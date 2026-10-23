"""
Unified SQLite Canonical Storage & On-Demand Format Exporter.
"""

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from deeper_dhamma.config import ARCHIVE_DIR, TRANSCRIPTS_DB_PATH

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
                    filepath TEXT,
                    is_transcribed INTEGER DEFAULT 0,
                    media_url TEXT,
                    permalink TEXT,
                    duration_sec REAL NOT NULL,
                    is_multi_speaker INTEGER DEFAULT 0,
                    speaker_shares TEXT,
                    terminology_changelog TEXT,
                    last_error TEXT,
                    last_error_at TEXT,
                    last_error_op TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS teachers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL,
                    default_role TEXT DEFAULT 'monastic_primary',
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

            # Ensure columns exist on legacy episodes table
            cur = conn.execute("PRAGMA table_info(episodes);")
            cols = {row["name"] for row in cur.fetchall()}
            if "identified_teachers" not in cols:
                conn.execute("ALTER TABLE episodes ADD COLUMN identified_teachers TEXT;")
            if "filepath" not in cols:
                conn.execute("ALTER TABLE episodes ADD COLUMN filepath TEXT;")
            if "is_transcribed" not in cols:
                conn.execute("ALTER TABLE episodes ADD COLUMN is_transcribed INTEGER DEFAULT 0;")
                conn.execute("UPDATE episodes SET is_transcribed = 1 WHERE duration_sec > 0;")
            if "last_error" not in cols:
                conn.execute("ALTER TABLE episodes ADD COLUMN last_error TEXT;")
            if "last_error_at" not in cols:
                conn.execute("ALTER TABLE episodes ADD COLUMN last_error_at TEXT;")
            if "last_error_op" not in cols:
                conn.execute("ALTER TABLE episodes ADD COLUMN last_error_op TEXT;")

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
                        terminology_changelog = excluded.terminology_changelog,
                        last_error = NULL,
                        last_error_at = NULL,
                        last_error_op = NULL;
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
        """Seeds the teachers table with known monastics and roles."""
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
                        INSERT INTO teachers (slug, display_name, default_role)
                        VALUES (?, ?, ?)
                        ON CONFLICT(slug) DO UPDATE SET
                            display_name = excluded.display_name,
                            default_role = excluded.default_role;
                        """,
                        (t["slug"], t["display_name"], t.get("default_role", "monastic_primary")),
                    )
                    if cur.rowcount > 0:
                        added += 1
                conn.execute(
                    """
                    INSERT INTO teachers (slug, display_name, default_role)
                    VALUES ('unknown_teacher', 'Unknown Teacher', 'unregistered')
                    ON CONFLICT(slug) DO NOTHING;
                    """
                )
        return added

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
        from deeper_dhamma.catalog import identify_primary_teacher, parse_episode_metadata

        archive_dir = Path(archive_dir)
        total_files = 0
        added_episodes = 0
        associated_teachers = 0

        with self._get_connection() as conn:
            with conn:
                for p in archive_dir.rglob("*"):
                    if not p.is_file():
                        continue
                    if p.name.endswith(".temp.mp3") or p.name.endswith(".temp.m4a"):
                        continue
                    if p.suffix.lower() not in (".mp3", ".m4a"):
                        continue

                    total_files += 1
                    stem = p.stem
                    year_val, _, _ = parse_episode_metadata(p.name, "")
                    teacher_slug, teacher_display = identify_primary_teacher(p.name)

                    # Check if episode exists
                    cur = conn.execute(
                        "SELECT id, is_transcribed, identified_teachers FROM episodes WHERE id = ?;",
                        (stem,),
                    )
                    row = cur.fetchone()
                    if not row:
                        conn.execute(
                            """
                            INSERT INTO episodes (
                                id, title, date, year, primary_teacher, primary_display,
                                duration_sec, is_transcribed, filepath, identified_teachers
                            ) VALUES (?, ?, ?, ?, ?, ?, 0.0, 0, ?, ?);
                            """,
                            (
                                stem,
                                p.name,
                                str(year_val),
                                year_val,
                                teacher_slug,
                                teacher_display,
                                str(p),
                                teacher_display,
                            ),
                        )
                        added_episodes += 1
                    else:
                        conn.execute(
                            "UPDATE episodes SET filepath = ? WHERE id = ? AND (filepath IS NULL OR filepath = '');",
                            (str(p), stem),
                        )

                    # Associate initial teacher from filename
                    cur_t = conn.execute("SELECT id FROM teachers WHERE slug = ?;", (teacher_slug,))
                    t_row = cur_t.fetchone()
                    if t_row:
                        t_id = t_row["id"]
                        cur_assoc = conn.execute(
                            """
                            INSERT INTO episode_teachers (
                                episode_id, teacher_id, detection_source, confidence, share
                            ) VALUES (?, ?, 'filename', 1.0, 1.0)
                            ON CONFLICT(episode_id, teacher_id, detection_source) DO NOTHING;
                            """,
                            (stem, t_id),
                        )
                        if cur_assoc.rowcount > 0:
                            associated_teachers += 1

        return {
            "total_audio_files": total_files,
            "new_episodes_indexed": added_episodes,
            "filename_associations": associated_teachers,
        }

    def has_episode(self, episode_id: str) -> bool:
        with self._get_connection() as conn:
            cur = conn.execute(
                "SELECT 1 FROM episodes WHERE id = ? AND is_transcribed = 1 LIMIT 1;",
                (episode_id,),
            )
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
        Records or updates the most recent error associated with an episode/archive file.
        Inserts a tracking record if the episode is not yet cataloged.
        """
        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()
        clean_err = str(error_message).strip()

        with self._get_connection() as conn:
            with conn:
                cur = conn.execute("SELECT id FROM episodes WHERE id = ?;", (episode_id,))
                if cur.fetchone():
                    conn.execute(
                        """
                        UPDATE episodes
                        SET last_error = ?,
                            last_error_at = ?,
                            last_error_op = ?
                        WHERE id = ?;
                        """,
                        (clean_err, now_iso, operation, episode_id),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO episodes (
                            id, title, filepath, duration_sec, is_transcribed,
                            last_error, last_error_at, last_error_op
                        ) VALUES (?, ?, ?, 0.0, 0, ?, ?, ?);
                        """,
                        (
                            episode_id,
                            title or episode_id,
                            filepath,
                            clean_err,
                            now_iso,
                            operation,
                        ),
                    )

    def get_error(self, episode_id: str) -> Optional[Dict[str, Any]]:
        """Returns error metadata for an episode if an active error is recorded, else None."""
        with self._get_connection() as conn:
            cur = conn.execute(
                """
                SELECT id, title, filepath, last_error, last_error_at, last_error_op
                FROM episodes
                WHERE id = ? AND last_error IS NOT NULL AND last_error != ''
                LIMIT 1;
                """,
                (episode_id,),
            )
            row = cur.fetchone()
            return dict(row) if row else None

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
        with self._get_connection() as conn:
            with conn:
                conn.execute(
                    """
                    UPDATE episodes
                    SET last_error = NULL,
                        last_error_at = NULL,
                        last_error_op = NULL
                    WHERE id = ?;
                    """,
                    (episode_id,),
                )

    def list_errors(self, operation: Optional[str] = None) -> List[Dict[str, Any]]:
        """Returns all episodes that currently have recorded errors."""
        with self._get_connection() as conn:
            if operation:
                cur = conn.execute(
                    """
                    SELECT id, title, filepath, last_error, last_error_at, last_error_op
                    FROM episodes
                    WHERE last_error IS NOT NULL AND last_error != '' AND last_error_op = ?
                    ORDER BY last_error_at DESC;
                    """,
                    (operation,),
                )
            else:
                cur = conn.execute(
                    """
                    SELECT id, title, filepath, last_error, last_error_at, last_error_op
                    FROM episodes
                    WHERE last_error IS NOT NULL AND last_error != ''
                    ORDER BY last_error_at DESC;
                    """
                )
            return [dict(r) for r in cur.fetchall()]

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
