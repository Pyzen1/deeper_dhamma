# Deeper Dhamma AI Transcription, Diarization & Search Suite

Consolidated application for the Buddhist Society of Western Australia (BSWA) **Deeper Dhamma** audio archive (30+ years of Theravada Buddhist teachings, retreats, and monastic Q&A sessions).

## Architecture & Features

- **Centralized Database Storage (`databases/`)**: 
  - `databases/dhamma_transcripts.db`: Canonical transcripts warehouse & zero-copy FTS5 search index.
  - `databases/voiceprints.db`: Era-tagged speaker embeddings gallery.
  - `databases/buddhism_lexicon.db`: Master Pali terminology, translation matrix, and phonetic rule definitions.
- **High-Accuracy Speech-to-Text (`faster-whisper-large-v3`)**:
  - Float16 on NVIDIA CUDA (RTX 5070 Ti) with BatchedInferencePipeline running **50x–70x faster than real-time**.
  - In-memory waveform caching for zero-disk acoustic profiling and speaker attribution.
  - Silero VAD speech filtering and Pali doctrinal prompt conditioning.
- **Era-Tagged Voiceprint Gallery (`speechbrain/spkrec-ecapa-voxceleb`)**:
  - 192-d ECAPA-TDNN embeddings cataloging monastics across eras (`1997_2003`, `2004_2014`, `2015_2026`).
  - Pre-analysis acoustic clustering for detecting uncredited co-teachers, Q&A dialogues, and host introductions.
  - Ultra-fast monologue bypass for solo talks.
- **Buddhist Reference Terminology Editor**:
  - Canonical dictionary normalization in standard Latin Pali (`jhana`, `samadhi`, `anatta`, `Bodhinyana`, `Rains Retreat`).
  - Inlines structured audit changelogs into metadata.
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

# 3. Export Transcripts on demand
python main.py export --list
python main.py export --id pb28113880 --format md
python main.py export --year 2001 --format vtt --output-dir exports/2001_vtt/
python main.py export --all --format md --output-dir exports/all_markdown/

# 4. Manage Voiceprints Gallery
python main.py voiceprints              # Inspect current reference voiceprints
python main.py voiceprints --rebuild    # Rebuild gallery from audio archive

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
python main.py test

# 9. Sync Audio Catalog & Downloader
python main.py sync --year 2026
```

## Directory Structure

```text
deeper_dhamma/
├── main.py                     # Unified CLI entry point
├── pyproject.toml              # Modern Python package configuration
├── databases/                  # Centralized SQLite databases directory
│   ├── README.md               # Architecture & lifecycle documentation
│   ├── buddhism_lexicon.db     # Master SQLite Lexicon (SuttaCentral Bodhi/Sujato & BSWA Brahm/Brahmali)
│   ├── dhamma_transcripts.db   # Canonical SQLite database & FTS5 search index
│   └── voiceprints.db          # Reference speaker embeddings gallery
├── deeper_dhamma/              # Consolidated Python package
│   ├── config.py               # C:\ai-models env vars & Windows DLL loading
│   ├── cli.py                  # Subcommand router
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
│   ├── storage.py              # Unified SQLite archive & on-demand generators
│   ├── pipeline.py             # End-to-end TranscriptionPipeline orchestrator
│   ├── downloader.py           # Podbean RSS feed sync
│   ├── curation.py             # Reference transcript curation & audit review
│   └── benchmark.py            # Gold-standard accuracy benchmarks
└── benchmarks/
    └── reference_transcripts/  # Verified word-for-word human reference transcripts
```

