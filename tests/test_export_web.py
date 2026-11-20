"""
Unit tests for Static Web Application & SQLite WASM Compiler.
"""

from pathlib import Path
import sqlite3
import struct
import pytest

from deeper_dhamma.config import BUDDHISM_LEXICON_DB_PATH, TRANSCRIPTS_DB_PATH
from deeper_dhamma.export_web import compile_static_database

APP_FRONTEND_MODULES = (
    "speaker_palette.js",
    "bookmarks_view.js",
    "browse_view.js",
    "archive_export.js",
    "search_view.js",
    "lexicon_views.js",
    "audio_player.js",
    "app.js",
)

APP_FRONTEND_STYLES = (
    "style.css",
    "style_browse.css",
    "style_lexicon.css",
    "style_player.css",
    "style_transcript.css",
    "style_bookmarks_about.css",
)


def _read_all_app_js(web_dir: Path) -> str:
    """Reads all modular frontend JS files that compose the application shell."""
    static_dir = web_dir / "static"
    return "\n".join((static_dir / name).read_text(encoding="utf-8") for name in APP_FRONTEND_MODULES)


def _read_all_style_css(web_dir: Path) -> str:
    """Reads all modular frontend CSS files in cascade order."""
    static_dir = web_dir / "static"
    return "\n".join((static_dir / name).read_text(encoding="utf-8") for name in APP_FRONTEND_STYLES)


def test_standalone_frontend_modules_architecture():
    """
    Verifies the standalone frontend module architecture:
    1. All 8 JS modules (<2000 lines) and 6 CSS modules (<1500 lines) exist in web/static/ with LF endings.
    2. index.html and svc_worker.js reference all JS and CSS modules in exact dependency/cascade order.
    3. dist/ matches web/static/ byte-for-byte for every module when built.
    """
    from deeper_dhamma.config import DIST_DIR, PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    static_dir = web_dir / "static"
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    svc_worker_js = (static_dir / "svc_worker.js").read_text(encoding="utf-8")

    html_positions = []
    sw_positions = []
    for mod_name in APP_FRONTEND_MODULES:
        mod_path = static_dir / mod_name
        assert mod_path.exists(), f"Missing standalone frontend module: {mod_name}"
        raw = mod_path.read_bytes()
        assert b"\r\n" not in raw, f"{mod_name} must use LF line endings"
        line_count = len(raw.decode("utf-8").splitlines())
        assert line_count < 2000, f"{mod_name} must stay under 2000 lines (got {line_count})"

        script_ref = f'/static/{mod_name}?v='
        assert script_ref in index_html, f"index.html must load {mod_name}"
        html_positions.append(index_html.index(script_ref))

        sw_ref = f"'./{mod_name}'"
        assert sw_ref in svc_worker_js, f"svc_worker.js must precache {mod_name}"
        sw_positions.append(svc_worker_js.index(sw_ref))

        if (DIST_DIR / "index.html").exists():
            dist_mod = DIST_DIR / mod_name
            assert dist_mod.exists(), f"dist/ missing {mod_name}"
            assert dist_mod.read_bytes() == raw, f"dist/{mod_name} out of sync with web/static/{mod_name}"

    assert html_positions == sorted(html_positions), "index.html script tags must preserve exact module load order"
    assert sw_positions == sorted(sw_positions), "svc_worker.js CORE_ASSETS must include all modules in order"

    css_html_positions = []
    css_sw_positions = []
    for css_name in APP_FRONTEND_STYLES:
        css_path = static_dir / css_name
        assert css_path.exists(), f"Missing standalone frontend stylesheet: {css_name}"
        raw = css_path.read_bytes()
        assert b"\r\n" not in raw, f"{css_name} must use LF line endings"
        line_count = len(raw.decode("utf-8").splitlines())
        assert line_count < 1500, f"{css_name} must stay under 1500 lines (got {line_count})"

        link_ref = f'/static/{css_name}?v='
        assert link_ref in index_html, f"index.html must link {css_name}"
        css_html_positions.append(index_html.index(link_ref))

        sw_ref = f"'./{css_name}'"
        assert sw_ref in svc_worker_js, f"svc_worker.js must precache {css_name}"
        css_sw_positions.append(svc_worker_js.index(sw_ref))

        if (DIST_DIR / "index.html").exists():
            dist_css = DIST_DIR / css_name
            assert dist_css.exists(), f"dist/ missing {css_name}"
            assert dist_css.read_bytes() == raw, f"dist/{css_name} out of sync with web/static/{css_name}"

    assert css_html_positions == sorted(css_html_positions), "index.html stylesheet links must preserve exact cascade order"
    assert css_sw_positions == sorted(css_sw_positions), "svc_worker.js CORE_ASSETS must include all stylesheets in order"


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
        assert metrics.get("words", 0) >= 9

        w_row = conn.execute("SELECT words_blob FROM episode_words WHERE episode_id = 'pb28113880';").fetchone()
        assert w_row is not None
        blob = w_row[0]
        word_count = struct.unpack("<I", blob[:4])[0]
        assert word_count > 0
        assert len(blob) >= 4 + word_count * 6

        seg_rows = conn.execute("SELECT text FROM speech_segments WHERE episode_id = 'pb28113880' ORDER BY turn_index;").fetchall()
        token_count = sum(len(r[0].split()) for r in seg_rows)
        assert word_count == token_count, f"Compiled pb28113880 word count {word_count} != token count {token_count}"

        src_conn = sqlite3.connect(TRANSCRIPTS_DB_PATH)
        try:
            src_row = src_conn.execute("SELECT words_blob FROM episode_words WHERE episode_id = 'pb28113880';").fetchone()
            assert src_row is not None
            assert blob == src_row[0], "Compiled words_blob must match source dhamma_transcripts.db byte-for-byte"
        finally:
            src_conn.close()
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
    assert "cache: 'reload'" in sw_dist, "svc_worker.js precaching must use cache: 'reload' to bypass HTTP cache"

    # 4.1 Check .nojekyll bypass exists
    assert (PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / ".nojekyll").exists()

    # 5. Check app.js null-safety and no deleted button references
    app_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "app.js"
    assert app_js_path.exists()
    app_js = app_js_path.read_text(encoding="utf-8")
    assert "drawerPlayFullBtn" not in app_js, "app.js must not reference deleted drawerPlayFullBtn"
    assert "drawer-play-full-btn" not in app_js, "app.js must not reference deleted #drawer-play-full-btn"
    assert "transcriptPlayBtn" in app_js, "app.js must wire up transcriptPlayBtn"
    assert "btn-player-transcript" in app_js, "app.js must wire up btn-player-transcript"
    assert "if (els.drawerTurns)" in app_js, "app.js must null-guard els.drawerTurns"
    assert "if (els.drawerTitle)" in app_js, "app.js must null-guard els.drawerTitle"
    assert "window.resetDeeperDhammaCache" in app_js, "app.js must provide resetDeeperDhammaCache recovery"


def test_bookmark_feature_and_view_integrity():
    """
    Verifies the bookmark feature architecture:
    1. index.html defines the Bookmarks tab nav button, badge counter, and view panel.
    2. Bookmark ribbon icon buttons exist on cards, transcript reader, and audio player bar.
    3. db_worker.js and wasm_client.js implement getEpisodesByIds to load talks from stored IDs.
    4. app.js contains BookmarkStore with localStorage persistence, reordering (moveUp/moveDown/drag),
       deletion, and waiting for database load state.
    5. style.css includes styling for bookmark ribbon buttons, drag handles, and reorder controls.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    app_js = _read_all_app_js(web_dir)
    bookmarks_view_js = (web_dir / "static" / "bookmarks_view.js").read_text(encoding="utf-8")
    card_physics_js = (web_dir / "static" / "card_physics.js").read_text(encoding="utf-8")
    db_worker_js = (web_dir / "static" / "db_worker.js").read_text(encoding="utf-8")
    wasm_client_js = (web_dir / "static" / "adapters" / "wasm_client.js").read_text(encoding="utf-8")
    db_client_js = (web_dir / "static" / "db_client.js").read_text(encoding="utf-8")
    svc_worker_js = (web_dir / "static" / "svc_worker.js").read_text(encoding="utf-8")
    style_css = _read_all_style_css(web_dir)

    # 1. Navigation & View elements in index.html
    assert 'id="tab-bookmarks-btn"' in index_html, "Must have bookmarks nav tab"
    assert 'data-tab="bookmarks-view"' in index_html, "Must point to bookmarks-view"
    assert 'id="bookmarks-count-badge"' in index_html, "Must have bookmarks counter badge"
    assert 'id="bookmarks-view"' in index_html, "Must have bookmarks-view panel"
    assert 'id="bookmarks-list"' in index_html, "Must have bookmarks-list container"
    assert 'id="transcript-bookmark-btn"' in index_html, "Must have transcript drawer bookmark button"
    assert 'id="btn-player-bookmark"' in index_html, "Must have audio player bar bookmark button"
    assert 'card_physics.js' in index_html, "Must load decoupled card_physics.js engine"
    assert 'bookmarks_view.js' in index_html, "Must load decoupled bookmarks_view.js module"
    assert '__DEEPER_DHAMMA_VERSION__' in index_html, "Must stamp global version in index.html"
    assert '__DEEPER_DHAMMA_VERSION__' in wasm_client_js, "Must propagate version query to db_worker.js"
    assert 'card_physics.js' in svc_worker_js, "Must cache card_physics.js in svc_worker.js"
    assert 'bookmarks_view.js' in svc_worker_js, "Must cache bookmarks_view.js in svc_worker.js"

    # 2. Worker & Client APIs for batch fetching by IDs
    assert "handleGetEpisodesByIds" in db_worker_js
    assert "case 'get_episodes_by_ids':" in db_worker_js
    assert "async getEpisodesByIds(ids)" in wasm_client_js
    assert "async getEpisodesByIds(ids)" in db_client_js
    assert "Unknown message type" in wasm_client_js, "Client must provide backward-compatible fallback for cached workers"
    assert "Unknown message type" in db_client_js, "Client must provide backward-compatible fallback for cached workers"

    # 3. Decoupled Generic CardPhysics Engine
    assert "CardPhysics" in card_physics_js
    assert "stepExchange(" in card_physics_js
    assert "_initCard(" in card_physics_js
    assert "_updateIndicator(" in card_physics_js
    assert "_finishDrag(" in card_physics_js

    # 4. BookmarkStore & reordering integration in bookmarks_view.js + speaker_palette.js
    assert "BookmarkStore" in bookmarks_view_js
    assert "deeper_dhamma_bookmarks" in bookmarks_view_js
    assert "renderBookmarkRibbonSvg" in app_js
    assert "bookmark-ribbon-icon" in app_js
    assert "loadBookmarksView" in bookmarks_view_js
    assert "renderBookmarksList" in bookmarks_view_js
    assert "Waiting for database to load..." in bookmarks_view_js
    assert "moveUp(" in bookmarks_view_js
    assert "moveDown(" in bookmarks_view_js
    assert "moveRelativeTo(" in bookmarks_view_js
    assert "CardPhysics" in bookmarks_view_js
    assert "bookmarkPhysics" in bookmarks_view_js
    assert "bookmark-floating-drag-card" in bookmarks_view_js
    assert "bookmark-drop-indicator" in bookmarks_view_js
    assert "is-ghost" in bookmarks_view_js
    assert "bookmark-order-badge" in bookmarks_view_js
    assert "btn-bookmark-icon" in app_js

    # 5. CSS styling (Generic & Bookmark-Specific)
    assert ".btn-bookmark-icon" in style_css
    assert ".bookmark-ribbon-icon" in style_css
    assert ".bookmark-card" in style_css
    assert ".card-is-ghost" in style_css
    assert ".card-floating-drag" in style_css
    assert ".card-drop-indicator" in style_css
    assert ".card-is-exchanging-active" in style_css
    assert ".card-is-exchanging-target" in style_css
    assert ".bookmark-order-badge" in style_css
    assert ".card-drag-handle" in style_css
    assert ".btn-reorder" in style_css


def test_bookmark_reorder_persistence_and_episodes_sync():
    """
    Verifies that removing and adding bookmarks followed by arrow reordering
    preserves all bookmarks without dropping any items:
    1. app.js maintains state.bookmarkEpisodes dynamically.
    2. onExchange and onReorder resequence state.bookmarkEpisodes via BookmarkStore.getAll().
    3. onRender re-renders from state.bookmarkEpisodes.
    4. CardPhysics.prototype.attach accepts and merges dynamic options.
    5. Pure-logic simulation of the exact user scenario:
       - 4 initial bookmarks
       - 2 removed
       - 2 added (total 4)
       - up/down arrow reorders
       - asserts length remains exactly 4 and elements are reordered correctly.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    app_js = (web_dir / "static" / "app.js").read_text(encoding="utf-8")
    bookmarks_view_js = (web_dir / "static" / "bookmarks_view.js").read_text(encoding="utf-8")
    card_physics_js = (web_dir / "static" / "card_physics.js").read_text(encoding="utf-8")

    # 1. Verify app.js & bookmarks_view.js dynamic state synchronization
    assert "bookmarkEpisodes:" in app_js, "state must define bookmarkEpisodes"
    assert "state.bookmarkEpisodes = " in bookmarks_view_js, "Must store episodes on state"
    assert "BookmarkStore.getAll().map(id => epMap.get(id)).filter(Boolean)" in bookmarks_view_js, (
        "Must resequence state.bookmarkEpisodes from BookmarkStore.getAll() in onExchange and onReorder"
    )
    assert "renderBookmarksList(state.bookmarkEpisodes)" in bookmarks_view_js, (
        "onRender must render the dynamic state.bookmarkEpisodes"
    )

    # 2. Verify CardPhysics.prototype.attach options merging and cache reset
    assert "attach(container, options = null)" in card_physics_js
    assert "Object.assign(this.options, options)" in card_physics_js
    assert "this._boundCards.clear()" in card_physics_js

    # 3. Simulate exact user bug scenario:
    class SimulatedBookmarkStore:
        def __init__(self):
            self._ids = []
            self._set = set()

        def add(self, ep_id: str):
            if ep_id in self._set:
                return
            self._ids.insert(0, ep_id)
            self._set.add(ep_id)

        def remove(self, ep_id: str):
            if ep_id not in self._set:
                return
            self._ids = [x for x in self._ids if x != ep_id]
            self._set.remove(ep_id)

        def move_up(self, ep_id: str):
            idx = self._ids.index(ep_id)
            if idx > 0:
                self._ids[idx], self._ids[idx - 1] = self._ids[idx - 1], self._ids[idx]
                return True
            return False

        def move_down(self, ep_id: str):
            idx = self._ids.index(ep_id)
            if 0 <= idx < len(self._ids) - 1:
                self._ids[idx], self._ids[idx + 1] = self._ids[idx + 1], self._ids[idx]
                return True
            return False

        def get_all(self):
            return list(self._ids)

    store = SimulatedBookmarkStore()

    # Step 1: User starts with 4 bookmarks
    for ep in ["talk_1", "talk_2", "talk_3", "talk_4"]:
        store.add(ep)
    assert store.get_all() == ["talk_4", "talk_3", "talk_2", "talk_1"]

    # Step 2: User removes 2 bookmarks
    store.remove("talk_1")
    store.remove("talk_2")
    assert store.get_all() == ["talk_4", "talk_3"]

    # Step 3: User adds 2 new bookmarks (now 4 total)
    store.add("talk_5")
    store.add("talk_6")
    assert store.get_all() == ["talk_6", "talk_5", "talk_4", "talk_3"]
    assert len(store.get_all()) == 4

    # Step 4: User clicks Up arrow on talk_3
    assert store.move_up("talk_3") is True
    # Talk 3 swaps with talk 4
    assert store.get_all() == ["talk_6", "talk_5", "talk_3", "talk_4"]
    assert len(store.get_all()) == 4, "Must not drop bookmarks on move_up!"

    # Step 5: User clicks Down arrow on talk_5
    assert store.move_down("talk_5") is True
    # Talk 5 swaps with talk 3
    assert store.get_all() == ["talk_6", "talk_3", "talk_5", "talk_4"]
    assert len(store.get_all()) == 4, "Must not drop bookmarks on move_down!"

    # Step 6: Verify mapping to episode objects
    episodes_pool = {f"talk_{i}": {"id": f"talk_{i}", "title": f"Title {i}"} for i in range(1, 7)}
    resequenced = [episodes_pool[ep_id] for ep_id in store.get_all()]
    assert len(resequenced) == 4
    assert [e["id"] for e in resequenced] == ["talk_6", "talk_3", "talk_5", "talk_4"]


def test_bookmark_finger_touch_and_physical_exchange_animation():
    """
    Verifies that:
    1. The 6-dots handle (⠿) is removed from bookmark cards, avoiding visual clutter.
    2. Up/down arrow reorder buttons have generous finger-tappable dimensions (>= 36px height).
    3. stepExchange in card_physics.js explicitly configures smooth CSS transitions on transform,
       triggers layout flush (offsetHeight), and cleans up properly.
    4. CSS applies transition: transform on exchanging cards and bookmark-card.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    app_js = _read_all_app_js(web_dir)
    card_physics_js = (web_dir / "static" / "card_physics.js").read_text(encoding="utf-8")
    style_css = _read_all_style_css(web_dir)

    # 1. 6-dots icon removed from bookmark list cards
    assert "bookmark-drag-handle" not in app_js, "Six dots handle must be removed from bookmark cards"
    assert "⠿" not in app_js, "Six dots unicode symbol must not be rendered in bookmark cards"

    # 2. Large finger-tappable buttons in style.css
    assert "height: 36px;" in style_css, "Reorder buttons must have at least 36px height"
    assert "min-height: 36px;" in style_css, "Reorder buttons must enforce min-height 36px"
    assert "touch-action: manipulation;" in style_css, "Must optimize mobile touch delay"

    # 3. Physics engine hardware-accelerated transition and reflow flush
    assert "currentCard.style.transition =" in card_physics_js, "Must set explicit transition on currentCard"
    assert "targetCard.style.transition =" in card_physics_js, "Must set explicit transition on targetCard"
    assert "offsetHeight" in card_physics_js, "Must force browser reflow to guarantee CSS transition animation"
    assert "translateY" in card_physics_js, "Must translate along Y axis"
    assert "scale" in card_physics_js, "Must apply depth scale during physical exchange"

    # 4. CSS transition rules on cards
    assert "transition: transform" in style_css, "Must declare transition on transform in CSS"

    # 5. Drop-in-place animation mechanics in _finishDrag
    assert "floatingEl.style.transition =" in card_physics_js, "Must set glide transition on floatingEl before drop"
    assert "floatingEl.offsetHeight" in card_physics_js, "Must flush layout on floatingEl for drop glide"
    assert "translate(${deltaX}px, ${deltaY}px)" in card_physics_js, "Must animate floatingEl into destination rect"
    assert "floatingEl.remove()" in card_physics_js, "Must cleanly remove floating element after drop animation"


def test_about_view_and_navigation_integrity():
    """
    Verifies that the About page and view navigation are properly integrated:
    1. index.html contains tab-about-btn, data-tab="about-view", and #about-view.
    2. #about-view contains detailed sections: historical audio heritage, features,
       technical architecture, monastic teachers, shortcuts, and dāna acknowledgments.
    3. app.js caches tabAboutBtn and aboutView, registers click listener, supports 'about' route
       in parseLocation and handleRoute, and maps 'about-view' to 'about' in switchTab.
    4. style.css includes responsive styles for .about-container, .about-hero, .about-features-grid,
       .about-arch-grid, .about-teachers-grid, .shortcuts-grid, and .about-dana-card.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    app_js = (web_dir / "static" / "app.js").read_text(encoding="utf-8")
    style_css = _read_all_style_css(web_dir)

    # 1. Navigation & DOM elements in index.html
    assert 'id="tab-about-btn"' in index_html, "Must have about nav tab button"
    assert 'data-tab="about-view"' in index_html, "Must point to about-view"
    assert 'id="about-view"' in index_html, "Must have about-view panel"
    assert 'about-hero' in index_html, "Must have hero section"
    assert 'about-features-grid' in index_html, "Must have features grid"
    assert 'about-arch-grid' in index_html, "Must have technical architecture grid"
    assert 'about-teachers-grid' in index_html, "Must have teachers grid"
    assert 'shortcuts-grid' in index_html, "Must have shortcuts grid"
    assert 'about-dana-card' in index_html, "Must have dana card"

    # 2. Key content items in index.html
    assert "Ajahn Brahm" in index_html, "Must mention Ajahn Brahm"
    assert "Ajahn Brahmali" in index_html, "Must mention Ajahn Brahmali"
    assert "Bhante Sujato" in index_html, "Must mention Bhante Sujato"
    assert "faster-whisper-large-v3" in index_html, "Must explain ASR model"
    assert "ECAPA-TDNN" in index_html, "Must explain diarization"
    assert "Buddhist Society of Western Australia" in index_html, "Must reference BSWA"

    # 3. Router and tab handling in app.js
    assert "tabAboutBtn: document.getElementById('tab-about-btn')" in app_js, "Must cache tabAboutBtn"
    assert "aboutView: document.getElementById('about-view')" in app_js, "Must cache aboutView"
    assert "els.tabAboutBtn.addEventListener('click', () => switchTab('about-view'))" in app_js, "Must register about click listener"
    assert "case 'about':" in app_js, "Must handle about route in handleRoute"
    assert "'about-view': 'about'" in app_js, "Must map about-view to about route in switchTab"

    # 4. Styling in style.css
    assert ".about-container" in style_css, "Must have .about-container in CSS"
    assert ".about-hero" in style_css, "Must have .about-hero in CSS"
    assert ".about-features-grid" in style_css, "Must have .about-features-grid in CSS"
    assert ".about-arch-grid" in style_css, "Must have .about-arch-grid in CSS"
    assert ".about-teachers-grid" in style_css, "Must have .about-teachers-grid in CSS"
    assert ".about-dana-card" in style_css, "Must have .about-dana-card in CSS"

    # 5. English talks count, Bhante Sujato naming, and telemetry/privacy adjustments
    assert "2,971 English" in index_html, "Must specify 2,971 English talks"
    assert "3,246 English" not in index_html, "Must remove stale 3,246 English talks count"
    assert "(Ajahn Sujato)" not in index_html, "Must remove '(Ajahn Sujato)' side parens"
    assert "anonymous usage" in index_html, "Must state collection of anonymous usage statistics"
    assert "Zero tracking, zero telemetry" not in index_html, "Must remove strict no-telemetry note"

    # 6. Non-conflicting keyboard shortcuts
    assert "safeSeek(curPhys - 15)" in app_js, "Must support J/L media seek in app.js"
    assert "Shift" not in index_html.split("shortcuts-grid")[1].split("about-diagnostics-card")[0], "Must not use Shift+Arrow shortcuts that conflict with text selection"

    # 7. Voluntary donations and site upkeep support
    assert "dana-support-banner" in index_html, "Must have donation support banner in index.html"
    assert "<!-- Site Upkeep Support Banner" in index_html, "Site upkeep banner should be commented out pending Ko-fi setup"
    assert "-->" in index_html.split('id="btn-donate-site"')[1].split("dana-links-grid")[0], "Site upkeep banner should be enclosed in HTML comments"
    assert "upkeep" in index_html.lower(), "Must mention donations for site upkeep"
    assert "infrastructure costs" in index_html.lower(), "Must mention generic infrastructure costs"
    assert "audio streaming" not in index_html.split("about-dana-card")[1].split("about-features-grid")[0], "Must not claim audio streaming costs"
    assert "btn-donate-site" in index_html, "Must have site upkeep donation button"
    assert "btn-donate-bswa" in index_html, "Must have BSWA donation button"
    assert "dana-bswa-card" in index_html, "Must have dana-bswa-card in index.html"
    assert "btn-donate-bswa" in index_html.split("dana-bswa-card")[1].split("dana-sc-card")[0], "Must place BSWA donation button inside the BSWA dana card"
    assert ".dana-support-banner" in style_css, "Must style donation support banner in style.css"
    assert ".dana-bswa-card" in style_css, "Must style dana-bswa-card in style.css"

    # 8. SuttaCentral donation button and Dāna section relocation
    assert "btn-donate-sc" in index_html, "Must have SuttaCentral donation button"
    assert "https://suttacentral.net/donate-now?lang=en" in index_html, "Must have exact SuttaCentral donation URL"
    assert "btn-donate-sc" in index_html.split("dana-sc-card")[1].split("podcast.bswa.org")[0], "Must place SuttaCentral donation button inside the SuttaCentral dana card"
    assert ".dana-sc-card" in style_css, "Must style dana-sc-card in style.css"
    assert ".btn-donate-sc" in style_css, "Must style btn-donate-sc in style.css"
    assert index_html.find("The Audio Heritage &amp; Mission") < index_html.find("about-dana-card") < index_html.find("about-features-grid"), "Dana card must appear after intro mission and before features grid"


def test_atomic_database_update_and_hot_swap_integrity():
    """
    Verifies that:
    1. db_worker.js implements non-blocking fast startup from cached IndexedDB snapshot.
    2. Background updates are atomic: new databases are verified with SQLite magic header
       and test deserialization before modifying IndexedDB or the active in-memory connection.
    3. If background download or verification fails, active cached DB remains 100% functional.
    4. Successful background updates trigger seamless in-memory hot-swap and post 'db_hot_swapped'.
    5. db_client.js and app.js handle 'db_hot_swapped' to refresh UI without page reload.
    6. svc_worker.js does not cache dhamma_web.db in CORE_ASSETS and treats .db as network-first.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    static_dir = PROJECT_ROOT / "deeper_dhamma" / "web" / "static"
    worker_js = (static_dir / "db_worker.js").read_text(encoding="utf-8")
    client_js = (static_dir / "db_client.js").read_text(encoding="utf-8")
    adapter_js = (static_dir / "adapters" / "wasm_client.js").read_text(encoding="utf-8")
    app_js = (static_dir / "app.js").read_text(encoding="utf-8")
    sw_js = (static_dir / "svc_worker.js").read_text(encoding="utf-8")

    # 1. Non-blocking fast startup and background check
    assert "deserializeAndAttachDb" in worker_js
    assert "checkAndUpdateInBackground" in worker_js
    assert "hasValidCache" in worker_js

    # 2. Atomic integrity validation before writing to cache
    assert "SQLite format 3" in worker_js, "Must validate SQLite magic header before caching"
    assert "sqlite3_deserialize" in worker_js
    assert "candidateDb" in worker_js, "Must test candidate DB in isolated instance before hot-swap"
    assert "setCachedDatabase" in worker_js

    # 3. Seamless hot-swap event emission
    assert "db_hot_swapped" in worker_js
    assert "db_hot_swapped" in client_js
    assert "db_hot_swapped" in adapter_js
    assert "onHotSwap" in client_js
    assert "dbService.onHotSwap" in app_js

    # 4. Service Worker isolation (no double-caching, network-first for DB)
    assert "'./dhamma_web.db'" not in sw_js, "dhamma_web.db must not be in CORE_ASSETS"
    assert "isDbFetch" in sw_js, "svc_worker.js must provide network-first bypass for DB downloads"


def test_static_preview_handler_db_range_and_atomic_headers():
    """
    Verifies that StaticPreviewHandler serves sharded .db.gz payloads with accurate
    Content-Range, Content-Length, and binary Content-Type without transparent gzip stripping.
    """
    import gzip
    import http.server
    import json
    import threading
    import urllib.request
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    manifest_path = DIST_DIR / "db_manifest.json"
    core_gz_path = DIST_DIR / "core.db.gz"
    if not manifest_path.exists() or not core_gz_path.exists():
        pytest.skip("Sharded bundle not yet compiled in dist/")

    expected_size = core_gz_path.stat().st_size

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: StaticPreviewHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        # 1. Range probe bytes=0-99
        req_probe = urllib.request.Request(
            f"http://127.0.0.1:{port}/core.db.gz",
            headers={"Range": "bytes=0-99"},
        )
        with urllib.request.urlopen(req_probe) as resp:
            assert resp.status == 206
            cr = resp.headers.get("Content-Range")
            assert cr == f"bytes 0-99/{expected_size}"
            header_bytes = resp.read()
            assert len(header_bytes) == 100
            assert header_bytes[:2] == b"\x1f\x8b"

        # 2. Full fetch + gzip decompression verification
        req_full = urllib.request.Request(f"http://127.0.0.1:{port}/core.db.gz")
        with urllib.request.urlopen(req_full) as resp:
            assert resp.status == 200
            assert resp.headers.get("Content-Type") == "application/octet-stream"
            cl = int(resp.headers.get("Content-Length", 0))
            assert cl == expected_size
            raw_gz = resp.read()
            raw_sqlite = gzip.decompress(raw_gz)
            assert raw_sqlite.startswith(b"SQLite format 3\x00")

        # 3. Manifest JSON fetch
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/db_manifest.json") as resp:
            assert resp.status == 200
            manifest = json.loads(resp.read().decode("utf-8"))
            assert manifest["format"] == "sharded_v1"
    finally:
        server.shutdown()
        server.server_close()


def test_compile_sharded_static_databases_and_pwa_assets(tmp_path: Path, capsys):
    """
    Verifies sharded PWA compilation produces <100MB shards cleanly matching source data,
    emits stage progress bars, removes stale monolithic dhamma_web.db, and ships PNG icons.
    """
    import gzip
    import json
    from deeper_dhamma.config import PROJECT_ROOT
    from deeper_dhamma.export_web import compile_sharded_static_databases

    if not (TRANSCRIPTS_DB_PATH.exists() and BUDDHISM_LEXICON_DB_PATH.exists()):
        pytest.skip("Source databases not present")

    # Pre-create stale monolithic db to verify cleanup
    (tmp_path / "dhamma_web.db").write_bytes(b"stale")
    res = compile_sharded_static_databases(tmp_path, version_int=20261115, show_progress=True)
    captured = capsys.readouterr().out
    assert "Building core.db & importing Pali lexicon" in captured
    assert "Indexing search_vocab" in captured
    assert "Sharded bundle ready" in captured
    assert not any(p.name.startswith(".build_stage") for p in tmp_path.iterdir())
    manifest = res["manifest"]

    assert manifest["format"] == "sharded_v1"
    assert not (tmp_path / "dhamma_web.db").exists()
    assert (tmp_path / "db_manifest.json").exists()
    assert len(manifest["talks"]) == 4
    assert len(manifest["words"]) == 4

    # Every file must stay below GitHub's 100 MB raw limit, and every compressed shard strictly below GitHub's 50 MB warning threshold
    max_raw = max(
        [manifest["core"]["raw_bytes"]]
        + [s["raw_bytes"] for s in manifest["talks"]]
        + [s["raw_bytes"] for s in manifest["words"]]
    )
    max_gz = max(
        [manifest["core"]["gz_bytes"]]
        + [s["gz_bytes"] for s in manifest["talks"]]
        + [s["gz_bytes"] for s in manifest["words"]]
    )
    assert max_raw < 100 * 1024 * 1024, f"Raw shard exceeds 100 MB: {max_raw}"
    assert max_gz < 50 * 1024 * 1024, f"Gzipped shard exceeds 50 MB GitHub warning limit: {max_gz}"

    # Verify pb28113880 routing from core -> talks & words shards
    core_p = tmp_path / "verify_core.db"
    core_p.write_bytes(gzip.decompress((tmp_path / manifest["core"]["file"]).read_bytes()))
    c_conn = sqlite3.connect(core_p)
    try:
        row = c_conn.execute("SELECT talks_shard, words_shard FROM episodes WHERE id = 'pb28113880';").fetchone()
        assert row is not None and row[0] in (1, 2, 3, 4) and row[1] in (1, 2, 3, 4)
        talks_p = tmp_path / "verify_talks.db"
        talks_p.write_bytes(gzip.decompress((tmp_path / f"talks_{row[0]}.db.gz").read_bytes()))
        words_p = tmp_path / "verify_words.db"
        words_p.write_bytes(gzip.decompress((tmp_path / f"words_{row[1]}.db.gz").read_bytes()))
    finally:
        c_conn.close()

    t_conn = sqlite3.connect(talks_p)
    w_conn = sqlite3.connect(words_p)
    try:
        seg_cnt = t_conn.execute("SELECT COUNT(*) FROM speech_segments WHERE episode_id = 'pb28113880';").fetchone()[0]
        assert seg_cnt > 0
        fts_hit = t_conn.execute(
            "SELECT COUNT(*) FROM transcripts_fts WHERE transcripts_fts MATCH 'meditation';"
        ).fetchone()[0]
        assert fts_hit >= 0
        wb = w_conn.execute("SELECT words_blob FROM episode_words WHERE episode_id = 'pb28113880';").fetchone()
        assert wb is not None and len(wb[0]) > 4
    finally:
        t_conn.close()
        w_conn.close()

    # Verify PWA manifest PNG icons and long DB timeout in service worker
    static_dir = PROJECT_ROOT / "deeper_dhamma" / "web" / "static"
    pwa_manifest = json.loads((static_dir / "manifest.json").read_text(encoding="utf-8"))
    sizes = {icon.get("sizes"): icon.get("src") for icon in pwa_manifest.get("icons", [])}
    assert "192x192" in sizes and "512x512" in sizes
    assert (static_dir / "icons" / "app_icon.svg").exists()
    assert (static_dir / "icons" / "pwa_icon_192.png").exists()
    assert (static_dir / "icons" / "pwa_icon_512.png").exists()
    assert (static_dir / "icons" / "ios_apple_touch_icon.png").exists()
    sw_text = (static_dir / "svc_worker.js").read_text(encoding="utf-8")
    assert "timeoutMs = isFullDb ? 300000" in sw_text


def test_headless_chrome_sharded_pwa_worker_end_to_end():
    """
    Runs real db_worker.js inside headless Google Chrome against dist/ over HTTP,
    verifying gzip decompression, OPFS/IDB shard loading, merged FTS search,
    episode segment loading, and binary words_blob playback retrieval.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists():
        pytest.skip("Sharded bundle not compiled in dist/")

    report = {}

    class WorkerE2EHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__e2e_report":
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length)
                report.update(json.loads(payload.decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__e2e_harness.html":
                html = b"""<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
                (async () => {
                  const res = {};
                  try {
                    const worker = new Worker('./db_worker.js');
                    let seq = 0;
                    const pending = new Map();
                    const syncEvents = [];
                    worker.onmessage = (e) => {
                      const { id, success, data, error, type } = e.data || {};
                      if (type === 'db_sync_progress') {
                        syncEvents.push(data);
                        return;
                      }
                      if (pending.has(id)) {
                        const p = pending.get(id);
                        pending.delete(id);
                        if (success) p.resolve(data);
                        else p.reject(new Error(error || 'worker error'));
                      }
                    };
                    function call(type, payload) {
                      const id = ++seq;
                      return new Promise((resolve, reject) => {
                        pending.set(id, { resolve, reject });
                        worker.postMessage({ id, type, payload });
                      });
                    }
                    res.init = await call('init', { manifestUrl: './db_manifest.json' });
                    res.stats = await call('get_stats');
                    res.search = await call('search', { query: 'breath', limit: 20 });
                    res.episode = await call('get_episode', { episodeId: 'pb28113880' });
                    res.words = await call('get_episode_words', { episodeId: 'pb28113880' });
                    res.wordsByteLen = res.words ? res.words.byteLength : 0;
                    res.segCount = res.episode && res.episode.segments ? res.episode.segments.length : 0;
                    res.searchCount = res.search && res.search.results ? res.search.results.length : 0;
                    res.syncEventCount = syncEvents.length;
                    delete res.words;
                    delete res.episode;
                    delete res.search;
                    res.ok = true;
                  } catch (err) {
                    res.ok = false;
                    res.error = err && err.message ? err.message : String(err);
                  }
                  await fetch('/__e2e_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(res),
                  });
                })();
                </script></body></html>"""
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html)))
                self.end_headers()
                self.wfile.write(html)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: WorkerE2EHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/__e2e_harness.html",
            ]
            proc = subprocess.Popen(cmd)
            try:
                # Poll cleanly up to 30s until browser reports completion
                import time
                deadline = time.time() + 45.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"Chrome E2E failed: {report}"
        assert report["init"]["sharded"] is True
        assert report["stats"]["transcribed_episodes"] >= 2500
        assert report["searchCount"] > 0
        assert report["segCount"] > 0
        assert report["wordsByteLen"] > 100
    finally:
        server.shutdown()
        server.server_close()












def test_compile_sharded_atomic_staging_preserves_prior_bundle_on_interrupt(tmp_path: Path, monkeypatch):
    """If web compilation is interrupted mid-build, existing dist/ artifacts must remain untouched."""
    from deeper_dhamma.export_web import compile_sharded_static_databases
    from deeper_dhamma.storage import TranscriptDatabase

    if not BUDDHISM_LEXICON_DB_PATH.exists():
        pytest.skip("Lexicon database not present")

    src_db_path = tmp_path / "tiny_transcripts.db"
    tdb = TranscriptDatabase(db_path=src_db_path, pipeline_db_path=tmp_path / "tiny_pipe.db")
    tdb.save_episode(
        episode_metadata={"id": "pb1", "title": "Tiny Talk", "primary_teacher": "ajahn_brahm", "upload_date": "20200101", "media_url": "https://example.com/1.mp3"},
        attributed_segments=[{"start": 0.0, "end": 1.0, "speaker_slug": "ajahn_brahm", "speaker_display": "Ajahn Brahm", "text": "Namo Buddhaya."}],
        duration_sec=10.0,
        year="2020",
        filename_stem="tiny",
    )

    out_dir = tmp_path / "dist"
    out_dir.mkdir()
    prior_manifest = out_dir / "db_manifest.json"
    prior_core = out_dir / "core.db.gz"
    prior_manifest.write_text('{"version": 1}', encoding="utf-8")
    prior_core.write_bytes(b"prior-core-gz")

    import deeper_dhamma.export_web as ew
    calls = {"n": 0}
    real_compress = ew._compress_db_gzip

    def _interrupt_on_second(raw_p, gz_p):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise KeyboardInterrupt("simulated Ctrl+C")
        return real_compress(raw_p, gz_p)

    monkeypatch.setattr(ew, "_compress_db_gzip", _interrupt_on_second)
    with pytest.raises(KeyboardInterrupt):
        compile_sharded_static_databases(out_dir, version_int=20261116, transcripts_db_path=src_db_path, show_progress=False)

    assert prior_manifest.read_text(encoding="utf-8") == '{"version": 1}'
    assert prior_core.read_bytes() == b"prior-core-gz"
    assert not any(p.name.startswith(".build_stage") for p in out_dir.iterdir())


def test_search_stopword_filtering_and_pagination_ui():
    """Verifies 50-per-page search pagination controls and stopword suppression across web assets."""
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    search_view_js = (web_dir / "static" / "search_view.js").read_text(encoding="utf-8")
    worker_js = (web_dir / "static" / "db_worker.js").read_text(encoding="utf-8")
    style_css = _read_all_style_css(web_dir)

    for dom_id in (
        'id="search-pagination"',
        'id="btn-search-first"',
        'id="btn-search-prev"',
        'id="btn-search-next"',
        'id="btn-search-last"',
        'id="search-page-indicator"',
    ):
        assert dom_id in index_html, f"Missing {dom_id} in index.html"

    assert ".search-pagination" in style_css
    assert "APP_SEARCH_STOPWORDS" in search_view_js
    assert "updateSearchPagination" in search_view_js
    assert "episodeLimit" in search_view_js
    assert "episodeLimit" in worker_js
    assert "all_episode_ids" in worker_js


def test_headless_chrome_search_pagination_and_stopword_quality():
    """
    Runs the real dist/index.html + app.js + db_worker.js in headless Google Chrome
    for 'mindfulness of breathing', verifying:
    1. Page 1 renders at most 50 result cards (50 of ~167 matching talks).
    2. Standalone stopword matches ('of', 'off', 'often') are NOT highlighted or extracted.
    3. Pagination controls appear and clicking Next 50 loads the next disjoint 50 talks.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    report = {}

    class SearchUIHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__search_ui_report":
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length)
                report.update(json.loads(payload.decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__search_ui_e2e.html":
                raw_html = (DIST_DIR / "index.html").read_text(encoding="utf-8")
                harness_js = """
                <script>
                (async () => {
                  const res = { ok: false };
                  const waitFor = async (fn, timeoutMs = 45000) => {
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await new Promise(r => setTimeout(r, 100));
                    }
                    throw new Error('Timed out waiting for condition');
                  };
                  try {
                    if (!window.location.hash) {
                      window.location.hash = '#search?q=mindfulness%20of%20breathing';
                    }
                    await waitFor(() => document.querySelectorAll('#search-results-list .result-card').length > 0);
                    const p1Cards = Array.from(document.querySelectorAll('#search-results-list .result-card'));
                    const p1Ids = p1Cards.map(el => el.dataset.epId);
                    const p1Bold = Array.from(document.querySelectorAll('#search-results-list .sentence-context-text b'))
                      .map(el => el.textContent.trim().toLowerCase());
                    const pagEl = document.getElementById('search-pagination');
                    const pagInd1 = document.getElementById('search-page-indicator')?.textContent || '';
                    const nextBtn = document.getElementById('btn-search-next');
                    const prevBtn = document.getElementById('btn-search-prev');

                    res.p1Count = p1Cards.length;
                    res.p1Ids = p1Ids;
                    res.p1BadOfBold = p1Bold.filter(w => ['of', 'off', 'often', 'offer'].includes(w));
                    res.p1PhraseBoldCount = p1Bold.filter(w => w.includes('mindfulness of breathing')).length;
                    res.pagVisible = pagEl && getComputedStyle(pagEl).display !== 'none';
                    res.pagInd1 = pagInd1;
                    res.prevDisabled1 = prevBtn ? prevBtn.disabled : null;
                    res.nextDisabled1 = nextBtn ? nextBtn.disabled : null;

                    nextBtn.click();
                    await waitFor(() => {
                      const txt = document.getElementById('search-page-indicator')?.textContent || '';
                      return txt.includes('51') && txt !== pagInd1;
                    });
                    const p2Cards = Array.from(document.querySelectorAll('#search-results-list .result-card'));
                    const p2Ids = p2Cards.map(el => el.dataset.epId);
                    res.p2Count = p2Cards.length;
                    res.p2Ids = p2Ids;
                    res.pagInd2 = document.getElementById('search-page-indicator')?.textContent || '';
                    res.prevDisabled2 = prevBtn ? prevBtn.disabled : null;
                    res.ok = true;
                  } catch (err) {
                    res.error = err && err.message ? err.message : String(err);
                  }
                  await fetch('/__search_ui_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(res),
                  });
                })();
                </script>
                """
                injected = raw_html.replace("</body>", harness_js + "\n</body>").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(injected)))
                self.end_headers()
                self.wfile.write(injected)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: SearchUIHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/__search_ui_e2e.html#search?q=mindfulness%20of%20breathing",
            ]
            proc = subprocess.Popen(cmd)
            try:
                deadline = time.time() + 75.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"Search UI E2E failed: {report}"
        assert 1 <= report["p1Count"] <= 50
        assert report["p1Count"] == 50
        assert report["p1BadOfBold"] == [], f"Unexpected standalone 'of' highlights: {report['p1BadOfBold']}"
        assert report["p1PhraseBoldCount"] > 0
        assert report["pagVisible"] is True
        assert "1–50" in report["pagInd1"]
        assert report["prevDisabled1"] is True
        assert report["nextDisabled1"] is False

        assert 1 <= report["p2Count"] <= 50
        assert "51–" in report["pagInd2"]
        assert report["prevDisabled2"] is False
        assert set(report["p1Ids"]).isdisjoint(set(report["p2Ids"])), "Page 2 results must not overlap Page 1"
    finally:
        server.shutdown()
        server.server_close()


def test_headless_chrome_search_jump_to_exact_phrase_location():
    """
    Verifies that clicking search results for 'mindfullness of breathing' across multiple
    consecutive talks always:
    1. Resolves the exact target word timestamp (never stale turnWordMap from a prior talk).
    2. Highlights the matched word inside the target sentence.
    3. Scrolls the matched word/sentence inside the unobstructed reading area between the
       sticky transcript toolbar and the bottom audio player bar.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    report = {}

    class JumpUIHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__jump_ui_report":
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length)
                report.update(json.loads(payload.decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__jump_ui_e2e.html":
                raw_html = (DIST_DIR / "index.html").read_text(encoding="utf-8")
                harness_js = """
                <script>
                (async () => {
                  const res = { ok: false, jumps: [] };
                  const wait = ms => new Promise(r => setTimeout(r, ms));
                  const waitFor = async (fn, timeoutMs = 45000) => {
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await wait(80);
                    }
                    throw new Error('Timed out waiting for jump UI condition');
                  };
                  try {
                    HTMLMediaElement.prototype.play = function() { return Promise.resolve(); };
                    let lastSeekCall = null;
                    if (window.WordSync && typeof window.WordSync.prepareSeek === 'function') {
                      const origPrepareSeek = window.WordSync.prepareSeek.bind(window.WordSync);
                      window.WordSync.prepareSeek = function(physSec, wordStartSec) {
                        lastSeekCall = { epId: window.WordSync.currentEpisodeId, physSec, wordStartSec };
                        return origPrepareSeek(physSec, wordStartSec);
                      };
                    }
                    await waitFor(() => document.querySelectorAll('#search-results-list .sentence-match-row').length > 0);
                    const allRows = Array.from(document.querySelectorAll('#search-results-list .sentence-match-row'));
                    const seenEps = new Set();
                    const picked = [];
                    for (const r of allRows) {
                      if (!seenEps.has(r.dataset.epId)) {
                        seenEps.add(r.dataset.epId);
                        picked.push({
                          epId: r.dataset.epId,
                          turnIdx: Number(r.dataset.turnIdx),
                          wordOff: Number(r.dataset.wordOffset),
                        });
                        if (picked.length >= 8) break;
                      }
                    }

                    for (const p of picked) {
                      lastSeekCall = null;
                      document.getElementById('tab-search-btn').click();
                      await wait(60);
                      const rowEl = document.querySelector(
                        `.sentence-match-row[data-ep-id="${p.epId}"][data-turn-idx="${p.turnIdx}"][data-word-offset="${p.wordOff}"]`
                      );
                      rowEl.click();
                      await waitFor(() =>
                        window.WordSync &&
                        window.WordSync.currentEpisodeId === p.epId &&
                        window.WordSync.turnWordMap &&
                        window.WordSync.turnWordMap[p.turnIdx] &&
                        document.querySelector('#drawer-turns-container .active-word')
                      );
                      await wait(250);

                      const activeWord = document.querySelector('#drawer-turns-container .active-word');
                      const flashedSent = document.querySelector('#drawer-turns-container .target-sentence-flash');
                      const turnWords = (window.WordSync && window.WordSync.turnWordMap && window.WordSync.turnWordMap[p.turnIdx]) || [];
                      const realWord = turnWords[p.wordOff] || null;
                      const toolbar = document.getElementById('transcript-sticky-toolbar');
                      const toolbarBottom = toolbar ? Math.max(0, toolbar.getBoundingClientRect().bottom) : 0;
                      const playerBar = document.getElementById('audio-player-bar');
                      const playerTop = playerBar ? Math.min(window.innerHeight, playerBar.getBoundingClientRect().top) : window.innerHeight;
                      const targetEl = activeWord || flashedSent;
                      const rect = targetEl ? targetEl.getBoundingClientRect() : null;
                      const recordedSeek = (lastSeekCall && lastSeekCall.epId === p.epId)
                        ? lastSeekCall.wordStartSec
                        : (window.WordSync ? window.WordSync._seekTargetWordTime : null);

                      res.jumps.push({
                        epId: p.epId,
                        turnIdx: p.turnIdx,
                        wordOff: p.wordOff,
                        hasActiveWord: Boolean(activeWord),
                        activeWordText: activeWord ? activeWord.textContent.trim().toLowerCase() : '',
                        hasFlashedSent: Boolean(flashedSent),
                        sentContainsPhrase: flashedSent ? flashedSent.textContent.toLowerCase().includes('mindfulness of breathing') : false,
                        realWordTime: realWord ? realWord.s : null,
                        seekTargetTime: recordedSeek,
                        rectTop: rect ? Math.round(rect.top) : null,
                        rectBottom: rect ? Math.round(rect.bottom) : null,
                        toolbarBottom: Math.round(toolbarBottom),
                        playerTop: Math.round(playerTop),
                      });
                    }
                    res.ok = true;
                  } catch (err) {
                    res.error = err && err.message ? err.message : String(err);
                  }
                  await fetch('/__jump_ui_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(res),
                  });
                })();
                </script>
                """
                injected = raw_html.replace("</body>", harness_js + "\n</body>").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(injected)))
                self.end_headers()
                self.wfile.write(injected)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: JumpUIHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/__jump_ui_e2e.html#search?q=mindfullness%20of%20breathing",
            ]
            proc = subprocess.Popen(cmd)
            try:
                deadline = time.time() + 75.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"Jump UI E2E failed: {report}"
        assert len(report["jumps"]) == 8
        for j in report["jumps"]:
            assert j["hasFlashedSent"] is True, f"Missing flashed sentence for {j}"
            assert j["sentContainsPhrase"] is True, f"Target sentence missing phrase for {j}"
            assert j["hasActiveWord"] is True, f"Missing active word for {j}"
            assert "mindful" in j["activeWordText"], f"Wrong active word '{j['activeWordText']}' for {j}"
            assert j["rectTop"] >= j["toolbarBottom"] - 2, f"Occluded by sticky toolbar: {j}"
            assert j["rectBottom"] <= j["playerTop"] + 2, f"Occluded by player bar: {j}"
            if j["realWordTime"] is not None and j["realWordTime"] > 0:
                assert j["seekTargetTime"] is not None, f"Seek target missing for {j}"
                assert abs(j["seekTargetTime"] - j["realWordTime"]) < 0.2, (
                    f"Seek target {j['seekTargetTime']} != realWordTime {j['realWordTime']} for {j}"
                )
    finally:
        server.shutdown()
        server.server_close()


def test_archive_notes_view_and_transcribed_only_ui_cleanup():
    """
    Verifies:
    1. Browse Talks and sidebar stats no longer imply untranscribed talks exist
       (no #browse-transcribed-only-btn, no 'Toggle off \"Transcribed Only\"',
        no 'audio talks' suffix on #stat-episodes).
    2. Archive Notes view (#notes-view), sidebar button (#tab-notes-btn), routing ('notes'),
       and About cross-link (#btn-about-archive-notes) are properly wired.
    3. Archive Notes compiles the full catalog reconciliation and pipeline documentation.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    app_js = (web_dir / "static" / "app.js").read_text(encoding="utf-8")
    all_app_js = _read_all_app_js(web_dir)
    style_css = _read_all_style_css(web_dir)

    # 1. No misleading untranscribed-talks WUI controls or redundant transcribed pills
    assert 'id="browse-transcribed-only-btn"' not in index_html
    assert "Toggle off \"Transcribed Only\"" not in all_app_js
    assert "Show All Audio Talks" not in all_app_js
    assert "audio talks`" not in all_app_js
    assert "transcribed-pill" not in all_app_js
    assert "transcribedOnly: true" in all_app_js

    # 2. Archive Notes navigation, view, and routing
    assert 'id="tab-notes-btn"' in index_html
    assert 'data-tab="notes-view"' in index_html
    assert 'id="notes-view"' in index_html
    assert 'id="btn-about-archive-notes"' in index_html
    assert "tabNotesBtn: document.getElementById('tab-notes-btn')" in app_js
    assert "notesView: document.getElementById('notes-view')" in app_js
    assert "case 'notes':" in app_js
    assert "'notes-view': 'notes'" in app_js
    assert ".notes-table" in style_css
    assert ".notes-diagram-card" in style_css
    assert ".notes-diagram-svg" in style_css

    # 3. Plain-language reconciliation & process details via SVG (no internal file/symbol names or static distribution section)
    notes_html = index_html.split('id="notes-view"')[1].split('id="transcript-view"')[0]
    assert "```mermaid" not in notes_html.lower()
    assert "notes-ascii-diagram" not in notes_html
    assert "notes-diagram-svg--desktop" in notes_html
    assert "notes-diagram-svg--mobile" in notes_html
    assert "<svg" in notes_html
    for forbidden in (
        "pipeline_state.db",
        "TranscriptPostProcessor",
        "catalog.json",
        "core.db.gz",
        "voiceprints.db",
        "archive.log",
        "archive/",
        "is_english_talk",
        "Static Distribution",
        "Silent retreat",
        "Non-Speech Recording",
    ):
        assert forbidden not in notes_html, f"Found internal/removed term '{forbidden}' in Archive Notes"
    for token in (
        "3,323",
        "2,971",
        "-279",
        "72",
        "272",
        "1994",
        "2012 April | 9 Day Retreat - 20",
        "2012 January Retreat - 18 Metta Chanting",
        "2009 November Retreat - Chanting",
        "2016 March | 02. Weekend Meditation Retreat",
        "raw speech segments are preserved",
        "no spoken segments",
    ):
        assert token in notes_html, f"Missing '{token}' in Archive Notes view"


def test_compile_sharded_excludes_zero_segment_transcribed_rows(tmp_path: Path):
    """Static sharded export must exclude any is_transcribed=1 episode that has zero speech segments."""
    from deeper_dhamma.export_web import compile_sharded_static_databases
    from deeper_dhamma.storage import TranscriptDatabase

    if not BUDDHISM_LEXICON_DB_PATH.exists():
        pytest.skip("Lexicon database not present")

    src_db_path = tmp_path / "filter_transcripts.db"
    tdb = TranscriptDatabase(db_path=src_db_path, pipeline_db_path=tmp_path / "filter_pipe.db")
    tdb.save_episode(
        episode_metadata={"id": "pb_spoken", "title": "Spoken Talk", "primary_teacher": "ajahn_brahm", "upload_date": "20200101", "media_url": "https://example.com/1.mp3"},
        attributed_segments=[{"start": 0.0, "end": 1.0, "speaker_slug": "ajahn_brahm", "speaker_display": "Ajahn Brahm", "text": "Namo Buddhaya."}],
        duration_sec=10.0,
        year="2020",
        filename_stem="spoken",
    )
    tdb.save_episode(
        episode_metadata={"id": "pb_empty", "title": "Group Chanting", "primary_teacher": "ajahn_brahm", "upload_date": "20200102", "media_url": "https://example.com/2.mp3"},
        attributed_segments=[],
        duration_sec=10.0,
        year="2020",
        filename_stem="empty",
    )

    out_dir = tmp_path / "dist"
    res = compile_sharded_static_databases(out_dir, version_int=20261116, transcripts_db_path=src_db_path, show_progress=False)
    manifest = res["manifest"]
    assert manifest["episodes"] == 1
    assert manifest["transcribed_episodes"] == 1


def test_headless_chrome_archive_notes_and_browse_count_parity():
    """
    Runs the compiled dist/index.html in headless Chrome to verify:
    1. #stat-episodes reports transcribed talks without implying missing audio talks.
    2. #browse-count-badge equals the transcribed episodes count (e.g. 2972).
    3. Navigating to #notes activates #notes-view and hydrates live bundle metrics.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    report = {}

    class NotesUIHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__notes_ui_report":
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length)
                report.update(json.loads(payload.decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__notes_ui_e2e.html":
                raw_html = (DIST_DIR / "index.html").read_text(encoding="utf-8")
                harness_js = """
                <script>
                (async () => {
                  const res = { ok: false };
                  const waitFor = async (fn, timeoutMs = 45000) => {
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await new Promise(r => setTimeout(r, 80));
                    }
                    throw new Error('Timed out waiting for Archive Notes UI condition');
                  };
                  try {
                    await waitFor(() => {
                      const b = document.getElementById('browse-count-badge')?.textContent?.trim();
                      const s = document.getElementById('stat-episodes')?.textContent?.trim();
                      const cards = document.querySelectorAll('#browse-episodes-grid .episode-card').length;
                      return b && b !== '0' && s && !s.includes('Loading') && cards > 0;
                    });
                    res.statText = document.getElementById('stat-episodes').textContent.trim();
                    res.browseBadge = document.getElementById('browse-count-badge').textContent.trim();
                    res.hasBrowseToggle = Boolean(document.getElementById('browse-transcribed-only-btn'));
                    res.browseCardCount = document.querySelectorAll('#browse-episodes-grid .episode-card').length;
                    res.transcribedPillCount = document.querySelectorAll('#browse-episodes-grid .transcribed-pill, #browse-episodes-grid .status-pill').length;
                    res.transcriptBtnCount = document.querySelectorAll('#browse-episodes-grid .episode-card button[data-action="view-transcript"]').length;

                    document.getElementById('tab-notes-btn').click();
                    await waitFor(() => document.getElementById('notes-view')?.classList.contains('active'));
                    res.hashAfterNotes = window.location.hash;
                    res.notesTranscribed = document.getElementById('notes-tbl-transcribed')?.textContent?.trim();
                    res.notesSvgTranscribed = document.getElementById('notes-svg-transcribed')?.textContent?.trim();
                    const svgRect = document.querySelector('#notes-view svg.notes-diagram-svg')?.getBoundingClientRect();
                    res.svgWidth = svgRect ? Math.round(svgRect.width) : 0;
                    res.svgHeight = svgRect ? Math.round(svgRect.height) : 0;
                    res.notesTableRows = document.querySelectorAll('#notes-view .notes-table tbody tr').length;
                    res.ok = true;
                  } catch (err) {
                    res.error = err && err.message ? err.message : String(err);
                  }
                  await fetch('/__notes_ui_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(res),
                  });
                })();
                </script>
                """
                injected = raw_html.replace("</body>", harness_js + "\n</body>").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(injected)))
                self.end_headers()
                self.wfile.write(injected)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: NotesUIHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/__notes_ui_e2e.html",
            ]
            proc = subprocess.Popen(cmd)
            try:
                deadline = time.time() + 45.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        manifest = json.loads((DIST_DIR / "db_manifest.json").read_text(encoding="utf-8"))
        expected_trans = str(manifest["transcribed_episodes"])

        assert report.get("ok") is True, f"Notes UI E2E failed: {report}"
        assert report["hasBrowseToggle"] is False
        assert report["browseCardCount"] > 0
        assert report["transcribedPillCount"] == 0
        assert report["transcriptBtnCount"] == report["browseCardCount"]
        assert report["browseBadge"] == expected_trans
        assert "audio talks" not in report["statText"]
        assert f"{int(expected_trans):,} transcribed talks" in report["statText"]
        assert report["hashAfterNotes"] == "#notes"
        assert report["notesTranscribed"] == f"{int(expected_trans):,}"
        assert report["notesSvgTranscribed"] == f"{int(expected_trans):,}"
        assert report["svgWidth"] > 400 and report["svgHeight"] > 200
        assert report["notesTableRows"] == 8
    finally:
        server.shutdown()
        server.server_close()


def test_browse_multi_faceted_filtering_contract():
    """Verifies DOM controls, CSS, and worker handlers for multi-faceted Browse filtering."""
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    all_app_js = _read_all_app_js(web_dir)
    worker_js = (web_dir / "static" / "db_worker.js").read_text(encoding="utf-8")
    style_css = _read_all_style_css(web_dir)

    for dom_id in (
        'id="browse-title-input"',
        'id="browse-title-word-checkbox"',
        'id="browse-teachers-dropdown"',
        'id="btn-teacher-mode-any"',
        'id="btn-teacher-mode-all"',
        'id="browse-teachers-list"',
        'id="browse-years-dropdown"',
        'id="browse-era-presets"',
        'id="browse-years-grid"',
        'id="browse-year-from"',
        'id="browse-year-to"',
        'id="browse-duration-dropdown"',
        'id="browse-duration-buckets"',
        'id="browse-min-duration"',
        'id="browse-max-duration"',
        'id="browse-category-dropdown"',
        'id="browse-collections-list"',
        'id="browse-formats-list"',
        'id="browse-cotaught-checkbox"',
        'id="browse-bookmarked-checkbox"',
        'id="browse-sort-select"',
        'id="browse-reset-filters-btn"',
        'id="browse-active-chips"',
        'id="browse-filtered-archive-dropdown-wrapper"',
    ):
        assert dom_id in index_html, f"Missing {dom_id} in index.html"

    for css_sel in (".browse-filter-panel", ".browse-popover-panel", ".year-chip-grid", ".browse-filter-chip", ".title-match-mark"):
        assert css_sel in style_css, f"Missing {css_sel} in style.css"

    for js_sym in ("setupBrowseFilterListeners", "buildBrowseQueryOpts", "buildBrowseRouteHash", "highlightTitleText", "downloadBrowseFilteredArchive"):
        assert js_sym in all_app_js, f"Missing {js_sym} in frontend modules"

    for worker_sym in ("matchesTitleQuery", "classifyEpisodeCategories", "resolveTeacherToSlug", "browse_teachers", "year_counts", "duration_counts", "category_counts"):
        assert worker_sym in worker_js, f"Missing {worker_sym} in db_worker.js"


def test_headless_chrome_browse_multi_faceted_filtering_e2e():
    """
    Exercises all Browse View filtering features inside headless Google Chrome against dist/:
    1. Multi-monastic selection (Any/OR vs All/AND co-taught) without Ajahn Brahm/Brahmali collision.
    2. Groupable years (arbitrary multi-year selection & era presets).
    3. Title text filter ("MN", diacritic-folded "dhatu", and Whole Word "AN" without matching "Ajahn").
    4. Talk length / duration buckets and custom min-max minute bounds.
    5. Collection/format filters, sorting, active chip removal, URL hash sync, and Reset.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    report = {}

    class BrowseUIHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__browse_ui_report":
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length)
                report.update(json.loads(payload.decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__browse_ui_e2e.html":
                raw_html = (DIST_DIR / "index.html").read_text(encoding="utf-8")
                harness_js = r"""
                <script>
                (async () => {
                  const res = { ok: false };
                  const wait = ms => new Promise(r => setTimeout(r, ms));
                  const waitFor = async (fn, timeoutMs = 45000) => {
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await wait(60);
                    }
                    throw new Error('Timed out waiting for Browse UI condition');
                  };
                  const getBrowseCount = () => parseInt(document.getElementById('browse-count-badge')?.textContent?.trim() || '0', 10);
                  try {
                    await waitFor(() => {
                      const b = getBrowseCount();
                      const cards = document.querySelectorAll('#browse-episodes-grid .episode-card').length;
                      const teachers = document.querySelectorAll('#browse-teachers-list input[data-teacher-slug]').length;
                      return b > 2000 && cards > 0 && teachers > 5;
                    });
                    res.initialTotal = getBrowseCount();

                    // Navigate to Browse tab
                    document.getElementById('tab-browse-btn').click();
                    await waitFor(() => document.getElementById('browse-view')?.classList.contains('active'));

                    // 1. Single monastic: Ajahn Brahm (must NOT collide with Ajahn Brahmali)
                    const brahmCb = document.querySelector('#browse-teachers-list input[data-teacher-slug="ajahn_brahm"]');
                    const brahmaliCb = document.querySelector('#browse-teachers-list input[data-teacher-slug="ajahn_brahmali"]');
                    brahmCb.click();
                    await waitFor(() => getBrowseCount() < res.initialTotal && getBrowseCount() > 1000);
                    res.brahmOnlyCount = getBrowseCount();

                    // 2. Multi-monastic Any (OR): Ajahn Brahm + Ajahn Brahmali
                    brahmaliCb.click();
                    await waitFor(() => getBrowseCount() > res.brahmOnlyCount);
                    res.brahmOrBrahmaliCount = getBrowseCount();

                    // 3. Multi-monastic All (AND): Co-taught talks with BOTH Ajahn Brahm AND Ajahn Brahmali
                    document.getElementById('btn-teacher-mode-all').click();
                    await waitFor(() => getBrowseCount() > 0 && getBrowseCount() < 50);
                    res.brahmAndBrahmaliCount = getBrowseCount();
                    res.brahmAndBrahmaliHash = window.location.hash;
                    res.andCardBadges = Array.from(document.querySelectorAll('#browse-episodes-grid .episode-card')).map(card =>
                      Array.from(card.querySelectorAll('.teacher-badge')).map(b => b.textContent.trim())
                    );

                    // Reset
                    document.getElementById('browse-reset-filters-btn').click();
                    await waitFor(() => getBrowseCount() === res.initialTotal);

                    // 4. Groupable years: 1997 + 2001
                    const y1997Btn = document.querySelector('#browse-years-grid .year-chip-btn[data-year="1997"]');
                    const y2001Btn = document.querySelector('#browse-years-grid .year-chip-btn[data-year="2001"]');
                    y1997Btn.click();
                    await waitFor(() => getBrowseCount() > 0 && getBrowseCount() < 200);
                    const c1997 = getBrowseCount();
                    y2001Btn.click();
                    await waitFor(() => getBrowseCount() > c1997);
                    res.y1997Count = c1997;
                    res.y1997And2001Count = getBrowseCount();

                    // Also verify 1990s era preset & chip removal
                    const era1990sBtn = document.querySelector('#browse-era-presets .era-preset-btn[data-era="1990s"]');
                    era1990sBtn.click();
                    await waitFor(() => getBrowseCount() > res.y1997And2001Count);
                    res.with1990sCount = getBrowseCount();

                    // Reset
                    document.getElementById('browse-reset-filters-btn').click();
                    await waitFor(() => getBrowseCount() === res.initialTotal);

                    // 5. Title filter: "MN" + Whole Word "AN" + diacritic folding "dhatu"
                    const titleInput = document.getElementById('browse-title-input');
                    const wordCb = document.getElementById('browse-title-word-checkbox');
                    const setInput = (el, val) => {
                      el.value = val;
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                    };
                    setInput(titleInput, 'MN');
                    await waitFor(() => getBrowseCount() > 100 && getBrowseCount() < 300);
                    res.mnTitleCount = getBrowseCount();
                    res.mnHighlightCount = document.querySelectorAll('#browse-episodes-grid .title-match-mark').length;

                    // Test "AN" substring vs Whole Word
                    setInput(titleInput, 'AN');
                    await waitFor(() => getBrowseCount() > 500);
                    res.anSubstrCount = getBrowseCount();
                    wordCb.click();
                    await waitFor(() => getBrowseCount() > 20 && getBrowseCount() < 100);
                    res.anWholeWordCount = getBrowseCount();
                    res.anSampleTitles = Array.from(document.querySelectorAll('#browse-episodes-grid .episode-title')).slice(0, 10).map(e => e.textContent.trim());

                    // Reset and test diacritic folding "dhatu"
                    document.getElementById('browse-reset-filters-btn').click();
                    await waitFor(() => getBrowseCount() === res.initialTotal);
                    setInput(titleInput, 'dhatu');
                    await waitFor(() => getBrowseCount() > 0 && getBrowseCount() < 50);
                    res.dhatuTitles = Array.from(document.querySelectorAll('#browse-episodes-grid .episode-title')).map(e => e.textContent.trim());

                    // Reset
                    document.getElementById('browse-reset-filters-btn').click();
                    await waitFor(() => getBrowseCount() === res.initialTotal);

                    // 6. Talk length filter: under_15 bucket, then custom min=45 max=60
                    const under15Cb = document.querySelector('#browse-duration-buckets input[data-dur-bucket="under_15"]');
                    under15Cb.click();
                    await waitFor(() => getBrowseCount() > 10 && getBrowseCount() < 150);
                    res.under15Count = getBrowseCount();
                    res.under15Durs = Array.from(document.querySelectorAll('#browse-episodes-grid .episode-card')).map(card => {
                      const m = card.textContent.match(/(\d+)\s*mins/);
                      return m ? parseInt(m[1], 10) : 0;
                    });

                    const minDurInput = document.getElementById('browse-min-duration');
                    const maxDurInput = document.getElementById('browse-max-duration');
                    setInput(minDurInput, '45');
                    setInput(maxDurInput, '60');
                    await waitFor(() => getBrowseCount() > 500 && getBrowseCount() < 1500);
                    res.custom45to60Count = getBrowseCount();
                    res.customSampleDurs = Array.from(document.querySelectorAll('#browse-episodes-grid .episode-card')).slice(0, 25).map(card => {
                      const m = card.textContent.match(/(\d+)\s*mins/);
                      return m ? parseInt(m[1], 10) : 0;
                    });

                    // 7. Sort shortest first
                    const sortSel = document.getElementById('browse-sort-select');
                    sortSel.value = 'duration_asc';
                    sortSel.dispatchEvent(new Event('change', { bubbles: true }));
                    await waitFor(() => {
                      const first = document.querySelector('#browse-episodes-grid .episode-card')?.textContent?.match(/(\d+)\s*mins/);
                      return first && parseInt(first[1], 10) === 45;
                    });
                    res.sortedFirstDur = parseInt(document.querySelector('#browse-episodes-grid .episode-card').textContent.match(/(\d+)\s*mins/)[1], 10);

                    // 8. Collection filter (MN) + active chip removal
                    document.getElementById('browse-reset-filters-btn').click();
                    await waitFor(() => getBrowseCount() === res.initialTotal);
                    const mnColCb = document.querySelector('#browse-collections-list input[data-collection="mn"]');
                    mnColCb.click();
                    await waitFor(() => getBrowseCount() > 100 && getBrowseCount() < 250);
                    res.mnCollectionCount = getBrowseCount();
                    const mnChip = document.querySelector('#browse-active-chips .browse-filter-chip[data-remove-col="mn"]');
                    mnChip.click();
                    await waitFor(() => getBrowseCount() === res.initialTotal);

                    // Final reset
                    res.resetTotal = getBrowseCount();
                    res.ok = true;
                  } catch (err) {
                    res.error = err && err.message ? err.message : String(err);
                  }
                  await fetch('/__browse_ui_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(res),
                  });
                })();
                </script>
                """
                injected = raw_html.replace("</body>", harness_js + "\n</body>").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(injected)))
                self.end_headers()
                self.wfile.write(injected)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: BrowseUIHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/__browse_ui_e2e.html",
            ]
            proc = subprocess.Popen(cmd)
            try:
                deadline = time.time() + 75.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"Browse UI E2E failed: {report}"
        assert report["initialTotal"] >= 2900
        assert report["brahmOnlyCount"] < 2000, "Ajahn Brahm filter must NOT collide with Ajahn Brahmali"
        assert report["brahmOrBrahmaliCount"] > report["brahmOnlyCount"]
        assert 1 <= report["brahmAndBrahmaliCount"] < 25
        assert "teachers=ajahn_brahm" in report["brahmAndBrahmaliHash"]
        assert "tmode=all" in report["brahmAndBrahmaliHash"]
        for badges in report["andCardBadges"]:
            assert "Ajahn Brahm" in badges and "Ajahn Brahmali" in badges

        assert report["y1997And2001Count"] > report["y1997Count"]
        assert report["with1990sCount"] > report["y1997And2001Count"]
        assert 100 <= report["mnTitleCount"] <= 250
        assert 100 <= report["mnCollectionCount"] <= 250
        assert report["mnHighlightCount"] > 0
        assert report["anSubstrCount"] > 500
        assert 20 <= report["anWholeWordCount"] <= 80
        assert any("Dhātuvibhaṅga" in t or "Dhatu" in t for t in report["dhatuTitles"])

        assert all(d < 15 for d in report["under15Durs"])
        assert all(45 <= d <= 60 for d in report["customSampleDurs"])
        assert report["sortedFirstDur"] == 45
        assert report["resetTotal"] == report["initialTotal"]
    finally:
        server.shutdown()
        server.server_close()


def test_search_multi_faceted_filtering_contract():
    """Verifies DOM controls, JS handlers, and worker handlers for multi-faceted Search filtering."""
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    all_app_js = _read_all_app_js(web_dir)
    worker_js = (web_dir / "static" / "db_worker.js").read_text(encoding="utf-8")
    style_css = _read_all_style_css(web_dir)

    for dom_id in (
        'id="search-teachers-dropdown"',
        'id="btn-search-teacher-mode-any"',
        'id="btn-search-teacher-mode-all"',
        'id="search-teachers-list"',
        'id="search-years-dropdown"',
        'id="search-era-presets"',
        'id="search-years-grid"',
        'id="search-year-from"',
        'id="search-year-to"',
        'id="search-duration-dropdown"',
        'id="search-duration-buckets"',
        'id="search-min-duration"',
        'id="search-max-duration"',
        'id="search-category-dropdown"',
        'id="search-collections-list"',
        'id="search-formats-list"',
        'id="search-cotaught-checkbox"',
        'id="search-bookmarked-checkbox"',
        'id="search-title-dropdown"',
        'id="search-title-input"',
        'id="search-title-word-checkbox"',
        'id="search-active-chips"',
        'id="sort-order-select"',
        'id="reset-filters-btn"',
    ):
        assert dom_id in index_html, f"Missing {dom_id} in index.html"

    for css_sel in (".search-facets-group", ".search-title-panel", ".search-active-chips"):
        assert css_sel in style_css, f"Missing {css_sel} in CSS"

    for js_sym in (
        "setupSearchFilterListeners",
        "buildSearchFilterOpts",
        "buildSearchRouteHash",
        "applySearchParamsFromRoute",
        "resetSearchFilters",
        "populateSearchFilterFacets",
    ):
        assert js_sym in all_app_js, f"Missing {js_sym} in frontend modules"

    for worker_sym in ("normalizeEpisodeFilterCriteria", "matchesEpisodeFilterCriteria"):
        assert worker_sym in worker_js, f"Missing {worker_sym} in db_worker.js"


def test_headless_chrome_search_multi_faceted_filtering_e2e():
    """
    Exercises multi-faceted Search View filtering inside headless Google Chrome against dist/:
    1. FTS query ("jhana") + multi-monastic selection (Any/OR vs All/AND co-taught).
    2. Multi-year selection + Date Range toggle.
    3. Duration bucket & Collection filter + Title filter.
    4. Filter-only mode (no FTS query), active chip removal, URL hash sync, and Reset.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    report = {}

    class SearchFilterUIHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__report__":
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length).decode("utf-8")
                report.update(json.loads(body))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__search_filters_e2e.html":
                raw_html = (DIST_DIR / "index.html").read_text(encoding="utf-8")
                head_err_js = "<script>window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @ '+e.filename+':'+e.lineno));</script>"
                raw_html = raw_html.replace("<head>", f"<head>{head_err_js}", 1)
                harness_js = """
                <script>
                (async () => {
                  const out = { ok: false, errors: window.__errs || [] };
                  const wait = (ms) => new Promise(r => setTimeout(r, ms));
                  async function waitFor(fn, timeoutMs = 45000) {
                    const t0 = performance.now();
                    while (performance.now() - t0 < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await wait(80);
                    }
                    throw new Error("Timed out waiting for condition");
                  }
                  try {
                    await waitFor(() => document.querySelectorAll('#search-teachers-list input[data-teacher-slug]').length > 5, 45000);

                    const searchInput = document.getElementById('search-input');
                    const getCount = () => Number(document.getElementById('search-count-badge').textContent || '0');

                    // 1. Run FTS query "jhana"
                    searchInput.value = 'jhana';
                    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    await waitFor(() => getCount() > 50);
                    out.jhanaAllCount = getCount();

                    // 2. Filter by Ajahn Brahm
                    document.querySelector('#search-teachers-list input[data-teacher-slug="ajahn_brahm"]').click();
                    await waitFor(() => getCount() > 0 && getCount() < out.jhanaAllCount);
                    out.jhanaBrahmCount = getCount();

                    // 3. Add Ajahn Brahmali (Any/OR -> expands)
                    document.querySelector('#search-teachers-list input[data-teacher-slug="ajahn_brahmali"]').click();
                    await waitFor(() => getCount() > out.jhanaBrahmCount);
                    out.jhanaOrCount = getCount();

                    // 4. Switch to All (AND co-taught)
                    document.getElementById('btn-search-teacher-mode-all').click();
                    await waitFor(() => getCount() < out.jhanaOrCount);
                    out.jhanaAndCount = getCount();
                    out.andHash = window.location.hash;

                    // 5. Reset and test Collection (MN) + Duration (< 15 min) without FTS query
                    document.getElementById('reset-filters-btn').click();
                    await waitFor(() => document.getElementById('search-empty-state').style.display === 'block');

                    document.querySelector('#search-collections-list input[data-collection="mn"]').click();
                    await waitFor(() => getCount() >= 100 && getCount() <= 250);
                    out.mnOnlyCount = getCount();

                    document.querySelector('#search-duration-buckets input[data-dur-bucket="under_15"]').click();
                    await waitFor(() => getCount() < out.mnOnlyCount);
                    out.mnUnder15Count = getCount();

                    // 6. Verify chips exist and removing chip updates results
                    out.chipCount = document.querySelectorAll('#search-active-chips .browse-filter-chip').length;
                    const durChip = document.querySelector('#search-active-chips .browse-filter-chip[data-remove-dur="under_15"]');
                    if (durChip) durChip.click();
                    await waitFor(() => getCount() === out.mnOnlyCount);
                    out.afterChipRemoveCount = getCount();

                    // 7. Reset clears everything back to empty state
                    document.getElementById('reset-filters-btn').click();
                    await waitFor(() => document.getElementById('search-empty-state').style.display === 'block');
                    out.resetBadge = getCount();

                    out.ok = true;
                  } catch (err) {
                    out.error = String(err && err.stack ? err.stack : err);
                    out.hasDD = Boolean(window.DeeperDhamma);
                    out.isDbReady = Boolean(window.DeeperDhamma && window.DeeperDhamma.state && window.DeeperDhamma.state.isDbReady);
                    out.teacherCheckboxes = document.querySelectorAll('#search-teachers-list input[data-teacher-slug]').length;
                    out.browseTeacherCheckboxes = document.querySelectorAll('#browse-teachers-list input[data-teacher-slug]').length;
                    out.searchCountBadge = document.getElementById('search-count-badge')?.textContent;
                  }
                  await fetch('/__report__', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
                })();
                </script>
                """
                body = raw_html.replace("</body>", f"{harness_js}</body>").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

    class ReusableServer(http.server.ThreadingHTTPServer):
        allow_reuse_address = True

    server = ReusableServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: SearchFilterUIHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_data_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_data_dir}",
                f"http://127.0.0.1:{port}/__search_filters_e2e.html",
            ]
            proc = subprocess.Popen(cmd)
            try:
                deadline = time.time() + 75.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"Search Filter E2E failed: {report}"
        assert report["jhanaAllCount"] > report["jhanaBrahmCount"] > 0
        assert report["jhanaOrCount"] > report["jhanaBrahmCount"]
        assert report["jhanaAndCount"] < report["jhanaOrCount"]
        assert "teachers=ajahn_brahm" in report["andHash"]
        assert "tmode=all" in report["andHash"]
        assert 100 <= report["mnOnlyCount"] <= 250
        assert report["mnUnder15Count"] < report["mnOnlyCount"]
        assert report["chipCount"] == 2
        assert report["afterChipRemoveCount"] == report["mnOnlyCount"]
        assert report["resetBadge"] == 0
    finally:
        server.shutdown()
        server.server_close()


def test_responsive_small_screen_layout_contract():
    """
    Verifies small-screen CSS and JS layout guards:
    1. Search filter select-group wraps and allows flex children to shrink without overflowing.
    2. Date Mode toggle button prevents awkward multi-line label wrapping.
    3. Mobile top navigation bar wraps instead of clipping nav icons off-screen.
    4. Mobile transcript lexicon companion resets left: 0 after the 900px rule.
    5. app.js exposes clampFloatingPanelToViewport and updates --sidebar-height.
    """
    from deeper_dhamma.config import PROJECT_ROOT

    web_dir = PROJECT_ROOT / "deeper_dhamma" / "web"
    style_css = _read_all_style_css(web_dir)
    app_js = _read_all_app_js(web_dir)

    # 1. Select group & date range wrapping
    select_group_css = style_css.split(".select-group {", 1)[1].split("}", 1)[0]
    assert "flex-wrap: wrap" in select_group_css
    assert "min-width: 0" in select_group_css

    date_btn_css = style_css.split(".date-mode-btn {", 1)[1].split("}", 1)[0]
    assert "white-space: nowrap" in date_btn_css

    date_inputs_css = style_css.rsplit(".date-range-inputs {", 1)[1].split("}", 1)[0]
    assert "flex-wrap: wrap" in date_inputs_css
    assert "min-width: 0" in date_inputs_css

    # 2. View fade animation must not set transform (would trap fixed lexicon companion)
    view_fade_css = style_css.split("@keyframes viewFadeIn {", 1)[1].split("\n}", 1)[0]
    assert "transform" not in view_fade_css

    # 2. App-shell grid layout & mobile wrapping + sticky toolbar/companion inside <main>
    assert "height: 100dvh;" in style_css
    assert 'grid-template-areas:\n    "sidebar main"\n    "footer footer";' in style_css

    mobile_block = style_css.split("@media (max-width: 600px)")[1]
    assert "flex-wrap: wrap" in mobile_block
    assert "width: auto" in mobile_block
    assert '"sidebar"\n      "main"\n      "footer"' in mobile_block

    comp_1100 = style_css.split("@media (max-width: 1100px)")[1]
    assert "position: sticky;" in comp_1100
    comp_expanded_1100 = comp_1100.split(".transcript-lexicon-companion.is-expanded {", 1)[1].split("}", 1)[0]
    assert "var(--main-height" in comp_expanded_1100
    assert "var(--toolbar-height" in comp_expanded_1100
    comp_stack_1100 = style_css.split(".transcript-lexicon-companion.is-expanded .lexicon-stack-container {", 1)[1].split("}", 1)[0]
    assert "min-height: 0" in comp_stack_1100

    # Reduced desktop lexicon companion width & always-stacked compact track-details & always-available toolbar toggle
    layout_grid_css = style_css.split(".transcript-layout-container {", 1)[1].split("}", 1)[0]
    assert "280px" in layout_grid_css
    btn_toggle_css = style_css.split(".btn-toggle-toolbar-actions {", 1)[1].split("}", 1)[0]
    assert "display: inline-flex" in btn_toggle_css
    actions_group_css = style_css.split(".toolbar-actions-group {", 1)[1].split("}", 1)[0]
    assert "display: none" in actions_group_css
    player_container_css = style_css.split(".player-container {", 1)[1].split("}", 1)[0]
    assert "flex-direction: column" in player_container_css

    # 3. Viewport clamping helper, <main> scroll helpers & layout chrome height observers in app.js
    assert "function clampFloatingPanelToViewport(" in app_js
    assert "function resetFloatingPanelPosition(" in app_js
    assert "function getScrollContainer(" in app_js
    assert "function isCompanionBottomSheet(" in app_js
    assert "toggleMobileLexSheet(false)" in app_js.split("function jumpToCompanionTerm(", 1)[1].split("function setActiveCompanionTerm(", 1)[0]
    assert "--main-height" in app_js
    assert "--toolbar-height" in app_js

    # 4. Fluent mic track icon and Podbean CDN badge removed; Bookmark stays top-right;
    #    Gear sits left of play buttons above elapsed time; Transcript sits icon-only right of
    #    play buttons above total time; toolbar-actions-group collapses under toolbar-sync-group;
    #    transcript-sticky-toolbar uses <aside> docked at the top on small screens;
    #    and mobile sidebar stacks Deeper Dhamma brand above nav icons.
    index_html = (web_dir / "views" / "index.html").read_text(encoding="utf-8")
    assert "fluent-mic" not in index_html
    assert "track-icon-wrapper" not in index_html
    assert "fluent-mic" not in app_js

    assert '<aside class="transcript-sticky-toolbar" id="transcript-sticky-toolbar"' in index_html
    toolbar_html = index_html.split('id="transcript-sticky-toolbar"', 1)[1].split('<div class="transcript-layout-container"', 1)[0]
    sync_group_html = toolbar_html.split('<div class="toolbar-sync-group">', 1)[1].split('<div class="toolbar-actions-group"', 1)[0]
    assert 'id="btn-toggle-toolbar-actions"' in sync_group_html
    assert 'id="toolbar-actions-group"' in toolbar_html
    assert "function toggleToolbarActions(" in app_js

    player_bar_html = index_html.split('<footer class="audio-player-bar"', 1)[1].split("</footer>", 1)[0]
    assert "track-stream-badge" not in player_bar_html
    assert "Podbean CDN" not in player_bar_html
    assert "player-extras" not in player_bar_html
    track_info_html = player_bar_html.split('<div class="track-info">', 1)[1].split("<!-- Player Center Controls -->", 1)[0]
    assert 'id="btn-player-bookmark"' in track_info_html
    assert 'id="btn-player-transcript"' not in track_info_html
    top_row_html = player_bar_html.split('<div class="player-controls-top-row">', 1)[1].split('<div class="scrubber-row">', 1)[0]
    assert 'id="btn-player-settings"' in top_row_html
    assert 'id="btn-player-transcript"' in top_row_html
    assert top_row_html.index('id="btn-player-settings"') < top_row_html.index('class="control-buttons"') < top_row_html.index('id="btn-player-transcript"')
    assert "btn-player-transcript-label" not in top_row_html
    tx_btn_html = top_row_html.split('id="btn-player-transcript"', 1)[1].split("</button>", 1)[0]
    assert "Transcript" not in tx_btn_html
    assert 'class="speed-selector"' not in player_bar_html
    assert 'id="volume-slider"' not in player_bar_html

    assert ".sidebar-brand .brand-text {" in mobile_block
    assert "flex-direction: column;" in mobile_block

    settings_view_html = index_html.split('id="player-settings-view"', 1)[1].split('id="archive-progress-modal"', 1)[0]
    assert 'class="speed-selector"' in settings_view_html
    assert 'id="volume-slider"' in settings_view_html
    assert 'id="vol-toggle-btn"' in settings_view_html
    assert "openPlayerSettings" in app_js
    assert "closePlayerSettings" in app_js


def test_headless_chrome_small_screen_no_overflow():
    """
    Tests rendered UI inside headless Google Chrome across mobile/tablet widths (320px, 393px, 768px)
    to verify zero horizontal overflow, zero clipped nav buttons, intact search filter bounds,
    single-line Date Range toggle, clamped popovers/dropdowns, and full-width lexicon companion.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    report = {}

    class ResponsiveAuditHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__responsive_report":
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length)
                report.update(json.loads(payload.decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__responsive_host.html":
                html = r"""<!DOCTYPE html>
                <html><head><meta charset="utf-8"></head>
                <body style="margin:0;padding:0;">
                <iframe id="f" style="border:0;height:851px;display:block;" src="about:blank"></iframe>
                <script>
                (async () => {
                  const viewports = [
                    { w: 320, h: 568 },
                    { w: 358, h: 661 },
                    { w: 371, h: 698 },
                    { w: 393, h: 851 },
                    { w: 768, h: 480 },
                    { w: 1027, h: 720 },
                    { w: 1120, h: 800 },
                    { w: 1280, h: 800 }
                  ];
                  const frame = document.getElementById('f');
                  const wait = ms => new Promise(r => setTimeout(r, ms));
                  const waitFor = async (fn, timeoutMs = 45000) => {
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await wait(80);
                    }
                    throw new Error('Timed out waiting for responsive test condition');
                  };

                  const out = { ok: false, widths: {} };
                  try {
                    await new Promise(res => {
                      frame.onload = () => {
                        if (frame.contentWindow.location.pathname === '/index.html') res();
                      };
                      frame.src = '/index.html';
                    });

                    const doc = frame.contentDocument;
                    const win = frame.contentWindow;
                    await waitFor(() => parseInt(doc.getElementById('browse-count-badge')?.textContent?.trim() || '0', 10) > 1000);

                    const searchInput = doc.getElementById('search-input');
                    searchInput.value = 'five hindrances';
                    searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
                    await waitFor(() => doc.querySelectorAll('#search-results-list .result-card').length > 0);

                    function auditState(label, vw) {
                      const docW = doc.documentElement.clientWidth;
                      const scrollW = doc.documentElement.scrollWidth;
                      const overflowEls = [];
                      for (const el of doc.querySelectorAll('body *')) {
                        const cs = win.getComputedStyle(el);
                        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        if (el.closest('.doc-table-container')) continue;
                        if (rect.right > docW + 1 || rect.left < -1) {
                          overflowEls.push({
                            tag: el.tagName.toLowerCase(),
                            id: el.id || '',
                            cls: typeof el.className === 'string' ? el.className : '',
                            left: Math.round(rect.left),
                            right: Math.round(rect.right),
                            docW
                          });
                        }
                      }
                      const clippedNav = [];
                      doc.querySelectorAll('.sidebar-nav-item').forEach(btn => {
                        if (win.getComputedStyle(btn).display === 'none') return;
                        const r = btn.getBoundingClientRect();
                        if (r.right > docW + 1 || r.left < -1) {
                          clippedNav.push({ id: btn.id, left: Math.round(r.left), right: Math.round(r.right), docW });
                        }
                      });
                      const extra = {};
                      if (label === 'search_year') {
                        const rangeBtn = doc.getElementById('btn-mode-range');
                        const wrap = doc.querySelector('.search-box-wrapper');
                        const sortSel = doc.getElementById('sort-order-select');
                        const resetBtn = doc.getElementById('reset-filters-btn');
                        extra.rangeBtnHeight = rangeBtn ? Math.round(rangeBtn.getBoundingClientRect().height) : 0;
                        extra.sortInsideWrapper = Boolean(wrap && sortSel && sortSel.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 1);
                        extra.resetInsideWrapper = Boolean(wrap && resetBtn && resetBtn.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 1);
                      }
                      if (label === 'notes_view') {
                        const deskSvg = doc.querySelector('.notes-diagram-svg--desktop');
                        const mobSvg = doc.querySelector('.notes-diagram-svg--mobile');
                        const theadEl = doc.querySelector('#notes-view .notes-table thead');
                        const deskDisp = deskSvg ? win.getComputedStyle(deskSvg).display : 'none';
                        const mobDisp = mobSvg ? win.getComputedStyle(mobSvg).display : 'none';
                        const theadDisp = theadEl ? win.getComputedStyle(theadEl).display : '';
                        extra.diagramResponsiveOk = vw <= 680
                          ? (deskDisp === 'none' && mobDisp !== 'none')
                          : (deskDisp !== 'none' && mobDisp === 'none');
                        extra.tableResponsiveOk = vw <= 600
                          ? (theadDisp === 'none')
                          : (theadDisp !== 'none');
                      }
                      if (label === 'transcript_view') {
                        const comp = doc.getElementById('transcript-lexicon-companion');
                        const sb = doc.getElementById('app-sidebar');
                        const brandEl = sb ? sb.querySelector('.sidebar-brand') : null;
                        const brandTitle = doc.getElementById('site-title');
                        const navEl = doc.getElementById('main-nav-tabs');
                        const tb = doc.getElementById('transcript-sticky-toolbar');
                        const tbToggle = doc.getElementById('btn-toggle-toolbar-actions');
                        const tbActions = doc.getElementById('toolbar-actions-group');
                        const bar = doc.getElementById('audio-player-bar');
                        const ti = bar ? bar.querySelector('.track-info') : null;
                        const td = bar ? bar.querySelector('.track-details') : null;
                        const bmk = doc.getElementById('btn-player-bookmark');
                        const txBtn = doc.getElementById('btn-player-transcript');
                        const gearBtn = doc.getElementById('btn-player-settings');
                        const ctlBtns = bar ? bar.querySelector('.control-buttons') : null;
                        const timeCur = doc.getElementById('time-current');
                        const timeTot = doc.getElementById('time-total');
                        const tiRect = ti ? ti.getBoundingClientRect() : null;
                        const tdRect = td ? td.getBoundingClientRect() : null;
                        const bmkRect = bmk ? bmk.getBoundingClientRect() : null;
                        const gearRect = gearBtn ? gearBtn.getBoundingClientRect() : null;
                        const txRect = txBtn ? txBtn.getBoundingClientRect() : null;
                        const ctlRect = ctlBtns ? ctlBtns.getBoundingClientRect() : null;
                        const curRect = timeCur ? timeCur.getBoundingClientRect() : null;
                        const totRect = timeTot ? timeTot.getBoundingClientRect() : null;
                        extra.compLeft = comp ? Math.round(comp.getBoundingClientRect().left) : null;
                        const mainEl = doc.getElementById('main-content');
                        const mainRightEdge = mainEl ? Math.round(mainEl.getBoundingClientRect().left + mainEl.clientWidth) : docW;
                        extra.toolbarIsAsideTopDocked = Boolean(
                          tb && tb.tagName.toLowerCase() === 'aside' &&
                          win.getComputedStyle(tb).position === 'sticky' &&
                          Math.abs(Math.round(tb.getBoundingClientRect().right) - mainRightEdge) <= 1 &&
                          (vw <= 600
                            ? (Math.round(tb.getBoundingClientRect().left) === 0 && sb && Math.abs(tb.getBoundingClientRect().top - sb.getBoundingClientRect().bottom) <= 1)
                            : (Math.round(tb.getBoundingClientRect().top) === 0 && Math.round(tb.getBoundingClientRect().left) === (vw <= 900 ? 76 : 260))
                          )
                        );
                        const txHdr = doc.querySelector('#transcript-view .transcript-view-header');
                        extra.toolbarClearedHeader = (tb && txHdr)
                          ? txHdr.getBoundingClientRect().top >= tb.getBoundingClientRect().bottom - 1
                          : true;
                        extra.toolbarClearedSidebar = (vw <= 600 && sb && tb)
                          ? tb.getBoundingClientRect().top >= sb.getBoundingClientRect().bottom - 1
                          : true;
                        extra.noCdnBadge = Boolean(bar && !bar.querySelector('.track-stream-badge') && !bar.textContent.includes('Podbean CDN'));
                        extra.bookmarkTopRight = Boolean(
                          tiRect && tdRect && bmkRect && bmkRect.width > 0 &&
                          bmkRect.top <= tiRect.top + 4 &&
                          tiRect.right - bmkRect.right <= 2 &&
                          bmkRect.left >= tdRect.right - 1
                        );
                        extra.titleFullWidthMinusBookmark = Boolean(
                          tiRect && tdRect && bmkRect && bmkRect.width > 0 &&
                          (tiRect.width - tdRect.width - bmkRect.width) <= 16
                        );
                        const trackTitleEl = doc.getElementById('player-track-title');
                        const trackTitleFontPx = trackTitleEl ? parseFloat(win.getComputedStyle(trackTitleEl).fontSize) : 99;
                        extra.trackDetailsAboveButtons = Boolean(
                          tdRect && ctlRect && tdRect.bottom <= ctlRect.top + 2 && trackTitleFontPx <= 13
                        );
                        extra.gearInlineLeftAboveElapsed = Boolean(
                          gearRect && ctlRect && curRect && gearRect.width > 0 &&
                          gearRect.right <= ctlRect.left + 1 &&
                          Math.abs((gearRect.top + gearRect.height / 2) - (ctlRect.top + ctlRect.height / 2)) <= 6 &&
                          Math.abs(gearRect.left - curRect.left) <= 2 &&
                          gearRect.bottom <= curRect.top + 2
                        );
                        extra.transcriptIconInlineRightAboveTotal = Boolean(
                          txBtn && txRect && ctlRect && totRect && txRect.width > 0 &&
                          win.getComputedStyle(txBtn).display !== 'none' &&
                          txRect.left >= ctlRect.right - 1 &&
                          Math.abs((txRect.top + txRect.height / 2) - (ctlRect.top + ctlRect.height / 2)) <= 6 &&
                          Math.abs(txRect.right - totRect.right) <= 2 &&
                          txRect.bottom <= totRect.top + 2 &&
                          !txBtn.textContent.toLowerCase().includes('transcript')
                        );
                        extra.toolbarActionsCollapsedInitially = Boolean(
                          tbToggle && tbActions &&
                          win.getComputedStyle(tbToggle).display !== 'none' &&
                          win.getComputedStyle(tbActions).display === 'none'
                        );
                        if (tbToggle && tbActions) {
                          tbToggle.click();
                          const expandedDisp = win.getComputedStyle(tbActions).display;
                          const expandedOverflow = doc.documentElement.scrollWidth > doc.documentElement.clientWidth;
                          tbToggle.click();
                          const recollapsedDisp = win.getComputedStyle(tbActions).display;
                          extra.toolbarActionsToggleWorks = (expandedDisp !== 'none' && !expandedOverflow && recollapsedDisp === 'none');
                        } else {
                          extra.toolbarActionsToggleWorks = false;
                        }
                        const tickerEl = doc.getElementById('lex-mobile-ticker');
                        const turnTextEl = doc.querySelector('#drawer-turns-container .turn-text');
                        const readerEl = doc.getElementById('drawer-turns-container');
                        const compRect = comp ? comp.getBoundingClientRect() : null;
                        const turnTextRect = turnTextEl ? turnTextEl.getBoundingClientRect() : null;
                        const readerRect = readerEl ? readerEl.getBoundingClientRect() : null;
                        extra.companionPlacementOk = vw <= 1100
                          ? Boolean(tickerEl && win.getComputedStyle(tickerEl).display !== 'none')
                          : Boolean(
                              tickerEl && win.getComputedStyle(tickerEl).display === 'none' &&
                              compRect && compRect.width <= 290 &&
                              turnTextRect && turnTextRect.width > compRect.width &&
                              readerRect && readerRect.width > compRect.width
                            );
                        if (vw <= 600 && brandEl && brandTitle && navEl) {
                          const brandRect = brandEl.getBoundingClientRect();
                          const titleRect = brandTitle.getBoundingClientRect();
                          const navRect = navEl.getBoundingClientRect();
                          const navBtns = Array.from(navEl.querySelectorAll('.sidebar-nav-item')).filter(b => win.getComputedStyle(b).display !== 'none');
                          const navTops = navBtns.map(b => Math.round(b.getBoundingClientRect().top));
                          extra.mobileBrandVisibleAboveNav = Boolean(
                            win.getComputedStyle(brandTitle).display !== 'none' &&
                            titleRect.width > 40 && titleRect.height > 10 &&
                            navRect.top >= brandRect.bottom - 1 &&
                            navBtns.length >= 7 &&
                            (Math.max(...navTops) - Math.min(...navTops)) <= 2
                          );
                        } else {
                          extra.mobileBrandVisibleAboveNav = true;
                        }
                      }
                      return {
                        label,
                        docW,
                        scrollW,
                        overflowEls: overflowEls.slice(0, 10),
                        clippedNav,
                        extra
                      };
                    }

                    for (const vp of viewports) {
                      const vw = vp.w;
                      frame.style.width = vp.w + 'px';
                      frame.style.height = vp.h + 'px';
                      await wait(160);
                      const states = [];

                      doc.getElementById('tab-search-btn').click();
                      await wait(100);
                      doc.getElementById('btn-mode-year').click();
                      await wait(80);
                      states.push(auditState('search_year', vw));

                      doc.getElementById('btn-mode-range').click();
                      await wait(80);
                      states.push(auditState('search_date_range', vw));
                      doc.getElementById('btn-mode-year').click();

                      doc.getElementById('btn-download-all-archive').click();
                      await wait(80);
                      states.push(auditState('search_all_dropdown', vw));
                      doc.body.click();

                      doc.getElementById('tab-browse-btn').click();
                      await waitFor(() => doc.querySelectorAll('#browse-episodes-grid .episode-card').length > 0);
                      await wait(100);
                      doc.getElementById('browse-category-btn').click();
                      await wait(80);
                      states.push(auditState('browse_category_popover', vw));
                      doc.body.click();

                      doc.getElementById('tab-lexicon-btn').click();
                      await waitFor(() => doc.querySelectorAll('#lexicon-results-list .lexicon-card').length > 0);
                      await wait(80);
                      states.push(auditState('lexicon_view', vw));

                      doc.getElementById('tab-documents-btn').click();
                      await wait(200);
                      states.push(auditState('documents_view', vw));

                      doc.getElementById('tab-about-btn').click();
                      await wait(80);
                      states.push(auditState('about_view', vw));

                      doc.getElementById('tab-notes-btn').click();
                      await wait(80);
                      states.push(auditState('notes_view', vw));

                      doc.getElementById('tab-search-btn').click();
                      await wait(80);
                      doc.querySelector('#search-results-list [data-action="view-transcript"]').click();
                      await waitFor(() => doc.querySelectorAll('#drawer-turns-container .transcript-turn').length > 0);
                      const txPlay = doc.getElementById('transcript-play-btn');
                      if (txPlay) txPlay.click();
                      const mainScrollReset = doc.getElementById('main-content');
                      if (mainScrollReset) mainScrollReset.scrollTop = 0;
                      win.scrollTo(0, 0);
                      await wait(240);
                      states.push(auditState('transcript_view', vw));

                      const gearBtn = doc.getElementById('btn-player-settings');
                      const settingsView = doc.getElementById('player-settings-view');
                      const settingsCard = doc.getElementById('player-settings-card');
                      const closeSettingsBtn = doc.getElementById('btn-close-player-settings');
                      const speedValEl = doc.getElementById('player-settings-speed-val');
                      const volValEl = doc.getElementById('player-settings-vol-val');
                      const volToggleBtn = doc.getElementById('vol-toggle-btn');
                      const speed125Btn = settingsView.querySelector('.speed-btn[data-speed="1.25"]');
                      const speed100Btn = settingsView.querySelector('.speed-btn[data-speed="1.0"]');
                      gearBtn.click();
                      await wait(120);
                      const settingsState = auditState('player_settings_view', vw);
                      const cardRect = settingsCard.getBoundingClientRect();
                      speed125Btn.click();
                      const speedAfterClick = speedValEl ? speedValEl.textContent.trim() : '';
                      const hasCustomWhenFast = gearBtn.classList.contains('has-custom');
                      volToggleBtn.click();
                      const volMutedText = volValEl ? volValEl.textContent.trim() : '';
                      volToggleBtn.click();
                      const volRestoredText = volValEl ? volValEl.textContent.trim() : '';
                      speed100Btn.click();
                      settingsState.extra = {
                        opened: win.getComputedStyle(settingsView).display !== 'none',
                        cardInsideViewport: cardRect.left >= -1 && cardRect.right <= settingsState.docW + 1 && cardRect.top >= -1 && cardRect.bottom <= vp.h + 1,
                        speedAfterClick,
                        hasCustomWhenFast,
                        volMutedText,
                        volRestoredText,
                      };
                      closeSettingsBtn.click();
                      await wait(80);
                      settingsState.extra.closedAfterClick = win.getComputedStyle(settingsView).display === 'none';
                      states.push(settingsState);

                      if (vw <= 1100) {
                        const comp = doc.getElementById('transcript-lexicon-companion');
                        const toggleBtn = doc.getElementById('btn-toggle-lex-sheet');
                        const sb = doc.getElementById('app-sidebar');
                        toggleBtn.click();
                        await wait(360);
                        const expandedState = auditState('transcript_companion_expanded', vw);
                        const tRect = toggleBtn.getBoundingClientRect();
                        const sbRect = sb.getBoundingClientRect();
                        const hitX = tRect.left + tRect.width / 2;
                        const hitY = tRect.top + tRect.height / 2;
                        const hitEl = doc.elementFromPoint(hitX, hitY);
                        expandedState.extra = {
                          expanded: comp.classList.contains('is-expanded'),
                          toggleTop: Math.round(tRect.top),
                          sidebarBottom: Math.round(sbRect.bottom),
                          toggleClearedSidebar: vw <= 600 ? (tRect.top >= sbRect.bottom - 1) : (tRect.top >= 0),
                          toggleHitTestOk: Boolean(hitEl && (hitEl === toggleBtn || toggleBtn.contains(hitEl))),
                        };
                        if (expandedState.extra.toggleHitTestOk) {
                          toggleBtn.click();
                          await wait(80);
                          expandedState.extra.collapsedAfterClick = !comp.classList.contains('is-expanded');
                        } else {
                          expandedState.extra.collapsedAfterClick = false;
                        }
                        states.push(expandedState);
                      }

                      out.widths[vw] = states;
                    }
                    out.ok = true;
                  } catch (err) {
                    out.error = err && err.message ? err.message : String(err);
                  }
                  await fetch('/__responsive_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(out),
                  });
                })();
                </script>
                </body></html>"""
                body = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: ResponsiveAuditHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            cmd = [
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                "http://127.0.0.1:%d/__responsive_host.html" % port,
            ]
            proc = subprocess.Popen(cmd)
            try:
                deadline = time.time() + 55.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"Responsive layout audit failed: {report}"
        for vw_str, states in report["widths"].items():
            vw = int(vw_str)
            for st in states:
                assert st["scrollW"] <= st["docW"], f"Horizontal scroll overflow at {vw}px in {st['label']}: {st}"
                assert st["overflowEls"] == [], f"Overflowing elements at {vw}px in {st['label']}: {st['overflowEls']}"
                assert st["clippedNav"] == [], f"Clipped nav buttons at {vw}px in {st['label']}: {st['clippedNav']}"
                if st["label"] == "search_year":
                    assert st["extra"]["rangeBtnHeight"] <= 36, f"Date Range button wrapped onto multiple lines at {vw}px: {st['extra']}"
                    assert st["extra"]["sortInsideWrapper"] is True, f"Sort select escaped wrapper at {vw}px"
                    assert st["extra"]["resetInsideWrapper"] is True, f"Reset button escaped wrapper at {vw}px"
                if st["label"] == "notes_view":
                    assert st["extra"]["diagramResponsiveOk"] is True, f"Archive Notes diagram did not switch for {vw}px: {st['extra']}"
                    assert st["extra"]["tableResponsiveOk"] is True, f"Archive Notes table did not adapt for {vw}px: {st['extra']}"
                if st["label"] == "transcript_view":
                    assert st["extra"]["toolbarIsAsideTopDocked"] is True, f"Toolbar aside not top-docked cleanly at {vw}px: {st['extra']}"
                    assert st["extra"]["toolbarClearedHeader"] is True, f"Fixed top toolbar covered transcript header at {vw}px: {st['extra']}"
                    assert st["extra"]["toolbarClearedSidebar"] is True, f"Sticky toolbar overlapped mobile header at {vw}px"
                    assert st["extra"]["noCdnBadge"] is True, f"Podbean CDN badge should be removed at {vw}px"
                    assert st["extra"]["bookmarkTopRight"] is True, f"Bookmark button not positioned top-right in play bar at {vw}px: {st['extra']}"
                    assert st["extra"]["titleFullWidthMinusBookmark"] is True, f"Talk title did not expand full width minus bookmark at {vw}px: {st['extra']}"
                    assert st["extra"]["trackDetailsAboveButtons"] is True, f"Track details not stacked above buttons or font not reduced at {vw}px: {st['extra']}"
                    assert st["extra"]["gearInlineLeftAboveElapsed"] is True, f"Gear button not inline left above elapsed time at {vw}px: {st['extra']}"
                    assert st["extra"]["transcriptIconInlineRightAboveTotal"] is True, f"Transcript icon button not inline right above total time at {vw}px: {st['extra']}"
                    assert st["extra"]["toolbarActionsCollapsedInitially"] is True, f"Toolbar actions not collapsed initially at {vw}px: {st['extra']}"
                    assert st["extra"]["toolbarActionsToggleWorks"] is True, f"Toolbar actions toggle failed at {vw}px: {st['extra']}"
                    assert st["extra"]["companionPlacementOk"] is True, f"Companion placement or width check failed at {vw}px: {st['extra']}"
                    assert st["extra"]["mobileBrandVisibleAboveNav"] is True, f"Mobile brand line or single-row nav icons failed at {vw}px: {st['extra']}"
                    if vw <= 600:
                        assert st["extra"]["compLeft"] == 0, f"Lexicon companion cut off on left at {vw}px: {st['extra']}"
                if st["label"] == "player_settings_view":
                    assert st["extra"]["opened"] is True, f"Player settings view did not open at {vw}px"
                    assert st["extra"]["cardInsideViewport"] is True, f"Player settings card overflowed viewport at {vw}px: {st['extra']}"
                    assert st["extra"]["speedAfterClick"] == "1.25x", f"Speed selector failed inside settings view at {vw}px: {st['extra']}"
                    assert st["extra"]["hasCustomWhenFast"] is True
                    assert st["extra"]["volMutedText"] == "Muted"
                    assert st["extra"]["volRestoredText"] == "100%"
                    assert st["extra"]["closedAfterClick"] is True, f"Player settings view did not close at {vw}px"
                if st["label"] == "transcript_companion_expanded":
                    assert st["extra"]["expanded"] is True, f"Lexicon companion failed to expand at {vw}px"
                    assert st["extra"]["toggleClearedSidebar"] is True, f"Expanded lexicon collapse button hidden behind nav bar at {vw}px: {st['extra']}"
                    assert st["extra"]["toggleHitTestOk"] is True, f"Expanded lexicon collapse button not hit-testable at {vw}px: {st['extra']}"
                    assert st["extra"]["collapsedAfterClick"] is True, f"Clicking expanded lexicon collapse button failed at {vw}px: {st['extra']}"
    finally:
        server.shutdown()
        server.server_close()


def test_headless_chrome_pb9577355_lexicon_companion_track_sync():
    """
    Verifies on #talk/pb9577355 (SN12.23 Upanisa Sutta) that the Lexicon Live Companion
    never breaks WordSync 'track' mode or steals document scroll:
    1. Every word in WordSync.words resolves to a live transcript DOM span across all 34 turns.
    2. Updating companion cards scrolls only #transcript-lexicon-stack without moving window.scrollY.
    3. Clicking a companion card scrolls the target word into the unobstructed reading zone.
    4. Clicking 'Active' (#btn-clear-lex-stack) leaves window.scrollY unchanged.
    5. Wheel events inside #transcript-lexicon-companion do not pause teleprompter tracking.
    6. On mobile (393x851), track teleprompter respects the fixed #transcript-lexicon-companion bar.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    report = {}

    class TrackSyncAuditHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__track_sync_report":
                length = int(self.headers.get("Content-Length", 0))
                report.update(json.loads(self.rfile.read(length).decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__track_sync_host.html":
                html = r"""<!DOCTYPE html>
                <html><head><meta charset="utf-8"></head>
                <body style="margin:0;padding:0;">
                <iframe id="f" style="border:0;width:1280px;height:720px;display:block;" src="about:blank"></iframe>
                <script>
                (async () => {
                  const frame = document.getElementById('f');
                  const wait = ms => new Promise(r => setTimeout(r, ms));
                  const waitFor = async (fn, timeoutMs = 45000) => {
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await wait(80);
                    }
                    throw new Error('Timed out waiting for pb9577355 load');
                  };

                  const out = { ok: false };
                  try {
                    await new Promise(res => {
                      frame.onload = () => {
                        if (frame.contentWindow.location.pathname === '/index.html') res();
                      };
                      frame.src = '/index.html#talk/pb9577355';
                    });

                    const doc = frame.contentDocument;
                    const win = frame.contentWindow;
                    await waitFor(() => doc.querySelectorAll('#drawer-turns-container .transcript-turn').length === 34);
                    await waitFor(() => win.WordSync && win.WordSync.words && win.WordSync.words.length > 9000);
                    await waitFor(() => doc.querySelectorAll('#transcript-lexicon-stack .lex-stack-card').length > 100);
                    await wait(200);

                    const ws = win.WordSync;
                    const mainEl = doc.getElementById('main-content');
                    const stack = doc.getElementById('transcript-lexicon-stack');
                    const comp = doc.getElementById('transcript-lexicon-companion');

                    let missingDom = 0;
                    for (let i = 0; i < ws.words.length; i++) {
                      if (!doc.getElementById(ws.words[i].domId || ws.words[i].id)) missingDom++;
                    }
                    out.missingDom = missingDom;
                    out.wordsLen = ws.words.length;

                    // 1. Trigger Pali term updates while at top of talk: main/window scroll must remain 0 while stack scrolls
                    mainEl.scrollTop = 0;
                    await wait(50);
                    const mainBeforePali = mainEl.scrollTop;
                    ws.setMode('on');
                    const paliTimeEl = doc.getElementById('lex-card-40');
                    const wordTarget = doc.getElementById('tw-1383');
                    const tTarget = wordTarget ? parseFloat(wordTarget.dataset.start) : 520;
                    ws.update(tTarget + 0.05);
                    await wait(350);
                    out.stackScrolledWithoutWindow = (
                      Math.round(mainEl.scrollTop) === Math.round(mainBeforePali) &&
                      Math.round(win.scrollY) === 0 &&
                      stack.scrollTop > 0
                    );

                    // 2. Click companion card #40 from scrollTop=0 -> transcript word lands inside viewport
                    mainEl.scrollTop = 0;
                    await wait(60);
                    paliTimeEl.click();
                    await wait(1200);
                    const rect40 = wordTarget.getBoundingClientRect();
                    out.jumpCardInViewport = rect40.top >= 60 && rect40.bottom <= 680;
                    out.jumpScrollY = Math.round(mainEl.scrollTop);

                    // 3. Clicking 'Active' scrolls companion stack only, leaving main/window scroll unchanged
                    stack.scrollTop = 0;
                    await wait(50);
                    const yBeforeActive = Math.round(mainEl.scrollTop);
                    doc.getElementById('btn-clear-lex-stack').click();
                    await wait(600);
                    out.activeBtnWinUnchanged = Math.abs(mainEl.scrollTop - yBeforeActive) <= 1 && Math.round(win.scrollY) === 0;
                    out.activeBtnStackScrolled = stack.scrollTop > 100;

                    // 4. Wheel on companion does not pause teleprompter tracking; wheel on transcript does
                    ws._userInteractedAt = 0;
                    stack.dispatchEvent(new win.WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
                    out.wheelCompanionIgnored = ws._userInteractedAt === 0;
                    doc.getElementById('drawer-turns-container').dispatchEvent(new win.WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
                    out.wheelTranscriptPauses = ws._userInteractedAt > 0;
                    ws._userInteractedAt = 0;

                    // 5. Continuous 'track' mode progression on mobile stays above sticky lexicon companion bar
                    frame.style.width = '393px';
                    frame.style.height = '851px';
                    await wait(180);

                    // 5a. Clicking a lexicon companion card on small screen scrolls to term AND minimizes helper
                    mainEl.scrollTop = 0;
                    await wait(60);
                    doc.getElementById('btn-toggle-lex-sheet').click();
                    await wait(350);
                    const wasExpandedBeforeClick = comp.classList.contains('is-expanded');
                    doc.getElementById('lex-card-40').click();
                    await wait(1000);
                    const minimizedAfterClick = !comp.classList.contains('is-expanded');
                    const mobJumpRect = wordTarget ? wordTarget.getBoundingClientRect() : null;
                    const mobTbRect = doc.getElementById('transcript-sticky-toolbar').getBoundingClientRect();
                    const mobCompRect = comp.getBoundingClientRect();
                    out.mobileCardClickMinimizesAndScrolls = Boolean(
                      wasExpandedBeforeClick &&
                      minimizedAfterClick &&
                      mobJumpRect &&
                      mobJumpRect.top >= mobTbRect.bottom - 1 &&
                      mobJumpRect.bottom <= mobCompRect.top + 1
                    );

                    ws._awaitingInitialSeek = false;
                    ws.setMode('track');
                    const trackWord = doc.getElementById('tw-1383') || doc.getElementById('tw-1259');
                    const trackStart = parseFloat(trackWord.dataset.start);
                    const trackMid = trackStart + 0.05;
                    for (let k = 0; k < 70; k++) {
                      ws.update(trackStart + Math.min(k * 0.002, 0.05));
                      await wait(16);
                    }
                    const mobWordRect = ws.activeWordEl ? ws.activeWordEl.getBoundingClientRect() : null;
                    const tbRect = doc.getElementById('transcript-sticky-toolbar').getBoundingClientRect();
                    const compRect = comp.getBoundingClientRect();
                    out.mobDebug = {
                      trackStart,
                      activeId: ws.activeWordEl ? ws.activeWordEl.id : null,
                      mobWordTop: mobWordRect ? Math.round(mobWordRect.top) : null,
                      mobWordBottom: mobWordRect ? Math.round(mobWordRect.bottom) : null,
                      tbBottom: Math.round(tbRect.bottom),
                      compTop: Math.round(compRect.top),
                      scrollY: Math.round(mainEl.scrollTop),
                      winScrollY: Math.round(win.scrollY),
                    };
                    out.mobileTrackClearOfCompanion = Boolean(
                      mobWordRect && mobWordRect.top >= tbRect.bottom - 1 && mobWordRect.bottom <= compRect.top + 1
                    );

                    // 6. Detached activeWordEl recovery in WordSync.update
                    const prevActive = ws.activeWordEl;
                    if (prevActive && prevActive.parentNode) {
                      const clone = prevActive.cloneNode(true);
                      prevActive.parentNode.replaceChild(clone, prevActive);
                      ws.update(parseFloat(clone.dataset.start) + 0.02);
                      out.reattachedAfterDetachedSpan = Boolean(ws.activeWordEl && ws.activeWordEl.isConnected && ws.activeWordEl === clone);
                    } else {
                      out.reattachedAfterDetachedSpan = false;
                    }

                    out.ok = true;
                  } catch (err) {
                    out.error = err && err.stack ? err.stack : String(err);
                  }
                  await fetch('/__track_sync_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(out),
                  });
                })();
                </script>
                </body></html>"""
                body = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: TrackSyncAuditHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            proc = subprocess.Popen([
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/__track_sync_host.html",
            ])
            try:
                deadline = time.time() + 45.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"pb9577355 companion/track audit failed: {report}"
        assert report["missingDom"] == 0
        assert report["wordsLen"] == 9602
        assert report["stackScrolledWithoutWindow"] is True
        assert report["jumpCardInViewport"] is True, f"Card jump stranded offscreen: {report}"
        assert report["activeBtnWinUnchanged"] is True
        assert report["activeBtnStackScrolled"] is True
        assert report["wheelCompanionIgnored"] is True
        assert report["wheelTranscriptPauses"] is True
        assert report["mobileCardClickMinimizesAndScrolls"] is True, f"Mobile companion click did not scroll & minimize: {report}"
        assert report["mobileTrackClearOfCompanion"] is True, f"Mobile track covered by companion: {report}"
        assert report["reattachedAfterDetachedSpan"] is True
    finally:
        server.shutdown()
        server.server_close()


def test_headless_chrome_app_shell_layout_e2e():
    """
    Verifies the 100dvh CSS Grid app-shell layout on index.html:
    1. Separates <aside.app-sidebar>, <main.app-main>, and <footer.audio-player-bar> into
       non-overlapping grid regions at both mobile (412x915) and desktop (1280x800).
    2. Locks outer html/body scroll (scrollHeight <= clientHeight) while <main> scrolls internally.
    3. Keeps mobile Word Sync toolbar and Lexicon companion pinned cleanly inside <main> on scroll
       and verifies WordSync teleprompter scrolls <main> rather than window.scrollY.
    """
    import http.server
    import json
    import subprocess
    import tempfile
    import threading
    import time
    from deeper_dhamma.config import DIST_DIR
    from deeper_dhamma.export_web import StaticPreviewHandler

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if not chrome_path.exists():
        pytest.skip("Google Chrome not found")
    if not (DIST_DIR / "db_manifest.json").exists() or not (DIST_DIR / "index.html").exists():
        pytest.skip("Built static bundle not present in dist/")

    assert not (DIST_DIR / "index_shell.html").exists(), "Temporary index_shell.html should be pruned"
    assert not (DIST_DIR / "style_shell.css").exists(), "Temporary style_shell.css should be pruned"

    report = {}

    class ShellAuditHandler(StaticPreviewHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__shell_report":
                length = int(self.headers.get("Content-Length", 0))
                payload = self.rfile.read(length)
                report.update(json.loads(payload.decode("utf-8")))
                self.send_response(200)
                self.end_headers()
                return
            self.send_error(404)

        def do_GET(self):
            if self.path == "/__shell_host.html":
                html = r"""<!DOCTYPE html>
                <html><head><meta charset="utf-8"></head>
                <body style="margin:0;padding:0;">
                <iframe id="f" style="border:0;width:412px;height:915px;display:block;" src="about:blank"></iframe>
                <script>
                (async () => {
                  const frame = document.getElementById('f');
                  const wait = ms => new Promise(r => setTimeout(r, ms));
                  const waitFor = async (fn, timeoutMs = 45000) => {
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                      const val = fn();
                      if (val) return val;
                      await wait(80);
                    }
                    throw new Error('Timed out waiting for shell layout condition');
                  };

                  const out = { ok: false };
                  try {
                    await new Promise(res => {
                      frame.onload = () => {
                        if (frame.contentWindow.location.pathname === '/index.html') res();
                      };
                      frame.src = '/index.html';
                    });

                    const doc = frame.contentDocument;
                    const win = frame.contentWindow;
                    await waitFor(() => parseInt(doc.getElementById('browse-count-badge')?.textContent?.trim() || '0', 10) > 1000);

                    // Open search -> transcript
                    const searchInput = doc.getElementById('search-input');
                    searchInput.value = 'five hindrances';
                    searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
                    await waitFor(() => doc.querySelectorAll('#search-results-list .result-card').length > 0);
                    doc.querySelector('#search-results-list [data-action="view-transcript"]').click();
                    await waitFor(() => doc.querySelectorAll('#drawer-turns-container .transcript-turn').length > 0);
                    const txPlay = doc.getElementById('transcript-play-btn');
                    if (txPlay) txPlay.click();
                    await wait(300);

                    const mainEl = doc.getElementById('main-content');
                    const sbEl = doc.getElementById('app-sidebar');
                    const barEl = doc.getElementById('audio-player-bar');
                    const tbEl = doc.getElementById('transcript-sticky-toolbar');
                    const compEl = doc.getElementById('transcript-lexicon-companion');

                    function snapMobile() {
                      const sb = sbEl.getBoundingClientRect();
                      const main = mainEl.getBoundingClientRect();
                      const bar = barEl.getBoundingClientRect();
                      const tb = tbEl.getBoundingClientRect();
                      const comp = compEl.getBoundingClientRect();
                      return {
                        docScrollH: doc.documentElement.scrollHeight,
                        docClientH: doc.documentElement.clientHeight,
                        docScrollW: doc.documentElement.scrollWidth,
                        docClientW: doc.documentElement.clientWidth,
                        winScrollY: win.scrollY,
                        mainScrollTop: Math.round(mainEl.scrollTop),
                        mainScrollHeight: Math.round(mainEl.scrollHeight),
                        mainClientHeight: Math.round(mainEl.clientHeight),
                        sbTop: Math.round(sb.top),
                        sbBottom: Math.round(sb.bottom),
                        mainTop: Math.round(main.top),
                        mainBottom: Math.round(main.bottom),
                        barTop: Math.round(bar.top),
                        barBottom: Math.round(bar.bottom),
                        tbTop: Math.round(tb.top),
                        tbBottom: Math.round(tb.bottom),
                        compTop: Math.round(comp.top),
                        compBottom: Math.round(comp.bottom),
                      };
                    }

                    out.mobileAt0 = snapMobile();
                    mainEl.scrollTop = 1800;
                    await wait(160);
                    out.mobileAt1800 = snapMobile();

                    // Test WordSync teleprompter scrolls <main> rather than window
                    const ws = win.WordSync;
                    if (ws && ws.words && ws.words.length > 200) {
                      const targetW = ws.words[Math.floor(ws.words.length * 0.45)];
                      mainEl.scrollTop = 0;
                      await wait(80);
                      ws._userInteractedAt = 0;
                      ws.setMode('track');
                      ws.playingEpisodeId = ws.currentEpisodeId;
                      ws._teleprompterLine = null;
                      for (let f = 0; f < 40; f++) {
                        ws.update(targetW.s + 0.05);
                        await wait(16);
                      }
                      out.mobileAfterTeleprompter = snapMobile();
                    }

                    // Expand companion sheet on mobile and verify it stays bounded inside <main>
                    const toggleBtn = doc.getElementById('btn-toggle-lex-sheet');
                    toggleBtn.click();
                    await wait(350);
                    out.mobileCompanionExpanded = snapMobile();
                    toggleBtn.click();
                    await wait(200);

                    // Resize to desktop 1280x800 and verify non-overlapping sidebar | main above footer
                    frame.style.width = '1280px';
                    frame.style.height = '800px';
                    await wait(220);
                    mainEl.scrollTop = 900;
                    await wait(120);
                    const dSb = sbEl.getBoundingClientRect();
                    const dMain = mainEl.getBoundingClientRect();
                    const dBar = barEl.getBoundingClientRect();
                    const dTb = tbEl.getBoundingClientRect();
                    out.desktop = {
                      docScrollH: doc.documentElement.scrollHeight,
                      docClientH: doc.documentElement.clientHeight,
                      docScrollW: doc.documentElement.scrollWidth,
                      docClientW: doc.documentElement.clientWidth,
                      winScrollY: win.scrollY,
                      sbLeft: Math.round(dSb.left),
                      sbRight: Math.round(dSb.right),
                      sbBottom: Math.round(dSb.bottom),
                      mainLeft: Math.round(dMain.left),
                      mainTop: Math.round(dMain.top),
                      mainBottom: Math.round(dMain.bottom),
                      barTop: Math.round(dBar.top),
                      barBottom: Math.round(dBar.bottom),
                      tbTop: Math.round(dTb.top),
                    };

                    out.ok = true;
                  } catch (err) {
                    out.error = err && err.stack ? err.stack : String(err);
                  }
                  await fetch('/__shell_report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(out),
                  });
                })();
                </script>
                </body></html>"""
                body = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        lambda *args, **kwargs: ShellAuditHandler(*args, directory=str(DIST_DIR), **kwargs),
    )
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as user_dir:
            proc = subprocess.Popen([
                str(chrome_path),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                f"--user-data-dir={user_dir}",
                f"http://127.0.0.1:{port}/__shell_host.html",
            ])
            try:
                deadline = time.time() + 75.0
                while time.time() < deadline and not report:
                    time.sleep(0.25)
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

        assert report.get("ok") is True, f"Parallel shell layout audit failed: {report}"

        for key in ("mobileAt0", "mobileAt1800"):
            st = report[key]
            assert st["docScrollH"] <= st["docClientH"], f"Outer document scrolled vertically in {key}: {st}"
            assert st["docScrollW"] <= st["docClientW"], f"Horizontal overflow in {key}: {st}"
            assert st["winScrollY"] == 0, f"window.scrollY moved in {key}: {st}"
            assert st["sbTop"] == 0 and st["sbBottom"] <= st["mainTop"] + 1, f"Sidebar overlapped main in {key}: {st}"
            assert st["mainBottom"] <= st["barTop"] + 1 and st["barBottom"] == 915, f"Main overlapped footer in {key}: {st}"
            assert st["tbTop"] == st["mainTop"], f"Word sync toolbar not flush at top of main in {key}: {st}"
            assert st["compBottom"] == st["mainBottom"], f"Companion not flush at bottom of main in {key}: {st}"

        tp = report.get("mobileAfterTeleprompter")
        assert tp is not None and tp["mainScrollTop"] > 100 and tp["winScrollY"] == 0, f"Teleprompter did not scroll <main>: {tp}"

        exp = report["mobileCompanionExpanded"]
        assert exp["compTop"] >= exp["tbBottom"] - 1 and exp["compBottom"] <= exp["barTop"] + 1, (
            f"Expanded companion escaped main region: {exp}"
        )

        desk = report["desktop"]
        assert desk["docScrollH"] <= desk["docClientH"], f"Desktop outer document scrolled: {desk}"
        assert desk["docScrollW"] <= desk["docClientW"], f"Desktop horizontal overflow: {desk}"
        assert desk["winScrollY"] == 0
        assert desk["sbLeft"] == 0 and desk["sbRight"] <= desk["mainLeft"] + 1, f"Desktop sidebar overlapped main: {desk}"
        assert desk["sbBottom"] <= desk["barTop"] + 1 and desk["mainBottom"] <= desk["barTop"] + 1 and desk["barBottom"] == 800
        assert desk["tbTop"] == desk["mainTop"], f"Desktop sticky toolbar not pinned at top of main: {desk}"
    finally:
        server.shutdown()
        server.server_close()



def test_deploy_to_github_pages_excludes_staging_raw_db_and_crlf_warnings(tmp_path: Path, monkeypatch, capfd):
    """
    Verifies export_static_site() prunes stale files and deploy_to_github_pages():
    1. Excludes .build_stage_* and raw *.db files even if manually present in dist/.
    2. Emits zero Git LF->CRLF warnings even when core.autocrlf=true on Windows.
    3. Validates required manifest shards are staged and aborts before pushing >= 100 MB files.
    """
    import json
    import os
    import subprocess
    import time
    from deeper_dhamma.export_web import deploy_to_github_pages, export_static_site

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    subprocess.run(["git", "init", str(repo_dir)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "-C", str(repo_dir), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "config", "core.autocrlf", "true"], check=True)
    (repo_dir / ".gitignore").write_text("dist/\n*.db\n", encoding="utf-8", newline="\n")

    remote_bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote_bare)], check=True, stdout=subprocess.DEVNULL)

    dist_dir = repo_dir / "dist"
    dist_dir.mkdir()

    # Verify export_static_site prunes arbitrary leftover files/dirs after compiling
    stale_dir = dist_dir / ".build_stage_8316"
    stale_dir.mkdir()
    (stale_dir / "talks_2.db").write_bytes(b"old-stage")
    stale_file = dist_dir / "obsolete_asset.txt"
    stale_file.write_text("stale", encoding="utf-8")

    monkeypatch.setattr(
        "deeper_dhamma.export_web.compile_sharded_static_databases",
        lambda out_d, version_int, show_progress=True: (
            (Path(out_d) / "core.db.gz").write_bytes(b"\x1f\x8bcore"),
            (Path(out_d) / "talks_1.db.gz").write_bytes(b"\x1f\x8bt1"),
            (Path(out_d) / "words_1.db.gz").write_bytes(b"\x1f\x8bw1"),
            (Path(out_d) / "db_manifest.json").write_text(
                json.dumps({
                    "format": "sharded_v1",
                    "version": version_int,
                    "core": {"file": "core.db.gz", "gz_bytes": 6, "raw_bytes": 10},
                    "talks": [{"file": "talks_1.db.gz", "gz_bytes": 4, "raw_bytes": 8, "episodes": 1}],
                    "words": [{"file": "words_1.db.gz", "gz_bytes": 4, "raw_bytes": 8, "episodes": 1}],
                }),
                encoding="utf-8",
            ),
            {
                "version": version_int,
                "size_bytes": 14,
                "raw_size_bytes": 26,
                "episodes": 1,
                "transcribed_episodes": 1,
                "segments": 1,
                "terms": 1,
                "words": 1,
                "manifest": {
                    "core": {"file": "core.db.gz", "gz_bytes": 6, "raw_bytes": 10},
                    "talks": [{"file": "talks_1.db.gz", "gz_bytes": 4, "raw_bytes": 8, "episodes": 1}],
                    "words": [{"file": "words_1.db.gz", "gz_bytes": 4, "raw_bytes": 8, "episodes": 1}],
                },
            },
        )[-1],
    )
    export_static_site(dist_dir, show_progress=False)
    assert not stale_dir.exists(), "export_static_site must prune leftover staging directories"
    assert not stale_file.exists(), "export_static_site must prune leftover obsolete files"
    assert (dist_dir / "index.html").exists()

    # Re-plant a stray staging dir & raw .db file right before deploy to verify deploy exclusions too
    future_ts = time.time() + 3600
    for p in dist_dir.iterdir():
        if p.is_file():
            os.utime(p, (future_ts, future_ts))
    stale_stage = dist_dir / ".build_stage_999999"
    stale_stage.mkdir()
    (stale_stage / "talks_2.db").write_bytes(b"raw-sqlite-leaked")
    (stale_stage / "talks_3.db-journal").write_bytes(b"journal")
    (dist_dir / "stray.db").write_bytes(b"raw-stray")

    monkeypatch.setattr("deeper_dhamma.export_web._is_dist_stale", lambda _p: False)
    capfd.readouterr()

    deploy_to_github_pages(
        dist_dir=dist_dir,
        remote=str(remote_bare),
        branch="gh-pages",
        repo_root=repo_dir,
    )

    captured = capfd.readouterr()
    assert "LF will be replaced by CRLF" not in captured.err
    assert "LF will be replaced by CRLF" not in captured.out

    tree_out = subprocess.check_output(
        ["git", "--git-dir", str(remote_bare), "ls-tree", "-r", "--name-only", "refs/heads/gh-pages"],
        text=True,
    )
    deployed_files = set(tree_out.splitlines())
    assert "index.html" in deployed_files
    assert "index_shell.html" not in deployed_files
    assert "style_shell.css" not in deployed_files
    assert "core.db.gz" in deployed_files
    assert "talks_1.db.gz" in deployed_files
    assert "words_1.db.gz" in deployed_files
    assert not any(".build_stage_" in f for f in deployed_files)
    assert not any(f.endswith((".db", ".db-journal")) for f in deployed_files)

    # Verify LF preserved without autocrlf mangling
    app_blob = subprocess.check_output(
        ["git", "--git-dir", str(remote_bare), "show", "refs/heads/gh-pages:app.js"],
    )
    assert b"\r\n" not in app_blob

    # Verify hard error before pushing if a staged file >= 100 MB
    monkeypatch.setattr("deeper_dhamma.export_web._GITHUB_HARD_MAX_BYTES", 1024)
    (dist_dir / "words_1.db.gz").write_bytes(b"x" * 2048)
    with pytest.raises(RuntimeError, match="Refusing to deploy"):
        deploy_to_github_pages(
            dist_dir=dist_dir,
            remote=str(remote_bare),
            branch="gh-pages",
            repo_root=repo_dir,
        )


def test_export_static_site_static_only_preserves_db_and_updates_assets(tmp_path, monkeypatch):
    """Verifies static_only=True skips DB compilation, preserves existing shards, and updates static assets."""
    import json
    from deeper_dhamma.export_web import _is_dist_stale, export_static_site

    dist_dir = tmp_path / "dist"
    dist_dir.mkdir()

    manifest = {
        "format": "sharded_v1",
        "version": 1700000000,
        "core": {"id": "core", "file": "core.db.gz"},
        "talks": [{"id": 1, "file": "talks_1.db.gz"}],
        "words": [{"id": 1, "file": "words_1.db.gz"}],
        "episodes": 4242,
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    (dist_dir / "db_manifest.json").write_bytes(manifest_bytes)
    (dist_dir / "core.db.gz").write_bytes(b"core-shard-bytes")
    (dist_dir / "talks_1.db.gz").write_bytes(b"talks-shard-bytes")
    (dist_dir / "words_1.db.gz").write_bytes(b"words-shard-bytes")
    (dist_dir / "stale_old_asset.txt").write_text("remove me", encoding="utf-8")

    def fail_compile(*_args, **_kwargs):
        raise AssertionError("compile_sharded_static_databases must not be called when static_only=True")

    monkeypatch.setattr("deeper_dhamma.export_web.compile_sharded_static_databases", fail_compile)
    monkeypatch.setattr("deeper_dhamma.export_web.ensure_wasm_assets", lambda _p: None)

    result_path = export_static_site(output_dir=dist_dir, static_only=True)
    assert result_path == dist_dir.resolve()

    # Existing DB bundle is untouched
    assert (dist_dir / "db_manifest.json").read_bytes() == manifest_bytes
    assert (dist_dir / "core.db.gz").read_bytes() == b"core-shard-bytes"
    assert (dist_dir / "talks_1.db.gz").read_bytes() == b"talks-shard-bytes"
    assert (dist_dir / "words_1.db.gz").read_bytes() == b"words-shard-bytes"

    # Obsolete non-bundle file is pruned, static assets and rendered HTML/SW are updated
    assert not (dist_dir / "stale_old_asset.txt").exists()
    index_html = (dist_dir / "index.html").read_text(encoding="utf-8")
    assert "{{db_version}}" not in index_html
    assert "{{total_episodes}}" not in index_html
    assert "__DEEPER_DHAMMA_VERSION__" in index_html
    assert (dist_dir / "404.html").read_text(encoding="utf-8") == index_html
    sw_js = (dist_dir / "svc_worker.js").read_text(encoding="utf-8")
    assert "{{db_version}}" not in sw_js
    assert (dist_dir / "icons").is_dir()

    # With up-to-date DBs, _is_dist_stale should be False after static_only build
    monkeypatch.setattr("deeper_dhamma.export_web.TRANSCRIPTS_DB_PATH", tmp_path / "missing_t.db")
    monkeypatch.setattr("deeper_dhamma.export_web.BUDDHISM_LEXICON_DB_PATH", tmp_path / "missing_l.db")
    assert _is_dist_stale(dist_dir) is False


def test_export_static_site_static_only_requires_existing_bundle(tmp_path):
    """Verifies static_only=True fails clearly when db_manifest.json or shards are missing."""
    from deeper_dhamma.export_web import export_static_site

    with pytest.raises(FileNotFoundError, match="web --build"):
        export_static_site(output_dir=tmp_path, static_only=True)

