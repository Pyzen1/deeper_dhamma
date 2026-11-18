"""
Static Web Site & SQLite WASM Compiler for Deeper Dhamma.

Compiles an immutable, serverless static web application into dist/:
1. Consolidates dhamma_transcripts.db and buddhism_lexicon.db into a single dhamma_web.db.
2. Stamps PRAGMA user_version = <YYYYMMDD> in the SQLite 100-byte file header.
3. Bundles official SQLite WASM engine, FTS5 virtual tables, and Web Worker client.
4. Pre-renders index.html with relative asset links and version stamps.
"""

from collections import Counter
from datetime import datetime
import gzip
import hashlib
import http.server
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from typing import Callable, Dict, Iterable, List, Optional, Tuple
import urllib.request
from pathlib import Path

from deeper_dhamma.config import (
    BUDDHISM_LEXICON_DB_PATH,
    DEFAULT_WEB_HOST,
    DEFAULT_WEB_PORT,
    DIST_DIR,
    PROJECT_ROOT,
    TRANSCRIPTS_DB_PATH,
)
from deeper_dhamma.status import make_progress_bar

logger = logging.getLogger("export_web")

_GITHUB_RECOMMENDED_MAX_BYTES = 50 * 1024 * 1024
_GITHUB_HARD_MAX_BYTES = 100 * 1024 * 1024

WEB_DIR = PROJECT_ROOT / "deeper_dhamma" / "web"
STATIC_SRC_DIR = WEB_DIR / "static"
VIEWS_SRC_DIR = WEB_DIR / "views"

SQLITE_WASM_URL = "https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.46.1-build1/sqlite-wasm/jswasm/sqlite3.wasm"
SQLITE_JS_URL = "https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.46.1-build1/sqlite-wasm/jswasm/sqlite3.js"


def ensure_wasm_assets(target_dir: Path) -> None:
    """Ensures official SQLite WASM binary and JS loader are present in target_dir."""
    target_dir.mkdir(parents=True, exist_ok=True)
    wasm_path = target_dir / "sqlite3.wasm"
    js_path = target_dir / "sqlite3.js"

    if not wasm_path.exists():
        logger.info(f"Downloading SQLite WASM engine from {SQLITE_WASM_URL} ...")
        urllib.request.urlretrieve(SQLITE_WASM_URL, wasm_path)
        logger.info(f"[✓] Downloaded sqlite3.wasm ({wasm_path.stat().st_size:,} bytes)")

    if not js_path.exists():
        logger.info(f"Downloading SQLite JS loader from {SQLITE_JS_URL} ...")
        urllib.request.urlretrieve(SQLITE_JS_URL, js_path)
        logger.info(f"[✓] Downloaded sqlite3.js ({js_path.stat().st_size:,} bytes)")


def _copy_lexicon_to_conn(conn: sqlite3.Connection) -> None:
    """Imports reference lexicon tables, views, and FTS5 index from BUDDHISM_LEXICON_DB_PATH."""
    lex_uri = BUDDHISM_LEXICON_DB_PATH.resolve().as_uri()
    logger.debug(f"Importing lexicon reference tables from {lex_uri} ...")
    lex_conn = sqlite3.connect(f"{lex_uri}?mode=ro", uri=True)
    try:
        lex_conn.execute("PRAGMA query_only = ON;")
        # Strip large compressed binary document blobs to keep web bundles light
        conn.execute("DROP TABLE IF EXISTS main.source_documents;")
        conn.execute("""
            CREATE TABLE main.source_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT UNIQUE NOT NULL,
                mirror_url TEXT NOT NULL,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                publisher TEXT NOT NULL,
                retrieved_date TEXT NOT NULL,
                content_format TEXT NOT NULL,
                uncompressed_bytes INTEGER NOT NULL,
                compressed_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                content_compressed BLOB,
                content_text TEXT
            );
        """)
        src_rows = lex_conn.execute(
            "SELECT id, url, mirror_url, title, author, publisher, retrieved_date, content_format, "
            "uncompressed_bytes, compressed_bytes, sha256, NULL, content_text FROM source_documents;"
        ).fetchall()
        conn.executemany("INSERT INTO main.source_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", src_rows)

        for tbl in ["terms", "phrase_rules"]:
            schema_row = lex_conn.execute(
                f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{tbl}';"
            ).fetchone()
            if schema_row and schema_row[0]:
                conn.execute(f"DROP TABLE IF EXISTS main.{tbl};")
                conn.execute(schema_row[0])
                rows = lex_conn.execute(f"SELECT * FROM {tbl};").fetchall()
                if rows:
                    placeholders = ",".join(["?"] * len(rows[0]))
                    conn.executemany(f"INSERT INTO main.{tbl} VALUES ({placeholders});", rows)
    finally:
        lex_conn.close()

    conn.execute("DROP VIEW IF EXISTS main.v_terms;")
    conn.execute("""
        CREATE VIEW main.v_terms AS
        SELECT
            t.id,
            t.pali_plain,
            t.pali_diacritic,
            t.category,
            t.translation_bodhi,
            t.translation_sujato,
            t.translation_brahm,
            t.translation_brahmali,
            t.english_description,
            t.context_keywords,
            t.phonetic_variants,
            t.source,
            t.source_document_id,
            COALESCE(t.source_url, s.url) AS source_url,
            s.mirror_url AS source_mirror_url,
            s.title AS source_title,
            s.author AS source_author
        FROM main.terms t
        LEFT JOIN main.source_documents s ON t.source_document_id = s.id;
    """)

    conn.execute("DROP TABLE IF EXISTS main.fts_terms;")
    conn.execute("""
        CREATE VIRTUAL TABLE main.fts_terms USING fts5(
            pali_plain,
            pali_diacritic,
            english_description,
            context_keywords,
            translation_bodhi,
            translation_sujato,
            translation_brahm,
            translation_brahmali,
            content='terms',
            content_rowid='id'
        );
    """)
    conn.execute("INSERT INTO main.fts_terms(fts_terms) VALUES('rebuild');")


def _build_search_vocab_into_conn(
    conn: sqlite3.Connection,
    seg_rows: Iterable[Tuple[Optional[str]]],
    progress_cb: Optional[Callable[[int], None]] = None,
) -> None:
    """Populates search_vocab from transcript segment rows and imported lexicon terms."""
    conn.execute("DROP TABLE IF EXISTS main.search_vocab;")
    conn.execute("""
        CREATE TABLE search_vocab (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT UNIQUE NOT NULL,
            count INTEGER NOT NULL
        );
    """)
    vocab_counter: Counter = Counter()
    word_re = re.compile(r"[a-zA-Z]{3,}")
    processed = 0
    for row in seg_rows:
        if row and row[0]:
            vocab_counter.update(word_re.findall(row[0].lower()))
        processed += 1
        if progress_cb and (processed % 2500 == 0):
            progress_cb(processed)
    if progress_cb:
        progress_cb(processed)
    term_rows = conn.execute("SELECT pali_plain, english_description FROM terms;").fetchall()
    for row in term_rows:
        if row[0]:
            vocab_counter.update(word_re.findall(row[0].lower()))
        if row[1]:
            vocab_counter.update(word_re.findall(row[1].lower()))

    conn.executemany(
        "INSERT OR IGNORE INTO search_vocab (word, count) VALUES (?, ?);",
        vocab_counter.most_common(),
    )


class _BuildProgress:
    """Renders single-line CLI build progress across SQLite compilation and gzip sharding."""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.is_tty = bool(sys.stdout.isatty()) if enabled else False
        self.last_emit = 0.0
        self.last_stage = ""

    def update(self, pct: float, label: str, force: bool = False) -> None:
        if not self.enabled:
            return
        now = time.monotonic()
        clamped = max(0, min(100, int(round(pct))))
        if self.is_tty:
            if not force and label == self.last_stage and (now - self.last_emit) < 0.08:
                return
            bar = make_progress_bar(clamped, 100, width=20)
            line = f"[*] {bar} | {label}"
            sys.stdout.write(f"\r{line:<92}")
            sys.stdout.flush()
        else:
            if not force and label == self.last_stage:
                return
            bar = make_progress_bar(clamped, 100, width=20)
            print(f"[*] {bar} | {label}", flush=True)
        self.last_emit = now
        self.last_stage = label

    def finish(self) -> None:
        if not self.enabled:
            return
        if self.is_tty:
            sys.stdout.write("\r" + " " * 94 + "\r")
            sys.stdout.flush()


def _assign_balanced_shards(weighted_ids: List[Tuple[str, int]], num_shards: int) -> Dict[str, int]:
    """Deterministically packs episodes across 1..num_shards balancing byte payload."""
    totals = [0] * num_shards
    assignments: Dict[str, int] = {}
    for ep_id, weight in sorted(weighted_ids, key=lambda item: (-item[1], item[0])):
        min_idx = min(range(num_shards), key=lambda idx: (totals[idx], idx))
        assignments[ep_id] = min_idx + 1
        totals[min_idx] += max(1, int(weight))
    return assignments


def _compress_db_gzip(raw_db_path: Path, gz_path: Path) -> Tuple[int, int, str]:
    """Computes SHA-256 of raw SQLite bytes and writes deterministic gzip level-6 output."""
    hasher = hashlib.sha256()
    raw_bytes = 0
    with open(raw_db_path, "rb") as src_f, open(gz_path, "wb") as dst_f:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=6, fileobj=dst_f, mtime=0) as gz_f:
            while True:
                chunk = src_f.read(1024 * 1024)
                if not chunk:
                    break
                hasher.update(chunk)
                gz_f.write(chunk)
                raw_bytes += len(chunk)
    return raw_bytes, gz_path.stat().st_size, hasher.hexdigest()


def compile_static_database(output_db_path: Path, version_int: int) -> dict:
    """
    Consolidates transcripts and Buddhist lexicon tables into a single vacuumed SQLite database,
    stamping PRAGMA user_version in the file header for browser cache validation.
    """
    output_db_path = Path(output_db_path)
    if output_db_path.exists():
        try:
            output_db_path.unlink()
        except PermissionError:
            # On Windows, if a preview dev server is holding a read lock,
            # unlink fails, but SQLite backup API (src.backup(dst)) can still safely overwrite.
            pass

    logger.info(f"Cloning transcripts database from {TRANSCRIPTS_DB_PATH} ...")
    src = sqlite3.connect(TRANSCRIPTS_DB_PATH)
    dst = sqlite3.connect(output_db_path)
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()

    conn = sqlite3.connect(output_db_path)
    try:
        conn.execute("PRAGMA foreign_keys = OFF;")
        _copy_lexicon_to_conn(conn)

        # Safety guard: ensure only playable or genuinely transcribed talks remain in the exported web DB
        conn.execute(
            """
            DELETE FROM main.episodes
            WHERE (
                is_transcribed = 1
                AND NOT EXISTS (SELECT 1 FROM main.speech_segments s WHERE s.episode_id = main.episodes.id)
            )
               OR (is_transcribed = 0 AND (media_url IS NULL OR media_url = ''));
            """
        )
        conn.execute("DELETE FROM main.episode_teachers WHERE episode_id NOT IN (SELECT id FROM main.episodes);")

        _build_search_vocab_into_conn(conn, conn.execute("SELECT text FROM speech_segments;"))

        conn.execute("""
            CREATE TABLE IF NOT EXISTS episode_words (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                episode_id TEXT UNIQUE NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                words_blob BLOB NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_episode_words_episode_id ON episode_words(episode_id);")
        conn.commit()

        conn.isolation_level = None
        conn.execute("PRAGMA journal_mode = DELETE;")
        conn.execute(f"PRAGMA user_version = {version_int};")
        conn.execute("VACUUM;")

        episodes_count = conn.execute("SELECT COUNT(*) FROM episodes;").fetchone()[0]
        segments_count = conn.execute("SELECT COUNT(*) FROM speech_segments;").fetchone()[0]
        terms_count = conn.execute("SELECT COUNT(*) FROM terms;").fetchone()[0]
        words_count = conn.execute("SELECT COUNT(*) FROM episode_words;").fetchone()[0]
    finally:
        conn.close()

    final_size = output_db_path.stat().st_size
    return {
        "version": version_int,
        "size_bytes": final_size,
        "episodes": episodes_count,
        "segments": segments_count,
        "terms": terms_count,
        "words": words_count,
    }


def compile_sharded_static_databases(
    output_dir: Path | str,
    version_int: int,
    num_talks_shards: int = 4,
    num_words_shards: int = 4,
    transcripts_db_path: Path | str = TRANSCRIPTS_DB_PATH,
    show_progress: bool = True,
) -> dict:
    """
    Compiles a PWA-ready sharded & gzipped database bundle atomically via an isolated temp stage:
    - core.db.gz: episodes (with talks_shard / words_shard routing), teachers, lexicon, search_vocab
    - talks_1..N.db.gz: speech_segments + FTS5 transcripts_fts shards
    - words_1..M.db.gz: episode_words (binary word timings + VBR1 seek trailers) shards
    - db_manifest.json: per-shard byte sizes and SHA-256 digests for incremental updates
    """
    if num_talks_shards < 1 or num_words_shards < 1:
        raise ValueError("num_talks_shards and num_words_shards must both be >= 1")

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    progress = _BuildProgress(enabled=show_progress)
    src_uri = Path(transcripts_db_path).resolve().as_uri()
    src_conn = sqlite3.connect(f"{src_uri}?mode=ro", uri=True)
    src_conn.execute("PRAGMA query_only = ON;")
    stage_dir = Path(tempfile.mkdtemp(prefix="dd_build_stage_"))

    try:
        progress.update(2, "Scanning catalog & computing shard balance", force=True)
        valid_ep_rows = src_conn.execute(
            """
            SELECT * FROM episodes
            WHERE (
                is_transcribed = 1
                AND EXISTS (SELECT 1 FROM speech_segments s WHERE s.episode_id = episodes.id)
            )
               OR (is_transcribed = 0 AND media_url IS NOT NULL AND media_url != '');
            """
        ).fetchall()
        ep_cols = [desc[0] for desc in src_conn.execute("SELECT * FROM episodes LIMIT 0;").description]
        ep_id_idx = ep_cols.index("id")
        valid_ep_ids = {r[ep_id_idx] for r in valid_ep_rows}

        seg_weights = [
            (ep_id, weight)
            for ep_id, weight in src_conn.execute(
                "SELECT episode_id, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM speech_segments GROUP BY episode_id;"
            ).fetchall()
            if ep_id in valid_ep_ids
        ]
        talks_shard_map = _assign_balanced_shards(seg_weights, num_talks_shards)
        total_seg_rows_est = src_conn.execute("SELECT COUNT(*) FROM speech_segments;").fetchone()[0] or 1

        word_weights = [
            (ep_id, weight)
            for ep_id, weight in src_conn.execute(
                "SELECT episode_id, LENGTH(words_blob) FROM episode_words;"
            ).fetchall()
            if ep_id in valid_ep_ids
        ]
        words_shard_map = _assign_balanced_shards(word_weights, num_words_shards)
        total_words_est = len(word_weights) or 1

        # 1. Build core.db -> core.db.gz in staging directory
        progress.update(6, "Building core.db & importing Pali lexicon", force=True)
        core_raw_path = stage_dir / "core.db"
        core_gz_path = stage_dir / "core.db.gz"
        core_conn = sqlite3.connect(core_raw_path)
        try:
            core_conn.execute("PRAGMA foreign_keys = OFF;")
            for tbl in ("episodes", "teachers", "episode_teachers"):
                ddl = src_conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;", (tbl,)
                ).fetchone()
                if ddl and ddl[0]:
                    core_conn.execute(ddl[0])

            core_conn.execute("ALTER TABLE episodes ADD COLUMN talks_shard INTEGER;")
            core_conn.execute("ALTER TABLE episodes ADD COLUMN words_shard INTEGER;")

            idx_rows = src_conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' "
                "AND tbl_name IN ('episodes', 'teachers', 'episode_teachers') AND sql IS NOT NULL;"
            ).fetchall()
            for (idx_sql,) in idx_rows:
                core_conn.execute(idx_sql)
            core_conn.execute("CREATE INDEX IF NOT EXISTS idx_episodes_talks_shard ON episodes(talks_shard);")
            core_conn.execute("CREATE INDEX IF NOT EXISTS idx_episodes_words_shard ON episodes(words_shard);")

            all_core_ep_cols = ep_cols + ["talks_shard", "words_shard"]
            ep_placeholders = ",".join(["?"] * len(all_core_ep_cols))
            ep_col_sql = ",".join(all_core_ep_cols)
            core_ep_rows = [
                tuple(r) + (talks_shard_map.get(r[ep_id_idx]), words_shard_map.get(r[ep_id_idx]))
                for r in valid_ep_rows
            ]
            core_conn.executemany(
                f"INSERT INTO episodes ({ep_col_sql}) VALUES ({ep_placeholders});",
                core_ep_rows,
            )

            teacher_rows = src_conn.execute("SELECT * FROM teachers;").fetchall()
            if teacher_rows:
                t_ph = ",".join(["?"] * len(teacher_rows[0]))
                core_conn.executemany(f"INSERT INTO teachers VALUES ({t_ph});", teacher_rows)

            et_rows = [
                r for r in src_conn.execute("SELECT * FROM episode_teachers;").fetchall()
                if r[1] in valid_ep_ids
            ]
            if et_rows:
                et_ph = ",".join(["?"] * len(et_rows[0]))
                core_conn.executemany(f"INSERT INTO episode_teachers VALUES ({et_ph});", et_rows)

            view_row = src_conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='view' AND name='v_episode_teachers';"
            ).fetchone()
            if view_row and view_row[0]:
                core_conn.execute(view_row[0])

            _copy_lexicon_to_conn(core_conn)

            progress.update(10, "Indexing search_vocab from segments", force=True)
            seg_vocab_cursor = src_conn.execute(
                """
                SELECT s.text FROM speech_segments s
                JOIN episodes e ON s.episode_id = e.id
                WHERE e.is_transcribed = 1 OR (e.media_url IS NOT NULL AND e.media_url != '');
                """
            )
            _build_search_vocab_into_conn(
                core_conn,
                seg_vocab_cursor,
                progress_cb=lambda n: progress.update(
                    10.0 + 18.0 * min(1.0, n / total_seg_rows_est),
                    "Indexing search_vocab",
                ),
            )
            core_conn.commit()

            progress.update(28, "VACUUM & compressing core.db.gz", force=True)
            core_conn.isolation_level = None
            core_conn.execute("PRAGMA journal_mode = DELETE;")
            core_conn.execute(f"PRAGMA user_version = {version_int};")
            core_conn.execute("VACUUM;")

            episodes_count = core_conn.execute("SELECT COUNT(*) FROM episodes;").fetchone()[0]
            transcribed_count = core_conn.execute("SELECT COUNT(*) FROM episodes WHERE is_transcribed = 1;").fetchone()[0]
            terms_count = core_conn.execute("SELECT COUNT(*) FROM terms;").fetchone()[0]
        finally:
            core_conn.close()

        core_raw_bytes, core_gz_bytes, core_sha = _compress_db_gzip(core_raw_path, core_gz_path)
        core_raw_path.unlink(missing_ok=True)

        # 2. Build talks_1..N.db -> .db.gz in one sequential scan
        talks_conns: Dict[int, sqlite3.Connection] = {}
        talks_paths: Dict[int, Tuple[Path, Path]] = {}
        talks_batches: Dict[int, List[Tuple]] = {k: [] for k in range(1, num_talks_shards + 1)}
        talks_ep_counts: Dict[int, set] = {k: set() for k in range(1, num_talks_shards + 1)}
        segments_count = 0

        for k in range(1, num_talks_shards + 1):
            t_raw = stage_dir / f"talks_{k}.db"
            t_gz = stage_dir / f"talks_{k}.db.gz"
            t_conn = sqlite3.connect(t_raw)
            t_conn.execute("""
                CREATE TABLE speech_segments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    episode_id TEXT NOT NULL,
                    turn_index INTEGER NOT NULL,
                    start_sec REAL NOT NULL,
                    end_sec REAL NOT NULL,
                    speaker_slug TEXT NOT NULL,
                    speaker_display TEXT NOT NULL,
                    text TEXT NOT NULL
                );
            """)
            talks_conns[k] = t_conn
            talks_paths[k] = (t_raw, t_gz)

        progress.update(32, f"Distributing speech segments across {num_talks_shards} shards", force=True)
        seg_cur = src_conn.execute(
            "SELECT episode_id, turn_index, start_sec, end_sec, speaker_slug, speaker_display, text "
            "FROM speech_segments ORDER BY id;"
        )
        scanned_segs = 0
        try:
            for row in seg_cur:
                scanned_segs += 1
                shard_k = talks_shard_map.get(row[0])
                if not shard_k:
                    continue
                talks_batches[shard_k].append(row)
                talks_ep_counts[shard_k].add(row[0])
                segments_count += 1
                if len(talks_batches[shard_k]) >= 5000:
                    talks_conns[shard_k].executemany(
                        "INSERT INTO speech_segments (episode_id, turn_index, start_sec, end_sec, speaker_slug, speaker_display, text) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?);",
                        talks_batches[shard_k],
                    )
                    talks_batches[shard_k].clear()
                if scanned_segs % 4000 == 0:
                    progress.update(
                        32.0 + 14.0 * min(1.0, scanned_segs / total_seg_rows_est),
                        "Distributing speech segments",
                    )

            talks_meta = []
            for k in range(1, num_talks_shards + 1):
                t_conn = talks_conns[k]
                t_raw, t_gz = talks_paths[k]
                base_pct = 46.0 + (k - 1) * (30.0 / num_talks_shards)
                progress.update(base_pct, f"Building FTS5 index for talks_{k}.db", force=True)
                if talks_batches[k]:
                    t_conn.executemany(
                        "INSERT INTO speech_segments (episode_id, turn_index, start_sec, end_sec, speaker_slug, speaker_display, text) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?);",
                        talks_batches[k],
                    )
                    talks_batches[k].clear()
                t_conn.execute("CREATE INDEX idx_segments_ep_turn ON speech_segments(episode_id, turn_index);")
                t_conn.execute("""
                    CREATE VIRTUAL TABLE transcripts_fts USING fts5(
                        speaker_display,
                        text,
                        content='speech_segments',
                        content_rowid='id'
                    );
                """)
                t_conn.execute("INSERT INTO transcripts_fts(transcripts_fts) VALUES('rebuild');")
                t_conn.execute("INSERT INTO transcripts_fts(transcripts_fts) VALUES('optimize');")
                t_conn.commit()
                t_conn.isolation_level = None
                t_conn.execute("PRAGMA journal_mode = DELETE;")
                t_conn.execute(f"PRAGMA user_version = {version_int};")
                t_conn.execute("VACUUM;")
                t_conn.close()
                talks_conns.pop(k, None)

                progress.update(
                    base_pct + (18.0 / num_talks_shards),
                    f"Compressing talks_{k}.db.gz",
                    force=True,
                )
                raw_b, gz_b, sha = _compress_db_gzip(t_raw, t_gz)
                t_raw.unlink(missing_ok=True)
                talks_meta.append({
                    "id": f"talks_{k}",
                    "shard": k,
                    "file": t_gz.name,
                    "raw_file": t_raw.name,
                    "raw_bytes": raw_b,
                    "gz_bytes": gz_b,
                    "sha256": sha,
                    "episodes": len(talks_ep_counts[k]),
                })
        finally:
            for c_rem in talks_conns.values():
                try:
                    c_rem.close()
                except Exception:
                    pass

        # 3. Build words_1..M.db -> .db.gz in one sequential scan
        words_conns: Dict[int, sqlite3.Connection] = {}
        words_paths: Dict[int, Tuple[Path, Path]] = {}
        words_ep_counts: Dict[int, int] = {k: 0 for k in range(1, num_words_shards + 1)}
        words_count = 0

        for k in range(1, num_words_shards + 1):
            w_raw = stage_dir / f"words_{k}.db"
            w_gz = stage_dir / f"words_{k}.db.gz"
            w_conn = sqlite3.connect(w_raw)
            w_conn.execute("""
                CREATE TABLE episode_words (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    episode_id TEXT UNIQUE NOT NULL,
                    words_blob BLOB NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
            """)
            words_conns[k] = w_conn
            words_paths[k] = (w_raw, w_gz)

        progress.update(76, f"Distributing word timings across {num_words_shards} shards", force=True)
        w_cur = src_conn.execute("SELECT episode_id, words_blob, created_at FROM episode_words ORDER BY id;")
        words_batches: Dict[int, List[Tuple]] = {k: [] for k in range(1, num_words_shards + 1)}
        try:
            for row in w_cur:
                shard_k = words_shard_map.get(row[0])
                if not shard_k:
                    continue
                words_batches[shard_k].append(row)
                words_ep_counts[shard_k] += 1
                words_count += 1
                if len(words_batches[shard_k]) >= 100:
                    words_conns[shard_k].executemany(
                        "INSERT INTO episode_words (episode_id, words_blob, created_at) VALUES (?, ?, ?);",
                        words_batches[shard_k],
                    )
                    words_batches[shard_k].clear()
                if words_count % 250 == 0:
                    progress.update(
                        76.0 + 6.0 * min(1.0, words_count / total_words_est),
                        "Distributing word timings",
                    )

            words_meta = []
            for k in range(1, num_words_shards + 1):
                w_conn = words_conns[k]
                w_raw, w_gz = words_paths[k]
                base_pct = 82.0 + (k - 1) * (16.0 / num_words_shards)
                progress.update(base_pct, f"Compressing words_{k}.db.gz", force=True)
                if words_batches[k]:
                    w_conn.executemany(
                        "INSERT INTO episode_words (episode_id, words_blob, created_at) VALUES (?, ?, ?);",
                        words_batches[k],
                    )
                    words_batches[k].clear()
                w_conn.execute("CREATE INDEX idx_episode_words_episode_id ON episode_words(episode_id);")
                w_conn.commit()
                w_conn.isolation_level = None
                w_conn.execute("PRAGMA journal_mode = DELETE;")
                w_conn.execute(f"PRAGMA user_version = {version_int};")
                w_conn.execute("VACUUM;")
                w_conn.close()
                words_conns.pop(k, None)

                raw_b, gz_b, sha = _compress_db_gzip(w_raw, w_gz)
                w_raw.unlink(missing_ok=True)
                words_meta.append({
                    "id": f"words_{k}",
                    "shard": k,
                    "file": w_gz.name,
                    "raw_file": w_raw.name,
                    "raw_bytes": raw_b,
                    "gz_bytes": gz_b,
                    "sha256": sha,
                    "episodes": words_ep_counts[k],
                })
        finally:
            for c_rem in words_conns.values():
                try:
                    c_rem.close()
                except Exception:
                    pass

        progress.update(98, "Publishing manifest & sharded bundle", force=True)
        total_raw_bytes = core_raw_bytes + sum(s["raw_bytes"] for s in talks_meta) + sum(s["raw_bytes"] for s in words_meta)
        total_gz_bytes = core_gz_bytes + sum(s["gz_bytes"] for s in talks_meta) + sum(s["gz_bytes"] for s in words_meta)

        manifest = {
            "format": "sharded_v1",
            "version": version_int,
            "core": {
                "id": "core",
                "file": core_gz_path.name,
                "raw_file": core_raw_path.name,
                "raw_bytes": core_raw_bytes,
                "gz_bytes": core_gz_bytes,
                "sha256": core_sha,
            },
            "talks": talks_meta,
            "words": words_meta,
            "episodes": episodes_count,
            "transcribed_episodes": transcribed_count,
            "segments": segments_count,
            "terms": terms_count,
            "words_count": words_count,
            "total_raw_bytes": total_raw_bytes,
            "total_gz_bytes": total_gz_bytes,
        }
        (stage_dir / "db_manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

        for shard_meta in [manifest["core"], *talks_meta, *words_meta]:
            if shard_meta["gz_bytes"] >= _GITHUB_RECOMMENDED_MAX_BYTES:
                logger.warning(
                    f"Shard '{shard_meta['file']}' is {shard_meta['gz_bytes'] / (1024 * 1024):.2f} MB gzipped "
                    f"(>= 50 MB GitHub large-file warning threshold); consider increasing shard count."
                )

        # Promote staged artifacts atomically so an interrupted build never wipes prior dist/ DBs
        for pattern in ("dhamma_web.db*", "core.db*", "talks_*.db*", "words_*.db*", "db_manifest.json"):
            for old_p in out_dir.glob(pattern):
                try:
                    old_p.unlink()
                except OSError:
                    pass

        for staged_file in stage_dir.iterdir():
            dst_file = out_dir / staged_file.name
            try:
                staged_file.replace(dst_file)
            except OSError:
                shutil.move(str(staged_file), str(dst_file))

        progress.update(100, "Sharded bundle ready", force=True)
        progress.finish()
    finally:
        src_conn.close()
        shutil.rmtree(stage_dir, ignore_errors=True)

    return {
        "version": version_int,
        "size_bytes": total_gz_bytes,
        "raw_size_bytes": total_raw_bytes,
        "episodes": episodes_count,
        "transcribed_episodes": transcribed_count,
        "segments": segments_count,
        "terms": terms_count,
        "words": words_count,
        "manifest": manifest,
    }


def _resolve_repo_path(path_or_str: Path | str) -> Path:
    """Resolves relative paths against PROJECT_ROOT so nothing leaks into parent CWD."""
    p = Path(path_or_str)
    if not p.is_absolute():
        return (PROJECT_ROOT / p).resolve()
    return p.resolve()


def export_static_site(output_dir: Path | str = DIST_DIR, show_progress: bool = True) -> Path:
    """
    Builds the complete self-contained static site and SQLite WASM bundle.
    """
    out_path = _resolve_repo_path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    today = datetime.now()
    version_int = int(time.time())
    date_str = today.strftime("%Y-%m-%d")

    print("\n" + "=" * 80)
    print("BSWA Deeper Dhamma: Static Web & SQLite WASM Compiler")
    print("=" * 80)
    print(f"[*] Target Directory:    {out_path}")
    print(f"[*] Database Version:    {version_int} (stamped in SQLite header)")
    print(f"[*] Build Date:          {date_str}")
    print("-" * 80)

    # 1. Compile sharded & gzipped SQLite PWA bundle (core + talks_1..4 + words_1..4)
    metrics = compile_sharded_static_databases(out_path, version_int=version_int, show_progress=show_progress)
    manifest = metrics["manifest"]
    print(
        f"[✓] Compiled sharded PWA bundle: {metrics['size_bytes'] / (1024 * 1024):.2f} MB gzipped "
        f"({metrics['raw_size_bytes'] / (1024 * 1024):.2f} MB raw)"
    )
    print(f"    - core.db.gz:            {manifest['core']['gz_bytes'] / (1024 * 1024):.2f} MB gz ({manifest['core']['raw_bytes'] / (1024 * 1024):.2f} MB raw)")
    for s in manifest["talks"]:
        print(f"    - {s['file']:22s} {s['gz_bytes'] / (1024 * 1024):.2f} MB gz ({s['raw_bytes'] / (1024 * 1024):.2f} MB raw, {s['episodes']:,} talks)")
    for s in manifest["words"]:
        print(f"    - {s['file']:22s} {s['gz_bytes'] / (1024 * 1024):.2f} MB gz ({s['raw_bytes'] / (1024 * 1024):.2f} MB raw, {s['episodes']:,} talks)")
    print(f"    - Episodes indexed:      {metrics['episodes']:,} ({metrics['transcribed_episodes']:,} transcribed)")
    print(f"    - Speech segments:       {metrics['segments']:,}")
    print(f"    - Buddhist Pali terms:   {metrics['terms']:,}")
    print(f"    - Word-synced talks:     {metrics.get('words', 0):,}")

    # 2. Ensure SQLite WASM engine assets exist
    ensure_wasm_assets(STATIC_SRC_DIR)

    expected_entries = {
        "db_manifest.json",
        manifest["core"]["file"],
        *(s["file"] for s in manifest["talks"]),
        *(s["file"] for s in manifest["words"]),
        "index.html",
        "404.html",
        "svc_worker.js",
        ".nojekyll",
        "CNAME",
    }

    # 3. Copy static frontend assets (skips directories like adapters/)
    copied_files = 0
    for src_file in STATIC_SRC_DIR.iterdir():
        if src_file.is_file():
            dst_file = out_path / src_file.name
            shutil.copy2(src_file, dst_file)
            expected_entries.add(src_file.name)
            copied_files += 1

    # Copy static asset subdirectories (icons/, fonts/) if present
    for subdir_name in ("icons", "fonts"):
        sub_src = STATIC_SRC_DIR / subdir_name
        if sub_src.exists() and sub_src.is_dir():
            sub_dst = out_path / subdir_name
            if sub_dst.exists():
                shutil.rmtree(sub_dst)
            shutil.copytree(sub_src, sub_dst)
            expected_entries.add(subdir_name)
            copied_files += len([f for f in sub_src.iterdir() if f.is_file()])


    # Mirror pristine local document sources into dist/sources/ for user verification
    sources_src = PROJECT_ROOT / "databases" / "sources"
    if sources_src.exists() and sources_src.is_dir():
        sources_dst = out_path / "sources"
        if sources_dst.exists():
            shutil.rmtree(sources_dst)
        shutil.copytree(sources_src, sources_dst)
        expected_entries.add("sources")
        copied_files += len([f for f in sources_src.iterdir() if f.is_file()])

    # Deploy pure SQLite WASM client adapter to dist/db_client.js and static/db_client.js
    wasm_adapter = STATIC_SRC_DIR / "adapters" / "wasm_client.js"
    if wasm_adapter.exists():
        shutil.copy2(wasm_adapter, out_path / "db_client.js")
        shutil.copy2(wasm_adapter, STATIC_SRC_DIR / "db_client.js")
        expected_entries.add("db_client.js")
        copied_files += 1

    print(f"[✓] Copied {copied_files} frontend/WASM assets into {out_path.name}/")

    # 4. Pre-render index.html with relative paths and version stamps
    index_template = VIEWS_SRC_DIR / "index.html"
    if not index_template.exists():
        raise FileNotFoundError(f"Template not found: {index_template}")

    with open(index_template, "r", encoding="utf-8") as f:
        html_src = f.read()

    # Normalize script and stylesheet links to relative paths for zero-config hosting
    html_src = html_src.replace('href="/static/', 'href="./')
    html_src = html_src.replace('src="/static/', 'src="./')

    # Standard template variable interpolation
    rendered_html = (
        html_src
        .replace("{{db_version}}", str(version_int))
        .replace("{{build_date}}", str(date_str))
        .replace("{{total_episodes}}", str(metrics["episodes"]))
    )

    out_index = out_path / "index.html"
    with open(out_index, "w", encoding="utf-8", newline="\n") as f:
        f.write(rendered_html)

    # 4.1 Pre-render 404.html for seamless GitHub Pages SPA routing fallback
    out_404 = out_path / "404.html"
    with open(out_404, "w", encoding="utf-8", newline="\n") as f:
        f.write(rendered_html)

    # 5. Pre-render svc_worker.js with version stamp for atomic cache invalidation
    sw_dist = out_path / "svc_worker.js"
    if sw_dist.exists():
        sw_content = sw_dist.read_text(encoding="utf-8")
        sw_content = sw_content.replace("{{db_version}}", str(version_int))
        sw_dist.write_text(sw_content, encoding="utf-8", newline="\n")
        print(f"[✓] Pre-rendered svc_worker.js with cache version 'deeper_dhamma_shell_{version_int}'")

    # 5.1 Ensure .nojekyll is present to bypass Jekyll build on GitHub Pages
    nojekyll_dist = out_path / ".nojekyll"
    if not nojekyll_dist.exists():
        nojekyll_dist.touch()

    # 6. Prune any leftover files/directories from prior builds after new bundle is ready
    for entry in list(out_path.iterdir()):
        if entry.name in expected_entries:
            continue
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            try:
                entry.unlink()
            except OSError:
                pass

    print(f"[✓] Pre-rendered index.html with relative asset links")
    print("-" * 80)
    print("[✓] Static Site Build Complete!")
    print(f"    To preview locally: python main.py web --run")
    print(f"    To deploy: Upload the contents of '{out_path}' to GitHub Pages, Cloudflare Pages, or S3.")
    print("=" * 80 + "\n")

    return out_path


def _is_dist_stale(dist_path: Path) -> bool:
    """Checks whether any source asset or database is newer than the built dist/index.html."""
    index_out = dist_path / "index.html"
    manifest_out = dist_path / "db_manifest.json"
    if not index_out.exists() or not manifest_out.exists():
        return True
    dist_mtime = min(index_out.stat().st_mtime, manifest_out.stat().st_mtime)
    candidates = [
        VIEWS_SRC_DIR / "index.html",
        STATIC_SRC_DIR / "adapters" / "wasm_client.js",
        TRANSCRIPTS_DB_PATH,
        BUDDHISM_LEXICON_DB_PATH,
    ]
    if STATIC_SRC_DIR.exists():
        for src_p in STATIC_SRC_DIR.iterdir():
            # db_client.js is overwritten from adapters/wasm_client.js mid-build after db_manifest.json
            if src_p.is_file() and src_p.name != "db_client.js":
                candidates.append(src_p)
        for subdir_name in ("icons", "fonts"):
            sub_dir = STATIC_SRC_DIR / subdir_name
            if sub_dir.exists():
                candidates.extend(p for p in sub_dir.iterdir() if p.is_file())
    sources_dir = PROJECT_ROOT / "databases" / "sources"
    if sources_dir.exists():
        candidates.extend(p for p in sources_dir.iterdir() if p.is_file())
    for src in candidates:
        if src.exists() and src.stat().st_mtime > dist_mtime:
            return True
    return False


class RangeFile:
    """Wrapper that reads a slice of an underlying binary file for HTTP 206 Partial Content."""
    def __init__(self, f, length: int):
        self.f = f
        self.length = length
        self.read_so_far = 0

    def read(self, size: int = -1) -> bytes:
        if self.read_so_far >= self.length:
            return b""
        rem = self.length - self.read_so_far
        to_read = min(size, rem) if size > 0 else rem
        chunk = self.f.read(to_read)
        self.read_so_far += len(chunk)
        return chunk

    def close(self):
        self.f.close()


class StaticPreviewHandler(http.server.SimpleHTTPRequestHandler):
    """
    Standard library static file request handler with native HTTP Range support,
    CORS, service worker header propagation, and /static/ alias stripping.
    """
    def __init__(self, *args, directory: str = "", **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        if self.path.endswith("svc_worker.js") or "/svc_worker.js" in self.path:
            self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        clean_path = path
        if clean_path.startswith("/static/"):
            clean_path = "/" + clean_path[8:]
        return super().translate_path(clean_path)

    def guess_type(self, path: str) -> str:
        lower = path.lower().split("?", 1)[0]
        if lower.endswith(".db") or lower.endswith(".db.gz"):
            return "application/octet-stream"
        if lower.endswith(".wasm"):
            return "application/wasm"
        if lower.endswith(".json"):
            return "application/json"
        return super().guess_type(path)

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            index = os.path.join(path, "index.html")
            if os.path.exists(index):
                path = index
        ctype = self.guess_type(path)
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        total_length = os.fstat(f.fileno()).st_size
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            try:
                parts = range_header[6:].split("-")
                start = int(parts[0]) if parts[0] else 0
                end = int(parts[1]) if parts[1] else total_length - 1
                end = min(end, total_length - 1)
                length = end - start + 1
                f.seek(start)
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", f"bytes {start}-{end}/{total_length}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                return RangeFile(f, length)
            except Exception:
                f.seek(0)

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(total_length))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return f

    def log_message(self, format, *args):
        # Concise quiet logging
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))


def run_web_preview(host: str = DEFAULT_WEB_HOST, port: str | int = DEFAULT_WEB_PORT, dist_dir: Path | str = DIST_DIR) -> None:
    """
    Serves the static distribution folder using pure Python standard library HTTP server
    with native HTTP Range request support for SQLite WASM.
    """
    dist_path = _resolve_repo_path(dist_dir)
    if _is_dist_stale(dist_path):
        print(f"[*] Rebuilding static bundle in '{dist_path}' to ensure latest assets...")
        export_static_site(dist_path)

    print("\n" + "=" * 80)
    print("BSWA Deeper Dhamma: Static Web Preview Server (Serverless PWA)")
    print("=" * 80)
    print(f"[*] Serving static bundle:  {dist_path}")
    print(f"[*] Local URL:              http://{host}:{port}/")
    print(f"[*] HTTP Range Support:     Enabled (for SQLite WASM)")
    print("=" * 80)
    print("Press Ctrl+C to stop.\n")

    server = http.server.ThreadingHTTPServer(
        (host, int(port)),
        lambda *args, **kwargs: StaticPreviewHandler(*args, directory=str(dist_path), **kwargs),
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping preview server...")
    finally:
        server.server_close()


def _validate_staged_pages_index(dist_path: Path, env: dict) -> None:
    """Verifies staged gh-pages blobs exclude staging/raw DB artifacts and fit GitHub limits."""
    staged_raw = subprocess.check_output(
        ["git", "ls-files", "--stage"],
        cwd=str(dist_path),
        env=env,
        text=True,
    )
    staged_entries: List[Tuple[str, str]] = []
    for line in staged_raw.splitlines():
        if "\t" not in line:
            continue
        meta, rel_path = line.split("\t", 1)
        parts = meta.split()
        if len(parts) < 2:
            continue
        oid = parts[1]
        norm_rel = rel_path.replace("\\", "/")
        if any(seg.startswith(".build_stage_") for seg in norm_rel.split("/")):
            raise RuntimeError(f"Refusing to deploy build staging artifact: {rel_path}")
        if norm_rel.endswith((".db", ".db-journal", ".db-wal", ".db-shm")):
            raise RuntimeError(f"Refusing to deploy uncompressed SQLite artifact: {rel_path}")
        staged_entries.append((oid, norm_rel))

    staged_paths = {rel_path for _, rel_path in staged_entries}
    required_paths = {"index.html", "404.html", "svc_worker.js", "db_manifest.json", "core.db.gz", "CNAME", ".nojekyll"}
    manifest_path = dist_path / "db_manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        core_file = (manifest.get("core") or {}).get("file")
        if core_file:
            required_paths.add(core_file)
        for shard_group in ("talks", "words"):
            for shard_meta in manifest.get(shard_group, []):
                if shard_meta.get("file"):
                    required_paths.add(shard_meta["file"])
    missing = sorted(required_paths - staged_paths)
    if missing:
        raise RuntimeError(f"Refusing to deploy incomplete dist/ bundle; missing staged files: {', '.join(missing)}")

    if not staged_entries:
        raise RuntimeError("No files staged for GitHub Pages deployment.")

    oid_input = "\n".join(oid for oid, _ in staged_entries) + "\n"
    sizes_out = subprocess.check_output(
        ["git", "cat-file", "--batch-check"],
        input=oid_input,
        cwd=str(dist_path),
        env=env,
        text=True,
    )
    oversized_warn: List[Tuple[str, int]] = []
    for (_, rel_path), size_line in zip(staged_entries, sizes_out.splitlines()):
        tokens = size_line.split()
        if len(tokens) >= 3 and tokens[1] == "blob":
            blob_size = int(tokens[2])
            if blob_size >= _GITHUB_HARD_MAX_BYTES:
                raise RuntimeError(
                    f"Refusing to deploy '{rel_path}' ({blob_size / (1024 * 1024):.2f} MB >= 100 MB GitHub limit)"
                )
            if blob_size >= _GITHUB_RECOMMENDED_MAX_BYTES:
                oversized_warn.append((rel_path, blob_size))

    for rel_path, blob_size in oversized_warn:
        print(
            f"[!] Warning: '{rel_path}' is {blob_size / (1024 * 1024):.2f} MB "
            f"(>= 50 MB GitHub large-file threshold).",
            flush=True,
        )


def deploy_to_github_pages(
    dist_dir: Path | str = DIST_DIR,
    remote: str = "origin",
    branch: str = "gh-pages",
    repo_root: Path | str = PROJECT_ROOT,
) -> None:
    """
    Deploys the static site distribution directly to GitHub Pages (gh-pages branch)
    using git plumbing without checking build artifacts into the main branch.
    """
    dist_path = _resolve_repo_path(dist_dir)
    if not dist_path.exists() or _is_dist_stale(dist_path):
        print(f"[*] Rebuilding static distribution in '{dist_path}' before deployment...")
        export_static_site(dist_path)

    # Ensure CNAME and .nojekyll are present
    cname_path = dist_path / "CNAME"
    if not cname_path.exists():
        cname_path.write_text("deeperdhamma.com\n", encoding="utf-8", newline="\n")

    nojekyll_path = dist_path / ".nojekyll"
    if not nojekyll_path.exists():
        nojekyll_path.touch()

    repo_root_path = Path(repo_root).resolve()
    git_dir_raw = subprocess.check_output(
        ["git", "-C", str(repo_root_path), "rev-parse", "--git-dir"],
        text=True,
    ).strip()
    git_dir_path = Path(git_dir_raw)
    if not git_dir_path.is_absolute():
        git_dir_path = (repo_root_path / git_dir_path).resolve()

    manifest_version = None
    manifest_file = dist_path / "db_manifest.json"
    if manifest_file.exists():
        try:
            manifest_version = json.loads(manifest_file.read_text(encoding="utf-8")).get("version")
        except Exception:
            manifest_version = None

    print("\n" + "=" * 80)
    print("BSWA Deeper Dhamma: Deploy to GitHub Pages (deeperdhamma.com)")
    print("=" * 80)
    print(f"[*] Distribution Directory: {dist_path}")
    print(f"[*] Remote Repository:      {remote}")
    print(f"[*] Target Branch:          {branch}")
    print(f"[*] Custom Domain (CNAME):  {cname_path.read_text(encoding='utf-8').strip()}")
    print("-" * 80)

    with tempfile.TemporaryDirectory(prefix="dd_pages_index_") as tmp_idx_dir:
        temp_index = Path(tmp_idx_dir) / "index"
        env = os.environ.copy()
        env["GIT_DIR"] = str(git_dir_path)
        env["GIT_WORK_TREE"] = str(dist_path.resolve())
        env["GIT_INDEX_FILE"] = str(temp_index.resolve())

        # 1. Stage all static files from dist_path (disabling CRLF conversion and excluding build/raw DB artifacts)
        subprocess.run(
            [
                "git",
                "-c",
                "core.autocrlf=false",
                "add",
                "-A",
                "--",
                ".",
                ":!.build_stage_*",
                ":!*/.build_stage_*",
                ":!*.db",
                ":!*.db-journal",
                ":!*.db-wal",
                ":!*.db-shm",
            ],
            cwd=str(dist_path.resolve()),
            env=env,
            check=True,
        )

        # 2. Verify staged files exclude staging/raw DB artifacts and stay within GitHub limits
        _validate_staged_pages_index(dist_path, env)

        # 3. Write tree object
        tree_sha = subprocess.check_output(
            ["git", "write-tree"], cwd=str(dist_path.resolve()), env=env, text=True
        ).strip()

        # 4. Create commit object
        today_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        deploy_ver = manifest_version if manifest_version is not None else int(time.time())
        commit_msg = f"Deploy Deeper Dhamma v{deploy_ver} to deeperdhamma.com ({today_str})"
        commit_sha = subprocess.check_output(
            ["git", "commit-tree", tree_sha, "-m", commit_msg],
            cwd=str(dist_path.resolve()),
            env=env,
            text=True,
        ).strip()

        # 5. Push commit to remote branch
        print(f"[*] Pushing commit {commit_sha[:8]} to {remote}/{branch}...")
        subprocess.run(
            ["git", "push", remote, f"{commit_sha}:refs/heads/{branch}", "--force"],
            cwd=str(repo_root_path),
            check=True,
        )

        print("-" * 80)
        print("[✓] Successfully deployed to GitHub Pages!")
        print("    Live URL:  https://deeperdhamma.com/")
        print(f"    Branch:    {branch}")
        print("=" * 80 + "\n")

