"""
Unit tests for Static Web Application & SQLite WASM Compiler.
"""

from pathlib import Path
import sqlite3
import struct
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
    app_js = (web_dir / "static" / "app.js").read_text(encoding="utf-8")
    card_physics_js = (web_dir / "static" / "card_physics.js").read_text(encoding="utf-8")
    db_worker_js = (web_dir / "static" / "db_worker.js").read_text(encoding="utf-8")
    wasm_client_js = (web_dir / "static" / "adapters" / "wasm_client.js").read_text(encoding="utf-8")
    db_client_js = (web_dir / "static" / "db_client.js").read_text(encoding="utf-8")
    svc_worker_js = (web_dir / "static" / "svc_worker.js").read_text(encoding="utf-8")
    style_css = (web_dir / "static" / "style.css").read_text(encoding="utf-8")

    # 1. Navigation & View elements in index.html
    assert 'id="tab-bookmarks-btn"' in index_html, "Must have bookmarks nav tab"
    assert 'data-tab="bookmarks-view"' in index_html, "Must point to bookmarks-view"
    assert 'id="bookmarks-count-badge"' in index_html, "Must have bookmarks counter badge"
    assert 'id="bookmarks-view"' in index_html, "Must have bookmarks-view panel"
    assert 'id="bookmarks-list"' in index_html, "Must have bookmarks-list container"
    assert 'id="transcript-bookmark-btn"' in index_html, "Must have transcript drawer bookmark button"
    assert 'id="btn-player-bookmark"' in index_html, "Must have audio player bar bookmark button"
    assert 'card_physics.js' in index_html, "Must load decoupled card_physics.js engine"
    assert '__DEEPER_DHAMMA_VERSION__' in index_html, "Must stamp global version in index.html"
    assert '__DEEPER_DHAMMA_VERSION__' in wasm_client_js, "Must propagate version query to db_worker.js"
    assert 'card_physics.js' in svc_worker_js, "Must cache card_physics.js in svc_worker.js"

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

    # 4. BookmarkStore & reordering integration in app.js
    assert "BookmarkStore" in app_js
    assert "deeper_dhamma_bookmarks" in app_js
    assert "renderBookmarkRibbonSvg" in app_js
    assert "bookmark-ribbon-icon" in app_js
    assert "loadBookmarksView" in app_js
    assert "renderBookmarksList" in app_js
    assert "Waiting for database to load..." in app_js
    assert "moveUp(" in app_js
    assert "moveDown(" in app_js
    assert "moveRelativeTo(" in app_js
    assert "CardPhysics" in app_js
    assert "bookmarkPhysics" in app_js
    assert "bookmark-floating-drag-card" in app_js
    assert "bookmark-drop-indicator" in app_js
    assert "is-ghost" in app_js
    assert "bookmark-order-badge" in app_js
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
    card_physics_js = (web_dir / "static" / "card_physics.js").read_text(encoding="utf-8")

    # 1. Verify app.js dynamic state synchronization
    assert "bookmarkEpisodes:" in app_js, "state must define bookmarkEpisodes"
    assert "state.bookmarkEpisodes = " in app_js, "Must store episodes on state"
    assert "BookmarkStore.getAll().map(id => epMap.get(id)).filter(Boolean)" in app_js, (
        "Must resequence state.bookmarkEpisodes from BookmarkStore.getAll() in onExchange and onReorder"
    )
    assert "renderBookmarksList(state.bookmarkEpisodes)" in app_js, (
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
    app_js = (web_dir / "static" / "app.js").read_text(encoding="utf-8")
    card_physics_js = (web_dir / "static" / "card_physics.js").read_text(encoding="utf-8")
    style_css = (web_dir / "static" / "style.css").read_text(encoding="utf-8")

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
    style_css = (web_dir / "static" / "style.css").read_text(encoding="utf-8")

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
    assert "3,246 English" in index_html, "Must specify 3,246 English talks"
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
    assert len(manifest["words"]) == 2

    # Every file (both gzipped and uncompressed) must stay strictly below GitHub's 100 MB limit
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
    assert max_gz < 100 * 1024 * 1024, f"Gzipped shard exceeds 100 MB: {max_gz}"

    # Verify pb28113880 routing from core -> talks & words shards
    core_p = tmp_path / "verify_core.db"
    core_p.write_bytes(gzip.decompress((tmp_path / manifest["core"]["file"]).read_bytes()))
    c_conn = sqlite3.connect(core_p)
    try:
        row = c_conn.execute("SELECT talks_shard, words_shard FROM episodes WHERE id = 'pb28113880';").fetchone()
        assert row is not None and row[0] in (1, 2, 3, 4) and row[1] in (1, 2)
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
    assert (static_dir / "icons" / "icon_192.png").exists()
    assert (static_dir / "icons" / "icon_512.png").exists()
    assert (static_dir / "icons" / "apple_touch_icon.png").exists()
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
    app_js = (web_dir / "static" / "app.js").read_text(encoding="utf-8")
    worker_js = (web_dir / "static" / "db_worker.js").read_text(encoding="utf-8")
    style_css = (web_dir / "static" / "style.css").read_text(encoding="utf-8")

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
    assert "APP_SEARCH_STOPWORDS" in app_js
    assert "updateSearchPagination" in app_js
    assert "episodeLimit" in app_js
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
                deadline = time.time() + 50.0
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
                deadline = time.time() + 50.0
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
