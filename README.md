# Deeper Dhamma AI Transcription, Diarization & Search Suite

Consolidated application for the Buddhist Society of Western Australia (BSWA) **Deeper Dhamma** audio archive (30+ years of Theravada Buddhist teachings, retreats, and monastic Q&A sessions).

## Support &amp; Dāna (Donations)

In accordance with the monastic Vinaya and the living Buddhist tradition of generosity (*dāna*), the Dhamma teachings are priceless and freely accessible to everyone without paywalls, subscriptions, or advertisements.

<!--
- 💛 **Support Site Upkeep &amp; Development**: Voluntary contributions directly help cover ongoing infrastructure costs, technical maintenance, and continued open-source feature development for this study tool.
-->
- 🏛️ **Donate to BSWA.org**: Donate directly to the [Buddhist Society of Western Australia (BSWA)](https://bswa.org/support-us/) to support the monastic Sangha, Bodhinyana Monastery, Dhammasara Nuns Monastery, and retreat facilities.
- 📜 **Donate to SuttaCentral**: Support [SuttaCentral](https://suttacentral.net/donate-now?lang=en) in making early Buddhist texts and translations freely available worldwide.

## Architecture & Features

- **Centralized Database Storage (`databases/`)**: 
  - `databases/dhamma_transcripts.db`: Canonical transcripts warehouse & zero-copy FTS5 search index (pure domain data keyed by `pbXXXXXXX`, zero local filepaths).
  - `databases/pipeline_state.db`: Local operational ingestion state (archive filepaths, transcription flags, and error logs; excluded from web distribution).
  - `databases/voiceprints.db`: Era-tagged speaker embeddings gallery.
  - `databases/buddhism_lexicon.db`: Master Pali terminology, translation matrix, and phonetic rule definitions.
- **High-Accuracy Speech-to-Text (`faster-whisper-large-v3`)**:
  - Float16 on NVIDIA CUDA (RTX 5070 Ti, 16 GB GDDR7) running **single-worker sequential transcription (`batch_size=1` by default)** with tuned Silero VAD to guarantee 100% speech capture with zero dropped words or boundary truncation.
  - **1-Slot Lookahead CPU Prefetch Pipeline & Ryzen 7 9800X3D Tuning (`cpu_threads=8`)**: Overlaps Talk $N+1$'s CPU-bound 16 kHz audio decoding, Silero VAD speech chunk detection, 128-bin log-Mel spectrogram STFT (`Transcriber.prepare_audio`), and VBR1 seek table scanning (`TranscriptionPipeline.prefetch_file`) in a background thread while the GPU is executing Talk $N$'s ASR pass, eliminating the ~7.7s inter-talk CPU stall with 100% bit-for-bit output parity.
  - In-memory waveform caching for zero-disk acoustic profiling and speaker attribution.
  - Teacher-specific prompt steering with dynamic Pali lexicon conditioning.
  - Live interactive CLI progress bar (`TranscriptionProgressBar`) reporting real-time factor (RTF), percentage, elapsed/total audio time, ETA, turn count, and recognized speech snippets.
- **Era-Tagged Voiceprint Gallery & Continuous Diarization (`speechbrain/spkrec-ecapa-voxceleb`)**:
  - 192-d ECAPA-TDNN embeddings cataloging monastics across eras (`1997_2003`, `2004_2014`, `2015_2026`) with historical recording year detection (`extract_recording_year`) to handle backfilled audio uploads.
  - Outlier-resistant composite voiceprint scoring (`_compute_teacher_composite` / `score_speaker`) with gallery cluster pruning to eliminate single-sample acoustic spikes.
  - Candidate-aware hysteresis and isolated turn smoothing (`_smooth_isolated_turns`) to eliminate false third-party teacher flips on solo talks while preserving genuine secondary speakers (such as archival tape narrators and audience Q&A).
  - Word-level conversational pause change-point detection: splits multi-speaker exchanges grouped by ASR at natural speech pauses ($\ge 0.45\text{s}$) while preserving pristine Whisper text on un-split turns and adhering word punctuation tokens.
- **Buddhist Reference Terminology Editor & Canonical Authority Documents**:
  - 2,447 canonical Pali entries & multi-word phrases covering doctrinal concepts, Tipiṭaka text titles, and Vinaya monastic law across Theravada traditions.
  - Non-destructive context-aware phrase disambiguation (using non-consuming lookaheads for multi-word misrecognitions like `vassa`, `jhana`, `nimitta`, `yoniso manasikara`, `noble eightfold path`, and `patimokkha`).
  - Automated word-timing array synchronization (`_sync_word_timings`) maintaining 1:1 parity with binary synchronization BLOBs (`words/<id>.bin`) when multi-word misrecognitions are merged into canonical tokens.
  - Deterministically compiled from pristine local upstream sources (`databases/sources/`) with authentic external links (`source_url`) and mirrored offline verification copies (`dist/sources/`).
  - Four bitstream-verified offline authority reference texts stored with SHA-256 integrity hashes:
    1. *Bodhi & Sujato Glossary* (1,052 terms comparative concordance table)
    2. *Brahmali Vinaya Piṭaka* (1,309 terms monastic law table)
    3. *Ajahn Brahm Meditation & Dhamma Glossary* (55 terms extracted from *The Word of the Buddha*, BSWA 2024 PDF)
    4. *SuttaCentral Tipiṭaka Canon* (216 canonical basket/nikāya names and DN/MN sutta titles)
  - Greedy multi-word phrase highlighting and phrase-level audio seeking (`Majjhima Nikāya`, `Sabbāsava Sutta`, `yoniso manasikara`, etc.) in the live Lexicon Companion.
  - Canonical dictionary normalization in standard Latin Pali (`jhana`, `samadhi`, `anatta`, `Bodhinyana`, `Rains Retreat`).
  - Inlines structured audit changelogs into episode metadata.
- **Dynamic Serverless Web Application (SQLite WASM & REST)**:
  - **Live Production Deployment**: Hosted at [https://deeperdhamma.com/](https://deeperdhamma.com/) (GitHub Pages on `gh-pages` branch) with automated HTTP/HTTPS forwarding from `deeperdhamma.net`.
  - 100% dynamic, on-demand querying directly from SQLite (zero hardcoded HTML).
  - Diacritic-insensitive real-time search filtering across all lexicon terms and authority documents.
  - Full 3,246-talk playable archive in Browse Talks with a "Transcribed Only" toggle (default ON) and paginated "Load More" browsing.
  - Live audio companion highlighting Pali terms dynamically during playback.
  - Full browser Back and Forward history support (`popstate` SPA history routing) without interrupting audio streaming.
  - Universal shareable URLs for text messages and email: supports hashes (`/#talk/pb28113880`), query parameters (`/?talk=pb28113880`), and clean server paths (`/talk/pb28113880`).
  - Precision timestamp links (`?t=125` or `?t=2m05s` or `?t=02:05`): automatically scrolls to the turn, highlights the speech segment, and starts playback at that exact second.
  - **Sticky Transcript Toolbar & Triple-Option Word Sync (`Off | On | Track`)**:
    - Glassmorphic sticky header (`#transcript-sticky-toolbar`) keeps synchronization and export controls permanently reachable during long reads.
    - Global in-memory state (`WordSync.mode`) with three dedicated operational modes:
      - **`Off`**: Completely disables word-level highlight tracking.
      - **`On`**: Highlights active words in real time with audio playback; preserves 100% manual scroll control.
      - **`Track`** (default): Seamless teleprompter auto-scrolling that continuously interpolates vertical reading progression across each spoken line with sub-pixel damping, smoothly gliding upward without jarring line-break jumps. Temporarily yields to manual user touch/wheel interaction with automatic resumption.
  - Deterministic zero-loss sentence scanner (`splitSentences`) in WordSync: preserves internal decimals (`6.15`, `5.30`, `3.14`), spaced dots (`6 .15`), quotes, and abbreviations without regex backtracking or dropping DOM tokens, guaranteeing 100% word-highlight synchronization.
  - **Atomic Service Worker Versioning & Network-First Navigation**:
    - Pre-rendered Service Worker (`svc_worker.js`) stamped with dynamic Unix build version (`deeper_dhamma_shell_{timestamp}`), automatically rotating caches and purging obsolete assets across builds.
    - Online Network-First navigation with 1.2s timeout fallback ensures browser refreshes (`Ctrl+R` / `F5`) always serve the freshest application shell while guaranteeing 100% offline PWA resilience.
    - Defensive DOM null guards across all drawer elements and in-app 1-click OPFS cache recovery button (`window.resetDeeperDhammaCache()`).
  - **Atomic Background Database Hot-Swap & Zero-Disruption Sync**:
    - **Instant Startup**: Immediately deserializes and mounts cached IndexedDB snapshot so UI loads with 0ms latency.
    - **Background Probing & Size Verification**: Range probes compare both version header and total byte length (`Content-Range`), invalidating poisoned or stale caches automatically.
    - **Atomic Integrity Verification Gate**: Downloads candidate database in the background without affecting the running session; validates SQLite magic header and test-deserializes in an isolated instance before touching IndexedDB.
    - **In-Memory Hot-Swap**: Atomically replaces active SQLite connection (`db = candidateDb`) and dispatches `db_hot_swapped` event, allowing `app.js` to update talk counts, statistics, and search results seamlessly without a browser refresh.
    - **Fail-Safe Offline Retention**: If background downloads drop or fail, the active cached database remains 100% operational with zero user disruption.
  - **Local Bookmarks & Fluid Card Reordering Physics**:
    - Fast recall bookmarks stored locally with zero metadata bloat (persists only talk IDs in `localStorage`, querying SQLite on-demand with resilient fallback).
    - Dedicated Bookmarks tab (`#bookmarks-view`) with unread badge counter, dynamic reordering, and talk playback controls.
    - Sleek compact two-column card layout (<110px height, >50% space savings) with pinned left reorder rail, large finger-friendly touch targets (`min-height: 36px`), and immediate talk playback/download action strip.
    - Decoupled generic `CardPhysics` engine: ▲ / ▼ arrow buttons trigger simultaneous physical card exchange glide animations; pointer/touch drag-and-drop leaves an in-place ghost card while dragging a full-opacity elevated clone (with 240ms touch long-press support), guided by a glowing placement indicator line, and resolving with a multi-card FLIP drop animation that physically opens space and glides into position.
  - 1-click "Share Talk" and "Share Moment" (🔗) copy-to-clipboard buttons with toast feedback.
- **Lossless On-Demand Format Generation**:
  - Generates Markdown (`.md`), WebVTT (`.vtt`), or JSON (`.json`) on the fly directly from SQLite.

## Unified CLI Commands

The entire application runs through `python main.py` with standard subcommands:

```powershell
# 1. Full-Text Search across the archive (<5ms latency)
python main.py search "hindrances OR obstacles"

# 2. Transcribe Audio (single file, specific year, series, or full archive)
python main.py transcribe --file archive/2001/standalone/2001-08-15_the_five_hindrances_ajahn_brahm_15_august_2001.mp3
python main.py transcribe --year 2001 --limit 5
python main.py transcribe --check-updates     # Explicitly check Hugging Face for model updates

# 3. Export Transcripts on demand
python main.py export --list
python main.py export --id pb28113880 --format md
python main.py export --year 2001 --format vtt --output-dir exports/2001_vtt/
python main.py export --all --format md --output-dir exports/all_markdown/

# 4. Manage Voiceprints Gallery & Resolve Unknown Speakers
python main.py voiceprints --list            # Inspect current reference voiceprints
python main.py voiceprints --rebuild         # Rebuild gallery from audio archive
python main.py voiceprints --inspect-unknown # Inspect unknown audio and associate discovered teachers in SQLite DB

# 5. Dashboard Status & Coverage
python main.py status -a                     # Full dashboard (summary, year, teacher tables)
python main.py status -t                     # Monastic teacher coverage breakdown

# 5. Query & Search Canonical Buddhism Lexicon (SuttaCentral Bodhi/Sujato & BSWA Brahm/Brahmali)
python main.py lexicon --lookup jhana
python main.py lexicon --search "breathing mindfulness stillness"

# 6. Autonomous Self-Correction & Synthetic Reference Curation
python main.py curate --list            # List verified references and pending candidates
python main.py curate archive/1997/1997_9_day_retreat/1997-05-23_...mp3 --duration 300 --auto-approve
python main.py curate --approve 1997-05-23_1997_9_day_retreat_day_01_part_2_the_method_for_jhana_ajahn_brahmavamso

# 7. Evaluate Accuracy against Gold-Standard Transcripts
python main.py benchmark --duration 300

# 8. Sanity Test
python main.py test --run

# 9. Sync Audio Catalog & Downloader
python main.py sync --year 2026

# 10. Transcription Progress & Archive Availability Status
python main.py status --all             # Full dashboard (summary, year breakdown, teacher breakdown)
python main.py status --summary         # High-level archive, catalog & transcription summary
python main.py status --years           # Year-by-year availability and transcription status table
python main.py status --teachers        # Monastic teacher breakdown
python main.py status --pending -y 2001 # List audio files in archive ready to be transcribed
python main.py status --completed       # List already transcribed talks in database

# 11. Static Web Application & SQLite WASM Compiler (Zero-Backend Serverless)
python main.py web --build              # Compiles vacuumed dhamma_web.db & static bundle into dist/
python main.py web --run                # Preview static site with native HTTP Range support
python main.py web --build --run        # Compile and immediately preview
python main.py web --deploy             # Compiles & deploys dist/ directly to GitHub Pages (deeperdhamma.com)
python main.py web -r --port 8080       # Custom port or output directory

# 12. Local Static Preview Server (Stdlib HTTP with RFC 7233 Range Support)
python main.py serve --run              # Serve static bundle on http://127.0.0.1:34266
python main.py serve -r --port 34266    # Custom port (requires -r/--run to start)

# 13. Run Full Verification & Unit Test Suite (151 tests, 100% passing, 0 warnings)
python -m pytest tests -p no:cov        # Execute all unit and integration tests
pytest --cov=deeper_dhamma              # Generate full code coverage report
```

## Directory Structure

```text
deeper_dhamma/
├── main.py                     # Unified CLI entry point
├── pyproject.toml              # Modern Python package configuration
├── databases/                  # Centralized SQLite databases directory
│   ├── readme.md               # Architecture & lifecycle documentation
│   ├── sources/                # Pristine upstream authority documents (JSON, HTML, PDF)
│   ├── buddhism_lexicon.db     # Master SQLite Lexicon (SuttaCentral & BSWA authorities)
│   ├── dhamma_transcripts.db   # Canonical SQLite domain warehouse & FTS5 search index
│   ├── pipeline_state.db       # Local operational state (archive filepaths & error tracking)
│   └── voiceprints.db          # Reference speaker embeddings gallery
├── deeper_dhamma/              # Consolidated Python package
│   ├── config.py               # C:\ai-models env vars & Windows DLL loading
│   ├── cli.py                  # Subcommand router
│   ├── build_lexicon.py        # Deterministic lexicon compiler from databases/sources/
│   ├── catalog.py              # Monastic catalog & era determination
│   ├── audio.py                # Sliced soundfile loading & resampling
│   ├── encoder.py              # SpeechBrain ECAPA-TDNN embeddings
│   ├── voiceprints.py          # SQLite voiceprints vector gallery
│   ├── profiler.py             # Acoustic clustering & multi-speaker profiling
│   ├── asr.py                  # faster-whisper large-v3 ASR
│   ├── aligner.py              # Speaker assignment & monologue fast-path
│   ├── lexicon.py              # BuddhismLexiconDatabase interface & FTS5 search
│   ├── terminology.py          # Context-aware Buddhist lexicon normalizer & audit tracking
│   ├── self_correction.py      # Dual-pass prompt steering & anti-drift guardrail engine
│   ├── calibration.py          # VBR stream seek calibration & in-memory Xing->Info neutralization
│   ├── storage.py              # Unified SQLite archive & on-demand generators
│   ├── pipeline.py             # End-to-end TranscriptionPipeline orchestrator
│   ├── downloader.py           # Podbean RSS feed sync
│   ├── curation.py             # Reference transcript curation & audit review
│   ├── benchmark.py            # Gold-standard accuracy benchmarks
│   ├── export_web.py           # Static site & SQLite WASM bundle compiler
│   └── web/                    # Frontend assets, views & Web Worker
│       ├── static/             # CSS, app.js, word_sync.js, db_worker.js, sqlite3.wasm
│       │   └── adapters/       # In-browser SQLite WASM adapter (wasm_client.js)
│       └── views/              # Static HTML template (index.html)
├── tests/                      # Comprehensive Unit & Integration Test Suite (151 tests)
│   ├── test_cli.py             # CLI parser, "One Obvious Way" flags, subcommands dispatch
│   ├── test_audit.py           # Ghost files, temp fragments, html error pages, archive cleanup
│   ├── test_benchmark.py       # Precision, recall, F1, and sequence-aligned WER evaluation
│   ├── test_catalog.py         # Era determination, teacher matching, clean slugging, dates
│   ├── test_status.py          # Duration formatting, progress bars, catalog & archive metrics
│   ├── test_storage.py         # PipelineStateDatabase & TranscriptDatabase FTS5/CRUD/exports
│   ├── test_profiler.py        # Fast acoustic pre-analysis, single & multi-speaker clustering
│   ├── test_main_and_cli.py    # main.py entry point and CLI subcommand integration
│   ├── test_curation_and_self_correction.py # Curation slugs, false friends, anti-drift guardrails
│   ├── test_audio_utils.py     # get_audio_info, load_audio_segment, downmixing, boundary checks
│   ├── test_export_web.py      # SQLite WASM db compilation, PRAGMA user_version, search_vocab
│   ├── test_pipeline_integrity.py # Voiceprint scoring, turn smoothing, Pali terminology
│   ├── test_lexicon_view.py    # BuddhismLexiconDatabase, core/all pagination, FTS5
│   ├── test_audio_cdn_sync.py  # Bitstream parity with Podbean CDN streams
│   ├── test_downloader_parity.py # ID3 preservation, parity audit, and archive log management
│   ├── test_sync_repair.py     # Remote parity audit and corrupt file repair
│   ├── test_stream_seek_calibration.py # VBR1 seek trailer generation & in-memory Xing patching
│   ├── test_cross_browser_word_sync.py # Headless Firefox & Chrome real-time audio sync parity
│   └── test_browser_fuzzy_search.py # Multi-word fuzzy search, Damerau-Levenshtein, V8 tests
├── docs/
│   ├── design/                 # Pipeline architecture specifications
│   └── troubleshooting/        # Modular troubleshooting guides (VBR sync, SW caching, etc.)
└── benchmarks/
    └── reference_transcripts/  # Verified word-for-word human reference transcripts
```

