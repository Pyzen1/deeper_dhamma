# Deeper Dhamma Centralized Databases (`databases/`)

This directory centralizes all SQLite databases utilized by the BSWA Deeper Dhamma AI Speech Transcription, Diarization, and Search Suite.

```text
databases/
├── sources/                # Pristine local copies of upstream authority documents (mirrored to dist/sources/)
├── buddhism_lexicon.db     # Master Pali terminology, canonical phrases, translations & phonetic rules
├── dhamma_transcripts.db   # Canonical transcripts archive & FTS5 search index
├── voiceprints.db          # Reference speaker embeddings gallery (ECAPA-TDNN)
└── readme.md               # Architecture, lifecycle & separation rationale
```

---

## Why Separate Database Files? (Architecture & Rationale)

While consolidating these files under a single `databases/` folder makes discovery, backup, and inspection intuitive, keeping them as **three distinct SQLite database files** is a deliberate architectural decision based on the following factors:

```text
+-----------------------------------------------------------------------------------------+
|                                    LIFECYCLE SEPARATION                                 |
+-----------------------------------------------------------------------------------------+
|                                                                                         |
|  [buddhism_lexicon.db]           [voiceprints.db]             [dhamma_transcripts.db]   |
|  - Role: Code Reference Asset    - Role: Model Gallery Cache  - Role: Operational Store |
|  - Mutability: Static / Read     - Mutability: Model Rebuilds - Mutability: High Writes |
|  - Git: TRACKED IN GIT           - Git: IGNORED               - Git: IGNORED            |
|  - Size: ~550 KB                 - Size: <5 MB                - Size: Scales to GBs     |
|                                                                                         |
+-----------------------------------------------------------------------------------------+
```

### 1. Version Control & Distribution Boundary
* **`buddhism_lexicon.db`** represents verified doctrinal reference data (SuttaCentral Bodhi/Sujato translations and BSWA teaching terminology). It is **tracked directly in Git** (explicitly allowed in `.gitignore`) so that any clone of the repository immediately possesses the full Buddhist terminology engine without needing external setup.
* **`dhamma_transcripts.db`** and **`voiceprints.db`** are local generated runtime artifacts. Merging them into a single file would either bloat Git history with hundreds of megabytes of binary transcription churn or force the lexicon out of version control.

### 2. Acoustic Model Coupling
* **`voiceprints.db`** stores 192-dimensional floating-point embeddings produced by `speechbrain/spkrec-ecapa-voxceleb`.
* If the underlying embedding encoder is upgraded or swapped in the future, the gallery can be cleared and rebuilt (`python main.py voiceprints --rebuild`) without migrating or risking the transcribed text in `dhamma_transcripts.db`.

### 3. Write Contention & Lock Isolation
* SQLite uses database-level write locks (even in WAL mode, there is only one concurrent writer).
* During long-running batch transcription runs, `dhamma_transcripts.db` is continuously writing segments and synchronizing FTS5 index tables.
* Keeping `buddhism_lexicon.db` and `voiceprints.db` separate guarantees that term lookups, phonetic regex checks, and speaker verification queries never block or wait on transcription write transactions.

### 4. Blast Radius & Fault Tolerance
* A crash, WAL recovery event, or corrupt index rebuild on `dhamma_transcripts.db` leaves the reference lexicon and speaker gallery completely intact.
* Users can purge, reset, or export the transcript archive independently.

---

## Database Overview & Schemas

### 1. `buddhism_lexicon.db` & `databases/sources/`
* **File:** `databases/buddhism_lexicon.db` (~1.25 MB)
* **Local Upstream Archive:** `databases/sources/` (mirrored into `dist/sources/` during `python main.py web --build`)
* **Status:** Tracked in Git
* **Python Interface:** `deeper_dhamma.lexicon.BuddhismLexiconDatabase`, `deeper_dhamma.terminology.TerminologyEditor`, `deeper_dhamma.build_lexicon`
* **Key Tables:**
  * `terms`: 2,447 doctrinal, canonical text/sutta, & monastic Vinaya entries with diacritics, plain Romanization, categories, foreign key `source_document_id`, per-item `source_url`, and teacher translation columns (`translation_bodhi`, `translation_sujato`, `translation_brahm`, `translation_brahmali`). Zero terms are hardcoded in Python; all entries are deterministically parsed from `databases/sources/`.
  * `phrase_rules`: Contextual phonetic correction rules that intercept Whisper ASR misrecognitions.
  * `source_documents`: 4 canonical offline authority reference documents with local mirror path (`mirror_url`), raw content (`content_text`), zlib compression (`content_compressed`), and SHA-256 integrity hashes of the pristine source files:
    1. **Pali Glossary for Bhikkhus Bodhi and Sujato** (1,063 terms comparative concordance table; local source: `sources/suttacentral_bodhi_sujato_glossary.json`; canonical URL: `https://discourse.suttacentral.net/t/pali-glossary-for-bhikkhus-bodhi-and-sujato/12008`).
    2. **SuttaCentral Vinaya Piṭaka: Monastic Law of the Theravāda School** by Bhikkhu Brahmali (1,302 unique terms monastic law table; local source: `sources/suttacentral_brahmali_vinaya_glossary.html`; canonical URL: `https://suttacentral.net/edition/pli-tv-vi/en/brahmali/appendix-glossary`).
    3. **The Word of the Buddha: BSWA Glossary & Canonical Translations** by Ajahn Brahm (55 terms & canonical book titles parsed from `sources/bswa_word_of_the_buddha_2024.pdf`; canonical URL: `https://bswa.org/teaching/the-word-of-the-buddha-book/`).
    4. **SuttaCentral Tipiṭaka: Canonical Nikāyas & Discourses (DN & MN)** by Bhikkhu Sujato & Bhikkhu Bodhi (219 Piṭaka, Nikāya, and DN/MN sutta titles parsed from `sources/suttacentral_super_name_root.json`, `sources/suttacentral_super_name_en_sujato.json`, `sources/suttacentral_suttaplex_dn.json`, and `sources/suttacentral_suttaplex_mn.json`; canonical URL: `https://suttacentral.net/pitaka/sutta`).
  * `v_terms`: SQL view joining `terms` with `source_documents` (`COALESCE(t.source_url, s.url) AS source_url`, `s.mirror_url AS source_mirror_url`) for zero-overhead client retrieval.
  * `fts_terms`: SQLite FTS5 virtual table for sub-millisecond full-text lexical search.

### 2. `voiceprints.db`
* **File:** `databases/voiceprints.db` (~324 KB)
* **Status:** Ignored by Git (rebuildable via `python main.py voiceprints --rebuild`)
* **Python Interface:** `deeper_dhamma.voiceprints.VoiceprintDatabase`, `deeper_dhamma.profiler.AcousticProfiler`
* **Key Tables:**
  * `speaker_gallery`: 155 acoustic reference segments. Stores 192-d ECAPA-TDNN embedding vectors (`BLOB`), teacher slug, display name, era (`1997_2003`, `2004_2014`, `2015_2026`), role, and time offsets.
  * `voiceprints`: Consolidated speaker embeddings table.

### 3. `dhamma_transcripts.db`
* **File:** `databases/dhamma_transcripts.db` (~168 KB initial)
* **Status:** Ignored by Git (primary operational store)
* **Python Interface:** `deeper_dhamma.storage.TranscriptDatabase`
* **Key Tables:**
  * `episodes`: High-level talk metadata (id, title, date, year, primary teacher, media URL, audio duration, multi-speaker flags, speaker shares, and JSON terminology changelogs).
  * `speech_segments`: Granular timestamped dialogue turns (`start_sec`, `end_sec`, `speaker_slug`, `speaker_display`, `text`).
  * `transcripts_fts`: SQLite FTS5 external content table with synchronization triggers on `speech_segments` enabling sub-5ms full-text search.

---

## Cross-Database Querying via SQLite `ATTACH`

If relational joins across the separated databases are required (e.g., cross-referencing transcribed speech turns with speaker gallery profiles or lexicon terms), SQLite natively attaches multiple databases to a single session:

```sql
-- Open connection to dhamma_transcripts.db, then attach companion databases:
ATTACH DATABASE 'databases/voiceprints.db' AS vp;
ATTACH DATABASE 'databases/buddhism_lexicon.db' AS lex;

-- Query speaker turn counts with profile display names across databases:
SELECT 
    s.speaker_slug,
    g.display_name,
    COUNT(s.id) AS turn_count
FROM speech_segments s
LEFT JOIN vp.speaker_gallery g ON s.speaker_slug = g.speaker_name
GROUP BY s.speaker_slug, g.display_name
ORDER BY turn_count DESC;
```

---

## Static Web Distribution Compilation (`dhamma_web.db`)

While `buddhism_lexicon.db`, `voiceprints.db`, and `dhamma_transcripts.db` remain strictly separated during ingestion, training, and transcription on the developer system, the web application runs 100% serverless via in-browser **SQLite WASM**:

```text
=================== DEVELOPMENT / INGESTION (Source) ===================
  [buddhism_lexicon.db]       [voiceprints.db]       [dhamma_transcripts.db]
  - Tracked in Git            - Ignored by Git       - Ignored by Git
  - Doctrinal reference       - 192-d ECAPA vectors  - Live transcription writes
           |                          |                         |
           | (Doctrinal terms)        x (EXCLUDED FROM WEB)     | (Segments, FTS5)
           +--------------------------+-------------------------+
                                      |
                                      v  python main.py web --build
=================== STATIC WEB DISTRIBUTION (dist/) ====================
                           [dhamma_web.db]
                   - episodes & speech_segments
                   - transcripts_fts (FTS5)
                   - terms & lexicon_fts
                   - PRAGMA user_version = <YYYYMMDD>
                   - VACUUM (zero fragmentation, ~2.5 MB)
                                      |
                                      v
                             Shipped to Browser
```

* **Why Combine for Web?** The browser is 100% read-only (zero write lock contention) and does not perform acoustic inference (`voiceprints.db` is excluded). Consolidating into `dhamma_web.db` allows the browser to download and query a single vacuumed file.
* **Cache Validation**: The build script stamps `PRAGMA user_version = <YYYYMMDD>` at byte offset 60..63 of the file header. The client worker issues a 100-byte HTTP Range probe (`Range: bytes=0-99`) to validate local `IndexedDB` caching before fetching any updates.

## Pluggable Web Architecture: Zero Code Duplication

Both the live development server (`python main.py serve --run`) and the static site (`python main.py web --build`) share 100% of the UI code, CSS styling, audio player, and templates without duplication.

Data access is decoupled via a dependency-injected client adapter:

```text
+---------------------------------------------------------------------------------+
|                         Unified Frontend (100% Shared)                          |
|  views/index.html + static/style.css + static/app.js (calls window.DeeperDhammaDB)
+---------------------------------------------------------------------------------+
                                         |
                       loads <script src="db_client.js">
                                         |
            +----------------------------+----------------------------+
            |                                                         |
            v (Local Dev: serve --run)                                v (Static Site: web --build)
[ adapters/api_client.js ]                                  [ adapters/wasm_client.js ]
  - Served dynamically at /static/db_client.js                - Copied as dist/db_client.js
  - Queries Bottle /api/* endpoints                           - Queries dist/dhamma_web.db in-browser
  - Instant live DB reflection during transcription           - Zero /api/ or backend fallback in dist/
```


