"""
Unified SQLite Canonical Storage & On-Demand Format Exporter.
"""

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from deeper_dhamma.config import ARCHIVE_DIR, PIPELINE_DB_PATH, TRANSCRIPTS_DB_PATH

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
    """Formats seconds into WebVTT timestamp: HH:MM:SS.mmm with exact carry-over."""
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hrs, rem_ms = divmod(total_ms, 3_600_000)
    mins, rem_ms = divmod(rem_ms, 60_000)
    secs, ms = divmod(rem_ms, 1000)
    return f"{hrs:02d}:{mins:02d}:{secs:02d}.{ms:03d}"


class PipelineStateDatabase:
    """
    Manages local operational state, disk audio file paths, transcription progress tracking,
    and pipeline error logs in a separate database (databases/pipeline_state.db) so that
    dhamma_transcripts.db contains only pure, publishable domain data.
    """

    def __init__(self, db_path: Union[Path, str] = PIPELINE_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        return conn

    def _init_schema(self) -> None:
        with self._get_connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS episode_states (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    episode_uid TEXT UNIQUE NOT NULL,
                    title TEXT,
                    filepath TEXT,
                    filename_stem TEXT,
                    year INTEGER,
                    is_transcribed INTEGER DEFAULT 0,
                    last_error TEXT,
                    last_error_at TEXT,
                    last_error_op TEXT,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE INDEX IF NOT EXISTS idx_episode_states_stem ON episode_states(filename_stem);
                CREATE INDEX IF NOT EXISTS idx_episode_states_transcribed ON episode_states(is_transcribed);
                """
            )

    def upsert_file_state(
        self,
        episode_uid: str,
        title: Optional[str] = None,
        filepath: Optional[str] = None,
        year: Optional[int] = None,
        is_transcribed: Optional[int] = None,
        clear_error: bool = False,
    ) -> None:
        stem = Path(filepath).stem if filepath else None
        trans_val = 1 if is_transcribed else 0
        with self._get_connection() as conn:
            with conn:
                if clear_error:
                    conn.execute(
                        """
                        INSERT INTO episode_states (
                            episode_uid, title, filepath, filename_stem, year, is_transcribed,
                            last_error, last_error_at, last_error_op, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
                        ON CONFLICT(episode_uid) DO UPDATE SET
                            title = COALESCE(NULLIF(excluded.title, ''), episode_states.title),
                            filepath = COALESCE(NULLIF(excluded.filepath, ''), episode_states.filepath),
                            filename_stem = COALESCE(NULLIF(excluded.filename_stem, ''), episode_states.filename_stem),
                            year = COALESCE(NULLIF(excluded.year, 0), episode_states.year),
                            is_transcribed = CASE WHEN excluded.is_transcribed = 1 THEN 1 ELSE episode_states.is_transcribed END,
                            last_error = NULL,
                            last_error_at = NULL,
                            last_error_op = NULL,
                            updated_at = CURRENT_TIMESTAMP;
                        """,
                        (episode_uid, title, filepath, stem, year, trans_val),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO episode_states (
                            episode_uid, title, filepath, filename_stem, year, is_transcribed, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(episode_uid) DO UPDATE SET
                            title = COALESCE(NULLIF(excluded.title, ''), episode_states.title),
                            filepath = COALESCE(NULLIF(excluded.filepath, ''), episode_states.filepath),
                            filename_stem = COALESCE(NULLIF(excluded.filename_stem, ''), episode_states.filename_stem),
                            year = COALESCE(NULLIF(excluded.year, 0), episode_states.year),
                            is_transcribed = CASE WHEN excluded.is_transcribed = 1 THEN 1 ELSE episode_states.is_transcribed END,
                            updated_at = CURRENT_TIMESTAMP;
                        """,
                        (episode_uid, title, filepath, stem, year, trans_val),
                    )

    def get_filepath(self, identifier: str) -> Optional[str]:
        raw = str(identifier).strip()
        candidates = [raw]
        if not raw.startswith("pb"):
            candidates.append(f"pb{raw}")
        elif raw.startswith("pb") and raw[2:].isdigit():
            candidates.append(raw[2:])

        placeholders = ", ".join(["?"] * len(candidates))
        with self._get_connection() as conn:
            row = conn.execute(
                f"""
                SELECT filepath FROM episode_states
                WHERE episode_uid IN ({placeholders}) OR filename_stem IN ({placeholders})
                LIMIT 1;
                """,
                candidates + candidates,
            ).fetchone()
            return row["filepath"] if row and row["filepath"] else None

    def get_filepath_map(self) -> Dict[str, str]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT episode_uid, filename_stem, filepath FROM episode_states WHERE filepath IS NOT NULL AND filepath != '';"
            ).fetchall()
            mapping: Dict[str, str] = {}
            for r in rows:
                mapping[r["episode_uid"]] = r["filepath"]
                if r["filename_stem"]:
                    mapping[r["filename_stem"]] = r["filepath"]
            return mapping

    def resolve_episode_uid(self, identifier: str) -> Optional[str]:
        with self._get_connection() as conn:
            row = conn.execute(
                """
                SELECT episode_uid FROM episode_states
                WHERE episode_uid = ? OR filename_stem = ? OR filepath LIKE ?
                LIMIT 1;
                """,
                (identifier, identifier, f"%{identifier}%"),
            ).fetchone()
            return row["episode_uid"] if row else None

    def record_error(
        self,
        episode_id: str,
        error_message: str,
        operation: Optional[str] = None,
        filepath: Optional[str] = None,
        title: Optional[str] = None,
        year: Optional[int] = None,
    ) -> None:
        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()
        clean_err = str(error_message).strip()
        stem = Path(filepath).stem if filepath else None
        if not year and filepath:
            for part in Path(filepath).parts:
                if part.isdigit() and len(part) == 4:
                    year = int(part)
                    break

        with self._get_connection() as conn:
            with conn:
                conn.execute(
                    """
                    INSERT INTO episode_states (
                        episode_uid, title, filepath, filename_stem, year, is_transcribed,
                        last_error, last_error_at, last_error_op, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(episode_uid) DO UPDATE SET
                        title = COALESCE(NULLIF(excluded.title, ''), episode_states.title),
                        filepath = COALESCE(NULLIF(excluded.filepath, ''), episode_states.filepath),
                        filename_stem = COALESCE(NULLIF(excluded.filename_stem, ''), episode_states.filename_stem),
                        year = COALESCE(NULLIF(excluded.year, 0), episode_states.year),
                        last_error = excluded.last_error,
                        last_error_at = excluded.last_error_at,
                        last_error_op = excluded.last_error_op,
                        updated_at = CURRENT_TIMESTAMP;
                    """,
                    (episode_id, title or episode_id, filepath, stem, year, clean_err, now_iso, operation),
                )

    def get_error(self, episode_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            row = conn.execute(
                """
                SELECT id AS state_id, episode_uid AS id, title, filepath, year,
                       last_error, last_error_at, last_error_op
                FROM episode_states
                WHERE (episode_uid = ? OR filename_stem = ?)
                  AND last_error IS NOT NULL AND last_error != ''
                LIMIT 1;
                """,
                (episode_id, episode_id),
            ).fetchone()
            return dict(row) if row else None

    def clear_error(self, episode_id: str) -> None:
        with self._get_connection() as conn:
            with conn:
                conn.execute(
                    """
                    UPDATE episode_states
                    SET last_error = NULL,
                        last_error_at = NULL,
                        last_error_op = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE episode_uid = ? OR filename_stem = ?;
                    """,
                    (episode_id, episode_id),
                )

    def list_errors(self, operation: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            if operation:
                cur = conn.execute(
                    """
                    SELECT id AS state_id, episode_uid AS id, title, filepath, year,
                           last_error, last_error_at, last_error_op
                    FROM episode_states
                    WHERE last_error IS NOT NULL AND last_error != '' AND last_error_op = ?
                    ORDER BY last_error_at DESC;
                    """,
                    (operation,),
                )
            else:
                cur = conn.execute(
                    """
                    SELECT id AS state_id, episode_uid AS id, title, filepath, year,
                           last_error, last_error_at, last_error_op
                    FROM episode_states
                    WHERE last_error IS NOT NULL AND last_error != ''
                    ORDER BY last_error_at DESC;
                    """
                )
            return [dict(r) for r in cur.fetchall()]


class TranscriptDatabase:
    """Manages the canonical SQLite transcripts and FTS5 search database."""

    def __init__(
        self,
        db_path: Union[Path, str] = TRANSCRIPTS_DB_PATH,
        pipeline_db_path: Optional[Union[Path, str]] = None,
    ):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        if pipeline_db_path is not None:
            resolved_pipe_path = Path(pipeline_db_path)
        elif self.db_path.resolve() == TRANSCRIPTS_DB_PATH.resolve():
            resolved_pipe_path = PIPELINE_DB_PATH
        else:
            resolved_pipe_path = self.db_path.with_name(f"{self.db_path.stem}_pipeline.db")
        self.pipeline_db = PipelineStateDatabase(resolved_pipe_path)
        self._init_schema()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA cache_size = -64000;")
        conn.execute("PRAGMA mmap_size = 268435456;")
        conn.execute("PRAGMA temp_store = MEMORY;")
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
                    identified_teachers TEXT,
                    is_transcribed INTEGER DEFAULT 0,
                    media_url TEXT,
                    permalink TEXT,
                    duration_sec REAL NOT NULL,
                    is_multi_speaker INTEGER DEFAULT 0,
                    speaker_shares TEXT,
                    terminology_changelog TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS teachers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL,
                    default_role TEXT DEFAULT 'monastic_primary',
                    color TEXT DEFAULT '#f59e0b',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS episode_teachers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
                    detection_source TEXT NOT NULL,
                    confidence REAL DEFAULT 1.0,
                    share REAL DEFAULT 0.0,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(episode_id, teacher_id, detection_source)
                );

                CREATE VIEW IF NOT EXISTS v_episode_teachers AS
                SELECT
                    et.id AS association_id,
                    e.id AS episode_id,
                    e.title AS episode_title,
                    t.id AS teacher_id,
                    t.slug AS teacher_slug,
                    t.display_name AS teacher_name,
                    et.detection_source,
                    et.confidence,
                    et.share,
                    e.identified_teachers
                FROM episode_teachers et
                JOIN episodes e ON et.episode_id = e.id
                JOIN teachers t ON et.teacher_id = t.id;

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

                CREATE TABLE IF NOT EXISTS episode_words (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    episode_id TEXT UNIQUE NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    words_blob BLOB NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE INDEX IF NOT EXISTS idx_episode_words_episode_id ON episode_words(episode_id);

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

        self.seed_teachers()

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

        filepath = episode_metadata.get("filepath", "")

        with self._get_connection() as conn:
            with conn:
                conn.execute(
                    """
                    INSERT INTO episodes (
                        id, title, date, year, primary_teacher, primary_display,
                        identified_teachers, is_transcribed,
                        media_url, permalink, duration_sec, is_multi_speaker,
                        speaker_shares, terminology_changelog
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        title = excluded.title,
                        date = excluded.date,
                        year = excluded.year,
                        primary_teacher = excluded.primary_teacher,
                        primary_display = excluded.primary_display,
                        identified_teachers = COALESCE(episodes.identified_teachers, excluded.identified_teachers),
                        is_transcribed = 1,
                        media_url = excluded.media_url,
                        permalink = excluded.permalink,
                        duration_sec = excluded.duration_sec,
                        is_multi_speaker = excluded.is_multi_speaker,
                        speaker_shares = excluded.speaker_shares,
                        terminology_changelog = excluded.terminology_changelog;
                    """,
                    (
                        ep_id, title, date_display, year_int, primary_slug, primary_display,
                        primary_display,
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

        self.pipeline_db.upsert_file_state(
            episode_uid=ep_id,
            title=title,
            filepath=filepath or None,
            year=year_int,
            is_transcribed=1,
            clear_error=True,
        )

        if primary_slug and primary_slug != "unknown_teacher":
            self.associate_teacher(
                episode_id=ep_id,
                teacher_slug=primary_slug,
                detection_source="pipeline",
                confidence=1.0,
                share=1.0,
            )

        logger.info(f"[✓] Saved '{title}' to database ({len(segment_rows)} turns indexed).")

    def seed_teachers(self, teachers: Optional[List[Dict]] = None) -> int:
        """Seeds the teachers table with known monastics, roles, and color palettes."""
        if teachers is None:
            try:
                from deeper_dhamma.catalog import KNOWN_TEACHERS
                teachers = KNOWN_TEACHERS
            except ImportError:
                teachers = []

        added = 0
        with self._get_connection() as conn:
            with conn:
                for t in teachers:
                    cur = conn.execute(
                        """
                        INSERT INTO teachers (slug, display_name, default_role, color)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(slug) DO UPDATE SET
                            display_name = excluded.display_name,
                            default_role = excluded.default_role,
                            color = excluded.color;
                        """,
                        (t["slug"], t["display_name"], t.get("default_role", "monastic_primary"), t.get("color", "#f59e0b")),
                    )
                    if cur.rowcount > 0:
                        added += 1

                # Special non-monastic dialogue roles
                special_roles = [
                    ("questioner", "Questioner", "lay_questioner", "#94a3b8"),
                    ("unregistered_speaker", "Unregistered Speaker", "unregistered", "#64748b"),
                    ("unknown_teacher", "Unknown Teacher", "unregistered", "#64748b"),
                ]
                for s_slug, s_name, s_role, s_color in special_roles:
                    conn.execute(
                        """
                        INSERT INTO teachers (slug, display_name, default_role, color)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(slug) DO UPDATE SET
                            display_name = excluded.display_name,
                            default_role = excluded.default_role,
                            color = excluded.color;
                        """,
                        (s_slug, s_name, s_role, s_color),
                    )
        return added

    def get_all_teachers(self) -> List[Dict]:
        """Returns all teachers with id, slug, display_name, default_role, and color."""
        with self._get_connection() as conn:
            cur = conn.execute("SELECT id, slug, display_name, default_role, color FROM teachers ORDER BY id ASC;")
            return [dict(r) for r in cur.fetchall()]

    def associate_teacher(
        self,
        episode_id: str,
        teacher_slug: str,
        detection_source: str = "filename",
        confidence: float = 1.0,
        share: float = 0.0,
    ) -> None:
        """
        Associates a teacher with an episode in `episode_teachers` and updates
        the denormalized `identified_teachers` summary column on `episodes`.
        """
        with self._get_connection() as conn:
            with conn:
                cur = conn.execute("SELECT id, display_name FROM teachers WHERE slug = ?;", (teacher_slug,))
                row = cur.fetchone()
                if not row:
                    cur2 = conn.execute(
                        "INSERT INTO teachers (slug, display_name) VALUES (?, ?);",
                        (teacher_slug, teacher_slug.replace("_", " ").title()),
                    )
                    teacher_id = cur2.lastrowid
                    display_name = teacher_slug.replace("_", " ").title()
                else:
                    teacher_id = row["id"]
                    display_name = row["display_name"]

                conn.execute(
                    """
                    INSERT INTO episode_teachers (
                        episode_id, teacher_id, detection_source, confidence, share
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(episode_id, teacher_id, detection_source) DO UPDATE SET
                        confidence = excluded.confidence,
                        share = excluded.share;
                    """,
                    (episode_id, teacher_id, detection_source, confidence, share),
                )

                # Recompute identified_teachers summary column
                assoc_rows = conn.execute(
                    """
                    SELECT t.display_name, et.detection_source, et.confidence
                    FROM episode_teachers et
                    JOIN teachers t ON et.teacher_id = t.id
                    WHERE et.episode_id = ?
                    ORDER BY et.confidence DESC, et.id ASC;
                    """,
                    (episode_id,),
                ).fetchall()

                items = []
                for a in assoc_rows:
                    if a["display_name"] == "Unknown Teacher" and len(assoc_rows) > 1:
                        continue
                    if a["detection_source"] == "voiceprint":
                        items.append(f"{a['display_name']} (voiceprint {a['confidence']:.2f})")
                    else:
                        items.append(a["display_name"])

                unique_items = list(dict.fromkeys(items))
                summary_str = ", ".join(unique_items) if unique_items else display_name

                conn.execute(
                    "UPDATE episodes SET identified_teachers = ? WHERE id = ?;",
                    (summary_str, episode_id),
                )

    def index_archive_audio_files(
        self,
        archive_dir: Path | str = ARCHIVE_DIR,
    ) -> Dict[str, int]:
        """
        Indexes all audio files on disk into `episodes` and creates initial teacher
        associations in `episode_teachers` and `identified_teachers` from filenames.
        """
        from deeper_dhamma.catalog import (
            extract_year_and_date,
            identify_all_teachers,
            identify_primary_teacher,
            is_english_talk,
            parse_episode_metadata,
        )
        from deeper_dhamma.config import CATALOG_PATH
        import html

        archive_dir = Path(archive_dir)
        total_files = 0
        added_episodes = 0
        associated_teachers = 0

        catalog_map = {}
        catalog_by_id = {}
        if CATALOG_PATH and Path(CATALOG_PATH).exists():
            try:
                with open(CATALOG_PATH, "r", encoding="utf-8") as f:
                    cat_list = json.load(f)
                for ep in cat_list:
                    ep_id_val = ep.get("id")
                    if ep_id_val:
                        catalog_by_id[ep_id_val] = ep
                    _, _, fname = parse_episode_metadata(ep.get("title", ""), ep.get("upload_date", ""))
                    if fname not in catalog_map or ep.get("media_url"):
                        catalog_map[fname] = ep
            except Exception as e:
                logger.warning(f"Could not load catalog in scan_archive_directory: {e}")

        permanently_broken_ids = {
            r["id"]
            for r in self.pipeline_db.list_errors()
            if "404" in (r.get("last_error") or "") or "removed from cdn" in (r.get("last_error") or "").lower()
        }

        with self._get_connection() as conn:
            with conn:
                teacher_id_map = {
                    r["slug"]: (r["id"], r["display_name"])
                    for r in conn.execute("SELECT id, slug, display_name FROM teachers;").fetchall()
                }

                for p in archive_dir.rglob("*"):
                    if not p.is_file():
                        continue
                    if p.name.endswith(".temp.mp3") or p.name.endswith(".temp.m4a"):
                        continue
                    if p.suffix.lower() not in (".mp3", ".m4a"):
                        continue

                    total_files += 1
                    stem = p.stem
                    year_str, _, _ = parse_episode_metadata(p.name, "")
                    year_val = int(year_str) if str(year_str).isdigit() else 0
                    teacher_slug, teacher_display = identify_primary_teacher(p.name)

                    cat_ep = catalog_map.get(stem)
                    if cat_ep:
                        ep_id = cat_ep.get("id") or stem
                        clean_title = html.unescape(cat_ep.get("title", stem))
                        media_url = cat_ep.get("media_url")
                        permalink = cat_ep.get("permalink")
                        upload_date = cat_ep.get("upload_date", "")
                        yr_s, date_display = extract_year_and_date(clean_title, upload_date)
                        if str(yr_s).isdigit():
                            year_val = int(yr_s)
                        t_slug, t_disp = identify_primary_teacher(clean_title)
                        if t_slug != "unknown_teacher":
                            teacher_slug, teacher_display = t_slug, t_disp
                    else:
                        ep_id = stem
                        clean_title = stem.replace("_", " ").title()
                        media_url = None
                        permalink = None
                        date_display = str(year_val) if year_val else ""

                    # Check if canonical episode exists
                    cur = conn.execute(
                        "SELECT id, is_transcribed, primary_teacher, primary_display, identified_teachers FROM episodes WHERE id = ?;",
                        (ep_id,),
                    )
                    row = cur.fetchone()
                    is_trans_val = 1 if (row and row["is_transcribed"]) else 0

                    # Record local filepath and transcription state in pipeline_state.db
                    self.pipeline_db.upsert_file_state(
                        episode_uid=ep_id,
                        title=clean_title,
                        filepath=str(p),
                        year=year_val,
                        is_transcribed=is_trans_val,
                    )

                    if ep_id in permanently_broken_ids and not is_trans_val:
                        continue

                    if not row:
                        if media_url or is_trans_val:
                            conn.execute(
                                """
                                INSERT INTO episodes (
                                    id, title, date, year, primary_teacher, primary_display,
                                    duration_sec, is_transcribed, identified_teachers,
                                    media_url, permalink
                                ) VALUES (?, ?, ?, ?, ?, ?, 0.0, 0, ?, ?, ?);
                                """,
                                (
                                    ep_id,
                                    clean_title,
                                    date_display,
                                    year_val,
                                    teacher_slug,
                                    teacher_display,
                                    teacher_display,
                                    media_url,
                                    permalink,
                                ),
                            )
                            added_episodes += 1
                    else:
                        conn.execute(
                            """
                            UPDATE episodes SET
                                date = COALESCE(NULLIF(date, ''), ?),
                                year = COALESCE(NULLIF(year, 0), ?),
                                primary_teacher = CASE WHEN primary_teacher IS NULL OR primary_teacher = '' OR primary_teacher = 'unknown_teacher' THEN ? ELSE primary_teacher END,
                                primary_display = CASE WHEN primary_display IS NULL OR primary_display = '' OR primary_display = 'Unknown Teacher' THEN ? ELSE primary_display END,
                                identified_teachers = COALESCE(NULLIF(identified_teachers, ''), ?),
                                media_url = COALESCE(NULLIF(media_url, ''), ?),
                                permalink = COALESCE(NULLIF(permalink, ''), ?),
                                title = CASE WHEN title LIKE '%.mp3' OR title LIKE '%.m4a' OR title = id THEN ? ELSE title END
                            WHERE id = ?;
                            """,
                            (
                                date_display,
                                year_val,
                                teacher_slug,
                                teacher_display,
                                teacher_display,
                                media_url,
                                permalink,
                                clean_title,
                                ep_id,
                            ),
                        )

                    # Associate initial teacher from filename/title if episode exists in episodes
                    if row or media_url:
                        t_info = teacher_id_map.get(teacher_slug)
                        if t_info:
                            t_id = t_info[0]
                            cur_assoc = conn.execute(
                                """
                                INSERT INTO episode_teachers (
                                    episode_id, teacher_id, detection_source, confidence, share
                                ) VALUES (?, ?, 'filename', 1.0, 1.0)
                                ON CONFLICT(episode_id, teacher_id, detection_source) DO NOTHING;
                                """,
                                (ep_id, t_id),
                            )
                            if cur_assoc.rowcount > 0:
                                associated_teachers += 1

                # Reconcile any remaining catalog episodes in database
                for ep_id, cat_ep in catalog_by_id.items():
                    if ep_id in permanently_broken_ids:
                        continue
                    raw_title = cat_ep.get("title", "")
                    clean_title = html.unescape(raw_title)
                    if not is_english_talk(clean_title):
                        continue
                    media_url = cat_ep.get("media_url") or None
                    permalink = cat_ep.get("permalink") or None
                    upload_date = cat_ep.get("upload_date", "")
                    yr_s, date_display = extract_year_and_date(clean_title, upload_date)
                    year_val = int(yr_s) if str(yr_s).isdigit() else 0
                    t_slug, t_disp = identify_primary_teacher(clean_title)
                    all_t = identify_all_teachers(clean_title)
                    id_teachers_str = ", ".join(d for _, d in all_t) if all_t else t_disp

                    existing = conn.execute(
                        "SELECT id, date, year, primary_teacher, primary_display, identified_teachers, media_url FROM episodes WHERE id = ?;",
                        (ep_id,),
                    ).fetchone()
                    if existing:
                        conn.execute(
                            """
                            UPDATE episodes SET
                                title = COALESCE(NULLIF(title, ''), ?),
                                date = COALESCE(NULLIF(date, ''), ?),
                                year = COALESCE(NULLIF(year, 0), ?),
                                primary_teacher = CASE WHEN primary_teacher IS NULL OR primary_teacher = '' OR primary_teacher = 'unknown_teacher' THEN ? ELSE primary_teacher END,
                                primary_display = CASE WHEN primary_display IS NULL OR primary_display = '' OR primary_display = 'Unknown Teacher' THEN ? ELSE primary_display END,
                                identified_teachers = COALESCE(NULLIF(identified_teachers, ''), ?),
                                media_url = COALESCE(NULLIF(media_url, ''), ?),
                                permalink = COALESCE(NULLIF(permalink, ''), ?)
                            WHERE id = ?;
                            """,
                            (
                                clean_title,
                                date_display,
                                year_val,
                                t_slug,
                                t_disp,
                                id_teachers_str,
                                media_url,
                                permalink,
                                ep_id,
                            ),
                        )
                    elif media_url:
                        conn.execute(
                            """
                            INSERT INTO episodes (
                                id, title, date, year, primary_teacher, primary_display,
                                duration_sec, is_transcribed, identified_teachers,
                                media_url, permalink
                            ) VALUES (?, ?, ?, ?, ?, ?, 0.0, 0, ?, ?, ?);
                            """,
                            (
                                ep_id,
                                clean_title,
                                date_display,
                                year_val,
                                t_slug,
                                t_disp,
                                id_teachers_str,
                                media_url,
                                permalink,
                            ),
                        )
                        added_episodes += 1

                    if not existing and not media_url:
                        continue

                    # Ensure all teachers identified in title are linked in episode_teachers
                    for slug_item, _ in (all_t or [(t_slug, t_disp)]):
                        t_info = teacher_id_map.get(slug_item)
                        if t_info:
                            conn.execute(
                                """
                                INSERT INTO episode_teachers (
                                    episode_id, teacher_id, detection_source, confidence, share
                                ) VALUES (?, ?, 'filename', 1.0, 1.0)
                                ON CONFLICT(episode_id, teacher_id, detection_source) DO NOTHING;
                                """,
                                (ep_id, t_info[0]),
                            )

                # Recompute identified_teachers where episode_teachers has voiceprint or catalog_scan entries
                ep_rows = conn.execute(
                    """
                    SELECT DISTINCT episode_id FROM episode_teachers
                    WHERE detection_source IN ('voiceprint', 'catalog_scan', 'pipeline');
                    """
                ).fetchall()
                for er in ep_rows:
                    eid = er["episode_id"]
                    assoc_rows = conn.execute(
                        """
                        SELECT t.slug, t.display_name, et.detection_source, et.confidence
                        FROM episode_teachers et
                        JOIN teachers t ON et.teacher_id = t.id
                        WHERE et.episode_id = ?
                        ORDER BY
                            CASE et.detection_source
                                WHEN 'pipeline' THEN 1
                                WHEN 'catalog_scan' THEN 2
                                WHEN 'voiceprint' THEN 3
                                ELSE 4
                            END ASC,
                            et.confidence DESC,
                            et.id ASC;
                        """,
                        (eid,),
                    ).fetchall()
                    if assoc_rows:
                        items = []
                        primary_cand = None
                        for a in assoc_rows:
                            if a["display_name"] == "Unknown Teacher" and len(assoc_rows) > 1:
                                continue
                            if primary_cand is None and a["slug"] != "unknown_teacher":
                                primary_cand = (a["slug"], a["display_name"])
                            if a["detection_source"] == "voiceprint":
                                items.append(f"{a['display_name']} (voiceprint {a['confidence']:.2f})")
                            else:
                                items.append(a["display_name"])
                        unique_items = list(dict.fromkeys(items))
                        if unique_items:
                            conn.execute(
                                "UPDATE episodes SET identified_teachers = ? WHERE id = ?;",
                                (", ".join(unique_items), eid),
                            )
                        if primary_cand:
                            conn.execute(
                                """
                                UPDATE episodes
                                SET primary_teacher = CASE WHEN primary_teacher IS NULL OR primary_teacher = '' OR primary_teacher = 'unknown_teacher' THEN ? ELSE primary_teacher END,
                                    primary_display = CASE WHEN primary_display IS NULL OR primary_display = '' OR primary_display = 'Unknown Teacher' THEN ? ELSE primary_display END
                                WHERE id = ?;
                                """,
                                (primary_cand[0], primary_cand[1], eid),
                            )

                # Clean up any leftover non-pb rows that match catalog_map and any empty unplayable draft rows
                leftover_stems = conn.execute(
                    "SELECT id, primary_teacher, primary_display, identified_teachers FROM episodes WHERE id NOT LIKE 'pb%' AND is_transcribed = 0;"
                ).fetchall()
                for lr in leftover_stems:
                    l_stem = lr["id"]
                    c_ep = catalog_map.get(l_stem)
                    if c_ep and c_ep.get("id") and c_ep.get("id") != l_stem:
                        target_pb = c_ep["id"]
                        conn.execute(
                            """
                            INSERT OR IGNORE INTO episode_teachers (
                                episode_id, teacher_id, detection_source, confidence, share
                            )
                            SELECT ?, teacher_id, detection_source, confidence, share
                            FROM episode_teachers WHERE episode_id = ?;
                            """,
                            (target_pb, l_stem),
                        )
                        conn.execute("DELETE FROM episode_teachers WHERE episode_id = ?;", (l_stem,))
                        conn.execute("DELETE FROM episodes WHERE id = ? AND is_transcribed = 0;", (l_stem,))

                if permanently_broken_ids:
                    placeholders = ", ".join("?" for _ in permanently_broken_ids)
                    conn.execute(
                        f"DELETE FROM episodes WHERE is_transcribed = 0 AND id IN ({placeholders});",
                        tuple(permanently_broken_ids),
                    )
                conn.execute(
                    """
                    DELETE FROM episodes
                    WHERE is_transcribed = 0
                      AND (media_url IS NULL OR media_url = '');
                    """
                )
                conn.execute("DELETE FROM episode_teachers WHERE episode_id NOT IN (SELECT id FROM episodes);")

        return {
            "total_audio_files": total_files,
            "new_episodes_indexed": added_episodes,
            "filename_associations": associated_teachers,
        }

    def has_episode(self, episode_id: str) -> bool:
        resolved_uid = self.pipeline_db.resolve_episode_uid(episode_id) or episode_id
        with self._get_connection() as conn:
            cur = conn.execute(
                "SELECT 1 FROM episodes WHERE id IN (?, ?) AND is_transcribed = 1 LIMIT 1;",
                (episode_id, resolved_uid),
            )
            return cur.fetchone() is not None

    def resolve_audio_path(
        self,
        identifier: str,
        archive_dir: Optional[Union[Path, str]] = None,
    ) -> Tuple[Optional[Path], Optional[str]]:
        """
        Resolves an episode identifier (Podbean ID like 'pbXXXX', filename stem, or raw path)
        to a verified local audio Path in the archive.

        Returns (path, None) on success, or (None, error_message) on failure.
        """
        from deeper_dhamma.catalog import parse_episode_metadata
        from deeper_dhamma.config import CATALOG_PATH

        raw = str(identifier).strip()
        if not raw:
            return None, "Episode identifier cannot be empty."

        p_direct = Path(raw)
        if p_direct.is_file() and p_direct.exists():
            return p_direct, None

        candidates = [raw]
        if not raw.startswith("pb"):
            candidates.append(f"pb{raw}")
        elif raw.startswith("pb") and raw[2:].isdigit():
            candidates.append(raw[2:])

        arch_dir = Path(archive_dir) if archive_dir else ARCHIVE_DIR
        expected_path: Optional[Path] = None

        # 1. Check pipeline_db episode_states
        for cid in candidates:
            fp = self.pipeline_db.get_filepath(cid)
            if fp:
                p = Path(fp)
                if p.is_file() and p.exists():
                    return p, None
                expected_path = p

        # 2. Check catalog.json
        cat_entry = None
        if CATALOG_PATH and Path(CATALOG_PATH).exists():
            try:
                with open(CATALOG_PATH, "r", encoding="utf-8") as f:
                    for entry in json.load(f):
                        if entry.get("id") in candidates:
                            cat_entry = entry
                            break
            except Exception as e:
                logger.debug(f"Could not read catalog in resolve_audio_path: {e}")

        if cat_entry:
            ep_year, ep_series, filename = parse_episode_metadata(
                cat_entry.get("title", ""), cat_entry.get("upload_date", "")
            )
            for ext in (".mp3", ".m4a"):
                p1 = arch_dir / ep_year / ep_series / f"{filename}{ext}"
                if p1.is_file() and p1.exists():
                    return p1, None
                p2 = arch_dir / ep_year / "standalone" / f"{filename}{ext}"
                if p2.is_file() and p2.exists():
                    return p2, None

            # Check if anywhere in arch_dir matches filename
            for ext in (".mp3", ".m4a", ".wav", ".aac"):
                matches = list(arch_dir.rglob(f"{filename}{ext}"))
                if matches and matches[0].is_file() and matches[0].exists():
                    return matches[0], None

            expected_file = arch_dir / ep_year / ep_series / f"{filename}.mp3"
            return None, f"Audio file for episode '{raw}' not found in local archive ({expected_file}). Run 'python main.py sync' to download it."

        # 3. Check archive for candidate substring
        for cid in candidates:
            matches = list(arch_dir.rglob(f"*{cid}*"))
            for m in matches:
                if m.is_file() and m.exists() and m.suffix.lower() in [".mp3", ".m4a", ".wav", ".aac"]:
                    return m, None

        if expected_path:
            return None, f"Audio file for episode '{raw}' not found in local archive ({expected_path}). Run 'python main.py sync' to download it."

        return None, f"Episode '{raw}' not found in catalog or archive."

    def get_episode(self, episode_id: str) -> Optional[Dict]:
        resolved_uid = self.pipeline_db.resolve_episode_uid(episode_id) or episode_id
        with self._get_connection() as conn:
            ep = conn.execute(
                "SELECT * FROM episodes WHERE id IN (?, ?) LIMIT 1;",
                (episode_id, resolved_uid),
            ).fetchone()
            if not ep:
                return None
            ep_dict = dict(ep)
            resolved_id = ep_dict["id"]
            ep_dict["filepath"] = self.pipeline_db.get_filepath(resolved_id) or ""
            try:
                ep_dict["speaker_shares"] = json.loads(ep_dict.get("speaker_shares") or "{}")
            except Exception:
                ep_dict["speaker_shares"] = {}
            try:
                ep_dict["terminology_changelog"] = json.loads(ep_dict.get("terminology_changelog") or "[]")
            except Exception:
                ep_dict["terminology_changelog"] = []

            segs = conn.execute(
                "SELECT * FROM speech_segments WHERE episode_id = ? ORDER BY turn_index ASC;",
                (resolved_id,),
            ).fetchall()
            ep_dict["segments"] = [dict(s) for s in segs]
            words_row = conn.execute(
                "SELECT words_blob FROM episode_words WHERE episode_id = ?;",
                (resolved_id,),
            ).fetchone()
            ep_dict["words_blob"] = bytes(words_row["words_blob"]) if words_row and words_row["words_blob"] else None
            return ep_dict

    def save_episode_words(self, episode_id: str, words_blob: bytes) -> None:
        """Saves compact word timing binary BLOB for an episode."""
        with self._get_connection() as conn:
            with conn:
                conn.execute(
                    """
                    INSERT INTO episode_words (episode_id, words_blob)
                    VALUES (?, ?)
                    ON CONFLICT(episode_id) DO UPDATE SET
                        words_blob = excluded.words_blob,
                        created_at = CURRENT_TIMESTAMP;
                    """,
                    (episode_id, sqlite3.Binary(words_blob)),
                )

    def get_episode_words(self, episode_id: str) -> Optional[bytes]:
        """Retrieves compact word timing binary BLOB for an episode."""
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT words_blob FROM episode_words WHERE episode_id = ?;",
                (episode_id,),
            ).fetchone()
            return bytes(row["words_blob"]) if row and row["words_blob"] else None

    def list_episodes(self, year: Optional[int] = None) -> List[Dict]:
        with self._get_connection() as conn:
            if year is not None:
                rows = conn.execute("SELECT * FROM episodes WHERE year = ? ORDER BY date ASC;", (year,)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM episodes ORDER BY date ASC;").fetchall()
            return [dict(r) for r in rows]

    def search_fts(
        self,
        query: str,
        limit: int = 25,
        return_meta: bool = False,
        exact: bool = False,
    ) -> Union[List[Dict], Tuple[List[Dict], Dict]]:
        """
        Executes full-text search with automatic tiered query expansion:
          Tier 1: Explicit syntax (if AND, OR, NOT, NEAR used) or Exact phrase
          Tier 2: Proximity match (NEAR - words within 15 words of each other)
          Tier 3: Prefix / stem matching (word*)
          Tier 4: Typo auto-correction (Levenshtein / difflib against transcript vocabulary)
          Tier 5: BM25 ranked 'any word' match (word1 OR word2)

        If `exact=True`, bypasses Tiers 2-5 and performs strict literal matching only.
        """
        import difflib
        import re

        clean_query = query.replace('\\"', '"').strip()
        words = re.findall(r"[a-zA-Z0-9]+", clean_query.lower())
        if not words:
            return ([], {"tier": "none", "effective_query": query, "corrected": False}) if return_meta else []

        with self._get_connection() as conn:
            sql = """
                SELECT
                    e.id as episode_id,
                    e.title,
                    e.date,
                    e.duration_sec,
                    e.primary_teacher as teacher_slug,
                    e.primary_display as teacher,
                    e.identified_teachers,
                    e.media_url,
                    e.permalink,
                    s.turn_index,
                    s.speaker_slug,
                    s.speaker_display,
                    s.start_sec,
                    s.end_sec,
                    s.text,
                    snippet(transcripts_fts, 1, '<b>', '</b>', '...', 15) as snippet_text
                FROM transcripts_fts
                JOIN speech_segments s ON transcripts_fts.rowid = s.id
                JOIN episodes e ON s.episode_id = e.id
                WHERE transcripts_fts MATCH ?
                ORDER BY rank
                LIMIT ?;
            """

            def _try_query(q_str: str) -> List[Dict]:
                try:
                    res = conn.execute(sql, (q_str, limit)).fetchall()
                    return [dict(r) for r in res]
                except sqlite3.OperationalError:
                    return []

            meta = {
                "tier": "exact",
                "original_query": query,
                "effective_query": query,
                "corrected": False,
            }

            # 0. Check for explicit boolean/operator syntax
            has_explicit_syntax = any(op in clean_query for op in [" AND ", " OR ", " NOT ", "NEAR("]) or (
                clean_query.startswith('"') and clean_query.endswith('"') and len(clean_query) > 2
            )
            if has_explicit_syntax:
                rows = _try_query(clean_query)
                if not rows:
                    escaped = '"' + clean_query.replace('"', '""') + '"'
                    rows = _try_query(escaped)
                meta["tier"] = "explicit"
                if return_meta:
                    return rows, meta
                return rows

            # Tier 1: Exact phrase (if >1 word) or exact word
            t1_q = f'"{clean_query}"' if len(words) > 1 else words[0]
            rows = _try_query(t1_q)
            if rows or exact:
                meta["tier"] = "exact_phrase" if len(words) > 1 else "exact_word"
                meta["effective_query"] = t1_q
                return (rows, meta) if return_meta else rows

            # Tier 2: Proximity match (NEAR - words in reasonable proximity)
            if len(words) > 1:
                t2_q = f"NEAR({' '.join(words)}, 15)"
                rows = _try_query(t2_q)
                if rows:
                    meta["tier"] = "proximity"
                    meta["effective_query"] = t2_q
                    return (rows, meta) if return_meta else rows

            # Tier 3: Prefix / Stem matching (word1* AND word2*)
            t3_q = " AND ".join(f"{w}*" for w in words)
            rows = _try_query(t3_q)
            if rows:
                meta["tier"] = "prefix"
                meta["effective_query"] = t3_q
                return (rows, meta) if return_meta else rows

            # Tier 4: Typo auto-correction (against transcript vocabulary)
            vocab_rows = conn.execute("SELECT text FROM speech_segments LIMIT 1000;").fetchall()
            vocab = set(re.findall(r"[a-zA-Z]{3,}", " ".join(r[0] for r in vocab_rows).lower()))
            corrected = []
            for w in words:
                if w not in vocab and len(w) >= 4:
                    matches = difflib.get_close_matches(w, vocab, n=1, cutoff=0.72)
                    corrected.append(matches[0] if matches else w)
                else:
                    corrected.append(w)

            if corrected != words:
                corr_phrase = " ".join(corrected)
                # Try exact corrected
                t4_exact = f'"{corr_phrase}"' if len(corrected) > 1 else corrected[0]
                rows = _try_query(t4_exact)
                if not rows and len(corrected) > 1:
                    # Try proximity corrected
                    t4_near = f"NEAR({' '.join(corrected)}, 15)"
                    rows = _try_query(t4_near)
                if rows:
                    meta["tier"] = "auto_corrected"
                    meta["effective_query"] = corr_phrase
                    meta["corrected"] = True
                    return (rows, meta) if return_meta else rows

            # Tier 5: Ranked BM25 'any word' match
            if len(words) > 1:
                t5_q = " OR ".join(words)
                rows = _try_query(t5_q)
                if rows:
                    meta["tier"] = "any_word"
                    meta["effective_query"] = t5_q
                    return (rows, meta) if return_meta else rows

            meta["tier"] = "none"
            return ([], meta) if return_meta else []

    def suggest_terms(self, query: str, n: int = 3) -> List[str]:
        """Suggests closest matching terms from the transcript vocabulary for typos."""
        import difflib
        import re
        clean_words = re.findall(r"[a-zA-Z]{3,}", query.lower())
        if not clean_words:
            return []
        target = clean_words[0]
        with self._get_connection() as conn:
            rows = conn.execute("SELECT text FROM speech_segments LIMIT 1000;").fetchall()
            if not rows:
                return []
            vocab = set(re.findall(r"[a-zA-Z]{3,}", " ".join(r[0] for r in rows).lower()))
            return difflib.get_close_matches(target, vocab, n=n, cutoff=0.70)

    def record_error(
        self,
        episode_id: str,
        error_message: str,
        operation: Optional[str] = None,
        filepath: Optional[str] = None,
        title: Optional[str] = None,
    ) -> None:
        """
        Records or updates the most recent error associated with an episode/archive file
        in the operational pipeline state database (`pipeline_state.db`).
        """
        self.pipeline_db.record_error(
            episode_id=episode_id,
            error_message=error_message,
            operation=operation,
            filepath=filepath,
            title=title,
        )

    def get_error(self, episode_id: str) -> Optional[Dict[str, Any]]:
        """Returns error metadata for an episode if an active error is recorded, else None."""
        return self.pipeline_db.get_error(episode_id)

    def check_preflight(
        self,
        episode_id: str,
        operation: str,
        retry_errors: bool = False,
        auto_resolver: Optional[Any] = None,
    ) -> Tuple[bool, Optional[str]]:
        """
        Pre-flight check before performing an operation on an episode/file.
        Checks for previous errors. Returns (should_proceed, message_or_reason).

        If an active error exists:
        - If retry_errors is True: clears error and permits operation.
        - If auto_resolver callable is supplied: attempts to resolve the error. If resolved,
          clears the error and permits operation.
        - Otherwise: blocks operation and returns (False, reason).
        """
        err_info = self.get_error(episode_id)
        if not err_info:
            return True, None

        last_op = err_info.get("last_error_op") or "unknown"
        last_msg = err_info.get("last_error") or ""
        last_at = err_info.get("last_error_at") or ""

        # 1. User requested retry
        if retry_errors:
            self.clear_error(episode_id)
            return True, f"cleared_for_retry (was {last_op}: {last_msg})"

        # 2. Automated resolution check (e.g. ghost file was deleted, file repaired)
        if auto_resolver and callable(auto_resolver):
            try:
                resolved = auto_resolver(err_info)
                if resolved:
                    self.clear_error(episode_id)
                    return True, f"resolved_automatically ({resolved})"
            except Exception as e:
                logger.debug(f"Resolver failed for {episode_id}: {e}")

        # 3. Known permanent dead links (e.g. 404 removed from CDN)
        if "404" in last_msg or "removed from cdn" in last_msg.lower():
            return False, f"Permanent 404 (removed from CDN on {last_at[:10]}): {last_msg}"

        return False, f"Active error recorded ({last_op} on {last_at[:10]}): {last_msg}"

    def clear_error(self, episode_id: str) -> None:
        """Clears the last_error tracking fields when an operation succeeds for an episode."""
        self.pipeline_db.clear_error(episode_id)

    def list_errors(self, operation: Optional[str] = None) -> List[Dict[str, Any]]:
        """Returns all episodes that currently have recorded errors in pipeline_state.db."""
        return self.pipeline_db.list_errors(operation=operation)

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
            safe_speaker = str(seg.get("speaker_display") or data["primary_display"]).replace(">", "").strip()
            safe_text = (
                str(seg.get("text") or "")
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
            )
            vtt_lines.append(f"{start_str} --> {end_str}")
            vtt_lines.append(f"<v {safe_speaker}>{safe_text}")
            vtt_lines.append("")

        return "\n".join(vtt_lines)

    def generate_json(self, episode_id: str) -> Dict:
        data = self.get_episode(episode_id)
        if not data:
            raise ValueError(f"Episode '{episode_id}' not found in database.")
        return data
