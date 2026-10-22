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
| **Speech-to-Text (ASR)** | `faster-whisper` (`Systran/faster-whisper-large-v3`) | NVIDIA RTX 5070 Ti (16GB VRAM, float16) | `C:\ai-models\cache\huggingface` |
| **Voice Activity & Segmentation** | `silero-vad` + energy-based chunker | CUDA / CPU | `C:\ai-models\cache\torch` |
| **Speaker Embeddings** | `speechbrain/spkrec-ecapa-voxceleb` (ECAPA-TDNN) | CUDA (float32, 512-d) | `C:\ai-models\cache\huggingface` |
| **Voiceprint Database** | SQLite (`voiceprints.db`) | Local Disk (~5 MB) | `databases/voiceprints.db` |
| **Search & Indexing** | SQLite FTS5 / Tantivy | Local Disk / Web CDN | `index/search_index.db` |

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
