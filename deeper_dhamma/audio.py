"""
Audio Loading, Resampling, and Slicing Utilities.
"""

from pathlib import Path
from typing import Dict, Tuple
import numpy as np
import soundfile as sf

import deeper_dhamma.config  # Enforces HF_HOME and TORCH_HOME under C:\ai-models
import torch
import torchaudio


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


def get_audio_info(file_path: Path | str) -> Dict:
    """Reads audio file metadata without loading the entire stream into memory."""
    try:
        info = sf.info(str(file_path))
        return {
            "samplerate": info.samplerate,
            "channels": info.channels,
            "duration": info.duration,
            "frames": info.frames,
            "format": info.format,
            "subtype": info.subtype,
        }
    except Exception:
        # Fallback to ffprobe when soundfile does not recognize format (e.g. .m4a)
        import subprocess
        import json
        cmd = [
            "ffprobe", "-v", "error", "-show_entries",
            "format=duration:stream=sample_rate,channels",
            "-of", "json", str(file_path)
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if proc.returncode == 0:
            meta = json.loads(proc.stdout)
            duration = float(meta.get("format", {}).get("duration", 0.0))
            sr = 16000
            channels = 1
            streams = meta.get("streams", [])
            if streams:
                sr = int(streams[0].get("sample_rate", 16000))
                channels = int(streams[0].get("channels", 1))
            return {
                "samplerate": sr,
                "channels": channels,
                "duration": duration,
                "frames": int(duration * sr),
                "format": Path(file_path).suffix.lstrip(".").upper(),
                "subtype": "UNKNOWN",
            }
        raise


def load_audio_segment(
    file_path: Path | str,
    start_sec: float = 0.0,
    end_sec: float = None,
    target_sr: int = 16000,
    clean_audio: bool = True,
) -> Tuple[torch.Tensor, int]:
    """
    Reads a segment of audio from disk, downmixes to mono, resamples to target_sr,
    and applies acoustic cleaning (80Hz high-pass filter + peak normalization).
    Returns:
        waveform: Tensor of shape (1, num_samples)
        sample_rate: int
    """
    info = get_audio_info(file_path)
    sr = info["samplerate"]
    dur = info["duration"]

    if start_sec >= dur:
        return torch.zeros((1, 0)), target_sr

    try:
        start_frame = max(0, int(start_sec * sr))
        if end_sec is not None:
            stop_frame = min(info["frames"], int(end_sec * sr))
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
        tensor = torch.from_numpy(data.T)
    except Exception:
        # FFmpeg pipe fallback for formats not supported by soundfile (e.g. .m4a)
        import subprocess
        import io
        dur_to_read = (end_sec - start_sec) if end_sec is not None else (dur - start_sec)
        cmd = [
            "ffmpeg", "-ss", str(max(0.0, start_sec)), "-t", str(max(0.01, dur_to_read)),
            "-i", str(file_path), "-f", "wav", "-ar", str(target_sr), "-ac", "1", "pipe:1"
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg decoding failed: {proc.stderr.decode('utf-8', errors='ignore')}")
        data, read_sr = sf.read(io.BytesIO(proc.stdout), dtype="float32", always_2d=True)
        tensor = torch.from_numpy(data.T)
        sr = read_sr

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
