# Firefox Page Reload (`Ctrl+R`) Failure & Service Worker Version Skew

## 1. Symptom

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

---

## 2. Root Cause Analysis

### Cause A: Gecko Service Worker Navigation Interception & Cache Skew
In PWA architectures, Mozilla Firefox's Service Worker implementation strictly honors `fetch` event interceptors on standard navigation requests (`Ctrl+R` / `F5`). Prior to the fix:
1. `svc_worker.js` hardcoded a static cache container (`const CACHE_NAME = 'deeper_dhamma_shell_v4';`).
2. Its navigation handler (`req.mode === 'navigate'`) was **Cache-First**, immediately returning cached `index.html` and static assets without revalidating against the server.
3. When static site builds were run via `python main.py web --build`, `export_web.py` only substituted `{{db_version}}` into `index.html`, leaving `svc_worker.js` unstamped.
4. Consequently, Firefox continued serving the older cached `app.js` against updated HTML templates (or vice versa), creating a client-side version skew across page reloads.

### Cause B: DOM Null Pointer on Removed Toolbar Buttons
Modernization of the transcript toolbar (`#transcript-sticky-toolbar`) removed redundant elements, including the old `#drawer-play-full-btn`. However, the stale cached `app.js` still contained:

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

---

## 3. Architectural Solution

To eliminate service worker skew and guarantee resilient page reloads across all browsers:

### 3.1 Dynamic Build-Time Service Worker Version Stamping
`export_web.py` stamps `svc_worker.js` during compilation with the build's Unix timestamp, rotating the cache name atomically:

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

### 3.2 Online Network-First Navigation with Offline Fallback
For navigation requests (`req.mode === 'navigate'`), `svc_worker.js` uses a **Network-First** strategy when online, backed by an `AbortController` 1,200 ms timeout:

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

### 3.3 Query-Sensitive Asset Matching
`matchInCache()` matches exact URLs with query parameters (`?v=...`) before falling back to `ignoreSearch: true`, ensuring versioned asset updates are immediately fetched and cached.

### 3.4 Defensive DOM Guards & In-App Cache Reset
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

---

## 4. Verification

Verify atomic cache rotation and network-first navigation using the automated test suite:

```powershell
pytest tests/test_export_web.py -k "test_service_worker_dynamic_version_stamping_and_network_first_navigation"
```

