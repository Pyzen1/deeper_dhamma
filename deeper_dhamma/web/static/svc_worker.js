/**
 * Deeper Dhamma — Self-Referential Offline Service Worker
 * 
 * Provides 100% offline resilience across page refreshes (F5 / reload) even when
 * the local server process is shut down.
 * 
 * Architecture:
 * - Pre-caches core application shell (index.html, styles, scripts, SQLite WASM, icons).
 * - Cache-First for navigation and static assets with ignoreSearch: true and
 *   pathname normalization (/static/ and relative links).
 * - Live server exception ONLY for version probes (Range: bytes=0-99, /api/) so that
 *   updates reflect live server state while failing gracefully to IndexedDB when offline.
 * - Bypasses cross-origin media streaming (Podbean CDN audio).
 */

'use strict';

const CACHE_NAME = 'deeper_dhamma_shell_{{db_version}}';

const CORE_ASSETS = [
  './',
  './index.html',
  './404.html',
  './manifest.json',
  './style.css',
  './app.js',
  './word_sync.js',
  './db_client.js',
  './db_worker.js',
  './sqlite3.js',
  './sqlite3.wasm',
  './dhamma_web.db',
  './icons/fluent_play.svg',
  './icons/fluent_pause.svg',
  './icons/fluent_play_pause.svg',
  './icons/fluent_stop.svg',
  './icons/fluent_rewind.svg',
  './icons/fluent_fast_forward.svg',
  './icons/fluent_skip_back.svg',
  './icons/fluent_skip_fwd.svg',
  './icons/fluent_speaker_high.svg',
  './icons/fluent_speaker_low.svg',
  './icons/fluent_speaker_mute.svg',
  './icons/fluent_mic.svg'
];

// ============================================================================
// Installation: Pre-cache Application Shell under normalized keys
// ============================================================================

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of CORE_ASSETS) {
        try {
          const res = await fetch(asset);
          if (res && res.status === 200) {
            await cache.put(asset, res.clone());
            const clean = asset.replace(/^\.\//, '/');
            await cache.put(clean, res.clone());
            if (!clean.startsWith('/static/')) {
              await cache.put('/static' + clean, res.clone());
            }
          }
        } catch (err) {
          console.warn('[ServiceWorker] Precache failed for:', asset, err.message);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

// ============================================================================
// Activation: Prune Stale Caches and Claim Clients
// ============================================================================

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] Removing stale cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================================
// Helper: Cache Match with ignoreSearch and path normalization
// ============================================================================

async function matchInCache(req) {
  // 1. Exact match with query params if present
  let match = await caches.match(req);
  if (match) return match;

  // 2. Exact match with ignoreSearch (handles ?v=... query parameters)
  match = await caches.match(req, { ignoreSearch: true });
  if (match) return match;

  const url = new URL(req.url);
  const pathname = url.pathname;

  // 2. Direct pathname match
  match = await caches.match(pathname, { ignoreSearch: true });
  if (match) return match;

  // 3. Match relative ./pathname
  match = await caches.match('.' + pathname, { ignoreSearch: true });
  if (match) return match;

  // 4. Handle /static/ prefix stripping or adding
  if (pathname.startsWith('/static/')) {
    const stripped = pathname.slice(7); // strip '/static'
    match = (await caches.match(stripped, { ignoreSearch: true })) ||
            (await caches.match('.' + stripped, { ignoreSearch: true }));
    if (match) return match;
  } else {
    match = await caches.match('/static' + pathname, { ignoreSearch: true });
    if (match) return match;
  }

  // 5. Match by basename (e.g. "style.css", "app.js", "db_worker.js", "sqlite3.wasm")
  const basename = pathname.split('/').pop();
  if (basename) {
    match = (await caches.match('./' + basename, { ignoreSearch: true })) ||
            (await caches.match('/' + basename, { ignoreSearch: true })) ||
            (await caches.match(basename, { ignoreSearch: true })) ||
            (await caches.match('/static/' + basename, { ignoreSearch: true }));
    if (match) return match;
  }

  return null;
}

// ============================================================================
// Fetch Interception: Self-Referential Cache-First Routing
// ============================================================================

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Cross-Origin Requests (e.g. Podbean CDN audio streams, Google Fonts)
  // Let the browser handle these directly without service worker interference.
  if (url.origin !== self.location.origin) {
    return;
  }

  // 2. Server Version Checks & Probes (EXCEPTIONS to cache)
  // Range probes (bytes=0-99) and API stats explicitly check live server status.
  const isRangeProbe = req.headers.get('Range') === 'bytes=0-99';
  const isServerProbe = isRangeProbe || url.pathname.startsWith('/api/');

  if (isServerProbe) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 300) : null;
    event.respondWith(
      fetch(req, { signal: controller ? controller.signal : undefined })
        .then((res) => {
          if (timeoutId) clearTimeout(timeoutId);
          return res;
        })
        .catch(() => {
          if (timeoutId) clearTimeout(timeoutId);
          // Return 503 when server is down so caller (e.g. db_worker.js)
          // gracefully activates its IndexedDB offline fallback.
          return new Response('Server offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          });
        })
    );
    return;
  }

  // 3. Navigation Requests (User clicks browser Refresh / F5 / deep-link navigation)
  // When online, fetch fresh application shell so page updates immediately on refresh.
  // Fall back to Cache-First offline so the PWA works seamlessly without internet.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        if (navigator.onLine) {
          try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timeoutId = controller ? setTimeout(() => controller.abort(), 1200) : null;
            const fresh = await fetch(req, { signal: controller ? controller.signal : undefined });
            if (timeoutId) clearTimeout(timeoutId);
            if (fresh && fresh.status === 200) {
              const cache = await caches.open(CACHE_NAME);
              await cache.put('./index.html', fresh.clone());
              await cache.put('/', fresh.clone());
              return fresh;
            }
          } catch (_) {}
        }

        const cached =
          (await caches.match('./index.html', { ignoreSearch: true })) ||
          (await caches.match('/index.html', { ignoreSearch: true })) ||
          (await caches.match('/', { ignoreSearch: true })) ||
          (await caches.match('./', { ignoreSearch: true })) ||
          (await caches.match('index.html', { ignoreSearch: true }));

        if (cached) {
          return cached;
        }

        // Cache miss: attempt network fetch and cache result
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('./index.html', fresh.clone());
            await cache.put('/', fresh.clone());
          }
          return fresh;
        } catch (err) {
          return new Response('Offline: Deeper Dhamma cache initializing.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      })()
    );
    return;
  }

  // 4. Static Application Shell Assets (.js, .css, .wasm, .svg, .json, .bin)
  // When online, check for updated version query parameters (?v=...) to prevent stale script/markup skew.
  event.respondWith(
    (async () => {
      const hasVersionQuery = url.search.includes('v=');
      if (hasVersionQuery && navigator.onLine) {
        const exact = await caches.match(req);
        if (!exact) {
          try {
            const fresh = await fetch(req);
            if (fresh && fresh.status === 200) {
              const cache = await caches.open(CACHE_NAME);
              await cache.put(req, fresh.clone());
              return fresh;
            }
          } catch (_) {}
        }
      }

      const cached = await matchInCache(req);
      if (cached) {
        // Revalidate in background if online
        if (navigator.onLine) {
          fetch(req)
            .then(async (fresh) => {
              if (fresh && fresh.status === 200) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(req, fresh);
              }
            })
            .catch(() => {});
        }
        return cached;
      }

      // Not yet in cache: fetch from network and dynamically cache
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        console.warn('[ServiceWorker] Asset unavailable offline:', req.url);
        // Fallback: check basename one last time
        const basename = url.pathname.split('/').pop();
        if (basename) {
          const fallback =
            (await caches.match('./' + basename, { ignoreSearch: true })) ||
            (await caches.match('/' + basename, { ignoreSearch: true })) ||
            (await caches.match(basename, { ignoreSearch: true }));
          if (fallback) return fallback;
        }
        return new Response('Asset unavailable offline', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    })()
  );
});
