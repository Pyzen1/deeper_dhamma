# Offline Transcript Loading Latency & Continuous Teleprompter Auto-Scroll

## 1. Issue: High Latency (> 1s) Loading Transcripts in Offline / Unserved Environments

### 1.1 Symptom
When accessing the static distribution (`dist/index.html`) offline, unserved via `file:///`, or on static hosts with no active backend server:
- Clicking any talk card or directly navigating to a talk URL (e.g. `#talk/pb27802310`) took more than 1 second to display the transcript.
- The UI showed a blocking `"Loading transcript turns..."` spinner during the delay.
- Memory allocations and CPU spikes occurred on the main thread during talk drawer transitions.

---

### 1.2 Root Cause Analysis

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

### 1.3 Architectural Fix & Optimizations

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

## 2. Sticky Toolbar, Triple Word Sync (`Off | On | Track`), & Continuous Teleprompter Auto-Scroll

### 2.1 Evolution of Auto-Scroll Approaches
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

### 2.2 Word Sync Mode Semantics (`WordSync.mode`)
The synchronization state is managed as a lightweight, in-memory global state variable (`WordSync.mode`) with three distinct modes:
- **`'off'`**: Synchronized highlighting and auto-scrolling are fully deactivated. Transcript text acts as a static document.
- **`'on'`**: Real-time highlighting of the currently spoken word is active, but auto-scrolling is disabled so the user retains complete manual control over document scrolling.
- **`'track'`** (default): Real-time highlighting is paired with continuous teleprompter auto-scrolling.

### 2.3 Manual Interaction Cooldown
To respect user agency during playback:
- Listening to passive `wheel` and `touchmove` events records `WordSync._userInteractedAt = performance.now()`.
- The teleprompter loop automatically pauses auto-scrolling for 2.5 seconds upon user interaction, allowing the reader to freely inspect preceding or subsequent turns without fighting the scroll engine.
- Clicking any transcript word span immediately resets the interaction cooldown (`_userInteractedAt = 0`) and centers playback smoothly on the clicked word.
