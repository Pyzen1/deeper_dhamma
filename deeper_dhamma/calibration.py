"""
Stream Seek Calibration Engine.

Aligns physical uncompressed PCM timestamps produced by Whisper with the
browser's HTML5 <audio> HTTP streaming timeline.
Accounts for Variable Bit Rate (VBR) compression density variations (e.g. low-bitrate
lead-in silence) and Xing seek table offsets so that web player scrubbers and
transcript turn buttons match with millisecond precision across all episodes.
"""

import bisect
import json
import logging
import struct
import subprocess
from pathlib import Path
from typing import Callable, Dict, List, Optional

logger = logging.getLogger("seek_calibrator")


class StreamSeekCalibrator:
    """Calibrates transcript timestamps against HTML5 audio HTTP streaming timelines."""

    def __init__(self):
        self._cache: Dict[str, Callable[[float], float]] = {}

    def get_calibrator(self, audio_path: Path | str) -> Callable[[float], float]:
        """
        Returns a callable mapping uncompressed PCM timestamps (seconds) to browser
        HTTP seek time (seconds). For CBR audio, returns an identity lambda.
        """
        path_str = str(Path(audio_path).resolve())
        if path_str in self._cache:
            return self._cache[path_str]

        calibrator = self._build_calibrator(Path(path_str))
        self._cache[path_str] = calibrator
        return calibrator

    def _build_calibrator(self, audio_path: Path) -> Callable[[float], float]:
        if not audio_path.exists() or audio_path.suffix.lower() != ".mp3":
            return lambda t: t

        try:
            with open(audio_path, "rb") as f:
                header_peek = f.read(10)
                id3_len = 0
                if header_peek[:3] == b"ID3":
                    id3_len = (
                        (header_peek[6] << 21)
                        | (header_peek[7] << 14)
                        | (header_peek[8] << 7)
                        | header_peek[9]
                    ) + 10

                f.seek(id3_len)
                head = f.read(20000)

            xing_pos = head.find(b"Xing")
            has_info = head.find(b"Info") != -1

            # CBR files use an "Info" header or fixed frame sizes: 100% linear, zero skew
            if xing_pos == -1 or has_info:
                return lambda t: t

            flags = struct.unpack(">I", head[xing_pos + 4 : xing_pos + 8])[0]
            offset = xing_pos + 8
            frames = None
            bytes_len = None
            toc = None

            if flags & 1:  # Frames
                frames = struct.unpack(">I", head[offset : offset + 4])[0]
                offset += 4
            if flags & 2:  # Bytes
                bytes_len = struct.unpack(">I", head[offset : offset + 4])[0]
                offset += 4
            if flags & 4:  # TOC (100 entries)
                toc = list(head[offset : offset + 100])

            if not toc or not bytes_len or not frames:
                return lambda t: t

            total_dur = (frames * 1152) / 44100.0
            if total_dur <= 0:
                return lambda t: t

            audio_stream_size = float(bytes_len or (audio_path.stat().st_size - id3_len))
            if audio_stream_size <= 0:
                return lambda t: t

            # Sample packet positions across the audio file using ffprobe
            cmd = [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_packets",
                "-show_entries",
                "packet=pts_time,pos",
                "-read_intervals",
                "%+3600",
                "-of",
                "json",
                str(audio_path),
            ]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            pkts = json.loads(proc.stdout).get("packets", [])
            if not pkts:
                return lambda t: t

            pcm_times = []
            browser_seek_times = []
            last_t = -10.0

            for p in pkts:
                if "pts_time" not in p or "pos" not in p:
                    continue
                try:
                    t = float(p["pts_time"])
                    pos = int(p["pos"])
                except (ValueError, TypeError):
                    continue

                if t - last_t >= 2.0:
                    last_t = t
                    offset_in_audio = max(0, pos - id3_len)
                    seek_t = (offset_in_audio / audio_stream_size) * total_dur
                    pcm_times.append(t)
                    browser_seek_times.append(seek_t)

            if not pcm_times:
                return lambda t: t

            def calibrate(t_pcm: float) -> float:
                if t_pcm <= pcm_times[0]:
                    return t_pcm
                if t_pcm >= pcm_times[-1]:
                    delta = browser_seek_times[-1] - pcm_times[-1]
                    return max(0.0, t_pcm + delta)
                idx = bisect.bisect_right(pcm_times, t_pcm) - 1
                t0, t1 = pcm_times[idx], pcm_times[idx + 1]
                s0, s1 = browser_seek_times[idx], browser_seek_times[idx + 1]
                ratio = (t_pcm - t0) / (t1 - t0) if t1 > t0 else 0
                return max(0.0, s0 + ratio * (s1 - s0))

            return calibrate
        except Exception as e:
            logger.warning(f"Failed to build VBR calibrator for {audio_path.name}: {e}")
            return lambda t: t

    def calibrate_segments(
        self,
        audio_path: Path | str,
        segments: List[Dict],
    ) -> List[Dict]:
        """
        Calibrates turn and word timestamps in-place, aligning with the browser timeline.
        """
        calibrator = self.get_calibrator(audio_path)
        calibrated_segments = []

        for seg in segments:
            new_seg = dict(seg)
            raw_st = float(seg["start"])
            raw_en = float(seg["end"])

            cal_st = round(calibrator(raw_st), 2)
            cal_en = round(calibrator(raw_en), 2)

            new_seg["start"] = cal_st
            new_seg["end"] = cal_en

            if "words" in new_seg and new_seg["words"]:
                new_words = []
                for w in new_seg["words"]:
                    w_copy = dict(w)
                    w_copy["start"] = round(calibrator(float(w["start"])), 2)
                    w_copy["end"] = round(calibrator(float(w["end"])), 2)
                    new_words.append(w_copy)
                new_seg["words"] = new_words

            calibrated_segments.append(new_seg)

        return calibrated_segments
