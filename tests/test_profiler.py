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


def test_voiceprint_db_in_memory_cache_and_invalidation(tmp_path):
    """Verifies that VoiceprintDatabase caches gallery embeddings in RAM and invalidates on insert."""
    from deeper_dhamma.voiceprints import VoiceprintDatabase

    db_file = tmp_path / "test_vp.db"
    vdb = VoiceprintDatabase(db_path=db_file)

    emb1 = np.zeros(192, dtype=np.float32)
    emb1[0] = 3.0
    vdb.insert_voiceprint(
        teacher_slug="ajahn_brahm",
        display_name="Ajahn Brahm",
        era="2004_2014",
        role="monastic_primary",
        source_file="talk1.mp3",
        start_sec=10.0,
        end_sec=16.0,
        embedding=emb1,
    )

    gallery_1 = vdb.load_gallery(era="2004_2014")
    assert len(gallery_1) == 1
    assert "embedding_normed" in gallery_1[0]
    assert np.isclose(np.linalg.norm(gallery_1[0]["embedding_normed"]), 1.0)
    assert vdb.score_speaker(emb1, "ajahn_brahm", era="2004_2014") == 1.0

    # Insert a second voiceprint and confirm cache automatically refreshes
    emb2 = np.zeros(192, dtype=np.float32)
    emb2[1] = 5.0
    vdb.insert_voiceprint(
        teacher_slug="ajahn_brahmali",
        display_name="Ajahn Brahmali",
        era="2004_2014",
        role="monastic_primary",
        source_file="talk2.mp3",
        start_sec=20.0,
        end_sec=26.0,
        embedding=emb2,
    )
    gallery_2 = vdb.load_gallery(era="2004_2014")
    assert len(gallery_2) == 2




def test_profile_audio_single_valid_speech_window_does_not_crash():
    """Sparse talks with only one non-silent profiler window should not crash AgglomerativeClustering."""
    import numpy as np
    import torch
    from deeper_dhamma.profiler import SpeakerProfiler

    class _DummyDB:
        def identify_speaker(self, emb, era=None, threshold=0.40):
            return {
                "identified": False,
                "teacher_slug": "unregistered",
                "display_name": "Unregistered",
                "confidence": 0.0,
                "role": "unknown",
            }

    class _DummyEncoder:
        def encode_waveform(self, waveform):
            vec = np.ones(192, dtype=np.float32)
            return vec / np.linalg.norm(vec)

    # 180 seconds at 16 kHz -> stride=30s yields >=5 sample points starting at 10s;
    # only the [10s..13s] window exceeds the energy threshold.
    waveform = torch.zeros((1, 180 * 16000), dtype=torch.float32)
    waveform[:, 10 * 16000 : 13 * 16000] = 0.2

    profiler = SpeakerProfiler(voiceprint_db=_DummyDB(), encoder=_DummyEncoder())
    result = profiler.profile_audio(
        "sparse_meditation.mp3",
        stride_sec=30.0,
        window_sec=3.0,
        waveform_16k=waveform,
        sample_rate=16000,
    )

    assert result["clusters_count"] == 1
    assert result["is_multi_speaker"] is False
    assert len(result["ranked_speakers"]) == 1
    assert result["ranked_speakers"][0]["share"] == 1.0
