"""
Audio Loading, Resampling, and Slicing Utilities.
"""

from pathlib import Path
from typing import Dict, Tuple
import numpy as np
import soundfile as sf
import torch
import torchaudio


def get_audio_info(file_path: Path | str) -> Dict:
    """Reads audio file metadata without loading the entire stream into memory."""
    info = sf.info(str(file_path))
    return {
        "samplerate": info.samplerate,
        "channels": info.channels,
        "duration": info.duration,
        "frames": info.frames,
        "format": info.format,
        "subtype": info.subtype,
    }


def load_audio_segment(
    file_path: Path | str,
    start_sec: float = 0.0,
    end_sec: float = None,
    target_sr: int = 16000,
) -> Tuple[torch.Tensor, int]:
    """
    Reads a segment of audio from disk, downmixes to mono, and resamples to target_sr.
    Returns:
        waveform: Tensor of shape (1, num_samples)
        sample_rate: int
    """
    info = get_audio_info(file_path)
    sr = info["samplerate"]

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

    # Downmix to mono
    if tensor.shape[0] > 1:
        tensor = torch.mean(tensor, dim=0, keepdim=True)

    # Resample if needed
    if sr != target_sr:
        resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=target_sr)
        tensor = resampler(tensor)

    return tensor, target_sr
