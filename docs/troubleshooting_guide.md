# Deeper Dhamma Troubleshooting & Audio Synchronization Guide

## 1. Overview

This guide documents root causes, architectural solutions, and diagnostic procedures for audio-to-transcript synchronization across browsers (**Mozilla Firefox** and **Chromium / Chrome / Edge**) in the BSWA Deeper Dhamma web application.

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
Previously, `StreamSeekCalibrator` pre-warped all segment and word timestamps in `databases/dhamma_transcripts.db` and `words/*.bin` using Chromium's `Xing` seek curve $S_{\text{xing}}(t_{\text{phys}})$.
- However, the `Xing` table is **only** consulted at the instant a seek is initiated.
- Once `<audio>` lands at a byte offset corresponding to physical time $t_{\text{phys}}$ and begins sequential playback, the browser's MPEG-1 Layer III audio decoder outputs `1152` PCM samples per frame at `44,100 Hz`, advancing `audio.currentTime` at **exactly `1.000s` per `1.000s` of physical PCM audio**.
- Because pre-warped `.bin` timestamps compressed `5.18s` of real speech (`216.30s .. 221.48s`) into `3.78s` of `Xing` seek time (`203.14s .. 206.92s`), word highlighting drifted out of sync with the speaker's voice during continuous playback even in Chromium.
- Additionally, `ffprobe` previously used `-read_intervals %+3600`, truncating VBR calibration after 60 minutes on talks longer than 1 hour (`pb27802310` is 107 minutes).

---

## 3. Architectural Solution (100% Serverless Static Web Application)

Because Deeper Dhamma is deployed as a **100% static public website** (`dist/` hosted on GitHub Pages, Cloudflare Pages, or S3) streaming audio directly from Podbean CDN (`https://mcdn.podbean.com/...`) with **zero Python backend**, the entire VBR synchronization engine operates purely in client-side JavaScript (`word_sync.js`) powered by the binary `VBR1` trailer inside `words/<episode_id>.bin`:

```text
+-----------------------------------------------------------------------------+
| 1. Offline Build Time (`calibration.py` -> `words/<episode_id>.bin`)        |
|    - Stores true physical 44.1 kHz PCM timestamps in `dhamma_transcripts.db`|
|      (`speech_segments`) and `words/<episode_id>.bin` (`start_ms, dur_ms`). |
|    - Appends compact `VBR1` trailer (`pcm_ms`, `audio_byte_offset`, `toc`)  |
|      for VBR episodes across 100% of talk duration (~25.8 KB).              |
+-----------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
| 2. Client-Side Browser Engine (`WordSync` in `word_sync.js`)                |
|    - Loads `./words/<episode_id>.bin` and parses `VBR1` trailer in < 5ms.   |
|    - Chromium / Safari (`streamMode = 'cdn'`):                              |
|      Streams `media_url` directly from Podbean CDN via HTTP Range requests  |
|      and maps `targetPhys` -> `xingSeekTimes` (`215.80s -> 202.64s`).       |
|    - Mozilla Firefox (`streamMode = 'patched_blob'`):                       |
|      Progressively streams `media_url` from Podbean CDN via CORS `fetch()`, |
|      patches the 8-byte `Xing` header at `id3_len + 36` to                  |
|      `Info\x00\x00\x00\x03` in client-side `Uint8Array` memory, and serves  |
|      a zero-copy progressive `Blob` URL (`linearSeekTimes`, `183.40s`)      |
|      with zero dead zones and zero backend server dependencies.             |
+-----------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
| 3. Constant-Offset 1:1 Playback Clock (`WordSync` in `word_sync.js`)        |
|    - On seek to physical time `targetPhys`:                                 |
|      `streamSeek = WordSync.prepareSeek(targetPhys)`                        |
|      `seekOffset = targetPhys - streamSeek`                                 |
|    - During 60fps playback loop (`WordSync.update(audio.currentTime)`):     |
|      `physTime = audio.currentTime + seekOffset`                            |
|    - Advances at 1.000s per 1.000s of decoded PCM audio with zero drift.    |
+-----------------------------------------------------------------------------+
```

### 3.1 Binary `VBR1` Trailer Specification (`words/<episode_id>.bin`)
For CBR episodes (`6` of the `9` currently transcribed episodes), `.bin` files contain only the header and word array (`4 + 6 * N` bytes). For VBR episodes (`pb27802310`, `pb27940021`, `pb28867656`), a `VBR1` trailer is appended immediately at byte offset `4 + 6 * N`:

| Offset (rel) | Type | Field | Description |
| :--- | :--- | :--- | :--- |
| `+0` | `char[4]` | `magic` | ASCII `"VBR1"` (`0x56 0x42 0x52 0x31`) |
| `+4` | `uint32` | `total_dur_ms` | Total MP3 duration in milliseconds (`frames * 1152 / 44.1`) |
| `+8` | `uint32` | `id3_len` | Byte length of leading ID3v2 tag (`mFirstFrameOffset`) |
| `+12` | `uint32` | `bytes_len` | Audio stream byte length from `Xing` header |
| `+16` | `uint8[100]` | `toc` | Raw 100-byte `Xing` TOC array (used to compute `xingSeekTimes`) |
| `+116` | `uint32` | `sample_count` | Number of packet sample points `M` (~2s stride across full file) |
| `+120` | `uint32[2*M]` | `samples` | `M` pairs of `(uint32 pcm_ms, uint32 audio_byte_offset)` |

---

## 4. Issue: Desynchronized Word Highlighting & Missing Leading Turn Text on Decimals or Numbers

### 4.1 Symptom
When viewing episodes containing spoken times, decimal figures, or spaced numbering (most notably **`pb10641521`** *2018 December | Weekend KM Retreat Q&A | Venerable Cunda & Venerable Bodhidhaja*, **`pb28867656`**, and **`pb27802310`**):
- Turn 2/3 in the web interface appeared to begin mid-sentence with:
  > *"15 and technically you can carry on sitting here and using those two halls if you want..."*
- The initial 18 words (*"here from 6.15 onwards so we can sit here in the hall from 5.30 to 6."*) were completely absent from the UI.
- The active word highlight was ~18 words (~7 seconds) out of sync with the audible speech, creating the false impression that Voice Activity Detection (VAD) had pruned audio segments.

---

### 4.2 Root Cause Analysis

Three distinct factors contributed to this defect:

#### Cause A: Fragile Sentence Splitting RegExp in Frontend Client
In `word_sync.js` and `app.js`, paragraph formatting split text into sentences using:
```javascript
const rawSentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [trimmed];
```
- The sub-pattern `(?:\s+|$)` requires terminal punctuation to be followed immediately by whitespace or EOF.
- When encountering times or decimal numbers (such as `6.15`, `5.30`, `6 .15`, or sutta citation `46 .23`), the period `.` is immediately followed by digits (`15`, `30`, `23`).
- Because `String.prototype.match(/.../g)` silently discards all substrings that fail to match the expression, the entire initial sentence up to `...15 and technically...` was discarded from the DOM.

#### Cause B: Downstream 1-to-1 Word Mapping Offset
- `WordSync.turnWordMap[turnIdx]` loaded all 212 physical word timings for the turn from `words/<episode_id>.bin` (starting at `72.56s` for *"here"*).
- Because 18 words were dropped from the DOM, only 194 word `<span>` elements were generated.
- `WordSync` sequentially mapped timestamp 0 (`72.56s`, *"here"*) onto DOM token 0 (`"15"`), shifting all subsequent word highlights in the turn by 18 positions.

#### Cause C: Backend Word Re-Assembly in SpeakerAligner
- In `aligner.py`, `SpeakerAligner.refine_turns_by_word_boundaries` stripped and joined word tokens using `" ".join(w["word"].strip() for w in words)` even when no bilateral speaker change occurred.
- Because Whisper word tokens adhere punctuation (e.g. `' 6'` and `'.15'`), stripping and joining with spaces artificially introduced spaces before periods and hyphens (`6 .15`, `5 .30`, `hand -peeling`).

---

### 4.3 Architectural Fix

```text
+-----------------------------------------------------------------------------+
|               DETERMINISTIC ZERO-LOSS SENTENCE SCANNER                      |
+-----------------------------------------------------------------------------+
                                       |
  1. Character-by-character scan for terminal punctuation ('.', '!', '?')
  2. Lookahead look-through for closing quotes/brackets (e.g. '"Let it go."')
  3. Validate genuine boundary: followed by whitespace or EOF
     (Internal decimals '6.15', '5.30', '3.14', '6 .15' are preserved intact)
  4. Slice clean sentence [start .. j], consume trailing whitespace, reset start
  5. Capture any unpunctuated tail segment as the final sentence
                                       |
                                       v
+-----------------------------------------------------------------------------+
| Result: Zero characters dropped, all 212 word spans match timestamps 1-to-1 |
+-----------------------------------------------------------------------------+
```

1. **Frontend Zero-Loss Sentence Scanner**:
   Replaced regex matching with a deterministic scanner `splitSentences(text)` across `word_sync.js` and `app.js`. It preserves internal decimals, spaced dots, abbreviations, and quotation marks without dropping text.
2. **Pristine Text Preservation in Aligner**:
   Updated `SpeakerAligner.refine_turns_by_word_boundaries` to preserve Whisper's original `seg["text"]` intact when no speaker change occurs, and added `_reconstruct_text_from_words` to maintain punctuation adhesion for split turns.
3. **Automated Regression Verification**:
   Added `test_pb10641521_turn_sentence_splitting_and_word_highlight_alignment` to `tests/test_cross_browser_word_sync.py`, verifying in headless Chrome that Turn 2 renders all 212 words and synchronizes word highlights with 100% precision.

---

## 5. Diagnostic & Verification Procedures

### 5.1 Running the Cross-Browser Synchronization Test Suite
Run `pytest` to verify byte parity, `VBR1` trailer integrity, client-side `Xing -> Info` progressive `Blob` neutralization, and real headless Firefox + Chrome playback synchronization:

```powershell
pytest tests/
```

Specifically:
- `tests/test_cross_browser_word_sync.py`:
  - Verifies that all VBR episodes in `databases/dhamma_transcripts.db` and `words/*.bin` store unwarped physical PCM timestamps and valid full-duration `VBR1` trailers.
  - Launches headless **Mozilla Firefox** and headless **Google Chrome** against a pure static HTTP server (serving the raw unpatched VBR MP3 with `Access-Control-Allow-Origin: *` just like Podbean CDN) to verify that seeking to `"Everyone,"` (`216.30s`) and `"one"` (`231.34s`) via client-side `WordSync` lands at the exact physical audio position and highlights the exact spoken words in real time.
- `tests/test_audio_cdn_sync.py`:
  - Verifies 1:1 bit-for-bit parity between local `archive/` MP3 files and Podbean CDN streams.

### 5.2 Rebuilding Static Web Assets & Resetting Browser Cache
Whenever `dhamma_transcripts.db`, `words/*.bin`, `word_sync.js`, or `app.js` are updated, recompile the static `dist/` bundle:

```powershell
python main.py web --build
```

Each build stamps a fresh Unix timestamp into `PRAGMA user_version` in `dist/dhamma_web.db`. Additionally, `python main.py web --run` automatically checks `_is_dist_stale(dist_path)` and rebuilds `dist/` whenever `word_sync.js`, `app.js`, `index.html`, or `dhamma_transcripts.db` is newer than `dist/index.html`, and serves static preview assets with `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` headers.

If a browser tab has cached old OPFS database state:
1. Perform a hard reload (`Ctrl+Shift+R` in Firefox / Chrome), or
2. Run `window.resetDeeperDhammaCache()` in the browser developer console to purge the Origin Private File System (OPFS) SQLite cache and reload.


