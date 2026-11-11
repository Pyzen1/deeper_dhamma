# Bookmarks Worker Message Desynchronization & GitHub Pages Deployment Pipeline

## 1. Symptoms

1. **Red Banner Error on Bookmarks View**:
   Navigating to `#bookmarks` displays:
   `FAILED TO LOAD BOOKMARKS: Unknown message type: get_episodes_by_ids`
2. **Delayed Deployment Updates on DeeperDhamma.com**:
   After running `python main.py web --deploy`, the live site at `https://deeperdhamma.com/` continues serving an older version stamp (e.g. `1794247613`), masking newly committed UI and synchronization improvements.

---

## 2. Root Cause Analysis

```text
+-------------------------------------------------------------------------------+
| Cause A: GitHub Pages Legacy Jekyll Container Bottleneck                     |
+-------------------------------------------------------------------------------+
| - In the absence of a .nojekyll file in the deployment root (dist/), GitHub   |
|   Pages invokes an automated jekyll-build-pages container.                    |
| - Jekyll encounters SQLite binary assets (dhamma_web.db, 17MB) and files      |
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

## 3. Architectural Solutions

### 3.1 Automated `.nojekyll` Bypass
`export_static_site()` and `deploy_to_github_pages()` in `deeper_dhamma/export_web.py` ensure a `.nojekyll` file exists in `dist/` and `static/`. GitHub Pages completely skips the Jekyll build container and deploys static assets directly to Fastly CDN in under 15 seconds.

### 3.2 Graceful Fallback for Batch Talk Lookups
In both `adapters/wasm_client.js` and `db_client.js`, `getEpisodesByIds()` catches `Unknown message type` and falls back gracefully to individual `getEpisode(id)` lookups:

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

### 3.3 Forced HTTP Cache Bypass in Service Worker
`svc_worker.js` passes `{ cache: 'reload' }` during installation:

```javascript
for (const asset of CORE_ASSETS) {
  try {
    const res = await fetch(asset, { cache: 'reload' });
    if (res && res.status === 200) {
      await cache.put(asset, res.clone());
...
```

### 3.4 Versioned Service Worker Registration
`app.js` registers `./svc_worker.js?v=${encodeURIComponent(window.__DEEPER_DHAMMA_VERSION__)}` and invokes `reg.update()`, triggering immediate browser detection of new service worker scripts.

---

## 4. Verification

Run the automated test suite verifying `.nojekyll` presence, reload caching, and worker message fallback:

```powershell
pytest tests/test_export_web.py -k "test_bookmark_feature_and_view_integrity or test_service_worker"
```

