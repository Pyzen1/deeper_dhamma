# Diagnostic & Verification Procedures

## 1. Running the Cross-Browser Synchronization Test Suite

Run `pytest` to verify byte parity, `VBR1` trailer integrity, client-side `Xing -> Info` progressive `Blob` neutralization, and real headless Firefox + Chrome playback synchronization:

```powershell
pytest tests/
```

Specifically:
- `tests/test_cross_browser_word_sync.py`:
  - Verifies that all VBR episodes in `databases/dhamma_transcripts.db` store unwarped physical PCM timestamps in `episode_words` and valid full-duration `VBR1` trailers.
  - Launches headless **Mozilla Firefox** and headless **Google Chrome** against a pure static HTTP server (serving raw MP3s with `Access-Control-Allow-Origin: *` just like Podbean CDN) to verify `pb27802310` parity (`O(1)` `< 1.5 MB` late-talk MSE seek on 88.7 MB MP3), full `dist/` Chrome PCM cross-correlation on `pb28769672` (`streamMode == 'mse_vbr'`, `seekOffset == 0.0`, `< 4 MB` across 5 jumps, continuous cross-chunk boundary playback, and rapid `card85 -> tw673 -> card20` ordering), `pb28585203` CBR mobile clock-vs-highlight parity (`1.0x`/`2.0x`), and automatic `200 OK` non-206 downgrade from `'mse_vbr'` to `'patched_blob'`.
- `tests/test_audio_cdn_sync.py`:
  - Verifies 1:1 bit-for-bit parity between local `archive/` MP3 files and Podbean CDN streams.
- `tests/test_export_web.py`:
  - Verifies static site compilation, Service Worker version stamping, dynamic word counts, IndexedDB startup, and atomic background updates.

---

## 2. Rebuilding Static Web Assets & Resetting Browser Cache

Whenever `dhamma_transcripts.db`, `word_sync.js`, `app.js`, `style.css`, or `index.html` are updated, recompile the static `dist/` bundle:

```powershell
python main.py web --build
```

Each build emits gzipped database shards (`core.db.gz`, `talks_1..4.db.gz`, `words_1..4.db.gz`) plus `db_manifest.json` (`sharded_v1`) stamped with a fresh Unix timestamp in `PRAGMA user_version` and SHA-256 digests. Additionally, `python main.py web --run` automatically checks `_is_dist_stale(dist_path)` and rebuilds `dist/` whenever `word_sync.js`, `app.js`, `index.html`, or `dhamma_transcripts.db` is newer than `dist/index.html`, and serves static preview assets with `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` headers.

If a browser tab has cached old OPFS or IndexedDB database state:
1. Perform a hard reload (`Ctrl+Shift+R` or `Ctrl+F5` in Firefox / Chrome), or
2. Run `window.resetDeeperDhammaCache()` in the browser developer console to purge the SQLite cache, delete the IndexedDB store, unregister active service workers, and reload cleanly.

---

## 3. Targeted Test Execution Commands

| Target Area | Test Command |
| :--- | :--- |
| **All Web & Synchronization Tests** | `python -m pytest tests/test_export_web.py tests/test_cross_browser_word_sync.py` |
| **App-Shell Layout & Responsive Chrome** | `python -m pytest tests/test_export_web.py -k "app_shell or companion"` |
| **Headless Cross-Browser Word Sync** | `python -m pytest tests/test_cross_browser_word_sync.py -v` |
| **Service Worker & Atomic DB Hot-Swap** | `python -m pytest tests/test_export_web.py -k "test_service_worker or test_atomic"` |
| **Downloader & Parity Checks** | `python -m pytest tests/test_downloader_parity.py tests/test_sync_repair.py` |

