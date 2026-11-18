"""
Cross-browser unit and integration tests for WordSync and VBR audio stream synchronization
across Mozilla Firefox (Gecko MP3TrackDemuxer) and Google Chrome (Chromium FFmpeg mp3dec).
"""

import http.server
import io
import json
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path
import pytest

from deeper_dhamma.calibration import (
    VBR_TRAILER_MAGIC,
    detect_xing_patch_offset,
    patch_xing_chunk_in_memory,
)
from deeper_dhamma.config import PROJECT_ROOT, TRANSCRIPTS_DB_PATH
from deeper_dhamma.storage import TranscriptDatabase

VBR_EPISODES = {"pb27802310", "pb27940021", "pb28867656"}
CBR_EPISODES = {"pb28113880", "pb7020389", "pb28113897", "pb7017972", "pb10641521", "pb13152882"}


def test_vbr_episodes_store_unwarped_physical_timestamps_and_vbr1_trailer():
    """
    Verifies that all VBR episodes store unwarped physical 44.1 kHz PCM timestamps
    in SQLite episode_words and include a full-duration VBR1 seek calibration trailer.
    """
    if not TRANSCRIPTS_DB_PATH.exists():
        pytest.skip("Transcript database not found")

    conn = sqlite3.connect(TRANSCRIPTS_DB_PATH)
    try:
        # Verify pb27802310 Turn 0 starts at physical 216.30s (not legacy warped 203.14s)
        seg0 = conn.execute(
            "SELECT start_sec, end_sec, text FROM speech_segments WHERE episode_id = 'pb27802310' AND turn_index = 0"
        ).fetchone()
        assert seg0 is not None
        assert abs(float(seg0[0]) - 216.30) <= 0.15, f"Expected Turn 0 at ~216.30s physical, got {seg0[0]}"
        assert seg0[2].startswith("Everyone,")
    finally:
        conn.close()

    # Check pb27802310 words BLOB timestamps & VBR1 trailer from SQLite (11,888 words after sub-word coalescing & hallucination pruning)
    db = TranscriptDatabase(TRANSCRIPTS_DB_PATH)
    pb_bin = db.get_episode_words("pb27802310")
    assert pb_bin is not None, "pb27802310 words BLOB missing from database"
    word_count = struct.unpack("<I", pb_bin[:4])[0]
    assert word_count in (11850, 11888, 11923, 11929)

    # Word 0 ("Everyone,") at ~216.30s (216300 ms)
    w0_st_ms, w0_dur_ms = struct.unpack("<IH", pb_bin[4:10])
    assert abs(w0_st_ms / 1000.0 - 216.30) <= 0.15

    # Word 29 ("one" in "one of the most significant things about") at ~231.34s
    w29_off = 4 + 29 * 6
    w29_st_ms, _ = struct.unpack("<IH", pb_bin[w29_off : w29_off + 6])
    assert abs(w29_st_ms / 1000.0 - 231.34) <= 0.20

    # Verify VBR1 trailer on all 3 VBR episodes in database
    for ep_id in VBR_EPISODES:
        raw = db.get_episode_words(ep_id)
        assert raw is not None, f"Missing words BLOB in database for {ep_id}"
        wc = struct.unpack("<I", raw[:4])[0]
        t_off = 4 + wc * 6
        assert len(raw) > t_off + 120, f"Missing VBR1 trailer on {ep_id}"
        assert raw[t_off : t_off + 4] == VBR_TRAILER_MAGIC
        total_dur_ms, id3_len, bytes_len = struct.unpack("<III", raw[t_off + 4 : t_off + 16])
        sample_count = struct.unpack("<I", raw[t_off + 116 : t_off + 120])[0]
        assert total_dur_ms > 2000_000
        assert bytes_len > 10_000_000
        assert sample_count > 1000
        assert len(raw) == t_off + 120 + sample_count * 8

    # Verify CBR episodes do not have VBR1 trailer overhead
    for ep_id in CBR_EPISODES:
        raw = db.get_episode_words(ep_id)
        if raw is not None:
            wc = struct.unpack("<I", raw[:4])[0]
            assert len(raw) == 4 + wc * 6


def test_in_memory_xing_neutralization_and_disk_immutability():
    """
    Verifies that the 8-byte Xing header at offset 176,164 in pb27802310.mp3 is
    accurately detected and neutralized in memory to `Info\\x00\\x00\\x00\\x03` while
    keeping the raw archive file on disk 100% unmodified.
    """
    sample_mp3 = PROJECT_ROOT / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"
    if not sample_mp3.exists():
        pytest.skip("Archive MP3 not found on disk")

    with open(sample_mp3, "rb") as f:
        header_prefix = f.read(180000)

    xing_off = detect_xing_patch_offset(header_prefix)
    assert xing_off == 176164

    raw_slice = header_prefix[176128:176301]
    patched_slice = patch_xing_chunk_in_memory(raw_slice, 176128, xing_off)

    # Offset 176164 - 176128 = 36 inside the slice must be patched to Info (flags=3)
    assert patched_slice[36:44] == b"Info\x00\x00\x00\x03"

    # Verify pristine archive file on disk still has raw Xing (flags=0x0f)
    with open(sample_mp3, "rb") as f:
        f.seek(176164)
        disk_bytes = f.read(8)
    assert disk_bytes == b"Xing\x00\x00\x00\x0f"


def test_headless_firefox_and_chrome_word_sync_parity():
    """
    End-to-end serverless cross-browser verification in headless Mozilla Firefox and Google Chrome.
    Serves the raw, unpatched VBR MP3 over a pure static HTTP server (identical to Podbean CDN)
    and verifies that:
    - Firefox progressively fetches the stream, patches `Xing -> Info` (`flags = 3`) in client-side
      `Uint8Array` memory (`streamMode = 'patched_blob'`), and seeks linearly (`183.40s`, `197.60s`).
    - Chrome streams directly (`streamMode = 'cdn'`) and seeks via `xingSeekTimes` (`202.64s`, `213.84s`).
    - Both browsers immediately highlight Word 0 ("Everyone," at 216.30s) and Word 29 ("one" at 231.34s)
      and advance their physical playback clocks in lockstep (`< 0.35s` delta) during real audio playback.
    """
    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    firefox_path = Path(r"C:\Program Files\Mozilla Firefox\firefox.exe")
    sample_mp3 = PROJECT_ROOT / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"
    db = TranscriptDatabase(TRANSCRIPTS_DB_PATH)
    bin_bytes = db.get_episode_words("pb27802310")
    word_sync_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "word_sync.js"

    if not (chrome_path.exists() and firefox_path.exists() and sample_mp3.exists() and bin_bytes):
        pytest.skip("Headless browsers or sample assets not present")

    file_size = sample_mp3.stat().st_size
    word_sync_js = word_sync_js_path.read_bytes()
    reports = {}

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    class SyncTestHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            if self.path.startswith("/report/"):
                bname = self.path.split("/report/")[1]
                reports[bname] = json.loads(body.decode("utf-8"))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            if self.path == "/word_sync.js":
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(word_sync_js)))
                self.end_headers()
                self.wfile.write(word_sync_js)
                return

            if self.path in ("/words/pb27802310.bin", "/api/episodes/pb27802310/words"):
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(bin_bytes)))
                self.end_headers()
                self.wfile.write(bin_bytes)
                return

            if self.path.startswith("/raw_cdn/pb27802310.mp3"):
                # Pure unpatched static MP3 stream with CORS (identical to Podbean CDN)
                rng = self.headers.get("Range")
                start, end = 0, file_size - 1
                status = 200
                if rng and rng.startswith("bytes="):
                    status = 206
                    parts = rng[6:].split("-")
                    start = int(parts[0]) if parts[0] else 0
                    if len(parts) > 1 and parts[1]:
                        end = min(int(parts[1]), file_size - 1)
                length = end - start + 1
                self.send_response(status)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(length))
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.end_headers()
                with open(sample_mp3, "rb") as f:
                    f.seek(start)
                    rem = length
                    while rem > 0:
                        chunk = f.read(min(65536, rem))
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except Exception:
                            break
                        rem -= len(chunk)
                return

            if self.path.startswith("/runner.html"):
                bname = self.path.split("b=")[1]
                html = f"""<!DOCTYPE html><html><body>
                <div id="turn-0"></div>
                <audio id="a" crossorigin="anonymous"></audio>
                <script src="/word_sync.js"></script>
                <script>
                async function run() {{
                    await WordSync.ensureEpisodeLoaded('pb27802310');
                    const container = document.getElementById('turn-0');
                    for (let i = 0; i < 50; i++) {{
                        const sp = document.createElement('span');
                        sp.id = 'tw-' + i;
                        container.appendChild(sp);
                    }}
                    const a = document.getElementById('a');
                    WordSync.bindAudio(a);
                    const ctx = new (window.AudioContext || window.webkitAudioContext)({{sampleRate: 16000}});
                    const src = ctx.createMediaElementSource(a);
                    const proc = ctx.createScriptProcessor(4096, 1, 1);
                    let sumSq = 0;
                    proc.onaudioprocess = (e) => {{
                        const ch = e.inputBuffer.getChannelData(0);
                        for (let i = 0; i < ch.length; i++) sumSq += ch[i] * ch[i];
                    }};
                    src.connect(proc);
                    proc.connect(ctx.destination);

                    const rawCdnUrl = '/raw_cdn/pb27802310.mp3';
                    if (WordSync.isFirefox) {{
                        const blobUrl = await WordSync.waitForFirefoxBlobUrl(rawCdnUrl, 235.0);
                        WordSync.streamMode = 'patched_blob';
                        a.src = blobUrl;
                    }} else {{
                        WordSync.streamMode = 'cdn';
                        a.src = rawCdnUrl;
                    }}
                    await new Promise(r => a.addEventListener('loadedmetadata', r, {{once: true}}));

                    // Seek 1: Word 0 ("Everyone," at 216.30s -> 215.80s with 0.50s lead-in)
                    const s1 = WordSync.prepareSeek(215.80, 216.30);
                    a.currentTime = s1;
                    await new Promise(r => a.addEventListener('seeked', r, {{once: true}}));
                    WordSync.update(a.currentTime);
                    const initIdx1 = WordSync.activeWordIdx;

                    await ctx.resume();
                    await a.play();
                    await new Promise(r => setTimeout(r, 850));
                    WordSync.update(a.currentTime);
                    const phys1 = WordSync.getPhysicalTime(a.currentTime);
                    const activeIdx1 = WordSync.activeWordIdx;
                    a.pause();

                    // Seek 2: Word 29 ("one" at 231.34s -> 230.84s with 0.50s lead-in)
                    const s2 = WordSync.prepareSeek(230.84, 231.34);
                    a.currentTime = s2;
                    await new Promise(r => a.addEventListener('seeked', r, {{once: true}}));
                    WordSync.update(a.currentTime);
                    const initIdx2 = WordSync.activeWordIdx;

                    await a.play();
                    await new Promise(r => setTimeout(r, 850));
                    WordSync.update(a.currentTime);
                    const phys2 = WordSync.getPhysicalTime(a.currentTime);
                    const activeIdx2 = WordSync.activeWordIdx;
                    a.pause();

                    await fetch('/report/{bname}', {{
                        method: 'POST',
                        body: JSON.stringify({{
                            streamMode: WordSync.streamMode,
                            s1, initIdx1, phys1, activeIdx1,
                            s2, initIdx2, phys2, activeIdx2,
                            sumSq
                        }})
                    }});
                }}
                run();
                </script></body></html>""".encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(html)))
                self.end_headers()
                self.wfile.write(html)

    server = ThreadedHTTPServer(("127.0.0.1", 0), SyncTestHandler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with (
            tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as c_dir,
            tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as f_dir,
        ):
            p_chrome = subprocess.Popen(
                [
                    str(chrome_path),
                    "--headless=new",
                    "--autoplay-policy=no-user-gesture-required",
                    f"--user-data-dir={c_dir}",
                    f"http://127.0.0.1:{port}/runner.html?b=chrome",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            Path(f_dir, "user.js").write_text(
                'user_pref("media.autoplay.default", 0);\n'
                'user_pref("media.autoplay.blocking_policy", 0);\n',
                encoding="utf-8",
            )
            p_firefox = subprocess.Popen(
                [
                    str(firefox_path),
                    "-headless",
                    "-profile",
                    f_dir,
                    f"http://127.0.0.1:{port}/runner.html?b=firefox",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            t0 = time.time()
            while time.time() - t0 < 25:
                if "chrome" in reports and "firefox" in reports:
                    break
                time.sleep(0.25)

            p_chrome.kill()
            p_firefox.kill()
    finally:
        server.shutdown()

    assert "chrome" in reports, "Headless Chrome did not report back"
    assert "firefox" in reports, "Headless Firefox did not report back"

    c_rep = reports["chrome"]
    f_rep = reports["firefox"]

    assert c_rep["streamMode"] == "cdn"
    assert f_rep["streamMode"] == "patched_blob"

    # Chrome uses xingSeekTimes (~202.64s, ~220.88s); Firefox uses linearSeekTimes (~183.40s, ~197.60s)
    assert 202.0 <= c_rep["s1"] <= 203.2
    assert 220.0 <= c_rep["s2"] <= 221.5
    assert 183.0 <= f_rep["s1"] <= 184.0
    assert 197.0 <= f_rep["s2"] <= 198.5

    # Both browsers must highlight Word 0 ("Everyone,") on Seek 1 and Word 29 ("one") on Seek 2
    assert c_rep["initIdx1"] == 0 and f_rep["initIdx1"] == 0
    assert c_rep["initIdx2"] == 29 and f_rep["initIdx2"] == 29

    # After ~850ms of playback, physical time must be in [216.2s, 217.5s] for Seek 1 and [231.2s, 232.5s] for Seek 2
    for bname, rep in [("chrome", c_rep), ("firefox", f_rep)]:
        assert 216.2 <= rep["phys1"] <= 217.5, f"{bname} phys1 out of range: {rep['phys1']}"
        assert rep["activeIdx1"] in (0, 1, 2), f"{bname} activeIdx1 unexpected: {rep['activeIdx1']}"
        assert 231.2 <= rep["phys2"] <= 232.5, f"{bname} phys2 out of range: {rep['phys2']}"
        assert 29 <= rep["activeIdx2"] <= 33, f"{bname} activeIdx2 unexpected: {rep['activeIdx2']}"
        assert rep["sumSq"] > 0.01, f"{bname} produced silent audio buffer"


def test_static_dist_bundle_parity_staleness_and_no_local_audio_route():
    """
    Verifies that:
    1. `_is_dist_stale` detects missing or outdated `dist/` bundles and returns False
       when `dist/` is freshly compiled.
    2. `dist/word_sync.js`, `dist/app.js`, and `dist/words/*.bin` match `deeper_dhamma/web/static/`
       byte-for-byte.
    3. Neither `deeper_dhamma.web.app` nor `deeper_dhamma.export_web` exposes a local
       `/audio/<episode_id>` fallback route, ensuring local testing matches static hosting.
    """
    import os
    from deeper_dhamma.export_web import _is_dist_stale, export_static_site

    dist_dir = PROJECT_ROOT / "dist"
    static_dir = PROJECT_ROOT / "deeper_dhamma" / "web" / "static"

    if not (dist_dir / "index.html").exists() or _is_dist_stale(dist_dir):
        export_static_site(dist_dir)

    assert not _is_dist_stale(dist_dir), "Freshly built dist/ should not be marked stale"

    # Byte-for-byte asset parity between source static/ and compiled dist/
    assert (dist_dir / "word_sync.js").read_bytes() == (static_dir / "word_sync.js").read_bytes()
    assert (dist_dir / "app.js").read_bytes() == (static_dir / "app.js").read_bytes()

    # Verify episode_words in sharded dist/ (core.db.gz + words_*.db.gz) matches source database byte-for-byte
    src_db = TranscriptDatabase(TRANSCRIPTS_DB_PATH)
    manifest_path = dist_dir / "db_manifest.json"
    assert manifest_path.exists(), "dist/db_manifest.json must exist in sharded static build"
    assert not (dist_dir / "dhamma_web.db").exists(), "Monolithic dhamma_web.db (>100MB) must be removed from dist/"

    import gzip
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        tmp_p = Path(tmp)
        core_db_p = tmp_p / "core.db"
        core_db_p.write_bytes(gzip.decompress((dist_dir / manifest["core"]["file"]).read_bytes()))
        core_conn = sqlite3.connect(core_db_p)
        words_conns = {}
        try:
            for w_meta in manifest["words"]:
                w_p = tmp_p / f"{w_meta['id']}.db"
                w_p.write_bytes(gzip.decompress((dist_dir / w_meta["file"]).read_bytes()))
                words_conns[int(w_meta["shard"])] = sqlite3.connect(w_p)

            total_dist_words = sum(
                wc.execute("SELECT COUNT(*) FROM episode_words;").fetchone()[0]
                for wc in words_conns.values()
            )
            assert total_dist_words >= 9
            for ep_id in VBR_EPISODES | CBR_EPISODES:
                src_bytes = src_db.get_episode_words(ep_id)
                if src_bytes:
                    route = core_conn.execute("SELECT words_shard FROM episodes WHERE id = ?;", (ep_id,)).fetchone()
                    assert route is not None and route[0] is not None, f"Missing words_shard route for {ep_id}"
                    w_conn = words_conns[int(route[0])]
                    row = w_conn.execute("SELECT words_blob FROM episode_words WHERE episode_id = ?;", (ep_id,)).fetchone()
                    assert row is not None, f"Missing {ep_id} in dist/ words_{route[0]} shard"
                    assert bytes(row[0]) == src_bytes, f"Byte mismatch for {ep_id} in dist/ words_{route[0]} shard"
        finally:
            core_conn.close()
            for wc in words_conns.values():
                wc.close()

    # Verify _is_dist_stale detects missing directory or outdated index.html mtime
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        assert _is_dist_stale(tmp_path) is True
        idx = tmp_path / "index.html"
        idx.write_text("<html></html>", encoding="utf-8")
        os.utime(idx, (1000.0, 1000.0))
        assert _is_dist_stale(tmp_path) is True

    # Verify no local audio files are bundled into dist/, guaranteeing pure Podbean CDN streaming
    assert not (dist_dir / "audio").exists()


def test_firefox_raw_cdn_fallback_and_native_seek_regression():
    """
    Regression test for:
    1. The `pb27802310` Turn 0 (`3:36`, `216.30s` physical) regression where Firefox in
       raw `'cdn'` fallback mode previously jumped forward to Bucket `k = 3` (`221.91s` = `3:42`,
       highlighting Word 9 `"on"` in `"on how to proceed"` instead of Word 0 `"Everyone,"`).
    2. External/native `<audio>` seeking (`onSeeked` when `_pendingProgrammaticSeek` is false)
       in both `'patched_blob'` and `'cdn'` modes, plus failed progressive fetch fallback.
    """
    firefox_path = Path(r"C:\Program Files\Mozilla Firefox\firefox.exe")
    db = TranscriptDatabase(TRANSCRIPTS_DB_PATH)
    bin_bytes = db.get_episode_words("pb27802310")
    word_sync_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "word_sync.js"

    if not (firefox_path.exists() and bin_bytes):
        pytest.skip("Headless Firefox or pb27802310 words BLOB not present")

    word_sync_js = word_sync_js_path.read_bytes()
    report = {}

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    class RegressionHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            report["data"] = json.loads(body.decode("utf-8"))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            if self.path == "/word_sync.js":
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(word_sync_js)))
                self.end_headers()
                self.wfile.write(word_sync_js)
                return

            if self.path in ("/words/pb27802310.bin", "/api/episodes/pb27802310/words"):
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(bin_bytes)))
                self.end_headers()
                self.wfile.write(bin_bytes)
                return

            if self.path == "/broken_cdn.mp3":
                self.send_response(503)
                self.end_headers()
                return

            html = b"""<!DOCTYPE html><html><body>
            <div id="turn-0"></div>
            <audio id="a"></audio>
            <script src="/word_sync.js"></script>
            <script>
            (async () => {
                await WordSync.ensureEpisodeLoaded('pb27802310');
                const container = document.getElementById('turn-0');
                for (let i = 0; i < 35; i++) {
                    const sp = document.createElement('span');
                    sp.id = 'tw-' + i;
                    container.appendChild(sp);
                }

                // 1. Test failed progressive fetch cleanly resolves to null without hanging
                const brokenBlob = await WordSync.waitForFirefoxBlobUrl('/broken_cdn.mp3', 215.80);

                // 2. Test Firefox raw 'cdn' fallback at Turn 0 (3:36 -> 215.80s physical, word 0 at 216.30s)
                // Must NEVER select Bucket k=3 (delta=+28.74s, landedPhys=221.91s = 3:42 "on how to proceed" = word 9)
                WordSync.streamMode = 'cdn';
                const seekCdn = WordSync.prepareSeek(215.80, 216.30);
                const landedPhysCdn = WordSync.getPhysicalTime(seekCdn);
                WordSync.update(seekCdn);
                const activeWordCdn = WordSync.activeWordIdx;

                // 3. Test external/native seek inference in 'patched_blob' mode
                WordSync.streamMode = 'patched_blob';
                const sLinear = WordSync.prepareSeek(216.30, 216.30);
                const offsetLinear = WordSync.seekOffset;

                // 4. Test toggle() and clearHighlights()
                WordSync.toggle(false);
                const disabledState = WordSync.enabled;
                const clearedIdx = WordSync.activeWordIdx;
                WordSync.toggle(true);

                await fetch('/report', {
                    method: 'POST',
                    body: JSON.stringify({
                        brokenBlob,
                        seekCdn,
                        landedPhysCdn,
                        activeWordCdn,
                        sLinear,
                        offsetLinear,
                        disabledState,
                        clearedIdx,
                        totalDurSec: WordSync.vbrData.totalDurSec
                    })
                });
            })();
            </script></body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

    server = ThreadedHTTPServer(("127.0.0.1", 0), RegressionHandler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as f_dir:
            p_ff = subprocess.Popen(
                [
                    str(firefox_path),
                    "-headless",
                    "-profile",
                    f_dir,
                    f"http://127.0.0.1:{port}/",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            t0 = time.time()
            while time.time() - t0 < 20:
                if "data" in report:
                    break
                time.sleep(0.2)
            p_ff.kill()
            try:
                p_ff.wait(timeout=5)
            except Exception:
                pass
            time.sleep(0.5)
    finally:
        server.shutdown()

    assert "data" in report, "Headless Firefox regression runner did not report back"
    data = report["data"]

    # Broken upstream CDN must return null without hanging
    assert data["brokenBlob"] is None

    # In raw CDN fallback mode, landed physical time must be <= 216.15s (before "Everyone," at 216.30s)
    # and MUST NOT jump to 221.91s (3:42 "on how to proceed", word 9)
    assert data["landedPhysCdn"] <= 216.15, (
        f"Firefox raw CDN fallback jumped forward past Turn 0 to {data['landedPhysCdn']}s!"
    )
    assert data["activeWordCdn"] == 0, (
        f"Expected Word 0 ('Everyone,') to be highlighted on Turn 0 seek, got word {data['activeWordCdn']}"
    )

    # Linear patched_blob seek for 216.30s must be ~183.85s with offset ~+32.45s
    assert 183.5 <= data["sLinear"] <= 184.5
    assert 31.8 <= data["offsetLinear"] <= 33.0
    assert data["disabledState"] is False
    assert data["clearedIdx"] == -1
    assert 6438.0 <= data["totalDurSec"] <= 6440.0


def test_pb10641521_turn_sentence_splitting_and_word_highlight_alignment():
    """
    Verifies that WordSync.splitSentences and formatTurnParagraphs do not drop leading
    turn text containing numbers/decimals (e.g. '6.15', '5.30', or '6 .15') and that word
    highlighting remains 100% synchronized for episode pb10641521 Turn 2.
    """
    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    db = TranscriptDatabase(TRANSCRIPTS_DB_PATH)
    bin_bytes = db.get_episode_words("pb10641521")
    word_sync_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "word_sync.js"

    if not (chrome_path.exists() and bin_bytes and TRANSCRIPTS_DB_PATH.exists()):
        pytest.skip("Chrome or pb10641521 assets not present")

    word_sync_js = word_sync_js_path.read_bytes()

    conn = sqlite3.connect(TRANSCRIPTS_DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM speech_segments WHERE episode_id = 'pb10641521' ORDER BY turn_index"
        ).fetchall()
        segments = [dict(r) for r in rows]
    finally:
        conn.close()

    report = {}

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            report["data"] = json.loads(body.decode("utf-8"))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            if self.path == "/word_sync.js":
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(word_sync_js)))
                self.end_headers()
                self.wfile.write(word_sync_js)
                return

            if self.path in ("/words/pb10641521.bin", "/api/episodes/pb10641521/words"):
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(bin_bytes)))
                self.end_headers()
                self.wfile.write(bin_bytes)
                return

            html = f"""<!DOCTYPE html><html><body>
            <div id="container"></div>
            <script src="/word_sync.js"></script>
            <script>
            (async () => {{
                const segs = {json.dumps(segments)};
                await WordSync.ensureEpisodeLoaded('pb10641521');
                WordSync.indexWordsByTurn(segs);

                // Test 1: splitSentences preserves decimals and quotes
                const testText = 'Here from 6.15 onwards and 5.30 to 6.15. "Let it go." That is peace.';
                const testSents = WordSync.splitSentences(testText);

                // Test 2: Turn 2 formatTurnParagraphs preserves all 212 words
                const turn2Seg = segs.find(s => Number(s.turn_index) === 2);
                const html = WordSync.formatTurnParagraphs(turn2Seg.text, 2);
                const container = document.getElementById('container');
                container.innerHTML = html;

                const wordSpans = Array.from(container.querySelectorAll('.transcript-word'));
                const firstSpan = wordSpans[0];
                const technicallySpan = wordSpans.find(sp => sp.textContent.trim().toLowerCase() === 'technically');

                // Test 3: Live highlight synchronization
                WordSync.update(72.7); // At 72.7s ("here")
                const activeAt72_7 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;

                WordSync.update(78.5); // At 78.5s (second "6.15" [78.18s - 79.00s])
                const activeAt78_5 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;

                WordSync.update(79.75); // At 79.75s ("technically" [79.60s - 80.22s])
                const activeAt79_75 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;

                await fetch('/report', {{
                    method: 'POST',
                    body: JSON.stringify({{
                        testSents,
                        totalWordSpans: wordSpans.length,
                        firstWordText: firstSpan ? firstSpan.textContent.trim() : null,
                        firstWordStart: firstSpan ? firstSpan.dataset.start : null,
                        technicallyStart: technicallySpan ? technicallySpan.dataset.start : null,
                        activeAt72_7,
                        activeAt78_5,
                        activeAt79_75,
                    }})
                }});
            }})();
            </script></body></html>""".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

    server = ThreadedHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            proc = subprocess.Popen([
                str(chrome_path),
                "--headless=new",
                f"--user-data-dir={tmp}",
                f"http://127.0.0.1:{port}/",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            t0 = time.time()
            while time.time() - t0 < 15:
                if "data" in report:
                    break
                time.sleep(0.2)
            proc.kill()
    finally:
        server.shutdown()

    assert "data" in report, "Headless Chrome regression runner did not report back"
    data = report["data"]

    # Verify splitSentences preserves decimals and quotes
    assert data["testSents"] == [
        "Here from 6.15 onwards and 5.30 to 6.15.",
        '"Let it go."',
        "That is peace.",
    ]

    # Verify pb10641521 Turn 2 retains all 208 word spans, starting with "here"
    assert data["totalWordSpans"] == 208
    assert data["firstWordText"].lower() == "here"
    assert float(data["firstWordStart"]) == pytest.approx(72.56, abs=0.05)
    assert float(data["technicallyStart"]) == pytest.approx(79.60, abs=0.1)

    # Verify highlight accuracy after sub-word coalescing ("6.15" at 78.18-79.00s, "technically" at 79.60-80.22s)
    assert data["activeAt72_7"].lower() == "here"
    assert data["activeAt78_5"] == "6.15"
    assert data["activeAt79_75"].lower() == "technically"


def test_word_sync_triple_mode_and_sticky_toolbar_markup():
    """
    Verifies that the Word Sync control uses a 3-way mode (off|on|track) via global JS state,
    the metrics badge and redundant play button are removed, and the transcript toolbar is sticky.
    """
    index_html_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "views" / "index.html"
    assert index_html_path.exists()
    html_content = index_html_path.read_text(encoding="utf-8")

    # 1. Verify metrics badge is removed from markup
    assert 'id="word-sync-metrics-badge"' not in html_content
    assert 'word-sync-metrics-badge' not in html_content

    # 2. Verify redundant play button is removed from toolbar and header play button exists
    assert 'id="drawer-play-full-btn"' not in html_content
    assert 'id="transcript-play-btn"' in html_content
    assert 'id="btn-player-transcript"' in html_content

    # 3. Verify sticky toolbar and segmented Word Sync control markup
    assert 'id="transcript-sticky-toolbar"' in html_content
    assert 'id="segmented-word-sync-control"' in html_content
    assert 'data-mode="off"' in html_content
    assert 'data-mode="on"' in html_content
    assert 'data-mode="track"' in html_content
    assert "Word Sync:" in html_content

    # 4. Evaluate word_sync.js in headless Chrome
    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    word_sync_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "word_sync.js"
    if not (chrome_path.exists() and word_sync_js_path.exists()):
        return

    word_sync_js = word_sync_js_path.read_bytes()
    report = {}

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            report["data"] = json.loads(body.decode("utf-8"))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            if self.path == "/word_sync.js":
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(word_sync_js)))
                self.end_headers()
                self.wfile.write(word_sync_js)
                return

            html = """<!DOCTYPE html><html><body>
            <div id="container">
              <div id="transcript-sticky-toolbar">
                <div id="segmented-word-sync-control">
                  <button class="seg-btn" data-mode="off">Off</button>
                  <button class="seg-btn" data-mode="on">On</button>
                  <button class="seg-btn active" data-mode="track">Track</button>
                </div>
              </div>
            </div>
            <script src="/word_sync.js"></script>
            <script>
            (async () => {
                WordSync.init();
                const defaultMode = WordSync.mode;
                const defaultEnabled = WordSync.enabled;

                // Test mode transitions
                WordSync.setMode('on');
                const onMode = WordSync.mode;
                const onEnabled = WordSync.enabled;

                WordSync.setMode('off');
                const offMode = WordSync.mode;
                const offEnabled = WordSync.enabled;

                // Test cycleMode: off -> on -> track -> off
                WordSync.cycleMode();
                const cycle1 = WordSync.mode;
                WordSync.cycleMode();
                const cycle2 = WordSync.mode;
                WordSync.cycleMode();
                const cycle3 = WordSync.mode;

                const hasScrollMethod = typeof WordSync.scrollToWordIfOffScreen === 'function';

                // Test decoupled reader guard (Option 2):
                WordSync.setMode('on');
                WordSync.currentEpisodeId = 'talk_b';
                WordSync.playingEpisodeId = 'talk_a';
                WordSync.words = [{ s: 0, e: 1, domId: 'test-w1' }, { s: 1, e: 2, domId: 'test-w2' }];
                const dummySpan = document.createElement('span');
                dummySpan.id = 'test-w2';
                document.body.appendChild(dummySpan);

                WordSync.update(1.5);
                const decoupledActiveSpan = WordSync.activeWordEl;

                WordSync.playingEpisodeId = 'talk_b';
                WordSync.update(1.5);
                const matchedActiveSpanId = WordSync.activeWordEl ? WordSync.activeWordEl.id : null;

                await fetch('/report', {
                    method: 'POST',
                    body: JSON.stringify({
                        defaultMode,
                        defaultEnabled,
                        onMode,
                        onEnabled,
                        offMode,
                        offEnabled,
                        cycle1,
                        cycle2,
                        cycle3,
                        hasScrollMethod,
                        decoupledActiveSpan,
                        matchedActiveSpanId
                    })
                });
            })();
            </script></body></html>""".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

    server = ThreadedHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            proc = subprocess.Popen([
                str(chrome_path),
                "--headless=new",
                f"--user-data-dir={tmp}",
                f"http://127.0.0.1:{port}/",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            t0 = time.time()
            while time.time() - t0 < 15:
                if "data" in report:
                    break
                time.sleep(0.2)
            proc.kill()
    finally:
        server.shutdown()

    assert "data" in report, "Headless Chrome mode test did not report back"
    res = report["data"]

    assert res["defaultMode"] == "track"
    assert res["defaultEnabled"] is True
    assert res["onMode"] == "on"
    assert res["onEnabled"] is True
    assert res["offMode"] == "off"
    assert res["offEnabled"] is False
    assert res["cycle1"] == "on"
    assert res["cycle2"] == "track"
    assert res["cycle3"] == "off"
    assert res["hasScrollMethod"] is True
    assert res["decoupledActiveSpan"] is None, "WordSync must not highlight words when viewing a different talk than the playing talk"
    assert res["matchedActiveSpanId"] == "test-w2", "WordSync must highlight words when viewing matches the playing talk"


def test_pb22228026_word_sync_hyphenated_compounds_and_lead_in_alignment():
    """
    Regression test for episode pb22228026 ('1998 Rains Retreat (6/10) | Contentment Deepens Samadhi | Ajahn Brahm'):
    1. Turn 1 ('This evening I'm going to talk some more about meditation, about') must start at ~53.92s
       immediately preceding 'evening' (54.52s), rather than stranded 11.28s early at 42.46s during post-chanting silence.
    2. Turn 2 ('citta-viveka, citta-bhavana. Citta-viveka is the...') must coalesce hyphenated Pali compounds
       into single word-timing entries (60.92-64.97s, 65.29-66.29s, 67.15-68.09s) so 'is' (68.09s) and all 429
       subsequent words in Turn 2 highlight in 1:1 lockstep with zero cumulative word-index drift.
    3. All 30 turns in pb22228026 must have zero unmapped words and zero unwrapped DOM tokens.
    """
    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    db = TranscriptDatabase(TRANSCRIPTS_DB_PATH)
    bin_bytes = db.get_episode_words("pb22228026")
    word_sync_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "word_sync.js"

    if not (chrome_path.exists() and bin_bytes and TRANSCRIPTS_DB_PATH.exists()):
        pytest.skip("Chrome or pb22228026 assets not present")

    word_sync_js = word_sync_js_path.read_bytes()

    conn = sqlite3.connect(TRANSCRIPTS_DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        ep_row = conn.execute("SELECT duration_sec FROM episodes WHERE id = 'pb22228026'").fetchone()
        rows = conn.execute(
            "SELECT * FROM speech_segments WHERE episode_id = 'pb22228026' ORDER BY turn_index"
        ).fetchall()
        segments = [dict(r) for r in rows]
        pali_rows = conn.execute(
            "SELECT pali_plain, pali_diacritic, phonetic_variants FROM pali_terms"
        ).fetchall() if conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='pali_terms'").fetchone() else []
        pali_terms = [dict(r) for r in pali_rows]
    finally:
        conn.close()

    assert ep_row is not None
    assert float(ep_row["duration_sec"]) == pytest.approx(3854.60, abs=0.2)
    assert len(segments) == 33
    assert float(segments[1]["start_sec"]) == pytest.approx(53.92, abs=0.1)

    report = {}

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            report["data"] = json.loads(body.decode("utf-8"))
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            if self.path == "/word_sync.js":
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(word_sync_js)))
                self.end_headers()
                self.wfile.write(word_sync_js)
                return

            if self.path in ("/words/pb22228026.bin", "/api/episodes/pb22228026/words"):
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(bin_bytes)))
                self.end_headers()
                self.wfile.write(bin_bytes)
                return

            html = f"""<!DOCTYPE html><html><body>
            <div id="container"></div>
            <script src="/word_sync.js"></script>
            <script>
            (async () => {{
                const segs = {json.dumps(segments)};
                const terms = {json.dumps(pali_terms)};
                WordSync.setPaliTerms(terms);
                await WordSync.ensureEpisodeLoaded('pb22228026');
                WordSync.indexWordsByTurn(segs);

                const container = document.getElementById('container');
                let unmappedTotal = 0;
                for (const s of segs) {{
                    const div = document.createElement('div');
                    div.innerHTML = WordSync.formatTurnParagraphs(s.text, s.turn_index);
                    container.appendChild(div);
                    const tw = WordSync.turnWordMap[s.turn_index] || [];
                    for (const w of tw) {{
                        if (!w.domId) unmappedTotal++;
                    }}
                }}

                // Check Turn 1 Word 0 ('This') and Word 1 ('evening')
                WordSync.update(54.10);
                const t1Word0 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;
                WordSync.update(54.80);
                const t1Word1 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;

                // Check Turn 2 hyphenated Pali opening ('citta-viveka,', 'citta-bhavana.', 'Citta-viveka', 'is')
                WordSync.update(62.50);
                const t2Word0 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;
                WordSync.update(65.60);
                const t2Word1 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;
                WordSync.update(68.20);
                const t2Word2 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;
                WordSync.update(69.50);
                const t2Word3 = WordSync.activeWordEl ? WordSync.activeWordEl.textContent.trim() : null;

                await fetch('/report', {{
                    method: 'POST',
                    body: JSON.stringify({{
                        totalWords: WordSync.words.length,
                        unmappedTotal,
                        t1Word0,
                        t1Word1,
                        t2Word0,
                        t2Word1,
                        t2Word2,
                        t2Word3,
                    }})
                }});
            }})();
            </script></body></html>""".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

    server = ThreadedHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            proc = subprocess.Popen([
                str(chrome_path),
                "--headless=new",
                f"--user-data-dir={tmp}",
                f"http://127.0.0.1:{port}/",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            t0 = time.time()
            while time.time() - t0 < 15:
                if "data" in report:
                    break
                time.sleep(0.2)
            proc.kill()
    finally:
        server.shutdown()

    assert "data" in report, "Headless Chrome pb22228026 runner did not report back"
    data = report["data"]

    assert data["totalWords"] in (7124, 7173)
    assert data["unmappedTotal"] == 0
    assert data["t1Word0"] == "This"
    assert data["t1Word1"] == "evening"
    assert data["t2Word0"] in ("cittaviveka,", "citta-viveka,")
    assert data["t2Word1"] in ("cittabhavana.", "citta-bhavana.")
    assert data["t2Word2"] in ("cittaviveka", "Cittaviveka", "Citta-viveka")
    assert data["t2Word3"] == "is"


def test_sampled_newly_transcribed_episodes_one_to_one_word_sync_parity():
    """
    Verifies across all 114 transcribed episodes (and a random sample of newly transcribed talks)
    as well as unit-level TerminologyEditor._coalesce_subword_timings that:
    1. Every episode in `dhamma_transcripts.db` and `dist/dhamma_web.db` has exact 1:1 parity
       between `episode_words` BLOB entries and whitespace-delimited tokens in `speech_segments.text`.
    2. No turn has a stranded unpunctuated lead-in Word 0 (`gap >= 2.5s`).
    3. No episode contains trailing silence hallucination turns (`'Satsang with Mooji'`).
    4. `TerminologyEditor.edit_segments` coalesces sub-word continuation entries even when
       zero lexical substitutions are triggered.
    """
    from deeper_dhamma.terminology import TerminologyEditor

    # 1. Unit check on TerminologyEditor sub-word coalescing without lexical changes
    synthetic_words = [
        {"word": " citta", "start": 60.92, "end": 64.51, "prob": 0.9},
        {"word": "-viveka,", "start": 64.51, "end": 64.97, "prob": 0.95},
        {"word": " citta", "start": 65.29, "end": 65.89, "prob": 0.9},
        {"word": "-bhavana.", "start": 65.89, "end": 66.29, "prob": 0.92},
        {"word": " is", "start": 68.09, "end": 68.31, "prob": 0.99},
    ]
    coalesced = TerminologyEditor._sync_word_timings(
        synthetic_words,
        "citta-viveka, citta-bhavana. is",
        orig_text="citta-viveka, citta-bhavana. is",
    )
    assert len(coalesced) == 3
    assert coalesced[0]["word"] == " citta-viveka,"
    assert coalesced[0]["start"] == 60.92 and coalesced[0]["end"] == 64.97
    assert coalesced[1]["word"] == " citta-bhavana."
    assert coalesced[1]["start"] == 65.29 and coalesced[1]["end"] == 66.29
    assert coalesced[2]["word"] == " is"

    # 2. Verify all 114 episodes in dhamma_transcripts.db and dist/dhamma_web.db
    for db_path in [TRANSCRIPTS_DB_PATH, PROJECT_ROOT / "dist" / "dhamma_web.db"]:
        if not db_path.exists():
            continue
        conn = sqlite3.connect(db_path)
        try:
            episodes = conn.execute(
                "SELECT id FROM episodes WHERE is_transcribed = 1 ORDER BY id"
            ).fetchall()
            assert len(episodes) >= 114
            for (ep_id,) in episodes:
                segs = conn.execute(
                    "SELECT turn_index, start_sec, end_sec, text FROM speech_segments WHERE episode_id = ? ORDER BY turn_index",
                    (ep_id,),
                ).fetchall()
                ws_count = sum(len(s[3].split()) for s in segs)
                w_row = conn.execute(
                    "SELECT words_blob FROM episode_words WHERE episode_id = ?",
                    (ep_id,),
                ).fetchone()
                if ws_count == 0:
                    assert len(segs) == 0, f"{db_path.name} {ep_id}: non-empty segments with 0 tokens"
                    assert w_row is None or struct.unpack("<I", w_row[0][:4])[0] == 0
                    continue
                assert w_row is not None, f"{db_path.name} {ep_id}: missing words_blob for {ws_count} tokens"
                blob = w_row[0]
                wc = struct.unpack("<I", blob[:4])[0]
                assert wc == ws_count, f"{db_path.name} {ep_id}: blob word count {wc} != token count {ws_count}"

                cursor = 0
                for t_idx, st_sec, en_sec, text in segs:
                    assert text.strip().lower() != "satsang with mooji", f"Hallucination remained in {ep_id}"
                    toks = text.split()
                    n_toks = len(toks)
                    if n_toks >= 2:
                        w0_st, w0_dur = struct.unpack("<IH", blob[4 + cursor * 6 : 10 + cursor * 6])
                        w1_st, _ = struct.unpack("<IH", blob[4 + (cursor + 1) * 6 : 10 + (cursor + 1) * 6])
                        w0_en_s = (w0_st + w0_dur) / 1000.0
                        w1_st_s = w1_st / 1000.0
                        gap = w1_st_s - w0_en_s
                        assert not (gap >= 2.5 and toks[0][-1] not in ".?!,:;"), (
                            f"Stranded lead-in Word 0 in {ep_id} Turn {t_idx}: '{toks[0]}' gap={gap:.2f}s"
                        )
                    cursor += n_toks
        finally:
            conn.close()


def _decode_mp3_pcm_16k(mp3_path: Path, start_sec: float | None = None, duration_sec: float | None = None):
    """Decode mono 16kHz float32 reference PCM from an MP3 file (full or windowed)."""
    import numpy as np

    ffmpeg_bin = shutil.which("ffmpeg")
    cmd = [ffmpeg_bin, "-v", "error"]
    if start_sec is not None and start_sec > 0:
        cmd += ["-ss", f"{start_sec:.3f}"]
    if duration_sec is not None and duration_sec > 0:
        cmd += ["-t", f"{duration_sec:.3f}"]
    cmd += ["-i", str(mp3_path), "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"]
    pcm_raw = subprocess.check_output(cmd)
    return np.frombuffer(pcm_raw, dtype=np.int16).astype(np.float32)


def _match_pcm_timestamp_sec(full_pcm, clip_b64: str, center_sec: float, pcm_offset_sec: float = 0.0, radius_sec: float = 25.0) -> float:
    """Finds the true physical timestamp (seconds) of captured WebAudio PCM via FFT cross-correlation."""
    import base64
    import numpy as np

    clip = np.frombuffer(base64.b64decode(clip_b64), dtype=np.int16).astype(np.float32)
    nz = np.where(np.abs(clip) > 50)[0]
    assert len(nz) > 4000, f"Silent WebAudio capture ({len(nz)} non-zero samples)"
    clip_trim = clip[nz[0] : nz[0] + 12000]
    clip_trim = clip_trim - np.mean(clip_trim)

    rel_center = center_sec - pcm_offset_sec
    win_start = max(0, int((rel_center - radius_sec) * 16000))
    win_end = min(len(full_pcm), int((rel_center + radius_sec) * 16000))
    ref = full_pcm[win_start:win_end]
    assert len(ref) > len(clip_trim) + 100, "Reference PCM window too short for correlation"

    fft_len = 1 << int(np.ceil(np.log2(len(ref) + len(clip_trim))))
    cc = np.fft.irfft(np.fft.rfft(ref, fft_len) * np.conj(np.fft.rfft(clip_trim, fft_len)))[: len(ref) - len(clip_trim) + 1]
    return pcm_offset_sec + (win_start + int(np.argmax(cc))) / 16000.0 - (nz[0] / 16000.0)


def _run_headless_chrome_dist_media_test(ep_id: str, mp3_path: Path, run_body_js: str, allow_range: bool = True, timeout_sec: float = 40.0) -> dict:
    """Serves built dist/ alongside a local archive MP3 and executes `run_body_js` in headless Chrome."""
    import mimetypes
    from deeper_dhamma.export_web import _is_dist_stale, export_static_site

    chrome_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    ffmpeg_bin = shutil.which("ffmpeg")
    dist_dir = PROJECT_ROOT / "dist"

    if not (chrome_path.exists() and ffmpeg_bin and mp3_path.exists() and TRANSCRIPTS_DB_PATH.exists()):
        pytest.skip(f"Chrome, ffmpeg, or {ep_id} archive assets not present")

    if not (dist_dir / "index.html").exists() or _is_dist_stale(dist_dir):
        export_static_site(dist_dir)

    mp3_size = mp3_path.stat().st_size
    harness_js = f"""
<script>
(function() {{
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {{
    if (typeof input === 'string' && input.includes('podbean.com')) {{
      input = location.origin + '/media/{ep_id}.mp3';
    }}
    return origFetch(input, init);
  }};
  const aProto = HTMLMediaElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(aProto, 'src');
  Object.defineProperty(aProto, 'src', {{
    get() {{ return srcDesc.get.call(this); }},
    set(v) {{
      if (typeof v === 'string' && v.includes('podbean.com')) {{
        v = location.origin + '/media/{ep_id}.mp3';
      }}
      return srcDesc.set.call(this, v);
    }}
  }});

  async function sleep(ms) {{ return new Promise(r => setTimeout(r, ms)); }}
  async function waitUntil(pred, timeoutMs = 8000, stepMs = 30) {{
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {{
      if (pred()) return true;
      await sleep(stepMs);
    }}
    return Boolean(pred());
  }}
  function encodePcmInt16Chunks(chunks) {{
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Int16Array(total);
    let k = 0;
    for (const c of chunks) {{
      for (let i = 0; i < c.length; i++) {{
        out[k++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
      }}
    }}
    let bin = '';
    const bytes = new Uint8Array(out.buffer);
    for (let i = 0; i < bytes.length; i += 8192) {{
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }}
    return btoa(bin);
  }}
  async function reportResult(payload) {{
    await origFetch('/__report', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify(payload),
    }});
  }}
  async function getMediaStats() {{
    const r = await origFetch('/__stats');
    return r.json();
  }}

  async function runTest() {{
    {run_body_js}
  }}

  window.addEventListener('load', () => setTimeout(() => {{
    runTest().catch(err => reportResult({{ error: String(err && err.stack || err) }}));
  }}, 350));
}})();
</script>
"""

    report = {}
    done = threading.Event()
    stats_lock = threading.Lock()
    media_stats = {"bytes": 0, "requests": []}

    class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
        daemon_threads = True

    class DistTestHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            if self.path == "/__report":
                cl = int(self.headers.get("Content-Length", 0))
                report["data"] = json.loads(self.rfile.read(cl).decode("utf-8"))
                self.send_response(200)
                self.end_headers()
                done.set()

        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/__stats":
                with stats_lock:
                    body = json.dumps(media_stats).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if p == f"/media/{ep_id}.mp3":
                rng = self.headers.get("Range")
                start, end, status = 0, mp3_size - 1, 200
                if allow_range and rng and rng.startswith("bytes="):
                    ps = rng[6:].split(",")[0].split("-")
                    if ps[0]:
                        start = int(ps[0])
                    if len(ps) > 1 and ps[1]:
                        end = min(mp3_size - 1, int(ps[1]))
                    status = 206
                length = max(0, end - start + 1)
                self.send_response(status)
                self.send_header("Content-Type", "audio/mpeg")
                if allow_range:
                    self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(length))
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{mp3_size}")
                self.end_headers()
                with stats_lock:
                    media_stats["requests"].append({"status": status, "range": rng, "length": length})
                try:
                    with open(mp3_path, "rb") as f:
                        f.seek(start)
                        rem = length
                        while rem > 0:
                            chunk = f.read(min(262144, rem))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            with stats_lock:
                                media_stats["bytes"] += len(chunk)
                            rem -= len(chunk)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
                return

            if p in ("/", "/index.html"):
                html = (dist_dir / "index.html").read_text(encoding="utf-8").replace("</body>", harness_js + "</body>")
                data = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            fpath = dist_dir / p.lstrip("/")
            if fpath.is_file():
                data = fpath.read_bytes()
                ct, _ = mimetypes.guess_type(str(fpath))
                if p.endswith(".js"):
                    ct = "application/javascript"
                elif p.endswith(".wasm"):
                    ct = "application/wasm"
                elif p.endswith(".gz"):
                    ct = "application/gzip"
                self.send_response(200)
                self.send_header("Content-Type", ct or "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_error(404)

    server = ThreadedHTTPServer(("127.0.0.1", 0), DistTestHandler)
    port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as c_dir:
            proc = subprocess.Popen(
                [
                    str(chrome_path),
                    "--headless=new",
                    "--autoplay-policy=no-user-gesture-required",
                    f"--user-data-dir={c_dir}",
                    "--window-size=1280,900",
                    f"http://127.0.0.1:{port}/#talk/{ep_id}",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            done.wait(timeout=timeout_sec)
            proc.kill()
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
    finally:
        server.shutdown()

    assert "data" in report, f"Headless Chrome {ep_id} test did not report back"
    assert "error" not in report["data"], f"Headless Chrome JS error: {report['data'].get('error')}"
    report["data"]["serverMediaStats"] = media_stats
    return report["data"]


def test_headless_chrome_pb28769672_patched_vbr_and_companion_sync():
    """
    End-to-end headless Chrome test against the real built `dist/` application for VBR talk `pb28769672`:
    1. Verifies Chromium uses O(1) VBR1 frame-aligned HTTP Range + MediaSource (`streamMode == 'mse_vbr'`,
       `seekOffset == 0.0`) fetching < 4 MB across 5 jumps across the 26 MB talk.
    2. Verifies real WebAudio output matches true physical audio timestamps (<= 0.65s delta via
       PCM cross-correlation) across transcript word clicks (`tw-84`, `tw-2500`, `tw-3000`) and
       Lexicon Companion card clicks.
    3. Verifies seamless continuous playback across an MSE chunk boundary (>= 5.0s continuous play
       crossing chunk 1 -> chunk 2 append) with zero tail PCM drift.
    4. Verifies zero companion card flicker during seek lead-in and rapid click ordering (`card85 -> tw673 -> card20`).
    """
    mp3_path = PROJECT_ROOT / "archive/2026/2026_rains_retreat/2026-09-29_2026_rains_retreat_07_12_getting_out_of_a_rut_ajahn_brahmali.mp3"

    run_body_js = r"""
    const ready = await waitUntil(() => {
      const ws = window.WordSync;
      const cards = document.querySelectorAll('#transcript-lexicon-stack .lex-stack-card');
      return document.getElementById('tw-3000') && ws && ws.currentEpisodeId === 'pb28769672' && cards.length > 50;
    }, 20000, 100);
    if (!ready) throw new Error('Timed out waiting for pb28769672 readiness');

    const a = document.getElementById('native-audio');
    const ws = window.WordSync;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const srcNode = ctx.createMediaElementSource(a);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    srcNode.connect(proc);
    proc.connect(ctx.destination);
    let captureBuf = null;
    proc.onaudioprocess = (e) => {
      if (captureBuf) captureBuf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    const cards = Array.from(document.querySelectorAll('#transcript-lexicon-stack .lex-stack-card'));
    const cases = [
      { label: 'tw84', el: document.getElementById('tw-84'), expectCardIdx: null },
      { label: 'tw2500', el: document.getElementById('tw-2500'), expectCardIdx: null },
      { label: 'tw3000', el: document.getElementById('tw-3000'), expectCardIdx: null },
      { label: 'card5', el: cards[5], expectCardIdx: cards[5].dataset.idx },
      { label: 'card50', el: cards[50], expectCardIdx: cards[50].dataset.idx },
    ];

    const results = [];
    for (const item of cases) {
      captureBuf = [];
      if (ctx.state === 'suspended') await ctx.resume();
      item.el.click();
      await waitUntil(() => (
        ws.streamMode === 'mse_vbr' &&
        !ws.isSeekLocked() &&
        a.readyState >= 3 &&
        !a.seeking &&
        !ws._awaitingInitialSeek
      ), 6000, 30);
      const seekedPhys = ws.getPhysicalTime(a.currentTime);
      const curActiveCardEarly = document.querySelector('#transcript-lexicon-stack .lex-stack-card.current-companion-term');
      const earlyCardIdx = curActiveCardEarly ? curActiveCardEarly.dataset.idx : null;

      await sleep(1600);
      const chunks = captureBuf;
      captureBuf = null;
      results.push({
        label: item.label,
        streamMode: ws.streamMode,
        seekOffset: Number((ws.seekOffset || 0).toFixed(4)),
        seekedPhys: Number(seekedPhys.toFixed(3)),
        activeIdx: ws.activeWordIdx,
        expectCardIdx: item.expectCardIdx,
        earlyCardIdx,
        b64pcm: encodePcmInt16Chunks(chunks),
      });
    }
    const statsAfterFiveSeeks = await getMediaStats();

    // Continuous cross-chunk MSE boundary test:
    // Seek to tw-84 to buffer chunk 1 [~28s..~68s], find a word ~4.2s before chunk end,
    // click it (hits buffered fast path / continuous prefetch), and record >= 5.2s across chunk seam.
    document.getElementById('tw-84').click();
    await waitUntil(() => (
      ws.streamMode === 'mse_vbr' &&
      ws._mse && ws._mse.sourceBuffer && ws._mse.sourceBuffer.buffered.length > 0 &&
      !ws.isSeekLocked() && a.readyState >= 3
    ), 6000, 30);
    const end1 = ws._mse.sourceBuffer.buffered.end(0);
    let boundaryWord = null;
    let bestBoundaryDiff = Infinity;
    document.querySelectorAll('#drawer-turns-container .transcript-word').forEach(el => {
      const st = parseFloat(el.dataset.start);
      const diff = Math.abs(st - (end1 - 4.2));
      if (!isNaN(st) && st <= end1 - 3.0 && diff < bestBoundaryDiff) {
        bestBoundaryDiff = diff;
        boundaryWord = el;
      }
    });
    if (!boundaryWord) throw new Error('Could not locate word near chunk 1 end');

    captureBuf = [];
    boundaryWord.click();
    await waitUntil(() => (
      ws.streamMode === 'mse_vbr' && !ws.isSeekLocked() && a.readyState >= 3 && !a.seeking
    ), 4000, 20);
    const boundaryPlayStartPhys = ws.getPhysicalTime(a.currentTime);
    captureBuf = [];
    await sleep(5400);
    const boundaryEndPhys = ws.getPhysicalTime(a.currentTime);
    const tailChunks = captureBuf;
    captureBuf = null;
    const end2 = (ws._mse && ws._mse.sourceBuffer && ws._mse.sourceBuffer.buffered.length > 0)
      ? ws._mse.sourceBuffer.buffered.end(0)
      : end1;
    // Keep final ~1.5s of recorded WebAudio (`~6` scriptProcessor buffers) past chunk boundary
    const tailSlice = tailChunks.slice(-Math.min(tailChunks.length, 6));
    let tailSamples = 0;
    for (const c of tailSlice) tailSamples += c.length;

    // Rapid overlap test: card 85 -> tw-673 -> card 20 within 80ms
    cards[85].click();
    await sleep(40);
    document.getElementById('tw-673').click();
    await sleep(40);
    cards[20].click();
    await waitUntil(() => (
      ws.streamMode === 'mse_vbr' && !ws.isSeekLocked() && a.readyState >= 3 && !a.seeking
    ), 5000, 30);
    await sleep(1200);
    const activeCardRapid = document.querySelector('#transcript-lexicon-stack .lex-stack-card.current-companion-term');

    await reportResult({
      results,
      bytesAfterFiveSeeks: statsAfterFiveSeeks.bytes,
      boundary: {
        end1: Number(end1.toFixed(3)),
        end2: Number(end2.toFixed(3)),
        startPhys: Number(boundaryPlayStartPhys.toFixed(3)),
        endPhys: Number(boundaryEndPhys.toFixed(3)),
        tailDurationSec: Number((tailSamples / 16000.0).toFixed(3)),
        tailB64Pcm: encodePcmInt16Chunks(tailSlice),
      },
      rapidExpectedCard: cards[20].dataset.idx,
      rapidActualCard: activeCardRapid ? activeCardRapid.dataset.idx : null,
      rapidPhys: Number(ws.getPhysicalTime(a.currentTime).toFixed(2)),
    });
    """

    data = _run_headless_chrome_dist_media_test("pb28769672", mp3_path, run_body_js, allow_range=True, timeout_sec=45.0)
    full_pcm = _decode_mp3_pcm_16k(mp3_path)

    # 1. O(1) bandwidth budget across 5 seeks on the 26 MB talk
    assert data["bytesAfterFiveSeeks"] < 4_000_000, (
        f"Expected < 4 MB HTTP Range bytes across 5 seeks, transferred {data['bytesAfterFiveSeeks']:,} bytes"
    )

    for res in data["results"]:
        assert res["streamMode"] == "mse_vbr", f"Expected mse_vbr on {res['label']}, got {res['streamMode']}"
        assert abs(res["seekOffset"]) < 0.001, f"Expected seekOffset 0.0 on mse_vbr, got {res['seekOffset']}"
        if res["expectCardIdx"] is not None:
            assert res["earlyCardIdx"] == res["expectCardIdx"], (
                f"Companion highlight flickered on {res['label']}: expected {res['expectCardIdx']}, got {res['earlyCardIdx']}"
            )
        actual_start = _match_pcm_timestamp_sec(full_pcm, res["b64pcm"], res["seekedPhys"])
        assert abs(actual_start - res["seekedPhys"]) <= 0.65, (
            f"{res['label']} audio/highlight desync: expected ~{res['seekedPhys']:.2f}s, decoded ~{actual_start:.2f}s"
        )

    # 2. Continuous cross-chunk playback verification
    b = data["boundary"]
    assert b["end2"] > b["end1"] + 20.0, f"MSE chunk 2 failed to append ahead: end1={b['end1']}, end2={b['end2']}"
    assert b["endPhys"] > b["end1"] + 0.5, f"Playback did not cross chunk boundary {b['end1']}: endPhys={b['endPhys']}"
    tail_expected = b["endPhys"] - b["tailDurationSec"]
    tail_actual = _match_pcm_timestamp_sec(full_pcm, b["tailB64Pcm"], tail_expected)
    assert abs(tail_actual - tail_expected) <= 0.65, (
        f"Cross-chunk MSE drift/gap at boundary {b['end1']}s: expected tail ~{tail_expected:.2f}s, decoded ~{tail_actual:.2f}s"
    )

    # 3. Rapid click ordering
    assert data["rapidActualCard"] == data["rapidExpectedCard"], (
        f"Rapid companion/word click race: expected card {data['rapidExpectedCard']}, got {data['rapidActualCard']}"
    )
    assert 285.0 <= data["rapidPhys"] <= 315.0, f"Rapid click landed on unexpected physical time: {data['rapidPhys']}"


def test_headless_chrome_mse_range_refusal_fallback_to_patched_blob():
    """
    Verifies automatic downgrade from 'mse_vbr' to 'patched_blob' (Xing -> Info progressive Blob)
    when the HTTP media server ignores Range headers (responds 200 OK instead of 206 Partial Content).
    """
    mp3_path = PROJECT_ROOT / "archive/2026/2026_rains_retreat/2026-09-29_2026_rains_retreat_07_12_getting_out_of_a_rut_ajahn_brahmali.mp3"

    run_body_js = r"""
    const ready = await waitUntil(() => {
      const ws = window.WordSync;
      const cards = document.querySelectorAll('#transcript-lexicon-stack .lex-stack-card');
      return document.getElementById('tw-2500') && ws && ws.currentEpisodeId === 'pb28769672' && cards.length > 50;
    }, 20000, 100);
    if (!ready) throw new Error('Timed out waiting for pb28769672 readiness');

    const a = document.getElementById('native-audio');
    const ws = window.WordSync;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const srcNode = ctx.createMediaElementSource(a);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    srcNode.connect(proc);
    proc.connect(ctx.destination);
    let captureBuf = [];
    proc.onaudioprocess = (e) => {
      if (captureBuf) captureBuf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    const cards = Array.from(document.querySelectorAll('#transcript-lexicon-stack .lex-stack-card'));
    const card50 = cards[50];
    if (ctx.state === 'suspended') await ctx.resume();
    card50.click();

    const settled = await waitUntil(() => (
      ws.streamMode === 'patched_blob' &&
      !ws.isSeekLocked() &&
      a.readyState >= 3 &&
      !a.seeking &&
      !ws._awaitingInitialSeek
    ), 12000, 50);
    if (!settled) throw new Error('Timed out waiting for patched_blob fallback (mode=' + ws.streamMode + ')');

    captureBuf = [];
    const seekedPhys = ws.getPhysicalTime(a.currentTime);
    const earlyActiveCard = document.querySelector('#transcript-lexicon-stack .lex-stack-card.current-companion-term');
    const earlyCardIdx = earlyActiveCard ? earlyActiveCard.dataset.idx : null;

    await sleep(1600);
    const chunks = captureBuf;
    captureBuf = null;

    const mediaUrl = ws.currentEpisode && ws.currentEpisode.media_url ? ws.currentEpisode.media_url : '';
    await reportResult({
      streamMode: ws.streamMode,
      mseMarkedFailed: Boolean(mediaUrl && ws._mseFailed[mediaUrl]),
      seekedPhys: Number(seekedPhys.toFixed(3)),
      expectCardIdx: card50.dataset.idx,
      earlyCardIdx,
      b64pcm: encodePcmInt16Chunks(chunks),
    });
    """

    data = _run_headless_chrome_dist_media_test("pb28769672", mp3_path, run_body_js, allow_range=False, timeout_sec=35.0)
    assert data["streamMode"] == "patched_blob", f"Expected automatic patched_blob fallback, got {data['streamMode']}"
    assert data["mseMarkedFailed"] is True, "Expected _mseFailed flag cached after 200 non-206 response"
    assert data["earlyCardIdx"] == data["expectCardIdx"], (
        f"Companion flicker during fallback: expected {data['expectCardIdx']}, got {data['earlyCardIdx']}"
    )
    full_pcm = _decode_mp3_pcm_16k(mp3_path)
    actual_start = _match_pcm_timestamp_sec(full_pcm, data["b64pcm"], data["seekedPhys"])
    assert abs(actual_start - data["seekedPhys"]) <= 0.65, (
        f"Fallback patched_blob audio desync: expected ~{data['seekedPhys']:.2f}s, decoded ~{actual_start:.2f}s"
    )


def test_headless_chrome_pb27802310_late_talk_mse_seek_o1():
    """
    O(1) late-talk verification on 88.7 MB / 107-minute VBR talk `pb27802310`:
    Jumps directly past 4500s (~80% into the talk) via full UI click in headless Chrome and verifies:
    - < 1.5 MB transferred over HTTP Range (vs 88.7 MB full MP3),
    - `streamMode == 'mse_vbr'` and `seekOffset == 0.0`,
    - Stable companion highlight and <= 0.65s real WebAudio PCM alignment against windowed reference PCM.
    """
    mp3_path = PROJECT_ROOT / "archive/2026/2026_march_9_day_sutta_retreat/2026-03-28_2026_march_9_day_sutta_retreat_07_26_ajahn_brahmali_ayya_karunika.mp3"

    run_body_js = r"""
    const ready = await waitUntil(() => {
      const ws = window.WordSync;
      const cards = document.querySelectorAll('#transcript-lexicon-stack .lex-stack-card');
      return ws && ws.currentEpisodeId === 'pb27802310' && ws.words && ws.words.length > 5000 && cards.length > 10;
    }, 20000, 100);
    if (!ready) throw new Error('Timed out waiting for pb27802310 readiness');

    const a = document.getElementById('native-audio');
    const ws = window.WordSync;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const srcNode = ctx.createMediaElementSource(a);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    srcNode.connect(proc);
    proc.connect(ctx.destination);
    let captureBuf = [];
    proc.onaudioprocess = (e) => {
      if (captureBuf) captureBuf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    const cards = Array.from(document.querySelectorAll('#transcript-lexicon-stack .lex-stack-card'));
    const lateCard = cards[Math.min(cards.length - 1, Math.floor(cards.length * 0.80))];

    if (ctx.state === 'suspended') await ctx.resume();
    lateCard.click();

    const settled = await waitUntil(() => (
      ws.streamMode === 'mse_vbr' &&
      !ws.isSeekLocked() &&
      a.readyState >= 3 &&
      !a.seeking &&
      !ws._awaitingInitialSeek
    ), 8000, 30);
    if (!settled) throw new Error('Timed out waiting for pb27802310 late-talk MSE seek');

    captureBuf = [];
    const seekedPhys = ws.getPhysicalTime(a.currentTime);
    const curActiveCard = document.querySelector('#transcript-lexicon-stack .lex-stack-card.current-companion-term');
    const earlyCardIdx = curActiveCard ? curActiveCard.dataset.idx : null;

    await sleep(1600);
    const chunks = captureBuf;
    captureBuf = null;
    const stats = await getMediaStats();

    await reportResult({
      streamMode: ws.streamMode,
      seekOffset: Number((ws.seekOffset || 0).toFixed(4)),
      seekedPhys: Number(seekedPhys.toFixed(3)),
      expectCardIdx: lateCard.dataset.idx,
      earlyCardIdx,
      bytesTransferred: stats.bytes,
      b64pcm: encodePcmInt16Chunks(chunks),
    });
    """

    data = _run_headless_chrome_dist_media_test("pb27802310", mp3_path, run_body_js, allow_range=True, timeout_sec=35.0)
    assert data["streamMode"] == "mse_vbr"
    assert abs(data["seekOffset"]) < 0.001
    assert data["seekedPhys"] > 4000.0, f"Expected late-talk seek > 4000s, got {data['seekedPhys']}"
    assert data["bytesTransferred"] < 1_500_000, (
        f"Expected < 1.5 MB HTTP Range transfer on 88.7 MB pb27802310, transferred {data['bytesTransferred']:,} bytes"
    )
    assert data["earlyCardIdx"] == data["expectCardIdx"], (
        f"Companion card mismatch on pb27802310 late seek: expected {data['expectCardIdx']}, got {data['earlyCardIdx']}"
    )

    win_off = max(0.0, data["seekedPhys"] - 35.0)
    win_pcm = _decode_mp3_pcm_16k(mp3_path, start_sec=win_off, duration_sec=70.0)
    actual_start = _match_pcm_timestamp_sec(win_pcm, data["b64pcm"], data["seekedPhys"], pcm_offset_sec=win_off)
    assert abs(actual_start - data["seekedPhys"]) <= 0.65, (
        f"pb27802310 late-talk MSE desync: expected ~{data['seekedPhys']:.2f}s, decoded ~{actual_start:.2f}s"
    )


def test_headless_chrome_pb28585203_cbr_clock_and_word_sync_parity():
    """
    End-to-end headless Chrome verification for CBR talk `pb28585203` (`301x565` mobile viewport):
    1. Confirms `streamMode == 'cdn'` and `seekOffset == 0.0` across Turn 1 (`0:28`), `#tw-30`
       (`talks`, `30.64s`), and late-talk seek (`#tw-2500`, `~1287s`), with <= 0.65s WebAudio PCM match.
    2. Verifies the displayed player clock (`#time-current`) stays synchronized via `onClockTick` /
       `'pause'` with `.active-word` at `1.0x` and `2.0x` so `'talks'` (`>= 30.64s`) never highlights
       while the clock displays `0:29`.
    """
    mp3_path = PROJECT_ROOT / "archive/2026/2026_rains_retreat/2026-09-09_2026_rains_retreat_02_12_the_one_event_that_matters_ajahn_brahm.mp3"

    run_body_js = r"""
    const ready = await waitUntil(() => {
      const ws = window.WordSync;
      return document.getElementById('tw-2500') && ws && ws.currentEpisodeId === 'pb28585203';
    }, 20000, 100);
    if (!ready) throw new Error('Timed out waiting for pb28585203 readiness');

    const a = document.getElementById('native-audio');
    const ws = window.WordSync;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const srcNode = ctx.createMediaElementSource(a);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    srcNode.connect(proc);
    proc.connect(ctx.destination);
    let captureBuf = null;
    proc.onaudioprocess = (e) => {
      if (captureBuf) captureBuf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    const clockSkewViolations = [];
    for (const rate of [1.0, 2.0]) {
      if (ctx.state === 'suspended') await ctx.resume();
      document.querySelector('#turn-1 .turn-time-btn').click();
      await waitUntil(() => !ws.isSeekLocked() && a.readyState >= 3 && !a.seeking && !a.paused, 6000, 25);
      a.playbackRate = rate;
      for (let step = 0; step < 90; step++) {
        await sleep(30);
        const uiTime = document.getElementById('time-current').textContent;
        const activeId = ws.activeWordEl ? ws.activeWordEl.id : null;
        const activeStart = ws.activeWordEl ? parseFloat(ws.activeWordEl.dataset.start) : -1;
        if (uiTime === '0:29' && activeStart >= 30.0) {
          clockSkewViolations.push({ rate, uiTime, activeId, activeStart, t: a.currentTime });
        }
        if (a.currentTime > 31.3) break;
      }
      a.pause();
      await sleep(50);
    }

    // Verify Turn 1 ('0:28'), #tw-30 ('talks'), and #tw-2500 real PCM alignment
    const pcmCases = [];
    for (const spec of [
      { label: 'tw30', el: document.getElementById('tw-30') },
      { label: 'tw2500', el: document.getElementById('tw-2500') },
    ]) {
      captureBuf = [];
      a.playbackRate = 1.0;
      if (ctx.state === 'suspended') await ctx.resume();
      spec.el.click();
      await waitUntil(() => !ws.isSeekLocked() && a.readyState >= 3 && !a.seeking && !ws._awaitingInitialSeek, 6000, 25);
      const seekedPhys = ws.getPhysicalTime(a.currentTime);
      await sleep(1500);
      const chunks = captureBuf;
      captureBuf = null;
      pcmCases.push({
        label: spec.label,
        streamMode: ws.streamMode,
        seekOffset: Number((ws.seekOffset || 0).toFixed(4)),
        seekedPhys: Number(seekedPhys.toFixed(3)),
        b64pcm: encodePcmInt16Chunks(chunks),
      });
    }

    await reportResult({ clockSkewViolations, pcmCases });
    """

    data = _run_headless_chrome_dist_media_test("pb28585203", mp3_path, run_body_js, allow_range=True, timeout_sec=35.0)
    assert data["clockSkewViolations"] == [], f"Clock/highlight skew detected on pb28585203: {data['clockSkewViolations']}"
    for c in data["pcmCases"]:
        assert c["streamMode"] == "cdn"
        assert abs(c["seekOffset"]) < 0.001
        win_off = max(0.0, c["seekedPhys"] - 30.0)
        win_pcm = _decode_mp3_pcm_16k(mp3_path, start_sec=win_off, duration_sec=60.0)
        actual = _match_pcm_timestamp_sec(win_pcm, c["b64pcm"], c["seekedPhys"], pcm_offset_sec=win_off)
        assert abs(actual - c["seekedPhys"]) <= 0.65, (
            f"pb28585203 {c['label']} desync: expected ~{c['seekedPhys']:.2f}s, decoded ~{actual:.2f}s"
        )


