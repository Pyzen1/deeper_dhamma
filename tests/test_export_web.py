"""
Unit tests for Static Web Application & SQLite WASM Compiler.
"""

from pathlib import Path
import sqlite3
import pytest

from deeper_dhamma.config import BUDDHISM_LEXICON_DB_PATH, TRANSCRIPTS_DB_PATH
from deeper_dhamma.export_web import compile_static_database


def test_compile_static_database_header_version_and_vocab_table(tmp_path: Path):
    """
    Verifies that compile_static_database consolidates transcripts and lexicon tables,
    stamps PRAGMA user_version in the SQLite 100-byte header, and builds the search_vocab table.
    """
    if not (TRANSCRIPTS_DB_PATH.exists() and BUDDHISM_LEXICON_DB_PATH.exists()):
        pytest.skip("Source databases not present for static compilation test")

    output_db = tmp_path / "test_dhamma_web.db"
    target_version = 20261106

    metrics = compile_static_database(output_db, version_int=target_version)

    assert output_db.exists()
    assert metrics["version"] == target_version
    assert metrics["size_bytes"] > 0
    assert metrics["episodes"] >= 0
    assert metrics["terms"] >= 1000

    # Inspect compiled database directly
    conn = sqlite3.connect(output_db)
    try:
        # 1. Header user_version
        user_version = conn.execute("PRAGMA user_version;").fetchone()[0]
        assert user_version == target_version

        # 2. search_vocab table compliance
        vocab_info = conn.execute("PRAGMA table_info(search_vocab);").fetchall()
        assert len(vocab_info) >= 3
        pk_col = next(r[1] for r in vocab_info if r[5] == 1)
        assert pk_col == "id", "search_vocab table must use integer primary key 'id'"

        vocab_count = conn.execute("SELECT COUNT(*) FROM search_vocab;").fetchone()[0]
        assert vocab_count > 100

        # 3. v_terms view and fts_terms virtual table exist
        v_terms_sample = conn.execute("SELECT id, pali_plain, translation_bodhi FROM v_terms LIMIT 1;").fetchone()
        assert v_terms_sample is not None

        fts_sample = conn.execute("SELECT * FROM fts_terms WHERE fts_terms MATCH 'jhana' LIMIT 1;").fetchone()
        assert fts_sample is not None

        # 4. episode_words table compliance & byte integrity
        words_info = conn.execute("PRAGMA table_info(episode_words);").fetchall()
        assert len(words_info) >= 3
        pk_words = next(r[1] for r in words_info if r[5] == 1)
        assert pk_words == "id", "episode_words table must use integer primary key 'id'"
        assert metrics.get("words", 0) == 9

        w_row = conn.execute("SELECT words_blob FROM episode_words WHERE episode_id = 'pb28113880';").fetchone()
        assert w_row is not None
        assert len(w_row[0]) == 41416
    finally:
        conn.close()


def test_offline_service_worker_bundling_and_routes():
    """
    Verifies that:
    1. svc_worker.js exists in static/ and dist/ (and svc-worker.js is removed).
    2. svc_worker.js implements cache-first navigation and server probe exceptions.
    3. StaticPreviewHandler exposes /svc_worker.js with Service-Worker-Allowed: / and handles HTTP Range.
    """
    from deeper_dhamma.config import DIST_DIR, PROJECT_ROOT

    static_dir = PROJECT_ROOT / "deeper_dhamma" / "web" / "static"
    sw_file = static_dir / "svc_worker.js"

    assert sw_file.exists(), "svc_worker.js must exist in web/static/"
    assert not (static_dir / "svc-worker.js").exists(), "svc-worker.js must be cleaned up from web/static/"

    sw_code = sw_file.read_text(encoding="utf-8")
    assert "CACHE_NAME" in sw_code
    assert "Range" in sw_code and "bytes=0-99" in sw_code, "Must bypass version probe requests"
    assert "navigate" in sw_code, "Must handle navigation requests with cache-first"

    # Verify dist/ has the service worker file and no legacy svc-worker.js
    assert (DIST_DIR / "svc_worker.js").exists(), "dist/svc_worker.js must be deployed"
    assert not (DIST_DIR / "svc-worker.js").exists(), "dist/svc-worker.js must be cleaned up"

    # Verify StaticPreviewHandler serves svc_worker.js and Range requests
    import http.server
    import threading
    import urllib.request
    from deeper_dhamma.export_web import StaticPreviewHandler

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: StaticPreviewHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        # 1. svc_worker.js headers
        req_sw = urllib.request.Request(f"http://127.0.0.1:{port}/svc_worker.js")
        with urllib.request.urlopen(req_sw) as res:
            assert res.status == 200
            assert res.headers.get("Service-Worker-Allowed") == "/"
            body = res.read()
            assert len(body) > 100

        # 2. Native Range request for SQLite WASM
        req_range = urllib.request.Request(
            f"http://127.0.0.1:{port}/sqlite3.wasm",
            headers={"Range": "bytes=0-99"},
        )
        with urllib.request.urlopen(req_range) as res:
            assert res.status == 206
            assert res.headers.get("Content-Range", "").startswith("bytes 0-99/")
            assert len(res.read()) == 100
    finally:
        server.shutdown()
        server.server_close()


def test_service_worker_dynamic_version_stamping_and_network_first_navigation():
    """
    Verifies that:
    1. Static build pre-renders svc_worker.js with a dynamic numeric cache version.
    2. dist/svc_worker.js contains 'deeper_dhamma_shell_<version>' and no un-templated '{{db_version}}'.
    3. svc_worker.js uses Network-First for navigation requests when online with fallback to cache.
    4. svc_worker.js supports version query strings (?v=...) for asset cache updates.
    5. app.js contains null guards for drawer elements and does not reference deleted #drawer-play-full-btn.
    """
    import re
    from deeper_dhamma.config import DIST_DIR, PROJECT_ROOT

    # 1. Check template in static/ contains the placeholder
    sw_template_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "svc_worker.js"
    assert sw_template_path.exists()
    sw_template = sw_template_path.read_text(encoding="utf-8")
    assert "const CACHE_NAME = 'deeper_dhamma_shell_{{db_version}}';" in sw_template

    # 2. Check rendered dist/svc_worker.js has numeric timestamp stamp
    sw_dist_path = DIST_DIR / "svc_worker.js"
    assert sw_dist_path.exists()
    sw_dist = sw_dist_path.read_text(encoding="utf-8")
    assert "{{db_version}}" not in sw_dist, "dist/svc_worker.js must not contain un-templated {{db_version}}"
    match = re.search(r"const CACHE_NAME = 'deeper_dhamma_shell_(\d+)';", sw_dist)
    assert match is not None, "dist/svc_worker.js must have stamped numeric cache name"
    version_val = int(match.group(1))
    assert version_val > 1700000000, f"Cache version should be a valid unix timestamp, got {version_val}"

    # 3. Check Network-First navigation with offline cache fallback
    assert "req.mode === 'navigate'" in sw_dist
    assert "navigator.onLine" in sw_dist
    assert "AbortController" in sw_dist

    # 4. Check query-sensitive asset matching
    assert "matchInCache(req)" in sw_dist
    assert "search.includes('v=')" in sw_dist

    # 5. Check app.js null-safety and no deleted button references
    app_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "app.js"
    assert app_js_path.exists()
    app_js = app_js_path.read_text(encoding="utf-8")
    assert "drawerPlayFullBtn" not in app_js, "app.js must not reference deleted drawerPlayFullBtn"
    assert "drawer-play-full-btn" not in app_js, "app.js must not reference deleted #drawer-play-full-btn"
    assert "if (els.drawerTurns)" in app_js, "app.js must null-guard els.drawerTurns"
    assert "if (els.drawerTitle)" in app_js, "app.js must null-guard els.drawerTitle"
    assert "window.resetDeeperDhammaCache" in app_js, "app.js must provide resetDeeperDhammaCache recovery"



