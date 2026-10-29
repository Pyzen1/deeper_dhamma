"""
Offline VBR Seek Calibration & `.bin` BLOB `VBR1` Trailer Generator.

Generates the compact binary `VBR1` seek calibration trailer appended to
`words/<episode_id>.bin` during transcription/export so the 100% static
JavaScript web application (`word_sync.js`) can align physical 44.1 kHz PCM
word timestamps with HTML5 `<audio>` streaming across both Mozilla Firefox
(Gecko `MP3TrackDemuxer`) and Chromium (FFmpeg `mp3dec`) with zero backend
server dependencies.

See `docs/troubleshooting_guide.md` for full root-cause analysis and diagrams.

Key Mechanisms & Invariants:
1. Canonical Physical Timestamps:
   True physical 44.1 kHz PCM timestamps are stored in SQLite (`speech_segments`)
   and compact binary word sidecars (`words/<episode_id>.bin`). Never pre-warp
   database or `.bin` word timestamps by the non-linear `Xing` TOC curve, because
   after any seek completes, the browser's audio decoder advances `audio.currentTime`
   at a constant 1:1 rate (`1152 / 44100` seconds per frame) rather than along
   the VBR bitrate curve.
2. Full-Duration `VBR1` Seek Trailer in `words/<episode_id>.bin`:
   For VBR MP3 files with a `Xing` header, `StreamSeekCalibrator.build_vbr_trailer()`
   appends a compact `VBR1` seek calibration trailer to `words/<episode_id>.bin`
   containing `(pcm_ms, audio_byte_offset)` sample points and the 100-byte TOC
   across 100% of the file duration (~25.8 KB for a 107-minute talk).
3. Client-Side Serverless Playback & Seeking (`word_sync.js`):
   - Chromium (`!isFirefox`): Streams directly from Podbean CDN using HTTP Range
     requests and translates physical timestamps via `xingSeekTimes` reconstructed
     from the `.bin` `VBR1` trailer.
   - Mozilla Firefox (`isFirefox`): Progressively fetches the MP3 stream from
     Podbean CDN (`Access-Control-Allow-Origin: *`), patches the 8-byte `Xing`
     header at `id3_len + 36` to `Info\x00\x00\x00\x03` in client-side `Uint8Array`
     RAM, and plays from a progressive `Blob` URL using `linearSeekTimes` with
     zero dead zones and zero backend server dependencies.
"""

import bisect
import json
import logging
import struct
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("seek_calibrator")

VBR_TRAILER_MAGIC = b"VBR1"


def detect_xing_patch_offset(header_bytes: bytes) -> Optional[int]:
    """
    Inspects the initial bytes of an MP3 stream (including any ID3v2 tag) and
    returns the exact absolute byte offset of the `b"Xing"` header if present,
    or None for CBR / `Info` files.
    """
    if len(header_bytes) < 10:
        return None
    id3_len = 0
    if header_bytes[:3] == b"ID3":
        id3_len = (
            (header_bytes[6] << 21)
            | (header_bytes[7] << 14)
            | (header_bytes[8] << 7)
            | header_bytes[9]
        ) + 10
    if len(header_bytes) <= id3_len + 40:
        return None
    search_window = header_bytes[id3_len : min(len(header_bytes), id3_len + 4096)]
    rel_pos = search_window.find(b"Xing")
    if rel_pos == -1:
        return None
    return id3_len + rel_pos


def patch_xing_chunk_in_memory(
    chunk: bytes | bytearray,
    chunk_start_offset: int,
    xing_abs_offset: Optional[int],
) -> bytes:
    """
    Reference implementation of the 8-byte in-memory `Xing -> Info` (`flags = 3`)
    neutralization (`b"Info\\x00\\x00\\x00\\x03"`) performed in client-side JS
    (`WordSync.ensureFirefoxPatchedStream` in `word_sync.js`).
    Never modifies files on disk.
    """
    if xing_abs_offset is None or not chunk:
        return bytes(chunk)
    chunk_end_offset = chunk_start_offset + len(chunk)
    patch_end = xing_abs_offset + 8
    if chunk_end_offset <= xing_abs_offset or chunk_start_offset >= patch_end:
        return bytes(chunk)

    buf = bytearray(chunk)
    replacement = b"Info\x00\x00\x00\x03"
    for i, b_val in enumerate(replacement):
        pos_in_buf = (xing_abs_offset + i) - chunk_start_offset
        if 0 <= pos_in_buf < len(buf):
            buf[pos_in_buf] = b_val
    return bytes(buf)


class StreamSeekCalibrator:
    """Calibrates transcript timestamps against HTML5 audio HTTP streaming timelines."""

    def __init__(self):
        self._cache: Dict[str, Callable[[float], float]] = {}
        self._linear_cache: Dict[str, Callable[[float], float]] = {}
        self._profile_cache: Dict[str, Optional[Dict[str, Any]]] = {}

    def _analyze_vbr_profile(self, audio_path: Path) -> Optional[Dict[str, Any]]:
        """
        Inspects an MP3 file and extracts its full-duration VBR packet profile:
        `(id3_len, xing_abs_offset, frames, bytes_len, total_dur, toc, pcm_times,
        byte_offsets, linear_seek_times, xing_seek_times)`.
        Returns None for CBR / Info files or non-MP3 files.
        """
        path_str = str(audio_path.resolve())
        if path_str in self._profile_cache:
            return self._profile_cache[path_str]

        if not audio_path.exists() or audio_path.suffix.lower() != ".mp3":
            self._profile_cache[path_str] = None
            return None

        try:
            with open(audio_path, "rb") as f:
                header_peek = f.read(10)
                id3_len = 0
                if len(header_peek) >= 10 and header_peek[:3] == b"ID3":
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
                self._profile_cache[path_str] = None
                return None

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
                self._profile_cache[path_str] = None
                return None

            total_dur = (frames * 1152) / 44100.0
            if total_dur <= 0:
                self._profile_cache[path_str] = None
                return None

            audio_stream_size = float(bytes_len or (audio_path.stat().st_size - id3_len))
            if audio_stream_size <= 0:
                self._profile_cache[path_str] = None
                return None

            # Sample packet positions across the FULL audio file using ffprobe
            cmd = [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_packets",
                "-show_entries",
                "packet=pts_time,pos",
                "-of",
                "json",
                str(audio_path),
            ]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            pkts = json.loads(proc.stdout).get("packets", [])
            if not pkts:
                self._profile_cache[path_str] = None
                return None

            pcm_times: List[float] = []
            byte_offsets: List[int] = []
            linear_seek_times: List[float] = []
            xing_seek_times: List[float] = []
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
                    linear_t = (offset_in_audio / audio_stream_size) * total_dur
                    frac = (offset_in_audio / audio_stream_size) * 256.0
                    seek_t = None
                    if toc and any(x > 0 for x in toc):
                        if frac <= toc[0]:
                            seek_t = (frac / toc[0]) * (1.0 / 100.0) * total_dur if toc[0] > 0 else 0.0
                        else:
                            for i in range(99):
                                if toc[i] <= frac <= toc[i + 1]:
                                    d = toc[i + 1] - toc[i]
                                    f_ratio = (frac - toc[i]) / d if d > 0 else 0.0
                                    seek_t = ((i + f_ratio) / 100.0) * total_dur
                                    break
                            if seek_t is None:
                                d = 256.0 - toc[99]
                                f_ratio = (frac - toc[99]) / d if d > 0 else 0.0
                                seek_t = ((99 + f_ratio) / 100.0) * total_dur
                    if seek_t is None:
                        seek_t = linear_t

                    pcm_times.append(t)
                    byte_offsets.append(offset_in_audio)
                    linear_seek_times.append(linear_t)
                    xing_seek_times.append(seek_t)

            if not pcm_times:
                self._profile_cache[path_str] = None
                return None

            profile = {
                "id3_len": int(id3_len),
                "xing_abs_offset": int(id3_len + xing_pos),
                "frames": int(frames),
                "bytes_len": int(audio_stream_size),
                "total_dur": float(total_dur),
                "toc": toc[:100],
                "pcm_times": pcm_times,
                "byte_offsets": byte_offsets,
                "linear_seek_times": linear_seek_times,
                "xing_seek_times": xing_seek_times,
            }
            self._profile_cache[path_str] = profile
            return profile
        except Exception as e:
            logger.warning(f"Failed to analyze VBR profile for {audio_path.name}: {e}")
            self._profile_cache[path_str] = None
            return None

    def get_calibrator(self, audio_path: Path | str) -> Callable[[float], float]:
        """
        Returns a callable mapping uncompressed PCM timestamps (seconds) to browser
        Xing TOC seek time (seconds). For CBR audio, returns an identity lambda.
        """
        path_obj = Path(audio_path)
        path_str = str(path_obj.resolve()) if path_obj.exists() else str(path_obj)
        if path_str in self._cache:
            return self._cache[path_str]

        calibrator = self._build_calibrator(path_obj, use_linear=False)
        self._cache[path_str] = calibrator
        return calibrator

    def get_linear_calibrator(self, audio_path: Path | str) -> Callable[[float], float]:
        """
        Returns a callable mapping uncompressed PCM timestamps (seconds) to linear
        byte-offset seek time (seconds) matching the `Xing -> Info` neutralized stream
        across both Mozilla Firefox and Chromium.
        """
        path_obj = Path(audio_path)
        path_str = str(path_obj.resolve()) if path_obj.exists() else str(path_obj)
        if path_str in self._linear_cache:
            return self._linear_cache[path_str]

        calibrator = self._build_calibrator(path_obj, use_linear=True)
        self._linear_cache[path_str] = calibrator
        return calibrator

    def _build_calibrator(self, audio_path: Path, use_linear: bool = False) -> Callable[[float], float]:
        profile = self._analyze_vbr_profile(audio_path)
        if not profile:
            return lambda t: t

        pcm_times = profile["pcm_times"]
        target_times = profile["linear_seek_times"] if use_linear else profile["xing_seek_times"]

        def calibrate(t_pcm: float) -> float:
            if t_pcm <= pcm_times[0]:
                return target_times[0]
            if t_pcm >= pcm_times[-1]:
                delta = target_times[-1] - pcm_times[-1]
                return max(0.0, t_pcm + delta)
            idx = bisect.bisect_right(pcm_times, t_pcm) - 1
            t0, t1 = pcm_times[idx], pcm_times[idx + 1]
            s0, s1 = target_times[idx], target_times[idx + 1]
            ratio = (t_pcm - t0) / (t1 - t0) if t1 > t0 else 0.0
            return max(0.0, s0 + ratio * (s1 - s0))

        return calibrate

    def build_vbr_trailer(self, audio_path: Path | str) -> bytes:
        """
        Builds the compact `VBR1` binary trailer to append to `words/<episode_id>.bin`
        for VBR MP3 files. Returns `b""` for CBR files.

        Binary Layout:
        - 4B: `b"VBR1"` magic
        - 4B uint32: `total_dur_ms`
        - 4B uint32: `id3_len`
        - 4B uint32: `bytes_len`
        - 100B uint8[100]: `toc`
        - 4B uint32: `sample_count` (M)
        - M * 8B: `(uint32 pcm_ms, uint32 audio_byte_offset)`
        """
        profile = self._analyze_vbr_profile(Path(audio_path))
        if not profile:
            return b""

        total_dur_ms = int(round(profile["total_dur"] * 1000.0))
        id3_len = int(profile["id3_len"])
        bytes_len = int(profile["bytes_len"])
        toc = profile["toc"]
        pcm_times = profile["pcm_times"]
        byte_offsets = profile["byte_offsets"]

        buf = bytearray()
        buf.extend(VBR_TRAILER_MAGIC)
        buf.extend(struct.pack("<III", total_dur_ms, id3_len, bytes_len))
        buf.extend(bytes(toc[:100]))
        buf.extend(struct.pack("<I", len(pcm_times)))

        for t_sec, b_off in zip(pcm_times, byte_offsets):
            t_ms = max(0, int(round(t_sec * 1000.0)))
            b_val = max(0, int(b_off))
            buf.extend(struct.pack("<II", t_ms, b_val))

        return bytes(buf)

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
