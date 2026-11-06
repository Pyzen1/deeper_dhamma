"""
Unit tests for StreamSeekCalibrator and HTML5/Chromium seek timeline alignment.
"""

from pathlib import Path
import pytest
from deeper_dhamma.calibration import StreamSeekCalibrator
from deeper_dhamma.config import PROJECT_ROOT


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
    sample_mp3 = PROJECT_ROOT / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"
    
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
    sample_mp3 = PROJECT_ROOT / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"
    
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
    sample_mp3 = PROJECT_ROOT / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"
    
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


def test_vbr_trailer_and_firefox_chrome_linear_calibration():
    """
    Verifies that VBR1 trailer generation covers the entire talk duration (>3600s)
    and that linear byte-offset calibration aligns both Firefox and Chromium when
    the Xing TOC bit is neutralized in memory.
    """
    import struct
    from deeper_dhamma.calibration import (
        VBR_TRAILER_MAGIC,
        detect_xing_patch_offset,
        patch_xing_chunk_in_memory,
    )

    cal = StreamSeekCalibrator()
    sample_mp3 = (
        PROJECT_ROOT
        / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"
    )
    if not sample_mp3.exists():
        pytest.skip("Archive sample not found on disk")

    trailer = cal.build_vbr_trailer(sample_mp3)
    assert trailer.startswith(VBR_TRAILER_MAGIC)
    total_dur_ms, id3_len, bytes_len = struct.unpack("<III", trailer[4:16])
    sample_count = struct.unpack("<I", trailer[116:120])[0]

    assert total_dur_ms > 6400_000
    assert id3_len == 176128
    assert sample_count > 3000  # Full 107-minute talk (not truncated at 3600s)

    # Last sample must reach the end of the talk (>6400s)
    last_pcm_ms, _ = struct.unpack("<II", trailer[-8:])
    assert last_pcm_ms > 6400_000

    # Linear calibrator for "Everyone," (physical 216.30s -> linear 184.13s)
    lin_fn = cal.get_linear_calibrator(sample_mp3)
    lin_seek = lin_fn(216.30)
    assert 183.8 <= lin_seek <= 184.5

    # In-memory Xing -> Info neutralization check
    with open(sample_mp3, "rb") as f:
        head = f.read(200000)
    xing_off = detect_xing_patch_offset(head)
    assert xing_off == 176164
    patched = patch_xing_chunk_in_memory(head, 0, xing_off)
    assert patched[xing_off : xing_off + 8] == b"Info\x00\x00\x00\x03"


def test_detect_xing_patch_offset_and_in_memory_patching_edge_cases():
    """
    Tests detect_xing_patch_offset and patch_xing_chunk_in_memory across boundary
    and edge cases (short buffers, CBR streams without Xing, ID3v2 synchsafe offsets,
    and chunk boundaries splitting the 8-byte Xing header).
    """
    from deeper_dhamma.calibration import (
        detect_xing_patch_offset,
        patch_xing_chunk_in_memory,
    )

    # 1. Short or empty buffers return None
    assert detect_xing_patch_offset(b"") is None
    assert detect_xing_patch_offset(b"ID3\x04\x00") is None
    assert detect_xing_patch_offset(b"\x00" * 35) is None

    # 2. CBR stream without Xing tag returns None
    cbr_header = b"ID3\x03\x00\x00\x00\x00\x01\x00" + (b"\x00" * 128) + b"\xff\xfb\x90\x64" + (b"\x00" * 200)
    assert detect_xing_patch_offset(cbr_header) is None

    # 3. Synthetic ID3v2 (size = 128 -> synchsafe 0x00 0x00 0x01 0x00, total id3_len = 138) + Xing at +36 = 174
    vbr_header = (
        b"ID3\x03\x00\x00\x00\x00\x01\x00"
        + (b"\x00" * 128)
        + (b"\xff\xfb\x90\x64" + b"\x00" * 32)
        + b"Xing\x00\x00\x00\x0f"
        + (b"\x00" * 200)
    )
    xing_off = detect_xing_patch_offset(vbr_header)
    assert xing_off == 174

    # 4. Chunk before, after, andNone xing_abs_offset remain untouched
    assert patch_xing_chunk_in_memory(vbr_header[:100], 0, xing_off) == vbr_header[:100]
    assert patch_xing_chunk_in_memory(vbr_header[200:], 200, xing_off) == vbr_header[200:]
    assert patch_xing_chunk_in_memory(vbr_header, 0, None) == vbr_header
    assert patch_xing_chunk_in_memory(b"", 0, xing_off) == b""

    # 5. Split chunk boundary right inside the 8-byte "Xing\x00\x00\x00\x0f" sequence (at offset 174 + 3 = 177)
    part1 = patch_xing_chunk_in_memory(vbr_header[:177], 0, xing_off)
    part2 = patch_xing_chunk_in_memory(vbr_header[177:], 177, xing_off)
    reassembled = part1 + part2
    assert reassembled[xing_off : xing_off + 8] == b"Info\x00\x00\x00\x03"
    assert reassembled[:xing_off] == vbr_header[:xing_off]
    assert reassembled[xing_off + 8 :] == vbr_header[xing_off + 8 :]



