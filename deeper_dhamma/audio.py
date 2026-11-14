"""
Audio Loading, Resampling, and Slicing Utilities.
"""

from pathlib import Path
from typing import Dict, List, Optional, Tuple
import json
import logging
import subprocess
import numpy as np
import soundfile as sf

import deeper_dhamma.config  # Enforces HF_HOME and TORCH_HOME under C:\ai-models
import torch
import torchaudio

logger = logging.getLogger(__name__)

# Route compressed podcast/archive formats directly through FFmpeg/FFprobe rather than
# libsndfile/libmpg123 so corrupt ID3v2 frames never leak C-stderr or silently truncate.
_FFMPEG_PRIMARY_EXTS = frozenset({".mp3", ".m4a", ".aac", ".mp4", ".m4b", ".opus"})
_BENIGN_FFMPEG_STDERR_MARKERS = (
    "[mjpeg",
    "error decoding exif",
    "estimating duration from bitrate",
)


def inspect_ffmpeg_audio_errors(stderr_text: str) -> List[str]:
    """Filters FFmpeg/FFprobe stderr to exclude benign cover-art/EXIF notices."""
    errors: List[str] = []
    for raw_line in (stderr_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lower = line.lower()
        if any(marker in lower for marker in _BENIGN_FFMPEG_STDERR_MARKERS):
            continue
        errors.append(line)
    return errors


def _is_empty_id3_text_pair(encoding: int, payload: bytes, require_desc: bool = False) -> bool:
    """Returns True when an ID3v2 TXXX/COMM payload has empty body text (or missing desc when required)."""
    if not payload:
        return True
    if encoding in (0, 3):
        sep = payload.find(b"\x00")
        if sep < 0:
            return len(payload.strip(b"\x00")) == 0
        desc = payload[:sep].strip(b"\x00")
        val = payload[sep + 1 :].strip(b"\x00")
        if require_desc:
            return len(desc) == 0 or len(val) == 0
        return len(val) == 0
    # UTF-16 (1 or 2): search 2-byte aligned double-null terminator
    for pos in range(0, max(0, len(payload) - 1), 2):
        if payload[pos : pos + 2] == b"\x00\x00":
            desc = payload[:pos].replace(b"\xff\xfe", b"").replace(b"\xfe\xff", b"").replace(b"\x00", b"")
            val = payload[pos + 2 :].replace(b"\xff\xfe", b"").replace(b"\xfe\xff", b"").replace(b"\x00", b"")
            if require_desc:
                return len(desc.strip()) == 0 or len(val.strip()) == 0
            return len(val.strip()) == 0
    return False


def inspect_id3_header_issues(file_path: Path | str) -> List[str]:
    """Read-only ID3v2 inspection for empty TXXX/COMM frames that cause libmpg123 id3.c errors."""
    path = Path(file_path)
    issues: List[str] = []
    try:
        with open(path, "rb") as fh:
            header = fh.read(10)
            tag_size = get_id3_tag_size(header)
            if tag_size <= 10:
                return issues
            ver_major = header[3]
            if ver_major not in (3, 4):
                return issues
            flags = header[5]
            tag_body = fh.read(tag_size - 10)
    except OSError:
        return issues

    pos = 0
    if flags & 0x40 and len(tag_body) >= 4:
        if ver_major == 4:
            ext_size = (
                ((tag_body[0] & 0x7F) << 21)
                | ((tag_body[1] & 0x7F) << 14)
                | ((tag_body[2] & 0x7F) << 7)
                | (tag_body[3] & 0x7F)
            )
            pos = max(pos, ext_size)
        else:
            ext_size = int.from_bytes(tag_body[:4], "big")
            pos = max(pos, 4 + ext_size)

    seen = set()
    while pos + 10 <= len(tag_body):
        frame_id = tag_body[pos : pos + 4]
        if frame_id == b"\x00\x00\x00\x00" or not all(
            65 <= b <= 90 or 48 <= b <= 57 for b in frame_id
        ):
            break
        raw_sz = tag_body[pos + 4 : pos + 8]
        if ver_major == 4:
            frame_size = (
                ((raw_sz[0] & 0x7F) << 21)
                | ((raw_sz[1] & 0x7F) << 14)
                | ((raw_sz[2] & 0x7F) << 7)
                | (raw_sz[3] & 0x7F)
            )
        else:
            frame_size = int.from_bytes(raw_sz, "big")
        if frame_size < 0 or pos + 10 + frame_size > len(tag_body):
            break
        payload = tag_body[pos + 10 : pos + 10 + frame_size]
        if frame_id == b"TXXX" and payload and _is_empty_id3_text_pair(payload[0], payload[1:], require_desc=True):
            if "id3_empty_txxx" not in seen:
                seen.add("id3_empty_txxx")
                issues.append("id3_empty_txxx")
        elif frame_id == b"COMM" and len(payload) >= 4 and _is_empty_id3_text_pair(payload[0], payload[4:], require_desc=False):
            if "id3_empty_comm" not in seen:
                seen.add("id3_empty_comm")
                issues.append("id3_empty_comm")
        pos += 10 + frame_size

    return issues


def get_id3_tag_size(header_bytes: bytes) -> int:
    """Calculates ID3v2 total tag length including 10-byte header from synchsafe integers."""
    if len(header_bytes) >= 10 and header_bytes[:3] == b"ID3":
        return (
            (header_bytes[6] << 21)
            | (header_bytes[7] << 14)
            | (header_bytes[8] << 7)
            | header_bytes[9]
        ) + 10
    return 0


get_id3v2_tag_size = get_id3_tag_size


def _probe_with_soundfile(file_path: Path | str) -> Dict:
    info = sf.info(str(file_path))
    return {
        "samplerate": info.samplerate,
        "channels": info.channels,
        "duration": info.duration,
        "frames": info.frames,
        "format": info.format,
        "subtype": info.subtype,
    }


def _probe_with_ffprobe(file_path: Path | str) -> Dict:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "format=duration,format_name:stream=sample_rate,channels,codec_name,duration",
        "-of",
        "json",
        str(file_path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {file_path}: {proc.stderr.strip()}")
    meta = json.loads(proc.stdout or "{}")
    streams = meta.get("streams", [])
    stream = streams[0] if streams else {}
    sr = int(stream.get("sample_rate") or 16000)
    channels = int(stream.get("channels") or 1)
    raw_dur = stream.get("duration") or meta.get("format", {}).get("duration") or 0.0
    duration = float(raw_dur)
    codec_name = str(stream.get("codec_name") or "UNKNOWN").upper()
    return {
        "samplerate": sr,
        "channels": channels,
        "duration": duration,
        "frames": int(round(duration * sr)),
        "format": Path(file_path).suffix.lstrip(".").upper(),
        "subtype": codec_name,
    }


def get_audio_info(file_path: Path | str) -> Dict:
    """Reads audio file metadata without loading the entire stream into memory."""
    suffix = Path(file_path).suffix.lower()
    if suffix in _FFMPEG_PRIMARY_EXTS:
        try:
            return _probe_with_ffprobe(file_path)
        except FileNotFoundError:
            return _probe_with_soundfile(file_path)
    try:
        return _probe_with_soundfile(file_path)
    except Exception:
        return _probe_with_ffprobe(file_path)


def _decode_with_ffmpeg(
    file_path: Path | str,
    start_sec: float = 0.0,
    end_sec: Optional[float] = None,
    target_sr: int = 16000,
) -> Tuple[torch.Tensor, int]:
    """Decodes an audio file or slice via FFmpeg stdout f32le pipe without C-stderr noise."""
    safe_start = max(0.0, float(start_sec))
    if end_sec is not None and float(end_sec) <= safe_start:
        return torch.zeros((1, 0), dtype=torch.float32), target_sr

    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if safe_start > 0.0:
        cmd.extend(["-ss", f"{safe_start:.6f}"])
    cmd.extend(["-i", str(file_path)])
    if end_sec is not None:
        dur_to_read = max(0.01, float(end_sec) - safe_start)
        cmd.extend(["-t", f"{dur_to_read:.6f}"])
    cmd.extend([
        "-vn",
        "-sn",
        "-dn",
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ar",
        str(int(target_sr)),
        "-ac",
        "1",
        "pipe:1",
    ])
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stderr_text = proc.stderr.decode("utf-8", errors="ignore")
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg decoding failed for {file_path}: {stderr_text.strip()}")

    audio_errors = inspect_ffmpeg_audio_errors(stderr_text)
    if audio_errors:
        logger.debug(
            "FFmpeg audio decode notices for %s: %s",
            Path(file_path).name,
            " | ".join(audio_errors[:3]),
        )

    raw = proc.stdout
    usable_bytes = (len(raw) // 4) * 4
    if usable_bytes == 0:
        return torch.zeros((1, 0), dtype=torch.float32), target_sr
    samples = np.frombuffer(raw[:usable_bytes], dtype="<f4").copy()
    return torch.from_numpy(samples).unsqueeze(0), target_sr


def _decode_with_soundfile(
    file_path: Path | str,
    start_sec: float,
    end_sec: Optional[float],
    info: Dict,
) -> Tuple[torch.Tensor, int]:
    sr = int(info["samplerate"])
    start_frame = max(0, int(start_sec * sr))
    if end_sec is not None:
        stop_frame = min(int(info["frames"]), int(end_sec * sr))
        frames_to_read = max(0, stop_frame - start_frame)
    else:
        frames_to_read = -1
    data, _ = sf.read(
        str(file_path),
        start=start_frame,
        frames=frames_to_read,
        dtype="float32",
        always_2d=True,
    )
    return torch.from_numpy(data.T), sr


def measure_decoded_duration_ffmpeg(
    file_path: Path | str,
    timeout_sec: float = 120.0,
) -> Tuple[float, List[str]]:
    """
    Streams decoded audio through FFmpeg as 8kHz mono f32le and counts bytes in O(1) RAM
    to obtain the true physical PCM duration regardless of lying Xing/ID3/container tags.
    """
    sample_rate = 8000
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-i",
        str(file_path),
        "-vn",
        "-sn",
        "-dn",
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ar",
        str(sample_rate),
        "-ac",
        "1",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    total_bytes = 0
    assert proc.stdout is not None
    assert proc.stderr is not None
    while True:
        chunk = proc.stdout.read(65536)
        if not chunk:
            break
        total_bytes += len(chunk)
    proc.stdout.close()
    stderr_bytes = proc.stderr.read()
    proc.stderr.close()
    rc = proc.wait(timeout=timeout_sec)
    stderr_text = stderr_bytes.decode("utf-8", errors="ignore")
    audio_errors = inspect_ffmpeg_audio_errors(stderr_text)
    if rc != 0:
        raise RuntimeError(f"FFmpeg duration measurement failed for {file_path}: {stderr_text.strip()}")
    usable_bytes = (total_bytes // 4) * 4
    duration_sec = round(usable_bytes / (4.0 * sample_rate), 3)
    return duration_sec, audio_errors


_RECOVERABLE_RESYNC_MARKERS = (
    "header missing",
    "error submitting packet to decoder: invalid data found when processing input",
    "invalid new backstep",
    "big_values too big",
    "error while decoding mpeg audio frame",
)


def verify_ffmpeg_decode(file_path: Path | str, timeout_sec: float = 120.0) -> Dict:
    """Runs a full null-muxer FFmpeg stream decode to verify zero fatal/corrupt audio errors."""
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-i",
        str(file_path),
        "-vn",
        "-sn",
        "-dn",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_sec,
    )
    audio_errors = inspect_ffmpeg_audio_errors(proc.stderr or "")
    fatal_errors: List[str] = []
    resync_warnings: List[str] = []
    for line in audio_errors:
        lower = line.lower()
        if proc.returncode == 0 and any(m in lower for m in _RECOVERABLE_RESYNC_MARKERS):
            resync_warnings.append(line)
        else:
            fatal_errors.append(line)
    return {
        "filepath": str(file_path),
        "ok": proc.returncode == 0 and not fatal_errors,
        "returncode": proc.returncode,
        "errors": fatal_errors,
        "resync_warnings": resync_warnings,
    }


def load_audio_segment(
    file_path: Path | str,
    start_sec: float = 0.0,
    end_sec: Optional[float] = None,
    target_sr: int = 16000,
    clean_audio: bool = True,
    info: Optional[Dict] = None,
) -> Tuple[torch.Tensor, int]:
    """
    Reads a segment of audio from disk, downmixes to mono, resamples to target_sr,
    and applies acoustic cleaning (80Hz high-pass filter + peak normalization).
    Returns:
        waveform: Tensor of shape (1, num_samples)
        sample_rate: int
    """
    resolved_info = info if info is not None else get_audio_info(file_path)
    dur = float(resolved_info.get("duration") or 0.0)

    if start_sec > 0.0 and dur > 0.0 and start_sec >= dur:
        return torch.zeros((1, 0), dtype=torch.float32), target_sr

    suffix = Path(file_path).suffix.lower()
    if suffix in _FFMPEG_PRIMARY_EXTS:
        try:
            tensor, sr = _decode_with_ffmpeg(
                file_path,
                start_sec=start_sec,
                end_sec=end_sec,
                target_sr=target_sr,
            )
        except FileNotFoundError:
            tensor, sr = _decode_with_soundfile(file_path, start_sec, end_sec, resolved_info)
    else:
        try:
            tensor, sr = _decode_with_soundfile(file_path, start_sec, end_sec, resolved_info)
        except Exception:
            tensor, sr = _decode_with_ffmpeg(
                file_path,
                start_sec=start_sec,
                end_sec=end_sec,
                target_sr=target_sr,
            )

    if tensor.shape[-1] == 0:
        return tensor, target_sr

    # Downmix to mono
    if tensor.shape[0] > 1:
        tensor = torch.mean(tensor, dim=0, keepdim=True)

    # Resample if needed
    if sr != target_sr:
        resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=target_sr)
        tensor = resampler(tensor)

    # Acoustic cleaning: 80Hz highpass filter (removes 50Hz mains hum) + peak normalization
    if clean_audio and tensor.shape[-1] > 160:
        try:
            tensor = torchaudio.functional.highpass_biquad(tensor, sample_rate=target_sr, cutoff_freq=80.0)
            max_val = torch.max(torch.abs(tensor))
            if max_val > 1e-4:
                tensor = tensor / max_val * 0.95
        except Exception:
            pass

    return tensor, target_sr
