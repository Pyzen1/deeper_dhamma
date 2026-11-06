"""
Unit tests for PipelineStateDatabase and TranscriptDatabase Storage Engines.
"""

from pathlib import Path
import sqlite3
import pytest

from deeper_dhamma.storage import (
    PipelineStateDatabase,
    TranscriptDatabase,
    format_timestamp_hhmmss,
    format_timestamp_vtt,
)


def test_format_timestamp_utilities():
    """Verifies timestamp formatting for display and WebVTT outputs."""
    assert format_timestamp_hhmmss(65.0) == "01:05"
    assert format_timestamp_hhmmss(3665.0) == "01:01:05"
    assert format_timestamp_vtt(0.0) == "00:00:00.000"
    assert format_timestamp_vtt(125.456) == "00:02:05.456"
    assert format_timestamp_vtt(3600.0) == "01:00:00.000"


def test_pipeline_state_database_crud(tmp_path: Path):
    """Verifies state tracking, error recording, and filepath resolution in pipeline_state.db."""
    pipe_db_path = tmp_path / "test_pipeline.db"
    pdb = PipelineStateDatabase(pipe_db_path)

    # 1. Primary key compliance
    with pdb._get_connection() as conn:
        pk_info = conn.execute("PRAGMA table_info(episode_states)").fetchall()
        pk_col = next(r[1] for r in pk_info if r[5] == 1)
        assert pk_col == "id", "episode_states must use integer primary key 'id'"

    # 2. Upsert file state
    pdb.upsert_file_state(
        episode_uid="pb10001",
        title="Mindfulness of Breathing",
        filepath="/archive/2026/breathing.mp3",
        year=2026,
        is_transcribed=1,
    )
    assert pdb.get_filepath("pb10001") == "/archive/2026/breathing.mp3"
    assert pdb.get_filepath("breathing") == "/archive/2026/breathing.mp3"
    assert pdb.resolve_episode_uid("breathing") == "pb10001"

    fp_map = pdb.get_filepath_map()
    assert fp_map.get("pb10001") == "/archive/2026/breathing.mp3"
    assert fp_map.get("breathing") == "/archive/2026/breathing.mp3"

    # 3. Record and clear errors
    pdb.record_error(
        episode_id="pb10002",
        error_message="Acoustic corrupt frame",
        operation="transcribe",
        filepath="/archive/2026/corrupt.mp3",
        title="Corrupt Audio",
        year=2026,
    )
    err = pdb.get_error("pb10002")
    assert err is not None
    assert err["last_error"] == "Acoustic corrupt frame"
    assert err["last_error_op"] == "transcribe"

    err_list = pdb.list_errors(operation="transcribe")
    assert len(err_list) == 1
    assert err_list[0]["id"] == "pb10002"

    pdb.clear_error("pb10002")
    assert pdb.get_error("pb10002") is None


def test_transcript_database_lifecycle_and_fts5_search(tmp_path: Path):
    """Verifies episode insertion, segment storage, FTS5 synchronization, and formats export."""
    db_path = tmp_path / "test_transcripts.db"
    tdb = TranscriptDatabase(db_path=db_path)

    # 1. Primary key compliance across all relational tables
    with tdb._get_connection() as conn:
        for tbl in ["teachers", "episode_teachers", "speech_segments"]:
            pk_info = conn.execute(f"PRAGMA table_info({tbl})").fetchall()
            pk_col = next(r[1] for r in pk_info if r[5] == 1)
            assert pk_col == "id", f"Table '{tbl}' must use integer primary key 'id'"

    # 2. Save episode with segments
    meta = {
        "id": "pb99999",
        "title": "Stillness and Peace",
        "date": "2026-03-28",
        "primary_teacher": "ajahn_brahm",
        "primary_display": "Ajahn Brahm",
        "media_url": "https://mcdn.podbean.com/test.mp3",
        "permalink": "https://podbean.com/test",
    }
    segments = [
        {
            "turn_index": 0,
            "start": 0.0,
            "end": 10.5,
            "speaker": "ajahn_brahm",
            "speaker_display": "Ajahn Brahm",
            "text": "Welcome to the meditation session on stillness and jhana.",
        },
        {
            "turn_index": 1,
            "start": 11.0,
            "end": 20.0,
            "speaker": "ajahn_brahm",
            "speaker_display": "Ajahn Brahm",
            "text": "When the mind is peaceful, samadhi arises naturally.",
        },
    ]

    tdb.save_episode(
        episode_metadata=meta,
        attributed_segments=segments,
        duration_sec=20.0,
        year="2026",
        filename_stem="2026-03-28_stillness_and_peace",
    )

    # 3. Retrieve episode
    ep = tdb.get_episode("pb99999")
    assert ep is not None
    assert ep["title"] == "Stillness and Peace"
    assert ep["primary_teacher"] == "ajahn_brahm"
    assert ep["is_transcribed"] == 1
    assert len(ep["segments"]) == 2
    assert ep["segments"][0]["text"].startswith("Welcome")

    # 4. FTS5 Search
    search_results = tdb.search_fts("samadhi")
    assert len(search_results) >= 1
    assert any("samadhi" in r.get("snippet_text", "").lower() or "samadhi" in r.get("text", "").lower() for r in search_results)

    # 5. Export formats
    md = tdb.generate_markdown("pb99999")
    assert "# Stillness and Peace" in md
    assert "Ajahn Brahm" in md
    assert "[00:00]" in md

    vtt = tdb.generate_webvtt("pb99999")
    assert "WEBVTT" in vtt
    assert "00:00:00.000 --> 00:00:10.500" in vtt

    json_data = tdb.generate_json("pb99999")
    assert json_data["title"] == "Stillness and Peace"

    # 6. Delete episode cascading
    with tdb._get_connection() as conn:
        with conn:
            conn.execute("DELETE FROM episodes WHERE id = ?;", ("pb99999",))

    assert tdb.get_episode("pb99999") is None
    assert len(tdb.search_fts("samadhi")) == 0
