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
    const url = dbUrl + (dbUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-99' },
      cache: 'no-store',
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

  if (cached && cached.version && remoteVersion && cached.version === remoteVersion && cached.buffer) {
    // Cache is strictly up-to-date!
    console.log(`[DB Worker] Using cached database (v${cached.version}) from IndexedDB.`);
    dbBuffer = cached.buffer;
    currentDbVersion = cached.version;
    isFromCache = true;
  } else {
    // Need full download
    console.log(`[DB Worker] Downloading updated database from ${dbUrl} (cached v${cached ? cached.version : 'none'} vs remote v${remoteVersion})...`);
    if (probeBuffer && probeBuffer.byteLength > 1000) {
      dbBuffer = probeBuffer;
    } else {
      const fetchUrl = dbUrl + (dbUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
      const res = await fetch(fetchUrl, { cache: 'no-store' });
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

  // Initialize in-memory vocabulary cache for instant typo correction
  initVocabCache();

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

  const teachersList = queryAll(`
    SELECT slug, display_name, color, default_role 
    FROM teachers 
    ORDER BY display_name;
  `);

  const teacherMap = {};
  teachersList.forEach((t) => {
    teacherMap[t.slug] = {
      name: t.display_name,
      color: t.color || '#f59e0b',
      role: t.default_role
    };
  });

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
    teachers: teachersList.filter((r) => r.default_role !== 'unregistered' && r.slug !== 'unknown_teacher').map((r) => r.display_name),
    teacher_map: teacherMap,
    years,
    db_version: currentDbVersion,
  };
}

function handleGetEpisodes({ teacher, year, startDate, endDate, sort = 'date_desc', transcribedOnly = true, limit = 50, offset = 0 }) {
  let sql = `
    SELECT id, title, date, year, primary_teacher, primary_display AS teacher, identified_teachers, media_url, permalink, duration_sec, is_transcribed 
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
  if (startDate) {
    sql += ' AND date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND date <= ?';
    params.push(endDate);
  }
  if (teacher) {
    sql += ' AND (primary_display LIKE ? OR id IN (SELECT episode_id FROM episode_teachers et JOIN teachers t ON et.teacher_id = t.id WHERE t.display_name LIKE ?))';
    params.push(`%${teacher}%`, `%${teacher}%`);
  }

  let orderBy = ' ORDER BY date DESC, id DESC';
  if (sort === 'date_asc') {
    orderBy = ' ORDER BY date ASC, id ASC';
  } else if (sort === 'duration_desc') {
    orderBy = ' ORDER BY duration_sec DESC, date DESC';
  } else if (sort === 'duration_asc') {
    orderBy = ' ORDER BY duration_sec ASC, date ASC';
  }
  sql += orderBy;

  if (limit > 0) {
    sql += ' LIMIT ? OFFSET ?;';
    params.push(limit, offset);
  } else {
    sql += ';';
  }

  const episodes = queryAll(sql, params);

  // Count total
  let countSql = 'SELECT COUNT(*) AS c FROM episodes WHERE 1=1';
  const countParams = [];
  if (transcribedOnly) countSql += ' AND is_transcribed = 1';
  if (year) { countSql += ' AND year = ?'; countParams.push(Number(year)); }
  if (startDate) { countSql += ' AND date >= ?'; countParams.push(startDate); }
  if (endDate) { countSql += ' AND date <= ?'; countParams.push(endDate); }
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

const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such',
  'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this',
  'to', 'was', 'will', 'with', 'you', 'your'
]);

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
  return topCombos.map((clause) => `(${clause.map((w) => `${w}*`).join(' AND ')})`).join(' OR ');
}

function handleSearchFTS({ query, exact = false, teacher, year, startDate, endDate, sort = 'rank', limit = 500 }) {
  const t0 = performance.now();
  const cleanQuery = (query || '').replace(/\\"/g, '"').trim();
  if (!cleanQuery) {
    return { query: cleanQuery, results: [], count: 0, elapsed_ms: 0, meta: { tier: 'none' } };
  }

  // Unicode-aware word tokenization
  const rawTokens = cleanQuery.match(/[\p{L}\p{N}]+/gu) || [];
  if (!rawTokens.length) {
    return { query: cleanQuery, results: [], count: 0, elapsed_ms: 0, meta: { tier: 'none' } };
  }

  const words = rawTokens.map((w) => foldDiacritics(w)).filter(Boolean);
  if (!words.length) {
    return { query: cleanQuery, results: [], count: 0, elapsed_ms: 0, meta: { tier: 'none' } };
  }

  const baseSql = `
    SELECT 
      e.id AS episode_id,
      e.title,
      e.date,
      e.duration_sec,
      e.primary_teacher AS teacher_slug,
      e.primary_display AS teacher,
      e.identified_teachers,
      e.media_url,
      e.permalink,
      s.turn_index,
      s.speaker_slug,
      s.speaker_display,
      s.start_sec,
      s.end_sec,
      s.text,
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
  let meta = {
    tier: 'exact',
    original_query: cleanQuery,
    effective_query: cleanQuery,
    corrected: false,
  };

  // 0. Explicit operators check
  const hasExplicitSyntax = [' AND ', ' OR ', ' NOT ', 'NEAR('].some((op) => cleanQuery.includes(op)) ||
    (cleanQuery.startsWith('"') && cleanQuery.endsWith('"') && cleanQuery.length > 2);

  if (hasExplicitSyntax) {
    results = tryFtsQuery(cleanQuery);
    if (!results.length) {
      results = tryFtsQuery(`"${cleanQuery.replace(/"/g, '""')}"`);
    }
    meta.tier = 'explicit';
  } else {
    // Tier 1: Exact Phrase / Exact Word
    const t1 = words.length > 1 ? `"${words.join(' ')}"` : words[0];
    results = tryFtsQuery(t1);
    meta.tier = words.length > 1 ? 'exact_phrase' : 'exact_word';

    // Tier 2: Proximity (NEAR) - words within 15 words of each other
    if (!results.length && !exact && words.length > 1) {
      const t2 = `NEAR(${words.join(' ')}, 15)`;
      results = tryFtsQuery(t2);
      if (results.length) {
        meta.tier = 'proximity';
        meta.effective_query = t2;
      }
    }

    // Tier 3: Prefix AND matching (word1* AND word2*)
    if (!results.length && !exact) {
      const t3 = words.map((w) => `${w}*`).join(' AND ');
      results = tryFtsQuery(t3);
      if (results.length) {
        meta.tier = 'prefix';
        meta.effective_query = t3;
      }
    }

    // Tier 4: Fuzzy Auto-Correction (Damerau-Levenshtein in browser worker)
    const correctedWords = words.map((w) => correctFuzzyWord(w));
    const isCorrected = correctedWords.some((cw, i) => cw !== words[i]);
    const correctedPhrase = correctedWords.join(' ');

    if (!results.length && !exact && isCorrected) {
      // 4a: Corrected exact phrase
      const t4Phrase = words.length > 1 ? `"${correctedPhrase}"` : correctedWords[0];
      results = tryFtsQuery(t4Phrase);

      // 4b: Corrected proximity
      if (!results.length && words.length > 1) {
        const t4Near = `NEAR(${correctedPhrase}, 15)`;
        results = tryFtsQuery(t4Near);
      }

      // 4c: Corrected prefix
      if (!results.length) {
        const t4Prefix = correctedWords.map((w) => `${w}*`).join(' AND ');
        results = tryFtsQuery(t4Prefix);
      }

      if (results.length) {
        meta.tier = 'fuzzy';
        meta.corrected = true;
        meta.effective_query = correctedPhrase;
      }
    }

    // Tier 5: Multi-Word Soft AND / Quorum Matching (e.g. 2 of 3 words)
    if (!results.length && !exact && words.length >= 3) {
      const wordsToQuorum = isCorrected ? correctedWords : words;
      const quorumQuery = generateQuorumQueries(wordsToQuorum);
      if (quorumQuery) {
        results = tryFtsQuery(quorumQuery);
        if (results.length) {
          meta.tier = 'quorum';
          meta.effective_query = `${wordsToQuorum.length - 1} of ${wordsToQuorum.length} words`;
          if (isCorrected) meta.corrected = true;
        }
      }
    }

    // Tier 6: Filtered Any-Word Match (Filtered OR)
    if (!results.length && !exact && words.length > 1) {
      const baseWords = isCorrected ? correctedWords : words;
      const contentWords = baseWords.filter((w) => !SEARCH_STOPWORDS.has(w));
      const wordsToUse = contentWords.length > 0 ? contentWords : baseWords;
      const t6 = wordsToUse.map((w) => `${w}*`).join(' OR ');
      results = tryFtsQuery(t6);
      if (results.length) {
        meta.tier = 'any_word';
        meta.effective_query = t6;
        if (isCorrected) meta.corrected = true;
      }
    }
  }

  // Filter in JS by teacher, year, or date range if requested
  if (teacher) {
    const tf = teacher.toLowerCase();
    results = results.filter((r) => (r.teacher || '').toLowerCase().includes(tf));
  }
  if (year) {
    const yStr = String(year);
    results = results.filter((r) => (r.date || '').startsWith(yStr));
  }
  if (startDate) {
    results = results.filter((r) => (r.date || '') >= startDate);
  }
  if (endDate) {
    results = results.filter((r) => (r.date || '') <= endDate);
  }

  // Sort if requested
  if (sort === 'date_asc') {
    results.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.start_sec - b.start_sec);
  } else if (sort === 'date_desc') {
    results.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.start_sec - b.start_sec);
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
    whereParts.push(`(translation_brahm IS NOT NULL OR category != 'sutta_canon' OR pali_plain IN (${placeholders}))`);
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
      case 'get_lexicon_page': {
        const pageData = handleGetLexiconPage(payload || {});
        self.postMessage({ id, success: true, data: pageData });
        break;
      }
      default:
        self.postMessage({ id, success: false, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || String(err) });
  }
};
