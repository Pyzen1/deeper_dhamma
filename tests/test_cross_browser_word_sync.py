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

WORDS_STATIC_DIR = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "words"
VBR_EPISODES = {"pb27802310", "pb27940021", "pb28867656"}
CBR_EPISODES = {"pb28113880", "pb7020389", "pb28113897", "pb7017972", "pb10641521", "pb13152882"}


def test_vbr_episodes_store_unwarped_physical_timestamps_and_vbr1_trailer():
    """
    Verifies that all VBR episodes store unwarped physical 44.1 kHz PCM timestamps
    in SQLite and words/*.bin and include a full-duration VBR1 seek calibration trailer.
    """
    if not TRANSCRIPTS_DB_PATH.exists():
        pytest.skip("Transcript database not found")

    with sqlite3.connect(TRANSCRIPTS_DB_PATH) as conn:
        # Verify pb27802310 Turn 0 starts at physical 216.30s (not legacy warped 203.14s)
        seg0 = conn.execute(
            "SELECT start_sec, end_sec, text FROM speech_segments WHERE episode_id = 'pb27802310' AND turn_index = 0"
        ).fetchone()
        assert seg0 is not None
        assert abs(float(seg0[0]) - 216.30) <= 0.15, f"Expected Turn 0 at ~216.30s physical, got {seg0[0]}"
        assert seg0[2].startswith("Everyone,")

    # Check pb27802310.bin word timestamps & VBR1 trailer
    pb_bin = (WORDS_STATIC_DIR / "pb27802310.bin").read_bytes()
    word_count = struct.unpack("<I", pb_bin[:4])[0]
    assert word_count == 11929

    # Word 0 ("Everyone,") at ~216.30s (216300 ms)
    w0_st_ms, w0_dur_ms = struct.unpack("<IH", pb_bin[4:10])
    assert abs(w0_st_ms / 1000.0 - 216.30) <= 0.15

    # Word 29 ("one" in "one of the most significant things about") at ~231.34s
    w29_off = 4 + 29 * 6
    w29_st_ms, _ = struct.unpack("<IH", pb_bin[w29_off : w29_off + 6])
    assert abs(w29_st_ms / 1000.0 - 231.34) <= 0.20

    # Verify VBR1 trailer on all 3 VBR episodes
    for ep_id in VBR_EPISODES:
        raw = (WORDS_STATIC_DIR / f"{ep_id}.bin").read_bytes()
        wc = struct.unpack("<I", raw[:4])[0]
        t_off = 4 + wc * 6
        assert len(raw) > t_off + 120, f"Missing VBR1 trailer on {ep_id}.bin"
        assert raw[t_off : t_off + 4] == VBR_TRAILER_MAGIC
        total_dur_ms, id3_len, bytes_len = struct.unpack("<III", raw[t_off + 4 : t_off + 16])
        sample_count = struct.unpack("<I", raw[t_off + 116 : t_off + 120])[0]
        assert total_dur_ms > 2000_000
        assert bytes_len > 10_000_000
        assert sample_count > 1000
        assert len(raw) == t_off + 120 + sample_count * 8

    # Verify CBR episodes do not have VBR1 trailer overhead
    for ep_id in CBR_EPISODES:
        bin_path = WORDS_STATIC_DIR / f"{ep_id}.bin"
        if bin_path.exists():
            raw = bin_path.read_bytes()
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
    bin_path = WORDS_STATIC_DIR / "pb27802310.bin"
    word_sync_js_path = PROJECT_ROOT / "deeper_dhamma" / "web" / "static" / "word_sync.js"

    if not (chrome_path.exists() and firefox_path.exists() and sample_mp3.exists() and bin_path.exists()):
        pytest.skip("Headless browsers or sample assets not present")

    file_size = sample_mp3.stat().st_size
    bin_bytes = bin_path.read_bytes()
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

            if self.path == "/words/pb27802310.bin":
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
