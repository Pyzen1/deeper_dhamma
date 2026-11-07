"""
Unit tests for SpeakerProfiler fast acoustic pre-analysis.
"""

from pathlib import Path
from unittest.mock import MagicMock
import numpy as np
import pytest
import torch

from deeper_dhamma.profiler import SpeakerProfiler


def test_profiler_silent_waveform():
    """Verifies that completely silent waveform returns empty clusters without errors."""
    mock_db = MagicMock()
    mock_encoder = MagicMock()
    profiler = SpeakerProfiler(voiceprint_db=mock_db, encoder=mock_encoder)

    # 5 seconds of total silence (zeros)
    silence = torch.zeros((1, 80000))
    res = profiler.profile_audio(
        audio_path="dummy.mp3",
        waveform_16k=silence,
        sample_rate=16000,
        stride_sec=1.0,
        window_sec=1.0,
    )

    assert res["is_multi_speaker"] is False
    assert res["clusters_count"] == 0
    assert len(res["ranked_speakers"]) == 0


def test_profiler_single_speaker_identification():
    """Verifies that consistent embeddings cluster into a single dominant speaker."""
    mock_db = MagicMock()
    mock_db.identify_speaker.return_value = {
        "teacher_slug": "ajahn_brahm",
        "display_name": "Ajahn Brahm",
        "confidence": 0.88,
        "role": "primary",
        "identified": True,
    }

    # Encoder returns identical unit embedding for each slice
    unit_vec = np.ones(192, dtype=np.float32)
    unit_vec = unit_vec / np.linalg.norm(unit_vec)
    mock_encoder = MagicMock()
    mock_encoder.encode_waveform.return_value = unit_vec

    profiler = SpeakerProfiler(voiceprint_db=mock_db, encoder=mock_encoder)

    # 30 seconds of non-zero audio
    audio = torch.randn((1, 16000 * 30)) * 0.1
    res = profiler.profile_audio(
        audio_path="talk.mp3",
        waveform_16k=audio,
        sample_rate=16000,
        stride_sec=2.0,
        window_sec=2.0,
    )

    assert res["is_multi_speaker"] is False
    assert res["clusters_count"] == 1
    assert len(res["ranked_speakers"]) == 1
    assert res["ranked_speakers"][0]["slug"] == "ajahn_brahm"
    assert res["shares"]["ajahn_brahm"] == 1.0


def test_profiler_multi_speaker_detection():
    """Verifies that distinct orthogonal embeddings trigger the multi-speaker flag."""
    vec_a = np.zeros(192, dtype=np.float32)
    vec_a[0] = 1.0

    vec_b = np.zeros(192, dtype=np.float32)
    vec_b[1] = 1.0

    call_count = [0]

    def mock_encode(waveform):
        call_count[0] += 1
        return vec_a if call_count[0] % 2 == 0 else vec_b

    def mock_identify(center, era=None, threshold=0.40):
        if center[0] > center[1]:
            return {"teacher_slug": "ajahn_brahm", "display_name": "Ajahn Brahm", "confidence": 0.85, "role": "lead", "identified": True}
        else:
            return {"teacher_slug": "ajahn_brahmali", "display_name": "Ajahn Brahmali", "confidence": 0.82, "role": "co-teacher", "identified": True}

    mock_db = MagicMock()
    mock_db.identify_speaker.side_effect = mock_identify

    mock_encoder = MagicMock()
    mock_encoder.encode_waveform.side_effect = mock_encode

    profiler = SpeakerProfiler(voiceprint_db=mock_db, encoder=mock_encoder)

    # 40 seconds of non-zero audio
    audio = torch.randn((1, 16000 * 40)) * 0.1
    res = profiler.profile_audio(
        audio_path="retreat.mp3",
        waveform_16k=audio,
        sample_rate=16000,
        stride_sec=2.0,
        window_sec=2.0,
    )

    assert res["clusters_count"] == 2
    assert res["is_multi_speaker"] is True
    assert "ajahn_brahm" in res["shares"]
    assert "ajahn_brahmali" in res["shares"]

