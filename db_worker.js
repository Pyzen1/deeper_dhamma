/**
 * Deeper Dhamma — SQLite WASM Database Web Worker
 * Runs all SQLite queries, FTS5 full-text searches, and IndexedDB caching
 * off the main UI thread.
 */

'use strict';

// Load official SQLite WASM engine
importScripts('sqlite3.js');

let sqlite3 = null;
let db = null;
let currentDbVersion = 0;
let activeManifest = null;
let activeManifestUrl = './db_manifest.json';
let isShardedMode = false;
let opfsPool = null;
let opfsInitAttempted = false;

const shardHandles = new Map();
const shardPromises = new Map();
const shardCachedShas = new Map();
let episodesMetaMap = new Map();
let episodesMetaList = [];
let talkSeriesList = [];
let teacherRegistryBySlug = new Map();
let teacherSlugByLowerName = new Map();
let teacherRegistryList = [];

// ============================================================================
// IndexedDB & OPFS Persistence Helpers
// ============================================================================

const IDB_NAME = 'deeper_dhamma_cache';
const IDB_STORE = 'db_snapshots';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(IDB_STORE)) {
        d.createObjectStore(IDB_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getCachedDatabase(key = 'dhamma_web') {
  try {
    const idb = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[DB Worker] IndexedDB read failed:', err);
    return null;
  }
}

async function setCachedDatabase(key, version, buffer, extra = {}) {
  try {
    const idb = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put({
        key,
        version,
        buffer,
        ...extra,
        updatedAt: Date.now(),
      });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[DB Worker] IndexedDB write failed:', err);
    return false;
  }
}

function isGzipBytes(u8) {
  return u8 && u8.byteLength >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
}

function assertValidSqliteHeader(buffer) {
  if (!buffer || buffer.byteLength < 64) {
    throw new Error(`Database buffer invalid or truncated (${buffer ? buffer.byteLength : 0} bytes)`);
  }
  const magic = new Uint8Array(buffer.slice(0, 16));
  const magicStr = String.fromCharCode(...magic);
  if (!magicStr.startsWith('SQLite format 3')) {
    throw new Error('Downloaded payload failed SQLite magic header validation.');
  }
}

async function decodeMaybeGzipBuffer(rawBuffer) {
  const u8 = new Uint8Array(rawBuffer);
  if (!isGzipBytes(u8)) {
    return rawBuffer;
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser does not support DecompressionStream("gzip") required for compressed PWA shards.');
  }
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}

async function fetchAndDecodeDbPayload(url) {
  const sep = url.includes('?') ? '&' : '?';
  const fetchUrl = `${url}${sep}t=${Date.now()}`;
  const res = await fetch(fetchUrl, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch database from ${url} (HTTP ${res.status})`);
  }
  const buf = await res.arrayBuffer();
  return await decodeMaybeGzipBuffer(buf);
}

async function fetchManifestJson(manifestUrl) {
  try {
    const sep = manifestUrl.includes('?') ? '&' : '?';
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 3000) : null;
    const res = await fetch(`${manifestUrl}${sep}t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
    if (timeoutId) clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.format === 'sharded_v1') {
        return data;
      }
    }
  } catch (_) {
    // Offline or server down
  }
  return null;
}

async function tryInitOpfsPool(requiredCapacity = 12) {
  if (opfsPool) {
    if (typeof opfsPool.reserveMinimumCapacity === 'function') {
      try {
        await opfsPool.reserveMinimumCapacity(requiredCapacity);
      } catch (_) {}
    }
    return opfsPool;
  }
  if (opfsInitAttempted) return null;
  opfsInitAttempted = true;
  if (!sqlite3 || typeof sqlite3.installOpfsSAHPoolVfs !== 'function') {
    return null;
  }
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({
      initialCapacity: requiredCapacity,
      directory: '/deeper-dhamma-opfs',
      verbosity: 0,
    });
    if (typeof pool.reserveMinimumCapacity === 'function') {
      await pool.reserveMinimumCapacity(requiredCapacity);
    }
    opfsPool = pool;
    console.log('[DB Worker] OPFS SAHPool VFS enabled for zero-RAM shard storage.');
    return opfsPool;
  } catch (err) {
    console.warn('[DB Worker] OPFS unavailable, using IndexedDB shard cache fallback:', err && err.message ? err.message : err);
    return null;
  }
}

function queryAllOn(targetDb, sql, bind = []) {
  if (!targetDb) throw new Error('Database is not initialized');
  const rows = [];
  targetDb.exec({
    sql,
    bind,
    rowMode: 'object',
    resultRows: rows,
  });
  return rows;
}

function queryOneOn(targetDb, sql, bind = []) {
  const rows = queryAllOn(targetDb, sql, bind);
  return rows.length > 0 ? rows[0] : null;
}

function stripTeacherNote(str) {
  return String(str || '').replace(/\s*\([^)]*\)\s*$/g, '').trim();
}

function getDurationBucket(durMin) {
  if (durMin < 15) return 'under_15';
  if (durMin < 30) return '15_30';
  if (durMin < 60) return '30_60';
  if (durMin < 90) return '60_90';
  return 'over_90';
}

function classifyEpisodeCategories(rawTitle, normTitle, realMonasticCount) {
  const cats = new Set();
  const t = normTitle || foldDiacritics(rawTitle || '');
  // Nikaya / Sutta Collections (letter-boundary before code, followed by digit/colon/dot/hyphen/space/end)
  if (/(?:^|[^a-z])mn(?=\s*\d|[:.\-\s]|$)/.test(t)) cats.add('mn');
  if (/(?:^|[^a-z])dn(?=\s*\d|[:.\-\s]|$)/.test(t)) cats.add('dn');
  if (/(?:^|[^a-z])sn(?=\s*\d|[:.\-\s]|$)/.test(t)) cats.add('sn');
  if (/(?:^|[^a-z])an(?=\s*\d|[:.\-\s]|$)/.test(t)) cats.add('an');
  if (/(?:^|[^a-z])(?:ud|iti|dhp|snp|thag|thig|kp)(?=\s*\d|[:.\-\s]|$)/.test(t)) cats.add('kn');
  if (/\bsuttas?\b/.test(t) || cats.has('mn') || cats.has('dn') || cats.has('sn') || cats.has('an') || cats.has('kn')) {
    cats.add('sutta');
  }
  const isRetreat = /\bretreat\b/.test(t);
  const isWorkshop = /\bworkshop\b|\bcourse\b/.test(t);
  if (isRetreat) cats.add('retreat');
  if (!isRetreat) cats.add('non_retreat');
  if (/\brains\s+retreat\b/.test(t)) cats.add('rains_retreat');
  if (/\b(?:9|nine)\s*[-]?\s*day\b/.test(t)) cats.add('nine_day_retreat');
  if (/\bweekend\b/.test(t)) cats.add('weekend_retreat');
  if (/q\s*&\s*a|\bq\s+and\s+a\b|\bquestions?\b/.test(t)) cats.add('qa');
  if (/\bmeditation\b|\bguided\b/.test(t)) cats.add('meditation');
  if (isWorkshop) cats.add('workshop');
  if (realMonasticCount >= 2) cats.add('co_taught');
  return cats;
}

function resolveTeacherToSlug(val) {
  const cleaned = stripTeacherNote(val);
  if (!cleaned) return '';
  if (teacherRegistryBySlug.has(cleaned)) return cleaned;
  const lower = cleaned.toLowerCase();
  if (teacherSlugByLowerName.has(lower)) return teacherSlugByLowerName.get(lower);
  const slugGuess = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (teacherRegistryBySlug.has(slugGuess)) return slugGuess;
  return lower;
}

function rebuildEpisodesMetaCache() {
  const nextMap = new Map();
  const nextList = [];
  const nextTeacherBySlug = new Map();
  const nextSlugByLowerName = new Map();
  let nextTeacherList = [];

  if (!db) {
    episodesMetaMap = nextMap;
    episodesMetaList = nextList;
    teacherRegistryBySlug = nextTeacherBySlug;
    teacherSlugByLowerName = nextSlugByLowerName;
    teacherRegistryList = nextTeacherList;
    return;
  }

  try {
    nextTeacherList = queryAllOn(
      db,
      `SELECT slug, display_name, color, default_role
       FROM teachers
       ORDER BY display_name;`
    );
    for (let i = 0; i < nextTeacherList.length; i++) {
      const t = nextTeacherList[i];
      nextTeacherBySlug.set(t.slug, t);
      if (t.display_name) {
        nextSlugByLowerName.set(t.display_name.toLowerCase(), t.slug);
      }
    }
  } catch (_) {}

  const etMap = new Map();
  try {
    const etRows = queryAllOn(
      db,
      `SELECT et.episode_id, t.slug
       FROM episode_teachers et
       JOIN teachers t ON et.teacher_id = t.id;`
    );
    for (let i = 0; i < etRows.length; i++) {
      const { episode_id, slug } = etRows[i];
      if (!etMap.has(episode_id)) etMap.set(episode_id, new Set());
      etMap.get(episode_id).add(slug);
    }
  } catch (_) {}

  let nextSeriesList = [];
  const epSeriesMap = new Map();
  try {
    nextSeriesList = queryAllOn(
      db,
      `SELECT ts.id, ts.slug, ts.title, ts.year, ts.teacher_slug, ts.expected_parts, ts.is_retreat,
              COUNT(se.episode_id) AS available_parts,
              SUM(CASE WHEN e.is_transcribed = 1 THEN 1 ELSE 0 END) AS transcribed_parts
       FROM talk_series ts
       LEFT JOIN series_episodes se ON se.series_id = ts.id
       LEFT JOIN episodes e ON e.id = se.episode_id
       GROUP BY ts.id
       HAVING available_parts > 0
       ORDER BY ts.year DESC, ts.title ASC;`
    );
    const seRows = queryAllOn(
      db,
      `SELECT se.episode_id, ts.slug AS series_slug, se.part_number, se.talk_date
       FROM series_episodes se
       JOIN talk_series ts ON ts.id = se.series_id;`
    );
    for (let i = 0; i < seRows.length; i++) {
      const r = seRows[i];
      if (!epSeriesMap.has(r.episode_id)) {
        epSeriesMap.set(r.episode_id, { slugs: new Set(), partNumber: r.part_number || 0, talkDate: r.talk_date || '' });
      }
      epSeriesMap.get(r.episode_id).slugs.add(r.series_slug);
    }
  } catch (_) {}

  let rows = [];
  try {
    rows = queryAllOn(
      db,
      `SELECT id, title, date, year, primary_teacher, primary_display, identified_teachers,
              media_url, permalink, duration_sec, is_transcribed, talks_shard, words_shard
       FROM episodes;`
    );
  } catch (_) {
    // Legacy monolithic DB lacks talks_shard / words_shard columns
    try {
      rows = queryAllOn(
        db,
        `SELECT id, title, date, year, primary_teacher, primary_display, identified_teachers,
                media_url, permalink, duration_sec, is_transcribed
         FROM episodes;`
      );
    } catch (_) {}
  }

  for (let i = 0; i < rows.length; i++) {
    const ep = rows[i];
    const teacherSlugs = new Set(etMap.get(ep.id) || []);
    const teacherLowerNames = new Set();

    if (ep.primary_teacher && nextTeacherBySlug.has(ep.primary_teacher)) {
      teacherSlugs.add(ep.primary_teacher);
    }

    const addTeacherNameToken = (rawToken) => {
      const cleaned = stripTeacherNote(rawToken);
      if (!cleaned) return;
      const lower = cleaned.toLowerCase();
      teacherLowerNames.add(lower);
      const matchedSlug = nextSlugByLowerName.get(lower);
      if (matchedSlug) {
        teacherSlugs.add(matchedSlug);
      }
    };

    if (ep.identified_teachers) {
      const parts = String(ep.identified_teachers).split(/\s*,\s*/);
      for (let j = 0; j < parts.length; j++) {
        addTeacherNameToken(parts[j]);
      }
    }
    if (ep.primary_display) {
      const parts = String(ep.primary_display).split(/\s*(?:&|,|\/|\band\b)\s*/i);
      for (let j = 0; j < parts.length; j++) {
        addTeacherNameToken(parts[j]);
      }
    }

    const realMonasticSlugs = [];
    for (const slug of teacherSlugs) {
      const reg = nextTeacherBySlug.get(slug);
      if (
        slug !== 'unknown_teacher' &&
        slug !== 'unregistered_speaker' &&
        slug !== 'questioner' &&
        (!reg || (reg.default_role !== 'unregistered' && reg.default_role !== 'lay_questioner'))
      ) {
        realMonasticSlugs.push(slug);
      }
    }

    if (realMonasticSlugs.length > 0) {
      teacherSlugs.delete('unknown_teacher');
      teacherLowerNames.delete('unknown teacher');
    }

    for (const slug of teacherSlugs) {
      const reg = nextTeacherBySlug.get(slug);
      if (reg && reg.display_name) {
        teacherLowerNames.add(reg.display_name.toLowerCase());
      }
    }

    const normTitle = foldDiacritics(ep.title || '');
    const durSec = Number(ep.duration_sec) || 0;
    const durMin = Math.round(durSec / 60);
    const epYear = ep.year
      ? Number(ep.year)
      : (ep.date && /^\d{4}/.test(ep.date) ? Number(ep.date.slice(0, 4)) : 0);

    ep._teacherSlugs = teacherSlugs;
    ep._teacherLowerNames = teacherLowerNames;
    ep._realMonasticCount = realMonasticSlugs.length;
    ep.teacher_slugs = Array.from(teacherSlugs);
    ep._normTitle = normTitle;
    ep._durSec = durSec;
    ep._durMin = durMin;
    ep._year = epYear;
    ep._durBucket = getDurationBucket(durMin);
    ep._categories = classifyEpisodeCategories(ep.title || '', normTitle, realMonasticSlugs.length);
    const serMeta = epSeriesMap.get(ep.id);
    ep._seriesSlugs = serMeta ? serMeta.slugs : new Set();
    ep._seriesPartNumber = serMeta ? serMeta.partNumber : 0;
    ep._seriesTalkDate = serMeta ? serMeta.talkDate : '';

    nextMap.set(ep.id, ep);
    nextList.push(ep);
  }

  episodesMetaMap = nextMap;
  episodesMetaList = nextList;
  talkSeriesList = nextSeriesList;
  teacherRegistryBySlug = nextTeacherBySlug;
  teacherSlugByLowerName = nextSlugByLowerName;
  teacherRegistryList = nextTeacherList;
  searchCache = null;
}

// ============================================================================
// Database Initialization, Shards & Deserialization
// ============================================================================

async function fetchRemoteVersion(dbUrl) {
  try {
    const url = dbUrl + (dbUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 400) : null;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-99' },
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
    if (timeoutId) clearTimeout(timeoutId);
    let totalBytes = 0;
    const cr = res.headers && res.headers.get('Content-Range');
    if (cr && cr.includes('/')) {
      totalBytes = parseInt(cr.split('/')[1], 10) || 0;
    } else if (res.headers && res.headers.get('Content-Length')) {
      totalBytes = parseInt(res.headers.get('Content-Length'), 10) || 0;
    }
    if (res.status === 206 || res.status === 200) {
      const headerBuf = await res.arrayBuffer();
      if (headerBuf.byteLength >= 64) {
        const view = new DataView(headerBuf);
        const version = view.getUint32(60, false); // big-endian
        return { version, totalBytes, fullBuffer: res.status === 200 ? headerBuf : null };
      }
    }
  } catch (err) {
    // Expected when offline or local server stopped
  }
  return { version: 0, totalBytes: 0, fullBuffer: null };
}

let isUpdatingInBackground = false;

function deserializeDbHandle(buffer, sanitySql = 'SELECT COUNT(*) FROM episodes;') {
  assertValidSqliteHeader(buffer);
  const uint8Array = new Uint8Array(buffer);
  const pBuffer = sqlite3.wasm.allocFromTypedArray(uint8Array);
  const candidateDb = new sqlite3.oo1.DB();
  const rc = sqlite3.capi.sqlite3_deserialize(
    candidateDb.pointer,
    'main',
    pBuffer,
    uint8Array.byteLength,
    uint8Array.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  );

  if (rc !== 0) {
    try { candidateDb.close(); } catch (_) {}
    throw new Error(`sqlite3_deserialize failed with code ${rc}`);
  }

  try {
    candidateDb.exec({ sql: sanitySql, rowMode: 'array' });
  } catch (queryErr) {
    try { candidateDb.close(); } catch (_) {}
    throw queryErr;
  }
  return { handle: candidateDb, byteLength: uint8Array.byteLength };
}

function deserializeAndAttachDb(buffer, version) {
  const { handle: newDb, byteLength } = deserializeDbHandle(buffer, 'SELECT COUNT(*) FROM episodes;');
  const oldDb = db;
  db = newDb;
  if (oldDb) {
    try { oldDb.close(); } catch (e) { console.warn('[DB Worker] Error closing previous DB:', e); }
  }

  currentDbVersion = version;
  vocabCacheInitialized = false;
  rebuildEpisodesMetaCache();
  setTimeout(ensureVocabCache, 50);
  return byteLength;
}

function closeShardHandle(shardId) {
  const existing = shardHandles.get(shardId);
  if (existing) {
    try { existing.close(); } catch (_) {}
    shardHandles.delete(shardId);
  }
}

function evictWordsHandlesForIdbFallback(keepShardId) {
  if (opfsPool) return;
  for (const [sid] of shardHandles) {
    if (sid.startsWith('words_') && sid !== keepShardId) {
      closeShardHandle(sid);
    }
  }
}

function getAllManifestShards(manifest) {
  if (!manifest) return [];
  return [...(manifest.talks || []), ...(manifest.words || [])];
}

function findManifestShard(shardId) {
  if (!activeManifest) return null;
  const all = getAllManifestShards(activeManifest);
  return all.find((s) => s.id === shardId) || null;
}

function emitSyncProgress(manifest, phase = 'syncing', currentShard = null) {
  if (!manifest) return;
  const all = getAllManifestShards(manifest);
  const talksTotal = (manifest.talks || []).length;
  const talksReady = (manifest.talks || []).filter((s) => shardCachedShas.get(s.id) === s.sha256).length;
  const wordsTotal = (manifest.words || []).length;
  const wordsReady = (manifest.words || []).filter((s) => shardCachedShas.get(s.id) === s.sha256).length;
  const loadedGzBytes = all.reduce(
    (sum, s) => sum + (shardCachedShas.get(s.id) === s.sha256 ? (s.gz_bytes || 0) : 0),
    manifest.core ? (manifest.core.gz_bytes || 0) : 0
  );
  const totalGzBytes = manifest.total_gz_bytes || all.reduce((sum, s) => sum + (s.gz_bytes || 0), 0);

  self.postMessage({
    type: 'db_sync_progress',
    data: {
      phase,
      currentShard,
      talksReady,
      talksTotal,
      wordsReady,
      wordsTotal,
      loadedBytes: loadedGzBytes,
      totalBytes: totalGzBytes,
      textSearchReady: talksTotal > 0 && talksReady === talksTotal,
      fullOfflineReady: talksReady === talksTotal && wordsReady === wordsTotal,
    },
  });
}

async function mountShardFromLocalCache(shardMeta) {
  const sanitySql = shardMeta.id.startsWith('talks_')
    ? 'SELECT COUNT(*) FROM speech_segments;'
    : 'SELECT COUNT(*) FROM episode_words;';

  // 1. Check OPFS pool first
  if (opfsPool) {
    const opfsPath = '/' + shardMeta.id + '.db';
    const metaRec = await getCachedDatabase('shard_meta_' + shardMeta.id);
    const hasFile = typeof opfsPool.getFileNames === 'function' && opfsPool.getFileNames().includes(opfsPath);
    if (hasFile && metaRec && (!shardMeta.sha256 || metaRec.sha256 === shardMeta.sha256)) {
      try {
        closeShardHandle(shardMeta.id);
        const sDb = new opfsPool.OpfsSAHPoolDb(opfsPath);
        try {
          sDb.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096;');
        } catch (_) {}
        sDb.exec({ sql: sanitySql, rowMode: 'array' });
        shardHandles.set(shardMeta.id, sDb);
        shardCachedShas.set(shardMeta.id, metaRec.sha256 || shardMeta.sha256);
        return true;
      } catch (err) {
        console.warn(`[DB Worker] OPFS mount failed for ${shardMeta.id}, trying IDB/network:`, err);
      }
    }
  }

  // 2. IndexedDB buffer fallback
  const cached = await getCachedDatabase('shard_' + shardMeta.id);
  if (cached && cached.buffer && cached.buffer.byteLength >= 64) {
    if (!shardMeta.sha256 || cached.sha256 === shardMeta.sha256) {
      evictWordsHandlesForIdbFallback(shardMeta.id);
      const { handle } = deserializeDbHandle(cached.buffer, sanitySql);
      closeShardHandle(shardMeta.id);
      shardHandles.set(shardMeta.id, handle);
      shardCachedShas.set(shardMeta.id, cached.sha256 || shardMeta.sha256);
      return true;
    }
  }
  return false;
}

async function installShardFromBuffer(shardMeta, rawBuffer) {
  const sanitySql = shardMeta.id.startsWith('talks_')
    ? 'SELECT COUNT(*) FROM speech_segments;'
    : 'SELECT COUNT(*) FROM episode_words;';

  // Validate SQLite integrity before mutating local persistent storage
  const { handle: validatedHandle } = deserializeDbHandle(rawBuffer, sanitySql);

  if (opfsPool) {
    try { validatedHandle.close(); } catch (_) {}
    closeShardHandle(shardMeta.id);
    const opfsPath = '/' + shardMeta.id + '.db';
    opfsPool.importDb(opfsPath, new Uint8Array(rawBuffer));
    await setCachedDatabase('shard_meta_' + shardMeta.id, activeManifest.version, null, {
      sha256: shardMeta.sha256,
      raw_bytes: rawBuffer.byteLength,
    });
    const sDb = new opfsPool.OpfsSAHPoolDb(opfsPath);
    try {
      sDb.exec('PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096;');
    } catch (_) {}
    sDb.exec({ sql: sanitySql, rowMode: 'array' });
    shardHandles.set(shardMeta.id, sDb);
    shardCachedShas.set(shardMeta.id, shardMeta.sha256);
    return;
  }

  evictWordsHandlesForIdbFallback(shardMeta.id);
  closeShardHandle(shardMeta.id);
  shardHandles.set(shardMeta.id, validatedHandle);
  shardCachedShas.set(shardMeta.id, shardMeta.sha256);
  await setCachedDatabase('shard_' + shardMeta.id, activeManifest.version, rawBuffer, {
    sha256: shardMeta.sha256,
  });
}

async function ensureShardReady(shardId) {
  if (!isShardedMode || !activeManifest) return null;
  const shardMeta = findManifestShard(shardId);
  if (!shardMeta) return null;

  if (shardHandles.has(shardId) && shardCachedShas.get(shardId) === shardMeta.sha256) {
    return shardHandles.get(shardId);
  }
  if (shardPromises.has(shardId)) {
    return await shardPromises.get(shardId);
  }

  const workPromise = (async () => {
    const mountedLocal = await mountShardFromLocalCache(shardMeta);
    if (mountedLocal) {
      emitSyncProgress(activeManifest, 'cached', shardId);
      return shardHandles.get(shardId);
    }

    const baseDir = activeManifestUrl.includes('/')
      ? activeManifestUrl.slice(0, activeManifestUrl.lastIndexOf('/') + 1)
      : './';
    const rawBuffer = await fetchAndDecodeDbPayload(`${baseDir}${shardMeta.file}`);
    await installShardFromBuffer(shardMeta, rawBuffer);
    emitSyncProgress(activeManifest, 'syncing', shardId);
    return shardHandles.get(shardId);
  })();

  shardPromises.set(shardId, workPromise);
  try {
    return await workPromise;
  } finally {
    shardPromises.delete(shardId);
  }
}

async function ensureAllTalksShardsReady() {
  if (!isShardedMode || !activeManifest) return [];
  const talks = activeManifest.talks || [];
  const handles = [];
  for (let i = 0; i < talks.length; i++) {
    const h = await ensureShardReady(talks[i].id);
    if (h) handles.push(h);
  }
  return handles;
}

async function syncRemainingShardsInBackground(manifest) {
  const talks = manifest.talks || [];
  const words = manifest.words || [];
  emitSyncProgress(manifest, 'syncing', null);

  for (let i = 0; i < talks.length; i++) {
    try {
      await ensureShardReady(talks[i].id);
    } catch (err) {
      console.warn(`[DB Worker] Background sync skipped ${talks[i].id}:`, err);
    }
  }
  for (let i = 0; i < words.length; i++) {
    try {
      await ensureShardReady(words[i].id);
    } catch (err) {
      console.warn(`[DB Worker] Background sync skipped ${words[i].id}:`, err);
    }
  }
  emitSyncProgress(manifest, 'complete', null);
}

async function checkAndUpdateInBackground(targetUrl, activeCachedCore, cachedManifestRecord) {
  if (isUpdatingInBackground) return;
  isUpdatingInBackground = true;

  try {
    // 1. Check sharded manifest first
    if (isShardedMode || (targetUrl && targetUrl.endsWith('db_manifest.json'))) {
      const manifestUrl = (targetUrl && targetUrl.endsWith('db_manifest.json')) ? targetUrl : activeManifestUrl;
      const remoteManifest = await fetchManifestJson(manifestUrl);
      if (!remoteManifest) {
        if (activeManifest) {
          await syncRemainingShardsInBackground(activeManifest);
        }
        return;
      }

      await tryInitOpfsPool(2 + (remoteManifest.talks || []).length + (remoteManifest.words || []).length);
      const oldSha = cachedManifestRecord && cachedManifestRecord.manifest && cachedManifestRecord.manifest.core
        ? cachedManifestRecord.manifest.core.sha256
        : null;
      const coreChanged = !oldSha || oldSha !== remoteManifest.core.sha256 || remoteManifest.version !== activeCachedCore.version;

      let coreBytes = activeCachedCore.buffer.byteLength;
      if (coreChanged) {
        const baseDir = manifestUrl.includes('/') ? manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1) : './';
        const newBuffer = await fetchAndDecodeDbPayload(`${baseDir}${remoteManifest.core.file}`);
        assertValidSqliteHeader(newBuffer);
        const view = new DataView(newBuffer);
        const newVersion = view.getUint32(60, false) || remoteManifest.version;
        const { handle: candidateDb, byteLength } = deserializeDbHandle(newBuffer, 'SELECT COUNT(*) FROM episodes;');
        coreBytes = byteLength;

        await setCachedDatabase('dhamma_web', newVersion, newBuffer);
        const oldDb = db;
        db = candidateDb;
        if (oldDb) {
          try { oldDb.close(); } catch (_) {}
        }
        currentDbVersion = newVersion;
        vocabCacheInitialized = false;
        rebuildEpisodesMetaCache();
        setTimeout(ensureVocabCache, 50);
      }

      isShardedMode = true;
      activeManifest = remoteManifest;
      await setCachedDatabase('sharded_manifest', remoteManifest.version, null, { manifest: remoteManifest });
      await syncRemainingShardsInBackground(remoteManifest);

      if (coreChanged) {
        self.postMessage({
          type: 'db_hot_swapped',
          data: { version: currentDbVersion, size: coreBytes },
        });
      }
      return;
    }

    // Legacy monolithic fallback check
    const dbUrl = targetUrl || './dhamma_web.db';
    const { version: remoteVersion, totalBytes: remoteTotalBytes, fullBuffer: probeBuffer } = await fetchRemoteVersion(dbUrl);
    if (!remoteVersion || remoteVersion === 0) return;

    const isVersionDifferent = remoteVersion !== activeCachedCore.version;
    const isSizeDifferent = remoteTotalBytes > 0 && Math.abs(activeCachedCore.buffer.byteLength - remoteTotalBytes) > 1024;
    if (!isVersionDifferent && !isSizeDifferent) return;

    let newBuffer = null;
    if (probeBuffer && probeBuffer.byteLength > 100000) {
      newBuffer = probeBuffer;
    } else {
      newBuffer = await fetchAndDecodeDbPayload(dbUrl);
    }
    assertValidSqliteHeader(newBuffer);
    const view = new DataView(newBuffer);
    const newVersion = view.getUint32(60, false) || remoteVersion;

    const uint8Array = new Uint8Array(newBuffer);
    const pTest = sqlite3.wasm.allocFromTypedArray(uint8Array);
    const candidateDb = new sqlite3.oo1.DB();
    const testRc = sqlite3.capi.sqlite3_deserialize(
      candidateDb.pointer,
      'main',
      pTest,
      uint8Array.byteLength,
      uint8Array.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );
    if (testRc !== 0) {
      try { candidateDb.close(); } catch (_) {}
      return;
    }
    try {
      candidateDb.exec({ sql: 'SELECT COUNT(*) FROM episodes;', rowMode: 'array' });
    } catch (_) {
      try { candidateDb.close(); } catch (_) {}
      return;
    }

    await setCachedDatabase('dhamma_web', newVersion, newBuffer);
    const oldDb = db;
    db = candidateDb;
    if (oldDb) {
      try { oldDb.close(); } catch (_) {}
    }
    currentDbVersion = newVersion;
    vocabCacheInitialized = false;
    rebuildEpisodesMetaCache();
    setTimeout(ensureVocabCache, 50);

    self.postMessage({
      type: 'db_hot_swapped',
      data: { version: newVersion, size: uint8Array.byteLength },
    });
  } catch (err) {
    console.warn('[DB Worker] Background update encountered unexpected error. Retaining active cached DB:', err);
  } finally {
    isUpdatingInBackground = false;
  }
}

async function initDatabase(initArg = { manifestUrl: './db_manifest.json' }) {
  if (!sqlite3) {
    sqlite3 = await sqlite3InitModule({
      print: (text) => console.log('[SQLite]', text),
      printErr: (err) => console.error('[SQLite Error]', err),
    });
  }

  let manifestUrl = './db_manifest.json';
  let legacyDbUrl = './dhamma_web.db';
  if (typeof initArg === 'string') {
    if (initArg.endsWith('.json')) manifestUrl = initArg;
    else legacyDbUrl = initArg;
  } else if (initArg) {
    if (initArg.manifestUrl) manifestUrl = initArg.manifestUrl;
    if (initArg.dbUrl) legacyDbUrl = initArg.dbUrl;
  }
  activeManifestUrl = manifestUrl;

  const [cached, cachedManifest] = await Promise.all([
    getCachedDatabase('dhamma_web'),
    getCachedDatabase('sharded_manifest'),
  ]);
  const hasValidCache = cached && cached.buffer && cached.buffer.byteLength >= 64;

  if (hasValidCache) {
    try {
      const bytesMounted = deserializeAndAttachDb(cached.buffer, cached.version || 0);
      if (cachedManifest && cachedManifest.manifest && cachedManifest.manifest.format === 'sharded_v1') {
        isShardedMode = true;
        activeManifest = cachedManifest.manifest;
        await tryInitOpfsPool(2 + (activeManifest.talks || []).length + (activeManifest.words || []).length);
        // Mount already-cached local shards immediately so offline reads/search hit 0ms
        const allShards = getAllManifestShards(activeManifest);
        for (let i = 0; i < allShards.length; i++) {
          await mountShardFromLocalCache(allShards[i]).catch(() => {});
        }
        emitSyncProgress(activeManifest, 'cached', null);
      }

      setTimeout(() => {
        checkAndUpdateInBackground(
          isShardedMode || !legacyDbUrl ? manifestUrl : manifestUrl,
          cached,
          cachedManifest
        ).catch((err) => {
          console.warn('[DB Worker] Background update check failed gracefully:', err);
        });
      }, 100);

      return { version: currentDbVersion, cached: true, size: bytesMounted, sharded: isShardedMode };
    } catch (cacheErr) {
      console.warn('[DB Worker] Cached database corrupted, falling back to download:', cacheErr);
    }
  }

  // First-time cold load: prefer sharded manifest bundle
  const remoteManifest = await fetchManifestJson(manifestUrl);
  if (remoteManifest && remoteManifest.format === 'sharded_v1') {
    isShardedMode = true;
    activeManifest = remoteManifest;
    await tryInitOpfsPool(2 + (remoteManifest.talks || []).length + (remoteManifest.words || []).length);

    const baseDir = manifestUrl.includes('/') ? manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1) : './';
    const coreBuffer = await fetchAndDecodeDbPayload(`${baseDir}${remoteManifest.core.file}`);
    assertValidSqliteHeader(coreBuffer);

    const view = new DataView(coreBuffer);
    const versionToStore = view.getUint32(60, false) || remoteManifest.version || 1;
    const bytesMounted = deserializeAndAttachDb(coreBuffer, versionToStore);
    await setCachedDatabase('dhamma_web', versionToStore, coreBuffer);
    await setCachedDatabase('sharded_manifest', versionToStore, null, { manifest: remoteManifest });

    // Trigger non-blocking offline download of talks_1..4 then words_1..4
    setTimeout(() => {
      syncRemainingShardsInBackground(remoteManifest).catch((err) => {
        console.warn('[DB Worker] Initial offline shard sync error:', err);
      });
    }, 25);

    return { version: versionToStore, cached: false, size: bytesMounted, sharded: true };
  }

  // Fallback legacy monolithic load
  isShardedMode = false;
  const { version: remoteVersion, fullBuffer: probeBuffer } = await fetchRemoteVersion(legacyDbUrl);
  let dbBuffer = null;
  if (probeBuffer && probeBuffer.byteLength > 100000) {
    dbBuffer = probeBuffer;
  } else {
    dbBuffer = await fetchAndDecodeDbPayload(legacyDbUrl);
  }
  assertValidSqliteHeader(dbBuffer);

  const view = new DataView(dbBuffer);
  const bufferVersion = view.getUint32(60, false);
  const versionToStore = remoteVersion || bufferVersion || 1;

  const bytesMounted = deserializeAndAttachDb(dbBuffer, versionToStore);
  await setCachedDatabase('dhamma_web', versionToStore, dbBuffer);
  return { version: versionToStore, cached: false, size: bytesMounted, sharded: false };
}

// ============================================================================
// Query Execution Helpers
// ============================================================================

function queryAll(sql, bind = []) {
  return queryAllOn(db, sql, bind);
}

function queryOne(sql, bind = []) {
  return queryOneOn(db, sql, bind);
}

// ============================================================================
// Service Handlers
// ============================================================================

function tokenMatchesTitle(normTitle, tokenText, wholeWord) {
  if (!wholeWord) {
    return normTitle.includes(tokenText);
  }
  const firstCh = tokenText[0];
  const lastCh = tokenText[tokenText.length - 1];
  const startBound = /[a-z]/.test(firstCh)
    ? '(?:^|[^a-z])'
    : (/[0-9]/.test(firstCh) ? '(?:^|[^0-9])' : '');
  const endBound = /[a-z]/.test(lastCh)
    ? '(?=$|[^a-z])'
    : (/[0-9]/.test(lastCh) ? '(?=$|[^0-9])' : '');
  const rx = new RegExp(`${startBound}${escapeRegExp(tokenText)}${endBound}`);
  return rx.test(normTitle);
}

function matchesTitleQuery(normTitle, titleQuery, wholeWord = false) {
  const raw = String(titleQuery || '').trim();
  if (!raw) return true;
  const branches = raw.split(/\s+OR\s+/);
  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b].trim();
    if (!branch) continue;
    const rawTokens = branch.match(/-?"[^"]+"|\S+/g) || [];
    if (rawTokens.length === 0) continue;
    let branchOk = true;
    for (let i = 0; i < rawTokens.length; i++) {
      let tok = rawTokens[i];
      let isNeg = false;
      if (tok.startsWith('-') && tok.length > 1) {
        isNeg = true;
        tok = tok.slice(1);
      }
      if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) {
        tok = tok.slice(1, -1);
      }
      const needle = foldDiacritics(tok).trim();
      if (!needle) continue;
      const hit = tokenMatchesTitle(normTitle, needle, wholeWord);
      if (isNeg ? hit : !hit) {
        branchOk = false;
        break;
      }
    }
    if (branchOk) return true;
  }
  return false;
}

function formatEpisodeRowForClient(ep) {
  return {
    id: ep.id,
    title: ep.title,
    date: ep.date,
    year: ep.year,
    primary_teacher: ep.primary_teacher,
    teacher: ep.primary_display,
    primary_display: ep.primary_display,
    identified_teachers: ep.identified_teachers,
    teacher_slugs: ep.teacher_slugs || [],
    media_url: ep.media_url,
    permalink: ep.permalink,
    duration_sec: ep.duration_sec,
    is_transcribed: ep.is_transcribed,
  };
}

function handleGetStats() {
  if (db && episodesMetaList.length === 0) {
    rebuildEpisodesMetaCache();
  }
  const totalEp = queryOne('SELECT COUNT(*) AS c FROM episodes;');
  const transEp = queryOne('SELECT COUNT(*) AS c FROM episodes WHERE is_transcribed = 1;');
  let segsCount = 0;
  if (isShardedMode && activeManifest) {
    segsCount = activeManifest.segments || 0;
  } else {
    try {
      const segs = queryOne('SELECT COUNT(*) AS c FROM speech_segments;');
      segsCount = segs ? segs.c : 0;
    } catch (_) {
      segsCount = 0;
    }
  }
  const dur = queryOne('SELECT SUM(duration_sec) AS s FROM episodes WHERE is_transcribed = 1;');

  const teachersList = teacherRegistryList.length > 0
    ? teacherRegistryList
    : queryAll(`SELECT slug, display_name, color, default_role FROM teachers ORDER BY display_name;`);

  const teacherMap = {};
  const teacherCounts = {};
  const yearCounts = {};
  const durationCounts = { under_15: 0, m15_30: 0, m30_60: 0, m60_90: 0, over_90: 0 };
  const categoryCounts = {
    mn: 0, dn: 0, sn: 0, an: 0, kn: 0, sutta: 0,
    retreat: 0, rains_retreat: 0, nine_day_retreat: 0, weekend_retreat: 0,
    non_retreat: 0, qa: 0, meditation: 0, workshop: 0, co_taught: 0,
  };

  teachersList.forEach((t) => {
    teacherMap[t.slug] = {
      name: t.display_name,
      color: t.color || '#f59e0b',
      role: t.default_role
    };
    teacherCounts[t.slug] = 0;
  });

  for (let i = 0; i < episodesMetaList.length; i++) {
    const ep = episodesMetaList[i];
    if (!ep.is_transcribed) continue;
    for (const slug of ep._teacherSlugs) {
      teacherCounts[slug] = (teacherCounts[slug] || 0) + 1;
    }
    if (ep._year > 0) {
      yearCounts[ep._year] = (yearCounts[ep._year] || 0) + 1;
    }
    if (ep._durBucket === 'under_15') durationCounts.under_15++;
    else if (ep._durBucket === '15_30') durationCounts.m15_30++;
    else if (ep._durBucket === '30_60') durationCounts.m30_60++;
    else if (ep._durBucket === '60_90') durationCounts.m60_90++;
    else durationCounts.over_90++;

    for (const cat of ep._categories) {
      if (cat in categoryCounts) categoryCounts[cat]++;
    }
  }

  const browseTeachers = teachersList
    .filter((r) => r.default_role !== 'unregistered' && r.default_role !== 'lay_questioner' && (teacherCounts[r.slug] || 0) > 0)
    .map((r) => ({
      slug: r.slug,
      name: r.display_name,
      color: r.color || '#f59e0b',
      role: r.default_role,
      count: teacherCounts[r.slug] || 0,
    }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

  if ((teacherCounts.unknown_teacher || 0) > 0 && teacherMap.unknown_teacher) {
    browseTeachers.push({
      slug: 'unknown_teacher',
      name: teacherMap.unknown_teacher.name,
      color: teacherMap.unknown_teacher.color || '#94a3b8',
      role: 'unregistered',
      count: teacherCounts.unknown_teacher,
    });
  }

  const years = queryAll(`
    SELECT DISTINCT year 
    FROM episodes 
    WHERE is_transcribed = 1 AND year IS NOT NULL AND year > 0
    ORDER BY year DESC;
  `).map((r) => r.year);

  const allYears = queryAll(`
    SELECT DISTINCT year 
    FROM episodes 
    WHERE year IS NOT NULL AND year > 0
    ORDER BY year DESC;
  `).map((r) => r.year);

  return {
    total_episodes: totalEp ? totalEp.c : 0,
    transcribed_episodes: transEp ? transEp.c : 0,
    transcribed_hours: dur && dur.s ? Math.round((dur.s / 3600.0) * 10) / 10 : 0.0,
    total_segments: segsCount,
    teachers: teachersList
      .filter((r) => r.default_role !== 'unregistered' && r.default_role !== 'lay_questioner' && r.slug !== 'unknown_teacher' && (teacherCounts[r.slug] || 0) > 0)
      .map((r) => r.display_name),
    browse_teachers: browseTeachers,
    teacher_map: teacherMap,
    years,
    all_years: allYears,
    year_counts: yearCounts,
    duration_counts: durationCounts,
    category_counts: categoryCounts,
    talk_series: talkSeriesList,
    db_version: currentDbVersion,
  };
}

function normalizeEpisodeFilterCriteria({
  teacher,
  teachers,
  teacherMatch = 'any',
  year,
  years,
  startDate,
  endDate,
  titleQuery,
  titleWholeWord = false,
  minDurationMin = null,
  maxDurationMin = null,
  durationBuckets = null,
  collections = null,
  formats = null,
  series = null,
  coTaughtOnly = false,
  episodeIds = null,
} = {}) {
  const rawTeachers = [];
  if (Array.isArray(teachers)) {
    for (let i = 0; i < teachers.length; i++) {
      if (teachers[i]) rawTeachers.push(String(teachers[i]));
    }
  }
  if (teacher && rawTeachers.length === 0) {
    rawTeachers.push(String(teacher));
  }
  const targetTeacherSlugs = rawTeachers.map(resolveTeacherToSlug).filter(Boolean);
  const useAllTeachers = teacherMatch === 'all';

  const yearSet = new Set();
  if (Array.isArray(years)) {
    for (let i = 0; i < years.length; i++) {
      const y = Number(years[i]);
      if (y > 0) yearSet.add(y);
    }
  }
  if (year && yearSet.size === 0) {
    const y = Number(year);
    if (y > 0) yearSet.add(y);
  }

  const bucketSet = Array.isArray(durationBuckets) && durationBuckets.length > 0
    ? new Set(durationBuckets)
    : null;
  const hasMinDur = minDurationMin !== null && minDurationMin !== undefined && minDurationMin !== '' && !Number.isNaN(Number(minDurationMin));
  const hasMaxDur = maxDurationMin !== null && maxDurationMin !== undefined && maxDurationMin !== '' && !Number.isNaN(Number(maxDurationMin));
  const minDurVal = hasMinDur ? Number(minDurationMin) : null;
  const maxDurVal = hasMaxDur ? Number(maxDurationMin) : null;

  const colList = Array.isArray(collections) ? collections.filter(Boolean) : [];
  const fmtList = Array.isArray(formats) ? formats.filter(Boolean) : [];
  const seriesList = Array.isArray(series) ? series.filter(Boolean) : [];
  const allowedIdsSet = Array.isArray(episodeIds) ? new Set(episodeIds) : null;
  const cleanTitleQuery = titleQuery ? String(titleQuery).trim() : '';
  const hasTitleQuery = Boolean(cleanTitleQuery);

  const hasAnyFilter = Boolean(
    allowedIdsSet ||
    yearSet.size > 0 ||
    startDate ||
    endDate ||
    targetTeacherSlugs.length > 0 ||
    coTaughtOnly ||
    colList.length > 0 ||
    fmtList.length > 0 ||
    seriesList.length > 0 ||
    hasMinDur ||
    hasMaxDur ||
    bucketSet ||
    hasTitleQuery
  );

  return {
    targetTeacherSlugs,
    useAllTeachers,
    yearSet,
    startDate: startDate || '',
    endDate: endDate || '',
    bucketSet,
    hasMinDur,
    hasMaxDur,
    minDurVal,
    maxDurVal,
    colList,
    fmtList,
    seriesList,
    coTaughtOnly: Boolean(coTaughtOnly),
    allowedIdsSet,
    hasTitleQuery,
    titleQuery: cleanTitleQuery,
    titleWholeWord: Boolean(titleWholeWord),
    hasAnyFilter,
  };
}

function matchesEpisodeFilterCriteria(ep, criteria) {
  if (!ep) return false;
  if (!criteria || !criteria.hasAnyFilter) return true;

  if (criteria.allowedIdsSet && !criteria.allowedIdsSet.has(ep.id)) return false;

  if (criteria.yearSet.size > 0) {
    const epYear = ep._year || (ep.year ? Number(ep.year) : (ep.date && /^\d{4}/.test(ep.date) ? Number(ep.date.slice(0, 4)) : 0));
    if (!criteria.yearSet.has(epYear)) return false;
  }
  if (criteria.startDate && (ep.date || '') < criteria.startDate) return false;
  if (criteria.endDate && (ep.date || '') > criteria.endDate) return false;

  if (criteria.targetTeacherSlugs.length > 0) {
    if (ep._teacherSlugs && ep._teacherSlugs.size > 0) {
      if (criteria.useAllTeachers) {
        for (let t = 0; t < criteria.targetTeacherSlugs.length; t++) {
          const slug = criteria.targetTeacherSlugs[t];
          if (!ep._teacherSlugs.has(slug) && !(ep._teacherLowerNames && ep._teacherLowerNames.has(slug))) {
            return false;
          }
        }
      } else {
        let anyMatched = false;
        for (let t = 0; t < criteria.targetTeacherSlugs.length; t++) {
          const slug = criteria.targetTeacherSlugs[t];
          if (ep._teacherSlugs.has(slug) || (ep._teacherLowerNames && ep._teacherLowerNames.has(slug))) {
            anyMatched = true;
            break;
          }
        }
        if (!anyMatched) return false;
      }
    } else {
      const primary = (ep.primary_display || '').toLowerCase();
      const identifiedRaw = (ep.identified_teachers || '').toLowerCase();
      const identifiedList = identifiedRaw ? identifiedRaw.split(',').map((s) => stripTeacherNote(s).toLowerCase()).filter(Boolean) : [];
      const matchesOne = (slug) => {
        const wordBoundaryRe = new RegExp(`\\b${escapeRegExp(slug)}\\b`, 'i');
        return primary === slug || identifiedList.includes(slug) || wordBoundaryRe.test(ep.primary_display || '') || wordBoundaryRe.test(ep.identified_teachers || '');
      };
      if (criteria.useAllTeachers) {
        if (!criteria.targetTeacherSlugs.every(matchesOne)) return false;
      } else if (!criteria.targetTeacherSlugs.some(matchesOne)) {
        return false;
      }
    }
  }

  if (criteria.coTaughtOnly && (!ep._categories || !ep._categories.has('co_taught'))) return false;

  if (criteria.colList.length > 0) {
    let colMatch = false;
    for (let c = 0; c < criteria.colList.length; c++) {
      if (ep._categories && ep._categories.has(criteria.colList[c])) {
        colMatch = true;
        break;
      }
    }
    if (!colMatch) return false;
  }

  if (criteria.fmtList.length > 0) {
    let fmtMatch = false;
    for (let f = 0; f < criteria.fmtList.length; f++) {
      if (ep._categories && ep._categories.has(criteria.fmtList[f])) {
        fmtMatch = true;
        break;
      }
    }
    if (!fmtMatch) return false;
  }

  if (criteria.seriesList.length > 0) {
    let seriesMatch = false;
    for (let s = 0; s < criteria.seriesList.length; s++) {
      if (ep._seriesSlugs && ep._seriesSlugs.has(criteria.seriesList[s])) {
        seriesMatch = true;
        break;
      }
    }
    if (!seriesMatch) return false;
  }

  if (criteria.hasMinDur || criteria.hasMaxDur) {
    const durMin = ep._durMin !== undefined ? ep._durMin : Math.round((ep.duration_sec || 0) / 60);
    if (criteria.hasMinDur && durMin < criteria.minDurVal) return false;
    if (criteria.hasMaxDur && durMin > criteria.maxDurVal) return false;
  } else if (criteria.bucketSet && !criteria.bucketSet.has(ep._durBucket)) {
    return false;
  }

  if (criteria.hasTitleQuery) {
    const normTitle = ep._normTitle !== undefined ? ep._normTitle : foldDiacritics(ep.title || '');
    if (!matchesTitleQuery(normTitle, criteria.titleQuery, criteria.titleWholeWord)) {
      return false;
    }
  }

  return true;
}

function handleGetEpisodes(opts = {}) {
  const {
    sort = 'date_desc',
    transcribedOnly = true,
    limit = 50,
    offset = 0,
  } = opts;
  if (db && episodesMetaList.length === 0) {
    rebuildEpisodesMetaCache();
  }

  const criteria = normalizeEpisodeFilterCriteria(opts);
  const filtered = [];
  let totalDurationSec = 0;

  for (let i = 0; i < episodesMetaList.length; i++) {
    const ep = episodesMetaList[i];
    if (transcribedOnly && !ep.is_transcribed) continue;
    if (!matchesEpisodeFilterCriteria(ep, criteria)) continue;

    filtered.push(ep);
    totalDurationSec += ep._durSec;
  }

  filtered.sort((a, b) => {
    switch (sort) {
      case 'year_desc':
        return (b._year - a._year) || (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || '');
      case 'year_asc':
        return (a._year - b._year) || (a.date || '').localeCompare(b.date || '') || (a.id || '').localeCompare(b.id || '');
      case 'date_asc':
        return (a.date || '').localeCompare(b.date || '') || (a.id || '').localeCompare(b.id || '');
      case 'duration_desc':
        return (b._durSec - a._durSec) || (b._year - a._year) || (b.date || '').localeCompare(a.date || '');
      case 'duration_asc':
        return (a._durSec - b._durSec) || (b._year - a._year) || (b.date || '').localeCompare(a.date || '');
      case 'title_asc':
        return (a._normTitle || '').localeCompare(b._normTitle || '') || (b._year - a._year);
      case 'series_asc':
        return ((a._seriesPartNumber || 0) - (b._seriesPartNumber || 0)) ||
          (a._seriesTalkDate || a.date || '').localeCompare(b._seriesTalkDate || b.date || '') ||
          (a.id || '').localeCompare(b.id || '');
      case 'date_desc':
      default:
        return (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || '');
    }
  });

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Number(limit);
  const sliced = (safeLimit > 0)
    ? filtered.slice(safeOffset, safeOffset + safeLimit)
    : filtered.slice(safeOffset);

  return {
    episodes: sliced.map(formatEpisodeRowForClient),
    total: filtered.length,
    total_duration_sec: totalDurationSec,
    all_episode_ids: filtered.map((ep) => ep.id),
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function handleGetEpisode(episodeId) {
  const ep = queryOne('SELECT * FROM episodes WHERE id = ?;', [episodeId]);
  if (!ep) return null;

  if (isShardedMode) {
    let segments = [];
    if (ep.talks_shard) {
      const talksDb = await ensureShardReady(`talks_${ep.talks_shard}`);
      if (talksDb) {
        segments = queryAllOn(
          talksDb,
          `SELECT turn_index, start_sec, end_sec, speaker_slug, speaker_display, text
           FROM speech_segments
           WHERE episode_id = ?
           ORDER BY turn_index ASC;`,
          [episodeId]
        );
      }
    }

    let wordsBlob = null;
    if (ep.words_shard) {
      const wordsKey = `words_${ep.words_shard}`;
      if (shardHandles.has(wordsKey)) {
        try {
          const wRow = queryOneOn(
            shardHandles.get(wordsKey),
            'SELECT words_blob FROM episode_words WHERE episode_id = ?;',
            [episodeId]
          );
          if (wRow && wRow.words_blob) wordsBlob = wRow.words_blob;
        } catch (_) {}
      }
    }

    return {
      ...ep,
      segments,
      words_blob: wordsBlob,
    };
  }

  const segments = queryAll(`
    SELECT turn_index, start_sec, end_sec, speaker_slug, speaker_display, text 
    FROM speech_segments 
    WHERE episode_id = ? 
    ORDER BY turn_index ASC;
  `, [episodeId]);

  let wordsBlob = null;
  try {
    const wRow = queryOne('SELECT words_blob FROM episode_words WHERE episode_id = ?;', [episodeId]);
    if (wRow && wRow.words_blob) {
      wordsBlob = wRow.words_blob;
    }
  } catch (_) {}

  return {
    ...ep,
    segments,
    words_blob: wordsBlob,
  };
}

async function handleGetEpisodeWords(episodeId) {
  try {
    if (isShardedMode) {
      const ep = queryOne('SELECT words_shard FROM episodes WHERE id = ?;', [episodeId]);
      if (!ep || !ep.words_shard) return null;
      const wordsDb = await ensureShardReady(`words_${ep.words_shard}`);
      if (!wordsDb) return null;
      const row = queryOneOn(wordsDb, 'SELECT words_blob FROM episode_words WHERE episode_id = ?;', [episodeId]);
      return row && row.words_blob ? row.words_blob : null;
    }
    const row = queryOne('SELECT words_blob FROM episode_words WHERE episode_id = ?;', [episodeId]);
    return row && row.words_blob ? row.words_blob : null;
  } catch (_) {
    return null;
  }
}

function handleGetEpisodesByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  if (db && episodesMetaList.length === 0) {
    rebuildEpisodesMetaCache();
  }
  if (episodesMetaMap.size > 0) {
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const ep = episodesMetaMap.get(ids[i]);
      if (ep) out.push(formatEpisodeRowForClient(ep));
    }
    if (out.length === ids.length || out.length > 0) {
      return out;
    }
  }
  const uniqueIds = Array.from(new Set(ids));
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = queryAll(`
    SELECT id, title, date, year, primary_teacher, primary_display AS teacher, 
           identified_teachers, media_url, permalink, duration_sec, is_transcribed 
    FROM episodes 
    WHERE id IN (${placeholders});
  `, uniqueIds);
  const map = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => map.get(id)).filter(Boolean);
}

// ============================================================================
// In-Browser Fuzzy Search, Vocabulary Cache & Unicode Normalization
// ============================================================================

let vocabList = [];
let vocabSet = new Set();

const PALI_DIACRITICS_MAP = {
  'ā': 'a', 'Ā': 'a',
  'ī': 'i', 'Ī': 'i',
  'ū': 'u', 'Ū': 'u',
  'ṭ': 't', 'Ṭ': 't',
  'ḍ': 'd', 'Ḍ': 'd',
  'ṇ': 'n', 'Ṇ': 'n',
  'ñ': 'n', 'Ñ': 'n',
  'ḷ': 'l', 'Ḷ': 'l',
  'ṁ': 'm', 'Ṁ': 'm',
  'ŋ': 'm', 'Ŋ': 'm',
  'ś': 's', 'Ś': 's',
  'ṣ': 's', 'Ṣ': 's'
};

function foldDiacritics(str) {
  if (!str) return '';
  return str
    .replace(/[ŋŊ]/g, 'm')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[āĀīĪūŪṭṬḍḌṇṆñÑḷḶṁṀŋŊśŚṣṢ]/g, (ch) => PALI_DIACRITICS_MAP[ch] || ch)
    .toLowerCase();
}

let vocabCacheInitialized = false;

function ensureVocabCache() {
  if (vocabCacheInitialized) return;
  if (!db) return;
  vocabCacheInitialized = true;
  initVocabCache();
}

function initVocabCache() {
  vocabList = [];
  vocabSet = new Set();
  try {
    const rows = queryAll('SELECT word, count FROM search_vocab ORDER BY count DESC;');
    if (rows && rows.length > 0) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        vocabList.push({ word: r.word, count: r.count });
        vocabSet.add(r.word);
      }
      console.log(`[DB Worker] Loaded ${vocabList.length} vocabulary terms for in-browser fuzzy search.`);
      return;
    }
  } catch (_) {}

  // Fallback dynamic extraction if search_vocab table is missing
  try {
    const segs = queryAll('SELECT text FROM speech_segments LIMIT 3000;');
    const counts = {};
    for (let i = 0; i < segs.length; i++) {
      const ws = (segs[i].text || '').toLowerCase().match(/[a-z]{3,}/g) || [];
      for (let j = 0; j < ws.length; j++) {
        const w = ws[j];
        counts[w] = (counts[w] || 0) + 1;
      }
    }
    const terms = queryAll('SELECT pali_plain, english_description FROM terms LIMIT 2000;');
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      const ws1 = (t.pali_plain || '').toLowerCase().match(/[a-z]{3,}/g) || [];
      for (let j = 0; j < ws1.length; j++) counts[ws1[j]] = (counts[ws1[j]] || 0) + 5;
      const ws2 = (t.english_description || '').toLowerCase().match(/[a-z]{3,}/g) || [];
      for (let j = 0; j < ws2.length; j++) counts[ws2[j]] = (counts[ws2[j]] || 0) + 1;
    }
    const keys = Object.keys(counts);
    for (let i = 0; i < keys.length; i++) {
      const w = keys[i];
      vocabList.push({ word: w, count: counts[w] });
      vocabSet.add(w);
    }
    vocabList.sort((a, b) => b.count - a.count);
    console.log(`[DB Worker] Dynamically indexed ${vocabList.length} vocabulary terms for fuzzy search.`);
  } catch (e) {
    console.warn('[DB Worker] Could not index vocabulary:', e);
  }
}

function damerauLevenshtein(a, b, maxDist = 2) {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (Math.abs(la - lb) > maxDist) return 999;

  const d = [];
  for (let i = 0; i <= la; i++) {
    d[i] = new Int32Array(lb + 1);
    d[i][0] = i;
  }
  for (let j = 0; j <= lb; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let minVal = Math.min(
        d[i - 1][j] + 1,       // deletion
        d[i][j - 1] + 1,       // insertion
        d[i - 1][j - 1] + cost // substitution
      );

      // Transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        minVal = Math.min(minVal, d[i - 2][j - 2] + 1);
      }
      d[i][j] = minVal;
    }
  }
  return d[la][lb];
}

function correctFuzzyWord(w) {
  ensureVocabCache();
  if (!w || w.length <= 4) return w;
  if (vocabSet.has(w)) return w;

  const maxDist = w.length <= 8 ? 1 : 2;
  let bestCandidate = w;
  let bestDist = maxDist + 1;
  let bestCount = -1;

  for (let i = 0; i < vocabList.length; i++) {
    const item = vocabList[i];
    const cand = item.word;
    const lenDiff = Math.abs(cand.length - w.length);
    if (lenDiff > maxDist) continue;

    const dist = damerauLevenshtein(w, cand, maxDist);
    if (dist <= maxDist) {
      if (dist < bestDist) {
        bestDist = dist;
        bestCandidate = cand;
        bestCount = item.count;
      } else if (dist === bestDist && item.count > bestCount) {
        bestCandidate = cand;
        bestCount = item.count;
      }
    }
  }

  return bestCandidate;
}

let searchCache = null;

const SEARCH_STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'being', 'but', 'by',
  'can', 'could',
  'did', 'do', 'does', 'doing', 'down',
  'for', 'from',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how',
  'if', 'in', 'into', 'is', 'it', 'its',
  'just',
  'like',
  'me', 'more', 'most', 'my',
  'no', 'nor', 'not', 'now',
  'of', 'on', 'only', 'or', 'other', 'our', 'ours', 'out', 'over',
  'same', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'up',
  'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours'
]);

function toPrefixTerm(w) {
  if (!w) return '';
  return w.length >= 3 && !/^\d+$/.test(w) ? `${w}*` : w;
}

function getContentWords(words) {
  const filtered = words.filter((w) => !SEARCH_STOPWORDS.has(w));
  return {
    contentWords: filtered.length > 0 ? filtered : words,
    hasContentWords: filtered.length > 0,
  };
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesEpisodeFilters(ep, filterOpts = {}) {
  const criteria = filterOpts && filterOpts.hasAnyFilter !== undefined
    ? filterOpts
    : normalizeEpisodeFilterCriteria(filterOpts);
  return matchesEpisodeFilterCriteria(ep, criteria);
}

function extractExplicitHighlightInfo(cleanQuery) {
  const strippedNot = cleanQuery.replace(/\bNOT\s+(?:"[^"]+"|\S+)/gi, ' ');
  const quotedPhrases = [];
  const quoteRe = /"([^"]+)"/g;
  let m;
  while ((m = quoteRe.exec(strippedNot)) !== null) {
    const phraseTokens = (m[1].match(/[\p{L}\p{N}]+/gu) || []).map((w) => foldDiacritics(w)).filter(Boolean);
    if (phraseTokens.length > 1) quotedPhrases.push(phraseTokens.join(' '));
  }
  const tokens = (strippedNot.replace(/\bNEAR\s*\(/gi, ' ').match(/[\p{L}\p{N}]+/gu) || [])
    .map((w) => foldDiacritics(w))
    .filter((w) => w && !['and', 'or', 'not', 'near'].includes(w) && !/^\d+$/.test(w));
  const nonStop = tokens.filter((w) => !SEARCH_STOPWORDS.has(w));
  return {
    highlightTerms: Array.from(new Set(nonStop.length > 0 ? nonStop : tokens)),
    hasContentWords: nonStop.length > 0,
    phrase: quotedPhrases.length === 1 ? quotedPhrases[0] : null,
  };
}

function generateQuorumQueries(words) {
  if (words.length < 3) return null;
  const k = words.length <= 4 ? words.length - 1 : Math.max(2, Math.floor(words.length * 0.75));

  function getCombos(arr, len) {
    if (len === 1) return arr.map((x) => [x]);
    const combos = [];
    for (let i = 0; i <= arr.length - len; i++) {
      const head = arr[i];
      const tails = getCombos(arr.slice(i + 1), len - 1);
      for (let j = 0; j < tails.length; j++) {
        combos.push([head, ...tails[j]]);
      }
    }
    return combos;
  }

  const combos = getCombos(words, k);
  if (!combos.length) return null;
  const topCombos = combos.slice(0, 10);
  return topCombos.map((clause) => `(${clause.map((w) => toPrefixTerm(w)).join(' AND ')})`).join(' OR ');
}

async function handleSearchFTS({
  query,
  exact = false,
  teacher,
  teachers,
  teacherMatch = 'any',
  year,
  years,
  startDate,
  endDate,
  titleQuery,
  titleWholeWord = false,
  minDurationMin = null,
  maxDurationMin = null,
  durationBuckets = null,
  collections = null,
  formats = null,
  coTaughtOnly = false,
  episodeIds = null,
  sort = 'rank',
  limit = 500,
  episodeLimit = null,
  offset = 0,
} = {}) {
  const t0 = performance.now();
  const cleanQuery = (query || '').replace(/\\"/g, '"').trim();
  const useEpisodePagination = episodeLimit !== null && episodeLimit !== undefined && Number(episodeLimit) > 0;
  const pageSize = useEpisodePagination ? Math.max(1, Number(episodeLimit)) : null;
  const safeOffset = Math.max(0, Number(offset) || 0);

  const emptyResponse = (tier = 'none') => ({
    query: cleanQuery,
    results: [],
    count: 0,
    total_episodes: 0,
    total_segments: 0,
    offset: safeOffset,
    limit: pageSize || limit,
    all_episode_ids: [],
    elapsed_ms: 0,
    meta: { tier },
  });

  if (!cleanQuery) return emptyResponse('none');

  // Unicode-aware word tokenization
  const rawTokens = cleanQuery.match(/[\p{L}\p{N}]+/gu) || [];
  if (!rawTokens.length) return emptyResponse('none');

  const words = rawTokens.map((w) => foldDiacritics(w)).filter(Boolean);
  if (!words.length) return emptyResponse('none');

  const { contentWords, hasContentWords } = getContentWords(words);

  if (isShardedMode) {
    await ensureAllTalksShardsReady();
  }

  const candidateSql = `
    SELECT
      s.id AS seg_id,
      s.episode_id,
      s.turn_index,
      s.start_sec,
      bm25(transcripts_fts) AS rank_score
    FROM transcripts_fts
    JOIN speech_segments s ON transcripts_fts.rowid = s.id
    WHERE transcripts_fts MATCH ?;
  `;

  const hydratePrefix = `
    SELECT
      s.id AS seg_id,
      s.episode_id,
      s.turn_index,
      s.speaker_slug,
      s.speaker_display,
      s.start_sec,
      s.end_sec,
      s.text,
      snippet(transcripts_fts, 1, '<b>', '</b>', '...', 15) AS snippet_text,
      bm25(transcripts_fts) AS rank_score
    FROM transcripts_fts
    JOIN speech_segments s ON transcripts_fts.rowid = s.id
    WHERE transcripts_fts MATCH ? AND transcripts_fts.rowid IN
  `;

  if (db && episodesMetaList.length === 0) {
    rebuildEpisodesMetaCache();
  }

  const filterCriteria = normalizeEpisodeFilterCriteria({
    teacher,
    teachers,
    teacherMatch,
    year,
    years,
    startDate,
    endDate,
    titleQuery,
    titleWholeWord,
    minDurationMin,
    maxDurationMin,
    durationBuckets,
    collections,
    formats,
    coTaughtOnly,
    episodeIds,
  });
  const hasEpFilters = filterCriteria.hasAnyFilter;
  const talksList = (activeManifest && activeManifest.talks) ? activeManifest.talks : [];
  const mountedCount = isShardedMode ? talksList.filter((t) => shardHandles.has(t.id)).length : 1;

  const cacheKey = JSON.stringify({
    v: currentDbVersion,
    m: mountedCount,
    sharded: isShardedMode,
    q: cleanQuery,
    exact: Boolean(exact),
    teachers: filterCriteria.targetTeacherSlugs,
    teacherMatch: filterCriteria.useAllTeachers ? 'all' : 'any',
    years: Array.from(filterCriteria.yearSet).sort((a, b) => a - b),
    startDate: filterCriteria.startDate,
    endDate: filterCriteria.endDate,
    titleQuery: filterCriteria.titleQuery,
    titleWholeWord: filterCriteria.titleWholeWord,
    minDur: filterCriteria.minDurVal,
    maxDur: filterCriteria.maxDurVal,
    buckets: filterCriteria.bucketSet ? Array.from(filterCriteria.bucketSet).sort() : null,
    col: filterCriteria.colList,
    fmt: filterCriteria.fmtList,
    coTaughtOnly: filterCriteria.coTaughtOnly,
    episodeIds: filterCriteria.allowedIdsSet ? Array.from(filterCriteria.allowedIdsSet).sort() : null,
    sort: sort || 'rank',
  });

  function queryCandidates(qStr) {
    const out = [];
    const collectFromHandle = (handle, shardId) => {
      try {
        const rows = queryAllOn(handle, candidateSql, [qStr]);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (hasEpFilters) {
            const ep = episodesMetaMap.get(r.episode_id);
            if (!matchesEpisodeFilters(ep, filterCriteria)) continue;
          }
          out.push({
            shardId,
            seg_id: r.seg_id,
            episode_id: r.episode_id,
            turn_index: r.turn_index,
            start_sec: r.start_sec,
            rank_score: r.rank_score,
          });
        }
      } catch (_) {}
    };

    if (!isShardedMode) {
      collectFromHandle(db, null);
      return out;
    }

    for (let i = 0; i < talksList.length; i++) {
      const shardId = talksList[i].id;
      const sHandle = shardHandles.get(shardId);
      if (sHandle) collectFromHandle(sHandle, shardId);
    }
    return out;
  }

  function hydrateCandidates(candidates, ftsQuery) {
    if (!candidates.length || !ftsQuery) return [];
    const byShard = new Map();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const key = c.shardId || '__main__';
      if (!byShard.has(key)) byShard.set(key, []);
      byShard.get(key).push(c.seg_id);
    }

    const hydrated = [];
    for (const [key, segIds] of byShard.entries()) {
      const handle = key === '__main__' ? db : shardHandles.get(key);
      if (!handle) continue;
      for (let start = 0; start < segIds.length; start += 400) {
        const chunk = segIds.slice(start, start + 400);
        const placeholders = chunk.map(() => '?').join(',');
        try {
          const rows = queryAllOn(handle, `${hydratePrefix} (${placeholders});`, [ftsQuery, ...chunk]);
          for (let j = 0; j < rows.length; j++) {
            const r = rows[j];
            const ep = episodesMetaMap.get(r.episode_id) || {};
            hydrated.push({
              seg_id: r.seg_id,
              episode_id: r.episode_id,
              title: ep.title || r.episode_id,
              date: ep.date || '',
              year: ep.year || 0,
              duration_sec: ep.duration_sec || 0,
              teacher_slug: ep.primary_teacher || '',
              teacher: ep.primary_display || '',
              identified_teachers: ep.identified_teachers || '',
              teacher_slugs: ep.teacher_slugs || [],
              media_url: ep.media_url || '',
              permalink: ep.permalink || '',
              turn_index: r.turn_index,
              speaker_slug: r.speaker_slug,
              speaker_display: r.speaker_display,
              start_sec: r.start_sec,
              end_sec: r.end_sec,
              text: r.text,
              snippet_text: r.snippet_text,
              rank_score: r.rank_score,
            });
          }
        } catch (_) {}
      }
    }
    return hydrated;
  }

  let cachedEntry = searchCache && searchCache.key === cacheKey ? searchCache : null;

  if (!cachedEntry) {
    let candidates = [];
    let winningFtsQuery = '';
    const meta = {
      tier: 'exact',
      original_query: cleanQuery,
      effective_query: cleanQuery,
      corrected: false,
      highlight_terms: contentWords,
      all_words: words,
      has_content_words: hasContentWords,
      phrase: words.length > 1 ? words.join(' ') : null,
    };

    const runTier = (qStr) => {
      const hits = queryCandidates(qStr);
      if (hits.length > 0) winningFtsQuery = qStr;
      return hits;
    };

    // 0. Explicit operators check
    const hasExplicitSyntax = [' AND ', ' OR ', ' NOT ', 'NEAR('].some((op) => cleanQuery.includes(op)) ||
      (cleanQuery.startsWith('"') && cleanQuery.endsWith('"') && cleanQuery.length > 2);

    if (hasExplicitSyntax) {
      candidates = runTier(cleanQuery);
      if (!candidates.length) {
        candidates = runTier(`"${cleanQuery.replace(/"/g, '""')}"`);
      }
      const explicitInfo = extractExplicitHighlightInfo(cleanQuery);
      meta.tier = 'explicit';
      meta.highlight_terms = explicitInfo.highlightTerms;
      meta.has_content_words = explicitInfo.hasContentWords;
      meta.phrase = explicitInfo.phrase;
    } else {
      // Tier 1: Exact Phrase (preserves stopwords so titles/phrases stay exact) / Exact Word
      const t1 = words.length > 1 ? `"${words.join(' ')}"` : words[0];
      candidates = runTier(t1);
      meta.tier = words.length > 1 ? 'exact_phrase' : 'exact_word';

      // Tier 2: Content-only Proximity (NEAR) or Exact Single Content Word
      if (!candidates.length && !exact && words.length > 1) {
        if (contentWords.length > 1) {
          const t2 = `NEAR(${contentWords.join(' ')}, 15)`;
          candidates = runTier(t2);
          if (candidates.length) {
            meta.tier = 'proximity';
            meta.effective_query = t2;
            meta.phrase = null;
          }
        } else if (hasContentWords) {
          const t2Single = contentWords[0];
          candidates = runTier(t2Single);
          if (candidates.length) {
            meta.tier = 'exact_word';
            meta.effective_query = t2Single;
            meta.phrase = null;
          }
        }
      }

      // Tier 3: Prefix AND matching on content words only (never wildcard-expand stopwords)
      if (!candidates.length && !exact) {
        const t3 = contentWords.map((w) => toPrefixTerm(w)).join(' AND ');
        candidates = runTier(t3);
        if (candidates.length) {
          meta.tier = 'prefix';
          meta.effective_query = t3;
          meta.phrase = null;
        }
      }

      // Tier 4: Fuzzy Auto-Correction (content words only)
      const correctedContentWords = contentWords.map((w) => (SEARCH_STOPWORDS.has(w) ? w : correctFuzzyWord(w)));
      const isCorrected = correctedContentWords.some((cw, i) => cw !== contentWords[i]);
      let correctedAllWords = words;
      if (isCorrected) {
        let cIdx = 0;
        correctedAllWords = words.map((w) => {
          if (hasContentWords && SEARCH_STOPWORDS.has(w)) return w;
          const cw = correctedContentWords[cIdx] || w;
          cIdx++;
          return cw;
        });
      }
      const correctedPhrase = correctedAllWords.join(' ');

      if (!candidates.length && !exact && isCorrected) {
        // 4a: Corrected exact phrase
        const t4Phrase = correctedAllWords.length > 1 ? `"${correctedPhrase}"` : correctedAllWords[0];
        candidates = runTier(t4Phrase);

        // 4b: Corrected content proximity
        if (!candidates.length && correctedContentWords.length > 1) {
          const t4Near = `NEAR(${correctedContentWords.join(' ')}, 15)`;
          candidates = runTier(t4Near);
        }

        // 4c: Corrected content prefix AND
        if (!candidates.length) {
          const t4Prefix = correctedContentWords.map((w) => toPrefixTerm(w)).join(' AND ');
          candidates = runTier(t4Prefix);
        }

        if (candidates.length) {
          meta.tier = 'fuzzy';
          meta.corrected = true;
          meta.effective_query = correctedPhrase;
          meta.highlight_terms = correctedContentWords;
          meta.phrase = correctedAllWords.length > 1 ? correctedPhrase : null;
        }
      }

      // Tier 5: Multi-Word Soft AND / Quorum Matching (ONLY when >= 3 content words!)
      const activeContentWords = isCorrected ? correctedContentWords : contentWords;
      if (!candidates.length && !exact && activeContentWords.length >= 3) {
        const quorumQuery = generateQuorumQueries(activeContentWords);
        if (quorumQuery) {
          candidates = runTier(quorumQuery);
          if (candidates.length) {
            meta.tier = 'quorum';
            const k = activeContentWords.length <= 4
              ? activeContentWords.length - 1
              : Math.max(2, Math.floor(activeContentWords.length * 0.75));
            meta.effective_query = `${k} of ${activeContentWords.length} key terms`;
            meta.highlight_terms = activeContentWords;
            meta.phrase = null;
            if (isCorrected) meta.corrected = true;
          }
        }
      }

      // Tier 6: Filtered Any-Word Match (content words only)
      if (!candidates.length && !exact && activeContentWords.length > 1) {
        const t6 = activeContentWords.map((w) => toPrefixTerm(w)).join(' OR ');
        candidates = runTier(t6);
        if (candidates.length) {
          meta.tier = 'any_word';
          meta.effective_query = t6;
          meta.highlight_terms = activeContentWords;
          meta.phrase = null;
          if (isCorrected) meta.corrected = true;
        }
      }
    }

    // Group candidates by episode_id and compute episode-level sort scores
    const epGroupMap = new Map();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      let grp = epGroupMap.get(c.episode_id);
      if (!grp) {
        const ep = episodesMetaMap.get(c.episode_id) || {};
        grp = {
          episode_id: c.episode_id,
          year: ep._year || 0,
          date: ep.date || '',
          duration_sec: ep._durSec || ep.duration_sec || 0,
          normTitle: ep._normTitle || '',
          bestRank: c.rank_score || 0,
          segments: [],
        };
        epGroupMap.set(c.episode_id, grp);
      }
      if ((c.rank_score || 0) < grp.bestRank) {
        grp.bestRank = c.rank_score || 0;
      }
      grp.segments.push(c);
    }

    const sortedEpisodes = Array.from(epGroupMap.values());
    for (let i = 0; i < sortedEpisodes.length; i++) {
      const g = sortedEpisodes[i];
      g.segments.sort((a, b) => a.turn_index - b.turn_index);
      // Combine strongest turn BM25 with logarithmic density boost (negative is better in FTS5)
      g.episodeRankScore = g.bestRank - 0.35 * Math.log(1 + g.segments.length);
    }

    if (sort === 'year_desc') {
      sortedEpisodes.sort((a, b) => (b.year - a.year) || (b.date || '').localeCompare(a.date || '') || b.episode_id.localeCompare(a.episode_id));
    } else if (sort === 'year_asc') {
      sortedEpisodes.sort((a, b) => (a.year - b.year) || (a.date || '').localeCompare(b.date || '') || a.episode_id.localeCompare(b.episode_id));
    } else if (sort === 'date_asc') {
      sortedEpisodes.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.episode_id.localeCompare(b.episode_id));
    } else if (sort === 'date_desc') {
      sortedEpisodes.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.episode_id.localeCompare(a.episode_id));
    } else if (sort === 'duration_desc') {
      sortedEpisodes.sort((a, b) => (b.duration_sec || 0) - (a.duration_sec || 0) || (b.year - a.year) || (b.date || '').localeCompare(a.date || ''));
    } else if (sort === 'duration_asc') {
      sortedEpisodes.sort((a, b) => (a.duration_sec || 0) - (b.duration_sec || 0) || (b.year - a.year) || (b.date || '').localeCompare(a.date || ''));
    } else if (sort === 'title_asc') {
      sortedEpisodes.sort((a, b) => (a.normTitle || '').localeCompare(b.normTitle || '') || (b.year - a.year));
    } else {
      sortedEpisodes.sort((a, b) => (a.episodeRankScore - b.episodeRankScore) || (b.date || '').localeCompare(a.date || ''));
    }

    cachedEntry = {
      key: cacheKey,
      candidates,
      sortedEpisodes,
      totalSegments: candidates.length,
      allEpisodeIds: sortedEpisodes.map((g) => g.episode_id),
      meta,
      winningFtsQuery,
    };
    searchCache = cachedEntry;
  }

  const totalEpisodes = cachedEntry.sortedEpisodes.length;
  let results = [];

  if (useEpisodePagination) {
    const pageEpisodes = cachedEntry.sortedEpisodes.slice(safeOffset, safeOffset + pageSize);
    const pageOrder = new Map();
    const selectedCandidates = [];
    for (let i = 0; i < pageEpisodes.length; i++) {
      pageOrder.set(pageEpisodes[i].episode_id, i);
      const segs = pageEpisodes[i].segments;
      for (let j = 0; j < segs.length; j++) {
        selectedCandidates.push(segs[j]);
      }
    }
    results = hydrateCandidates(selectedCandidates, cachedEntry.winningFtsQuery);
    results.sort((a, b) => {
      const oa = pageOrder.get(a.episode_id) ?? 0;
      const ob = pageOrder.get(b.episode_id) ?? 0;
      if (oa !== ob) return oa - ob;
      return a.turn_index - b.turn_index;
    });
  } else {
    // Legacy segment-capped behavior when caller provides only { limit }
    const segPool = [...cachedEntry.candidates];
    if (sort === 'date_asc') {
      segPool.sort((a, b) => {
        const da = (episodesMetaMap.get(a.episode_id) || {}).date || '';
        const dbDate = (episodesMetaMap.get(b.episode_id) || {}).date || '';
        return da.localeCompare(dbDate) || a.start_sec - b.start_sec;
      });
    } else if (sort === 'date_desc') {
      segPool.sort((a, b) => {
        const da = (episodesMetaMap.get(a.episode_id) || {}).date || '';
        const dbDate = (episodesMetaMap.get(b.episode_id) || {}).date || '';
        return dbDate.localeCompare(da) || a.start_sec - b.start_sec;
      });
    } else {
      segPool.sort((a, b) => (a.rank_score || 0) - (b.rank_score || 0));
    }
    const segOrder = new Map();
    const sliced = segPool.slice(0, limit);
    for (let i = 0; i < sliced.length; i++) {
      segOrder.set(`${sliced[i].episode_id}:${sliced[i].seg_id}`, i);
    }
    results = hydrateCandidates(sliced, cachedEntry.winningFtsQuery);
    results.sort((a, b) => {
      const oa = segOrder.get(`${a.episode_id}:${a.seg_id}`) ?? 0;
      const ob = segOrder.get(`${b.episode_id}:${b.seg_id}`) ?? 0;
      return oa - ob;
    });
  }

  const elapsed_ms = Math.round((performance.now() - t0) * 100) / 100;

  return {
    query: cleanQuery,
    results,
    count: results.length,
    total_episodes: totalEpisodes,
    total_segments: cachedEntry.totalSegments,
    offset: safeOffset,
    limit: pageSize || limit,
    all_episode_ids: cachedEntry.allEpisodeIds,
    elapsed_ms,
    meta: cachedEntry.meta,
  };
}

function handleSearchLexicon(q, limit = 10) {
  const raw = (q || '').trim();
  if (!raw) return [];
  const clean = foldDiacritics(raw);
  const words = (clean.match(/[\p{L}\p{N}]+/gu) || []).map((w) => w.trim()).filter(Boolean);
  if (!words.length) return [];

  // Try 1: Exact matches on terms table directly
  try {
    const exactMatches = queryAll(`
      SELECT * FROM v_terms 
      WHERE pali_plain = ? OR pali_diacritic = ? COLLATE NOCASE
      LIMIT ?;
    `, [clean, raw, limit]);
    if (exactMatches.length > 0) return exactMatches;
  } catch (_) {}

  // Try 2: FTS prefix AND
  try {
    const ftsQ = words.map((w) => `${w}*`).join(' AND ');
    const ftsMatches = queryAll(`
      SELECT t.* 
      FROM fts_terms f
      JOIN v_terms t ON f.rowid = t.id
      WHERE fts_terms MATCH ?
      ORDER BY rank
      LIMIT ?;
    `, [ftsQ, limit]);
    if (ftsMatches.length > 0) return ftsMatches;
  } catch (_) {}

  // Try 3: Fuzzy corrected words
  const correctedWords = words.map((w) => correctFuzzyWord(w));
  const isCorrected = correctedWords.some((cw, i) => cw !== words[i]);
  if (isCorrected) {
    try {
      const ftsCorr = correctedWords.map((w) => `${w}*`).join(' AND ');
      const corrMatches = queryAll(`
        SELECT t.* 
        FROM fts_terms f
        JOIN v_terms t ON f.rowid = t.id
        WHERE fts_terms MATCH ?
        ORDER BY rank
        LIMIT ?;
      `, [ftsCorr, limit]);
      if (corrMatches.length > 0) return corrMatches;
    } catch (_) {}
  }

  // Try 4: Substring LIKE fallback
  try {
    return queryAll(`
      SELECT * FROM v_terms 
      WHERE pali_plain LIKE ? OR english_description LIKE ? OR pali_diacritic LIKE ?
      LIMIT ?;
    `, [`%${clean}%`, `%${clean}%`, `%${raw}%`, limit]);
  } catch (_) {
    return [];
  }
}

function handleLookupLexicon(term) {
  const raw = (term || '').trim();
  if (!raw) return null;
  const clean = foldDiacritics(raw);
  return queryOne(`
    SELECT * FROM v_terms 
    WHERE pali_plain = ? OR pali_diacritic = ? COLLATE NOCASE 
    LIMIT 1;
  `, [clean, raw]);
}

const CORE_CANONICAL_TERMS = [
  'samadhi', 'sati', 'kamma', 'nibbana', 'panna', 'sila', 'bhavana', 'sangha',
  'dhamma', 'buddha', 'metta', 'brahmavihara', 'vipassana', 'samatha',
  'paticcasamuppada', 'tilakkhana', 'khandha', 'tanha', 'avijja', 'ariya'
];

function handleGetLexiconPage({
  mode = 'core',
  category = null,
  letter = null,
  sort = 'pali_asc',
  page = 1,
  limit = 25
} = {}) {
  const whereParts = ['1=1'];
  const params = [];

  if (mode === 'core') {
    const placeholders = CORE_CANONICAL_TERMS.map(() => '?').join(', ');
    whereParts.push(`(translation_brahm IS NOT NULL OR category IN ('meditation', 'hindrance', 'monastery', 'retreat_centre', 'monastic_calendar') OR pali_plain IN (${placeholders}))`);
    params.push(...CORE_CANONICAL_TERMS);
  }

  if (category && category !== 'all') {
    whereParts.push('category = ?');
    params.push(category);
  }

  if (letter && letter !== 'all') {
    whereParts.push('pali_plain LIKE ?');
    params.push(`${letter.toLowerCase()}%`);
  }

  const whereSql = whereParts.join(' AND ');

  const countRow = queryOne(`SELECT COUNT(*) as cnt FROM v_terms WHERE ${whereSql};`, params);
  const total = countRow ? (countRow.cnt || 0) : 0;

  let orderSql = 'pali_plain ASC';
  if (sort === 'teacher_first') {
    orderSql = '(translation_brahm IS NOT NULL) DESC, pali_plain ASC';
  }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.max(1, parseInt(limit, 10) || 25);
  const offset = (p - 1) * lim;

  const items = queryAll(`
    SELECT * FROM v_terms
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?;
  `, [...params, lim, offset]);

  items.forEach(item => {
    if (typeof item.phonetic_variants === 'string') {
      try {
        item.phonetic_variants = JSON.parse(item.phonetic_variants);
      } catch (_) {
        item.phonetic_variants = [];
      }
    }
  });

  return {
    items,
    total,
    page: p,
    limit: lim,
    totalPages: Math.ceil(total / lim) || 1
  };
}

// ============================================================================
// Worker Message Router
// ============================================================================

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};

  try {
    switch (type) {
      case 'init': {
        const res = await initDatabase(payload);
        self.postMessage({ id, success: true, data: res });
        break;
      }
      case 'get_stats': {
        const stats = handleGetStats();
        self.postMessage({ id, success: true, data: stats });
        break;
      }
      case 'get_episodes': {
        const episodes = handleGetEpisodes(payload || {});
        self.postMessage({ id, success: true, data: episodes });
        break;
      }
      case 'get_episode': {
        const ep = await handleGetEpisode(payload && payload.episodeId);
        self.postMessage({ id, success: true, data: ep });
        break;
      }
      case 'get_episode_words': {
        const wordsBlob = await handleGetEpisodeWords(payload && payload.episodeId);
        self.postMessage({ id, success: true, data: wordsBlob });
        break;
      }
      case 'get_episodes_by_ids': {
        const episodes = handleGetEpisodesByIds(payload && payload.ids);
        self.postMessage({ id, success: true, data: episodes });
        break;
      }
      case 'search': {
        const results = await handleSearchFTS(payload || {});
        self.postMessage({ id, success: true, data: results });
        break;
      }
      case 'search_lexicon': {
        const results = handleSearchLexicon(payload && payload.query, payload && payload.limit);
        self.postMessage({ id, success: true, data: results });
        break;
      }
      case 'lookup_lexicon': {
        const term = handleLookupLexicon(payload && payload.term);
        self.postMessage({ id, success: true, data: term });
        break;
      }
      case 'get_all_terms': {
        const terms = queryAll(`
          SELECT id, pali_plain, pali_diacritic, category, 
                 translation_bodhi, translation_sujato, translation_brahm, translation_brahmali,
                 english_description, phonetic_variants,
                 source_document_id, source_url, source_mirror_url, source_title
          FROM v_terms 
          ORDER BY pali_plain ASC;
        `);
        terms.forEach(item => {
          if (typeof item.phonetic_variants === 'string') {
            try {
              item.phonetic_variants = JSON.parse(item.phonetic_variants);
            } catch (_) {
              item.phonetic_variants = [];
            }
          }
        });
        self.postMessage({ id, success: true, data: terms });
        break;
      }
      case 'get_lexicon_page': {
        const pageData = handleGetLexiconPage(payload || {});
        self.postMessage({ id, success: true, data: pageData });
        break;
      }
      case 'get_source_documents': {
        const docs = queryAll(`
          SELECT id, url, mirror_url, title, author, publisher, retrieved_date,
                 content_format, uncompressed_bytes, compressed_bytes, sha256
          FROM source_documents
          ORDER BY id ASC;
        `);
        self.postMessage({ id, success: true, data: docs });
        break;
      }
      case 'get_source_document': {
        const query = payload && payload.query;
        let doc = null;
        if (typeof query === 'number' || (typeof query === 'string' && /^\d+$/.test(query.trim()))) {
          doc = queryOne(`
            SELECT id, url, mirror_url, title, author, publisher, retrieved_date,
                   content_format, uncompressed_bytes, compressed_bytes, sha256,
                   content_text, content_compressed
            FROM source_documents
            WHERE id = ? LIMIT 1;
          `, [parseInt(query, 10)]);
        } else if (query) {
          const qStr = String(query).trim();
          doc = queryOne(`
            SELECT id, url, mirror_url, title, author, publisher, retrieved_date,
                   content_format, uncompressed_bytes, compressed_bytes, sha256,
                   content_text, content_compressed
            FROM source_documents
            WHERE url = ? OR url LIKE ? OR title LIKE ?
            LIMIT 1;
          `, [qStr, `%${qStr}%`, `%${qStr}%`]);
        }

        if (doc) {
          if (doc.content_text) {
            doc.content = doc.content_text;
          } else if (doc.content_compressed) {
            try {
              if (typeof DecompressionStream !== 'undefined') {
                const ds = new DecompressionStream('deflate');
                const writer = ds.writable.getWriter();
                writer.write(doc.content_compressed);
                writer.close();
                const chunks = [];
                const reader = ds.readable.getReader();
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  chunks.push(value);
                }
                const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
                const combined = new Uint8Array(totalLen);
                let offset = 0;
                for (const chunk of chunks) {
                  combined.set(chunk, offset);
                  offset += chunk.length;
                }
                doc.content = new TextDecoder().decode(combined);
              }
            } catch (decompErr) {
              console.warn('[DB Worker] Decompression failed:', decompErr);
              doc.content = '';
            }
          }
          delete doc.content_compressed;
        }

        self.postMessage({ id, success: true, data: doc });
        break;
      }
      default:
        self.postMessage({ id, success: false, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || String(err) });
  }
};
