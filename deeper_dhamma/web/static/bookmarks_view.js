/**
 * Deeper Dhamma — Bookmarks Store & Catalog View
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const {
    state,
    els,
    dbService,
    escapeHtml,
    formatEpisodeDateHtml,
    getPodbeanUrl,
    renderBookmarkRibbonSvg,
    renderTeacherBadgesHtml,
  } = DD;
  const attachCardEventListeners = (...args) => DD.attachCardEventListeners(...args);
  const loadBrowseCatalog = (...args) => DD.loadBrowseCatalog(...args);
  const switchTab = (...args) => DD.switchTab(...args);

  // ==========================================================================
  // Bookmarks Storage & Reactive State Manager (Local Episode IDs Only)
  // ==========================================================================
  const BOOKMARKS_STORAGE_KEY = 'deeper_dhamma_bookmarks';

  const BookmarkStore = {
    _ids: [],
    _set: new Set(),

    init() {
      try {
        const raw = localStorage.getItem(BOOKMARKS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this._ids = [];
            this._set = new Set();
            parsed.forEach(id => {
              if (typeof id === 'string' && id.trim() && !this._set.has(id.trim())) {
                const cleanId = id.trim();
                this._ids.push(cleanId);
                this._set.add(cleanId);
              }
            });
          }
        }
      } catch (err) {
        console.warn('[BookmarkStore] Failed to read bookmarks from localStorage:', err);
        this._ids = [];
        this._set = new Set();
      }
      this.updateBadges();
    },

    save() {
      try {
        localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(this._ids));
      } catch (err) {
        console.warn('[BookmarkStore] Failed to persist bookmarks to localStorage:', err);
      }
      this.updateBadges();
      this.syncUiButtons();
      if (state.isDbReady && state.activeTab === 'browse-view' && state.browse.bookmarkedOnly) {
        loadBrowseCatalog({ append: false, skipHistory: true });
      }
      if (state.isDbReady && state.activeTab === 'search-view' && state.search.bookmarkedOnly && typeof DD.executeSearch === 'function') {
        DD.executeSearch(state.currentQuery, { keepPage: true, skipHistory: true });
      }
    },

    getAll() {
      return [...this._ids];
    },

    count() {
      return this._ids.length;
    },

    has(epId) {
      if (!epId) return false;
      return this._set.has(String(epId));
    },

    add(epId) {
      if (!epId) return;
      const idStr = String(epId);
      if (this._set.has(idStr)) return;
      this._ids.unshift(idStr);
      this._set.add(idStr);
      this.save();
    },

    remove(epId) {
      if (!epId) return;
      const idStr = String(epId);
      if (!this._set.has(idStr)) return;
      this._ids = this._ids.filter(id => id !== idStr);
      this._set.delete(idStr);
      this.save();
    },

    toggle(epId) {
      if (!epId) return false;
      const idStr = String(epId);
      if (this.has(idStr)) {
        this.remove(idStr);
        return false;
      } else {
        this.add(idStr);
        return true;
      }
    },

    moveUp(epId) {
      const idx = this._ids.indexOf(String(epId));
      if (idx > 0) {
        const temp = this._ids[idx];
        this._ids[idx] = this._ids[idx - 1];
        this._ids[idx - 1] = temp;
        this.save();
        return true;
      }
      return false;
    },

    moveDown(epId) {
      const idx = this._ids.indexOf(String(epId));
      if (idx >= 0 && idx < this._ids.length - 1) {
        const temp = this._ids[idx];
        this._ids[idx] = this._ids[idx + 1];
        this._ids[idx + 1] = temp;
        this.save();
        return true;
      }
      return false;
    },

    moveRelativeTo(draggedId, targetId, placeBefore) {
      const dIdx = this._ids.indexOf(String(draggedId));
      if (dIdx < 0) return;
      this._ids.splice(dIdx, 1);
      let tIdx = this._ids.indexOf(String(targetId));
      if (tIdx < 0) {
        this._ids.push(String(draggedId));
      } else {
        const insertIdx = placeBefore ? tIdx : tIdx + 1;
        this._ids.splice(insertIdx, 0, String(draggedId));
      }
      this.save();
    },

    clear() {
      this._ids = [];
      this._set.clear();
      this.save();
    },

    updateBadges() {
      const count = this.count();
      if (els.bookmarksCountBadge) {
        els.bookmarksCountBadge.textContent = String(count);
      }
      if (els.bookmarksStatusCount) {
        els.bookmarksStatusCount.textContent = `${count} saved talk${count === 1 ? '' : 's'}`;
      }
      if (els.catCntBookmarked) {
        els.catCntBookmarked.textContent = count.toLocaleString();
      }
      if (els.searchCatCntBookmarked) {
        els.searchCatCntBookmarked.textContent = count.toLocaleString();
      }
    },

    syncUiButtons() {
      // Synchronize all visible bookmark ribbon buttons across the document
      document.querySelectorAll('[data-action="toggle-bookmark"]').forEach(btn => {
        const epId = btn.dataset.epId;
        const isBmk = this.has(epId);
        btn.classList.toggle('is-bookmarked', isBmk);
        btn.setAttribute('aria-label', isBmk ? 'Remove bookmark' : 'Bookmark this talk');
        btn.title = isBmk ? 'Remove bookmark' : 'Bookmark this talk';
        btn.innerHTML = renderBookmarkRibbonSvg(isBmk);
      });

      // Update transcript drawer bookmark button if open
      if (state.currentEpisode && els.transcriptBookmarkBtn) {
        const isBmk = this.has(state.currentEpisode.id);
        els.transcriptBookmarkBtn.classList.toggle('is-bookmarked', isBmk);
        els.transcriptBookmarkBtn.title = isBmk ? 'Remove bookmark' : 'Bookmark talk';
        if (els.transcriptBookmarkIcon) {
          els.transcriptBookmarkIcon.innerHTML = renderBookmarkRibbonSvg(isBmk);
        }
        if (els.transcriptBookmarkLabel) {
          els.transcriptBookmarkLabel.textContent = isBmk ? 'Bookmarked' : 'Bookmark';
        }
      }

      // Update player bar bookmark button if playing
      if (els.btnPlayerBookmark) {
        if (state.playingEpisode && state.playingEpisode.id) {
          const isBmk = this.has(state.playingEpisode.id);
          els.btnPlayerBookmark.style.display = 'inline-flex';
          els.btnPlayerBookmark.classList.toggle('is-bookmarked', isBmk);
          els.btnPlayerBookmark.dataset.epId = state.playingEpisode.id;
          els.btnPlayerBookmark.title = isBmk ? 'Remove bookmark' : 'Bookmark current talk';
          els.btnPlayerBookmark.setAttribute('aria-label', isBmk ? 'Remove bookmark' : 'Bookmark current talk');
          els.btnPlayerBookmark.innerHTML = renderBookmarkRibbonSvg(isBmk);
        } else {
          els.btnPlayerBookmark.style.display = 'none';
        }
      }
    }
  };

  // ==========================================================================
  // Bookmarks Catalog View (Local Episode IDs Only)
  // ==========================================================================

  async function loadBookmarksView() {
    if (!els.bookmarksList) return;

    // Check if database is ready
    if (!state.isDbReady) {
      els.bookmarksList.innerHTML = `
        <div class="empty-state">
          <div class="loading-spinner"></div>
          <h2>Waiting for database to load...</h2>
          <p>The talk archive database is initializing. Your bookmarked talks will load momentarily.</p>
        </div>
      `;
      if (els.bookmarksStatusBar) els.bookmarksStatusBar.style.display = 'none';
      if (els.btnClearBookmarks) els.btnClearBookmarks.style.display = 'none';
      return;
    }

    const ids = BookmarkStore.getAll();
    if (ids.length === 0) {
      els.bookmarksList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon material-symbols-outlined" aria-hidden="true">bookmark</div>
          <h2>No Bookmarked Talks Yet</h2>
          <p>Click the bookmark ribbon icon (<span class="material-symbols-outlined ms-sm" aria-hidden="true">bookmark</span>) on any talk in Search or Browse to store it locally for fast recall.</p>
          <button type="button" class="btn-primary" style="margin-top: 1rem;" id="btn-bookmarks-go-browse">
            <span class="material-symbols-outlined ms-inline" aria-hidden="true">library_music</span> Browse Talks Catalog
          </button>
        </div>
      `;
      const goBrowse = document.getElementById('btn-bookmarks-go-browse');
      if (goBrowse) {
        goBrowse.addEventListener('click', () => switchTab('browse-view'));
      }
      if (els.bookmarksStatusBar) els.bookmarksStatusBar.style.display = 'none';
      if (els.btnClearBookmarks) els.btnClearBookmarks.style.display = 'none';
      return;
    }

    if (els.bookmarksStatusBar) els.bookmarksStatusBar.style.display = 'flex';
    if (els.btnClearBookmarks) els.btnClearBookmarks.style.display = 'inline-flex';
    els.bookmarksList.innerHTML = '<div class="loading-spinner">Loading bookmarked talks...</div>';

    try {
      const episodes = await dbService.getEpisodesByIds(ids);
      if (!episodes || episodes.length === 0) {
        els.bookmarksList.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon material-symbols-outlined" aria-hidden="true">warning</div>
            <h2>No matching talks found</h2>
            <p>The bookmarked talks could not be found in the current archive index.</p>
          </div>
        `;
        return;
      }

      renderBookmarksList(episodes);
    } catch (err) {
      console.error('[Bookmarks] Failed to load bookmarked episodes:', err);
      els.bookmarksList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon material-symbols-outlined" aria-hidden="true">warning</div>
          <h2>Failed to load bookmarks</h2>
          <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem;">${escapeHtml(err.message || String(err))}</p>
        </div>
      `;
    }
  }

  function renderBookmarksList(episodes) {
    if (!els.bookmarksList) return;
    state.bookmarkEpisodes = Array.isArray(episodes) ? [...episodes] : (state.bookmarkEpisodes || []);
    const total = state.bookmarkEpisodes.length;

    let html = state.bookmarkEpisodes.map((ep, idx) => {
      const isTranscribed = Boolean(ep.is_transcribed);
      const durMin = Math.round((ep.duration_sec || 0) / 60);
      const isFirst = idx === 0;
      const isLast = idx === total - 1;

      return `
        <div class="bookmark-card" data-ep-id="${escapeHtml(ep.id)}" data-index="${idx}">
          <!-- Left Reorder Rail: Index badge + finger-tappable arrows -->
          <div class="bookmark-rail">
            <span class="bookmark-order-badge" title="Hold or drag to reorder" aria-label="Bookmark #${idx + 1}">#${idx + 1}</span>
            <div class="bookmark-reorder-group" role="group" aria-label="Reorder bookmark">
              <button type="button" class="btn-reorder btn-reorder-up" data-action="bookmark-up" data-ep-id="${escapeHtml(ep.id)}" ${isFirst ? 'disabled' : ''} title="Move talk up" aria-label="Move Up">
                <span class="material-symbols-outlined ms-sm" aria-hidden="true">arrow_upward</span>
              </button>
              <button type="button" class="btn-reorder btn-reorder-down" data-action="bookmark-down" data-ep-id="${escapeHtml(ep.id)}" ${isLast ? 'disabled' : ''} title="Move talk down" aria-label="Move Down">
                <span class="material-symbols-outlined ms-sm" aria-hidden="true">arrow_downward</span>
              </button>
            </div>
          </div>

          <!-- Main Content Area -->
          <div class="bookmark-body">
            <!-- Top Line: Metadata pills on left, Remove action on right -->
            <div class="bookmark-meta-bar">
              <div class="bookmark-meta-pills">
                ${renderTeacherBadgesHtml(ep)}
                ${formatEpisodeDateHtml(ep, 'bookmark-meta-item')}
                ${durMin > 0 ? `<span class="bookmark-meta-item">• <span class="material-symbols-outlined ms-sm" aria-hidden="true">schedule</span> ${durMin}m</span>` : ''}
              </div>
              <button type="button" class="btn-remove-bookmark" data-action="remove-bookmark" data-ep-id="${escapeHtml(ep.id)}" title="Remove bookmark" aria-label="Remove from bookmarks">
                ${renderBookmarkRibbonSvg(true)}
                <span class="remove-label">Remove</span>
              </button>
            </div>

            <!-- Middle Line: Title -->
            <h3 class="bookmark-title" title="${escapeHtml(ep.title)}">${escapeHtml(ep.title)}</h3>

            <!-- Bottom Line: Playback & Export Actions -->
            <div class="bookmark-actions-bar">
              <button type="button" class="btn-primary btn-sm" data-action="play-ep-start" data-ep-id="${escapeHtml(ep.id)}">
                <span class="material-symbols-outlined ms-sm" aria-hidden="true">play_arrow</span> Play Talk
              </button>
              ${isTranscribed ? `
                <button type="button" class="btn-secondary btn-sm" data-action="view-transcript" data-ep-id="${escapeHtml(ep.id)}">
                  <span class="material-symbols-outlined ms-sm" aria-hidden="true">article</span> Transcript
                </button>
                <div class="download-dropdown-wrapper">
                  <button type="button" class="btn-secondary btn-sm download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                    <span class="material-symbols-outlined ms-sm" aria-hidden="true">download</span> Download <span class="material-symbols-outlined ms-sm" aria-hidden="true">arrow_drop_down</span>
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
              ` : ''}
              ${ep.permalink ? `
                <a href="${getPodbeanUrl(ep.permalink)}" target="_blank" rel="noopener noreferrer" class="link-btn btn-sm bookmark-podbean-link">
                  ↗ Podbean
                </a>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    els.bookmarksList.innerHTML = html;
    attachBookmarkCardEvents(els.bookmarksList, episodes);
  }

  function attachBookmarkCardEvents(container, episodes) {
    if (Array.isArray(episodes)) {
      state.bookmarkEpisodes = [...episodes];
    }
    attachCardEventListeners(container, state.bookmarkEpisodes);

    // Remove bookmark
    container.querySelectorAll('[data-action="remove-bookmark"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const epId = btn.dataset.epId;
        BookmarkStore.remove(epId);
        loadBookmarksView();
      });
    });

    // Move Up with generic physics step exchange
    container.querySelectorAll('[data-action="bookmark-up"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.bookmark-card');
        if (card && state.bookmarkPhysics) {
          state.bookmarkPhysics.stepExchange(card, 'up');
        }
      });
    });

    // Move Down with generic physics step exchange
    container.querySelectorAll('[data-action="bookmark-down"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = btn.closest('.bookmark-card');
        if (card && state.bookmarkPhysics) {
          state.bookmarkPhysics.stepExchange(card, 'down');
        }
      });
    });

    // Physics lifecycle callbacks bound dynamically to state.bookmarkEpisodes and BookmarkStore
    const physicsCallbacks = {
      onExchange: (fromIdx, toIdx, fromId, toId, direction) => {
        if (direction === 'up') {
          BookmarkStore.moveUp(fromId);
        } else {
          BookmarkStore.moveDown(fromId);
        }
        // Resequence state.bookmarkEpisodes based on BookmarkStore.getAll()
        const epMap = new Map((state.bookmarkEpisodes || []).map(ep => [String(ep.id), ep]));
        state.bookmarkEpisodes = BookmarkStore.getAll().map(id => epMap.get(id)).filter(Boolean);
      },
      onReorder: (fromIdx, toIdx, fromId, targetId, placeBefore) => {
        if (targetId) {
          BookmarkStore.moveRelativeTo(fromId, targetId, placeBefore);
        }
        // Resequence state.bookmarkEpisodes based on BookmarkStore.getAll()
        const epMap = new Map((state.bookmarkEpisodes || []).map(ep => [String(ep.id), ep]));
        state.bookmarkEpisodes = BookmarkStore.getAll().map(id => epMap.get(id)).filter(Boolean);
      },
      onRender: () => {
        renderBookmarksList(state.bookmarkEpisodes);
      },
    };

    // Decoupled CardPhysics engine integration
    if (!state.bookmarkPhysics) {
      state.bookmarkPhysics = new CardPhysics({
        container,
        itemSelector: '.bookmark-card',
        handleSelector: '.bookmark-order-badge',
        idAttribute: 'data-ep-id',
        classes: {
          ghost: 'is-ghost',
          floating: 'bookmark-floating-drag-card',
          indicator: 'bookmark-drop-indicator',
          activeExchange: 'is-exchanging-active',
          targetExchange: 'is-exchanging-target',
          landed: 'just-exchanged',
        },
        ...physicsCallbacks,
      });
    } else {
      state.bookmarkPhysics.attach(container, physicsCallbacks);
    }
  }

  Object.assign(DD, {
    BOOKMARKS_STORAGE_KEY,
    BookmarkStore,
    loadBookmarksView,
    renderBookmarksList,
    attachBookmarkCardEvents,
  });
})();
