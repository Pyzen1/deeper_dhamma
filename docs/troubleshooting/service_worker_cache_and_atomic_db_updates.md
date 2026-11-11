# Service Worker Database Double-Caching, Hard-Refresh Poisoning & Atomic Background Invalidation

## 1. Symptoms

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

## 2. Root Cause Analysis

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

## 3. Architectural Solution: Atomic Background Invalidation & In-Memory Hot-Swap

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

### 3.1 Removal of `dhamma_web.db` from Service Worker `CORE_ASSETS`
`db_worker.js` already provides complete offline durability through IndexedDB. Pre-caching the 17 MB binary in CacheStorage was redundant, doubled storage requirements (34 MB), and caused stale cache collisions.

### 3.2 Network-First Exception for Database Downloads in `svc_worker.js`
`svc_worker.js` routes all `.db` requests (`isDbFetch`) directly to the network when online, falling back to cache only when offline:

```javascript
const isRangeProbe = req.headers.get('Range') === 'bytes=0-99';
const isDbFetch = url.pathname.endsWith('.db') || url.pathname.includes('dhamma_web.db');
const isServerProbe = isRangeProbe || isDbFetch || url.pathname.startsWith('/api/');
```

### 3.3 Dual Version and Size Detection in `db_worker.js`
`fetchRemoteVersion()` parses total remote file size from `Content-Range: bytes 0-99/<total_bytes>`. If `cached.buffer.byteLength` differs from `remoteTotalBytes` by more than 1 KB, the cache is marked stale even if version stamps match.

### 3.4 Candidate DB Validation & Hot-Swap Pipeline
The candidate buffer is validated in an isolated `candidateDb` instance. If validation passes, `db` is hot-swapped in memory, IndexedDB is updated, and a `db_hot_swapped` event notifies the main thread to refresh view models in real time.

---

## 4. Verification

Run the web export and atomic update verification tests:

```powershell
pytest tests/test_export_web.py -v
```
