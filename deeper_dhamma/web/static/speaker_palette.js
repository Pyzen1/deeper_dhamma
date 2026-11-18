/**
 * Deeper Dhamma — Speaker Color Palette, Shared UI Helpers & Formatting Utilities
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const state = (DD.state = DD.state || {});
  const els = (DD.els = DD.els || {});
  const dbService = (DD.dbService = DD.dbService || (window.DeeperDhammaDB ? new window.DeeperDhammaDB() : null));

  // ==========================================================================
  // Fluent Emoji High Contrast Media Control SVG Icons (Wikipedia Reference)
  // https://en.wikipedia.org/wiki/Media_control_symbols
  // ==========================================================================
  const FLUENT_ICONS = {
    speakerHigh: `<svg class="fluent-icon fluent-speaker-high" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7.99756 23.001L16.6106 26.8308C17.7343 27.3704 19.0356 26.551 19.0356 25.3044V19.0768C20.6809 19.0289 21.9999 17.6801 21.9999 16.0232C21.9999 14.3663 20.6809 13.0175 19.0356 12.9696V6.49639C19.0356 5.25508 17.1704 4.70337 16.0474 5.23141L8.01223 9.0124V9H3.80282C2.80707 9 2 9.84705 2 10.8921V21.1079C2 22.153 2.80707 23 3.80282 23L7.99756 23.001ZM17.0356 7.03194V24.831L9.99756 21.7015L9.99758 10.2885L16.8909 7.04485L16.8926 7.04443C16.9011 7.04219 16.9385 7.03229 17.0069 7.03165C17.0165 7.03156 17.0261 7.03166 17.0356 7.03194Z" fill="currentColor"/><path d="M24.11 11.0695C23.9694 10.9151 23.8237 10.7676 23.6725 10.6276C23.035 10.0376 22 10.4914 22 11.3601V11.3876C22 11.6595 22.1181 11.9164 22.3175 12.1007C23.3031 13.0139 23.9212 14.3189 23.9212 15.7682C23.9212 17.2176 23.3037 18.5226 22.3175 19.4357C22.1119 19.6257 22 19.8964 22 20.1764C22 21.047 23.0369 21.4976 23.6756 20.9057C23.7419 20.8445 23.8069 20.782 23.8706 20.7176C25.2437 19.3445 25.9762 17.5014 25.9175 15.5514C25.8681 13.8932 25.2256 12.2976 24.11 11.0695Z" fill="currentColor"/><path d="M23.5063 7.97456C23.195 7.79455 23 7.46518 23 7.1058C23 6.3333 23.8369 5.85705 24.5056 6.24455C27.79 8.14705 30 11.6989 30 15.7683C30 19.8371 27.7906 23.3896 24.505 25.2921C23.8363 25.6796 22.9994 25.2027 22.9994 24.4302C22.9994 24.0714 23.1931 23.7427 23.5038 23.5627C24.1756 23.1739 24.8006 22.6952 25.3638 22.1321C27.0863 20.4096 28.0244 18.1121 27.9994 15.6721C27.9763 13.4202 27.1031 11.2471 25.56 9.60643C24.9475 8.95518 24.2556 8.40893 23.5063 7.97456Z" fill="currentColor"/></svg>`,
    speakerLow: `<svg class="fluent-icon fluent-speaker-low" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M16.6106 26.8308L7.99756 23.001L3.80282 23C2.80707 23 2 22.153 2 21.1079V10.8921C2 9.84705 2.80707 9 3.80282 9H8.01223V9.0124L16.0474 5.23141C17.1704 4.70337 19.0356 5.25508 19.0356 6.49639V12.9696C20.6809 13.0175 21.9999 14.3663 21.9999 16.0232C21.9999 17.6801 20.6809 19.0289 19.0356 19.0768V25.3044C19.0356 26.551 17.7343 27.3704 16.6106 26.8308ZM17.0356 24.831V7.03194C17.0261 7.03166 17.0165 7.03156 17.0069 7.03165C16.9385 7.03229 16.9011 7.04219 16.8926 7.04443L16.8909 7.04485L9.99758 10.2885L9.99756 21.7015L17.0356 24.831Z" fill="currentColor"/><path d="M24.11 11.0695C23.9694 10.9151 23.8237 10.7676 23.6725 10.6276C23.035 10.0376 22 10.4914 22 11.3601V11.3876C22 11.6595 22.1181 11.9164 22.3175 12.1007C23.3031 13.0139 23.9212 14.3189 23.9212 15.7682C23.9212 17.2176 23.3037 18.5226 22.3175 19.4357C22.1119 19.6257 22 19.8964 22 20.1764C22 21.047 23.0369 21.4976 23.6756 20.9057C23.7419 20.8445 23.8069 20.782 23.8706 20.7176C25.2437 19.3445 25.9762 17.5014 25.9175 15.5514C25.8681 13.8932 25.2256 12.2976 24.11 11.0695Z" fill="currentColor"/></svg>`,
    speakerMute: `<svg class="fluent-icon fluent-speaker-mute" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19.0356 20.7181L24.9692 26.6519C25.4342 27.1161 26.1866 27.1161 26.6509 26.6511C27.1151 26.1869 27.1151 25.4337 26.6509 24.9694L6.83142 5.14994C6.36718 4.6857 5.61394 4.6857 5.1497 5.14994C4.68545 5.61418 4.68545 6.36742 5.1497 6.83167L7.31807 9.00012H3.80282C2.80707 9.00012 2 9.84717 2 10.8922V21.108C2 22.1531 2.80707 23.0001 3.80282 23.0001L7.99756 23.0011L16.6106 26.8309C17.7343 27.3705 19.0356 26.5512 19.0356 25.3045V20.7181ZM17.0356 18.718V24.8311L9.99756 21.7016L9.99758 11.6797L17.0356 18.718Z" fill="currentColor"/><path d="M21.9999 16.0233C21.9999 16.5266 21.8782 17.0015 21.6626 17.4201L17.0356 12.7931V7.03206C17.0261 7.03178 17.0165 7.03168 17.0069 7.03177C16.9385 7.03241 16.9011 7.04231 16.8926 7.04455L16.8909 7.04498L13.0805 8.83799L11.5774 7.33491L16.0474 5.23153C17.1704 4.70349 19.0356 5.2552 19.0356 6.49651V12.9697C20.6809 13.0176 21.9999 14.3664 21.9999 16.0233Z" fill="currentColor"/></svg>`
  };

  function renderBookmarkRibbonSvg(isBookmarked = false) {
    return `<svg class="bookmark-ribbon-icon" viewBox="0 0 24 24" width="18" height="18" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${isBookmarked ? '1.5' : '2'}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5C6 2.67157 6.67157 2 7.5 2H16.5C17.3284 2 18 2.67157 18 3.5V21.25C18 21.7303 17.446 22.0028 17.0645 21.7099L12 17.8182L6.93553 21.7099C6.55403 22.0028 6 21.7303 6 21.25V3.5Z"></path></svg>`;
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
    FLUENT_ICONS,
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
