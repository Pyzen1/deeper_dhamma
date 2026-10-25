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

// ============================================================================
// IndexedDB Persistence Helpers
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

async function setCachedDatabase(key, version, buffer) {
  try {
    const idb = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put({ key, version, buffer, updatedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[DB Worker] IndexedDB write failed:', err);
  }
}

// ============================================================================
// Database Initialization & Deserialization
// ============================================================================

async function fetchRemoteVersion(dbUrl) {
  try {
    const res = await fetch(dbUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-99' },
      cache: 'no-cache',
    });
    if (res.status === 206 || res.status === 200) {
      const headerBuf = await res.arrayBuffer();
      if (headerBuf.byteLength >= 64) {
        const view = new DataView(headerBuf);
        const version = view.getUint32(60, false); // big-endian
        return { version, fullBuffer: res.status === 200 ? headerBuf : null };
      }
    }
  } catch (err) {
    console.warn('[DB Worker] Header Range probe failed:', err);
  }
  return { version: 0, fullBuffer: null };
}

async function initDatabase(dbUrl = 'dhamma_web.db') {
  // 1. Initialize SQLite WASM Module if not already loaded
  if (!sqlite3) {
    sqlite3 = await sqlite3InitModule({
      print: (text) => console.log('[SQLite]', text),
      printErr: (err) => console.error('[SQLite Error]', err),
    });
  }

  // 2. Check remote version header via Range probe
  const { version: remoteVersion, fullBuffer: probeBuffer } = await fetchRemoteVersion(dbUrl);
  const cached = await getCachedDatabase('dhamma_web');

  let dbBuffer = null;
  let isFromCache = false;

  if (cached && cached.version && cached.version >= remoteVersion && cached.buffer) {
    // Cache is up-to-date!
    console.log(`[DB Worker] Using cached database (v${cached.version}) from IndexedDB.`);
    dbBuffer = cached.buffer;
    currentDbVersion = cached.version;
    isFromCache = true;
  } else {
    // Need full download
    console.log(`[DB Worker] Downloading updated database from ${dbUrl} (remote v${remoteVersion})...`);
    if (probeBuffer && probeBuffer.byteLength > 1000) {
      dbBuffer = probeBuffer;
    } else {
      const res = await fetch(dbUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch database from ${dbUrl} (status ${res.status})`);
      }
      dbBuffer = await res.arrayBuffer();
    }

    // Extract version if remote header probe was 0
    if (!remoteVersion && dbBuffer.byteLength >= 64) {
      const view = new DataView(dbBuffer);
      currentDbVersion = view.getUint32(60, false);
    } else {
      currentDbVersion = remoteVersion;
    }

    // Save to IndexedDB
    await setCachedDatabase('dhamma_web', currentDbVersion, dbBuffer);
  }

  // 3. Deserialize buffer into in-memory SQLite connection
  const uint8Array = new Uint8Array(dbBuffer);
  const pBuffer = sqlite3.wasm.allocFromTypedArray(uint8Array);
  
  if (db) {
    try { db.close(); } catch (_) {}
  }

  db = new sqlite3.oo1.DB();
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer,
    'main',
    pBuffer,
    uint8Array.byteLength,
    uint8Array.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  );

  if (rc !== 0) {
    throw new Error(`sqlite3_deserialize failed with code ${rc}`);
  }

  console.log(`[DB Worker] Database ready: v${currentDbVersion}, ${uint8Array.byteLength} bytes.`);
  return { version: currentDbVersion, cached: isFromCache, size: uint8Array.byteLength };
}

// ============================================================================
// Query Execution Helpers
// ============================================================================

function queryAll(sql, bind = []) {
  if (!db) throw new Error('Database is not initialized');
  const rows = [];
  db.exec({
    sql,
    bind,
    rowMode: 'object',
    resultRows: rows,
  });
  return rows;
}

function queryOne(sql, bind = []) {
  const rows = queryAll(sql, bind);
  return rows.length > 0 ? rows[0] : null;
}

// ============================================================================
// Service Handlers
// ============================================================================

function handleGetStats() {
  const totalEp = queryOne('SELECT COUNT(*) AS c FROM episodes;');
  const transEp = queryOne('SELECT COUNT(*) AS c FROM episodes WHERE is_transcribed = 1;');
  const segs = queryOne('SELECT COUNT(*) AS c FROM speech_segments;');
  const dur = queryOne('SELECT SUM(duration_sec) AS s FROM episodes WHERE is_transcribed = 1;');

  const teachers = queryAll(`
    SELECT display_name 
    FROM teachers 
    WHERE default_role != 'unregistered' AND slug != 'unknown_teacher' 
    ORDER BY display_name;
  `).map((r) => r.display_name);

  const years = queryAll(`
    SELECT DISTINCT year 
    FROM episodes 
    WHERE is_transcribed = 1 AND year IS NOT NULL 
    ORDER BY year DESC;
  `).map((r) => r.year);

  return {
    total_episodes: totalEp ? totalEp.c : 0,
    transcribed_episodes: transEp ? transEp.c : 0,
    transcribed_hours: dur && dur.s ? Math.round((dur.s / 3600.0) * 10) / 10 : 0.0,
    total_segments: segs ? segs.c : 0,
    teachers,
    years,
    db_version: currentDbVersion,
  };
}

function handleGetEpisodes({ teacher, year, transcribedOnly = true, limit = 50, offset = 0 }) {
  let sql = `
    SELECT id, title, date, year, primary_display AS teacher, media_url, permalink, duration_sec, is_transcribed 
    FROM episodes 
    WHERE 1=1
  `;
  const params = [];

  if (transcribedOnly) {
    sql += ' AND is_transcribed = 1';
  }
  if (year) {
    sql += ' AND year = ?';
    params.push(Number(year));
  }
  if (teacher) {
    sql += ' AND (primary_display LIKE ? OR id IN (SELECT episode_id FROM episode_teachers et JOIN teachers t ON et.teacher_id = t.id WHERE t.display_name LIKE ?))';
    params.push(`%${teacher}%`, `%${teacher}%`);
  }

  sql += ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?;';
  params.push(limit, offset);

  const episodes = queryAll(sql, params);

  // Count total
  let countSql = 'SELECT COUNT(*) AS c FROM episodes WHERE 1=1';
  const countParams = [];
  if (transcribedOnly) countSql += ' AND is_transcribed = 1';
  if (year) { countSql += ' AND year = ?'; countParams.push(Number(year)); }
  if (teacher) {
    countSql += ' AND (primary_display LIKE ? OR id IN (SELECT episode_id FROM episode_teachers et JOIN teachers t ON et.teacher_id = t.id WHERE t.display_name LIKE ?))';
    countParams.push(`%${teacher}%`, `%${teacher}%`);
  }
  const countRow = queryOne(countSql, countParams);

  return {
    episodes,
    total: countRow ? countRow.c : episodes.length,
    limit,
    offset,
  };
}

function handleGetEpisode(episodeId) {
  const ep = queryOne('SELECT * FROM episodes WHERE id = ?;', [episodeId]);
  if (!ep) return null;

  const segments = queryAll(`
    SELECT turn_index, start_sec, end_sec, speaker_slug, speaker_display, text 
    FROM speech_segments 
    WHERE episode_id = ? 
    ORDER BY turn_index ASC;
  `, [episodeId]);

  return {
    ...ep,
    segments,
  };
}

function handleSearchFTS({ query, exact = false, teacher, year, limit = 30 }) {
  const t0 = performance.now();
  const cleanQuery = (query || '').replace(/\\"/g, '"').trim();
  const words = cleanQuery.match(/[a-zA-Z0-9]+/g) || [];

  if (!words.length) {
    return { query: cleanQuery, results: [], count: 0, elapsed_ms: 0, meta: { tier: 'none' } };
  }

  const baseSql = `
    SELECT 
      e.id AS episode_id,
      e.title,
      e.date,
      e.primary_display AS teacher,
      e.media_url,
      e.permalink,
      s.start_sec,
      s.end_sec,
      snippet(transcripts_fts, 1, '<b>', '</b>', '...', 15) AS snippet_text
    FROM transcripts_fts
    JOIN speech_segments s ON transcripts_fts.rowid = s.id
    JOIN episodes e ON s.episode_id = e.id
    WHERE transcripts_fts MATCH ?
    ORDER BY rank
    LIMIT ?;
  `;

  function tryFtsQuery(qStr) {
    try {
      return queryAll(baseSql, [qStr, limit]);
    } catch (_) {
      return [];
    }
  }

  let results = [];
  let meta = { tier: 'exact', effective_query: cleanQuery, corrected: false };

  // Explicit operators check
  const hasExplicitSyntax = [' AND ', ' OR ', ' NOT ', 'NEAR('].some((op) => cleanQuery.includes(op)) ||
    (cleanQuery.startsWith('"') && cleanQuery.endsWith('"') && cleanQuery.length > 2);

  if (hasExplicitSyntax) {
    results = tryFtsQuery(cleanQuery);
    if (!results.length) {
      results = tryFtsQuery(`"${cleanQuery.replace(/"/g, '""')}"`);
    }
    meta.tier = 'explicit';
  } else {
    // Tier 1: Exact phrase or word
    const t1 = words.length > 1 ? `"${cleanQuery}"` : words[0];
    results = tryFtsQuery(t1);
    meta.tier = words.length > 1 ? 'exact_phrase' : 'exact_word';

    // Tier 2: Proximity (NEAR)
    if (!results.length && !exact && words.length > 1) {
      const t2 = `NEAR(${words.join(' ')}, 15)`;
      results = tryFtsQuery(t2);
      if (results.length) {
        meta.tier = 'proximity';
        meta.effective_query = t2;
      }
    }

    // Tier 3: Prefix matching
    if (!results.length && !exact) {
      const t3 = words.map((w) => `${w}*`).join(' AND ');
      results = tryFtsQuery(t3);
      if (results.length) {
        meta.tier = 'prefix';
        meta.effective_query = t3;
      }
    }

    // Tier 4: Any word ranked match
    if (!results.length && !exact && words.length > 1) {
      const t5 = words.join(' OR ');
      results = tryFtsQuery(t5);
      if (results.length) {
        meta.tier = 'any_word';
        meta.effective_query = t5;
      }
    }
  }

  // Filter in JS by teacher or year if requested
  if (teacher) {
    const tf = teacher.toLowerCase();
    results = results.filter((r) => (r.teacher || '').toLowerCase().includes(tf));
  }
  if (year) {
    const yStr = String(year);
    results = results.filter((r) => (r.date || '').startsWith(yStr));
  }

  const elapsed_ms = Math.round((performance.now() - t0) * 100) / 100;

  return {
    query: cleanQuery,
    results,
    count: results.length,
    elapsed_ms,
    meta,
  };
}

function handleSearchLexicon(q, limit = 10) {
  const clean = (q || '').trim();
  if (!clean) return [];

  try {
    return queryAll(`
      SELECT t.* 
      FROM fts_terms f
      JOIN v_terms t ON f.rowid = t.id
      WHERE fts_terms MATCH ?
      ORDER BY rank
      LIMIT ?;
    `, [`${clean}*`, limit]);
  } catch (_) {
    return queryAll(`
      SELECT * FROM v_terms 
      WHERE pali_plain LIKE ? OR english_description LIKE ?
      LIMIT ?;
    `, [`%${clean}%`, `%${clean}%`, limit]);
  }
}

function handleLookupLexicon(term) {
  const clean = (term || '').trim();
  if (!clean) return null;
  return queryOne(`
    SELECT * FROM v_terms 
    WHERE pali_plain = ? OR pali_diacritic = ? COLLATE NOCASE 
    LIMIT 1;
  `, [clean, clean]);
}

// ============================================================================
// Worker Message Router
// ============================================================================

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};

  try {
    switch (type) {
      case 'init': {
        const res = await initDatabase(payload && payload.dbUrl);
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
        const ep = handleGetEpisode(payload && payload.episodeId);
        self.postMessage({ id, success: true, data: ep });
        break;
      }
      case 'search': {
        const results = handleSearchFTS(payload || {});
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
      default:
        self.postMessage({ id, success: false, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || String(err) });
  }
};
