"""
Unit tests for Audio Loading, Metadata Inspection, Resampling, and Slicing Utilities.
"""

from pathlib import Path
import numpy as np
import soundfile as sf
import torch
import pytest

from deeper_dhamma.audio import get_audio_info, load_audio_segment


@pytest.fixture
def synthetic_wav_file(tmp_path: Path) -> Path:
    """Generates a 2-second stereo 44.1 kHz synthetic sine wave WAV file for testing."""
    wav_path = tmp_path / "synthetic_test.wav"
    sr = 44100
    duration = 2.0
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    # 440 Hz left channel, 880 Hz right channel
    left = 0.5 * np.sin(2 * np.pi * 440 * t)
    right = 0.5 * np.sin(2 * np.pi * 880 * t)
    stereo_data = np.stack([left, right], axis=1).astype(np.float32)

    sf.write(str(wav_path), stereo_data, sr)
    return wav_path


def test_get_audio_info(synthetic_wav_file: Path):
    """Verifies get_audio_info accurately extracts metadata without decoding full audio."""
    info = get_audio_info(synthetic_wav_file)
    assert info["samplerate"] == 44100
    assert info["channels"] == 2
    assert abs(info["duration"] - 2.0) < 0.05
    assert info["format"] == "WAV"


def test_load_audio_segment_slicing_and_downmix(synthetic_wav_file: Path):
    """Verifies load_audio_segment downmixes to mono, resamples to 16kHz, and slices duration."""
    # Slice 0.5s to 1.5s (1.0s duration)
    tensor, sr = load_audio_segment(
        synthetic_wav_file,
        start_sec=0.5,
        end_sec=1.5,
        target_sr=16000,
        clean_audio=True,
    )

    assert sr == 16000
    assert isinstance(tensor, torch.Tensor)
    assert tensor.dim() == 2
    assert tensor.shape[0] == 1  # Downmixed mono

    # Duration ~1.0s at 16000 Hz = ~16000 samples
    samples = tensor.shape[1]
    assert abs(samples - 16000) <= 200


def test_load_audio_segment_past_duration_returns_empty(synthetic_wav_file: Path):
    """Verifies that requesting an audio segment starting beyond file duration returns an empty tensor."""
    tensor, sr = load_audio_segment(
        synthetic_wav_file,
        start_sec=5.0,  # File is only 2.0s
        end_sec=6.0,
        target_sr=16000,
    )

    assert sr == 16000
    assert tensor.shape == (1, 0)

