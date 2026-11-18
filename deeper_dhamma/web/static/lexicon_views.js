/**
 * Deeper Dhamma — Pali Lexicon View, Authority Source Documents & Live Companion
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const {
    state,
    els,
    dbService,
    escapeHtml,
    formatSeconds,
    isCompanionBottomSheet,
    resetFloatingPanelPosition,
    scrollContentTo,
    scrollElementIntoReadingZone,
  } = DD;
  const playAudioSegment = (...args) => DD.playAudioSegment(...args);
  const switchTab = (...args) => DD.switchTab(...args);

  // ==========================================================================
  // Pali Lexicon View
  // ==========================================================================

  function renderLexiconCard(item) {
    const diacritic = item.pali_diacritic ? `(${escapeHtml(item.pali_diacritic)})` : '';
    const isCore = !!item.translation_brahm || (item.category && item.category !== 'sutta_canon');

    // Build teacher translations gloss if present
    const teacherGloss = [];
    if (item.translation_brahm) {
      teacherGloss.push(`<div class="lexicon-gloss-item"><span class="gloss-teacher">Ajahn Brahm:</span> <span class="gloss-quote">“${escapeHtml(item.translation_brahm)}”</span></div>`);
    }
    if (item.translation_sujato) {
      teacherGloss.push(`<div class="lexicon-gloss-item"><span class="gloss-teacher">Bhikkhu Sujato:</span> <span class="gloss-quote">“${escapeHtml(item.translation_sujato)}”</span></div>`);
    }
    if (item.translation_bodhi) {
      teacherGloss.push(`<div class="lexicon-gloss-item"><span class="gloss-teacher">Bhikkhu Bodhi:</span> <span class="gloss-quote">“${escapeHtml(item.translation_bodhi)}”</span></div>`);
    }
    if (item.translation_brahmali) {
      teacherGloss.push(`<div class="lexicon-gloss-item"><span class="gloss-teacher">Ajahn Brahmali:</span> <span class="gloss-quote">“${escapeHtml(item.translation_brahmali)}”</span></div>`);
    }

    const sourceLabel = item.source_title
      ? `${item.source_title}${item.source_author ? ' — ' + item.source_author : ''}`
      : (item.source || 'SuttaCentral / Bodhinyana Reference');

    let sourceHtml = escapeHtml(sourceLabel);
    if (item.source_url) {
      sourceHtml = `
        <a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer" class="lexicon-source-link" title="Open source authority (${escapeHtml(item.source_url)})">
          ${escapeHtml(sourceLabel)} <span class="external-link-arrow">↗</span>
        </a>
      `;
    }
    if (item.source_document_id) {
      sourceHtml += ` <button type="button" class="btn-lexicon-view-doc" data-doc-id="${escapeHtml(String(item.source_document_id))}" data-term="${escapeHtml(item.pali_plain)}" title="Open offline reference document filtered to '${escapeHtml(item.pali_plain)}'">📜 View in Offline Source (“${escapeHtml(item.pali_plain)}”)</button>`;
    }
    if (item.source_mirror_url) {
      const mirrorExt = (item.source_mirror_url.split('.').pop() || 'file').toUpperCase();
      sourceHtml += ` <a href="${escapeHtml(item.source_mirror_url)}" target="_blank" rel="noopener noreferrer" class="lexicon-source-link" title="Inspect raw upstream archive file (${escapeHtml(item.source_mirror_url)}) used to compile the database">📦 Raw Archive File (.${escapeHtml(mirrorExt)}) ↗</a>`;
    }

    return `
      <div class="lexicon-card">
        <div class="lexicon-term-title">
          <span class="pali-term" title="Click to focus &amp; update URL for ${escapeHtml(item.pali_plain)}" style="cursor: pointer;">${escapeHtml(item.pali_plain)}</span>
          <span class="lexicon-diacritic">${diacritic}</span>
          ${item.category ? `<span class="category-badge">${escapeHtml(item.category.replace(/_/g, ' '))}</span>` : ''}
          ${isCore ? `<span class="core-badge">⭐ CORE</span>` : ''}
        </div>
        ${teacherGloss.length > 0 ? `
          <div class="lexicon-teacher-glosses">
            <div class="glosses-title">Teacher Translations:</div>
            ${teacherGloss.join('')}
          </div>
        ` : ''}
        <div class="lexicon-meta"><strong>Authority Source:</strong> ${sourceHtml}</div>
        <div class="lexicon-actions" style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button type="button" class="btn-lexicon-talks" data-term="${escapeHtml(item.pali_plain)}" title="Search transcripts for this Pali term">
            🔍 Find Talks Mentioning "${escapeHtml(item.pali_plain)}"
          </button>
          <button type="button" class="btn-secondary btn-lexicon-share" data-term="${escapeHtml(item.pali_plain)}" title="Copy shareable link to this lexicon term">
            🔗 Share Term Link
          </button>
        </div>
      </div>
    `;
  }

  async function loadLexiconView() {
    if (!els.lexiconResults) return;
    els.lexiconResults.innerHTML = '<div class="loading-spinner">Loading doctrinal terms...</div>';

    try {
      const pageData = await dbService.getLexiconPage({
        mode: state.lexicon.mode,
        category: state.lexicon.category,
        letter: state.lexicon.letter,
        sort: state.lexicon.sort,
        page: state.lexicon.page,
        limit: state.lexicon.limit,
      });

      state.lexicon.total = pageData.total || 0;
      state.lexicon.totalPages = pageData.totalPages || 1;
      state.lexicon.page = pageData.page || 1;
      state.lexicon.loadedOnce = true;

      // Update count text
      if (els.lexCountText) {
        if (state.lexicon.mode === 'core') {
          const filterSuffix = (state.lexicon.category && state.lexicon.category !== 'all')
            ? ` in "${state.lexicon.category.replace(/_/g, ' ')}"`
            : '';
          els.lexCountText.textContent = `Showing ${pageData.items.length} of ${pageData.total} Standard Core Terms${filterSuffix}`;
        } else {
          const start = pageData.total > 0 ? (state.lexicon.page - 1) * state.lexicon.limit + 1 : 0;
          const end = Math.min(state.lexicon.page * state.lexicon.limit, pageData.total);
          const filterSuffix = (state.lexicon.category && state.lexicon.category !== 'all')
            ? ` in "${state.lexicon.category.replace(/_/g, ' ')}"`
            : '';
          const letterSuffix = (state.lexicon.letter && state.lexicon.letter !== 'all')
            ? ` starting with "${state.lexicon.letter.toUpperCase()}"`
            : '';
          els.lexCountText.textContent = `Showing ${start}–${end} of ${pageData.total.toLocaleString()} Canonical Terms${filterSuffix}${letterSuffix}`;
        }
      }

      // Render cards
      if (!pageData.items || pageData.items.length === 0) {
        els.lexiconResults.innerHTML = `
          <div class="empty-state" style="padding: 2.5rem;">
            <p>No matching doctrinal terms found for current filters.</p>
          </div>
        `;
      } else {
        els.lexiconResults.innerHTML = pageData.items.map(item => renderLexiconCard(item)).join('');
      }

      // Update Pagination Controls
      if (els.lexPagination) {
        if (state.lexicon.totalPages > 1 || state.lexicon.mode === 'all') {
          els.lexPagination.style.display = 'flex';
          if (els.lexPageIndicator) {
            els.lexPageIndicator.textContent = `Page ${state.lexicon.page} of ${state.lexicon.totalPages}`;
          }
          if (els.btnLexFirst) els.btnLexFirst.disabled = state.lexicon.page <= 1;
          if (els.btnLexPrev) els.btnLexPrev.disabled = state.lexicon.page <= 1;
          if (els.btnLexNext) els.btnLexNext.disabled = state.lexicon.page >= state.lexicon.totalPages;
          if (els.btnLexLast) els.btnLexLast.disabled = state.lexicon.page >= state.lexicon.totalPages;
        } else {
          els.lexPagination.style.display = 'none';
        }
      }
    } catch (err) {
      console.error('Failed to load lexicon terms:', err);
      els.lexiconResults.innerHTML = '<div class="empty-state"><p>Failed to load lexicon terms.</p></div>';
    }
  }

  async function executeLexiconSearch(term) {
    if (!term) {
      loadLexiconView();
      return;
    }

    try {
      // Direct lookup
      const lookupData = await dbService.lookupLexicon(term);

      // Contextual search
      const searchResults = await dbService.searchLexicon(term, 10);

      let entries = [];
      if (lookupData && lookupData.found && lookupData.data) {
        entries.push(lookupData.data);
      }
      if (searchResults && searchResults.length) {
        searchResults.forEach(r => {
          if (!entries.some(e => e.pali_plain === r.pali_plain)) {
            entries.push(r);
          }
        });
      }

      if (entries.length === 0) {
        if (els.lexCountText) els.lexCountText.textContent = `No results found for "${term}"`;
        els.lexiconResults.innerHTML = `
          <div class="empty-state" style="padding: 2rem;">
            <p>No lexicon entry found for "${escapeHtml(term)}".</p>
          </div>
        `;
        return;
      }

      if (els.lexCountText) {
        els.lexCountText.textContent = `Found ${entries.length} matching term${entries.length > 1 ? 's' : ''} for "${term}"`;
      }
      els.lexiconResults.innerHTML = entries.map(item => renderLexiconCard(item)).join('');
    } catch (err) {
      console.error('Lexicon search failed:', err);
    }
  }

  // ==========================================================================
  // Canonical Authority Source Documents Tab & Rendered Viewer
  // ==========================================================================

  async function loadDocumentInView(docId = 1, filterTerm = '', options = {}) {
    state.documents.activeDocId = parseInt(docId, 10) || 1;
    const cleanFilter = (filterTerm || '').trim();
    state.documents.filterQuery = cleanFilter;

    if (!options.skipHistory && state.activeTab === 'documents-view') {
      const docHash = cleanFilter
        ? `#documents?id=${state.documents.activeDocId}&q=${encodeURIComponent(cleanFilter)}`
        : `#documents?id=${state.documents.activeDocId}`;
      if (window.location.hash !== docHash) {
        state.historyDepth++;
        window.history.pushState({ route: docHash }, '', docHash);
      }
    }

    // Update active tab button in doc-tabs-bar
    document.querySelectorAll('.doc-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.docId === String(state.documents.activeDocId));
    });

    if (els.docRenderedBody) {
      els.docRenderedBody.innerHTML = '<div class="loading-spinner">Loading canonical document...</div>';
    }

    try {
      let doc = state.documents.cachedDocs[state.documents.activeDocId];
      if (!doc) {
        doc = await dbService.getSourceDocument(state.documents.activeDocId);
        if (doc) {
          state.documents.cachedDocs[state.documents.activeDocId] = doc;
        }
      }

      if (!doc) {
        if (els.docRenderedBody) {
          els.docRenderedBody.innerHTML = '<div class="empty-state">Document not found.</div>';
        }
        return;
      }

      // Update Header Metadata
      if (els.docActiveTitle) els.docActiveTitle.textContent = doc.title;
      if (els.docActiveByline) els.docActiveByline.textContent = `Author: ${doc.author} • Publisher: ${doc.publisher || 'Canonical Reference'}`;
      if (els.docActiveRemoteLink) {
        els.docActiveRemoteLink.href = doc.url || '#';
      }
      if (els.docActiveMirrorLink) {
        if (doc.mirror_url) {
          const mirrorExt = (doc.mirror_url.split('.').pop() || 'file').toUpperCase();
          els.docActiveMirrorLink.href = doc.mirror_url;
          els.docActiveMirrorLink.textContent = `📦 Raw Archive File (.${mirrorExt}) ↗`;
          els.docActiveMirrorLink.style.display = 'inline-flex';
        } else {
          els.docActiveMirrorLink.style.display = 'none';
        }
      }
      if (els.docChipRetrieved) els.docChipRetrieved.textContent = `📅 Retrieved: ${doc.retrieved_date || 'N/A'}`;
      if (els.docChipFormat) els.docChipFormat.textContent = `📄 Format: ${doc.content_format || 'text/markdown'}`;
      if (els.docChipSize) {
        const kb = doc.uncompressed_bytes ? (doc.uncompressed_bytes / 1024).toFixed(1) + ' KB' : 'N/A';
        els.docChipSize.textContent = `💾 Size: ${kb}`;
      }
      if (els.docChipSha) {
        els.docChipSha.textContent = `🔒 SHA-256: ${(doc.sha256 || '').slice(0, 20)}...`;
        els.docChipSha.title = `Full SHA-256 Checksum: ${doc.sha256}`;
      }

      // Render Content with Rich Formatting & Tables
      if (els.docRenderedBody) {
        els.docRenderedBody.innerHTML = renderDocumentContent(doc);
      }

      // Set filter if provided
      if (els.docFilterInput) {
        els.docFilterInput.value = cleanFilter;
        filterActiveDocument(cleanFilter, { skipHistory: true, scrollToMatch: Boolean(cleanFilter) });
      }
    } catch (err) {
      console.error('Failed to load document:', err);
      if (els.docRenderedBody) {
        els.docRenderedBody.innerHTML = `<div class="empty-state">Failed to load document: ${escapeHtml(err.message || String(err))}</div>`;
      }
    }
  }

  function renderDocumentContent(doc) {
    if (!doc || !doc.content) {
      return '<div class="empty-state">No document content available.</div>';
    }

    const content = doc.content;
    const hasTable = content.includes('<table') && content.includes('</table>');

    if (hasTable) {
      let tableStartIdx = content.indexOf('<div class="doc-table-container">');
      if (tableStartIdx === -1) {
        tableStartIdx = content.indexOf('<table');
      }
      const tableEndIdx = content.lastIndexOf('</table>') + 8;
      let postEndIdx = tableEndIdx;
      const afterTable = content.slice(tableEndIdx).trimStart();
      if (afterTable.startsWith('</div>')) {
        postEndIdx = content.indexOf('</div>', tableEndIdx) + 6;
      }

      const preamble = content.slice(0, tableStartIdx);
      const postamble = content.slice(postEndIdx);
      let rawTableHtml = content.slice(tableStartIdx, postEndIdx);

      const renderedPreamble = renderSimpleMarkdown(preamble);
      const renderedPostamble = postamble.trim() ? renderSimpleMarkdown(postamble) : '';

      // Ensure wrapped in doc-table-container
      if (!rawTableHtml.includes('doc-table-container')) {
        rawTableHtml = `<div class="doc-table-container">${rawTableHtml}</div>`;
      }
      // Ensure table element has class doc-rendered-table and id doc-active-table
      if (!rawTableHtml.includes('doc-rendered-table')) {
        rawTableHtml = rawTableHtml.replace(/<table\b([^>]*)>/, '<table class="doc-rendered-table" id="doc-active-table"$1>');
      }

      // 3-column rows without classes (e.g. Doc 1: Pali, Bodhi, Sujato)
      rawTableHtml = rawTableHtml.replace(/<tr>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<\/tr>/g, (match, pali, bodhi, sujato) => {
        return `<tr class="doc-table-data-row">
          <td class="td-pali">${pali}</td>
          <td class="td-bodhi">${bodhi}</td>
          <td class="td-sujato">${sujato}</td>
        </tr>`;
      });

      // 2-column rows without classes (e.g. Doc 2: Pali, Brahmali)
      rawTableHtml = rawTableHtml.replace(/<tr>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<\/tr>/g, (match, pali, brahmali) => {
        return `<tr class="doc-table-data-row">
          <td class="td-pali">${pali}</td>
          <td class="td-brahmali">${brahmali}</td>
        </tr>`;
      });

      // Ensure all rows inside tbody have .doc-table-data-row class
      rawTableHtml = rawTableHtml.replace(/<tbody>([\s\S]*?)<\/tbody>/, (match, tbodyContent) => {
        const enhancedBody = tbodyContent.replace(/<tr\b([^>]*)>/g, (trMatch, attrs) => {
          if (attrs && attrs.includes('doc-table-data-row')) return trMatch;
          return `<tr class="doc-table-data-row"${attrs || ''}>`;
        });
        return `<tbody>${enhancedBody}</tbody>`;
      });

      return `
        <div class="doc-preamble-section">${renderedPreamble}</div>
        ${rawTableHtml}
        ${renderedPostamble}
      `;
    }

    // Fallback: Clean rich Markdown
    return renderSimpleMarkdown(content);
  }

  function renderSimpleMarkdown(md) {
    if (!md) return '';
    const lines = md.split(/\r?\n/);
    const htmlParts = [];
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) {
        if (inList) {
          htmlParts.push('</ul>');
          inList = false;
        }
        continue;
      }

      // Check if line is already an HTML block tag (like <p class="doc-intro-lead">...</p>)
      if (line.startsWith('<p') || line.startsWith('<div') || line.startsWith('</')) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        htmlParts.push(line);
        continue;
      }

      // Headers
      if (line.startsWith('### ')) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        htmlParts.push(`<h4>${formatInlineMd(line.slice(4))}</h4>`);
        continue;
      }
      if (line.startsWith('## ')) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        htmlParts.push(`<h3 class="doc-section-title">${formatInlineMd(line.slice(3))}</h3>`);
        continue;
      }
      if (line.startsWith('# ')) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        // Skip H1 title as it's shown in the card header
        continue;
      }

      // Bullet list items
      if (line.startsWith('- ') || line.startsWith('* ')) {
        if (!inList) {
          htmlParts.push('<ul>');
          inList = true;
        }
        const itemText = line.slice(2);
        htmlParts.push(`<li class="doc-list-item">${formatInlineMd(itemText)}</li>`);
        continue;
      }

      if (inList) {
        htmlParts.push('</ul>');
        inList = false;
      }

      // Paragraph
      htmlParts.push(`<p>${formatInlineMd(line)}</p>`);
    }

    if (inList) {
      htmlParts.push('</ul>');
    }

    return htmlParts.join('\n');
  }

  function formatInlineMd(text) {
    if (!text) return '';
    let out = text;
    // Bold **text**
    out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic *text*
    out = out.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Links [text](url)
    out = out.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="lexicon-source-link">$1 ↗</a>');
    // Standalone URLs (not preceded by href=")
    out = out.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="lexicon-source-link">$2 ↗</a>');
    return out;
  }

  function normalizePaliSearch(text) {
    if (!text) return '';
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[ṁṃŋ]/g, 'm')
      .toLowerCase();
  }

  function filterActiveDocument(query, options = {}) {
    const rawQ = (query || '').trim().toLowerCase();
    const q = normalizePaliSearch(rawQ);
    state.documents.filterQuery = rawQ;

    if (!options.skipHistory && state.activeTab === 'documents-view') {
      const docHash = rawQ
        ? `#documents?id=${state.documents.activeDocId}&q=${encodeURIComponent(rawQ)}`
        : `#documents?id=${state.documents.activeDocId}`;
      if (window.location.hash !== docHash) {
        window.history.replaceState({ route: docHash }, '', docHash);
      }
    }

    if (els.clearDocFilterBtn) {
      els.clearDocFilterBtn.style.display = rawQ ? 'inline-block' : 'none';
    }

    const tableRows = els.docRenderedBody ? els.docRenderedBody.querySelectorAll('.doc-table-data-row') : [];
    if (tableRows.length > 0) {
      let visibleCount = 0;
      let firstMatchedRow = null;
      tableRows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const normText = normalizePaliSearch(text);
        const matches = !q || text.includes(rawQ) || normText.includes(q);
        row.classList.toggle('doc-row-hidden', !matches);
        if (matches) {
          visibleCount++;
          if (!firstMatchedRow && q) firstMatchedRow = row;
        }
      });
      if (els.docFilterCount) {
        els.docFilterCount.textContent = rawQ 
          ? `Showing ${visibleCount.toLocaleString()} of ${tableRows.length.toLocaleString()} terms`
          : `${tableRows.length.toLocaleString()} terms`;
      }
      if (firstMatchedRow && options.scrollToMatch) {
        requestAnimationFrame(() => {
          firstMatchedRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      return;
    }

    // In markdown list mode (Doc 2 & 3 fallback)
    const listItems = els.docRenderedBody ? els.docRenderedBody.querySelectorAll('.doc-list-item') : [];
    if (listItems.length > 0) {
      let visibleCount = 0;
      listItems.forEach(item => {
        const text = item.textContent.toLowerCase();
        const normText = normalizePaliSearch(text);
        const matches = !q || text.includes(rawQ) || normText.includes(q);
        item.style.display = matches ? '' : 'none';
        if (matches) visibleCount++;
      });
      if (els.docFilterCount) {
        els.docFilterCount.textContent = rawQ 
          ? `Showing ${visibleCount.toLocaleString()} of ${listItems.length.toLocaleString()} items`
          : `${listItems.length.toLocaleString()} items`;
      }
    }
  }

  // ==========================================================================
  // Pali Lexicon Live Companion (Spoken Stack & Mobile Sheet)
  // ==========================================================================

  async function ensurePaliTermsLoaded() {
    if (state.lexCompanion.loadedOnce && window.WordSync && window.WordSync.paliTermsMap.size > 0) {
      return;
    }
    try {
      if (!dbService || !dbService.getAllTerms) return;
      const terms = await dbService.getAllTerms();
      if (Array.isArray(terms) && terms.length > 0) {
        if (window.WordSync) {
          window.WordSync.setPaliTerms(terms);
        }
        state.lexCompanion.loadedOnce = true;
      }
    } catch (err) {
      console.warn('[LexCompanion] Failed to pre-load Pali terms index:', err);
    }
  }

  function toggleToolbarActions(forceOpen) {
    if (!els.transcriptStickyToolbar) return;
    const isCurrentlyOpen = els.transcriptStickyToolbar.classList.contains('is-actions-open');
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !isCurrentlyOpen;
    els.transcriptStickyToolbar.classList.toggle('is-actions-open', shouldOpen);
    if (els.btnToggleToolbarActions) {
      els.btnToggleToolbarActions.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      const label = shouldOpen ? 'Hide transcript actions' : 'Show transcript actions';
      els.btnToggleToolbarActions.title = label;
      els.btnToggleToolbarActions.setAttribute('aria-label', label);
    }
    if (!shouldOpen) {
      const openDropdown = els.transcriptStickyToolbar.querySelector('.download-dropdown-wrapper.open');
      if (openDropdown) {
        openDropdown.classList.remove('open');
        resetFloatingPanelPosition(openDropdown.querySelector('.download-dropdown-menu'));
      }
    }
  }

  function toggleMobileLexSheet(forceOpen) {
    if (!els.lexCompanion) return;
    const isCurrentlyExpanded = els.lexCompanion.classList.contains('is-expanded');
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !isCurrentlyExpanded;

    els.lexCompanion.classList.toggle('is-expanded', shouldOpen);
    state.lexCompanion.isExpandedMobile = shouldOpen;
    if (els.btnToggleLexSheet) {
      els.btnToggleLexSheet.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    }
    if (shouldOpen && state.lexCompanion.currentActiveIdx >= 0 && els.lexiconStack) {
      requestAnimationFrame(() => {
        const activeCard = els.lexiconStack.querySelector('.lex-stack-card.current-companion-term');
        if (activeCard) {
          scrollCardIntoCompanionStack(activeCard, 'auto', 'nearest');
        }
      });
    }
  }

  function resetLexCompanion() {
    state.lexCompanion.allTerms = [];
    state.lexCompanion.currentActiveIdx = -1;
    if (els.lexiconStack) {
      els.lexiconStack.querySelectorAll('.lex-stack-card').forEach(el => el.remove());
    }
    if (els.lexStackEmpty) {
      els.lexStackEmpty.style.display = 'flex';
    }
    if (els.lexStackBadge) {
      els.lexStackBadge.textContent = '0 terms';
    }
    if (els.mobileSheetCount) {
      els.mobileSheetCount.textContent = '0';
    }
    if (els.mobileTickerTerm) {
      els.mobileTickerTerm.textContent = '—';
    }
    if (els.mobileTickerDef) {
      els.mobileTickerDef.textContent = 'Pali definitions appear here as spoken';
    }
    if (window.WordSync) {
      window.WordSync._lastSpokenWordId = null;
    }
  }

  function cleanDefinitionText(text) {
    if (!text) return '';
    let clean = String(text).trim();
    if (clean.startsWith('Canonical early Buddhist term')) {
      const mB = clean.match(/Bodhi:\s*'([^']+)'/i);
      const mS = clean.match(/Sujato:\s*'([^']+)'/i);
      if (mB && mB[1]) {
        clean = mB[1];
      } else if (mS && mS[1]) {
        clean = mS[1];
      } else {
        clean = 'Early Buddhist canonical doctrinal term.';
      }
    }
    // Remove "(1) untranslated: " or "untranslated: "
    clean = clean.replace(/(\(\d+\)\s*)?untranslated:\s*/gi, '');
    clean = clean.replace(/^[\s;,\.\-]+|[\s;,\.\-]+$/g, '');
    if (clean && clean[0] === clean[0].toLowerCase()) {
      clean = clean[0].toUpperCase() + clean.slice(1);
    }
    return clean;
  }

  function getBestDefinition(term) {
    if (!term) return { text: '', source: 'Lexicon' };
    const brahm = term.translation_brahm ? String(term.translation_brahm).trim() : '';
    const bodhi = term.translation_bodhi ? String(term.translation_bodhi).trim() : '';
    const sujato = term.translation_sujato ? String(term.translation_sujato).trim() : '';
    const brahmali = term.translation_brahmali ? String(term.translation_brahmali).trim() : '';
    const desc = term.english_description ? String(term.english_description).trim() : '';

    // 1. Ajahn Brahm: highest priority living forest tradition definition
    if (brahm) {
      return { text: cleanDefinitionText(brahm), source: 'Ajahn Brahm' };
    }

    // 2. If Bodhi is untranslated but Sujato has a direct English translation, prefer Sujato
    if (bodhi.toLowerCase().includes('untranslated') && sujato && !sujato.toLowerCase().includes('untranslated')) {
      return { text: cleanDefinitionText(sujato), source: 'Sujato' };
    }

    // 3. Bhikkhu Bodhi: canonical Theravada translation
    if (bodhi) {
      return { text: cleanDefinitionText(bodhi), source: 'Bodhi' };
    }

    // 4. Bhikkhu Sujato: modern SuttaCentral translation
    if (sujato) {
      return { text: cleanDefinitionText(sujato), source: 'Sujato' };
    }

    // 5. Ajahn Brahmali: Vinaya & monastic translation
    if (brahmali) {
      return { text: cleanDefinitionText(brahmali), source: 'Ajahn Brahmali' };
    }

    // 6. English description fallback if meaningful
    if (desc && !desc.startsWith('Canonical early Buddhist term') && !desc.startsWith('Vinaya (Brahmali)')) {
      return { text: cleanDefinitionText(desc), source: 'Lexicon' };
    }

    return { text: cleanDefinitionText('Canonical Buddhist doctrinal term.'), source: 'Lexicon' };
  }

  function openFullLexiconEntry(termKey) {
    if (!termKey) return;
    state.lexicon.term = termKey;
    switchTab('lexicon-view', { skipHistory: true });
    const cleanHash = `#lexicon?term=${encodeURIComponent(termKey)}`;
    if (window.location.hash !== cleanHash) {
      state.historyDepth++;
      window.history.pushState({ route: cleanHash }, '', cleanHash);
    }
    if (els.lexiconInput) {
      els.lexiconInput.value = termKey;
    }
    if (els.lexAlphabetBar) els.lexAlphabetBar.style.display = 'none';
    if (els.lexPagination) els.lexPagination.style.display = 'none';
    if (els.lexCountText) els.lexCountText.textContent = `Search results for "${termKey}"`;
    executeLexiconSearch(termKey);
    scrollContentTo(0, 'smooth');
  }

  function createCompanionCard(term, idx) {
    const card = document.createElement('article');
    card.className = 'lex-stack-card';
    card.id = `lex-card-${idx}`;
    card.dataset.idx = String(idx);
    card.dataset.term = term.pali_plain || '';

    const paliTitle = escapeHtml(term.pali_diacritic || term.pali_plain || '');
    const startSec = typeof term.startSec === 'number' ? term.startSec : 0;
    card.title = `Seek audio to ${formatSeconds(startSec)}`;
    const detailsBtn = `<button type="button" class="lex-card-link-btn" data-term="${escapeHtml(term.pali_plain || term.pali_diacritic || '')}" title="View full lexicon entry for ${paliTitle}">Lexicon ↗</button>`;

    const bestDef = getBestDefinition(term);
    const sourceNote = bestDef.source
      ? `<div class="lex-card-source-tag">— ${escapeHtml(bestDef.source)}</div>`
      : '';

    card.innerHTML = `
      <div class="lex-card-header">
        <div class="lex-card-term-group">
          <h4 class="lex-card-pali">${paliTitle}</h4>
        </div>
        <div class="lex-card-meta-right">
          ${detailsBtn}
        </div>
      </div>
      <div class="lex-card-def-row">
        <span class="lex-card-def-text">${escapeHtml(bestDef.text)}</span>
      </div>
      ${sourceNote}
    `;

    return card;
  }

  function renderCompanionCards(terms) {
    if (!els.lexiconStack) return;

    // Clear previous cards
    els.lexiconStack.querySelectorAll('.lex-stack-card').forEach(c => c.remove());

    if (!terms || terms.length === 0) {
      if (els.lexStackEmpty) els.lexStackEmpty.style.display = 'flex';
      if (els.lexStackBadge) els.lexStackBadge.textContent = '0 terms';
      if (els.mobileSheetCount) els.mobileSheetCount.textContent = '0';
      if (els.mobileTickerTerm) els.mobileTickerTerm.textContent = '—';
      if (els.mobileTickerDef) els.mobileTickerDef.textContent = 'No canonical Pali terms indexed in this talk';
      return;
    }

    if (els.lexStackEmpty) {
      els.lexStackEmpty.style.display = 'none';
    }
    if (els.lexStackBadge) {
      els.lexStackBadge.textContent = `${terms.length} term${terms.length === 1 ? '' : 's'} in talk`;
    }
    if (els.mobileSheetCount) {
      els.mobileSheetCount.textContent = `1 / ${terms.length}`;
    }

    const fragment = document.createDocumentFragment();
    terms.forEach((term, idx) => {
      const cardEl = createCompanionCard(term, idx);
      fragment.appendChild(cardEl);
    });
    els.lexiconStack.appendChild(fragment);

    // Initial preview: activate term 0 without forced scroll
    setActiveCompanionTerm(0, { scrollCompanion: false });
  }

  function buildCompanionTermsList() {
    if (!els.drawerTurns) return;
    const termElements = els.drawerTurns.querySelectorAll('.pali-term');
    const allTerms = [];
    let lastTermKey = null;
    let lastStartSec = -999;

    termElements.forEach((el) => {
      const key = el.dataset.pali;
      if (!key) return;
      const cleanKey = key.trim().toLowerCase();
      const termData = window.WordSync && window.WordSync.paliTermsMap
        ? window.WordSync.paliTermsMap.get(cleanKey)
        : null;
      if (!termData) return;

      let startSec = parseFloat(el.dataset.start);
      if (isNaN(startSec)) {
        const turnEl = el.closest('.transcript-turn');
        if (turnEl && turnEl.dataset.start) {
          startSec = parseFloat(turnEl.dataset.start);
        } else {
          startSec = 0;
        }
      }

      // Skip immediate stutter duplicates (same term spoken within 2.0s)
      if (cleanKey === lastTermKey && Math.abs(startSec - lastStartSec) < 2.0) {
        return;
      }
      lastTermKey = cleanKey;
      lastStartSec = startSec;

      const turnEl = el.closest('.transcript-turn');
      const turnIdx = turnEl && turnEl.dataset.turnIdx ? parseInt(turnEl.dataset.turnIdx, 10) : 0;
      let wordIdx = -1;
      if (el.id && el.id.startsWith('tw-')) {
        const parsedIdx = parseInt(el.id.slice(3), 10);
        if (!isNaN(parsedIdx)) wordIdx = parsedIdx;
      }
      if (wordIdx < 0 && window.WordSync && window.WordSync.words && window.WordSync.words.length > 0) {
        wordIdx = window.WordSync.findWordIndex(startSec + 0.01);
      }

      allTerms.push({
        idx: allTerms.length,
        pali_plain: termData.pali_plain,
        pali_diacritic: termData.pali_diacritic || termData.pali_plain,
        category: termData.category,
        translation_brahm: termData.translation_brahm,
        translation_bodhi: termData.translation_bodhi,
        translation_sujato: termData.translation_sujato,
        translation_brahmali: termData.translation_brahmali,
        english_description: termData.english_description,
        source_url: termData.source_url,
        source_mirror_url: termData.source_mirror_url,
        source_document_id: termData.source_document_id,
        startSec: startSec,
        turnIdx: turnIdx,
        wordIdx: wordIdx,
        wordId: el.id || null,
      });
    });

    // Chronological order (prefer exact word index when available, timestamp fallback otherwise)
    allTerms.sort((a, b) => {
      if (a.wordIdx >= 0 && b.wordIdx >= 0 && a.wordIdx !== b.wordIdx) {
        return a.wordIdx - b.wordIdx;
      }
      return a.startSec - b.startSec;
    });
    allTerms.forEach((t, i) => { t.idx = i; });

    state.lexCompanion.allTerms = allTerms;
    state.lexCompanion.currentActiveIdx = -1;
    renderCompanionCards(allTerms);
  }

  /**
   * Scrolls only the lexicon companion container (never ancestor/window scroll)
   * so tracking words in the transcript cannot be hijacked by companion updates.
   */
  function scrollCardIntoCompanionStack(cardEl, behavior = 'smooth', align = 'nearest') {
    const stackEl = els.lexiconStack;
    if (!stackEl || !cardEl) return;
    if (stackEl.offsetParent === null || window.getComputedStyle(stackEl).display === 'none') return;
    const stackRect = stackEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    if (stackRect.height <= 0 || cardRect.height <= 0) return;

    const relativeTop = cardRect.top - stackRect.top + stackEl.scrollTop;
    const relativeBottom = relativeTop + cardRect.height;
    let targetTop = stackEl.scrollTop;

    if (align === 'center') {
      targetTop = relativeTop - Math.max(0, (stackEl.clientHeight - cardRect.height) / 2);
    } else if (cardRect.top < stackRect.top) {
      targetTop = relativeTop - 8;
    } else if (cardRect.bottom > stackRect.bottom) {
      targetTop = relativeBottom - stackEl.clientHeight + 8;
    } else {
      return;
    }

    targetTop = Math.max(0, targetTop);
    if (typeof stackEl.scrollTo === 'function') {
      stackEl.scrollTo({ top: targetTop, behavior });
    } else {
      stackEl.scrollTop = targetTop;
    }
  }

  function jumpToCompanionTerm(idx) {
    const terms = state.lexCompanion.allTerms;
    if (!terms || !terms[idx]) return;
    const term = terms[idx];
    const isSmallScreen = isCompanionBottomSheet();

    // 1. Highlight this card in companion and minimize bottom sheet on small/medium screens
    //    before computing the unobstructed reading zone and scrolling to the term.
    setActiveCompanionTerm(idx, { scrollCompanion: !isSmallScreen });
    if (isSmallScreen) {
      toggleMobileLexSheet(false);
    }

    // 2. Resolve target word/turn cleanly via unified WordSync coordinator
    let scrollTarget = term.wordId ? document.getElementById(term.wordId) : null;
    if (!scrollTarget) {
      scrollTarget = document.getElementById(`turn-${term.turnIdx}`);
    }
    if (window.WordSync) {
      window.WordSync._userInteractedAt = 0;
      window.WordSync._teleprompterLine = null;
      if (scrollTarget && term.wordId && scrollTarget.classList.contains('transcript-word')) {
        window.WordSync.setActiveWordElement(scrollTarget, term.wordIdx);
      }
    }

    // 3. Seek audio to term's start time with deterministic word & companion lock
    if (state.currentEpisode) {
      playAudioSegment({
        episode_id: state.currentEpisode.id,
        media_url: state.currentEpisode.media_url,
        title: state.currentEpisode.title,
        teacher: state.currentEpisode.primary_display,
        start_sec: term.startSec,
        word_id: term.wordId || null,
        companion_idx: idx,
      });
    }

    // 4. Scroll transcript cleanly via single-owner reading-zone animator
    if (scrollTarget) {
      scrollElementIntoReadingZone(scrollTarget, 'smooth');
      if (!(term.wordId && scrollTarget.classList.contains('transcript-word'))) {
        scrollTarget.classList.add('target-turn-flash');
        setTimeout(() => scrollTarget.classList.remove('target-turn-flash'), 2500);
      }
    }
  }

  function setActiveCompanionTerm(idx, options = {}) {
    const terms = state.lexCompanion.allTerms;
    if (!terms || !terms[idx]) return;
    state.lexCompanion.currentActiveIdx = idx;
    const term = terms[idx];

    // 1. Update card highlights and keep inside companion stack viewport
    if (els.lexiconStack) {
      const cards = els.lexiconStack.querySelectorAll('.lex-stack-card');
      cards.forEach(c => {
        const cardIdx = parseInt(c.dataset.idx, 10);
        if (cardIdx === idx) {
          c.classList.add('current-companion-term');
          if (options.scrollCompanion !== false) {
            scrollCardIntoCompanionStack(c, 'smooth', 'nearest');
          }
        } else {
          c.classList.remove('current-companion-term');
        }
      });
    }

    // 2. Update collapsed mobile ticker
    if (els.mobileTickerTerm) {
      els.mobileTickerTerm.textContent = term.pali_diacritic || term.pali_plain || '—';
    }
    const bestDef = getBestDefinition(term);
    if (els.mobileTickerDef) {
      els.mobileTickerDef.textContent = bestDef.text ? `${bestDef.source}: ${bestDef.text}` : '';
    }
    if (els.mobileSheetCount) {
      els.mobileSheetCount.textContent = `${idx + 1} / ${terms.length}`;
    }
  }

  function updateActiveCompanionTerm(currentTime) {
    const terms = state.lexCompanion.allTerms;
    if (!terms || terms.length === 0) return;

    if (window.WordSync && typeof window.WordSync.isSeekLocked === 'function' && window.WordSync.isSeekLocked()) {
      const lockedC = window.WordSync._lockedCompanionIdx;
      if (typeof lockedC === 'number' && lockedC >= 0 && terms[lockedC]) {
        if (state.lexCompanion.currentActiveIdx !== lockedC) {
          setActiveCompanionTerm(lockedC, { scrollCompanion: !isCompanionBottomSheet() });
        }
      }
      return;
    }

    let evalTime = currentTime;
    let activeWordIdx = -1;
    if (window.WordSync) {
      if (
        typeof window.WordSync._seekTargetWordTime === 'number' &&
        window.WordSync._seekTargetWordTime > currentTime &&
        window.WordSync._seekTargetWordTime - currentTime <= 1.25
      ) {
        evalTime = window.WordSync._seekTargetWordTime;
      }
      if (typeof window.WordSync.activeWordIdx === 'number' && window.WordSync.activeWordIdx >= 0) {
        activeWordIdx = window.WordSync.activeWordIdx;
      } else if (window.WordSync.words && window.WordSync.words.length > 0) {
        activeWordIdx = window.WordSync.findWordIndex(evalTime);
      }
    }

    let targetIdx = -1;
    for (let i = terms.length - 1; i >= 0; i--) {
      const t = terms[i];
      if (activeWordIdx >= 0 && typeof t.wordIdx === 'number' && t.wordIdx >= 0) {
        if (t.wordIdx <= activeWordIdx) {
          targetIdx = i;
          break;
        }
      } else if (t.startSec <= evalTime + 0.35) {
        targetIdx = i;
        break;
      }
    }

    if (targetIdx === -1 && evalTime >= 0) {
      targetIdx = 0;
    }

    if (targetIdx !== -1 && targetIdx !== state.lexCompanion.currentActiveIdx) {
      setActiveCompanionTerm(targetIdx, { scrollCompanion: true });
    }
  }

  async function handleSpokenPaliTerm(termKey, termObj, options = {}) {
    if (!termKey) return;
    const terms = state.lexCompanion.allTerms;
    if (!terms || terms.length === 0) return;

    let matchedIdx = -1;
    if (options.wordId) {
      matchedIdx = terms.findIndex(t => t.wordId === options.wordId);
    }
    if (matchedIdx === -1 && typeof options.startSec === 'number') {
      matchedIdx = terms.findIndex(t => Math.abs(t.startSec - options.startSec) < 0.85);
    }
    if (matchedIdx === -1) {
      const cleanKey = String(termKey).trim().toLowerCase();
      matchedIdx = terms.findIndex(t => t.pali_plain.toLowerCase() === cleanKey);
    }

    if (matchedIdx !== -1) {
      if (options.userClicked && window.WordSync && window.WordSync.isSeekLocked()) {
        window.WordSync._lockedCompanionIdx = matchedIdx;
      }
      setActiveCompanionTerm(matchedIdx, { scrollCompanion: true });
    }

    if (options.userClicked && isCompanionBottomSheet()) {
      toggleMobileLexSheet(true);
    }
  }

  Object.assign(DD, {
    renderLexiconCard,
    loadLexiconView,
    executeLexiconSearch,
    loadDocumentInView,
    renderDocumentContent,
    renderSimpleMarkdown,
    formatInlineMd,
    normalizePaliSearch,
    filterActiveDocument,
    ensurePaliTermsLoaded,
    toggleToolbarActions,
    toggleMobileLexSheet,
    resetLexCompanion,
    cleanDefinitionText,
    getBestDefinition,
    openFullLexiconEntry,
    createCompanionCard,
    renderCompanionCards,
    buildCompanionTermsList,
    scrollCardIntoCompanionStack,
    jumpToCompanionTerm,
    setActiveCompanionTerm,
    updateActiveCompanionTerm,
    handleSpokenPaliTerm,
  });
})();
