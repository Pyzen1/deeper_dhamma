"""
Unit tests for Transcription Progress & Audio Catalog Availability Reporter.
"""

import json
from pathlib import Path
import pytest

from deeper_dhamma.status import (
    collect_status,
    format_duration_hhmmss,
    make_progress_bar,
)


def test_format_duration_hhmmss():
    """Verifies human-readable formatting of audio durations."""
    assert format_duration_hhmmss(45.0) == "45s"
    assert format_duration_hhmmss(135.0) == "2m 15s"
    assert format_duration_hhmmss(3600.0) == "1h 00m 00s"
    assert format_duration_hhmmss(3665.0) == "1h 01m 05s"
    assert format_duration_hhmmss(0.0) == "0s"


def test_make_progress_bar():
    """Verifies ASCII progress bar rendering across percentages."""
    bar_0 = make_progress_bar(0, 100, width=10)
    assert "[..........]   0.0%" in bar_0

    bar_50 = make_progress_bar(50, 100, width=10)
    assert "[=====.....]  50.0%" in bar_50

    bar_100 = make_progress_bar(100, 100, width=10)
    assert "[==========] 100.0%" in bar_100

    # Edge cases
    bar_zero_total = make_progress_bar(0, 0, width=10)
    assert "0.0%" in bar_zero_total


def test_collect_status_empty_environment(tmp_path: Path):
    """Verifies collect_status handles empty directories without errors."""
    archive_dir = tmp_path / "archive"
    archive_dir.mkdir()
    db_path = tmp_path / "empty_transcripts.db"
    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text("[]", encoding="utf-8")
    archive_log = tmp_path / "archive.log"
    archive_log.write_text("", encoding="utf-8")

    status = collect_status(
        archive_dir=archive_dir,
        db_path=db_path,
        catalog_path=catalog_path,
        archive_log_path=archive_log,
    )

    assert "catalog" in status
    assert "archive_disk" in status
    assert "transcripts" in status
    assert status["catalog"]["total_raw"] == 0
    assert status["archive_disk"]["total_files"] == 0
    assert status["transcripts"]["records_count"] == 0


def test_collect_status_tracks_excluded_untranscribable_tracks(tmp_path: Path):
    """Excluded non-speech files on disk must not count as pending transcription."""
    from deeper_dhamma.storage import TranscriptDatabase

    archive_dir = tmp_path / "archive" / "2012" / "standalone"
    archive_dir.mkdir(parents=True)
    stem = "2012-09-06_group_chanting"
    mp3 = archive_dir / f"{stem}.mp3"
    mp3.write_bytes(b"mp3data")

    db_path = tmp_path / "transcripts.db"
    tdb = TranscriptDatabase(db_path=db_path)
    tdb.exclude_episode(
        episode_id="pb_excl_1",
        reason="no_transcribable_speech",
        title="Group Chanting",
        filepath=str(mp3),
        year=2012,
    )

    catalog_path = tmp_path / "catalog.json"
    catalog_path.write_text("[]", encoding="utf-8")
    archive_log = tmp_path / "archive.log"
    archive_log.write_text("", encoding="utf-8")

    st = collect_status(
        archive_dir=tmp_path / "archive",
        db_path=db_path,
        catalog_path=catalog_path,
        archive_log_path=archive_log,
    )
    assert st["archive_disk"]["total_files"] == 1
    assert st["archive_disk"]["excluded_on_disk"] == 1
    assert st["archive_disk"]["pending_transcription_on_disk"] == 0
    assert st["excluded"]["count"] == 1
