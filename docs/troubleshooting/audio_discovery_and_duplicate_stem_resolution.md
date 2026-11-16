# Multi-Format Audio Discovery, Single-Window Profiler Clustering & Duplicate-Stem Resolution

## 1. Symptoms

When running `python main.py transcribe --all` after initial MP3 transcription runs, several classes of available archive talks remained untranscribed or risked duplicate/failed processing:

1. **Non-MP3 Archive Talks Completely Skipped (`374` `.m4a` files)**
   - Although `deeper_dhamma/audio.py`, `deeper_dhamma/downloader.py`, `deeper_dhamma/audit.py`, `deeper_dhamma/status.py`, `deeper_dhamma/storage.py` (`resolve_audio_path`), and `deeper_dhamma/calibration.py` already supported `.m4a`, `cmd_transcribe` (`--year`, `--series`, `--all`) and `cmd_test` in `deeper_dhamma/cli.py`, plus `find_matching_audio()` in `deeper_dhamma/benchmark.py`, hardcoded `*.mp3` globs.
   - Temporary `.temp.*` and `.part` files were not centrally excluded during transcription discovery, while `deeper_dhamma/voiceprints.py` duplicated `rglob("*.mp3") + rglob("*.m4a")` manually.

2. **Single-Window Sparse-Speech Crash (`pb16727929`) & Retry Lockout**
   - Guided meditation talk `pb16727929` (`2020-03-30_2020_march_sutta_meditation_retreat_bsv_15_26_ajahn_bramali.mp3`) yielded only one strided 3-second profiler window clearing the `mean_abs >= 0.005` speech threshold, producing `emb_matrix` shape `(1, 192)`.
   - `SpeakerProfiler.profile_audio()` passed that single-sample array directly to scikit-learn `AgglomerativeClustering`, raising:
     `Found array with 1 sample(s) (shape=(1, 192)) while a minimum of 2 is required by AgglomerativeClustering.`
   - The recorded error (`last_error_op = 'transcribe'`) continued blocking future `transcribe --all` passes (`_transcribe_auto_resolver` did not clear fixed profiler crashes) and explicit `--id` / `--force` runs did not pass `retry_errors=True`.

3. **Duplicate Catalog Stems & Non-Deterministic Episode Resolution**
   - Multiple `catalog.json` entries can share the same normalized `(title, upload_date)` filename stem (e.g., `2016-04-10_sn12_12_moliyaphagguna_sutta_ajahn_ekaggata_10_april_2016.m4a` maps to both `pb13559311` and `pb9724530`, alongside duplicate-stem `.mp3` talks).
   - `PipelineStateDatabase.resolve_episode_uid()` previously executed an unordered `LIMIT 1` query, `TranscriptDatabase.has_episode()` checked only one candidate UID, `TranscriptionPipeline.catalog_map` allowed later empty-URL duplicates to overwrite playable entries, and `process_file()` consulted `catalog_map.get(stem)` before checking the canonical UID indexed in `episode_states`.

---

## 2. Root Cause Architecture & Fix Flow

```text
+---------------------------------------------------------------------------------------------+
| BEFORE: Fragmented Globs, Unordered Lookup & Unprotected Clustering                         |
+---------------------------------------------------------------------------------------------+
| cli.py / benchmark.py   --> *.mp3 rglob only               --> 374 .m4a talks invisible     |
| profiler.py             --> AgglomerativeClustering(1x192) --> ValueError on pb16727929     |
| storage.py (LIMIT 1)    --> arbitrary sibling UID returned --> false pending / re-runs      |
| storage.py has_episode  --> filepath LIKE '%stem%' risk    --> substring stem collisions    |
| pipeline.py catalog_map --> unordered stem overwrite       --> empty-URL clobbers playable  |
+---------------------------------------------------------------------------------------------+
                                              |
                                              v
+---------------------------------------------------------------------------------------------+
| AFTER: Canonical Discovery, Safe Single-Window Path & Deterministic Candidate Resolution    |
+---------------------------------------------------------------------------------------------+
| config.py + audio.py    --> SUPPORTED_AUDIO_EXTENSIONS + discover_audio_files()             |
|                             (MP3, M4A, AAC, MP4, M4B, OPUS, WAV; skips .temp.*/.part/.tmp)  |
| profiler.py + aligner.py--> len(embeddings)==1 -> label [0]; slice frame guard >= 400 (>=25ms)|
| pipeline.py pre-flight  --> auto-clears stale AgglomerativeClustering error when file exists |
| cli.py --id / --force   --> sets effective retry_errors=True                                |
| storage.py resolution   --> exact UID > exact stem > is_transcribed DESC > updated_at DESC  |
| storage.py has_episode  --> checks all exact UID/stem candidates (no LIKE substring match)  |
+---------------------------------------------------------------------------------------------+
```

---

## 3. Code & Test Fixes Applied

| Component | Change Summary | Location |
| :--- | :--- | :--- |
| **Canonical Extension Set** | Defined `SUPPORTED_AUDIO_EXTENSIONS` (`{.mp3, .m4a, .aac, .mp4, .m4b, .opus, .wav}`). | `deeper_dhamma/config.py` |
| **Shared Audio Discovery** | Added `discover_audio_files()` excluding `.temp.*`, `.part`, and `.tmp` files in deterministic sorted order. | `deeper_dhamma/audio.py` |
| **CLI, Benchmark & Voiceprints** | Switched `cmd_transcribe` (`--year`, `--series`, `--all`), `cmd_test`, `find_matching_audio()`, and `bootstrap_voiceprints()` to `discover_audio_files()`. Propagated `force_run` into `retry_errors`. | `deeper_dhamma/cli.py`, `deeper_dhamma/benchmark.py`, `deeper_dhamma/voiceprints.py` |
| **Sparse-Speech & Slice Guards** | Handled `len(embeddings) == 1` directly as cluster `0` in `SpeakerProfiler.profile_audio()`. Enforced `>= 400` frame (`25ms` @ `16 kHz`) floor in `SpeakerAligner` ECAPA slices. | `deeper_dhamma/profiler.py`, `deeper_dhamma/aligner.py` |
| **Catalog & Auto-Recovery** | Protected playable `catalog_map[stem]` entries from empty-URL duplicates, resolved `episode_states` UID before `catalog_map[stem]`, and auto-cleared fixed `AgglomerativeClustering` errors in `_transcribe_auto_resolver`. | `deeper_dhamma/pipeline.py` |
| **Deterministic UID Lookup** | Ordered `resolve_episode_uid`, `_resolve_candidate_uids`, `resolve_candidate_uids`, `get_error`, and `get_episode`; updated `has_episode()` to check all exact UID/stem candidates with `include_filepath_like=False`. | `deeper_dhamma/storage.py` |
| **Regression Tests** | Added tests covering `.m4a` discovery & temp/part filtering, single-window profiling, deterministic duplicate-stem lookup & substring non-matching, benchmark `.m4a` matching, CLI `force`/`--id` retry propagation, and pipeline error auto-recovery. | `tests/test_audio_utils.py`, `tests/test_profiler.py`, `tests/test_storage.py`, `tests/test_cli.py`, `tests/test_benchmark.py`, `tests/test_pipeline_integrity.py` |

---

## 4. Verification Results

- **Read-only Live Archive & Database Check**:
  - `discover_audio_files(ARCHIVE_DIR)` enumerated `2,972` audio files (`2,598` `.mp3`, `374` `.m4a`).
  - `TranscriptDatabase().has_episode(f.stem)` reduced the pending transcription queue to **`375` files** (`374` `.m4a` + `1` `.mp3`: `pb16727929`), with colliding `.mp3` stems skipped and duplicate `.m4a` stem `2016-04-10_sn12_12_moliyaphagguna_sutta_ajahn_ekaggata_10_april_2016` deterministically resolved to `pb9724530`.
- **Targeted Tests** (`python -m pytest tests/test_audio_utils.py tests/test_profiler.py tests/test_storage.py tests/test_cli.py tests/test_benchmark.py tests/test_pipeline_integrity.py tests/test_transcription_progress.py -p no:cov -v`):
  - **67 passed**.
- **Usage**:
  ```powershell
  python main.py transcribe --all
  python main.py transcribe --id pb16727929
  ```
