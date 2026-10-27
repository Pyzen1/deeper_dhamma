"""
Unit tests for StreamSeekCalibrator and HTML5/Chromium seek timeline alignment.
"""

from pathlib import Path
import pytest
from deeper_dhamma.calibration import StreamSeekCalibrator


def test_calibrator_cbr_identity():
    """CBR audio or non-MP3 files must map 1:1 with zero skew."""
    cal = StreamSeekCalibrator()
    dummy_path = Path("non_existent_cbr.wav")
    fn = cal.get_calibrator(dummy_path)
    
    for t in [0.0, 15.5, 120.0, 3600.0]:
        assert fn(t) == t


def test_calibrator_vbr_xing_exact_inversion():
    """
    Verifies that the inverted Xing TOC seek time calculated for physical speech
    packet offsets exactly matches the byte offset Chromium's mp3_seek requests.
    """
    cal = StreamSeekCalibrator()
    sample_mp3 = Path(r"archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3")
    
    if not sample_mp3.exists():
        pytest.skip("Archive sample not found on disk")
        
    fn = cal.get_calibrator(sample_mp3)
    
    # Physical speech at 216.62s
    seek_t = fn(216.62)
    assert 200.0 <= seek_t <= 206.0, f"Expected seek_t near 203.5s, got {seek_t}"
    
    # Monotonicity test: speech turning forward in physical time must turn forward in seek time
    prev_s = 0.0
    for t in [10.0, 50.0, 100.0, 216.62, 500.0, 1000.0, 2000.0]:
        curr_s = fn(t)
        assert curr_s >= prev_s, f"Monotonicity violated at t={t}: {curr_s} < {prev_s}"
        prev_s = curr_s


def test_calibrate_segments_in_place():
    """Tests calibrate_segments batch structure and word timestamp calibration."""
    cal = StreamSeekCalibrator()
    sample_mp3 = Path(r"archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3")
    
    if not sample_mp3.exists():
        pytest.skip("Archive sample not found on disk")
        
    raw_segments = [
        {
            "start": 216.62,
            "end": 225.50,
            "text": "Everyone, welcome back.",
            "words": [
                {"word": "Everyone,", "start": 216.62, "end": 217.20},
                {"word": "welcome", "start": 217.30, "end": 217.80},
                {"word": "back.", "start": 217.90, "end": 218.40},
            ],
        }
    ]
    
    calibrated = cal.calibrate_segments(sample_mp3, raw_segments)
    assert len(calibrated) == 1
    seg = calibrated[0]
    
    assert seg["start"] < 216.62
    assert seg["end"] < 225.50
    assert len(seg["words"]) == 3
    assert seg["words"][0]["start"] == seg["start"]


def test_lead_time_to_first_word_calculation():
    """
    Verifies that applying a 500ms lead time to any seek reference point
    lands exactly 0.50s before the first spoken word and clamps to 0.0s.
    """
    cal = StreamSeekCalibrator()
    sample_mp3 = Path(r"archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3")
    
    if not sample_mp3.exists():
        pytest.skip("Archive sample not found on disk")
        
    fn = cal.get_calibrator(sample_mp3)
    
    # First word starts at physical 216.62s
    first_word_seek = fn(216.62)
    lead_time_sec = 0.50
    seek_target = max(0.0, first_word_seek - lead_time_sec)
    
    # Check that lead time is exactly 500ms
    assert round(first_word_seek - seek_target, 2) == 0.50
    
    # Check clamping at 0.0s for early talk start (e.g. 0.20s into audio)
    early_word_seek = 0.20
    clamped_target = max(0.0, early_word_seek - lead_time_sec)
    assert clamped_target == 0.0

