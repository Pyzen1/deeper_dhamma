"""Unit tests for Material Symbols playbar icons, self-hosted font fallback, and track-switch transcript sync."""

from __future__ import annotations

import re
from pathlib import Path

from deeper_dhamma.export_web import export_static_site

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = PROJECT_ROOT / "deeper_dhamma" / "web"
STATIC_DIR = WEB_DIR / "static"
INDEX_HTML = WEB_DIR / "views" / "index.html"
STYLE_PLAYER_CSS = STATIC_DIR / "style_player.css"
AUDIO_PLAYER_JS = STATIC_DIR / "audio_player.js"
SPEAKER_PALETTE_JS = STATIC_DIR / "speaker_palette.js"
SVC_WORKER_JS = STATIC_DIR / "svc_worker.js"
FONT_WOFF2 = STATIC_DIR / "fonts" / "material_symbols_outlined.woff2"


def test_playbar_uses_material_symbols_without_legacy_fluent_markup():
    html = INDEX_HTML.read_text(encoding="utf-8")

    assert "fonts.googleapis.com/css2?family=Material+Symbols+Outlined" in html
    assert "fluent-skip-back" not in html
    assert "fluent-rewind" not in html
    assert "fluent-play" not in html
    assert "fluent-fast-forward" not in html
    assert "fluent-skip-fwd" not in html

    expected_buttons = {
        "btn-prev-track": "skip_previous",
        "btn-skip-back": "fast_rewind",
        "btn-play-pause": "play_arrow",
        "btn-skip-fwd": "fast_forward",
        "btn-next-track": "skip_next",
    }
    for btn_id, icon_name in expected_buttons.items():
        pattern = rf'id="{btn_id}"[^>]*>\s*<span class="material-symbols-outlined"[^>]*>{icon_name}</span>'
        assert re.search(pattern, html), f"Missing Material Symbol '{icon_name}' for #{btn_id}"


def test_self_hosted_font_fallback_exists_and_is_precached():
    assert FONT_WOFF2.exists(), "Self-hosted material_symbols_outlined.woff2 must exist"
    assert FONT_WOFF2.stat().st_size > 100_000

    css = STYLE_PLAYER_CSS.read_text(encoding="utf-8")
    assert "font-family: 'Material Symbols Outlined Fallback'" in css
    assert "url('./fonts/material_symbols_outlined.woff2')" in css
    assert "font-family: 'Material Symbols Outlined', 'Material Symbols Outlined Fallback'" in css
    assert ".btn-ctl .material-symbols-outlined" in css
    assert ".btn-ctl-main .material-symbols-outlined" in css

    sw = SVC_WORKER_JS.read_text(encoding="utf-8")
    assert "'./fonts/material_symbols_outlined.woff2'" in sw


def test_legacy_playbar_fluent_icons_removed_from_js_and_css():
    palette_js = SPEAKER_PALETTE_JS.read_text(encoding="utf-8")
    for removed_key in ("play:", "pause:", "rewind:", "fastForward:", "skipBack:", "skipFwd:"):
        assert removed_key not in palette_js
    for kept_key in ("speakerHigh:", "speakerLow:", "speakerMute:"):
        assert kept_key in palette_js

    css = STYLE_PLAYER_CSS.read_text(encoding="utf-8")
    assert ".fluent-frame" not in css
    assert ".fluent-symbol" not in css


def test_audio_player_toggles_material_symbol_and_syncs_transcript_on_track_change():
    js = AUDIO_PLAYER_JS.read_text(encoding="utf-8")

    assert "iconSpan.textContent = 'pause'" in js
    assert "iconSpan.textContent = 'play_arrow'" in js
    assert "FLUENT_ICONS.play" not in js
    assert "FLUENT_ICONS.pause" not in js

    assert "function switchToCatalogEpisode(ep)" in js
    assert "state.activeTab === 'transcript-view'" in js
    assert "DD.openTranscriptDrawer(epId)" in js


def test_export_static_site_copies_fonts_directory(tmp_path, monkeypatch):
    dist_dir = tmp_path / "dist"

    def fake_shards(out_dir, version_int, show_progress=True):
        out_path = Path(out_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        for name in ("core.db.gz", "talks_1.db.gz", "words_1.db.gz", "db_manifest.json"):
            (out_path / name).write_bytes(b"stub")
        manifest = {
            "version": version_int,
            "core": {"file": "core.db.gz", "gz_bytes": 4, "raw_bytes": 8},
            "talks": [{"file": "talks_1.db.gz", "gz_bytes": 4, "raw_bytes": 8, "episodes": 1}],
            "words": [{"file": "words_1.db.gz", "gz_bytes": 4, "raw_bytes": 8, "episodes": 1}],
        }
        return {
            "episodes": 1,
            "transcribed_episodes": 1,
            "segments": 10,
            "terms": 5,
            "size_bytes": 12,
            "raw_size_bytes": 24,
            "manifest": manifest,
        }

    monkeypatch.setattr("deeper_dhamma.export_web.compile_sharded_static_databases", fake_shards)
    export_static_site(dist_dir, show_progress=False)

    exported_font = dist_dir / "fonts" / "material_symbols_outlined.woff2"
    assert exported_font.exists(), "export_static_site must copy fonts/material_symbols_outlined.woff2 to dist/"
    assert exported_font.stat().st_size == FONT_WOFF2.stat().st_size
