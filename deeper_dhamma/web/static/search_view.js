/**
 * Deeper Dhamma — Full-Text Search Execution & Results Renderer
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const {
    state,
    els,
    dbService,
    BookmarkStore,
    escapeHtml,
    formatEpisodeDateHtml,
    formatSeconds,
    getPodbeanUrl,
    renderBookmarkRibbonSvg,
    renderTeacherBadgesHtml,
    splitSentences,
  } = DD;
  const attachCardEventListeners = (...args) => DD.attachCardEventListeners(...args);
  const openTranscriptDrawer = (...args) => DD.openTranscriptDrawer(...args);
  const switchTab = (...args) => DD.switchTab(...args);

  // ==========================================================================
  // Full-Text Search Execution
  // ==========================================================================

  async function executeSearch(query, options = {}) {
    state.currentQuery = query;
    if (!options.keepPage) {
      state.search.offset = 0;
    }
    const teacherVal = (els.teacherFilter && els.teacherFilter.value) || '';
    const yearVal = (els.yearFilter && els.yearFilter.value) || '';
    const startDateVal = (els.startDateInput && els.startDateInput.value) || '';
    const endDateVal = (els.endDateInput && els.endDateInput.value) || '';
    const sortVal = (els.sortOrderSelect && els.sortOrderSelect.value) || 'rank';

    const hasFilters = Boolean(
      teacherVal ||
      (state.dateFilterMode === 'year' && yearVal) ||
      (state.dateFilterMode === 'range' && (startDateVal || endDateVal)) ||
      (sortVal && sortVal !== 'rank' && sortVal !== 'date_desc')
    );

    // If no text query and no filters, show empty state
    if (!query && !hasFilters) {
      els.searchEmptyState.style.display = 'block';
      els.searchResultsList.style.display = 'none';
      els.searchMetaBar.style.display = 'none';
      if (els.searchPagination) els.searchPagination.style.display = 'none';
      if (els.filteredArchiveDropdownWrapper) {
        els.filteredArchiveDropdownWrapper.style.display = 'none';
      }
      els.searchCountBadge.textContent = '0';
      state.currentFilteredTalks = [];
      state.search.totalEpisodes = 0;
      state.search.totalSegments = 0;
      state.search.filteredEpisodeIds = [];
      state.search.filteredFilterOpts = null;
      if (els.filteredArchiveCount) els.filteredArchiveCount.textContent = '0';
      if (els.btnDownloadFilteredArchive) els.btnDownloadFilteredArchive.disabled = true;

      if (!options.skipHistory && state.activeTab === 'search-view') {
        if (window.location.hash !== '#search') {
          window.history.replaceState({ route: '#search' }, '', '#search');
        }
      }
      return;
    }

    // Make sure we are on search tab without pushing a duplicate state
    switchTab('search-view', { skipHistory: true });

    if (!options.skipHistory) {
      const searchHash = query ? `#search?q=${encodeURIComponent(query)}` : '#search';
      if (window.location.hash !== searchHash) {
        if (options.pushHistory) {
          state.historyDepth++;
          window.history.pushState({ route: searchHash }, '', searchHash);
        } else {
          window.history.replaceState({ route: searchHash }, '', searchHash);
        }
      }
    }

    // Case 1: Search query provided (FTS search, 50 talks per page)
    if (query) {
      state.search.filteredFilterOpts = null;
      const searchOpts = {
        episodeLimit: state.search.limit,
        offset: state.search.offset,
        exact: els.exactCheckbox.checked,
        sort: sortVal,
      };

      if (teacherVal) searchOpts.teacher = teacherVal;
      if (state.dateFilterMode === 'year' && yearVal) searchOpts.year = yearVal;
      if (state.dateFilterMode === 'range') {
        if (startDateVal) searchOpts.startDate = startDateVal;
        if (endDateVal) searchOpts.endDate = endDateVal;
      }

      try {
        const data = await dbService.search(query, searchOpts);
        renderSearchResults(data);
      } catch (err) {
        console.error('Search failed:', err);
      }
      return;
    }

    // Case 2: No search query, but filters active (Browse by Filter, 50 talks per page)
    try {
      const filterOpts = {
        transcribedOnly: true,
        limit: state.search.limit,
        offset: state.search.offset,
        sort: sortVal === 'rank' ? 'date_desc' : sortVal,
      };
      if (teacherVal) filterOpts.teacher = teacherVal;
      if (state.dateFilterMode === 'year' && yearVal) filterOpts.year = yearVal;
      if (state.dateFilterMode === 'range') {
        if (startDateVal) filterOpts.startDate = startDateVal;
        if (endDateVal) filterOpts.endDate = endDateVal;
      }

      state.search.filteredFilterOpts = filterOpts;
      state.search.filteredEpisodeIds = [];
      const data = await dbService.getEpisodes(filterOpts);
      renderFilterResults(data);
    } catch (err) {
      console.error('Filter search failed:', err);
    }
  }

  function updateSearchPagination(totalEpisodes, shownCount) {
    if (!els.searchPagination) return;
    const limit = state.search.limit || 50;
    const offset = state.search.offset || 0;
    const total = Number(totalEpisodes) || 0;

    if (total <= limit || shownCount === 0) {
      els.searchPagination.style.display = 'none';
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const currentPage = Math.min(totalPages, Math.floor(offset / limit) + 1);
    const startNum = offset + 1;
    const endNum = Math.min(total, offset + shownCount);
    const remaining = Math.max(0, total - endNum);
    const nextBatch = remaining > 0 && remaining < limit ? remaining : limit;

    els.searchPagination.style.display = 'flex';
    if (els.searchPageIndicator) {
      els.searchPageIndicator.textContent =
        `Showing ${startNum.toLocaleString()}–${endNum.toLocaleString()} of ${total.toLocaleString()} (Page ${currentPage} of ${totalPages})`;
    }
    if (els.btnSearchFirst) els.btnSearchFirst.disabled = currentPage <= 1;
    if (els.btnSearchPrev) els.btnSearchPrev.disabled = currentPage <= 1;
    if (els.btnSearchNext) {
      els.btnSearchNext.disabled = currentPage >= totalPages;
      els.btnSearchNext.textContent = `Next ${nextBatch} ›`;
    }
    if (els.btnSearchLast) els.btnSearchLast.disabled = currentPage >= totalPages;
  }

  function renderFilterResults(data) {
    const episodes = data.episodes || [];
    const total = data.total !== undefined ? data.total : episodes.length;
    state.currentFilteredTalks = episodes;
    state.search.totalEpisodes = total;
    state.search.totalSegments = 0;

    els.searchEmptyState.style.display = 'none';
    els.searchResultsList.style.display = 'flex';
    els.searchMetaBar.style.display = 'flex';
    if (els.filteredArchiveDropdownWrapper) {
      els.filteredArchiveDropdownWrapper.style.display = 'inline-block';
    }
    els.searchCountBadge.textContent = String(total);

    els.queryTierBadge.textContent = 'Filtered Catalog';
    if (total > episodes.length && episodes.length > 0) {
      const startNum = state.search.offset + 1;
      const endNum = state.search.offset + episodes.length;
      els.queryMetaText.textContent =
        `Showing ${startNum.toLocaleString()}–${endNum.toLocaleString()} of ${total.toLocaleString()} talks matching active filters`;
    } else {
      els.queryMetaText.textContent =
        `Showing ${total.toLocaleString()} talk${total === 1 ? '' : 's'} matching active filters`;
    }

    if (els.filteredArchiveCount) els.filteredArchiveCount.textContent = String(total);
    if (els.btnDownloadFilteredArchive) els.btnDownloadFilteredArchive.disabled = total === 0;

    updateSearchPagination(total, episodes.length);

    if (episodes.length === 0) {
      els.searchResultsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon material-symbols-outlined" aria-hidden="true">search</div>
          <h2>No talks match the selected filters</h2>
          <p>Try clearing or expanding your date range or selecting "All Monastics".</p>
        </div>
      `;
      return;
    }

    let html = '';
    episodes.forEach(ep => {
      const durMin = Math.round((ep.duration_sec || 0) / 60);
      html += `
        <div class="episode-card" style="margin-bottom: 0.75rem;">
          <div>
            <div class="result-meta-line" style="margin-bottom: 0.5rem;">
              ${renderTeacherBadgesHtml(ep)}
              ${formatEpisodeDateHtml(ep)}
              <span>• <span class="material-symbols-outlined ms-sm" aria-hidden="true">schedule</span> ${durMin} mins</span>
            </div>
            <h3 class="episode-title">${escapeHtml(ep.title)}</h3>
          </div>

          <div class="episode-footer">
            <button type="button" class="btn-primary" data-action="play-ep-start" data-ep-id="${escapeHtml(ep.id)}">
              <span class="material-symbols-outlined ms-inline" aria-hidden="true">play_arrow</span> Play Talk
            </button>
            <button type="button" class="btn-secondary" data-action="view-transcript" data-ep-id="${escapeHtml(ep.id)}">
              <span class="material-symbols-outlined ms-inline" aria-hidden="true">article</span> Transcript
            </button>
            <div class="download-dropdown-wrapper">
              <button type="button" class="btn-secondary download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                <span class="material-symbols-outlined ms-inline" aria-hidden="true">download</span> Download <span class="material-symbols-outlined ms-inline" aria-hidden="true">arrow_drop_down</span>
              </button>
              <div class="download-dropdown-menu">
                <div class="dropdown-menu-header">Export Transcript</div>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="md">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">edit_note</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Markdown</span>
                    <span class="download-opt-desc">Formatted notes (.md)</span>
                  </div>
                  <span class="download-opt-badge">.md</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="txt">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">description</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Plain Text</span>
                    <span class="download-opt-desc">Clean transcript text (.txt)</span>
                  </div>
                  <span class="download-opt-badge">.txt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="srt">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">subtitles</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">SubRip Subtitles</span>
                    <span class="download-opt-desc">For VLC / media players (.srt)</span>
                  </div>
                  <span class="download-opt-badge">.srt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="vtt">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">closed_caption</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">WebVTT Captions</span>
                    <span class="download-opt-desc">Web caption track (.vtt)</span>
                  </div>
                  <span class="download-opt-badge">.vtt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="json">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">data_object</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">JSON Data</span>
                    <span class="download-opt-desc">Structured turn array (.json)</span>
                  </div>
                  <span class="download-opt-badge">.json</span>
                </button>
              </div>
            </div>
            ${ep.permalink ? `
              <a href="${getPodbeanUrl(ep.permalink)}" target="_blank" rel="noopener noreferrer" class="link-btn">
                ↗ Podbean
              </a>
            ` : ''}
          </div>
        </div>
      `;
    });

    els.searchResultsList.innerHTML = html;
    attachCardEventListeners(els.searchResultsList, episodes);
  }

  const APP_SEARCH_STOPWORDS = new Set([
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

  function buildDiacriticPattern(word) {
    const map = {
      a: '[aā]', i: '[iī]', u: '[uū]', t: '[tṭ]', d: '[dḍ]',
      n: '[nṇñṅ]', l: '[lḷ]', m: '[mṁṃŋ]', s: '[sśṣ]',
    };
    return String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[aiutdnlms]/gi, (ch) => map[ch.toLowerCase()] || ch);
  }

  /**
   * Extracts sentence-level matches from a segment turn's full text,
   * suppressing stopword-only noise while keeping phrase matches and content words.
   */
  function extractSentenceMatchesFromSegment(segItem, query, meta = {}) {
    const rawText = (segItem.text || '').trim();
    const startSec = parseFloat(segItem.start_sec || 0);
    const endSec = parseFloat(segItem.end_sec || startSec);
    const turnDur = Math.max(0, endSec - startSec);
    const turnIndex = segItem.turn_index !== undefined ? Number(segItem.turn_index) : 0;

    if (!rawText) {
      return [{
        episode_id: segItem.episode_id,
        turn_index: turnIndex,
        sent_idx_in_turn: 0,
        word_offset_in_turn: 0,
        sent_start_word_offset: 0,
        est_word_sec: startSec,
        speaker_display: segItem.speaker_display || segItem.teacher,
        speaker_slug: segItem.speaker_slug || segItem.teacher_slug,
        sentence_html: segItem.snippet_text || '',
        sentence_text: (segItem.snippet_text || '').replace(/<\/?b>/gi, ''),
      }];
    }

    // Build content terms from structured worker metadata (avoiding FTS syntax & stopwords)
    let rawTerms = [];
    let hasContentWords = true;
    if (meta && Array.isArray(meta.highlight_terms) && meta.highlight_terms.length > 0) {
      rawTerms = [...meta.highlight_terms];
      hasContentWords = meta.has_content_words !== false;
    } else {
      const STOP_OPS = new Set(['and', 'or', 'not', 'near']);
      const parsedWords = (query || '').match(/[\p{L}\p{N}]+/gu) || [];
      const allTokens = parsedWords
        .map(w => w.toLowerCase())
        .filter(lw => !STOP_OPS.has(lw) && lw.length >= 2);
      const nonStop = allTokens.filter(lw => !APP_SEARCH_STOPWORDS.has(lw));
      hasContentWords = nonStop.length > 0;
      rawTerms = Array.from(new Set(hasContentWords ? nonStop : allTokens));
    }

    // Also inspect any <b>...</b> highlighted words in snippet_text (handles Tier 4 fuzzy corrections)
    if (segItem.snippet_text) {
      const bMatches = segItem.snippet_text.match(/<b>([^<]+)<\/b>/gi) || [];
      bMatches.forEach(bm => {
        const cleanW = bm.replace(/<\/?b>/gi, '').trim().toLowerCase();
        if (cleanW && cleanW.length >= 2 && (!hasContentWords || !APP_SEARCH_STOPWORDS.has(cleanW))) {
          if (!rawTerms.includes(cleanW)) rawTerms.push(cleanW);
        }
      });
    }

    // Sort longest first so multi-char stems don't get shadowed
    rawTerms = Array.from(new Set(rawTerms)).sort((a, b) => b.length - a.length);

    const wordPatterns = rawTerms.map(t => {
      const basePat = buildDiacriticPattern(t);
      if (hasContentWords && t.length >= 3 && !/^\d+$/.test(t)) {
        return `${basePat}[a-zA-Z\\u00C0-\\u024F\\u1E00-\\u1EFF]*`;
      }
      return basePat;
    });

    const perTermRegexes = wordPatterns.map(pat => new RegExp(`\\b(?:${pat})\\b`, 'i'));

    let phrasePattern = null;
    let phraseRegex = null;
    const phraseTokens = (meta && meta.phrase)
      ? meta.phrase.match(/[\p{L}\p{N}]+/gu) || []
      : [];
    if (phraseTokens.length > 1) {
      phrasePattern = phraseTokens.map(t => buildDiacriticPattern(t)).join('[\\s,;:\\-—–]+');
      phraseRegex = new RegExp(`\\b${phrasePattern}\\b`, 'gi');
    }

    const highlightBranches = [];
    if (phrasePattern) highlightBranches.push(phrasePattern);
    if (wordPatterns.length > 0) highlightBranches.push(...wordPatterns);
    const highlightRegex = highlightBranches.length > 0
      ? new RegExp(`\\b(${highlightBranches.join('|')})\\b`, 'gi')
      : null;

    // Split turn text into sentences using the same boundary rule as WordSync.formatTurnParagraphs
    let paragraphs = [];
    if (rawText.includes('\n\n')) {
      paragraphs = rawText
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
    } else {
      const rawSentences = splitSentences(rawText);
      let currentChunk = [];
      let wordCount = 0;

      rawSentences.forEach(s => {
        const sent = s.trim();
        if (!sent) return;
        currentChunk.push(sent);
        wordCount += sent.split(/\s+/).length;

        if (wordCount >= 50 || currentChunk.length >= 3) {
          paragraphs.push(currentChunk.join(' '));
          currentChunk = [];
          wordCount = 0;
        }
      });
      if (currentChunk.length > 0) {
        paragraphs.push(currentChunk.join(' '));
      }
    }
    if (paragraphs.length === 0) paragraphs = [rawText];

    // Flatten paragraphs into sentences exactly as formatTurnParagraphs does
    const allSentences = [];
    let globalWordCursor = 0;
    let sentCursor = 0;

    paragraphs.forEach(pText => {
      const sents = splitSentences(pText);
      sents.forEach(sText => {
        const tokens = sText.split(/(\s+)/);
        const nonWsTokens = [];
        tokens.forEach(tok => {
          if (tok && !/^\s+$/.test(tok)) {
            nonWsTokens.push({
              token: tok,
              wordIdxInTurn: globalWordCursor++,
            });
          }
        });
        allSentences.push({
          sentIdxInTurn: sentCursor++,
          text: sText.trim(),
          rawSent: sText,
          words: nonWsTokens,
          startWordIdx: nonWsTokens.length > 0 ? nonWsTokens[0].wordIdxInTurn : globalWordCursor,
        });
      });
    });

    const totalTurnWords = Math.max(1, globalWordCursor);
    const candidateMatches = [];

    allSentences.forEach(sObj => {
      if (!sObj.text) return;

      let phraseMatched = false;
      if (phraseRegex) {
        phraseRegex.lastIndex = 0;
        phraseMatched = phraseRegex.test(sObj.text);
      }

      let distinctHits = 0;
      for (let i = 0; i < perTermRegexes.length; i++) {
        if (perTermRegexes[i].test(sObj.text)) {
          distinctHits++;
        }
      }

      if (!phraseMatched && distinctHits === 0) return;

      let firstMatchedWordIdx = -1;
      if (phraseMatched && phraseRegex) {
        phraseRegex.lastIndex = 0;
        const pMatch = phraseRegex.exec(sObj.text);
        if (pMatch) {
          const prefixText = sObj.text.slice(0, pMatch.index);
          const prefixTokens = prefixText.trim() ? prefixText.trim().split(/\s+/).length : 0;
          const endsMidToken = pMatch.index > 0 && !/\s/.test(sObj.text[pMatch.index - 1]);
          const wordIdxInSent = Math.max(0, Math.min(sObj.words.length - 1, endsMidToken ? prefixTokens - 1 : prefixTokens));
          if (sObj.words[wordIdxInSent]) {
            firstMatchedWordIdx = sObj.words[wordIdxInSent].wordIdxInTurn;
          }
        }
      }
      if (firstMatchedWordIdx < 0 && highlightRegex) {
        for (const wEntry of sObj.words) {
          highlightRegex.lastIndex = 0;
          if (highlightRegex.test(wEntry.token)) {
            firstMatchedWordIdx = wEntry.wordIdxInTurn;
            break;
          }
        }
      }
      if (firstMatchedWordIdx < 0) {
        firstMatchedWordIdx = sObj.startWordIdx || 0;
      }

      const escapedSent = escapeHtml(sObj.text);
      const highlightedHtml = highlightRegex
        ? escapedSent.replace(highlightRegex, '<b>$&</b>')
        : escapedSent;

      const wordRatio = firstMatchedWordIdx / totalTurnWords;
      const estWordSec = startSec + wordRatio * turnDur;

      candidateMatches.push({
        episode_id: segItem.episode_id,
        turn_index: turnIndex,
        sent_idx_in_turn: sObj.sentIdxInTurn,
        word_offset_in_turn: firstMatchedWordIdx,
        sent_start_word_offset: sObj.startWordIdx,
        est_word_sec: estWordSec,
        turn_start_sec: startSec,
        turn_end_sec: endSec,
        speaker_display: segItem.speaker_display || segItem.teacher,
        speaker_slug: segItem.speaker_slug || segItem.teacher_slug,
        sentence_html: highlightedHtml,
        sentence_text: sObj.text,
        _phraseMatched: phraseMatched,
        _distinctHits: distinctHits,
      });
    });

    // Prefer exact-phrase sentences for phrase tiers, then multi-term sentences, to keep cards focused
    let matchedSentences = candidateMatches;
    const tier = meta && meta.tier;
    if (candidateMatches.length > 0) {
      const phraseHits = candidateMatches.filter(m => m._phraseMatched);
      if (phraseHits.length > 0 && (tier === 'exact_phrase' || tier === 'explicit' || tier === 'fuzzy')) {
        matchedSentences = phraseHits;
      } else if (perTermRegexes.length > 1) {
        const allTermHits = candidateMatches.filter(m => m._distinctHits >= perTermRegexes.length);
        if (allTermHits.length > 0) {
          matchedSentences = allTermHits;
        }
      }
    }

    // Fallback if FTS matched the turn (e.g. speaker name or cross-sentence phrase)
    if (matchedSentences.length === 0 && allSentences.length > 0) {
      const firstS = allSentences[0];
      matchedSentences = [{
        episode_id: segItem.episode_id,
        turn_index: turnIndex,
        sent_idx_in_turn: 0,
        word_offset_in_turn: firstS.startWordIdx || 0,
        sent_start_word_offset: firstS.startWordIdx || 0,
        est_word_sec: startSec,
        turn_start_sec: startSec,
        turn_end_sec: endSec,
        speaker_display: segItem.speaker_display || segItem.teacher,
        speaker_slug: segItem.speaker_slug || segItem.teacher_slug,
        sentence_html: segItem.snippet_text || escapeHtml(firstS.text),
        sentence_text: firstS.text,
      }];
    }

    return matchedSentences;
  }

  function renderSearchResults(data) {
    const {
      results,
      meta,
      elapsed_ms,
      query,
      total_episodes,
      total_segments,
      all_episode_ids,
    } = data;

    // Group matching segments & extracted sentences by transcript (preserving global worker sort order)
    const episodeGroupsMap = new Map();
    const episodeGroups = [];
    let totalSentenceMatches = 0;

    (results || []).forEach(r => {
      const epId = r.episode_id;
      if (!epId) return;

      let group = episodeGroupsMap.get(epId);
      if (!group) {
        group = {
          id: epId,
          episode_id: epId,
          title: r.title,
          date: r.date,
          year: r.year || 0,
          teacher: r.teacher,
          teacher_slug: r.teacher_slug,
          identified_teachers: r.identified_teachers,
          teacher_slugs: r.teacher_slugs || [],
          media_url: r.media_url,
          permalink: r.permalink,
          duration_sec: r.duration_sec,
          matches: [],
        };
        episodeGroupsMap.set(epId, group);
        episodeGroups.push(group);
      }

      const sentMatches = extractSentenceMatchesFromSegment(r, query, meta || {});
      sentMatches.forEach(m => {
        group.matches.push(m);
        totalSentenceMatches++;
      });
    });

    // Sort matches chronologically within each transcript card so the listener sees them in talk order
    episodeGroups.forEach(group => {
      group.matches.sort((a, b) => (a.turn_index - b.turn_index) || (a.word_offset_in_turn - b.word_offset_in_turn));
    });

    const totalEpisodes = total_episodes !== undefined ? total_episodes : episodeGroups.length;
    const totalSegments = total_segments !== undefined ? total_segments : (results || []).length;

    state.currentFilteredTalks = episodeGroups;
    state.currentSearchGroups = episodeGroups;
    state.search.totalEpisodes = totalEpisodes;
    state.search.totalSegments = totalSegments;
    state.search.filteredEpisodeIds = Array.isArray(all_episode_ids)
      ? all_episode_ids
      : episodeGroups.map(g => g.id);

    els.searchEmptyState.style.display = 'none';
    els.searchResultsList.style.display = 'flex';
    els.searchMetaBar.style.display = 'flex';
    if (els.filteredArchiveDropdownWrapper) {
      els.filteredArchiveDropdownWrapper.style.display = 'inline-block';
    }
    els.searchCountBadge.textContent = String(totalEpisodes);

    if (els.filteredArchiveCount) els.filteredArchiveCount.textContent = String(totalEpisodes);
    if (els.btnDownloadFilteredArchive) els.btnDownloadFilteredArchive.disabled = totalEpisodes === 0;

    // Meta bar
    const tierDisplay = formatTierName(meta ? meta.tier : 'none');
    els.queryTierBadge.textContent = tierDisplay;
    let metaMsg = '';
    if (totalEpisodes > episodeGroups.length && episodeGroups.length > 0) {
      const startNum = state.search.offset + 1;
      const endNum = state.search.offset + episodeGroups.length;
      metaMsg =
        `Showing ${startNum.toLocaleString()}–${endNum.toLocaleString()} of ${totalEpisodes.toLocaleString()} talks ` +
        `(${totalSegments.toLocaleString()} matching segments) in ${elapsed_ms}ms`;
    } else {
      metaMsg =
        `Found ${totalSentenceMatches.toLocaleString()} match${totalSentenceMatches === 1 ? '' : 'es'} ` +
        `across ${totalEpisodes.toLocaleString()} talk${totalEpisodes === 1 ? '' : 's'} in ${elapsed_ms}ms`;
    }
    if (meta && meta.corrected && meta.effective_query) {
      metaMsg += ` (auto-corrected to "${meta.effective_query}")`;
    }
    els.queryMetaText.textContent = metaMsg;

    updateSearchPagination(totalEpisodes, episodeGroups.length);

    if (episodeGroups.length === 0) {
      els.searchResultsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon material-symbols-outlined" aria-hidden="true">search</div>
          <h2>No matching segments found</h2>
          <p>Try broadening your query, unchecking "Exact Phrase Only", or searching for key doctrinal words like <i>hindrances</i>, <i>breath</i>, or <i>samadhi</i>.</p>
        </div>
      `;
      return;
    }

    const INITIAL_VISIBLE_MATCHES = 5;
    let html = '';

    episodeGroups.forEach((group, gIdx) => {
      const matchCount = group.matches.length;
      const durMin = group.duration_sec ? Math.round(group.duration_sec / 60) : 0;
      const hiddenCount = Math.max(0, matchCount - INITIAL_VISIBLE_MATCHES);

      const sentencesHtml = group.matches.map((m, mIdx) => {
        const isHidden = mIdx >= INITIAL_VISIBLE_MATCHES;
        const timeStr = formatSeconds(m.est_word_sec);
        return `
          <div
            class="sentence-match-row${isHidden ? ' sentence-match-hidden' : ''}"
            role="button"
            tabindex="0"
            data-action="jump-sentence-match"
            data-group-idx="${gIdx}"
            data-match-idx="${mIdx}"
            data-ep-id="${escapeHtml(group.id)}"
            data-turn-idx="${m.turn_index}"
            data-word-offset="${m.word_offset_in_turn}"
            title="Open transcript at this sentence and stream from this word (${timeStr})"
          >
            <span class="sentence-time-pill" data-est-time="${m.est_word_sec}"><span class="material-symbols-outlined ms-sm" aria-hidden="true">play_arrow</span> ${timeStr}</span>
            <span class="sentence-context-text">${m.sentence_html}</span>
          </div>
        `;
      }).join('');

      html += `
        <article class="result-card transcript-group-card" data-group-idx="${gIdx}" data-ep-id="${escapeHtml(group.id)}">
          <div class="result-header">
            <div class="result-title-group">
              <h3 class="result-title">${escapeHtml(group.title)}</h3>
              <div class="result-meta-line">
                ${renderTeacherBadgesHtml(group)}
                ${formatEpisodeDateHtml(group)}
                ${durMin > 0 ? `<span>• <span class="material-symbols-outlined ms-sm" aria-hidden="true">schedule</span> ${durMin} mins</span>` : ''}
              </div>
            </div>

            <div class="result-header-badges">
              <button type="button" class="btn-bookmark-icon${BookmarkStore.has(group.id) ? ' is-bookmarked' : ''}" data-action="toggle-bookmark" data-ep-id="${escapeHtml(group.id)}" title="${BookmarkStore.has(group.id) ? 'Remove bookmark' : 'Bookmark this talk'}" aria-label="${BookmarkStore.has(group.id) ? 'Remove bookmark' : 'Bookmark this talk'}">
                ${renderBookmarkRibbonSvg(BookmarkStore.has(group.id))}
              </button>
              <span class="match-count-badge" title="${matchCount} search match${matchCount === 1 ? '' : 'es'} in this transcript">
                ${matchCount} match${matchCount === 1 ? '' : 'es'}
              </span>
            </div>
          </div>

          <div class="sentence-matches-list" id="matches-list-${gIdx}">
            ${sentencesHtml}
          </div>

          ${hiddenCount > 0 ? `
            <button
              type="button"
              class="btn-expand-matches"
              data-action="toggle-more-matches"
              data-group-idx="${gIdx}"
              data-hidden-count="${hiddenCount}"
              data-expanded="false"
            >
              + Show ${hiddenCount} more match${hiddenCount === 1 ? '' : 'es'} in this transcript
            </button>
          ` : ''}

          <div class="result-actions">
            <button type="button" class="link-btn" data-action="view-transcript" data-episode-id="${escapeHtml(group.id)}">
              <span class="material-symbols-outlined ms-sm" aria-hidden="true">article</span> View Full Transcript
            </button>
            <button type="button" class="link-btn" data-action="play-ep-start" data-ep-id="${escapeHtml(group.id)}" title="Play talk from the beginning">
              <span class="material-symbols-outlined ms-sm" aria-hidden="true">play_arrow</span> Play Talk from Start
            </button>
            <div class="download-dropdown-wrapper">
              <button type="button" class="btn-secondary download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                <span class="material-symbols-outlined ms-sm" aria-hidden="true">download</span> Download <span class="material-symbols-outlined ms-sm" aria-hidden="true">arrow_drop_down</span>
              </button>
              <div class="download-dropdown-menu">
                <div class="dropdown-menu-header">Export Transcript</div>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="md">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">edit_note</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Markdown</span>
                    <span class="download-opt-desc">Formatted notes (.md)</span>
                  </div>
                  <span class="download-opt-badge">.md</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="txt">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">description</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Plain Text</span>
                    <span class="download-opt-desc">Clean transcript text (.txt)</span>
                  </div>
                  <span class="download-opt-badge">.txt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="srt">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">subtitles</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">SubRip Subtitles</span>
                    <span class="download-opt-desc">For VLC / media players (.srt)</span>
                  </div>
                  <span class="download-opt-badge">.srt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="vtt">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">closed_caption</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">WebVTT Captions</span>
                    <span class="download-opt-desc">Web caption track (.vtt)</span>
                  </div>
                  <span class="download-opt-badge">.vtt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="json">
                  <span class="download-opt-icon material-symbols-outlined" aria-hidden="true">data_object</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">JSON Data</span>
                    <span class="download-opt-desc">Structured turn array (.json)</span>
                  </div>
                  <span class="download-opt-badge">.json</span>
                </button>
              </div>
            </div>
            ${group.permalink ? `
              <a href="${getPodbeanUrl(group.permalink)}" target="_blank" rel="noopener noreferrer" class="external-link">
                ↗ Podbean Page
              </a>
            ` : ''}
          </div>
        </article>
      `;
    });

    els.searchResultsList.innerHTML = html;

    // Attach click & keyboard events on sentence context rows
    els.searchResultsList.querySelectorAll('[data-action="jump-sentence-match"]').forEach(row => {
      const triggerJump = () => {
        const gIdx = parseInt(row.dataset.groupIdx, 10);
        const mIdx = parseInt(row.dataset.matchIdx, 10);
        const group = episodeGroups[gIdx];
        const match = group && group.matches[mIdx];
        if (group && match) {
          openTranscriptDrawer(group.id, {
            turnIndex: match.turn_index,
            sentIdxInTurn: match.sent_idx_in_turn,
            wordOffsetInTurn: match.word_offset_in_turn,
            fallbackSec: match.est_word_sec,
            autoPlay: true,
          });
        }
      };

      row.addEventListener('click', triggerJump);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerJump();
        }
      });
    });

    // Attach expand/collapse handler for cards with > 5 matches
    els.searchResultsList.querySelectorAll('[data-action="toggle-more-matches"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const gIdx = btn.dataset.groupIdx;
        const hiddenCount = btn.dataset.hiddenCount;
        const isExpanded = btn.dataset.expanded === 'true';
        const listEl = document.getElementById(`matches-list-${gIdx}`);
        if (!listEl) return;

        const extraRows = listEl.querySelectorAll('.sentence-match-row');
        extraRows.forEach((r, idx) => {
          if (idx >= INITIAL_VISIBLE_MATCHES) {
            r.classList.toggle('sentence-match-hidden', isExpanded);
          }
        });

        const nextExpanded = !isExpanded;
        btn.dataset.expanded = nextExpanded ? 'true' : 'false';
        btn.textContent = nextExpanded
          ? '− Show fewer matches'
          : `+ Show ${hiddenCount} more match${Number(hiddenCount) === 1 ? '' : 'es'} in this transcript`;
      });
    });

    // Attach View Full Transcript & Play from Start handlers
    attachCardEventListeners(els.searchResultsList, episodeGroups);
  }

  function formatTierName(tier) {
    switch (tier) {
      case 'explicit': return 'Explicit Syntax';
      case 'exact_phrase': return 'Tier 1: Exact Phrase';
      case 'exact_word': return 'Tier 1: Exact Word';
      case 'proximity': return 'Tier 2: Proximity Match (NEAR)';
      case 'prefix': return 'Tier 3: Prefix Match';
      case 'fuzzy': return 'Tier 4: Auto-Corrected';
      case 'quorum': return 'Tier 5: Multi-Word Quorum';
      case 'any_word':
      case 'bm25_any': return 'Tier 6: Ranked Any-Word';
      default: return 'FTS5 Index';
    }
  }

  Object.assign(DD, {
    executeSearch,
    updateSearchPagination,
    renderFilterResults,
    APP_SEARCH_STOPWORDS,
    buildDiacriticPattern,
    extractSentenceMatchesFromSegment,
    renderSearchResults,
    formatTierName,
  });
})();
