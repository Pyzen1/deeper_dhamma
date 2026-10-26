"""
Static Web Site & SQLite WASM Compiler for Deeper Dhamma.

Compiles an immutable, serverless static web application into dist/:
1. Consolidates dhamma_transcripts.db and buddhism_lexicon.db into a single dhamma_web.db.
2. Stamps PRAGMA user_version = <YYYYMMDD> in the SQLite 100-byte file header.
3. Bundles official SQLite WASM engine, FTS5 virtual tables, and Web Worker client.
4. Pre-renders index.html using Bottle's SimpleTemplate.
"""

import logging
import os
import shutil
import sqlite3
import sys
import urllib.request
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from bottle import Bottle, SimpleTemplate, static_file

from deeper_dhamma.config import (
    BUDDHISM_LEXICON_DB_PATH,
    DEFAULT_WEB_HOST,
    DEFAULT_WEB_PORT,
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
        output_db_path.unlink()

    # 1. Clone base transcripts database
    logger.info(f"Cloning transcripts database from {TRANSCRIPTS_DB_PATH} ...")
    with sqlite3.connect(TRANSCRIPTS_DB_PATH) as src, sqlite3.connect(output_db_path) as dst:
        src.backup(dst)

    # 2. Attach lexicon and import terms, source documents, and views
    with sqlite3.connect(output_db_path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF;")
        conn.execute(f"ATTACH DATABASE '{BUDDHISM_LEXICON_DB_PATH}' AS lex;")

        # Copy lexicon reference tables
        conn.execute("CREATE TABLE IF NOT EXISTS source_documents AS SELECT * FROM lex.source_documents;")
        conn.execute("CREATE TABLE IF NOT EXISTS terms AS SELECT * FROM lex.terms;")
        conn.execute("CREATE TABLE IF NOT EXISTS phrase_rules AS SELECT * FROM lex.phrase_rules;")

        # Recreate lexical join view
        conn.execute("DROP VIEW IF EXISTS v_terms;")
        conn.execute("""
            CREATE VIEW v_terms AS
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
                s.url AS source_url,
                s.title AS source_title,
                s.author AS source_author
            FROM terms t
            LEFT JOIN source_documents s ON t.source_document_id = s.id;
        """)

        # Rebuild lexical FTS5 search table
        conn.execute("DROP TABLE IF EXISTS fts_terms;")
        conn.execute("""
            CREATE VIRTUAL TABLE fts_terms USING fts5(
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
        conn.execute("INSERT INTO fts_terms(fts_terms) VALUES('rebuild');")

        conn.execute("DETACH DATABASE lex;")
        conn.commit()

        # 3. Clean and set header version outside transaction
        conn.isolation_level = None
        conn.execute("PRAGMA journal_mode = DELETE;")
        conn.execute(f"PRAGMA user_version = {version_int};")
        conn.execute("VACUUM;")

        # Gather metrics
        episodes_count = conn.execute("SELECT COUNT(*) FROM episodes;").fetchone()[0]
        segments_count = conn.execute("SELECT COUNT(*) FROM speech_segments;").fetchone()[0]
        terms_count = conn.execute("SELECT COUNT(*) FROM terms;").fetchone()[0]

    final_size = output_db_path.stat().st_size
    return {
        "version": version_int,
        "size_bytes": final_size,
        "episodes": episodes_count,
        "segments": segments_count,
        "terms": terms_count,
    }


def export_static_site(output_dir: Path | str = "dist") -> Path:
    """
    Builds the complete self-contained static site and SQLite WASM bundle.
    """
    out_path = Path(output_dir).resolve()
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

    # 1. Compile consolidated SQLite database
    db_out = out_path / "dhamma_web.db"
    metrics = compile_static_database(db_out, version_int=version_int)
    print(f"[✓] Compiled dhamma_web.db: {metrics['size_bytes'] / (1024 * 1024):.2f} MB")
    print(f"    - Episodes indexed:      {metrics['episodes']:,}")
    print(f"    - Speech segments:       {metrics['segments']:,}")
    print(f"    - Buddhist Pali terms:   {metrics['terms']:,}")

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

    # Deploy pure SQLite WASM client adapter to dist/db_client.js
    wasm_adapter = STATIC_SRC_DIR / "adapters" / "wasm_client.js"
    if wasm_adapter.exists():
        shutil.copy2(wasm_adapter, out_path / "db_client.js")
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

    # SimpleTemplate rendering
    tpl = SimpleTemplate(html_src)
    rendered_html = tpl.render(
        build_date=date_str,
        db_version=version_int,
        total_episodes=metrics["episodes"],
    )

    out_index = out_path / "index.html"
    with open(out_index, "w", encoding="utf-8") as f:
        f.write(rendered_html)

    print(f"[✓] Pre-rendered index.html with relative asset links")
    print("-" * 80)
    print("[✓] Static Site Build Complete!")
    print(f"    To preview locally: python main.py web --run")
    print(f"    To deploy: Upload the contents of '{out_path}' to GitHub Pages, Cloudflare Pages, or S3.")
    print("=" * 80 + "\n")

    return out_path


def run_web_preview(host: str = DEFAULT_WEB_HOST, port: int = DEFAULT_WEB_PORT, dist_dir: Path | str = "dist") -> None:
    """
    Serves the static distribution folder using Bottle with native HTTP Range request support.
    """
    dist_path = Path(dist_dir).resolve()
    if not (dist_path / "index.html").exists():
        print(f"[-] Static build not found in '{dist_path}'. Building now...")
        export_static_site(dist_path)

    app = Bottle()

    @app.route("/")
    def serve_index():
        return static_file("index.html", root=str(dist_path))

    @app.route("/<filepath:path>")
    def serve_static(filepath: str):
        return static_file(filepath, root=str(dist_path))

    print("\n" + "=" * 80)
    print("BSWA Deeper Dhamma: Static Web Preview Server")
    print("=" * 80)
    print(f"[*] Serving static bundle:  {dist_path}")
    print(f"[*] Local URL:              http://{host}:{port}/")
    print(f"[*] HTTP Range Support:     Enabled (for SQLite WASM header probes)")
    print("=" * 80)
    print("Press Ctrl+C to stop.\n")

    app.run(host=host, port=port, server="wsgiref")
