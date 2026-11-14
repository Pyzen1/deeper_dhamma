# `libmpg123` C-Stderr Spam, Silent Frame-Abort Truncation, Word-Sync Parity & Error Audit Tracking

## 1. Symptoms

During batch transcription (`python main.py transcribe --all`), C-level `libmpg123` diagnostic lines from `libsndfile` leaked directly to terminal `stderr`, corrupting progress output, while several subtle decoding, duration-capping, and word-synchronization bugs silently degraded transcripts without recording failures in `databases/pipeline_state.db`:

1. **ID3v2 / MPEG `libmpg123` C-stderr Errors (`id3.c`, `layer3.c`, `Xing`, `Illegal Audio-MPEG-Header`)**:
   ```text
   [C:\vcpkg\buildtrees\mpg123\src\-66150af195.clean\src\libmpg123\id3.c:process_extra():684] error: No extra frame text / valid description?
   [C:\vcpkg\buildtrees\mpg123\src\-66150af195.clean\src\libmpg123\id3.c:process_comment():587] error: No comment text / valid description?
   [C:\vcpkg\buildtrees\mpg123\src\-66150af195.clean\src\libmpg123\layer3.c:INT123_do_layer3():1908] error: dequantization failed!
   ```
2. **Silent Early Truncation in `libsndfile` & Metadata Duration Caps**:
   - Files containing a mid-stream corrupt MPEG frame aborted cleanly inside `sf.read()` at the damaged frame without raising an exception (`pb22141219` stopped at `145.8s` out of `3617.89s`; `pb22065166` stopped at `129.8s` out of `2629.80s`).
   - MP3s whose container/Xing/ID3 duration metadata underestimated true stream length (`pb10827777` `2526.2s` vs `3289.64s`, `pb6740888` `4666.1s` vs `6122.23s`) were truncated by passing `-t` / `end_sec=process_dur` instead of decoding to physical EOF (`end_sec=None`).
3. **1:1 Word-Timing Parity Mismatches (`test_sampled_newly_transcribed_episodes_one_to_one_word_sync_parity`)**:
   - `pb13148378` (Turn 69, bilingual talk): `faster-whisper`'s `s.text` (`98` whitespace tokens containing UTF-8 replacement characters `\ufffd` and mixed scripts) diverged from coalesced `s.words` (`56` clean aligned words).
   - `pb9433171` (Turn 22): `TerminologyEditor._sync_word_timings` copied deleted source slices when `SequenceMatcher` emitted a `delete` opcode (`k_len == 0`) adjacent to collocation collapses (`'kaya sankara'` -> `'kayasankhara'`).

---

## 2. Root Cause Architecture

```text
+---------------------------------------------------------------------------------------------------+
| BEFORE: libsndfile (libmpg123) + Container-Capped Decoding + Unsynced ASR/Opcode Edge Cases       |
+---------------------------------------------------------------------------------------------------+
| [Raw MP3] --> sf.info() + sf.read()                                                               |
|                |--> libmpg123 writes raw C-stderr on empty TXXX/COMM ID3v2 & layer3 frames        |
|                |--> sf.read() silently stops at 1st corrupt MPEG frame (pb22141219, pb22065166)   |
|                |--> pipeline.py passes end_sec=info['duration'] -> FFmpeg `-t` clips EOF          |
+---------------------------------------------------------------------------------------------------+
| [ASR / Post] --> s.text retained even when len(s.text.split()) != len(words) (pb13148378)         |
|              --> _sync_word_timings() fell back to `synced.extend(src_slice)` on delete/insert    |
+---------------------------------------------------------------------------------------------------+
| [State DB]   --> Zero audit history table; decode/DB truncation/sync issues left untracked        |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| AFTER: FFmpeg PCM Pipe (EOF) + 1:1 Text/Word Reconstruction + Audit Trail in pipeline_state.db    |
+---------------------------------------------------------------------------------------------------+
| [MP3/M4A] --> ffprobe (-select_streams a:0) + ffmpeg (-v error -map 0:a:0 -f f32le pipe:1)        |
|                |--> Thread-safe subprocess pipe: zero C-stderr leakage into tqdm progress bars    |
|                |--> Omits `-t` when end_sec=None -> decodes past corrupt packets to true PCM EOF  |
|                |--> Raises RuntimeError if decoded sample count == 0                              |
+---------------------------------------------------------------------------------------------------+
| [ASR / Post] --> Reconstructs s.text from words whenever split counts diverge                     |
|              --> Handles delete (k_len==0), replace (m==k), and expansion (k_len>m_len) opcodes   |
+---------------------------------------------------------------------------------------------------+
| [State DB]   --> `pipeline_error_history` (`id INTEGER PRIMARY KEY AUTOINCREMENT`, active->cleared) |
|              --> `audit --verify-decode --check-db --sync-db` records & clears per-operation errs |
+---------------------------------------------------------------------------------------------------+
```

---

## 3. Archive Scan Findings & Remediation Summary

Full scan across all `2,598` archive `.mp3` files (`374` `.m4a` files had `0` `ffprobe` errors):

| Finding Category | Count | Root Cause | Fix & Status |
| :--- | :---: | :--- | :--- |
| `id3.c:process_extra():684` (`TXXX`) | 46 MP3s | Empty ID3v2 `TXXX` payload frames (`2018-05-29`, `2020-03-30_01..26`, `2022-09-11`) | Bypassed `libmpg123` via FFmpeg PCM pipe; verified `ok=True` & cleared (`decode` / `id3_empty_txxx`: 46) |
| `id3.c:process_comment():587` (`COMM`) | 48 MP3s | Empty ID3v2 `COMM` frames across `2001..2026` | Bypassed `libmpg123` via FFmpeg PCM pipe; verified `ok=True` & cleared (`decode` / `id3_empty_comm`: 48) |
| `layer3.c:INT123_do_layer3()` | 8 MP3s | Layer-3 dequantization frame warning (`2011_rains_retreat_02..08`, `pb13998663`) | Verified `ffmpeg` decodes `rc=0` with `0` errors; cleared (`decode` / `libmpg123_layer3_dequant`: 8) |
| `Xing stream size off` / header drift | 1 MP3 | Corrupt Xing frame counter on `pb18882042` (`3871.77s` true PCM vs `5807.3s` header) | True decoded PCM verified (`3871.74s` vs `3871.77s`); cleared (`decode` / `libmpg123_xing_mismatch`: 1) |
| Mid-stream corrupt MPEG packet (`Header`) | 5 MP3s | Single corrupt MPEG packet; `sf.read` aborted on `pb22141219` & `pb22065166` | FFmpeg resyncs past bad packet (`rc=0`); non-truncated cleared (`libmpg123_mpeg_header_resync`: 2), truncated talks re-transcribed |
| Metadata-capped early truncation | 4 Talks | `pb22141219`, `pb22065166` (MPEG abort) + `pb10827777`, `pb6740888` (`sf.info` / `end_sec` cap) | `pipeline.py` passes `end_sec=max_duration_sec` (`None`); all 4 re-transcribed (`audit` / `duration_truncation`: 4 cleared) |
| Word-sync parity mismatches | 2 DBs | `pb13148378` (Turn 69 UTF-8/script mismatch), `pb9433171` (Turn 22 `delete` opcode) | Fixed `asr.py` & `terminology.py`; repaired & cleared (`audit` / `word_sync_mismatch`: 2 cleared, `0/1661` mismatches) |
| Unavailable CDN download (`HTTP 404`) | 1 Talk | `pb8320643` removed by host (`2016 March \| 02. Weekend Meditation Retreat`) | Retained as `'active'` in `episode_states` and `pipeline_error_history` (`1` active, `111` cleared total) |

---

## 4. Verification & Usage Commands

- **Inspect archive integrity, DB parity, and sync error ledger**:
  ```powershell
  python main.py audit --scan --check-db --sync-db
  ```
- **Inspect active errors and resolved/cleared error history**:
  ```powershell
  python main.py status -e
  ```
- **Re-transcribe specific damaged or repaired episodes without touching raw archive audio**:
  ```powershell
  python main.py transcribe --id <episode_id> --force --retry-errors
  ```
