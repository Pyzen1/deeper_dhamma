"""
Unit tests verifying byte-level parity between local archive audio files and Podbean CDN streams.
"""

import os
import sqlite3
import struct
import urllib.error
import urllib.request
from pathlib import Path
import pytest

from deeper_dhamma.config import PROJECT_ROOT, TRANSCRIPTS_DB_PATH


def get_id3_size(header_bytes: bytes) -> int:
    if len(header_bytes) >= 10 and header_bytes[:3] == b"ID3":
        return ((header_bytes[6] << 21) | (header_bytes[7] << 14) | (header_bytes[8] << 7) | header_bytes[9]) + 10
    return 0


def test_transcribed_episodes_cdn_parity():
    """
    Verifies that all transcribed episodes in the database have exact file size
    and ID3 tag length matching the remote Podbean CDN stream.
    """
    from deeper_dhamma.storage import TranscriptDatabase

    if not TRANSCRIPTS_DB_PATH.exists():
        pytest.skip("Transcript database not found")

    tdb = TranscriptDatabase(db_path=TRANSCRIPTS_DB_PATH)
    conn = sqlite3.connect(TRANSCRIPTS_DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.cursor().execute(
        "SELECT id, title, media_url FROM episodes WHERE is_transcribed = 1"
    ).fetchall()
    conn.close()

    assert len(rows) > 0, "No transcribed episodes found in database"

    for r in rows:
        fp = tdb.pipeline_db.get_filepath(r["id"])
        assert fp, f"No local filepath recorded in pipeline_state.db for {r['id']}"
        local_p = Path(fp)
        media_url = r["media_url"]
        
        assert local_p.exists(), f"Local audio file missing for {r['id']}: {local_p}"
        local_size = local_p.stat().st_size
        assert local_size > 1024 * 1024, f"Local audio file too small: {local_size} bytes"
        
        # Verify remote Content-Length
        try:
            req = urllib.request.Request(media_url, method="HEAD")
            with urllib.request.urlopen(req, timeout=10) as resp:
                remote_size = int(resp.headers.get("Content-Length", 0))
        except urllib.error.URLError as e:
            pytest.skip(f"CDN unreachable: {e}")
            
        assert local_size == remote_size, (
            f"Size mismatch on {r['id']}: local={local_size} bytes, remote={remote_size} bytes. "
            "Downloaded file must be an exact byte-for-byte copy of the CDN data."
        )
        
        # Verify ID3 length parity
        with open(local_p, "rb") as f:
            local_head = f.read(10)
        local_id3 = get_id3_size(local_head)
        
        try:
            req_id3 = urllib.request.Request(media_url, headers={"Range": "bytes=0-9"})
            with urllib.request.urlopen(req_id3, timeout=10) as resp:
                remote_head = resp.read()
        except urllib.error.URLError as e:
            pytest.skip(f"CDN unreachable: {e}")
        remote_id3 = get_id3_size(remote_head)
        
        assert local_id3 == remote_id3, (
            f"ID3 length mismatch on {r['id']}: local={local_id3} bytes, remote={remote_id3} bytes."
        )


def test_remote_and_local_first_frame_sync():
    """
    Verifies that the first MP3 MPEG audio frame sync occurs at the exact same
    byte offset in both the local archive file and the remote stream.
    """
    sample_mp3 = PROJECT_ROOT / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"
    url = "https://mcdn.podbean.com/mf/web/a2vs36pe6kjbzbwe/7_Guided_Meditation_Q_A_-_8th6vwu3.mp3"
    
    if not sample_mp3.exists():
        pytest.skip("Sample archive audio missing")
        
    with open(sample_mp3, "rb") as f:
        loc_data = f.read(300000)
        
    try:
        req = urllib.request.Request(url, headers={"Range": "bytes=0-299999"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            rem_data = resp.read()
    except urllib.error.URLError as e:
        pytest.skip(f"CDN unreachable: {e}")
        
    loc_id3 = get_id3_size(loc_data[:10])
    rem_id3 = get_id3_size(rem_data[:10])
    
    assert loc_id3 == rem_id3
    
    # First 300KB must match bit-for-bit
    assert loc_data == rem_data, "Local archive bytes diverge from remote CDN stream bytes!"


def test_operational_state_separated_from_transcript_db():
    """
    Verifies that local operational columns (`filepath`, `last_error*`) live exclusively in
    `databases/pipeline_state.db` (`episode_states`) and do not exist in `dhamma_transcripts.db`
    or `dist/dhamma_web.db`.
    """
    from deeper_dhamma.storage import TranscriptDatabase

    if not TRANSCRIPTS_DB_PATH.exists():
        pytest.skip("Transcript database not found")

    tdb = TranscriptDatabase(db_path=TRANSCRIPTS_DB_PATH)
    with tdb._get_connection() as conn:
        ep_cols = {r[1] for r in conn.execute("PRAGMA table_info(episodes)").fetchall()}

    forbidden_cols = {"filepath", "last_error", "last_error_at", "last_error_op"}
    assert ep_cols.isdisjoint(forbidden_cols), (
        f"dhamma_transcripts.db still contains operational columns: {ep_cols & forbidden_cols}"
    )

    with tdb.pipeline_db._get_connection() as pconn:
        state_cols = {r[1] for r in pconn.execute("PRAGMA table_info(episode_states)").fetchall()}
        pk_col = next(r[1] for r in pconn.execute("PRAGMA table_info(episode_states)").fetchall() if r[5] == 1)

    assert pk_col == "id", "episode_states must use integer primary key `id`"
    assert {"id", "episode_uid", "filepath", "last_error", "last_error_at", "last_error_op"}.issubset(state_cols)

