"""
Unit tests for Audio Loading, Metadata Inspection, Resampling, and Slicing Utilities.
"""

from pathlib import Path
import numpy as np
import soundfile as sf
import torch
import pytest

from deeper_dhamma.audio import (
    get_audio_info,
    inspect_ffmpeg_audio_errors,
    inspect_id3_header_issues,
    load_audio_segment,
)


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


def test_inspect_ffmpeg_audio_errors_filters_benign_cover_art():
    """Verifies EXIF/cover-art stderr lines are ignored while real audio errors remain."""
    raw_stderr = "\n".join([
        "[mjpeg @ 000001] error decoding EXIF",
        "Estimating duration from bitrate, this may be inaccurate",
        "[mp3float @ 000002] Header missing",
    ])
    filtered = inspect_ffmpeg_audio_errors(raw_stderr)
    assert filtered == ["[mp3float @ 000002] Header missing"]


def test_inspect_id3_header_issues_detects_empty_txxx_and_comm(tmp_path: Path):
    """Verifies read-only ID3v2 parser catches empty TXXX/COMM frames without altering files."""
    # Build an ID3v2.3 tag with empty TXXX ("major_brand\x00") and empty COMM ("eng\x00")
    txxx_payload = b"\x03major_brand\x00"
    comm_payload = b"\x00eng\x00"
    frame_txxx = b"TXXX" + len(txxx_payload).to_bytes(4, "big") + b"\x00\x00" + txxx_payload
    frame_comm = b"COMM" + len(comm_payload).to_bytes(4, "big") + b"\x00\x00" + comm_payload
    body = frame_txxx + frame_comm
    sz = len(body)
    synchsafe = bytes([(sz >> 21) & 0x7F, (sz >> 14) & 0x7F, (sz >> 7) & 0x7F, sz & 0x7F])
    bad_mp3 = tmp_path / "bad_id3.mp3"
    bad_mp3.write_bytes(b"ID3\x03\x00\x00" + synchsafe + body + b"\xff\xfb\x90\x64" * 16)

    issues = inspect_id3_header_issues(bad_mp3)
    assert issues == ["id3_empty_txxx", "id3_empty_comm"]

    # Non-empty TXXX and standard COMM with blank short description (val="BSWA") should pass cleanly
    good_txxx_payload = b"\x03major_brand\x00mp42"
    good_comm_payload = b"\x00eng\x00BSWA"
    good_body = (
        b"TXXX" + len(good_txxx_payload).to_bytes(4, "big") + b"\x00\x00" + good_txxx_payload
        + b"COMM" + len(good_comm_payload).to_bytes(4, "big") + b"\x00\x00" + good_comm_payload
    )
    gsz = len(good_body)
    gsync = bytes([(gsz >> 21) & 0x7F, (gsz >> 14) & 0x7F, (gsz >> 7) & 0x7F, gsz & 0x7F])
    good_mp3 = tmp_path / "good_id3.mp3"
    good_mp3.write_bytes(b"ID3\x03\x00\x00" + gsync + good_body + b"\xff\xfb\x90\x64" * 16)
    assert inspect_id3_header_issues(good_mp3) == []


def test_load_mp3_ignores_underestimated_metadata_duration(synthetic_wav_file: Path, tmp_path: Path):
    """Verifies FFmpeg full-file MP3 decoding does not truncate when container duration lies."""
    import subprocess

    mp3_path = tmp_path / "synthetic_test.mp3"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(synthetic_wav_file), "-c:a", "libmp3lame", str(mp3_path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        pytest.skip("ffmpeg libmp3lame encoder unavailable")

    # Simulate an underestimated container duration header via explicit info dict while end_sec=None
    fake_info = {"samplerate": 44100, "channels": 2, "duration": 0.4, "frames": 17640, "format": "MP3", "subtype": "MP3"}
    tensor, sr = load_audio_segment(
        mp3_path,
        start_sec=0.0,
        end_sec=None,
        target_sr=16000,
        clean_audio=True,
        info=fake_info,
    )
    assert sr == 16000
    # Full 2.0s MP3 decoded (~32,000 samples), not truncated to 0.4s (6,400 samples)
    assert tensor.shape[1] >= 30000

