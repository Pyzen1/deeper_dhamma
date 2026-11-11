# Diagnostic & Verification Procedures

## 1. Running the Cross-Browser Synchronization Test Suite

Run `pytest` to verify byte parity, `VBR1` trailer integrity, client-side `Xing -> Info` progressive `Blob` neutralization, and real headless Firefox + Chrome playback synchronization:

```powershell
pytest tests/
```

Specifically:
- `tests/test_cross_browser_word_sync.py`:
  - Verifies that all VBR episodes in `databases/dhamma_transcripts.db` store unwarped physical PCM timestamps in `episode_words` and valid full-duration `VBR1` trailers.
  - Launches headless **Mozilla Firefox** and headless **Google Chrome** against a pure static HTTP server (serving the raw unpatched VBR MP3 with `Access-Control-Allow-Origin: *` just like Podbean CDN) to verify that seeking to `"Everyone,"` (`216.30s`) and `"one"` (`231.34s`) via client-side `WordSync` lands at the exact physical audio position and highlights the exact spoken words in real time.
- `tests/test_audio_cdn_sync.py`:
  - Verifies 1:1 bit-for-bit parity between local `archive/` MP3 files and Podbean CDN streams.
- `tests/test_export_web.py`:
  - Verifies static site compilation, Service Worker version stamping, dynamic word counts, IndexedDB startup, and atomic background updates.

---

## 2. Rebuilding Static Web Assets & Resetting Browser Cache

Whenever `dhamma_transcripts.db`, `word_sync.js`, or `app.js` are updated, recompile the static `dist/` bundle:

```powershell
python main.py web --build
```

Each build stamps a fresh Unix timestamp into `PRAGMA user_version` in `dist/dhamma_web.db`. Additionally, `python main.py web --run` automatically checks `_is_dist_stale(dist_path)` and rebuilds `dist/` whenever `word_sync.js`, `app.js`, `index.html`, or `dhamma_transcripts.db` is newer than `dist/index.html`, and serves static preview assets with `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` headers.

If a browser tab has cached old OPFS or IndexedDB database state:
1. Perform a hard reload (`Ctrl+Shift+R` or `Ctrl+F5` in Firefox / Chrome), or
2. Run `window.resetDeeperDhammaCache()` in the browser developer console to purge the SQLite cache, delete the IndexedDB store, unregister active service workers, and reload cleanly.

---

## 3. Targeted Test Execution Commands

| Target Area | Test Command |
| :--- | :--- |
| **All Web & Synchronization Tests** | `pytest tests/test_export_web.py tests/test_cross_browser_word_sync.py` |
| **Headless Cross-Browser Word Sync** | `pytest tests/test_cross_browser_word_sync.py -v` |
| **Service Worker & Atomic DB Hot-Swap** | `pytest tests/test_export_web.py -k "test_service_worker or test_atomic"` |
| **Downloader & Parity Checks** | `pytest tests/test_downloader_parity.py tests/test_sync_repair.py` |

