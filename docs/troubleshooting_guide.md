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

#### Cause B: Pre-Warping Word Timestamps vs. the 1:1 44.1 kHz Playback Clock
Previously, `StreamSeekCalibrator` pre-warped all segment and word timestamps in `databases/dhamma_transcripts.db` and `words/*.bin` using Chromium's `Xing` seek curve $S_{\text{xing}}(t_{\text{phys}})$.
- However, the `Xing` table is **only** consulted at the instant a seek is initiated.
- Once `<audio>` lands at a byte offset corresponding to physical time $t_{\text{phys}}$ and begins sequential playback, the browser's MPEG-1 Layer III audio decoder outputs `1152` PCM samples per frame at `44,100 Hz`, advancing `audio.currentTime` at **exactly `1.000s` per `1.000s` of physical PCM audio**.
- Because pre-warped `.bin` timestamps compressed `5.18s` of real speech (`216.30s .. 221.48s`) into `3.78s` of `Xing` seek time (`203.14s .. 206.92s`), word highlighting drifted out of sync with the speaker's voice during continuous playback even in Chromium.
- Additionally, `ffprobe` previously used `-read_intervals %+3600`, truncating VBR calibration after 60 minutes on talks longer than 1 hour (`pb27802310` is 107 minutes).

---

## 3. Architectural Solution

The synchronization engine resolves both issues across all browsers without modifying a single byte of the raw archive MP3 files in `archive/`:

```text
+-----------------------------------------------------------------------------+
| 1. Canonical Storage: True Physical 44.1 kHz PCM Timestamps                 |
|    - dhamma_transcripts.db (`speech_segments.start_sec`, `end_sec`)         |
|    - words/<episode_id>.bin (`uint32 start_ms`, `uint16 dur_ms`)            |
|    - Appends compact `VBR1` trailer (`pcm_ms`, `audio_byte_offset`, `toc`)  |
|      for VBR episodes across 100% of talk duration.                         |
+-----------------------------------------------------------------------------+
                                       |
                                       v
+-----------------------------------------------------------------------------+
| 2. In-Memory VBR TOC Neutralization (`/audio/<episode_id>.mp3`)             |
|    - Streams HTTP 206 Partial Content from local `archive/` (or CDN proxy)  |
|    - Patches 8 bytes in memory only when range overlaps `xing_abs_offset`:  |
|      `b"Xing" + flags(7)`  --->  `b"Info\x00\x00\x00\x03"` (clears bit 0x04)|
|    - Forces BOTH Mozilla Firefox and Chromium into identical, continuous,   |
|      dead-zone-free linear byte-offset seeking:                             |
|      `S_linear(t_phys) = (audio_byte_offset / bytes_len) * total_dur`       |
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
| `+16` | `uint8[100]` | `toc` | Raw 100-byte `Xing` TOC array (for static CDN fallback) |
| `+116` | `uint32` | `sample_count` | Number of packet sample points `M` (~2s stride across full file) |
| `+120` | `uint32[2*M]` | `samples` | `M` pairs of `(uint32 pcm_ms, uint32 audio_byte_offset)` |

---

## 4. Diagnostic & Verification Procedures

### 4.1 Running the Cross-Browser Synchronization Test Suite
Run `pytest` to verify byte parity, `VBR1` trailer integrity, in-memory `Xing -> Info` stream neutralization, and real headless Firefox + Chrome playback synchronization:

```powershell
pytest tests/
```

Specifically:
- `tests/test_cross_browser_word_sync.py`:
  - Verifies that all VBR episodes in `databases/dhamma_transcripts.db` and `words/*.bin` store unwarped physical PCM timestamps and valid full-duration `VBR1` trailers.
  - Verifies that `/audio/pb27802310.mp3` neutralizes `Xing -> Info` (`flags = 3`) in memory while leaving `archive/` files untouched on disk.
  - Launches headless **Mozilla Firefox** and headless **Google Chrome** to verify that seeking to `"Everyone,"` (`216.30s`) and `"one"` (`231.34s`) lands at the exact same audio position (`< 0.05s` delta) and highlights the exact spoken words in real time.
- `tests/test_audio_cdn_sync.py`:
  - Verifies 1:1 bit-for-bit parity between local `archive/` MP3 files and Podbean CDN streams.

### 4.2 Rebuilding Static Web Assets & Resetting Browser Cache
Whenever `dhamma_transcripts.db`, `words/*.bin`, `word_sync.js`, or `app.js` are updated, recompile the static `dist/` bundle:

```powershell
python main.py web --build
```

Each build stamps a fresh Unix timestamp into `PRAGMA user_version` in `dist/dhamma_web.db`. If a browser tab has cached old static scripts:
1. Perform a hard reload (`Ctrl+Shift+R` in Firefox / Chrome), or
2. Run `window.resetDeeperDhammaCache()` in the browser developer console to purge the Origin Private File System (OPFS) SQLite cache and reload.
