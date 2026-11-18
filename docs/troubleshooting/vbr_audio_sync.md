# Variable Bitrate (VBR) MP3 Audio Synchronization & Xing Header Neutralization

## 1. Overview

This guide documents root causes and architectural solutions for audio-to-transcript synchronization across browsers (**Mozilla Firefox** and **Chromium / Chrome / Edge**) in the BSWA Deeper Dhamma web application.

---

## 2. Issue: Highlighted Word Does Not Match Heard Audio on VBR MP3 Talks

### 2.1 Symptom
When playing Variable Bit Rate (VBR) MP3 episodes with low-bitrate lead-in silence—most notably **`pb27802310`** (*2026 March | 9 Day Sutta Retreat (7/26) | Ajahn Brahmali & Ayya Karunika*), **`pb27940021`**, and **`pb28867656`**—in **Mozilla Firefox**:
- Clicking the Turn 0 timestamp button or clicking the first word `"Everyone,"` highlighted `"Everyone,"` in orange, while the audio heard from the speakers was **`"one of the most significant things about"`** (~15 seconds later in the talk).
- Even in **Chromium**, continuous playback within a single long speech turn gradually drifted out of sync with the speaker's voice by up to 15–21 seconds.

---

### 2.2 Root Cause Analysis

Two distinct mechanisms caused this mismatch:

#### Cause A: Gecko (`MP3TrackDemuxer`) vs. Chromium (`FFmpeg mp3dec`) `Xing` TOC Seek Divergence
VBR MP3 files contain a `Xing` header in their first MPEG audio frame (`byte 176,164` after the `176,128`-byte ID3v2 tag in `pb27802310`) with `flags = 0x07` (`Frames = 0x01`, `Bytes = 0x02`, `TOC = 0x04`). The `Xing` Table of Contents (`TOC`) is a coarse 100-byte array mapping each `1%` of duration (`~64.39s` per bucket in `pb27802310`) to a quantized byte fraction `TOC[k] / 256`.

Chromium and Firefox interpret this 100-byte `Xing` TOC differently when `audio.currentTime = S` is assigned:

```text
+-----------------------------------------------------------------------------+
|                     VBR MP3 WITH RAW "Xing" TOC (flags=7)                   |
+-----------------------------------------------------------------------------+
                   |                                       |
                   v                                       v
+-------------------------------------+ +-------------------------------------+
|     Chromium (FFmpeg mp3dec.c)      | |  Mozilla Firefox (MP3Demuxer.cpp)   |
+-------------------------------------+ +-------------------------------------+
| 1. Linearly interpolates between    | | 1. FastSeek(S) looks up un-interp   |
|    TOC[k] and TOC[k+1].             | |    step bucket TOC[floor(100*S/D)]: |
| 2. Adds id3_len to byte offset.     | |    offset_k = NumBytes * TOC[k]/256 |
| 3. For "Everyone," (t_phys=216.30s, | | 2. Estimates frame index at offset_k|
|    byte 2,711,858), Chromium maps   | |    using average bitrate:           |
|    seek S = 203.14s -> byte 2.71M.  | |    t_avg = (offset_k - id3)/AvgLen  |
|                                     | | 3. ScanUntil(S) scans forward       |
|                                     | |    (S - t_avg) seconds of frames!   |
+-------------------------------------+ +-------------------------------------+
                                                           |
                                                           v
                                        +-------------------------------------+
                                        | Bucket k=3 (193.17s <= S < 257.56s):|
                                        | - TOC[3] = 7 -> offset_3 = 2,424,648|
                                        | - True physical time  = 192.00s     |
                                        | - Average-bitrate time = 163.27s    |
                                        | - Bucket skew delta_3  = +28.73s    |
                                        |                                     |
                                        | Seeking to S = 202.64s lands at:    |
                                        | 202.64 + 28.73 = 231.37s physical!  |
                                        | ("one of the most significant...")  |
                                        +-------------------------------------+
```

Furthermore, because Firefox's `VBRHeader::Offset()` is a non-interpolated step function across buckets `k = 0..99`, crossing a bucket boundary where VBR bitrate was below average creates an **unreachable dead zone** in Firefox:
- In `pb27802310`, bucket `k=2` (`128.78s <= S < 193.17s`, `TOC[2] = 4`, `delta_2 = +14.74s`) covers physical audio `[143.52s .. 207.89s]`.
- Bucket `k=3` (`193.17s <= S < 257.56s`, `TOC[3] = 7`, `delta_3 = +28.75s`) jumps immediately to physical audio `[221.90s .. 286.29s]`.
- The 14-second physical window **`[207.89s .. 221.90s]`**—which contains Turn 0 (`"Everyone, so just a little bit of instructions again"`, `216.30s`)—cannot be reached by *any* `audio.currentTime` seek value in Firefox when the `Xing` TOC flag (`0x04`) is active.
- If a raw `'cdn'` fallback bucket search evaluates `Math.abs(landedPhys - clampedPhys)` without penalizing forward jumps past the target word (`215.80s`), Bucket `k=3` (`221.91s` physical, error `6.11s`) beats the end of Bucket `k=2` (`207.89s` physical, error `7.91s`), jumping forward `6.11s` to **`3:42` (`221.91s`, highlighting `"on"` in `"on how to proceed"`)** and skipping the first 9 words (`"Everyone, so just a little bit of instructions again"`). `WordSync.prepareSeek` therefore also guards raw `'cdn'` fallback mode with a `20x` penalty on `overJump > 0.35s` so it never skips forward into mid-sentence.

#### Cause B: Pre-Warping Word Timestamps vs. the 1:1 44.1 kHz Playback Clock
Previously, `StreamSeekCalibrator` pre-warped segment and word timestamps using Chromium's `Xing` seek curve $S_{\text{xing}}(t_{\text{phys}})$.
- However, the `Xing` table is **only** consulted at the instant a seek is initiated.
- Once `<audio>` lands at a byte offset corresponding to physical time $t_{\text{phys}}$ and begins sequential playback, the browser's MPEG-1 Layer III audio decoder outputs `1152` PCM samples per frame at `44,100 Hz`, advancing `audio.currentTime` at **exactly `1.000s` per `1.000s` of physical PCM audio**.
- Because pre-warped timestamps compressed `5.18s` of real speech (`216.30s .. 221.48s`) into `3.78s` of `Xing` seek time (`203.14s .. 206.92s`), word highlighting drifted out of sync with the speaker's voice during continuous playback even in Chromium.
- Additionally, `ffprobe` previously used `-read_intervals %+3600`, truncating VBR calibration after 60 minutes on talks longer than 1 hour (`pb27802310` is 107 minutes).

#### Cause C: Chromium `Xing` Cold/Warm Seek Divergence (`pb28769672`) & Click-Seek Race Contention
Even on Chromium (`FFmpegDemuxer`), streaming raw `Xing` VBR MP3s via HTTP Range requests (`streamMode = 'cdn'`) proved unreliable on VBR talks like `pb28769672` (*2026 Rains Retreat (7/12) | Getting Out of a Rut | Ajahn Brahmali*):
- Cold seeks diverged from interpolated `xingSeekTimes` by `-3.4s` to `+6.0s` (for example `-3.37s` / 12 words ahead at `tw-84`, `+3.88s` / 10 words behind at `tw-2500`, and `-4.61s` / 15 words ahead at `tw-3000`) due to coarse 1% `TOC` quantization and `FFmpeg` block alignment.
- Once byte ranges around a position were cached locally in the element, subsequent warm seeks resolved through `FFmpeg`'s internal packet `AVIndex` (`~0s` error), while `WordSync.seekOffset` still applied the cold `Xing` delta (`+4.6s` / `-4.5s`).
- In addition, rapid word/companion clicks could let an earlier async `waitForPatchedBlobUrl()` promise overwrite a newer click, `jumpToCompanionTerm()` called `WordSync.clearHighlights()` after `playAudioSegment()` and competed with 60fps `updateTeleprompter()` scrolling, and `updateActiveCompanionTerm()` re-evaluated companion highlights against the `-0.50s` seek lead-in window, flickering to the preceding term.

---

## 3. Architectural Solution (100% Serverless Static Web Application)

Because Deeper Dhamma is deployed as a **100% static public website** (`dist/` hosted on GitHub Pages, Cloudflare Pages, or S3) streaming audio directly from Podbean CDN (`https://mcdn.podbean.com/...`) with **zero Python backend**, the entire VBR synchronization engine operates purely in client-side JavaScript ([word_sync.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/word_sync.js) and [app.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/app.js)) powered by the binary `VBR1` trailer stored in the `episode_words` SQLite table in the sharded `words_1..4.db.gz` SQLite WASM databases (originally consolidated in `dhamma_web.db`):

```text
+-----------------------------------------------------------------------------+
| 1. Offline Build Time (`calibration.py` -> `dhamma_transcripts.db`)         |
|    - Stores true physical 44.1 kHz PCM timestamps in `dhamma_transcripts.db`|
|      (`speech_segments` and `episode_words` binary blob with `VBR1` trailer).|
|    - Appends compact `VBR1` trailer (`pcm_ms`, `audio_byte_offset`, `toc`)  |
|      for all VBR episodes across 100% of talk duration (397 VBR1 talks).    |
+-----------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
| 2. Client-Side 3-Tier VBR Engine (`WordSync` in `word_sync.js` & `app.js`)  |
|    - Queries `episode_words` from SQLite WASM and parses `VBR1` in < 5ms.   |
|    - Tier 1 (`streamMode = 'mse_vbr'`, Chromium/Edge): `mseSeekAndLoad()`   |
|      computes O(1) MPEG frame-aligned HTTP `Range` bounds (`id3Len +        |
|      byteOffsets[i0]`) for a ~40s (`CHUNK_STRIDE = 20`) window, sets        |
|      `SourceBuffer.timestampOffset = pcmTimes[i0]` (`seekOffset = 0.0`),    |
|      and seamlessly prefetches contiguous chunks ahead of playback.         |
|    - Tier 2 (`streamMode = 'patched_blob'`, Firefox/Safari or non-206):     |
|      Progressively fetches `media_url` via CORS `fetch()`, patches the      |
|      8-byte `Xing` header to `Info\x00\x00\x00\x03` in `Uint8Array` memory, |
|      and serves a progressive `Blob` URL (`linearSeekTimes`, ±0.25s).       |
|    - Tier 3 (`streamMode = 'cdn'`): Direct stream fallback on CORS block.  |
+-----------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
| 3. Unified Seek State Machine & Single-Owner Scroll (`word_sync.js`)        |
|    - `WordSync.beginSeek()` / `isCurrentSeek()` / `isSeekLocked()` track    |
|      monotonic `_seekSeq` and `_syncPhase` (`idle|buffering|seeking|playing`|
|      ), aborting stale Range fetches across `playAudioSegment` & `safeSeek`.|
|    - `WordSync.setActiveWordElement()` and `wordIdx`-locked companion       |
|      tracking (`term.wordIdx <= activeWordIdx`) prevent lead-in flip-back;  |
|      pre-target hold is tightened to `0.90s` (`10s` only on Firefox CDN).   |
|    - `onClockTick` syncs `#time-current` on every floored-second crossing   |
|      inside `rAF` (plus `'pause'`/`'ended'`) to prevent clock vs word skew. |
|    - `WordSync.scrollToElement()` + `updateTeleprompter()` share one `rAF`  |
|      reading-zone animator (`getReadingZoneBounds()`), ending scroll fights.|
|    - `physTime = audio.currentTime + seekOffset` (`0.0` in MSE mode) keeps  |
|      playback locked 1:1 to decoded 44.1 kHz PCM audio.                     |
+-----------------------------------------------------------------------------+
```

### 3.1 Binary `VBR1` Trailer Specification (`episode_words.words_blob`)
For CBR episodes, the binary blob contains only the header and word array (`4 + 6 * N` bytes). For VBR episodes (`397` talks including `pb27802310`, `pb27940021`, `pb28867656`, `pb28769672`), a `VBR1` trailer is appended immediately at byte offset `4 + 6 * N`:

| Offset (rel) | Type | Field | Description |
| :--- | :--- | :--- | :--- |
| `+0` | `char[4]` | `magic` | ASCII `"VBR1"` (`0x56 0x42 0x52 0x31`) |
| `+4` | `uint32` | `total_dur_ms` | Total MP3 duration in milliseconds (`frames * 1152 / 44.1`) |
| `+8` | `uint32` | `id3_len` | Byte length of leading ID3v2 tag (`mFirstFrameOffset`) |
| `+12` | `uint32` | `bytes_len` | Audio stream byte length from `Xing` header |
| `+16` | `uint8[100]` | `toc` | Raw 100-byte `Xing` TOC array (used to compute `xingSeekTimes`) |
| `+116` | `uint32` | `sample_count` | Number of packet sample points `M` (~2s stride across full file) |
| `+120` | `uint32[2*M]` | `samples` | `M` pairs of `(uint32 pcm_ms, uint32 audio_byte_offset)` |

