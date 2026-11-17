# `100dvh` App-Shell Layout & Mobile Viewport Drift

## 1. Symptoms

1. **Mobile Chrome (Pixel 8a) Top & Bottom Bar Drift**:
   On mobile viewports (`<= 600px`), scrolling or slightly zooming caused the bottom audio player bar (`footer.audio-player-bar`) to disappear off screen below and the Word Sync toolbar (`aside.transcript-sticky-toolbar`) plus top navigation header (`aside.app-sidebar`) to disappear off screen above.
2. **Short-Screen Expanded Lexicon Companion Overflow (`320×568`)**:
   Opening the mobile Lexicon Companion sheet (`.transcript-lexicon-companion.is-expanded`) on short screens pushed the sheet downward past `<main>`'s bottom edge behind the audio player bar because `.transcript-reader-container` and the companion stacked vertically as siblings inside `.transcript-layout-container`.
3. **Desktop/Tablet Fixed-Chrome Coordination Tax**:
   Using `position: fixed` for `.app-sidebar` (`bottom: 78px`) and `.audio-player-bar` (`bottom: 0`) alongside `window` scrolling required duplicated `margin-left: 260px` / `76px` offsets, `padding-bottom` fallbacks, and `--sidebar-height` positioning math across breakpoints.

---

## 2. Root Cause Analysis

- **Layout Viewport vs. Visual Viewport Coupling (`window` scroll)**:
  In Android Chrome, `position: fixed` and `position: sticky` attach to the layout viewport rather than the visual viewport. Whenever the visual viewport shrinks relative to the layout viewport (pinch/double-tap zoom, accessibility scaling, software keyboard, or browser toolbar resizing), scrolling pans the visual viewport vertically inside the taller layout viewport—pushing top bars above the screen and leaving the bottom playbar below it.
- **Sticky Containing-Block Ceiling in `.transcript-layout-container`**:
  Inside `#transcript-view`, `.transcript-lexicon-companion` sat below `.transcript-reader-container` inside `.transcript-layout-container`. Because `position: sticky; bottom: 0;` cannot overlap earlier siblings in the same containing block, expanding the companion taller than the remaining space below the turns forced it downward past the bottom of `<main>`.

---

## 3. Architectural Solution: `100dvh` CSS Grid App Shell

```text
Desktop / Tablet (> 600px)                     Mobile (<= 600px)
+---------+---------------------------+        +-----------------------------------+
| aside   | main.app-main             |        | aside.app-sidebar (grid: sidebar) |
| .app-   | (ONLY scroll container;   |        +-----------------------------------+
| sidebar |  overflow-y: auto;        |        | main.app-main (grid: main, 1fr)   |
| (grid:  |  overflow-x: clip)        |        |  +-----------------------------+  |
| sidebar)|  - Word Sync sticky top:0 |        |  | aside#transcript-sticky-    |  |
|         |  - Companion sticky       |        |  | toolbar (sticky top: 0)     |  |
+---------+---------------------------+        |  +-----------------------------+  |
| footer.audio-player-bar             |        |  | turns scroll under toolbar  |  |
| (grid: footer, auto height)         |        |  | & behind companion sheet    |  |
+-------------------------------------+        |  +-----------------------------+  |
                                               |  | aside#transcript-lexicon-   |  |
                                               |  | companion (grid-row: 2/4,   |  |
                                               |  |  sticky bottom: 0)          |  |
                                               |  +-----------------------------+  |
                                               +-----------------------------------+
                                               | footer.audio-player-bar           |
                                               | (grid: footer, auto height)       |
                                               +-----------------------------------+
```

### 3.1 Non-Overlapping Grid Regions ([style.css](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/style.css))
- `html, body` lock to `height: 100%; height: 100dvh; overflow: hidden; overscroll-behavior: none;` so the outer document never scrolls and `100dvh` tracks dynamic mobile browser toolbars.
- `body` defines three non-overlapping CSS Grid areas: `"sidebar main" / "footer footer"` (`260px` desktop, `76px` at `<= 900px`), switching to three stacked rows `"sidebar" / "main" / "footer"` at `<= 600px`.
- `<main class="app-main">` is the sole vertical scroll pane (`overflow-y: auto; overflow-x: clip; overscroll-behavior-y: contain;`), while `.views-wrapper` retains `max-width: 1200px` and `padding-top` so sticky toolbars dock flush at `top: 0`.

### 3.2 `<= 1024px` Transcript Grid Overlay (`display: contents`)
- At `<= 1024px`, `.app-main:has(#transcript-view.active)` drops outer padding (`padding: 0`) and `#transcript-view.active` becomes a 3-row CSS Grid (`auto auto minmax(0, 1fr)`).
- `#transcript-sticky-toolbar` occupies `grid-row: 1` (`position: sticky; top: 0;`).
- `.transcript-layout-container` uses `display: contents;` so `.transcript-view-header` (`grid-row: 2`), `.transcript-reader-container` (`grid-row: 3`), and `#transcript-lexicon-companion` (`grid-row: 2 / 4; align-self: end; position: sticky; bottom: 0;`) share the full `#transcript-view` height.
- Expanded companion height is bounded by `min(60dvh, calc(var(--main-height, 520px) - var(--toolbar-height, 48px) - 4px))` so it grows upward cleanly over turns/header without overflowing below `<main>`.

### 3.3 Scroll-Container Routing ([app.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/app.js), [word_sync.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/word_sync.js))
- `getScrollContainer()`, `getScrollTopPos()`, `scrollContentTo()`, and `scrollElementIntoReadingZone()` in `app.js` scroll `#main-content` (falling back to `window` only if `#main-content` is absent).
- `WordSync.getScrollContainer()`, `getScrollTop()`, `setScrollTop()`, `getLineInfo()`, and `updateTeleprompter()` in `word_sync.js` drive continuous teleprompter tracking directly via `#main-content.scrollTop` while `updateLayoutChromeVars()` observes `#main-content` to keep `--main-height` current.

---

## 4. Verification

```powershell
python main.py web --build
python -m pytest tests/test_export_web.py -k "app_shell_layout or small_screen or pb9577355" -v
```

Key regression tests in [test_export_web.py](file:///c:/dev/deeper_dhamma/tests/test_export_web.py):
- `test_responsive_small_screen_layout_contract`
- `test_headless_chrome_small_screen_no_overflow`
- `test_headless_chrome_pb9577355_lexicon_companion_track_sync`
- `test_headless_chrome_app_shell_layout_e2e`
