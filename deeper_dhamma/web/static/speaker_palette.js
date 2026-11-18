/**
 * Deeper Dhamma — Speaker Color Palette, Shared UI Helpers & Formatting Utilities
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const state = (DD.state = DD.state || {});
  const els = (DD.els = DD.els || {});
  const dbService = (DD.dbService = DD.dbService || (window.DeeperDhammaDB ? new window.DeeperDhammaDB() : null));

  function renderMaterialIcon(name, className = '', filled = false) {
    const classes = ['material-symbols-outlined'];
    if (className) classes.push(className);
    if (filled) classes.push('is-filled');
    return `<span class="${classes.join(' ')}" aria-hidden="true">${name}</span>`;
  }

  function renderBookmarkRibbonSvg(isBookmarked = false) {
    return `<span class="material-symbols-outlined bookmark-ribbon-icon${isBookmarked ? ' is-bookmarked' : ''}" aria-hidden="true">bookmark</span>`;
  }

  // ==========================================================================
  // Speaker Color & Palette Engine (Theravada Monastic Forest Tradition Inspired)
  // ==========================================================================

  function hashStringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash * 137.508) % 360; // Golden angle for even hue distribution
    return `hsl(${Math.round(h)}, 75%, 62%)`;
  }

  function getSpeakerColor(slug, displayName) {
    if (!slug && !displayName) return '#f59e0b';
    const cleanSlug = (slug || '').toLowerCase().trim();

    // 1. Direct match in loaded database teacher_map
    if (state.teachers && state.teachers[cleanSlug] && state.teachers[cleanSlug].color) {
      return state.teachers[cleanSlug].color;
    }

    // Check alias for Sujato
    if (cleanSlug === 'ajahn_sujato' && state.teachers && state.teachers['bhante_sujato']) {
      return state.teachers['bhante_sujato'].color;
    }

    // 2. Static monastic defaults for fallback / instant render
    const defaults = {
      'ajahn_brahm': '#f59e0b',
      'ajahn_brahmali': '#ea580c',
      'bhante_sujato': '#10b981',
      'ajahn_sujato': '#10b981',
      'ajahn_hasapanna': '#ec4899',
      'venerable_sunyo': '#eab308',
      'ayya_vayama': '#a855f7',
      'ajahn_khemavaro': '#14b8a6',
      'questioner': '#94a3b8',
      'unregistered_speaker': '#64748b',
      'unknown_teacher': '#64748b',
    };
    if (defaults[cleanSlug]) return defaults[cleanSlug];

    // 3. Name lookup in teacher_map
    if (displayName) {
      const lowerName = displayName.toLowerCase();
      if (lowerName.includes('question') || lowerName.includes('audience')) return '#94a3b8';
      for (const [s, data] of Object.entries(state.teachers || {})) {
        if (data.name && lowerName.includes(data.name.toLowerCase())) {
          return data.color;
        }
      }
    }

    // 4. Deterministic golden-ratio HSL generator
    return hashStringToColor(cleanSlug || displayName);
  }

  function getSpeakerInitials(name) {
    if (!name) return '🎙️';
    const lower = name.toLowerCase();
    if (lower.includes('question')) return '?';
    const words = name.replace(/^(ajahn|venerable|ven|bhante|ayya|ayye)\s+/i, '').split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    }
    if (words.length === 1 && words[0].length >= 2) {
      return words[0].slice(0, 2).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  /**
   * Splits a text string into sentences without dropping any characters or words.
   * Mirrors WordSync.splitSentences to prevent regex backtracking and text loss.
   */
  function splitSentences(text) {
    if (!text) return [];
    if (window.WordSync && typeof window.WordSync.splitSentences === 'function') {
      return window.WordSync.splitSentences(text);
    }
    const trimmed = text.trim();
    if (!trimmed) return [];

    const sents = [];
    let start = 0;
    let i = 0;
    const n = trimmed.length;

    while (i < n) {
      const ch = trimmed[i];

      // Check for sentence-ending punctuation marks
      if (ch === '.' || ch === '!' || ch === '?') {
        let j = i + 1;

        // Consume attached closing quotes and brackets (e.g. '"Let it go."' or '(notes).')
        while (
          j < n &&
          (trimmed[j] === '"' ||
            trimmed[j] === "'" ||
            trimmed[j] === '”' ||
            trimmed[j] === '’' ||
            trimmed[j] === ')' ||
            trimmed[j] === ']')
        ) {
          j++;
        }

        // True sentence boundaries occur at EOF or when immediately followed by whitespace.
        // Internal decimals (e.g. '6.15', '5.30', '3.14', '6 .15') are preserved without splitting.
        if (j >= n || /\s/.test(trimmed[j])) {
          const sent = trimmed.slice(start, j).trim();
          if (sent) {
            sents.push(sent);
          }

          // Advance past trailing inter-sentence whitespace
          while (j < n && /\s/.test(trimmed[j])) {
            j++;
          }
          start = j;
          i = j - 1;
        }
      }
      i++;
    }

    // Capture any remaining tail segment
    const rem = trimmed.slice(start).trim();
    if (rem) {
      sents.push(rem);
    }

    return sents.length > 0 ? sents : [trimmed];
  }

  function stripTeacherParenNote(str) {
    return String(str || '').replace(/\s*\([^)]*\)\s*$/g, '').trim();
  }

  function extractTeachers(item) {
    if (!item) return [{ name: 'BSWA Monastic', color: '#f59e0b', slug: 'bswa_monastic' }];

    const results = [];
    const seen = new Set();

    // 0. Prefer canonical teacher_slugs computed by worker (exact parity with filters)
    if (Array.isArray(item.teacher_slugs) && item.teacher_slugs.length > 0 && state.teachers && Object.keys(state.teachers).length > 0) {
      const nonUnknown = item.teacher_slugs.filter(s => s && s !== 'unknown_teacher' && s !== 'unregistered_speaker');
      const slugsToUse = nonUnknown.length > 0 ? nonUnknown : item.teacher_slugs;
      for (const slug of slugsToUse) {
        const reg = state.teachers[slug];
        if (reg && !seen.has(slug)) {
          seen.add(slug);
          results.push({
            name: reg.name,
            color: reg.color || getSpeakerColor(slug, reg.name),
            slug,
          });
        }
      }
      if (results.length > 0) return results;
    }

    const pushTeacherName = (rawName) => {
      const name = stripTeacherParenNote(rawName);
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const slug = key.replace(/[^a-z0-9]+/g, '_');
      results.push({
        name,
        color: getSpeakerColor(slug, name),
        slug,
      });
    };

    // 1. Combine identified_teachers (comma-separated) and multi-teacher primary_display
    const identified = (item.identified_teachers || '').trim();
    if (identified) {
      identified.split(/\s*,\s*/).filter(Boolean).forEach(pushTeacherName);
    }

    const teacherStr = (item.teacher || item.primary_display || '').trim();
    if (teacherStr && (/[&,/]|\band\b/i.test(teacherStr))) {
      teacherStr.split(/\s*(?:&|\band\b|,|\/)\s*/i).filter(Boolean).forEach(pushTeacherName);
    } else if (teacherStr && results.length === 0) {
      pushTeacherName(teacherStr);
    }

    // Filter out "Unknown Teacher" when at least one identified monastic is present
    const filteredResults = results.filter(r => r.name.toLowerCase() !== 'unknown teacher');
    if (filteredResults.length > 0) return filteredResults;
    if (results.length > 0) return results;

    // 2. Scan title and teacher string against known monastic teachers in database
    const textToScan = `${teacherStr} | ${item.title || ''}`.toLowerCase();
    for (const [slug, data] of Object.entries(state.teachers || {})) {
      if (data.role === 'unregistered' || slug === 'unknown_teacher' || slug === 'questioner') continue;
      const lowerName = data.name.toLowerCase();
      const words = lowerName.replace(/^(ajahn|venerable|ven|bhante|ayya|ayye)\s+/i, '').split(/\s+/);
      const coreName = words[words.length - 1];
      if (coreName && coreName.length >= 4 && new RegExp(`\\b${coreName}\\b`, 'i').test(textToScan)) {
        if (!seen.has(lowerName)) {
          seen.add(lowerName);
          results.push({
            name: data.name,
            color: data.color || '#f59e0b',
            slug
          });
        }
      }
    }

    // 3. Fallback: single teacher
    if (results.length === 0 && teacherStr) {
      results.push({
        name: teacherStr,
        color: getSpeakerColor(item.primary_teacher || item.teacher_slug, teacherStr),
        slug: (item.primary_teacher || item.teacher_slug || teacherStr).toLowerCase().replace(/[^a-z0-9]+/g, '_')
      });
    }

    return results.length > 0 ? results : [{
      name: 'BSWA Monastic',
      color: '#f59e0b',
      slug: 'bswa_monastic'
    }];
  }

  function renderTeacherBadgesHtml(item) {
    const teachers = extractTeachers(item);
    return teachers.map(t => `
      <span class="teacher-badge" style="--spk-color: ${t.color};" title="${escapeHtml(t.name)}">
        <span class="teacher-badge-dot"></span>
        ${escapeHtml(t.name)}
      </span>
    `).join(' ');
  }

  function formatEpisodeDateHtml(ep, className = '') {
    const epYear = ep && ep.year ? Number(ep.year) : 0;
    const dateStr = (ep && ep.date) ? String(ep.date) : '';
    const dateYear = /^\d{4}/.test(dateStr) ? Number(dateStr.slice(0, 4)) : 0;
    const clsAttr = className ? ` class="${className}"` : '';
    if (epYear > 0 && dateYear > 0 && epYear !== dateYear) {
      return `<span${clsAttr} title="Recorded year: ${epYear} • Podbean upload: ${escapeHtml(dateStr)}">📅 ${epYear}</span>`;
    }
    return `<span${clsAttr}>📅 ${escapeHtml(dateStr || (epYear ? String(epYear) : ''))}</span>`;
  }

  function foldCharForTitleMatch(ch) {
    return ch
      .replace(/[ŋŊ]/g, 'm')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function highlightTitleText(title, titleQuery, wholeWord = false) {
    const rawTitle = String(title || '');
    const rawQuery = String(titleQuery || '').trim();
    if (!rawTitle || !rawQuery) return escapeHtml(rawTitle);

    // Build folded string + character origin map
    let folded = '';
    const origStarts = [];
    const origEnds = [];
    for (let i = 0; i < rawTitle.length; ) {
      const cp = rawTitle.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const nextI = i + ch.length;
      const f = foldCharForTitleMatch(ch);
      for (let k = 0; k < f.length; k++) {
        folded += f[k];
        origStarts.push(i);
        origEnds.push(nextI);
      }
      i = nextI;
    }

    const positiveNeedles = [];
    const branches = rawQuery.split(/\s+OR\s+/);
    for (const branch of branches) {
      const tokens = branch.trim().match(/-?"[^"]+"|\S+/g) || [];
      for (let tok of tokens) {
        if (tok.startsWith('-')) continue;
        if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) {
          tok = tok.slice(1, -1);
        }
        let needle = '';
        for (const ch of tok) needle += foldCharForTitleMatch(ch);
        needle = needle.trim();
        if (needle) positiveNeedles.push(needle);
      }
    }

    if (positiveNeedles.length === 0) return escapeHtml(rawTitle);

    const intervals = [];
    const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const needle of Array.from(new Set(positiveNeedles))) {
      if (wholeWord) {
        const firstCh = needle[0];
        const lastCh = needle[needle.length - 1];
        const startBound = /[a-z]/.test(firstCh) ? '(?:^|[^a-z])' : (/[0-9]/.test(firstCh) ? '(?:^|[^0-9])' : '');
        const endBound = /[a-z]/.test(lastCh) ? '(?=$|[^a-z])' : (/[0-9]/.test(lastCh) ? '(?=$|[^0-9])' : '');
        const rx = new RegExp(`${startBound}(${escapeRx(needle)})${endBound}`, 'g');
        let m;
        while ((m = rx.exec(folded)) !== null) {
          const prefixLen = m[0].length - m[1].length;
          const fStart = m.index + prefixLen;
          const fEnd = fStart + m[1].length;
          if (fEnd > fStart && origStarts[fStart] !== undefined && origEnds[fEnd - 1] !== undefined) {
            intervals.push([origStarts[fStart], origEnds[fEnd - 1]]);
          }
          if (rx.lastIndex === m.index) rx.lastIndex++;
        }
      } else {
        let idx = folded.indexOf(needle);
        while (idx !== -1) {
          const fEnd = idx + needle.length;
          if (fEnd > idx && origStarts[idx] !== undefined && origEnds[fEnd - 1] !== undefined) {
            intervals.push([origStarts[idx], origEnds[fEnd - 1]]);
          }
          idx = folded.indexOf(needle, idx + needle.length);
        }
      }
    }

    if (intervals.length === 0) return escapeHtml(rawTitle);
    intervals.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const merged = [intervals[0]];
    for (let i = 1; i < intervals.length; i++) {
      const prev = merged[merged.length - 1];
      if (intervals[i][0] <= prev[1]) {
        prev[1] = Math.max(prev[1], intervals[i][1]);
      } else {
        merged.push(intervals[i]);
      }
    }

    let html = '';
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) html += escapeHtml(rawTitle.slice(cursor, start));
      html += `<mark class="title-match-mark">${escapeHtml(rawTitle.slice(start, end))}</mark>`;
      cursor = end;
    }
    if (cursor < rawTitle.length) html += escapeHtml(rawTitle.slice(cursor));
    return html;
  }

  // ==========================================================================
  // Timestamp & URL Parsing Helpers
  // ==========================================================================

  function parseTimestampToSeconds(val) {
    if (typeof val === 'number') return val;
    if (!val || typeof val !== 'string') return 0;
    const s = val.trim().toLowerCase();

    // 1. Colon format mm:ss or hh:mm:ss
    if (s.includes(':')) {
      const parts = s.split(':').map(Number);
      if (parts.some(isNaN)) return 0;
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    // 2. Unit format like 1h2m3s or 90s or 5m
    let totalSec = 0;
    let matchedUnit = false;
    const hMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
    if (hMatch) { totalSec += parseFloat(hMatch[1]) * 3600; matchedUnit = true; }
    const mMatch = s.match(/(\d+(?:\.\d+)?)\s*m/);
    if (mMatch) { totalSec += parseFloat(mMatch[1]) * 60; matchedUnit = true; }
    const sMatch = s.match(/(\d+(?:\.\d+)?)\s*s/);
    if (sMatch) { totalSec += parseFloat(sMatch[1]); matchedUnit = true; }
    if (matchedUnit) return totalSec;

    // 3. Fallback raw integer / float
    const num = parseFloat(s);
    return isNaN(num) ? 0 : Math.max(0, num);
  }

  // ==========================================================================
  // Toast & Clipboard Helpers
  // ==========================================================================

  function showToast(message) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      toast.className = 'app-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span class="toast-icon">✓</span> <span>${escapeHtml(message)}</span>`;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  function copyTextToClipboard(text, successMsg = 'Link copied to clipboard!') {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(successMsg);
      }).catch(() => {
        fallbackCopyText(text, successMsg);
      });
    } else {
      fallbackCopyText(text, successMsg);
    }
  }

  function fallbackCopyText(text, successMsg) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      showToast(successMsg);
    } catch (err) {
      window.prompt('Copy this link:', text);
    }
    document.body.removeChild(textArea);
  }

  function getShareBaseUrl() {
    const cleanPath = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/404\.html$/, '').replace(/\/$/, '');
    return `${window.location.origin}${cleanPath}`;
  }

  function resetFloatingPanelPosition(panel) {
    if (!panel) return;
    panel.style.left = '';
    panel.style.right = '';
    panel.style.maxWidth = '';
  }

  function clampFloatingPanelToViewport(wrapper, panel, margin = 8) {
    if (!wrapper || !panel) return;
    resetFloatingPanelPosition(panel);

    const vw = document.documentElement.clientWidth || window.innerWidth;
    const maxW = Math.max(160, vw - margin * 2);
    if (panel.offsetWidth > maxW) {
      panel.style.maxWidth = `${maxW}px`;
    }

    const panelW = panel.offsetWidth;
    if (!panelW) return;

    const wRect = wrapper.getBoundingClientRect();
    const r = panel.getBoundingClientRect();
    const animPad = Math.ceil(panelW * 0.02) + 1;

    // Preserve default CSS right/left anchoring if it already fits with margin.
    if (r.left - animPad >= margin && r.right + animPad <= vw - margin) {
      return;
    }

    panel.style.left = '0px';
    panel.style.right = 'auto';
    const baseLeft = wRect.left;
    const baseRight = baseLeft + panelW;
    const minShift = margin - baseLeft;
    const maxShift = (vw - margin) - baseRight;

    let shift = 0;
    if (baseRight > vw - margin) {
      shift = Math.max(minShift, maxShift);
    } else if (baseLeft < margin) {
      shift = minShift;
    }
    if (shift !== 0) {
      panel.style.left = `${Math.round(shift)}px`;
    }
  }

  function getScrollContainer() {
    return document.getElementById('main-content') || window;
  }

  function getScrollTopPos() {
    const sc = getScrollContainer();
    return sc === window ? (window.scrollY || window.pageYOffset || 0) : sc.scrollTop;
  }

  function scrollContentTo(top, behavior = 'auto') {
    const sc = getScrollContainer();
    if (sc === window) {
      window.scrollTo({ top, behavior });
    } else if (typeof sc.scrollTo === 'function') {
      sc.scrollTo({ top, behavior });
    } else {
      sc.scrollTop = top;
    }
  }

  function isCompanionBottomSheet() {
    if (!els.lexCompanion) return false;
    if (els.lexMobileTicker && window.getComputedStyle(els.lexMobileTicker).display !== 'none') {
      return true;
    }
    const viewportW = document.documentElement.clientWidth || window.innerWidth;
    return viewportW <= 1100;
  }

  function scrollElementIntoReadingZone(el, behavior = 'auto') {
    if (!el) return;
    if (window.WordSync && typeof window.WordSync.scrollToElement === 'function') {
      window.WordSync.scrollToElement(el, { behavior });
      return;
    }
    const sc = getScrollContainer();
    const mainRect = sc !== window ? sc.getBoundingClientRect() : null;
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const topFloor = mainRect ? Math.max(0, mainRect.top) : 0;
    const bottomLimit = mainRect ? Math.min(viewportH, mainRect.bottom) : viewportH;
    const toolbar = document.getElementById('transcript-sticky-toolbar');
    const toolbarBottom = toolbar ? Math.max(topFloor, toolbar.getBoundingClientRect().bottom) : topFloor;
    const rect = el.getBoundingClientRect();
    const availableH = Math.max(80, bottomLimit - toolbarBottom);
    const desiredTopInViewport = toolbarBottom + Math.min(availableH * 0.35, Math.max(20, (availableH - rect.height) / 2));
    const targetScrollY = Math.max(0, getScrollTopPos() + (rect.top - desiredTopInViewport));
    scrollContentTo(targetScrollY, behavior);
  }

  // ==========================================================================
  // Formatting Utilities
  // ==========================================================================

  function formatSeconds(sec) {
    if (isNaN(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const remSec = s % 60;
    const h = Math.floor(m / 60);
    const remMin = m % 60;

    const padSec = remSec < 10 ? `0${remSec}` : remSec;
    if (h > 0) {
      const padMin = remMin < 10 ? `0${remMin}` : remMin;
      return `${h}:${padMin}:${padSec}`;
    }
    return `${m}:${padSec}`;
  }

  function getPodbeanUrl(permalink) {
    if (!permalink) return '#';
    if (permalink.startsWith('http://') || permalink.startsWith('https://')) {
      return permalink;
    }
    const cleanPath = permalink.startsWith('/') ? permalink : `/${permalink}`;
    const withSlash = cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
    return `https://deeperdhamma.podbean.com${withSlash}`;
  }

  function formatTranscriptParagraphs(rawText) {
    if (!rawText) return '';
    const trimmed = rawText.trim();
    if (!trimmed) return '';

    // If text already contains explicit paragraphs
    if (trimmed.includes('\n\n')) {
      return trimmed
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => `<p class="turn-p">${escapeHtml(p)}</p>`)
        .join('');
    }

    // Split on sentence boundaries (period/question/exclamation followed by space or end)
    const rawSentences = splitSentences(trimmed);
    const paragraphs = [];
    let currentChunk = [];
    let wordCount = 0;

    rawSentences.forEach(s => {
      const sent = s.trim();
      if (!sent) return;
      currentChunk.push(sent);
      wordCount += sent.split(/\s+/).length;

      // Create natural paragraph breaks every 50-75 words or ~3 sentences
      if (wordCount >= 50 || currentChunk.length >= 3) {
        paragraphs.push(currentChunk.join(' '));
        currentChunk = [];
        wordCount = 0;
      }
    });

    if (currentChunk.length > 0) {
      paragraphs.push(currentChunk.join(' '));
    }

    if (paragraphs.length === 0) {
      return `<p class="turn-p">${escapeHtml(trimmed)}</p>`;
    }

    return paragraphs
      .map(p => `<p class="turn-p">${escapeHtml(p)}</p>`)
      .join('');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  Object.assign(DD, {
    renderMaterialIcon,
    renderBookmarkRibbonSvg,
    hashStringToColor,
    getSpeakerColor,
    getSpeakerInitials,
    splitSentences,
    stripTeacherParenNote,
    extractTeachers,
    renderTeacherBadgesHtml,
    formatEpisodeDateHtml,
    foldCharForTitleMatch,
    highlightTitleText,
    parseTimestampToSeconds,
    showToast,
    copyTextToClipboard,
    fallbackCopyText,
    getShareBaseUrl,
    resetFloatingPanelPosition,
    clampFloatingPanelToViewport,
    getScrollContainer,
    getScrollTopPos,
    scrollContentTo,
    isCompanionBottomSheet,
    scrollElementIntoReadingZone,
    formatSeconds,
    getPodbeanUrl,
    formatTranscriptParagraphs,
    escapeHtml,
  });
})();
