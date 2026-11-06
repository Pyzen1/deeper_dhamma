"""
Unit tests for Audio Archive Inspection, Integrity Auditing, and Scrubbing Engine.
"""

from pathlib import Path
import pytest

from deeper_dhamma.audit import clean_archive, probe_single_file


def test_probe_single_file_detects_zero_byte_ghost(tmp_path: Path):
    """Verifies 0-byte ghost files are detected and flagged for deletion."""
    ghost = tmp_path / "empty_talk.mp3"
    ghost.touch()

    issue = probe_single_file(ghost, archive_dir=tmp_path, deep_probe=False)
    assert issue is not None
    assert issue["issue"] == "zero_byte_ghost"
    assert issue["can_delete"] is True
    assert issue["size"] == 0


def test_probe_single_file_detects_transient_fragments(tmp_path: Path):
    """Verifies transient download fragments (.part, .temp, .aria2, .ytdl) are detected."""
    frag_part = tmp_path / "talk.mp3.part"
    frag_part.write_bytes(b"\x00" * 2048)

    issue = probe_single_file(frag_part, archive_dir=tmp_path, deep_probe=False)
    assert issue is not None
    assert issue["issue"] == "temp_fragment"
    assert issue["can_delete"] is True

    frag_temp = tmp_path / "talk.mp3.temp"
    frag_temp.write_bytes(b"\x00" * 2048)
    issue_temp = probe_single_file(frag_temp, archive_dir=tmp_path, deep_probe=False)
    assert issue_temp is not None
    assert issue_temp["issue"] == "temp_fragment"


def test_probe_single_file_detects_html_error_page_as_audio(tmp_path: Path):
    """Verifies HTML 404/500 error pages saved with .mp3 extensions are caught."""
    fake_audio = tmp_path / "talk_not_found.mp3"
    fake_audio.write_text("<!DOCTYPE html><html><body>404 Not Found</body></html>", encoding="utf-8")

    issue = probe_single_file(fake_audio, archive_dir=tmp_path, deep_probe=False)
    assert issue is not None
    assert issue["issue"] == "html_error_page"
    assert issue["can_delete"] is True


def test_probe_single_file_detects_corrupt_thumbnail(tmp_path: Path):
    """Verifies truncated or 0-byte cover art thumbnails under 200 bytes are flagged."""
    tiny_thumb = tmp_path / "cover.jpg"
    tiny_thumb.write_bytes(b"bad thumbnail bytes")

    issue = probe_single_file(tiny_thumb, archive_dir=tmp_path, deep_probe=False)
    assert issue is not None
    assert issue["issue"] == "corrupt_thumbnail"
    assert issue["can_delete"] is True

    # Valid-sized thumbnail (> 200 bytes) should not be flagged
    valid_thumb = tmp_path / "good_cover.jpg"
    valid_thumb.write_bytes(b"\xff\xd8\xff" + b"\x00" * 500)
    assert probe_single_file(valid_thumb, archive_dir=tmp_path, deep_probe=False) is None


def test_probe_single_file_access_error_on_missing_file(tmp_path: Path):
    """Verifies that attempting to probe a non-existent file returns an access error."""
    missing = tmp_path / "does_not_exist.mp3"
    issue = probe_single_file(missing, archive_dir=tmp_path, deep_probe=False)
    assert issue is not None
    assert issue["issue"] == "access_error"


def test_clean_archive_dry_run_vs_active(tmp_path: Path):
    """Verifies clean_archive respects dry_run and safely purges only flagged files."""
    ghost = tmp_path / "ghost.mp3"
    ghost.touch()

    frag = tmp_path / "talk.mp3.part"
    frag.write_bytes(b"\x00" * 1024)

    good_audio = tmp_path / "good_talk.mp3"
    good_audio.write_bytes(b"\xff\xfb\x90\x64" * 1000)

    issues = [
        {"full_path": str(ghost), "can_delete": True, "path": "ghost.mp3", "issue": "zero_byte_ghost", "description": "ghost"},
        {"full_path": str(frag), "can_delete": True, "path": "talk.mp3.part", "issue": "temp_fragment", "description": "fragment"},
    ]

    # Dry run should not delete files
    counts_dry = clean_archive(issues, dry_run=True)
    assert counts_dry["deleted_ghosts"] == 1
    assert counts_dry["deleted_fragments"] == 1
    assert ghost.exists()
    assert frag.exists()
    assert good_audio.exists()

    # Active clean should delete flagged files and keep good audio intact
    counts_active = clean_archive(issues, dry_run=False)
    assert counts_active["deleted_ghosts"] == 1
    assert counts_active["deleted_fragments"] == 1
    assert not ghost.exists()
    assert not frag.exists()
    assert good_audio.exists()
