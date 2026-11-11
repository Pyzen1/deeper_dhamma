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
Previously, `StreamSeekCalibrator` previously pre-warped segment and word timestamps using Chromium's `Xing` seek curve $S_{\text{xing}}(t_{\text{phys}})$.
- However, the `Xing` table is **only** consulted at the instant a seek is initiated.
- Once `<audio>` lands at a byte offset corresponding to physical time $t_{\text{phys}}$ and begins sequential playback, the browser's MPEG-1 Layer III audio decoder outputs `1152` PCM samples per frame at `44,100 Hz`, advancing `audio.currentTime` at **exactly `1.000s` per `1.000s` of physical PCM audio**.
- Because pre-warped timestamps compressed `5.18s` of real speech (`216.30s .. 221.48s`) into `3.78s` of `Xing` seek time (`203.14s .. 206.92s`), word highlighting drifted out of sync with the speaker's voice during continuous playback even in Chromium.
- Additionally, `ffprobe` previously used `-read_intervals %+3600`, truncating VBR calibration after 60 minutes on talks longer than 1 hour (`pb27802310` is 107 minutes).

---

## 3. Architectural Solution (100% Serverless Static Web Application)

Because Deeper Dhamma is deployed as a **100% static public website** (`dist/` hosted on GitHub Pages, Cloudflare Pages, or S3) streaming audio directly from Podbean CDN (`https://mcdn.podbean.com/...`) with **zero Python backend**, the entire VBR synchronization engine operates purely in client-side JavaScript (`word_sync.js`) powered by the binary `VBR1` trailer stored in the `episode_words` SQLite table in `dhamma_web.db`:

```text
+-----------------------------------------------------------------------------+
| 1. Offline Build Time (`calibration.py` -> `dhamma_transcripts.db`)         |
|    - Stores true physical 44.1 kHz PCM timestamps in `dhamma_transcripts.db`|
|      (`speech_segments` and `episode_words` binary blob with `VBR1` trailer).|
|    - Appends compact `VBR1` trailer (`pcm_ms`, `audio_byte_offset`, `toc`)  |
|      for VBR episodes across 100% of talk duration (~25.8 KB).              |
+-----------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
| 2. Client-Side Browser Engine (`WordSync` in `word_sync.js`)                |
|    - Queries `episode_words` from SQLite WASM and parses `VBR1` in < 5ms.   |
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

### 3.1 Binary `VBR1` Trailer Specification (`episode_words.words_blob`)
For CBR episodes (`6` of the `9` currently transcribed episodes), the binary blob contains only the header and word array (`4 + 6 * N` bytes). For VBR episodes (`pb27802310`, `pb27940021`, `pb28867656`), a `VBR1` trailer is appended immediately at byte offset `4 + 6 * N`:

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
- `WordSync.turnWordMap[turnIdx]` loaded all 212 physical word timings for the turn from `episode_words` (starting at `72.56s` for *"here"*).
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

## 5. Issue: High Latency (> 1s) Loading Transcripts in Offline / Unserved Environments

### 5.1 Symptom
When accessing the static distribution (`dist/index.html`) offline, unserved via `file:///`, or on static hosts with no active backend server:
- Clicking any talk card or directly navigating to a talk URL (e.g. `#talk/pb27802310`) took more than 1 second to display the transcript.
- The UI showed a blocking `"Loading transcript turns..."` spinner during the delay.
- Memory allocations and CPU spikes occurred on the main thread during talk drawer transitions.

---

### 5.2 Root Cause Analysis

Profiling in headless Mozilla Firefox and Google Chrome revealed five compounding bottlenecks:

```text
+-----------------------------------------------------------------------------------------+
|                                Previous Latency Bottlenecks                             |
+-----------------------------------------------------------------------------------------+
| 1. Full DB Probe Download  --> Discarded 4.75MB buffer & re-read 4.75MB from IndexedDB |
| 2. initVocabCache()        --> 5,000-row synchronous scan blocked worker initialization |
| 3. openTranscriptDrawer()  --> Waited for full 2,447 Pali terms + binary words blob     |
| 4. formatTurnParagraphs()  --> 30,000+ Unicode normalize('NFD') calls on ASCII words    |
| 5. renderDrawerTurns()     --> 12,000 querySelectorAll scans & individual event bindings|
+-----------------------------------------------------------------------------------------+
```

1. **Dual Database Read & Lack of Offline Fallback in `db_worker.js`**:
   - `fetchRemoteVersion(dbUrl)` probes `./dhamma_web.db` with `Range: bytes=0-99`.
   - On `file:///` and static hosts without HTTP 206 Partial Content support, the browser/host returns `HTTP 200` with the **full 4.75 MB buffer** (`probeBuffer`).
   - If `cached.version === remoteVersion`, the worker previously discarded `probeBuffer` and executed an asynchronous 4.75 MB read from IndexedDB, reading the database twice into memory.
   - If completely offline without a server, `fetchRemoteVersion` threw or delayed on network resolution without falling back to the existing IndexedDB cache.
2. **Synchronous 5,000-Row Vocabulary Scan at Startup**:
   - `initDatabase()` unconditionally called `initVocabCache()` (`SELECT word, count FROM search_vocab ORDER BY count DESC;`), mapping 5,000 rows into JS objects and a `Set` before resolving the ready event, blocking initial transcript requests.
3. **Waterfall Blocking in `openTranscriptDrawer`**:
   - `openTranscriptDrawer()` sequentially awaited `ensurePaliTermsLoaded()` (fetching all 2,447 terms across Web Worker `postMessage`), awaited `prepareEpisode()` (fetching binary word blob from SQLite WASM), and then generated 230+ companion cards before displaying the transcript.
4. **Heavy Unicode `normalize('NFD')` in `word_sync.js`**:
   - For every word in a talk (up to 12,000 words in talks like `pb27802310`), `matchPhraseAt` evaluated 4-word slices and invoked `foldDiacritics`. Calling `str.normalize('NFD')` 30,000+ times over standard English ASCII words choked the main JS thread.
5. **12,000 Listener Attachments per Render in `renderDrawerTurns`**:
   - `renderDrawerTurns` queried `.transcript-word` and attached individual click listeners to up to 12,000 span elements via `querySelectorAll`, creating massive DOM layout and listener overhead.

---

### 5.3 Architectural Fix & Optimizations

```text
+-----------------------------------------------------------------------------------------+
|                                    Optimized Pipeline                                   |
+-----------------------------------------------------------------------------------------+
| 1. Single Buffer Reuse     --> probeBuffer used directly; offline falls back to cache   |
| 2. Lazy Vocab Caching      --> initVocabCache deferred to background/idle search time   |
| 3. Progressive Rendering   --> Talk speech turns render immediately (<20ms)             |
| 4. ASCII Fast-Path & Guard --> foldDiacritics skips NFD; paliFirstWordsSet O(1) filter   |
| 5. Event Delegation        --> Single click listener on els.drawerTurns & lexiconStack  |
+-----------------------------------------------------------------------------------------+
```

1. **Buffer Reuse & Resilient Offline Fallback (`db_worker.js`)**:
   - Reuses `probeBuffer` directly if downloaded during the Range probe (`probeBuffer.byteLength > 100000`), eliminating the redundant IndexedDB read.
   - If network probes fail or timeout in offline mode, it falls back immediately to the existing IndexedDB cache snapshot.
   - `ensureVocabCache()` is deferred to background idle time (`setTimeout(ensureVocabCache, 50)`) or on-demand fuzzy search, unblocking immediate database readiness.
2. **ASCII Fast-Path & Prefix Guard (`word_sync.js`)**:
   - `foldDiacritics` checks `!/[^\x00-\x7F]/.test(str)`, immediately returning `str.toLowerCase()` for ASCII words without invoking `normalize('NFD')`.
   - Populated `paliFirstWordsSet` during `setPaliTerms`. In `matchPhraseAt`, words not found in the initial set exit in a single O(1) check, bypassing multi-word candidate slicing for ~98% of transcript words.
3. **Progressive Display & Event Delegation (`app.js`)**:
   - In `openTranscriptDrawer`, talk speech turns render immediately upon receiving `ep` from SQLite WASM (<20ms).
   - `ensurePaliTermsLoaded()` and `prepareEpisode()` run concurrently in the background and progressively enrich the transcript with word timestamps and companion cards without blocking initial display.
   - Replaced all individual word and card listeners with single delegated click listeners on `els.drawerTurns` and `els.lexiconStack`.

---

## 6. Architecture: Sticky Toolbar, Triple Word Sync (`Off | On | Track`), & Continuous Teleprompter Auto-Scroll

### 6.1 Evolution of Auto-Scroll Approaches
During synchronized audio playback, long Dhamma talks require the reader to navigate through thousands of words across multiple turns:
1. **Initial Requirement & Metric Removal**:
   - The `#word-sync-metrics-badge` (showing loaded bytes and word counts) created visual clutter without providing user utility and was removed.
   - The top drawer play button (`#drawer-play-full-btn`) was redundant with the bottom global player bar controls and was removed.
   - The word sync control was placed in a dedicated sticky toolbar (`#transcript-sticky-toolbar`) so users can switch synchronization modes from anywhere in the transcript without scrolling back up to the top.
2. **First Scroll Attempt (Discrete Off-Screen Jump)**:
   - When the active word scrolled off screen, the viewport jumped the active element to the top of the viewport.
   - *Issue*: A sudden ~800px vertical leap was disorienting and broke reading concentration.
3. **Second Scroll Attempt (Discrete Word-by-Word Center Snap)**:
   - Centered each highlighted word with smooth scrolling whenever `activeWordIdx` changed.
   - *Issue*: At line breaks, as the human eye scanned from right to left toward the beginning of the next line, the text jumped upward abruptly, producing a jerky and distracting effect.
4. **Third Working Approach (Continuous Line-Interpolated Teleprompter Scroll)**:
   - Distributes the vertical line transition smoothly and continuously across the spoken duration of that line.
   - The active reading viewport ($Y_{\text{center}}$) sits comfortably at 46% of the available space between the sticky toolbar and the bottom audio player.
   - Calculates the continuous fractional progress $\rho(t) \in [0, 1]$ of the current line:
     $$\rho(t) = \frac{t - t_{\text{line\_start}}}{\Delta t_{\text{line}}}$$
   - The target document position glides upward continuously at a steady sub-pixel rate ($\approx 0.13\text{ px/frame}$ at 60fps), eliminating boundary jumps entirely.

```text
+-----------------------------------------------------------------------------------------+
|                  CONTINUOUS LINE-INTERPOLATED TELEPROMPTER ENGINE                       |
+-----------------------------------------------------------------------------------------+
                                       |
    [ Audio Decoder 44.1 kHz PCM ] --->| audio.currentTime (Physical Timestamp)
                                       v
    +---------------------------------------------------------------------------------+
    | 1. getLineInfo(targetIdx, wordEl)                                               |
    |    - Scans backward/forward for DOM word spans sharing visual DocY (+-8px)       |
    |    - Caches line bounds: currentLineCenterY, nextLineCenterY, lineStartTime     |
    +---------------------------------------------------------------------------------+
                                       |
                                       v
    +---------------------------------------------------------------------------------+
    | 2. Fractional Time-Interpolated Target Scroll Calculation                       |
    |    progress = clamp((currentTime - lineStartTime) / lineDuration, 0, 1)         |
    |    idealDocY = currentLineCenterY + progress * (nextLineCenterY - currentLineCenterY)
    |    targetScrollY = max(0, idealDocY - activeCenterLine)                         |
    +---------------------------------------------------------------------------------+
                                       |
                                       v
    +---------------------------------------------------------------------------------+
    | 3. Sub-Pixel Continuous Damping Loop (60fps rAF)                                 |
    |    diff = targetScrollY - currentScrollY                                         |
    |    factor = abs(diff) > 150 ? 0.15 : 0.08                                        |
    |    window.scrollTo(0, currentScrollY + diff * factor)                            |
    +---------------------------------------------------------------------------------+
```

### 6.2 Word Sync Mode Semantics (`WordSync.mode`)
The synchronization state is managed as a lightweight, in-memory global state variable (`WordSync.mode`) with three distinct modes:
- **`'off'`**: Synchronized highlighting and auto-scrolling are fully deactivated. Transcript text acts as a static document.
- **`'on'`**: Real-time highlighting of the currently spoken word is active, but auto-scrolling is disabled so the user retains complete manual control over document scrolling.
- **`'track'`** (default): Real-time highlighting is paired with continuous teleprompter auto-scrolling.

### 6.3 Manual Interaction Cooldown
To respect user agency during playback:
- Listening to passive `wheel` and `touchmove` events records `WordSync._userInteractedAt = performance.now()`.
- The teleprompter loop automatically pauses auto-scrolling for 2.5 seconds upon user interaction, allowing the reader to freely inspect preceding or subsequent turns without fighting the scroll engine.
- Clicking any transcript word span immediately resets the interaction cooldown (`_userInteractedAt = 0`) and centers playback smoothly on the clicked word.

---

## 7. Diagnostic & Verification Procedures

### 7.1 Running the Cross-Browser Synchronization Test Suite
Run `pytest` to verify byte parity, `VBR1` trailer integrity, client-side `Xing -> Info` progressive `Blob` neutralization, and real headless Firefox + Chrome playback synchronization:

```powershell
pytest tests/
```

Specifically:
- `tests/test_cross_browser_word_sync.py`:
  - Verifies that all VBR episodes in `databases/dhamma_transcripts.db` store unwarped physical PCM timestamps in `episode_words` and valid full-duration `VBR1` trailers.
  - Launches headless **Mozilla Firefox** and headless **Google Chrome** against a pure static HTTP server (serving the raw unpatched VBR MP3 with `Access-Control-Allow-Origin: *` just like Podbean CDN) to verify that seeking to `"Everyone,"` (`216.30s`) and `"one"` (`231.34s`) via client-side `WordSync` lands at the exact physical audio position and highlights the exact spoken words in real time.
- `tests/test_audio_cdn_sync.py`:
  - Verifies 1:1 bit-for-bit parity between local `archive/` MP3 files and Podbean CDN streams.

### 7.2 Rebuilding Static Web Assets & Resetting Browser Cache
Whenever `dhamma_transcripts.db`, `word_sync.js`, or `app.js` are updated, recompile the static `dist/` bundle:

```powershell
python main.py web --build
```

Each build stamps a fresh Unix timestamp into `PRAGMA user_version` in `dist/dhamma_web.db`. Additionally, `python main.py web --run` automatically checks `_is_dist_stale(dist_path)` and rebuilds `dist/` whenever `word_sync.js`, `app.js`, `index.html`, or `dhamma_transcripts.db` is newer than `dist/index.html`, and serves static preview assets with `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` headers.

If a browser tab has cached old OPFS database state:
1. Perform a hard reload (`Ctrl+Shift+R` in Firefox / Chrome), or
2. Run `window.resetDeeperDhammaCache()` in the browser developer console to purge the Origin Private File System (OPFS) SQLite cache and reload.

---

## 8. Issue: Firefox Reload (`Ctrl+R`) Fails with "Failed to load transcript" and "0 terms"

### 8.1 Symptom
When loading a deep link (e.g. `http://127.0.0.1:34266/#talk/pb28867656`) in Mozilla Firefox, the page initially renders correctly. However, pressing `Ctrl+R` (standard page refresh) or `F5` causes the transcript pane to fail with:
- Error message: `"Failed to load transcript."`
- Pali Lexicon badge: `"PALI LEXICON 0 terms"` and empty companion list.

```text
+--------------------------------------------------------------------------+
|  <- Back     2026-10-17 • Ajahn Brahm • 45 mins • 49 speech turns        |
|  Playful Perceptions | Ajahn Brahm | 27 November 2025                    |
+--------------------------------------------------------------------------+
|  Word Sync: [Off] [On] [Track]                                           |
|                                     +---------------------------------+  |
|                                     | PALI LEXICON 0 terms            |  |
|                                     |                                 |  |
|         Failed to load transcript.  |       LEXICON COMPANION         |  |
|                                     |  Pali and Buddhist doctrinal    |  |
|                                     |  terms appear chronologically.  |  |
|                                     +---------------------------------+  |
+--------------------------------------------------------------------------+
```

### 8.2 Root Cause Analysis

#### Cause A: Gecko Service Worker Navigation Interception & Cache Skew
In PWA architectures, Mozilla Firefox's Service Worker implementation strictly honors `fetch` event interceptors on standard navigation requests (`Ctrl+R` / `F5`). Prior to the fix:
1. `svc_worker.js` hardcoded a static cache container (`const CACHE_NAME = 'deeper_dhamma_shell_v4';`).
2. Its navigation handler (`req.mode === 'navigate'`) was **Cache-First**, immediately returning cached `index.html` and static assets without revalidating against the server.
3. When static site builds were run via `python main.py web --build`, `export_web.py` only substituted `{{db_version}}` into `index.html`, leaving `svc_worker.js` unstamped.
4. Consequently, Firefox continued serving the older cached `app.js` against updated HTML templates (or vice versa), creating a client-side version skew across page reloads.

#### Cause B: DOM Null Pointer on Removed Toolbar Buttons
Commit `32ae81e` modernized the transcript toolbar (`#transcript-sticky-toolbar`) and removed redundant elements, including the old `#drawer-play-full-btn`. However, the stale cached `app.js` still contained:

```javascript
els.drawerPlayFullBtn = document.getElementById('drawer-play-full-btn');
...
els.drawerPlayFullBtn.onclick = () => { ... };
```

Because `#drawer-play-full-btn` was no longer in the DOM, `els.drawerPlayFullBtn` was `null`. When `openTranscriptDrawer()` executed on page reload, evaluating `els.drawerPlayFullBtn.onclick = ...` threw an unhandled exception:

```text
TypeError: els.drawerPlayFullBtn is null
    at openTranscriptDrawer (app.js:3863)
    at handleRoute (app.js:4102)
```

The unhandled exception immediately jumped to `catch (err)` inside `openTranscriptDrawer()`:
```javascript
els.drawerTurns.innerHTML = '<div class="empty-state"><p>Failed to load transcript.</p></div>';
```
Because the function aborted early, `buildCompanionTermsList()` was never called, leaving the Pali Lexicon companion badge showing `0 terms`.

### 8.3 Architectural Solution

To eliminate service worker skew and guarantee resilient page reloads across all browsers:

#### 1. Dynamic Build-Time Service Worker Version Stamping
`export_web.py` now stamps `svc_worker.js` during compilation with the build's Unix timestamp, rotating the cache name atomically:

```javascript
// deeper_dhamma/web/static/svc_worker.js
const CACHE_NAME = 'deeper_dhamma_shell_{{db_version}}';
```

When `export_static_site()` runs, `{{db_version}}` is replaced with `version_int` (e.g. `deeper_dhamma_shell_1794030447`). When the browser discovers the updated service worker, the `activate` event automatically deletes all prior `deeper_dhamma_shell_*` caches:

```javascript
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key.startsWith('deeper_dhamma_') && key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
});
```

#### 2. Online Network-First Navigation with Offline Fallback
For navigation requests (`req.mode === 'navigate'`), `svc_worker.js` now uses a **Network-First** strategy when online, backed by an `AbortController` 1,200 ms timeout:

```text
+-----------------------+
|  User Presses Ctrl+R  |
+-----------------------+
            |
            v
   [navigator.onLine?]
     /           \
   Yes            No
   /                \
  v                  v
+------------------+  +--------------------+
| Fetch Network    |  | Read Cache         |
| (1200ms Timeout) |  | (./index.html)     |
+------------------+  +--------------------+
  |              |
Success        Timeout
  |              |
  v              v
+--------------+ +--------------------+
| Update Cache | | Fallback to Cache  |
| & Return DOM | | (PWA Works Offline)|
+--------------+ +--------------------+
```

This guarantees that standard browser refreshes (`Ctrl+R` / `F5`) always load the latest application shell when connected to the server, while retaining 100% offline functionality when disconnected.

#### 3. Query-Sensitive Asset Matching
`matchInCache()` was updated to match exact URLs with query parameters (`?v=...`) before falling back to `ignoreSearch: true`, ensuring versioned asset updates are immediately fetched and cached.

#### 4. Defensive DOM Guards & In-App Cache Reset
All references to `#drawer-play-full-btn` were eliminated, and explicit null guards were added across all drawer elements (`els.drawerTurns`, `els.drawerTitle`, `els.drawerDateTag`, `els.drawerMetaInfo`, `els.drawerPodbeanLink`, `els.drawerShareBtn`).

The transcript error state was enhanced to present an actionable error card with a 1-click recovery button:

```javascript
els.drawerTurns.innerHTML = `
  <div class="empty-state">
    <div class="empty-icon">⚠️</div>
    <p>Failed to load transcript.</p>
    <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem;">${escapeHtml(err.message || String(err))}</p>
    <button type="button" class="btn-primary" style="margin-top: 1rem;" onclick="window.resetDeeperDhammaCache()">
      🔄 Reset Cache & Reload
    </button>
  </div>
`;
```

### 8.4 Verification
Verify atomic cache rotation and network-first navigation using the automated test suite:

```powershell
pytest tests/test_export_web.py -k "test_service_worker_dynamic_version_stamping_and_network_first_navigation"
```

---

## 9. Issue: Bookmarks Worker Message Desynchronization & GitHub Pages Deployment Pipeline

### 9.1 Symptoms
1. **Red Banner Error on Bookmarks View**:
   Navigating to `#bookmarks` displays:
   `FAILED TO LOAD BOOKMARKS: Unknown message type: get_episodes_by_ids`
2. **Delayed Deployment Updates on DeeperDhamma.com**:
   After running `python main.py web --deploy`, the live site at `https://deeperdhamma.com/` continues serving an older version stamp (e.g. `1794247613`), masking newly committed UI and physics improvements.

---

### 9.2 Root Cause Analysis

```text
+-------------------------------------------------------------------------------+
| Cause A: GitHub Pages Legacy Jekyll Container Bottleneck                     |
+-------------------------------------------------------------------------------+
| - In the absence of a .nojekyll file in the deployment root (dist/), GitHub   |
|   Pages invokes an automated jekyll-build-pages container.                    |
| - Jekyll encounters SQLite binary assets (dhamma_web.db, 5.2MB) and files     |
|   with leading underscores (_headers, _redirects), leading to failed or       |
|   stalled build queues when multiple commits are pushed in close succession.  |
+-------------------------------------------------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
| Cause B: Service Worker Pre-Cache HTTP Lockout & Worker Desynchronization     |
+-------------------------------------------------------------------------------+
| - svc_worker.js previously invoked fetch(asset) without { cache: 'reload' }.  |
| - Fastly edge CDN and browser HTTP caches retain static files for up to 600s  |
|   (max-age=600). The service worker thus precached stale responses into new   |
|   cache buckets.                                                              |
| - Meanwhile, an updated app.js called getEpisodesByIds(ids) via Web Worker.  |
|   If an older db_worker.js remained cached in memory or disk, it threw:       |
|   "Unknown message type: get_episodes_by_ids".                               |
+-------------------------------------------------------------------------------+
```

---

### 9.3 Architectural Solutions

#### 1. Automated `.nojekyll` Bypass
`export_static_site()` and `deploy_to_github_pages()` in `deeper_dhamma/export_web.py` now ensure a `.nojekyll` file exists in `dist/` and `static/`. GitHub Pages completely skips the Jekyll build container and deploys static assets directly to Fastly CDN in under 15 seconds.

#### 2. Graceful Fallback for Batch Talk Lookups
In both `adapters/wasm_client.js` and `db_client.js`, `getEpisodesByIds()` now catches `Unknown message type` and falls back to individual `getEpisode(id)` lookups:

```javascript
async getEpisodesByIds(ids) {
  if (!ids || ids.length === 0) return [];
  await this.init();
  try {
    return await this.send('get_episodes_by_ids', { ids });
  } catch (err) {
    if (err && err.message && err.message.includes('Unknown message type')) {
      console.warn('[WASM Client] Worker lacks get_episodes_by_ids; falling back to individual episode fetches:', err.message);
      const results = await Promise.all(ids.map((id) => this.getEpisode(id).catch(() => null)));
      return results.filter(Boolean);
    }
    throw err;
  }
}
```

#### 3. Forced HTTP Cache Bypass in Service Worker
`svc_worker.js` passes `{ cache: 'reload' }` during installation:

```javascript
for (const asset of CORE_ASSETS) {
  try {
    const res = await fetch(asset, { cache: 'reload' });
    if (res && res.status === 200) {
      await cache.put(asset, res.clone());
...
```

#### 4. Versioned Service Worker Registration
`app.js` registers `./svc_worker.js?v=${encodeURIComponent(window.__DEEPER_DHAMMA_VERSION__)}` and invokes `reg.update()`, triggering immediate browser detection of new service worker scripts.

---

### 9.4 Verification
Run the automated test suite verifying `.nojekyll` presence, reload caching, and worker message fallback:

```powershell
pytest tests/test_export_web.py -k "test_bookmark_feature_and_view_integrity or test_service_worker"
```

---

## 10. Issue: Audio Ingestion & aria2c Path Length Failure on Long Episode Titles (Windows MAX_PATH)

### 10.1 Symptoms

Running `python main.py sync --all` (or with `--retry-errors`) aborted when downloading long-titled episodes, terminating with `aria2c errorCode=16`:

```text
[3251/3251] Ingesting: 2016 June | 12/26. SN12.1 Dependent Origination, SN12.2 Analysis of Dependent Origination, AN3.35 Divine messengers, SN15 Tears and MN38 The Greater Discourse on the destruction of craving | Brahmali
   -> Folder: 2016/standalone/
   -> File:   2016-08-22_2016_june_12_26_sn12_1_dependent_origination_sn12_2_analysis_of_dependent_origination_an3_35_divine_messengers_sn15_tears_and_mn38_the_greater_discourse_on_the_destruction_of_craving_brahmali.mp3

11/10 23:58:04 [ERROR] CUID#7 - Download aborted. URI=https://s380.podbean.com/...
Exception: [AbstractCommand.cc:403] errorCode=16 URI=https://s380.podbean.com/...
  -> [RequestGroup.cc:761] errorCode=16 Download aborted.
  -> [AbstractDiskWriter.cc:204] errNum=3 errorCode=16 Failed to open the file ./2016/standalone//./2016-08-22_2016_june_12_26_sn12_1_dependent_origination_sn12_2_analysis_of_dependent_origination_an3_35_divine_messengers_sn15_tears_and_mn38_the_greater_discourse_on_the_destruction_of_craving_brahmali.mp3.part, cause: The system cannot find the path specified.

[yt-dlp error] ERROR: aria2c exited with code 16
[!] Error downloading '2016 June | 12/26. SN12.1 Dependent Origination, ...': ERROR: aria2c exited with code 16
[✓] Sync finished: 0 episode(s) downloaded.
```

---

### 10.2 Root Cause Analysis

```text
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause A: Long Episode Title & Filename Expansion                                                                                                         |
| - Talk filename: 2016-08-22_2016_june_12_26_sn12_1_dependent_origination_... (202 chars, longest in 3,323-talk catalog).                               |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
                                                                          |
                                                                          v
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause B: Relative outtmpl in yt-dlp & aria2c Argument Synthesis                                                                                          |
| - outtmpl: "%(custom_year)s/%(custom_series)s/%(custom_filename)s.%(ext)s" (relative).                                                                  |
| - yt-dlp Aria2cFD prepended `.\` to both --dir and --out:                                                                                                |
|     --dir .\2016\standalone\                                                                                                                            |
|     --out .\2016-08-22_...mp3.part                                                                                                                       |
| - aria2c concatenated them into: ./2016/standalone//./2016-08-22_...mp3.part                                                                            |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
                                                                          |
                                                                          v
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause C: Windows Win32 MAX_PATH (260 char) Ceiling on Uncanonicalized Relative Paths                                                                     |
| - Working directory: C:\dev\deeper_dhamma\archive\ (27 chars).                                                                                           |
| - Win32 CreateFileW combines cwd + relative string before canonicalizing:                                                                                |
|     C:\dev\deeper_dhamma\archive\.\2016\standalone\.\2016-08-22_...mp3.part                                                                             |
| - Total length: 260 characters (== MAX_PATH buffer limit).                                                                                               |
| - Win32 CreateFileW fails immediately with Win32 Error 3 (ERROR_PATH_NOT_FOUND) -> aria2c exits with code 16.                                            |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
                                                                          |
                                                                          v
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
| Cause D: Lack of External Downloader Exception Fallback                                                                                                  |
| - yt-dlp re-raised aria2c exit code 16 as an unhandled DownloadError.                                                                                    |
| - downloader.py caught the error and recorded it in pipeline_state.db, failing the ingestion run.                                                        |
+----------------------------------------------------------------------------------------------------------------------------------------------------------+
```

---

### 10.3 Architectural Solutions

#### 1. Absolute Home Path Resolution (`paths: {"home": str(target_dir)}`)
In `deeper_dhamma/downloader.py`, `ydl_opts` now configures `"paths": {"home": str(target_dir)}`. yt-dlp resolves the target directory into a clean, canonical absolute path (`C:\dev\deeper_dhamma\archive\2016\standalone\`), eliminating redundant relative `.\` and `//./` path inflation.

```python
ydl_opts = {
    "downloader": "aria2c",
    "downloader_args": {"aria2c": aria2_args},
    "external_downloader": {"default": "aria2c"},
    "external_downloader_args": {"aria2c": aria2_args},
    "ratelimit": (rate_limit_mb * 1024 * 1024) if rate_limit_mb else None,
    "download_archive": str(archive_path),
    "writethumbnail": True,
    "logger": ydl_adapter,
    "windowsfilenames": True,
    "retries": 10,
    "fragment_retries": 10,
    "paths": {"home": str(target_dir)},
    "outtmpl": "%(custom_year)s/%(custom_series)s/%(custom_filename)s.%(ext)s",
    "quiet": False,
    "no_warnings": True,
}
```

#### 2. Resilient Native Downloader Fallback
If `aria2c` encounters an exit failure (code 16, Win32 `MAX_PATH` path boundaries, segment control file `.aria2` write failures, or network timeouts), `run_sync` now catches the exception, purges transient partial files, and immediately retries using yt-dlp's native Python HTTP downloader.

Because Python on Windows utilizes native extended-length paths seamlessly, the download completes without hitting `MAX_PATH` restrictions while preserving exact 1:1 bitstream parity with the remote Podbean CDN stream.

```python
# deeper_dhamma/downloader.py
except Exception as e:
    ydl_adapter.clear_active_progress()
    err_str = str(e)

    # Fallback to native yt-dlp downloader if aria2c fails (e.g. Windows MAX_PATH limits, network/exit errors)
    if "aria2c exited with code" in err_str or "aria2c" in err_str.lower():
        l.warning(f"   [!] aria2c failed ({e}). Retrying with native downloader...")
        for remnant in (dest_mp3, dest_m4a, dest_jpg):
            if remnant.exists() and remnant.stat().st_size == 0:
                try:
                    remnant.unlink()
                except OSError:
                    pass
        for p in dest_folder.glob(f"{ep['filename']}.*"):
            if p.suffix.lower() in (".temp", ".part", ".ytdl", ".aria2") or ".temp." in p.name:
                try:
                    p.unlink()
                except OSError:
                    pass

        native_opts = dict(ydl_opts)
        native_opts.pop("downloader", None)
        native_opts.pop("downloader_args", None)
        native_opts.pop("external_downloader", None)
        native_opts.pop("external_downloader_args", None)
        try:
            ydl_native = yt_dlp.YoutubeDL(native_opts)
            ydl_native.add_post_processor(CatalogEpisodePP(ydl_native, ep), when="pre_process")
            ret = ydl_native.download([ep["media_url"]])
            ydl_adapter.clear_active_progress()
            if ret == 0:
                elapsed = time.time() - t0
                success_count += 1
                if tdb:
                    tdb.clear_error(ep_id)
                dest_file = dest_mp3 if dest_mp3.exists() else dest_m4a
                size_str = f" ({dest_file.stat().st_size / (1024 * 1024):.1f} MB)" if dest_file.exists() else ""
                tag_str = "repaired with exact bitstream parity" if ep.get("is_repair") else "exact bitstream copy preserved"
                l.info(f"   [✓] Completed via native fallback in {elapsed:.1f}s{size_str} - {tag_str}\n")
                if sleep_seconds > 0 and idx < len(pending_episodes) and elapsed > 1.0:
                    time.sleep(sleep_seconds)
                continue
        except KeyboardInterrupt:
            raise
        except Exception as fallback_e:
            e = fallback_e
            err_str = str(fallback_e)
```

#### 3. Automatic Pre-Flight Error Resolution
The pre-flight error checker in `_dl_auto_resolver` automatically clears previous recorded aria2c code 16 errors, allowing automatic retries without requiring the user to explicitly pass `--retry-errors`.

```python
if "aria2c exited with code 16" in err_msg or "code 16" in err_msg:
    return "aria2c path length error reset for native retry"
```

---

### 10.4 Verification

Verify that all audio sync and parity checks pass:

```powershell
# 1. Parity and downloader unit tests
pytest tests/test_downloader_parity.py tests/test_sync_repair.py

# 2. Ingest verification across entire 3,251-episode scope
python main.py sync --all
```

---

## 11. Issue: Service Worker Database Double-Caching, Hard-Refresh Poisoning & Atomic Background Invalidation

### 11.1 Symptoms
1. **Newly Transcribed Talks Missing After Rebuild**:
   After transcribing more talks and compiling an updated `dist/dhamma_web.db` (16.99 MB, 114 transcribed talks), the web UI continues displaying only the initial 9 transcribed talks (5.4 MB database).
2. **Hard Refresh (`Ctrl + F5`) Fails to Update**:
   Pressing `Ctrl + F5` or `Ctrl + Shift + R` reloads the page, but the DevTools console reports:
   ```text
   [DB Worker] Using cached database (v1794403294) from IndexedDB.
   [DB Worker] Database ready: v1794403294, 5423104 bytes.
   [WASM Client] SQLite WASM Worker initialized successfully:
     Object { version: 1794403294, cached: true, size: 5423104 }
   ```
   Notice that the database size is stuck at `5423104` bytes (~5.4 MB, the previous 9-talk archive), despite being stamped with the newest build version `1794403294`.
3. **Only Full Cache Reset Works**:
   Running `window.resetDeeperDhammaCache()` (which deletes IndexedDB and unregisters Service Workers) forces the new database to download, while normal user refresh actions fail.

---

### 11.2 Root Cause Analysis

```text
+-------------------------------------------------------------------------------+
| Cause A: Service Worker Double-Caching & Cache Interception                   |
+-------------------------------------------------------------------------------+
| - svc_worker.js previously listed './dhamma_web.db' in its CORE_ASSETS list.  |
| - When db_worker.js checked the remote version via Range probe (bytes=0-99),  |
|   the probe bypassed the Service Worker and retrieved the new version stamp.  |
| - However, when db_worker.js requested fetch('dhamma_web.db?t=...'), the      |
|   Service Worker intercepted the request. Because matchInCache matched        |
|   dhamma_web.db with ignoreSearch: true, it returned the STALE 5.4 MB copy!   |
+-------------------------------------------------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
| Cause B: IndexedDB Version Poisoning & Hard Refresh Immunity                  |
+-------------------------------------------------------------------------------+
| - db_worker.js received the stale 5.4 MB buffer from the Service Worker and   |
|   saved it into IndexedDB tagged with the NEW version stamp (1794403294).     |
| - Browser hard refresh (Ctrl + F5) instructs the network engine to bypass HTTP|
|   cache for HTML/CSS/JS, but NEVER clears IndexedDB or client-side storage.   |
| - On reload, db_worker.js compared remoteVersion (1794403294) against cached  |
|   IndexedDB version (1794403294). Because the versions matched, db_worker.js  |
|   reused the 5.4 MB buffer from IndexedDB and never queried the network again.|
+-------------------------------------------------------------------------------+
```

---

### 11.3 Architectural Solution: Atomic Background Invalidation & In-Memory Hot-Swap

To guarantee that database updates never stall user interactions, survive network drops, and update seamlessly without manual cache resets:

```text
+---------------------------------------------------------------------------------------+
| 1. Instant Startup (0ms Latency)                                                      |
+---------------------------------------------------------------------------------------+
| - If IndexedDB contains a cached database snapshot, db_worker.js deserializes and     |
|   mounts it IMMEDIATELY. The UI becomes interactive with zero network delay.          |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| 2. Non-Blocking Background Probe & Update Check                                       |
+---------------------------------------------------------------------------------------+
| - db_worker.js issues a 100-byte Range probe to the server in the background.         |
| - Compares remote version AND file size from Content-Range (bytes 0-99/<total_bytes>).|
| - If identical -> exits silently (cache is up to date).                               |
| - If updated -> begins streaming the new database in the background.                  |
|   * ACTIVE DATABASE REMAINS 100% FUNCTIONAL during the entire download.               |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| 3. Atomic Integrity Verification Gate                                                 |
+---------------------------------------------------------------------------------------+
| - Downloaded buffer is verified BEFORE touching IndexedDB or the active DB:           |
|   1. Magic Header: verifies "SQLite format 3\000".                                    |
|   2. Isolated Test Instance: candidateDb = new sqlite3.oo1.DB() deserializes buffer.   |
|   3. Sanity Query: runs candidateDb.exec("SELECT COUNT(*) FROM episodes").            |
|                                                                                       |
|   [IF DOWNLOAD FAILS OR TRUNCATES] ---> Candidate instance discarded cleanly;          |
|                                         active cached DB & IndexedDB remain UNTOUCHED.|
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| 4. Atomic Persistence & Seamless In-Memory Hot-Swap                                   |
+---------------------------------------------------------------------------------------+
| - Atomically writes validated buffer to IndexedDB (setCachedDatabase).                 |
| - Seamlessly swaps the in-memory SQLite connection:                                   |
|     const oldDb = db; db = candidateDb; oldDb.close();                                 |
| - Worker posts message: { type: 'db_hot_swapped', version, size }                      |
| - db_client.js dispatches onHotSwap() to app.js.                                       |
| - app.js refreshes stats, talk counts, and active views WITHOUT REFRESHING THE PAGE!   |
+---------------------------------------------------------------------------------------+
```

#### 1. Removal of `dhamma_web.db` from Service Worker `CORE_ASSETS`
`db_worker.js` already provides complete offline durability through IndexedDB. Pre-caching the 17 MB binary in CacheStorage was redundant, doubled storage requirements (34 MB), and caused stale cache collisions.

#### 2. Network-First Exception for Database Downloads in `svc_worker.js`
`svc_worker.js` now routes all `.db` requests (`isDbFetch`) directly to the network when online, falling back to cache only when offline:

```javascript
const isRangeProbe = req.headers.get('Range') === 'bytes=0-99';
const isDbFetch = url.pathname.endsWith('.db') || url.pathname.includes('dhamma_web.db');
const isServerProbe = isRangeProbe || isDbFetch || url.pathname.startsWith('/api/');
```

#### 3. Dual Version and Size Detection in `db_worker.js`
`fetchRemoteVersion()` now parses total remote file size from `Content-Range: bytes 0-99/<total_bytes>`. If `cached.buffer.byteLength` differs from `remoteTotalBytes` by more than 1 KB, the cache is marked stale even if version stamps match.

#### 4. Candidate DB Validation & Hot-Swap Pipeline
The candidate buffer is validated in an isolated `candidateDb` instance. If validation passes, `db` is hot-swapped in memory, IndexedDB is updated, and a `db_hot_swapped` event notifies the main thread to refresh view models in real time.

---

### 11.4 Verification

Run the web export and atomic update verification tests:

```powershell
pytest tests/test_export_web.py -v
```






