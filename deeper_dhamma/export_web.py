"""
Static Web Site & SQLite WASM Compiler for Deeper Dhamma.

Compiles an immutable, serverless static web application into dist/:
1. Consolidates dhamma_transcripts.db and buddhism_lexicon.db into a single dhamma_web.db.
2. Stamps PRAGMA user_version = <YYYYMMDD> in the SQLite 100-byte file header.
3. Bundles official SQLite WASM engine, FTS5 virtual tables, and Web Worker client.
4. Pre-renders index.html with relative asset links and version stamps.
"""

import http.server
import logging
import os
import shutil
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Optional

from deeper_dhamma.config import (
    BUDDHISM_LEXICON_DB_PATH,
    DEFAULT_WEB_HOST,
    DEFAULT_WEB_PORT,
    DIST_DIR,
    PROJECT_ROOT,
    TRANSCRIPTS_DB_PATH,
)

logger = logging.getLogger("export_web")

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

    # 1. Clone base transcripts database
    logger.info(f"Cloning transcripts database from {TRANSCRIPTS_DB_PATH} ...")
    src = sqlite3.connect(TRANSCRIPTS_DB_PATH)
    dst = sqlite3.connect(output_db_path)
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()

    # 2. Import lexicon reference tables (source_documents, terms, phrase_rules)
    lex_uri = BUDDHISM_LEXICON_DB_PATH.resolve().as_uri()
    logger.info(f"Importing lexicon reference tables from {lex_uri} ...")
    conn = sqlite3.connect(output_db_path)
    try:
        conn.execute("PRAGMA foreign_keys = OFF;")
        lex_conn = sqlite3.connect(f"{lex_uri}?mode=ro", uri=True)
        try:
            lex_conn.execute("PRAGMA query_only = ON;")
            # 2.1 source_documents (stripping large compressed text/PDF blobs)
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

            # 2.2 terms & phrase_rules
            for tbl in ["terms", "phrase_rules"]:
                schema_row = lex_conn.execute(f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{tbl}';").fetchone()
                if schema_row and schema_row[0]:
                    conn.execute(f"DROP TABLE IF EXISTS main.{tbl};")
                    conn.execute(schema_row[0])
                    rows = lex_conn.execute(f"SELECT * FROM {tbl};").fetchall()
                    if rows:
                        placeholders = ",".join(["?"] * len(rows[0]))
                        conn.executemany(f"INSERT INTO main.{tbl} VALUES ({placeholders});", rows)
        finally:
            lex_conn.close()

        # Safety guard: ensure only playable or transcribed talks remain in the exported web DB
        conn.execute(
            """
            DELETE FROM main.episodes
            WHERE is_transcribed = 0
              AND (media_url IS NULL OR media_url = '');
            """
        )
        conn.execute("DELETE FROM main.episode_teachers WHERE episode_id NOT IN (SELECT id FROM main.episodes);")

        # Recreate lexical join view
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

        # Rebuild lexical FTS5 search table
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

        # 3. Build search_vocab table for ultra-fast in-browser fuzzy search & spell correction
        conn.execute("DROP TABLE IF EXISTS main.search_vocab;")
        conn.execute("""
            CREATE TABLE search_vocab (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word TEXT UNIQUE NOT NULL,
                count INTEGER NOT NULL
            );
        """)
        import re
        from collections import Counter
        vocab_counter = Counter()
        seg_rows = conn.execute("SELECT text FROM speech_segments;").fetchall()
        for row in seg_rows:
            if row[0]:
                vocab_counter.update(re.findall(r"[a-zA-Z]{3,}", row[0].lower()))
        term_rows = conn.execute("SELECT pali_plain, english_description FROM terms;").fetchall()
        for row in term_rows:
            if row[0]:
                vocab_counter.update(re.findall(r"[a-zA-Z]{3,}", row[0].lower()))
            if row[1]:
                vocab_counter.update(re.findall(r"[a-zA-Z]{3,}", row[1].lower()))

        conn.executemany(
            "INSERT OR IGNORE INTO search_vocab (word, count) VALUES (?, ?);",
            vocab_counter.most_common(),
        )

        # Ensure episode_words table exists and is indexed
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

        # 4. Clean and set header version outside transaction
        conn.isolation_level = None
        conn.execute("PRAGMA journal_mode = DELETE;")
        conn.execute(f"PRAGMA user_version = {version_int};")
        conn.execute("VACUUM;")

        # Gather metrics
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


def _resolve_repo_path(path_or_str: Path | str) -> Path:
    """Resolves relative paths against PROJECT_ROOT so nothing leaks into parent CWD."""
    p = Path(path_or_str)
    if not p.is_absolute():
        return (PROJECT_ROOT / p).resolve()
    return p.resolve()


def export_static_site(output_dir: Path | str = DIST_DIR) -> Path:
    """
    Builds the complete self-contained static site and SQLite WASM bundle.
    """
    out_path = _resolve_repo_path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    # Remove stale / leftover test artifacts if present in output_dir
    for stale_item in ["test_copy.db", "transcripts", "ff_profile_test.html"]:
        stale_p = out_path / stale_item
        if stale_p.exists():
            if stale_p.is_dir():
                shutil.rmtree(stale_p, ignore_errors=True)
            else:
                try:
                    stale_p.unlink()
                except OSError:
                    pass

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

    # 1. Compile consolidated SQLite database
    db_out = out_path / "dhamma_web.db"
    metrics = compile_static_database(db_out, version_int=version_int)
    print(f"[✓] Compiled dhamma_web.db: {metrics['size_bytes'] / (1024 * 1024):.2f} MB")
    print(f"    - Episodes indexed:      {metrics['episodes']:,}")
    print(f"    - Speech segments:       {metrics['segments']:,}")
    print(f"    - Buddhist Pali terms:   {metrics['terms']:,}")
    print(f"    - Word-synced talks:     {metrics.get('words', 0):,}")

    # 2. Ensure SQLite WASM engine assets exist
    ensure_wasm_assets(STATIC_SRC_DIR)

    # 3. Copy static frontend assets (skips directories like adapters/)
    copied_files = 0
    for src_file in STATIC_SRC_DIR.iterdir():
        if src_file.is_file():
            dst_file = out_path / src_file.name
            shutil.copy2(src_file, dst_file)
            copied_files += 1

    # Copy icons directory if present
    icons_src = STATIC_SRC_DIR / "icons"
    if icons_src.exists() and icons_src.is_dir():
        icons_dst = out_path / "icons"
        if icons_dst.exists():
            shutil.rmtree(icons_dst)
        shutil.copytree(icons_src, icons_dst)
        copied_files += len(list(icons_src.glob("*.svg")))


    # Mirror pristine local document sources into dist/sources/ for user verification
    sources_src = PROJECT_ROOT / "databases" / "sources"
    if sources_src.exists() and sources_src.is_dir():
        sources_dst = out_path / "sources"
        if sources_dst.exists():
            shutil.rmtree(sources_dst)
        shutil.copytree(sources_src, sources_dst)
        copied_files += len([f for f in sources_src.iterdir() if f.is_file()])

    # Deploy pure SQLite WASM client adapter to dist/db_client.js and static/db_client.js
    wasm_adapter = STATIC_SRC_DIR / "adapters" / "wasm_client.js"
    if wasm_adapter.exists():
        shutil.copy2(wasm_adapter, out_path / "db_client.js")
        shutil.copy2(wasm_adapter, STATIC_SRC_DIR / "db_client.js")
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
    with open(out_index, "w", encoding="utf-8") as f:
        f.write(rendered_html)

    # 4.1 Pre-render 404.html for seamless GitHub Pages SPA routing fallback
    out_404 = out_path / "404.html"
    with open(out_404, "w", encoding="utf-8") as f:
        f.write(rendered_html)

    # 5. Pre-render svc_worker.js with version stamp for atomic cache invalidation
    sw_dist = out_path / "svc_worker.js"
    if sw_dist.exists():
        sw_content = sw_dist.read_text(encoding="utf-8")
        sw_content = sw_content.replace("{{db_version}}", str(version_int))
        sw_dist.write_text(sw_content, encoding="utf-8")
        print(f"[✓] Pre-rendered svc_worker.js with cache version 'deeper_dhamma_shell_{version_int}'")

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
    if not index_out.exists():
        return True
    dist_mtime = index_out.stat().st_mtime
    candidates = [
        VIEWS_SRC_DIR / "index.html",
        STATIC_SRC_DIR / "app.js",
        STATIC_SRC_DIR / "card_physics.js",
        STATIC_SRC_DIR / "word_sync.js",
        STATIC_SRC_DIR / "style.css",
        STATIC_SRC_DIR / "db_worker.js",
        STATIC_SRC_DIR / "svc_worker.js",
        STATIC_SRC_DIR / "adapters" / "wasm_client.js",
        TRANSCRIPTS_DB_PATH,
        BUDDHISM_LEXICON_DB_PATH,
    ]
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


def deploy_to_github_pages(dist_dir: Path | str = DIST_DIR, remote: str = "origin", branch: str = "gh-pages") -> None:
    """
    Deploys the static site distribution directly to GitHub Pages (gh-pages branch)
    using git plumbing without checking build artifacts into the main branch.
    """
    import subprocess

    dist_path = _resolve_repo_path(dist_dir)
    if not dist_path.exists() or _is_dist_stale(dist_path):
        print(f"[*] Rebuilding static distribution in '{dist_path}' before deployment...")
        export_static_site(dist_path)

    # Ensure CNAME is present
    cname_path = dist_path / "CNAME"
    if not cname_path.exists():
        cname_path.write_text("deeperdhamma.com\n", encoding="utf-8")

    repo_root = PROJECT_ROOT
    temp_index = repo_root / ".git" / "temp_pages_index"
    if temp_index.exists():
        try:
            temp_index.unlink()
        except OSError:
            pass

    print("\n" + "=" * 80)
    print("BSWA Deeper Dhamma: Deploy to GitHub Pages (deeperdhamma.com)")
    print("=" * 80)
    print(f"[*] Distribution Directory: {dist_path}")
    print(f"[*] Remote Repository:      {remote}")
    print(f"[*] Target Branch:          {branch}")
    print(f"[*] Custom Domain (CNAME):  {cname_path.read_text().strip()}")
    print("-" * 80)

    env = os.environ.copy()
    env["GIT_WORK_TREE"] = str(dist_path.resolve())
    env["GIT_INDEX_FILE"] = str(temp_index.resolve())

    try:
        # 1. Stage all files from dist_path into temp git index
        subprocess.run(["git", "add", "-A"], cwd=str(repo_root), env=env, check=True)

        # 2. Write tree object
        tree_sha = subprocess.check_output(
            ["git", "write-tree"], cwd=str(repo_root), env=env, text=True
        ).strip()

        # 3. Create commit object
        today_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        commit_msg = f"Deploy Deeper Dhamma v{int(time.time())} to deeperdhamma.com ({today_str})"
        commit_sha = subprocess.check_output(
            ["git", "commit-tree", tree_sha, "-m", commit_msg],
            cwd=str(repo_root),
            env=env,
            text=True,
        ).strip()

        # 4. Push commit to remote branch
        print(f"[*] Pushing commit {commit_sha[:8]} to {remote}/{branch}...")
        subprocess.run(
            ["git", "push", remote, f"{commit_sha}:refs/heads/{branch}", "--force"],
            cwd=str(repo_root),
            check=True,
        )

        print("-" * 80)
        print("[✓] Successfully deployed to GitHub Pages!")
        print("    Live URL:  https://deeperdhamma.com/")
        print("    Branch:    gh-pages")
        print("=" * 80 + "\n")
    finally:
        if temp_index.exists():
            try:
                temp_index.unlink()
            except OSError:
                pass

