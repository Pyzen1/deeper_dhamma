# Deeper Dhamma Troubleshooting Guide

The troubleshooting documentation has been modularized into targeted topic guides under [`docs/troubleshooting/`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/readme.md).

For the complete topic index, see:
👉 **[`docs/troubleshooting/readme.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/readme.md)**

---

## Quick Reference & Sub-Guides

| Topic | Focus Area | Guide |
| :--- | :--- | :--- |
| **VBR Audio Seek Divergence & Xing Headers** | Gecko vs. Chromium seek mechanics, `VBR1` binary trailer format, client-side progressive `Blob` Xing neutralization. | [`vbr_audio_sync.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/vbr_audio_sync.md) |
| **Sentence Tokenization & Word Alignment** | Preservation of decimal numbers (`6.15`), punctuation adhesion, deterministic zero-loss sentence scanning. | [`sentence_tokenization_and_word_timing.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/sentence_tokenization_and_word_timing.md) |
| **Offline Transcript Loading & Teleprompter** | Offline caching, Range probe reuse, lazy vocabulary caching, continuous line-interpolated teleprompter scrolling. | [`offline_loading_and_teleprompter.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/offline_loading_and_teleprompter.md) |
| **Firefox Page Reloads & Service Worker Skew** | Dynamic build-time cache rotation, online network-first navigation with offline fallback, defensive DOM guards. | [`firefox_reload_and_service_worker_skew.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/firefox_reload_and_service_worker_skew.md) |
| **Bookmarks & GitHub Pages Deployment** | Jekyll bypass via `.nojekyll`, batch worker lookup fallback, HTTP cache bypass on reload. | [`bookmarks_worker_sync_and_github_pages.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/bookmarks_worker_sync_and_github_pages.md) |
| **Windows MAX_PATH Audio Ingestion** | Resolving `aria2c errorCode=16` on long filenames using absolute directory paths and native downloader fallback. | [`audio_ingestion_path_lengths.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/audio_ingestion_path_lengths.md) |
| **Service Worker Double-Caching & Atomic Updates** | Resolving hard-refresh update failures, IndexedDB version poisoning, candidate DB validation, and in-memory hot-swapping. | [`service_worker_cache_and_atomic_db_updates.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/service_worker_cache_and_atomic_db_updates.md) |
| **Diagnostic & Verification Procedures** | Cross-browser test commands, headless browser testing, cache reset procedures, and static site rebuilds. | [`diagnostic_and_verification_procedures.md`](file:///c:/dev/deeper_dhamma/docs/troubleshooting/diagnostic_and_verification_procedures.md) |
