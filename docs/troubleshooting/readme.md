# Deeper Dhamma Troubleshooting & Architecture Guide

Welcome to the Deeper Dhamma troubleshooting documentation. This index maps symptoms, system components, and diagnostic procedures to modular topic guides.

---

## Topic Index

| Topic / Issue | Key Symptoms | Relevant Modules | Guide |
| :--- | :--- | :--- | :--- |
| **VBR Audio Seek Divergence** | Word highlight ~15s ahead of spoken audio on VBR talks (`pb27802310`) in Firefox; gradual drift in Chromium. | `word_sync.js`, `calibration.py` | [vbr_audio_sync.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/vbr_audio_sync.md) |
| **Sentence Tokenization & Word Timing** | Spoken numbers/decimals (`6.15`, `5.30`), hyphenated compounds (`citta-viveka`, `pb22228026`), or stranded lead-in words shift word highlights. | `asr.py`, `terminology.py`, `word_sync.js`, `app.js`, `aligner.py` | [sentence_tokenization_and_word_timing.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/sentence_tokenization_and_word_timing.md) |
| **Offline Latency & Teleprompter Scroll** | >1s spinner loading transcripts offline; jerky line-break auto-scrolling during playback. | `db_worker.js`, `app.js`, `word_sync.js` | [offline_loading_and_teleprompter.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/offline_loading_and_teleprompter.md) |
| **Firefox Page Reload Skew** | `Ctrl+R` / `F5` causes `"Failed to load transcript."` and `"0 terms"` in Pali Lexicon badge. | `svc_worker.js`, `export_web.py`, `app.js` | [firefox_reload_and_service_worker_skew.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/firefox_reload_and_service_worker_skew.md) |
| **Bookmarks & GitHub Pages Deploy** | Red error `Unknown message type: get_episodes_by_ids` on `#bookmarks`; live site deployment stalls. | `wasm_client.js`, `db_client.js`, `export_web.py` | [bookmarks_worker_sync_and_github_pages.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/bookmarks_worker_sync_and_github_pages.md) |
| **Windows MAX_PATH Audio Ingestion** | Ingestion terminates on long titles with `aria2c errorCode=16` (`errNum=3 Failed to open file`). | `downloader.py` | [audio_ingestion_path_lengths.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/audio_ingestion_path_lengths.md) |
| **Service Worker Double-Caching & Atomic Updates** | New talks missing after rebuild; hard refresh stuck on old 5.4MB DB; only cache reset works. | `db_worker.js`, `svc_worker.js`, `app.js` | [service_worker_cache_and_atomic_db_updates.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/service_worker_cache_and_atomic_db_updates.md) |
| **Diagnostic & Verification Procedures** | Running test suites, cross-browser headless verification, rebuilding static assets. | `pytest`, `main.py web --build` | [diagnostic_and_verification_procedures.md](file:///c:/dev/deeper_dhamma/docs/troubleshooting/diagnostic_and_verification_procedures.md) |

---

## Architectural Principles

1. **100% Serverless Static Architecture**:
   The static web distribution (`dist/`) runs with zero backend server dependencies, streaming directly from the Podbean CDN and querying SQLite via WASM in Web Workers.
2. **Deterministic Playback Clocks**:
   Playback timing always adheres to the 1:1 decoded 44.1 kHz PCM stream clock. VBR offsets are handled purely at seek time via binary `VBR1` trailer metadata and client-side header neutralization.
3. **Atomic Background Updates**:
   Database refreshes execute non-blocking checks in the background, validating candidate database binaries in isolated worker instances before hot-swapping in-memory connections with zero interruption to active reading.

