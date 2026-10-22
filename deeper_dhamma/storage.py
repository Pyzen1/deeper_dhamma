"""
Unified SQLite Canonical Storage & On-Demand Format Exporter.
"""

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from deeper_dhamma.config import TRANSCRIPTS_DB_PATH

logger = logging.getLogger("storage")


def format_timestamp_hhmmss(seconds: float) -> str:
    """Formats seconds into HH:MM:SS or MM:SS."""
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hrs > 0:
        return f"{hrs:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"


def format_timestamp_vtt(seconds: float) -> str:
    """Formats seconds into WebVTT timestamp: HH:MM:SS.mmm."""
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms >= 1000:
        ms = 999
    return f"{hrs:02d}:{mins:02d}:{secs:02d}.{ms:03d}"


class TranscriptDatabase:
    """Manages the canonical SQLite transcripts and FTS5 search database."""

    def __init__(self, db_path: Union[Path, str] = TRANSCRIPTS_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        return conn

    def _init_schema(self) -> None:
        """Initializes tables, triggers, and FTS5 external content virtual table."""
        with self._get_connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS episodes (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    date TEXT,
                    year INTEGER,
                    primary_teacher TEXT,
                    primary_display TEXT,
                    media_url TEXT,
                    permalink TEXT,
                    duration_sec REAL NOT NULL,
                    is_multi_speaker INTEGER DEFAULT 0,
                    speaker_shares TEXT,
                    terminology_changelog TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS speech_segments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    turn_index INTEGER NOT NULL,
                    start_sec REAL NOT NULL,
                    end_sec REAL NOT NULL,
                    speaker_slug TEXT NOT NULL,
                    speaker_display TEXT NOT NULL,
                    text TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_segments_ep_turn ON speech_segments(episode_id, turn_index);

                -- FTS5 External Content Virtual Table (zero data duplication)
                CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
                    speaker_display,
                    text,
                    content='speech_segments',
                    content_rowid='id'
                );

                -- FTS5 synchronization triggers
                CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON speech_segments BEGIN
                    INSERT INTO transcripts_fts(rowid, speaker_display, text)
                    VALUES (new.id, new.speaker_display, new.text);
                END;

                CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON speech_segments BEGIN
                    INSERT INTO transcripts_fts(transcripts_fts, rowid, speaker_display, text)
                    VALUES('delete', old.id, old.speaker_display, old.text);
                END;

                CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON speech_segments BEGIN
                    INSERT INTO transcripts_fts(transcripts_fts, rowid, speaker_display, text)
                    VALUES('delete', old.id, old.speaker_display, old.text);
                    INSERT INTO transcripts_fts(rowid, speaker_display, text)
                    VALUES (new.id, new.speaker_display, new.text);
                END;
                """
            )

    def save_episode(
        self,
        episode_metadata: Dict,
        attributed_segments: List[Dict],
        duration_sec: float,
        year: str,
        filename_stem: str,
        terminology_changelog: Optional[List[Dict]] = None,
    ) -> None:
        ep_id = episode_metadata.get("id", filename_stem)
        title = episode_metadata.get("title", filename_stem)
        media_url = episode_metadata.get("media_url", "")
        permalink = episode_metadata.get("permalink", "")
        primary_slug = episode_metadata.get("primary_teacher", "")
        primary_display = episode_metadata.get("primary_display", primary_slug)
        upload_date = episode_metadata.get("upload_date", "")

        date_display = (
            f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}"
            if len(upload_date) == 8
            else str(year)
        )
        year_int = int(year) if str(year).isdigit() else 0

        shares_json = json.dumps(episode_metadata.get("speaker_shares", {}), ensure_ascii=False)
        changelog_json = json.dumps(terminology_changelog or [], ensure_ascii=False)
        is_multi = 1 if episode_metadata.get("is_multi_speaker", False) else 0

        with self._get_connection() as conn:
            with conn:
                conn.execute(
                    """
                    INSERT INTO episodes (
                        id, title, date, year, primary_teacher, primary_display,
                        media_url, permalink, duration_sec, is_multi_speaker,
                        speaker_shares, terminology_changelog
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        date = excluded.date,
                        year = excluded.year,
                        primary_teacher = excluded.primary_teacher,
                        primary_display = excluded.primary_display,
                        media_url = excluded.media_url,
                        permalink = excluded.permalink,
                        duration_sec = excluded.duration_sec,
                        is_multi_speaker = excluded.is_multi_speaker,
                        speaker_shares = excluded.speaker_shares,
                        terminology_changelog = excluded.terminology_changelog;
                    """,
                    (
                        ep_id, title, date_display, year_int, primary_slug, primary_display,
                        media_url, permalink, duration_sec, is_multi,
                        shares_json, changelog_json,
                    ),
                )

                conn.execute("DELETE FROM speech_segments WHERE episode_id = ?;", (ep_id,))

                segment_rows = [
                    (
                        ep_id,
                        idx,
                        round(float(seg["start"]), 3),
                        round(float(seg["end"]), 3),
                        seg.get("speaker", "unknown"),
                        seg.get("speaker_display", seg.get("speaker", "Unknown")),
                        seg.get("text", "").strip(),
                    )
                    for idx, seg in enumerate(attributed_segments)
                ]
                conn.executemany(
                    """
                    INSERT INTO speech_segments (
                        episode_id, turn_index, start_sec, end_sec,
                        speaker_slug, speaker_display, text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?);
                    """,
                    segment_rows,
                )

        logger.info(f"[✓] Saved '{title}' to database ({len(segment_rows)} turns indexed).")

    def has_episode(self, episode_id: str) -> bool:
        with self._get_connection() as conn:
            cur = conn.execute("SELECT 1 FROM episodes WHERE id = ? LIMIT 1;", (episode_id,))
            return cur.fetchone() is not None

    def get_episode(self, episode_id: str) -> Optional[Dict]:
        with self._get_connection() as conn:
            ep = conn.execute("SELECT * FROM episodes WHERE id = ?;", (episode_id,)).fetchone()
            if not ep:
                return None
            ep_dict = dict(ep)
            ep_dict["speaker_shares"] = json.loads(ep_dict.get("speaker_shares") or "{}")
            ep_dict["terminology_changelog"] = json.loads(ep_dict.get("terminology_changelog") or "[]")

            segs = conn.execute(
                "SELECT * FROM speech_segments WHERE episode_id = ? ORDER BY turn_index ASC;",
                (episode_id,),
            ).fetchall()
            ep_dict["segments"] = [dict(s) for s in segs]
            return ep_dict

    def list_episodes(self, year: Optional[int] = None) -> List[Dict]:
        with self._get_connection() as conn:
            if year is not None:
                rows = conn.execute("SELECT * FROM episodes WHERE year = ? ORDER BY date ASC;", (year,)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM episodes ORDER BY date ASC;").fetchall()
            return [dict(r) for r in rows]

    def search_fts(self, query: str, limit: int = 25) -> List[Dict]:
        with self._get_connection() as conn:
            sql = """
                SELECT
                    e.id as episode_id,
                    e.title,
                    e.date,
                    e.primary_display as teacher,
                    s.start_sec,
                    s.end_sec,
                    snippet(transcripts_fts, 1, '<b>', '</b>', '...', 15) as snippet_text
                FROM transcripts_fts
                JOIN speech_segments s ON transcripts_fts.rowid = s.id
                JOIN episodes e ON s.episode_id = e.id
                WHERE transcripts_fts MATCH ?
                ORDER BY rank
                LIMIT ?;
            """
            rows = conn.execute(sql, (query, limit)).fetchall()
            return [dict(r) for r in rows]

    def generate_markdown(self, episode_id: str) -> str:
        data = self.get_episode(episode_id)
        if not data:
            raise ValueError(f"Episode '{episode_id}' not found in database.")

        stream_link = f"[Stream on Podbean]({data['media_url']})" if data.get("media_url") else "N/A"
        duration_fmt = format_timestamp_hhmmss(data["duration_sec"])

        lines = [
            f"# {data['title']}",
            f"- **Date**: {data['date']}",
            f"- **Primary Teacher**: {data['primary_display']}",
            f"- **Audio Stream**: {stream_link}",
            f"- **Duration**: {duration_fmt} ({data['duration_sec']:.1f}s)",
        ]

        changelog = data.get("terminology_changelog") or []
        if changelog:
            lines.append(f"- **Terminology Standardizations**: {len(changelog)} term(s) normalized")
            lines.append("")
            lines.append("> [!NOTE]")
            lines.append(f"> **Buddhist Terminology Corrections Applied ({len(changelog)})**:")
            for c in changelog:
                lines.append(f"> - `{c['original']}` -> `{c['replacement']}` ({c.get('count', 1)}x) [{c.get('category', 'general')}]")

        lines.extend(["", "---", ""])

        for seg in data["segments"]:
            ts = format_timestamp_hhmmss(seg["start_sec"])
            lines.append(f"### [{ts}] {seg['speaker_display']}")
            lines.append(seg["text"])
            lines.append("")

        return "\n".join(lines)

    def generate_webvtt(self, episode_id: str) -> str:
        data = self.get_episode(episode_id)
        if not data:
            raise ValueError(f"Episode '{episode_id}' not found in database.")

        vtt_lines = [
            "WEBVTT",
            f"NOTE Title: {data['title']}",
            f"NOTE Speaker: {data['primary_display']}",
            f"NOTE Date: {data['date']}",
            "",
        ]

        for seg in data["segments"]:
            start_str = format_timestamp_vtt(seg["start_sec"])
            end_str = format_timestamp_vtt(seg["end_sec"])
            vtt_lines.append(f"{start_str} --> {end_str}")
            vtt_lines.append(f"<v {seg['speaker_display']}>{seg['text']}")
            vtt_lines.append("")

        return "\n".join(vtt_lines)

    def generate_json(self, episode_id: str) -> Dict:
        data = self.get_episode(episode_id)
        if not data:
            raise ValueError(f"Episode '{episode_id}' not found in database.")
        return data
