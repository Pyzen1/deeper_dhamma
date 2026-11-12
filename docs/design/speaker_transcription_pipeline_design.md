# Speaker-Attributed Transcription & Search Pipeline Design

## 1. Executive Summary

This document specifies the technical design for the BSWA Deeper Dhamma audio transcription and speaker identification system. The system processes over 3,300 historical Dhamma talks (spanning 1997 through 2026) to generate high-fidelity, timestamped, speaker-attributed transcripts, while preserving links directly to the Podbean CDN for on-demand audio streaming.

```text
+-----------------------+      +---------------------------+      +-------------------------+
|  Podbean Audio File   | ---> |  Transcription & Speaker  | ---> |   Search Index & UI     |
|   (Local archive/)    |      |    Pipeline (Local AI)    |      |  (Podbean Stream Links) |
+-----------------------+      +---------------------------+      +-------------------------+
```

---

## 2. Core Architectural Pillars

### 2.1 Metadata Ground Truth (Bayesian Prior)
Rather than performing blind speaker clustering from audio in isolation, the pipeline cross-references `catalog.json` and standardized filenames. 
- The filename (e.g. `2025-07-16_..._ajahn_brahm.mp3`) provides ground truth for the **headline teacher**.
- The headline teacher accounts for the overwhelming majority (>85%) of speech duration.
- The pipeline only needs to segment secondary speakers (lay questioners, chanting leaders, co-presenters).

### 2.2 Temporal Vocal Drift & Aging Management (1997–2026)
Speakers' voices change over 30 years due to biological aging (lowered fundamental frequency, reduced vocal velocity) and recording medium transitions (analog cassette tapes in 1997 vs. modern digital boundary mics in 2026).
- **Multi-Centroid Voice Galleries**: Instead of a single static vector per teacher, each speaker has an era-tagged cluster gallery:
  - `era_1997_2003`: Analog tape, higher pitch, faster tempo.
  - `era_2004_2014`: Early digital compression, intermediate cadence.
  - `era_2015_2026`: High-fidelity digital acoustics, mature timbre.
- **k-Nearest Neighbors (k-NN)**: When comparing extracted voice embeddings, the system queries the nearest neighbor across all eras for that teacher.

### 2.3 Lightweight Vector Database
Speaker embeddings extracted via ECAPA-TDNN consist of 512-dimensional float32 vectors (2,048 bytes each). A gallery of 1,000 reference embeddings occupies less than 3 MB of storage, stored in a local SQLite database (`voiceprints.db`) or Parquet table.

---

## 3. End-to-End System Pipeline

```text
                              +---------------------------------------+
                              |      Audio Input (archive/*.mp3)      |
                              +---------------------------------------+
                                                  |
                         +------------------------+------------------------+
                         |                                                 |
                         v                                                 v
           +---------------------------+                     +---------------------------+
           |    faster-whisper ASR     |                     |    Speaker Diarization    |
           |      (large-v3 model)     |                     |    & Voice Activity (VAD) |
           +---------------------------+                     +---------------------------+
                         |                                                 |
                         | Text + Word Timestamps                          | Speaker Segments
                         |                                                 v
                         |                                   +---------------------------+
                         |                                   |  SpeechBrain (ECAPA-TDNN) |
                         |                                   |  Extract 512-d Embedding  |
                         |                                   +---------------------------+
                         |                                                 |
                         |                                                 v
                         |                                   +---------------------------+
                         |                                   |     Query Voiceprint      |
                         |                                   |  Database (voiceprints.db)|
                         |                                   +---------------------------+
                         |                                                 |
                         |                                                 | Matched Teacher ID
                         +------------------------+------------------------+
                                                  |
                                                  v
                              +---------------------------------------+
                              |       Alignment & Attribution         |
                              |  - Merges word timestamps with names  |
                              |  - Separates Monastics from Questions |
                              +---------------------------------------+
                                                  |
                                                  v
                              +---------------------------------------+
                              |         Output Deliverables           |
                              |  1. JSON Transcript (word-level)      |
                              |  2. Markdown Transcript (readable)    |
                              |  3. Search Index Record (SQLite)      |
                              +---------------------------------------+
```

---

## 4. Component Details & Technologies

| Pipeline Stage | Model / Tool | Hardware Target | Storage Location |
| :--- | :--- | :--- | :--- |
| **Speech-to-Text (ASR)** | `faster-whisper` (`Systran/faster-whisper-large-v3`) | NVIDIA RTX 5070 Ti (16GB VRAM, float16, `batch_size=1`, `cpu_threads=8`) | `C:\ai-models\cache\huggingface` |
| **CPU Lookahead Prefetch** | `TranscriptionPipeline.prefetch_file` + `Transcriber.prepare_audio` | AMD Ryzen 7 9800X3D (Background Thread: Decode + Silero VAD + 128-bin Mel STFT + VBR1 Scan) | In-Memory RAM (~400 MB 1-slot buffer) |
| **Voice Activity & Segmentation** | `silero-vad` + energy-based chunker | CPU (ONNX Runtime, pre-computed during lookahead prefetch) | `C:\ai-models\cache\torch` |
| **Speaker Embeddings** | `speechbrain/spkrec-ecapa-voxceleb` (ECAPA-TDNN) | CUDA (float32, 192-d) | `C:\ai-models\cache\huggingface` |
| **Voiceprint Database** | SQLite (`voiceprints.db`) | Local Disk + In-Memory Norm Cache (~5 MB) | `databases/voiceprints.db` |
| **ASR Post-Processing** | `TranscriptPostProcessor` (`postprocess.py` + `terminology.py`) | CPU (<15ms/talk: Stutter Dedup + Collocations + Confidence-Gated Phonetic + Pali Lexicon) | `databases/buddhism_lexicon.db` |
| **Search & Indexing** | SQLite FTS5 / Tantivy | Local Disk / Web CDN | `databases/dhamma_transcripts.db` |

### 4.1 Hardware Concurrency & Memory-Bandwidth Architecture (RTX 5070 Ti + Ryzen 7 9800X3D)

Autoregressive `large-v3` decoding at `batch_size=1` (`beam_size=5`) streams ~3.1 GB of FP16 model weights from GDDR7 VRAM on every token step, making single-talk inference **memory-bandwidth bound** (896 GB/s on the RTX 5070 Ti) rather than compute bound:
- **Why Parallel GPU `batch_size=1` Workers Are Avoided**: Running 2 or 3 concurrent `batch_size=1` workers on the same GPU does not coalesce weight reads across talks; instead, uncoordinated GEMV streams contend for GDDR7 memory bandwidth, thrash the L2 cache, and incur Windows WDDM context-switching overhead—empirically reducing aggregate real-time throughput by **14% (2 workers)** to **29% (3 workers)**. Furthermore, sharing a single `WhisperModel` across Python threads contends on the GIL and shares CTranslate2's temperature-fallback RNG state.
- **Zero-Loss CPU/GPU Overlap (`prefetch_file` + `prepare_audio`)**: To maximize single-GPU utilization without altering `batch_size=1` transcription fidelity, `cmd_transcribe` triggers a 1-slot background CPU prefetch (`ThreadPoolExecutor(max_workers=1)`) for Talk $N+1$ as soon as Talk $N$ enters its GPU ASR pass (`on_gpu_asr_start`). While the RTX 5070 Ti spends ~158s decoding Talk $N$, the Ryzen 7 9800X3D decodes Talk $N+1$ into 16 kHz mono PCM, runs Silero VAD, computes the 128-bin log-Mel spectrogram features, and builds the VBR1 seek trailer in ~7.7s—feeding the GPU continuously with zero inter-talk CPU stall and 100% bit-for-bit deterministic output parity.

```text
+-----------------------------------------------------------------------------------+
| Talk N   : [GPU Profile] -> [GPU Whisper ASR (~158s)] -> [GPU Align] -> [DB Save] |
|                                  | (on_gpu_asr_start triggers CPU prefetch)       |
|                                  v                                                |
| Talk N+1 :                  [CPU Prefetch (~7.7s): Decode + VAD + Mel + VBR1]     |
|                                                                             |     |
|                                                                             v     |
| Talk N+1 :                                               [GPU Profile] -> [GPU... |
+-----------------------------------------------------------------------------------+
```

### 4.2 Modular Non-Destructive ASR Post-Processing (`postprocess.py`)

`TranscriptPostProcessor` separates token-level acoustic artifact cleanup from domain-specific Pali terminology rules while preserving the pristine Whisper baseline (`raw_text`):

```text
+-------------------------------------------------------------------------------+
| TranscriptPostProcessor.process_segments()                                    |
+-------------------------------------------------------------------------------+
  Stage 0: Preserve `seg["raw_text"]` & Coalesce Sub-Word BPE Continuations
     |
     v
  Stage 1: `deduplicate_stutters()`
     - Removes 30s seek-boundary word duplications ("foot foot", "beginning beginning")
     - Gated by inter-word pause gap (<= 0.25s), token confidence (`prob`), and
       English reduplication whitelist (`VALID_ENGLISH_REDUPLICATIONS`)
     |
     v
  Stage 2: `apply_collocations()`
     - High-PMI spoken collocation & homophone anchors
       ("sloth and [twelver/tulpa]" -> "sloth and torpor",
        "my [ritual] thinking" -> "my wishful thinking",
        "[bear] from the waist" -> "bare from the waist")
     |
     v
  Stage 3: `apply_phonetic_lexicon()`
     - Confidence-gated (`prob < 0.72`) phonetic skeleton matching (`phonetic_skeleton`)
       against `buddhism_lexicon.db` verified by surrounding context keywords
     |
     v
  Stage 4: `TerminologyEditor.edit_segments()`
     - Context-aware canonical Pali phrase rules & word-timing synchronization
+-------------------------------------------------------------------------------+
```

- **Non-Destructive Raw ASR Baseline (`pipeline_state.db` -> `episode_raw_asr`)**:
  - When `TranscriptDatabase.save_episode()` commits a talk, `PipelineStateDatabase.save_raw_asr()` persists the pristine pre-postprocessing turns (`raw_text` and `raw_words` including per-word `prob`, `start`, `end`) as a `zlib`-compressed JSON BLOB in `databases/pipeline_state.db`.
  - Storing this baseline in `pipeline_state.db` keeps `dhamma_transcripts.db` (and the browser SQLite WASM bundle `dhamma_web.db`) 100% free of duplicate text bloat, while enabling `TranscriptDatabase.reprocess_episodes()` to re-run updated post-processing rules across the entire archive in seconds on CPU—preserving `VBR1` seek trailers and automatically updating FTS5 triggers.

---

## 5. Voiceprint Database Schema (`voiceprints.db`)

```text
+-------------------------------------------------------------------------------------------------+
|                                       Table: speaker_gallery                                    |
+---------------------+-------------------+-------------------------------------------------------+
| Column Name         | Data Type         | Description                                           |
+---------------------+-------------------+-------------------------------------------------------+
| id                  | INTEGER PRIMARY   | Unique voiceprint record ID                           |
| speaker_name        | TEXT NOT NULL     | Normalized slug (e.g. 'ajahn_brahm', 'ajahn_brahmali') |
| display_name        | TEXT NOT NULL     | Formatted name (e.g. 'Ajahn Brahm')                   |
| era                 | TEXT NOT NULL     | Era classification ('1997_2003', '2004_2014', etc.)   |
| year                | INTEGER NOT NULL  | Recording year of source audio                        |
| source_file         | TEXT NOT NULL     | Reference audio file basename                         |
| segment_start_sec   | REAL NOT NULL     | Audio offset start                                    |
| segment_end_sec     | REAL NOT NULL     | Audio offset end                                      |
| role                | TEXT NOT NULL     | 'monastic_primary', 'monastic_guest', 'lay_question'  |
| embedding           | BLOB NOT NULL     | 512-dimensional float32 binary array                  |
| created_at          | TEXT NOT NULL     | Timestamp (yyyy-mm-dd hh:mm:ss)                       |
+---------------------+-------------------+-------------------------------------------------------+
```

---

## 6. Output Transcript Formats

### 6.1 Human-Readable Markdown (`transcripts/YYYY/filename.md`)
```markdown
# 2025 April | 9 day Retreat (1/19) | Ajahn Brahm
- **Date**: 2025-07-16
- **Series**: 2025 April 9-day Retreat
- **Audio Stream**: [Stream on Podbean](https://mcdn.podbean.com/mf/web/.../audio.mp3)

---

### [00:00:15] Ajahn Brahm
Good evening, everyone. Welcome to the nine-day retreat here at Jhana Grove. For those who have not been here before, please settle in and take your time...

### [00:45:22] Questioner 1
Ajahn, when meditating on the breath, what should I do if restless thoughts continue to arise?

### [00:45:41] Ajahn Brahm
That is completely normal. The Buddha called this *uddhacca*. Do not fight the restless mind...
```

### 6.2 Structured Machine JSON (`transcripts_json/YYYY/filename.json`)
```json
{
  "episode_id": "pb26247753",
  "title": "2025 April | 9 day Retreat (1/19)| Ajahn Brahm",
  "media_url": "https://mcdn.podbean.com/mf/web/.../audio.mp3",
  "permalink": "https://deeperdhamma.podbean.com/e/...",
  "primary_teacher": "ajahn_brahm",
  "segments": [
    {
      "start": 15.2,
      "end": 2722.1,
      "speaker": "ajahn_brahm",
      "speaker_display": "Ajahn Brahm",
      "role": "monastic_primary",
      "text": "Good evening, everyone. Welcome to the nine-day retreat..."
    },
    {
      "start": 2722.5,
      "end": 2741.0,
      "speaker": "questioner_1",
      "speaker_display": "Audience Questioner",
      "role": "lay_questioner",
      "text": "Ajahn, when meditating on the breath..."
    }
  ]
}
```

---

## 7. Compliance with System Policies

1. **AI Model Storage Rule**:
   - `HF_HOME = C:\ai-models\cache\huggingface`
   - `TORCH_HOME = C:\ai-models\cache\torch`
   - All weights (Whisper models, SpeechBrain checkpoints, VAD models) must strictly reside under `C:\ai-models`.
2. **File & Folder Naming Convention**:
   - All created code and artifacts must use lowercase characters and underscores for spaces (e.g. `speaker_transcription_pipeline_design.md`, `voiceprints.db`, `transcribe_episodes.py`).
   - Dates formatted as `yyyy-mm-dd`.
3. **Diagrams**:
   - Pure ASCII text box diagrams exclusively (zero Mermaid).
