"""
Unit tests for the sync --repair functionality and bitstream parity audit in deeper_dhamma.downloader.
"""

from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from deeper_dhamma.downloader import (
    get_id3v2_tag_size,
    remove_from_archive_log,
    verify_remote_parity,
    run_sync,
)


def test_get_id3v2_tag_size():
    """Verifies synchsafe integer ID3 tag size calculation."""
    # Construct an ID3 header with synchsafe length 0x00 0x02 0x01 0x7F
    # synchsafe value: (2 << 14) | (1 << 7) | 127 = 32768 + 128 + 127 = 33023
    # Total tag size including 10-byte header = 33033
    header = b"ID3\x03\x00\x00\x00\x02\x01\x7f"
    assert get_id3v2_tag_size(header) == 33033

    # Non-ID3 header must return 0
    assert get_id3v2_tag_size(b"\xff\xfb\x90\x44\x00") == 0
    assert get_id3v2_tag_size(b"RIFF\x00\x00\x00\x00") == 0


def test_remove_from_archive_log(tmp_path: Path):
    """Verifies targeted eviction of identifiers from archive.log."""
    log_file = tmp_path / "archive.log"
    log_file.write_text(
        "generic 11_Bamboozled_Bliss\n"
        "generic 10_Keeping_The_Peace\n"
        "generic 09_Drop_The_Struggle\n",
        encoding="utf-8",
    )

    removed = remove_from_archive_log(log_file, {"10_Keeping_The_Peace"})
    assert removed == 1

    content = log_file.read_text(encoding="utf-8")
    assert "10_Keeping_The_Peace" not in content
    assert "11_Bamboozled_Bliss" in content
    assert "09_Drop_The_Struggle" in content


def test_verify_remote_parity_missing_or_small_file(tmp_path: Path):
    """Verifies failure on missing or undersized local files."""
    missing = tmp_path / "missing.mp3"
    valid, reason, _ = verify_remote_parity(missing, "http://example.com/audio.mp3")
    assert not valid
    assert "does not exist" in reason

    small = tmp_path / "small.mp3"
    small.write_bytes(b"too small")
    valid, reason, _ = verify_remote_parity(small, "http://example.com/audio.mp3")
    assert not valid
    assert "suspiciously small" in reason


def test_verify_remote_parity_detects_size_mismatch(tmp_path: Path):
    """Verifies that size differences between local file and remote HEAD Content-Length are flagged."""
    dummy_file = tmp_path / "talk.mp3"
    dummy_size = 2_000_000
    dummy_file.write_bytes(b"\x00" * dummy_size)

    # Mock remote HEAD returning 2,370,000 bytes
    mock_resp = MagicMock()
    mock_resp.headers = {"Content-Length": "2370000", "Content-Type": "audio/mpeg"}
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = None

    with patch("urllib.request.urlopen", return_value=mock_resp):
        valid, reason, meta = verify_remote_parity(dummy_file, "http://example.com/talk.mp3")

    assert not valid
    assert "size mismatch" in reason
    assert meta["diff"] == dummy_size - 2370000


def test_verify_remote_parity_detects_id3_tag_mismatch(tmp_path: Path):
    """Verifies that ID3 tag size differences (e.g. from injected cover art) are flagged."""
    local_id3_header = b"ID3\x03\x00\x00\x00\x10\x00\x00"  # larger tag
    remote_id3_header = b"ID3\x03\x00\x00\x00\x00\x50\x00"  # smaller original tag

    dummy_file = tmp_path / "talk.mp3"
    dummy_size = 2_000_000
    dummy_file.write_bytes(local_id3_header + b"\x00" * (dummy_size - len(local_id3_header)))

    # Mock HEAD returning identical file size
    mock_head = MagicMock()
    mock_head.headers = {"Content-Length": str(dummy_size), "Content-Type": "audio/mpeg"}
    mock_head.__enter__.return_value = mock_head
    mock_head.__exit__.return_value = None

    # Mock Range returning remote ID3 header
    mock_range = MagicMock()
    mock_range.read.return_value = remote_id3_header + b"\x00" * (1024 - len(remote_id3_header))
    mock_range.__enter__.return_value = mock_range
    mock_range.__exit__.return_value = None

    with patch("urllib.request.urlopen", side_effect=[mock_head, mock_range]):
        valid, reason, meta = verify_remote_parity(dummy_file, "http://example.com/talk.mp3")

    assert not valid
    assert "ID3 tag length mismatch" in reason


def test_verify_remote_parity_exact_match(tmp_path: Path):
    """Verifies that an exact bitstream match returns valid."""
    shared_head = b"ID3\x03\x00\x00\x00\x00\x50\x00" + (b"\xff\xfb\x90\x44" * 254)
    dummy_size = 2_000_000
    dummy_file = tmp_path / "talk.mp3"
    dummy_file.write_bytes(shared_head + b"\xaa" * (dummy_size - len(shared_head)))

    mock_head = MagicMock()
    mock_head.headers = {"Content-Length": str(dummy_size), "Content-Type": "audio/mpeg"}
    mock_head.__enter__.return_value = mock_head
    mock_head.__exit__.return_value = None

    mock_range = MagicMock()
    mock_range.read.return_value = shared_head
    mock_range.__enter__.return_value = mock_range
    mock_range.__exit__.return_value = None

    with patch("urllib.request.urlopen", side_effect=[mock_head, mock_range]):
        valid, reason, meta = verify_remote_parity(dummy_file, "http://example.com/talk.mp3")

    assert valid
    assert "exact bitstream parity confirmed" in reason
