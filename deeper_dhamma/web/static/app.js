/**
 * Deeper Dhamma — Frontend Application Logic
 * Fast debounced full-text search, direct Podbean CDN audio streaming,
 * interactive transcript seeking, and Pali lexicon exploration.
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const {
    BOOKMARKS_STORAGE_KEY,
    BookmarkStore,
    applyBrowseParamsFromRoute,
    buildBrowseRouteHash,
    buildCompanionTermsList,
    closeAllBrowsePopovers,
    closePlayerSettings,
    copyTextToClipboard,
    ensurePaliTermsLoaded,
    escapeHtml,
    executeLexiconSearch,
    executeSearch,
    filterActiveDocument,
    formatSeconds,
    formatTranscriptParagraphs,
    getPodbeanUrl,
    getShareBaseUrl,
    getSpeakerColor,
    getSpeakerInitials,
    handleSpokenPaliTerm,
    jumpToCompanionTerm,
    loadBookmarksView,
    loadBrowseCatalog,
    loadDocumentInView,
    loadLexiconView,
    openFullLexiconEntry,
    parseTimestampToSeconds,
    playAudioSegment,
    populateBrowseFilterFacets,
    renderTeacherBadgesHtml,
    resetLexCompanion,
    scrollCardIntoCompanionStack,
    scrollContentTo,
    scrollElementIntoReadingZone,
    setupAudioEngine,
    setupBrowseFilterListeners,
    setupDownloadDropdowns,
    toggleMobileLexSheet,
    togglePlayPause,
    toggleToolbarActions,
    updateActiveCompanionTerm,
  } = DD;
  const safeSeek = (targetPhysicalTime) => DD.safeSeek && DD.safeSeek(targetPhysicalTime);

  // State Management
  const state = Object.assign((DD.state = DD.state || {}), {
    currentQuery: '',
    searchDebounceTimer: null,
    currentEpisode: null,
    playingEpisode: null,
    currentMediaUrl: '',
    playbackSpeed: 1.0,
    activeTab: 'search-view',
    previousTab: 'search-view',
    historyDepth: 0,
    stats: null,
    teachers: {},
    browseTeachers: [],
    browseYears: [],
    catalog: [],
    browse: {
      offset: 0,
      limit: 60,
      total: 0,
      totalDurationSec: 0,
      filteredEpisodeIds: [],
      loadedOnce: false,
      teachers: [],
      teacherMatch: 'any',
      years: [],
      titleQuery: '',
      titleWholeWord: false,
      durationBuckets: [],
      minDurationMin: '',
      maxDurationMin: '',
      collections: [],
      formats: [],
      coTaughtOnly: false,
      bookmarkedOnly: false,
      sort: 'year_desc',
      debounceTimer: null,
    },
    search: {
      offset: 0,
      limit: 50,
      totalEpisodes: 0,
      totalSegments: 0,
      filteredEpisodeIds: [],
      filteredFilterOpts: null,
    },
    currentFilteredTalks: [],
    dateFilterMode: 'year',
    archiveCancelRequested: false,
    isDbReady: false,
    bookmarkEpisodes: [],
    bookmarkPhysics: null,
    lexicon: {
      term: '',
      mode: 'core',
      category: 'all',
      letter: 'all',
      sort: 'pali_asc',
      page: 1,
      limit: 25,
      total: 0,
      totalPages: 1,
      loadedOnce: false,
    },
    lexCompanion: {
      allTerms: [],
      currentActiveIdx: -1,
      isExpandedMobile: false,
      loadedOnce: false,
    },
    _audioSeekSeq: 0,
    _transcriptLoadSeq: 0,
    documents: {
      activeDocId: 1,
      cachedDocs: {},
      loadedOnce: false,
      filterQuery: '',
    },
  });

  // DOM Elements Cache
  const els = Object.assign((DD.els = DD.els || {}), {
    // Inputs & Filters
    searchInput: document.getElementById('search-input'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    exactCheckbox: document.getElementById('exact-mode-checkbox'),
    teacherFilter: document.getElementById('teacher-filter-select'),
    yearFilter: document.getElementById('year-filter-select'),
    btnModeYear: document.getElementById('btn-mode-year'),
    btnModeRange: document.getElementById('btn-mode-range'),
    dateRangeInputs: document.getElementById('date-range-inputs'),
    startDateInput: document.getElementById('start-date-input'),
    endDateInput: document.getElementById('end-date-input'),
    sortOrderSelect: document.getElementById('sort-order-select'),
    resetFiltersBtn: document.getElementById('reset-filters-btn'),

    // Search Actions & Archive Buttons
    searchActionsBar: document.getElementById('search-actions-bar'),
    filteredArchiveDropdownWrapper: document.getElementById('filtered-archive-dropdown-wrapper'),
    btnDownloadFilteredArchive: document.getElementById('btn-download-filtered-archive'),
    filteredArchiveCount: document.getElementById('filtered-archive-count'),
    allArchiveDropdownWrapper: document.getElementById('all-archive-dropdown-wrapper'),
    btnDownloadAllArchive: document.getElementById('btn-download-all-archive'),

    // Single Talk Dropdown in Reader View
    singleTalkDropdownWrapper: document.getElementById('single-talk-dropdown-wrapper'),
    drawerDownloadBtn: document.getElementById('drawer-download-btn'),

    // Archive Progress Modal
    archiveProgressModal: document.getElementById('archive-progress-modal'),
    archiveModalTitle: document.getElementById('archive-modal-title'),
    archiveModalSubtitle: document.getElementById('archive-modal-subtitle'),
    archiveProgressBar: document.getElementById('archive-progress-bar'),
    archiveProgressPercent: document.getElementById('archive-progress-percent'),
    archiveProgressCount: document.getElementById('archive-progress-count'),
    archiveModalCurrentItem: document.getElementById('archive-modal-current-item'),
    archiveCancelBtn: document.getElementById('archive-cancel-btn'),
    
    // Stats & Tabs
    statEpisodes: document.getElementById('stat-episodes'),
    tabSearchBtn: document.getElementById('tab-search-btn'),
    tabBrowseBtn: document.getElementById('tab-browse-btn'),
    tabBookmarksBtn: document.getElementById('tab-bookmarks-btn'),
    tabLexiconBtn: document.getElementById('tab-lexicon-btn'),
    tabTranscriptBtn: document.getElementById('tab-transcript-btn'),
    searchCountBadge: document.getElementById('search-count-badge'),
    browseCountBadge: document.getElementById('browse-count-badge'),
    bookmarksCountBadge: document.getElementById('bookmarks-count-badge'),

    // Views
    searchView: document.getElementById('search-view'),
    browseView: document.getElementById('browse-view'),
    bookmarksView: document.getElementById('bookmarks-view'),
    lexiconView: document.getElementById('lexicon-view'),
    transcriptView: document.getElementById('transcript-view'),

    // Bookmarks Content
    bookmarksList: document.getElementById('bookmarks-list'),
    bookmarksStatusBar: document.getElementById('bookmarks-status-bar'),
    bookmarksStatusCount: document.getElementById('bookmarks-status-count'),
    btnClearBookmarks: document.getElementById('btn-clear-bookmarks'),
    
    // Search Content
    searchResultsHeader: document.getElementById('search-results-header'),
    searchMetaBar: document.getElementById('search-meta-bar'),
    queryMetaText: document.getElementById('query-meta-text'),
    queryTierBadge: document.getElementById('query-tier-badge'),
    searchEmptyState: document.getElementById('search-empty-state'),
    searchEmptyHeading: document.getElementById('search-empty-heading'),
    searchResultsList: document.getElementById('search-results-list'),
    searchPagination: document.getElementById('search-pagination'),
    btnSearchFirst: document.getElementById('btn-search-first'),
    btnSearchPrev: document.getElementById('btn-search-prev'),
    btnSearchNext: document.getElementById('btn-search-next'),
    btnSearchLast: document.getElementById('btn-search-last'),
    searchPageIndicator: document.getElementById('search-page-indicator'),
    exampleChips: document.getElementById('example-queries'),

    // Browse Content & Multi-Faceted Filter Controls
    browseGrid: document.getElementById('browse-episodes-grid'),
    browseLoadMoreWrap: document.getElementById('browse-load-more-wrap'),
    btnBrowseLoadMore: document.getElementById('btn-browse-load-more'),
    btnBrowseShowAll: document.getElementById('btn-browse-show-all'),
    browseTitleInput: document.getElementById('browse-title-input'),
    browseClearTitleBtn: document.getElementById('browse-clear-title-btn'),
    browseTitleWordCheckbox: document.getElementById('browse-title-word-checkbox'),
    browseTeachersDropdown: document.getElementById('browse-teachers-dropdown'),
    browseTeachersBtn: document.getElementById('browse-teachers-btn'),
    browseTeachersLabel: document.getElementById('browse-teachers-label'),
    browseTeachersSearch: document.getElementById('browse-teachers-search'),
    browseTeachersSelectedInfo: document.getElementById('browse-teachers-selected-info'),
    browseTeachersModeHint: document.getElementById('browse-teachers-mode-hint'),
    btnTeacherModeAny: document.getElementById('btn-teacher-mode-any'),
    btnTeacherModeAll: document.getElementById('btn-teacher-mode-all'),
    btnBrowseTeachersClear: document.getElementById('btn-browse-teachers-clear'),
    browseTeachersList: document.getElementById('browse-teachers-list'),
    browseYearsDropdown: document.getElementById('browse-years-dropdown'),
    browseYearsBtn: document.getElementById('browse-years-btn'),
    browseYearsLabel: document.getElementById('browse-years-label'),
    browseEraPresets: document.getElementById('browse-era-presets'),
    btnBrowseYearsClear: document.getElementById('btn-browse-years-clear'),
    browseYearFrom: document.getElementById('browse-year-from'),
    browseYearTo: document.getElementById('browse-year-to'),
    btnBrowseYearRangeAdd: document.getElementById('btn-browse-year-range-add'),
    browseYearsGrid: document.getElementById('browse-years-grid'),
    browseDurationDropdown: document.getElementById('browse-duration-dropdown'),
    browseDurationBtn: document.getElementById('browse-duration-btn'),
    browseDurationLabel: document.getElementById('browse-duration-label'),
    browseDurationBuckets: document.getElementById('browse-duration-buckets'),
    browseMinDuration: document.getElementById('browse-min-duration'),
    browseMaxDuration: document.getElementById('browse-max-duration'),
    btnBrowseDurationClear: document.getElementById('btn-browse-duration-clear'),
    browseCategoryDropdown: document.getElementById('browse-category-dropdown'),
    browseCategoryBtn: document.getElementById('browse-category-btn'),
    browseCategoryLabel: document.getElementById('browse-category-label'),
    browseCollectionsList: document.getElementById('browse-collections-list'),
    browseFormatsList: document.getElementById('browse-formats-list'),
    browseCotaughtCheckbox: document.getElementById('browse-cotaught-checkbox'),
    browseBookmarkedCheckbox: document.getElementById('browse-bookmarked-checkbox'),
    btnBrowseCategoryClear: document.getElementById('btn-browse-category-clear'),
    browseSortSelect: document.getElementById('browse-sort-select'),
    browseResetFiltersBtn: document.getElementById('browse-reset-filters-btn'),
    browseResultStats: document.getElementById('browse-result-stats'),
    browseActiveChips: document.getElementById('browse-active-chips'),
    browseFilteredArchiveDropdownWrapper: document.getElementById('browse-filtered-archive-dropdown-wrapper'),
    btnBrowseDownloadFiltered: document.getElementById('btn-browse-download-filtered'),
    browseFilteredArchiveCount: document.getElementById('browse-filtered-archive-count'),
    catCntBookmarked: document.getElementById('cat-cnt-bookmarked'),

    // Lexicon Content
    lexiconInput: document.getElementById('lexicon-search-input'),
    lexiconResults: document.getElementById('lexicon-results-list'),
    btnLexCore: document.getElementById('btn-lexicon-core'),
    btnLexAll: document.getElementById('btn-lexicon-all'),
    lexSortSelect: document.getElementById('lexicon-sort-select'),
    lexCategoryBar: document.getElementById('lexicon-category-bar'),
    lexAlphabetBar: document.getElementById('lexicon-alphabet-bar'),
    lexCountText: document.getElementById('lexicon-count-text'),
    lexPagination: document.getElementById('lexicon-pagination'),
    btnLexFirst: document.getElementById('btn-lex-first'),
    btnLexPrev: document.getElementById('btn-lex-prev'),
    btnLexNext: document.getElementById('btn-lex-next'),
    btnLexLast: document.getElementById('btn-lex-last'),
    lexPageIndicator: document.getElementById('lex-page-indicator'),
    lexLimitSelect: document.getElementById('lex-limit-select'),
    btnLexSources: document.getElementById('btn-lex-sources'),

    // Documents View Elements
    tabDocsBtn: document.getElementById('tab-documents-btn'),
    documentsView: document.getElementById('documents-view'),
    docTabsBar: document.getElementById('doc-tabs-bar'),
    docActiveTitle: document.getElementById('doc-active-title'),
    docActiveByline: document.getElementById('doc-active-byline'),
    docActiveRemoteLink: document.getElementById('doc-active-remote-link'),
    docActiveMirrorLink: document.getElementById('doc-active-mirror-link'),
    docChipRetrieved: document.getElementById('doc-chip-retrieved'),
    docChipFormat: document.getElementById('doc-chip-format'),
    docChipSize: document.getElementById('doc-chip-size'),
    docChipSha: document.getElementById('doc-chip-sha'),
    docFilterInput: document.getElementById('doc-filter-input'),
    clearDocFilterBtn: document.getElementById('clear-doc-filter-btn'),
    docFilterCount: document.getElementById('doc-filter-count'),
    docRenderedBody: document.getElementById('doc-rendered-body'),

    // About View Elements
    tabAboutBtn: document.getElementById('tab-about-btn'),
    aboutView: document.getElementById('about-view'),
    aboutTalksChip: document.getElementById('about-talks-chip'),
    btnAboutArchiveNotes: document.getElementById('btn-about-archive-notes'),
    aboutAppVersion: document.getElementById('about-app-version'),
    btnAboutResetCache: document.getElementById('btn-about-reset-cache'),

    // Archive Notes View Elements
    tabNotesBtn: document.getElementById('tab-notes-btn'),
    notesView: document.getElementById('notes-view'),
    notesChipTranscribed: document.getElementById('notes-chip-transcribed'),
    notesChipHours: document.getElementById('notes-chip-hours'),
    notesChipSegments: document.getElementById('notes-chip-segments'),
    notesTblTranscribed: document.getElementById('notes-tbl-transcribed'),
    notesSvgTranscribed: document.getElementById('notes-svg-transcribed'),

    // Transcript View Elements
    transcriptBackBtn: document.getElementById('transcript-back-btn'),
    transcriptPlayBtn: document.getElementById('transcript-play-btn'),
    transcriptStickyToolbar: document.getElementById('transcript-sticky-toolbar'),
    btnToggleToolbarActions: document.getElementById('btn-toggle-toolbar-actions'),
    drawerTitle: document.getElementById('drawer-episode-title'),
    drawerDateTag: document.getElementById('drawer-date-tag'),
    drawerMetaInfo: document.getElementById('drawer-meta-info'),
    drawerPodbeanLink: document.getElementById('drawer-podbean-link'),
    drawerShareBtn: document.getElementById('drawer-share-btn'),
    drawerTurns: document.getElementById('drawer-turns-container'),

    // Lexicon Companion Elements
    lexCompanion: document.getElementById('transcript-lexicon-companion'),
    lexMobileTicker: document.getElementById('lex-mobile-ticker'),
    lexTickerTrigger: document.getElementById('lex-ticker-trigger'),
    mobileTickerTerm: document.getElementById('mobile-ticker-term'),
    mobileTickerDef: document.getElementById('mobile-ticker-def'),
    mobileSheetCount: document.getElementById('mobile-sheet-count'),
    btnToggleLexSheet: document.getElementById('btn-toggle-lex-sheet'),
    btnCloseLexSheet: document.getElementById('btn-close-lex-sheet'),
    lexStackBadge: document.getElementById('lex-stack-badge'),
    btnClearLexStack: document.getElementById('btn-clear-lex-stack'),
    lexiconStack: document.getElementById('transcript-lexicon-stack'),
    lexStackEmpty: document.getElementById('lex-stack-empty'),

    // Audio Player
    playerBar: document.getElementById('audio-player-bar'),
    nativeAudio: document.getElementById('native-audio'),
    playerTitle: document.getElementById('player-track-title'),
    playerSpeaker: document.getElementById('player-track-speaker'),
    btnPlayerTranscript: document.getElementById('btn-player-transcript'),
    btnPlayerBookmark: document.getElementById('btn-player-bookmark'),
    btnPlayerSettings: document.getElementById('btn-player-settings'),
    playerSettingsView: document.getElementById('player-settings-view'),
    btnClosePlayerSettings: document.getElementById('btn-close-player-settings'),
    playerSettingsSpeedVal: document.getElementById('player-settings-speed-val'),
    playerSettingsVolVal: document.getElementById('player-settings-vol-val'),
    transcriptBookmarkBtn: document.getElementById('transcript-bookmark-btn'),
    transcriptBookmarkIcon: document.getElementById('transcript-bookmark-icon'),
    transcriptBookmarkLabel: document.getElementById('transcript-bookmark-label'),
    btnPrevTrack: document.getElementById('btn-prev-track'),
    btnPlayPause: document.getElementById('btn-play-pause'),
    btnNextTrack: document.getElementById('btn-next-track'),
    btnSkipBack: document.getElementById('btn-skip-back'),
    btnSkipFwd: document.getElementById('btn-skip-fwd'),
    scrubber: document.getElementById('audio-scrubber'),
    timeCurrent: document.getElementById('time-current'),
    timeTotal: document.getElementById('time-total'),
    speedBtns: document.querySelectorAll('.speed-btn'),
    volumeSlider: document.getElementById('volume-slider'),
    volIcon: document.getElementById('vol-icon'),
    volToggleBtn: document.getElementById('vol-toggle-btn'),
  });

  // ==========================================================================
  // Database Service (Injected Adapter: ApiDatabaseClient or WasmDatabaseClient)
  // ==========================================================================

  const dbService = (DD.dbService = DD.dbService || (window.DeeperDhammaDB ? new window.DeeperDhammaDB() : null));
  if (!dbService) {
    console.error('[App] No DeeperDhammaDB database client found. Ensure db_client.js is loaded.');
  }
  window.dbClient = dbService;
  if (window.WordSync && dbService) {
    window.WordSync.setDbClient(dbService);
  }

  // ==========================================================================
  // SPA History & Hash Router
  // ==========================================================================

  const router = {
    parseLocation() {
      const searchParams = new URLSearchParams(window.location.search || '');
      const hash = window.location.hash.replace(/^#\/?/, '').trim();
      const pathname = window.location.pathname.replace(/^\/+/, '').trim();

      let route = 'search';
      let id = null;
      const params = {};

      // 1. Parse Query String parameters (?talk=pb... or ?q=... or ?t=...)
      for (const [k, v] of searchParams.entries()) {
        params[k.toLowerCase()] = v;
      }

      if (params.talk || params.episode || params.ep || params.id) {
        route = 'talk';
        id = params.talk || params.episode || params.ep || params.id;
      } else if (params.q) {
        route = 'search';
      } else if (params.pali || params.term) {
        route = 'lexicon';
        params.term = params.pali || params.term;
      } else if (params.doc || params.document) {
        route = 'documents';
        params.id = params.doc || params.document;
      } else if (params.tab) {
        route = params.tab.replace(/-view$/, '').toLowerCase();
      }

      // 2. Parse Pathname (/talk/pb... or /browse or /lexicon or /documents)
      // Supports both root deployments (/talk/pb...) and subpath deployments (/repo/talk/pb...)
      if (pathname) {
        const segments = pathname.split('/').filter(Boolean);
        const talkIdx = segments.indexOf('talk');
        if (talkIdx !== -1 && segments[talkIdx + 1]) {
          route = 'talk';
          id = segments[talkIdx + 1].trim();
        } else if (segments.length > 0) {
          const last = segments[segments.length - 1];
          if (['browse', 'lexicon', 'documents', 'search', 'bookmarks', 'about', 'notes'].includes(last)) {
            route = last;
          }
        }
      }

      // 3. Parse Hash (#talk/pb... or #browse or #search?q=...)
      if (hash) {
        const [pathPart, hashQueryPart] = hash.split('?');
        if (hashQueryPart) {
          const hashParams = new URLSearchParams(hashQueryPart);
          for (const [k, v] of hashParams.entries()) {
            params[k.toLowerCase()] = v;
          }
        }
        const cleanPath = pathPart.replace(/^\/+/, '').trim();
        if (cleanPath.startsWith('talk/')) {
          route = 'talk';
          id = cleanPath.replace('talk/', '').trim();
        } else if (['browse', 'lexicon', 'documents', 'search', 'bookmarks', 'about', 'notes'].includes(cleanPath)) {
          route = cleanPath;
        } else if (cleanPath) {
          route = cleanPath;
        }
      }

      // Parse timestamp if present (t=120 or t=2:05)
      if (params.t) {
        params.time = parseTimestampToSeconds(params.t);
      }

      return { route, id, params };
    },

    navigate(hashString, replace = false) {
      const cleanHash = '#' + hashString.replace(/^#/, '');
      if (window.location.hash === cleanHash) return;

      if (replace) {
        window.history.replaceState({ route: cleanHash }, '', cleanHash);
      } else {
        state.historyDepth++;
        window.history.pushState({ route: cleanHash }, '', cleanHash);
      }
      this.handleRoute();
    },

    async handleRoute() {
      const { route, id, params } = this.parseLocation();

      switch (route) {
        case 'talk':
          if (id) {
            const targetOpts = (params.time !== undefined && !isNaN(params.time)) ? {
              fallbackSec: params.time,
              autoPlay: true,
            } : null;
            await openTranscriptDrawer(id, targetOpts, { skipHistory: true });
          } else {
            this.navigate('search', true);
          }
          break;

        case 'browse':
          applyBrowseParamsFromRoute(params);
          switchTab('browse-view', { skipHistory: true });
          loadBrowseCatalog({ append: false, skipHistory: true });
          break;

        case 'bookmarks':
          switchTab('bookmarks-view', { skipHistory: true });
          break;

        case 'lexicon':
          switchTab('lexicon-view', { skipHistory: true });
          if (params.term) {
            state.lexicon.term = params.term;
            if (els.lexiconInput) els.lexiconInput.value = params.term;
            if (els.lexAlphabetBar) els.lexAlphabetBar.style.display = 'none';
            if (els.lexPagination) els.lexPagination.style.display = 'none';
            if (els.lexCountText) els.lexCountText.textContent = `Search results for "${params.term}"`;
            executeLexiconSearch(params.term);
          } else if (state.lexicon.term) {
            state.lexicon.term = '';
            if (els.lexiconInput) els.lexiconInput.value = '';
            if (els.lexCategoryBar) els.lexCategoryBar.style.display = 'flex';
            if (els.lexAlphabetBar && state.lexicon.mode === 'all') els.lexAlphabetBar.style.display = 'flex';
            loadLexiconView();
          }
          break;

        case 'documents':
          if (params.id) {
            state.documents.activeDocId = parseInt(params.id, 10) || 1;
          }
          if (params.q !== undefined || params.filter !== undefined || params.term !== undefined) {
            state.documents.filterQuery = params.q || params.filter || params.term || '';
          }
          switchTab('documents-view', { skipHistory: true });
          break;

        case 'about':
          switchTab('about-view', { skipHistory: true });
          break;

        case 'notes':
          switchTab('notes-view', { skipHistory: true });
          break;

        case 'search':
        default:
          switchTab('search-view', { skipHistory: true });
          const targetQ = params.q || '';
          if (targetQ !== state.currentQuery) {
            if (els.searchInput) {
              els.searchInput.value = targetQ;
              els.clearSearchBtn.style.display = targetQ.length > 0 ? 'inline-block' : 'none';
            }
            executeSearch(targetQ, { skipHistory: true });
          } else if (!targetQ && state.currentQuery) {
            if (els.searchInput) {
              els.searchInput.value = '';
              els.clearSearchBtn.style.display = 'none';
            }
            executeSearch('', { skipHistory: true });
          }
          break;
      }
    },
  };

  // ==========================================================================
  // Initialization
  // ==========================================================================

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      window.addEventListener('load', () => {
        const swVer = (typeof window !== 'undefined' && window.__DEEPER_DHAMMA_VERSION__)
          ? `?v=${encodeURIComponent(window.__DEEPER_DHAMMA_VERSION__)}`
          : '';
        navigator.serviceWorker.register(`./svc_worker.js${swVer}`)
          .then((reg) => {
            console.log('[ServiceWorker] Registered with scope:', reg.scope);
            if (reg.update) reg.update().catch(() => {});
          })
          .catch((err) => {
            console.warn('[ServiceWorker] Registration failed:', err);
          });
      });
    }
  }

  async function init() {
    registerServiceWorker();
    BookmarkStore.init();
    setupEventListeners();
    setupAudioEngine();
    if (window.WordSync) {
      window.WordSync.init();
      if (dbService) {
        window.WordSync.setDbClient(dbService);
      }
    }
    if (!dbService) return;
    try {
      await dbService.init();
      state.isDbReady = true;

      // Seamless background hot-swap & offline PWA sync listener
      dbService.onSyncProgress = (p) => {
        const syncEl = document.getElementById('stat-offline-sync');
        if (!syncEl || !p) return;
        syncEl.style.display = 'block';
        const mbDone = (p.loadedBytes / (1024 * 1024)).toFixed(0);
        const mbTotal = Math.max(1, Math.round(p.totalBytes / (1024 * 1024)));
        if (p.fullOfflineReady || p.phase === 'complete') {
          syncEl.textContent = `Offline PWA ready (${mbTotal} MB cached)`;
        } else if (p.textSearchReady) {
          syncEl.textContent = `Offline search ready • syncing word-sync (${mbDone}/${mbTotal} MB)`;
        } else {
          syncEl.textContent = `Syncing offline search (${p.talksReady}/${p.talksTotal}, ${mbDone}/${mbTotal} MB)...`;
        }
      };

      dbService.onHotSwap = (data) => {
        console.log(`[App] Database hot-swapped seamlessly in background: v${data.version} (${data.size} bytes).`);
        loadArchiveStats();
        if (state.activeTab === 'browse-view') {
          loadBrowseCatalog({ append: false });
        } else if (state.activeTab === 'search-view' && els.searchInput && els.searchInput.value.trim()) {
          executeSearch(els.searchInput.value.trim());
        } else if (state.activeTab === 'bookmarks-view') {
          loadBookmarksView();
        } else if (state.activeTab === 'transcript-view' && state.currentEpisode && state.currentEpisode.id) {
          ensurePaliTermsLoaded();
          openTranscriptDrawer(state.currentEpisode.id, null, { skipHistory: true });
        }
      };

      await loadArchiveStats();

      // Initialize router state from URL (hash, search params, or pathname)
      const hasInitialRoute = Boolean(
        window.location.hash ||
        window.location.search ||
        (window.location.pathname && window.location.pathname.length > 1)
      );
      if (hasInitialRoute) {
        const parsedInit = router.parseLocation();
        if (parsedInit.route !== 'browse') {
          await loadBrowseCatalog();
        }
        await router.handleRoute();
      } else {
        await loadBrowseCatalog();
        window.history.replaceState({ route: '#search' }, '', '#search');
      }

      if (state.activeTab === 'bookmarks-view') {
        loadBookmarksView();
      }

      // Preload Pali glossary tooltip index in background without blocking initial route interaction
      ensurePaliTermsLoaded();
    } catch (err) {
      console.error('[App] Failed to initialize database service:', err);
      if (els.browseGrid) {
        els.browseGrid.innerHTML = `
          <div class="empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">⚠️</div>
            <h3>Failed to load audio archive index</h3>
            <p style="color: var(--text-muted);">${escapeHtml(err.message || String(err))}</p>
            <button type="button" class="btn-primary" style="margin-top: 1rem;" onclick="window.resetDeeperDhammaCache()">
              🔄 Reset Cache & Reload
            </button>
          </div>
        `;
      }
    }
  }

  // ==========================================================================
  // Stats & Metadata Loading
  // ==========================================================================

  async function loadArchiveStats() {
    try {
      const data = await dbService.getStats();
      state.stats = data;
      if (data.teacher_map) {
        state.teachers = data.teacher_map;
      }

      const transcribedCount = Number(data.transcribed_episodes || 0);
      const transcribedFormatted = transcribedCount.toLocaleString();
      const transcribedHoursFormatted = Number(data.transcribed_hours || 0).toLocaleString();
      const totalSegmentsFormatted = Number(data.total_segments || 0).toLocaleString();

      if (els.statEpisodes) {
        els.statEpisodes.textContent = `${transcribedFormatted} transcribed talks (${transcribedHoursFormatted} hrs)`;
      }
      if (els.searchEmptyHeading && transcribedCount > 0) {
        els.searchEmptyHeading.textContent = `Search ${transcribedFormatted} English Theravada Teachings`;
      }
      if (els.aboutTalksChip && transcribedCount > 0) {
        els.aboutTalksChip.innerHTML = `<span class="chip-icon">🪷</span> ${transcribedFormatted} English Monastic Talks`;
      }
      if (els.notesChipTranscribed && transcribedCount > 0) {
        els.notesChipTranscribed.innerHTML = `<span class="chip-icon">✓</span> ${transcribedFormatted} Unique Transcribed Talks`;
      }
      if (els.notesChipHours && data.transcribed_hours) {
        els.notesChipHours.innerHTML = `<span class="chip-icon">⏱️</span> ${transcribedHoursFormatted} Audio Hours`;
      }
      if (els.notesChipSegments && data.total_segments) {
        els.notesChipSegments.innerHTML = `<span class="chip-icon">💬</span> ${totalSegmentsFormatted} Spoken Turns`;
      }
      if (els.notesTblTranscribed && transcribedCount > 0) {
        els.notesTblTranscribed.textContent = transcribedFormatted;
      }
      if (els.notesSvgTranscribed && transcribedCount > 0) {
        els.notesSvgTranscribed.textContent = transcribedFormatted;
      }

      // Populate search filter dropdowns (idempotent across hot-swaps)
      if (data.teachers && els.teacherFilter) {
        els.teacherFilter.innerHTML = '<option value="">All Monastics</option>';
        data.teachers.forEach(t => {
          const opt1 = document.createElement('option');
          opt1.value = t;
          opt1.textContent = t;
          els.teacherFilter.appendChild(opt1);
        });
      }

      if (data.years && els.yearFilter) {
        els.yearFilter.innerHTML = '<option value="">All Years</option>';
        data.years.forEach(y => {
          const opt1 = document.createElement('option');
          opt1.value = y;
          opt1.textContent = y;
          els.yearFilter.appendChild(opt1);
        });
      }

      // Populate multi-faceted Browse filter UI
      populateBrowseFilterFacets(data);

      if (els.btnDownloadAllArchive && data.transcribed_episodes) {
        els.btnDownloadAllArchive.innerHTML = `📦 Download All Transcripts (${data.transcribed_episodes}) ▾`;
      }
    } catch (err) {
      console.error('Failed to load archive stats:', err);
    }
  }

  function attachCardEventListeners(container, episodes) {
    container.querySelectorAll('[data-action="play-ep-start"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const epId = btn.dataset.epId;
        const ep = episodes.find(e => (e.id || e.episode_id) === epId);
        if (ep) {
          playAudioSegment({
            episode_id: ep.id || ep.episode_id,
            media_url: ep.media_url,
            title: ep.title,
            teacher: ep.teacher || ep.primary_display,
            start_sec: 0,
          });
        }
      });
    });

    container.querySelectorAll('[data-action="view-transcript"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const epId = btn.dataset.epId || btn.dataset.episodeId;
        openTranscriptDrawer(epId);
      });
    });

    container.querySelectorAll('[data-action="toggle-bookmark"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const epId = btn.dataset.epId;
        if (epId) {
          BookmarkStore.toggle(epId);
          if (state.activeTab === 'bookmarks-view') {
            loadBookmarksView();
          }
        }
      });
    });
  }

  // ==========================================================================
  // Event Listeners
  // ==========================================================================

  function setupEventListeners() {
    // Search input debounced execution
    els.searchInput.addEventListener('input', () => {
      const q = els.searchInput.value.trim();
      els.clearSearchBtn.style.display = q.length > 0 ? 'inline-block' : 'none';
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        executeSearch(q);
      }, 220);
    });

    els.clearSearchBtn.addEventListener('click', () => {
      els.searchInput.value = '';
      els.clearSearchBtn.style.display = 'none';
      executeSearch('');
      els.searchInput.focus();
    });

    els.exactCheckbox.addEventListener('change', () => {
      executeSearch(els.searchInput.value.trim());
    });

    els.teacherFilter.addEventListener('change', () => {
      executeSearch(els.searchInput.value.trim());
    });

    els.yearFilter.addEventListener('change', () => {
      executeSearch(els.searchInput.value.trim());
    });

    if (els.btnModeYear && els.btnModeRange) {
      els.btnModeYear.addEventListener('click', () => {
        state.dateFilterMode = 'year';
        els.btnModeYear.classList.add('active');
        els.btnModeRange.classList.remove('active');
        els.yearFilter.style.display = 'inline-block';
        els.dateRangeInputs.style.display = 'none';
        executeSearch(els.searchInput.value.trim());
      });

      els.btnModeRange.addEventListener('click', () => {
        state.dateFilterMode = 'range';
        els.btnModeRange.classList.add('active');
        els.btnModeYear.classList.remove('active');
        els.yearFilter.style.display = 'none';
        els.dateRangeInputs.style.display = 'inline-flex';
        executeSearch(els.searchInput.value.trim());
      });
    }

    if (els.startDateInput) {
      els.startDateInput.addEventListener('change', () => {
        executeSearch(els.searchInput.value.trim());
      });
    }

    if (els.endDateInput) {
      els.endDateInput.addEventListener('change', () => {
        executeSearch(els.searchInput.value.trim());
      });
    }

    if (els.sortOrderSelect) {
      els.sortOrderSelect.addEventListener('change', () => {
        executeSearch(els.searchInput.value.trim());
      });
    }

    if (els.resetFiltersBtn) {
      els.resetFiltersBtn.addEventListener('click', () => {
        els.searchInput.value = '';
        els.clearSearchBtn.style.display = 'none';
        els.exactCheckbox.checked = false;
        els.teacherFilter.value = '';
        els.yearFilter.value = '';
        if (els.startDateInput) els.startDateInput.value = '';
        if (els.endDateInput) els.endDateInput.value = '';
        if (els.sortOrderSelect) els.sortOrderSelect.value = 'rank';
        state.dateFilterMode = 'year';
        if (els.btnModeYear) els.btnModeYear.classList.add('active');
        if (els.btnModeRange) els.btnModeRange.classList.remove('active');
        if (els.yearFilter) els.yearFilter.style.display = 'inline-block';
        if (els.dateRangeInputs) els.dateRangeInputs.style.display = 'none';
        executeSearch('');
      });
    }

    const goToSearchPage = (nextOffset) => {
      const limit = state.search.limit || 50;
      const total = state.search.totalEpisodes || 0;
      const lastOffset = Math.max(0, Math.floor(Math.max(0, total - 1) / limit) * limit);
      const clamped = Math.max(0, Math.min(nextOffset, lastOffset));
      if (clamped === state.search.offset) return;
      state.search.offset = clamped;
      executeSearch(state.currentQuery, { keepPage: true, skipHistory: true });
      if (els.searchResultsHeader) {
        els.searchResultsHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    if (els.btnSearchFirst) {
      els.btnSearchFirst.addEventListener('click', () => goToSearchPage(0));
    }
    if (els.btnSearchPrev) {
      els.btnSearchPrev.addEventListener('click', () => {
        goToSearchPage(state.search.offset - (state.search.limit || 50));
      });
    }
    if (els.btnSearchNext) {
      els.btnSearchNext.addEventListener('click', () => {
        goToSearchPage(state.search.offset + (state.search.limit || 50));
      });
    }
    if (els.btnSearchLast) {
      els.btnSearchLast.addEventListener('click', () => {
        const limit = state.search.limit || 50;
        const total = state.search.totalEpisodes || 0;
        const lastOffset = Math.max(0, Math.floor(Math.max(0, total - 1) / limit) * limit);
        goToSearchPage(lastOffset);
      });
    }

    if (els.archiveCancelBtn) {
      els.archiveCancelBtn.addEventListener('click', () => {
        state.archiveCancelRequested = true;
        if (els.archiveModalCurrentItem) {
          els.archiveModalCurrentItem.textContent = 'Cancelling download...';
        }
      });
    }

    setupDownloadDropdowns();
    setupBrowseFilterListeners();

    if (els.btnBrowseLoadMore) {
      els.btnBrowseLoadMore.addEventListener('click', () => {
        state.browse.offset += state.browse.limit;
        loadBrowseCatalog({ append: true });
      });
    }

    if (els.btnBrowseShowAll) {
      els.btnBrowseShowAll.addEventListener('click', () => {
        const remaining = Math.max(0, state.browse.total - state.catalog.length);
        if (remaining <= 0) return;
        state.browse.offset = state.catalog.length;
        loadBrowseCatalog({ append: true, overrideLimit: remaining });
      });
    }

    // Example query chips
    if (els.exampleChips) {
      els.exampleChips.addEventListener('click', (e) => {
        const btn = e.target.closest('.chip-btn');
        if (btn) {
          const query = btn.dataset.query;
          els.searchInput.value = query;
          els.clearSearchBtn.style.display = 'inline-block';
          executeSearch(query, { pushHistory: true });
        }
      });
    }

    // Tabs
    els.tabSearchBtn.addEventListener('click', () => switchTab('search-view'));
    els.tabBrowseBtn.addEventListener('click', () => switchTab('browse-view'));
    if (els.tabBookmarksBtn) {
      els.tabBookmarksBtn.addEventListener('click', () => switchTab('bookmarks-view'));
    }
    els.tabLexiconBtn.addEventListener('click', () => switchTab('lexicon-view'));
    if (els.tabDocsBtn) {
      els.tabDocsBtn.addEventListener('click', () => switchTab('documents-view'));
    }
    if (els.tabAboutBtn) {
      els.tabAboutBtn.addEventListener('click', () => switchTab('about-view'));
    }
    if (els.tabNotesBtn) {
      els.tabNotesBtn.addEventListener('click', () => switchTab('notes-view'));
    }
    if (els.btnAboutArchiveNotes) {
      els.btnAboutArchiveNotes.addEventListener('click', () => switchTab('notes-view'));
    }
    if (els.tabTranscriptBtn) {
      els.tabTranscriptBtn.addEventListener('click', () => switchTab('transcript-view'));
    }

    // Bookmarks Controls & Event Listeners
    if (els.btnClearBookmarks) {
      els.btnClearBookmarks.addEventListener('click', () => {
        const count = BookmarkStore.count();
        if (count === 0) return;
        if (window.confirm(`Are you sure you want to remove all ${count} saved bookmark${count === 1 ? '' : 's'}?`)) {
          BookmarkStore.clear();
          loadBookmarksView();
        }
      });
    }

    if (els.transcriptBookmarkBtn) {
      els.transcriptBookmarkBtn.addEventListener('click', () => {
        if (state.currentEpisode && state.currentEpisode.id) {
          BookmarkStore.toggle(state.currentEpisode.id);
          if (state.activeTab === 'bookmarks-view') {
            loadBookmarksView();
          }
        }
      });
    }

    if (els.btnPlayerBookmark) {
      els.btnPlayerBookmark.addEventListener('click', () => {
        if (state.playingEpisode && state.playingEpisode.id) {
          BookmarkStore.toggle(state.playingEpisode.id);
          if (state.activeTab === 'bookmarks-view') {
            loadBookmarksView();
          }
        }
      });
    }

    // Delegated click handler for bookmark buttons across all views
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="toggle-bookmark"]');
      if (btn) {
        e.stopPropagation();
        e.preventDefault();
        const epId = btn.dataset.epId;
        if (epId) {
          BookmarkStore.toggle(epId);
          if (state.activeTab === 'bookmarks-view') {
            loadBookmarksView();
          }
        }
      }
    });

    // Cross-tab synchronization via localStorage events
    window.addEventListener('storage', (e) => {
      if (e.key === BOOKMARKS_STORAGE_KEY) {
        BookmarkStore.init();
        BookmarkStore.syncUiButtons();
        if (state.activeTab === 'bookmarks-view') {
          loadBookmarksView();
        }
      }
    });

    if (els.transcriptBackBtn) {
      els.transcriptBackBtn.addEventListener('click', () => {
        if (state.historyDepth > 0 && window.location.hash.startsWith('#talk/')) {
          window.history.back();
        } else {
          switchTab(state.previousTab || 'search-view');
        }
      });
    }

    if (els.transcriptPlayBtn) {
      els.transcriptPlayBtn.addEventListener('click', () => {
        const viewedEp = state.currentEpisode;
        if (!viewedEp) return;
        const isThisEpisode = state.playingEpisode && (state.playingEpisode.id === viewedEp.id);
        if (isThisEpisode && els.nativeAudio && els.nativeAudio.src) {
          if (els.nativeAudio.paused) {
            els.nativeAudio.play().catch(e => console.warn('Play gesture error:', e));
          } else {
            els.nativeAudio.pause();
          }
        } else {
          playAudioSegment({
            episode_id: viewedEp.id,
            media_url: viewedEp.media_url,
            title: viewedEp.title,
            teacher: viewedEp.primary_display || viewedEp.teacher,
            start_sec: 0,
          });
        }
        updateHeaderPlayButton();
      });
    }

    if (els.btnPlayerTranscript) {
      els.btnPlayerTranscript.addEventListener('click', () => {
        if (state.playingEpisode && state.playingEpisode.id) {
          openTranscriptDrawer(state.playingEpisode.id);
        }
      });
    }

    // Browser Back / Forward History Navigation
    window.addEventListener('popstate', () => {
      state.historyDepth = Math.max(0, state.historyDepth - 1);
      router.handleRoute();
    });

    // Word Synchronization Mode Controls (Segmented: Off | On | Track)
    const segmentedWordSyncControl = document.getElementById('segmented-word-sync-control');
    if (segmentedWordSyncControl) {
      segmentedWordSyncControl.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn || !btn.dataset.mode) return;
        const targetMode = btn.dataset.mode;
        if (window.WordSync) {
          window.WordSync.setMode(targetMode);
          if (targetMode !== 'off' && els.nativeAudio && !els.nativeAudio.paused) {
            window.WordSync.update(els.nativeAudio.currentTime);
          }
        }
      });
    }

    if (els.btnToggleToolbarActions) {
      els.btnToggleToolbarActions.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolbarActions();
      });
    }

    // Lexicon Live Companion Controls
    if (els.btnToggleLexSheet) {
      els.btnToggleLexSheet.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMobileLexSheet();
      });
    }
    if (els.lexTickerTrigger) {
      els.lexTickerTrigger.addEventListener('click', () => {
        toggleMobileLexSheet();
      });
    }
    if (els.btnCloseLexSheet) {
      els.btnCloseLexSheet.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMobileLexSheet(false);
      });
    }
    if (els.btnClearLexStack) {
      els.btnClearLexStack.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.lexCompanion.currentActiveIdx >= 0 && els.lexiconStack) {
          const activeCard = els.lexiconStack.querySelector('.lex-stack-card.current-companion-term');
          if (activeCard) {
            scrollCardIntoCompanionStack(activeCard, 'smooth', 'center');
          }
        }
      });
    }

    if (window.WordSync) {
      window.WordSync.onPaliTermSpoken = (key, termObj, options) => {
        handleSpokenPaliTerm(key, termObj, options);
      };
    }

    // Delegated click listener for transcript turns drawer:
    // Handles timestamp seek buttons, quote share buttons, word-level seek & Pali terms, and un-timed Pali terms
    if (els.drawerTurns) {
      els.drawerTurns.addEventListener('click', (e) => {
        const ep = state.currentEpisode;
        if (!ep) return;

        // 1. Click on word in drawer seeks audio to that exact second!
        const wSpan = e.target.closest('.transcript-word');
        if (wSpan) {
          e.stopPropagation();
          if (window.WordSync) {
            window.WordSync._userInteractedAt = 0;
          }
          const start = parseFloat(wSpan.dataset.start);
          playAudioSegment({
            episode_id: ep.id,
            media_url: ep.media_url,
            title: ep.title,
            teacher: ep.primary_display,
            start_sec: start,
            word_id: wSpan.id,
          });
          if (wSpan.classList.contains('pali-term') && wSpan.dataset.pali) {
            handleSpokenPaliTerm(wSpan.dataset.pali, null, { userClicked: true, startSec: start, wordId: wSpan.id });
          }
          return;
        }

        // 2. Click on un-timed Pali term in sentence fallback mode
        const pSpan = e.target.closest('.pali-term');
        if (pSpan) {
          e.stopPropagation();
          if (pSpan.dataset.pali) {
            handleSpokenPaliTerm(pSpan.dataset.pali, null, { userClicked: true });
          }
          return;
        }

        // 3. Click on timestamp button seeks audio to turn start
        const timeBtn = e.target.closest('.turn-time-btn');
        if (timeBtn) {
          e.stopPropagation();
          const start = parseFloat(timeBtn.dataset.start);
          playAudioSegment({
            episode_id: ep.id,
            media_url: ep.media_url,
            title: ep.title,
            teacher: ep.primary_display,
            start_sec: start,
          });
          return;
        }

        // 4. Click on share moment icon copies link to this moment
        const shareBtn = e.target.closest('.turn-share-btn');
        if (shareBtn) {
          e.stopPropagation();
          const startSec = Math.floor(parseFloat(shareBtn.dataset.start) || 0);
          const shareUrl = `${getShareBaseUrl()}/#talk/${ep.id}?t=${startSec}`;
          copyTextToClipboard(shareUrl, `Moment link at ${formatSeconds(startSec)} copied to clipboard!`);
          return;
        }
      });
    }

    // Delegated click listener for live companion lexicon cards
    if (els.lexiconStack) {
      els.lexiconStack.addEventListener('click', (e) => {
        const lBtn = e.target.closest('.lex-card-link-btn');
        if (lBtn) {
          e.stopPropagation();
          const term = lBtn.dataset.term;
          if (term) {
            openFullLexiconEntry(term);
          }
          return;
        }

        const card = e.target.closest('.lex-stack-card');
        if (card && card.dataset.idx !== undefined) {
          const idx = parseInt(card.dataset.idx, 10);
          if (!isNaN(idx)) {
            jumpToCompanionTerm(idx);
          }
        }
      });
    }



    // Lexicon Search & Controls
    if (els.lexiconInput) {
      els.lexiconInput.addEventListener('input', () => {
        const term = els.lexiconInput.value.trim();
        state.lexicon.term = term;
        clearTimeout(state.lexiconDebounceTimer);
        state.lexiconDebounceTimer = setTimeout(() => {
          if (!term) {
            if (state.activeTab === 'lexicon-view' && window.location.hash !== '#lexicon') {
              window.history.replaceState({ route: '#lexicon' }, '', '#lexicon');
            }
            if (els.lexCategoryBar) els.lexCategoryBar.style.display = 'flex';
            if (els.lexAlphabetBar && state.lexicon.mode === 'all') els.lexAlphabetBar.style.display = 'flex';
            loadLexiconView();
          } else {
            const lexHash = `#lexicon?term=${encodeURIComponent(term)}`;
            if (state.activeTab === 'lexicon-view' && window.location.hash !== lexHash) {
              window.history.replaceState({ route: lexHash }, '', lexHash);
            }
            if (els.lexAlphabetBar) els.lexAlphabetBar.style.display = 'none';
            if (els.lexPagination) els.lexPagination.style.display = 'none';
            if (els.lexCountText) els.lexCountText.textContent = `Search results for "${term}"`;
            executeLexiconSearch(term);
          }
        }, 250);
      });
    }

    // Lexicon Mode Toggling
    if (els.btnLexCore) {
      els.btnLexCore.addEventListener('click', () => {
        if (state.lexicon.mode === 'core') return;
        state.lexicon.mode = 'core';
        state.lexicon.page = 1;
        els.btnLexCore.classList.add('active');
        if (els.btnLexAll) els.btnLexAll.classList.remove('active');
        if (els.lexAlphabetBar) els.lexAlphabetBar.style.display = 'none';
        loadLexiconView();
      });
    }

    if (els.btnLexAll) {
      els.btnLexAll.addEventListener('click', () => {
        if (state.lexicon.mode === 'all') return;
        state.lexicon.mode = 'all';
        state.lexicon.page = 1;
        els.btnLexAll.classList.add('active');
        if (els.btnLexCore) els.btnLexCore.classList.remove('active');
        if (els.lexAlphabetBar) els.lexAlphabetBar.style.display = 'flex';
        loadLexiconView();
      });
    }

    // Lexicon Sort Select
    if (els.lexSortSelect) {
      els.lexSortSelect.addEventListener('change', () => {
        state.lexicon.sort = els.lexSortSelect.value;
        state.lexicon.page = 1;
        loadLexiconView();
      });
    }

    // Lexicon Category Bar
    if (els.lexCategoryBar) {
      els.lexCategoryBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.cat-pill');
        if (!btn) return;
        els.lexCategoryBar.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        state.lexicon.category = btn.dataset.cat || 'all';
        state.lexicon.page = 1;
        loadLexiconView();
      });
    }

    // Lexicon Alphabet Bar
    if (els.lexAlphabetBar) {
      els.lexAlphabetBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.alpha-btn');
        if (!btn) return;
        els.lexAlphabetBar.querySelectorAll('.alpha-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.lexicon.letter = btn.dataset.letter || 'all';
        state.lexicon.page = 1;
        loadLexiconView();
      });
    }

    // Lexicon Pagination Controls
    if (els.btnLexFirst) {
      els.btnLexFirst.addEventListener('click', () => {
        if (state.lexicon.page > 1) {
          state.lexicon.page = 1;
          loadLexiconView();
          scrollContentTo(0, 'smooth');
        }
      });
    }
    if (els.btnLexPrev) {
      els.btnLexPrev.addEventListener('click', () => {
        if (state.lexicon.page > 1) {
          state.lexicon.page--;
          loadLexiconView();
          scrollContentTo(0, 'smooth');
        }
      });
    }
    if (els.btnLexNext) {
      els.btnLexNext.addEventListener('click', () => {
        if (state.lexicon.page < state.lexicon.totalPages) {
          state.lexicon.page++;
          loadLexiconView();
          scrollContentTo(0, 'smooth');
        }
      });
    }
    if (els.btnLexLast) {
      els.btnLexLast.addEventListener('click', () => {
        if (state.lexicon.page < state.lexicon.totalPages) {
          state.lexicon.page = state.lexicon.totalPages;
          loadLexiconView();
          scrollContentTo(0, 'smooth');
        }
      });
    }
    if (els.lexLimitSelect) {
      els.lexLimitSelect.addEventListener('change', () => {
        state.lexicon.limit = parseInt(els.lexLimitSelect.value, 10) || 25;
        state.lexicon.page = 1;
        loadLexiconView();
      });
    }

    // Delegated clicks on lexicon cards (Find Talks, View Offline Document, Share Term Link, Click Term Title)
    if (els.lexiconResults) {
      els.lexiconResults.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-lexicon-talks');
        if (btn) {
          const term = btn.dataset.term;
          if (term) {
            if (els.searchInput) {
              els.searchInput.value = term;
              els.clearSearchBtn.style.display = 'inline-block';
            }
            executeSearch(term, { pushHistory: true });
          }
          return;
        }

        const shareBtn = e.target.closest('.btn-lexicon-share');
        if (shareBtn) {
          const term = shareBtn.dataset.term || '';
          const cleanHash = `#lexicon?term=${encodeURIComponent(term)}`;
          state.lexicon.term = term;
          if (window.location.hash !== cleanHash) {
            state.historyDepth++;
            window.history.pushState({ route: cleanHash }, '', cleanHash);
          }
          const shareUrl = `${getShareBaseUrl()}/${cleanHash}`;
          copyTextToClipboard(shareUrl, `Lexicon link for "${term}" copied to clipboard!`);
          return;
        }

        const termTitle = e.target.closest('.lexicon-term-title .pali-term');
        if (termTitle) {
          const term = termTitle.textContent.trim();
          if (term) {
            openFullLexiconEntry(term);
          }
          return;
        }

        const docBtn = e.target.closest('.btn-lexicon-view-doc');
        if (docBtn) {
          const docId = docBtn.dataset.docId || 1;
          const term = docBtn.dataset.term || docBtn.closest('.lexicon-card')?.querySelector('.pali-term')?.textContent || '';
          state.documents.activeDocId = parseInt(docId, 10) || 1;
          state.documents.filterQuery = term;
          switchTab('documents-view', { skipHistory: true });
          loadDocumentInView(docId, term);
          return;
        }
      });
    }

    // Lexicon Canonical Authority Sources Navigation
    if (els.btnLexSources) {
      els.btnLexSources.addEventListener('click', () => {
        switchTab('documents-view');
      });
    }

    // Authority Documents View Navigation & In-Document Filtering
    if (els.docTabsBar) {
      els.docTabsBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.doc-tab-btn');
        if (!btn) return;
        const docId = btn.dataset.docId;
        if (docId) {
          loadDocumentInView(docId);
        }
      });
    }

    if (els.docFilterInput) {
      els.docFilterInput.addEventListener('input', (e) => {
        filterActiveDocument(e.target.value);
      });
    }

    if (els.clearDocFilterBtn) {
      els.clearDocFilterBtn.addEventListener('click', () => {
        if (els.docFilterInput) {
          els.docFilterInput.value = '';
          filterActiveDocument('');
          els.docFilterInput.focus();
        }
      });
    }

    // Global Keyboard Shortcuts (designed to avoid browser navigation & text-selection conflicts)
    window.addEventListener('keydown', (e) => {
      // 'Escape' closes player settings, open browse popovers, clears doc filter, or returns to previous view
      if (e.key === 'Escape') {
        if (closePlayerSettings()) {
          return;
        }
        if (closeAllBrowsePopovers()) {
          return;
        }
        if (state.activeTab === 'documents-view' && els.docFilterInput && els.docFilterInput.value) {
          els.docFilterInput.value = '';
          filterActiveDocument('');
          return;
        }
        if (state.activeTab === 'transcript-view') {
          if (state.historyDepth > 0 && window.location.hash.startsWith('#talk/')) {
            window.history.back();
          } else {
            switchTab(state.previousTab || 'search-view');
          }
          return;
        }
      }

      // Check whether user is currently typing in an input, textarea, select, or contenteditable element
      const activeEl = document.activeElement;
      const isInputFocused = activeEl && (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName) ||
        activeEl.isContentEditable
      );

      // 'Ctrl+K' or 'Cmd+K' to focus search from anywhere
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (els.searchInput) {
          els.searchInput.focus();
          els.searchInput.select();
        }
        return;
      }

      // '/' to focus active view search/filter input when not typing in an input
      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        if (state.activeTab === 'browse-view' && els.browseTitleInput) {
          els.browseTitleInput.focus();
          els.browseTitleInput.select();
        } else if (els.searchInput) {
          els.searchInput.focus();
          els.searchInput.select();
        }
        return;
      }

      // Space toggles audio (when not typing in an input)
      if (e.code === 'Space' && !isInputFocused) {
        e.preventDefault();
        togglePlayPause();
        return;
      }

      // 'J' (rewind 15s) and 'L' (skip forward 15s)
      // Standard media controls; avoids browser navigation (Alt+Arrows) and text selection (Shift+Arrows)
      if (!isInputFocused && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key.toLowerCase() === 'j') {
          e.preventDefault();
          if (els.nativeAudio && els.nativeAudio.src) {
            const curPhys = window.WordSync ? window.WordSync.getPhysicalTime(els.nativeAudio.currentTime) : els.nativeAudio.currentTime;
            safeSeek(curPhys - 15);
          }
          return;
        }
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          if (els.nativeAudio && els.nativeAudio.src) {
            const curPhys = window.WordSync ? window.WordSync.getPhysicalTime(els.nativeAudio.currentTime) : els.nativeAudio.currentTime;
            safeSeek(curPhys + 15);
          }
          return;
        }
      }
    });
  }

  function switchTab(viewId, options = {}) {
    state.activeTab = viewId;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === viewId);
    });
    document.querySelectorAll('.view-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === viewId);
    });
    if (viewId === 'browse-view' && !state.browse.loadedOnce) {
      loadBrowseCatalog({ skipHistory: true });
    }
    if (viewId === 'bookmarks-view') {
      loadBookmarksView();
    }
    if (viewId === 'lexicon-view' && (!state.lexicon || !state.lexicon.loadedOnce)) {
      loadLexiconView();
    }
    if (viewId === 'documents-view') {
      loadDocumentInView(state.documents.activeDocId, state.documents.filterQuery, { skipHistory: options.skipHistory });
    }
    if (viewId === 'about-view') {
      if (els.aboutAppVersion && window.__DEEPER_DHAMMA_VERSION__) {
        els.aboutAppVersion.textContent = `v${window.__DEEPER_DHAMMA_VERSION__}`;
      }
    }
    if (viewId === 'transcript-view') {
      updateHeaderPlayButton();
      const isViewingPlaying = state.playingEpisode && state.currentEpisode && (state.playingEpisode.id === state.currentEpisode.id);
      if (isViewingPlaying && els.nativeAudio && !els.nativeAudio.paused) {
        if (window.WordSync) {
          window.WordSync.update(els.nativeAudio.currentTime);
        }
      }
    }

    if (!options.skipHistory) {
      const activeDocId = state.documents.activeDocId || 1;
      const docFilter = (state.documents.filterQuery || '').trim();
      const docRoute = docFilter
        ? `documents?id=${activeDocId}&q=${encodeURIComponent(docFilter)}`
        : `documents?id=${activeDocId}`;
      const tabToRouteMap = {
        'search-view': state.currentQuery ? `search?q=${encodeURIComponent(state.currentQuery)}` : 'search',
        'browse-view': buildBrowseRouteHash().replace(/^#/, ''),
        'bookmarks-view': 'bookmarks',
        'lexicon-view': state.lexicon.term ? `lexicon?term=${encodeURIComponent(state.lexicon.term)}` : 'lexicon',
        'documents-view': docRoute,
        'about-view': 'about',
        'notes-view': 'notes',
        'transcript-view': state.currentEpisode ? `talk/${state.currentEpisode.id}` : 'search',
      };
      const targetRoute = tabToRouteMap[viewId];
      if (targetRoute) {
        const cleanHash = '#' + targetRoute.replace(/^#/, '');
        if (window.location.hash !== cleanHash) {
          state.historyDepth++;
          window.history.pushState({ route: cleanHash }, '', cleanHash);
        }
      }
    }
  }

  // ==========================================================================
  // Transcript Drawer / Modal
  // ==========================================================================

  function updateHeaderPlayButton() {
    if (!els.transcriptPlayBtn) return;
    const viewedEp = state.currentEpisode;
    if (!viewedEp) {
      els.transcriptPlayBtn.style.display = 'none';
      return;
    }
    els.transcriptPlayBtn.style.display = 'inline-flex';
    const isPlayingThis = state.playingEpisode &&
      (state.playingEpisode.id === viewedEp.id) &&
      els.nativeAudio &&
      !els.nativeAudio.paused;

    if (isPlayingThis) {
      els.transcriptPlayBtn.innerHTML = '⏸ Pause Talk';
      els.transcriptPlayBtn.title = 'Pause playback';
    } else {
      els.transcriptPlayBtn.innerHTML = '▶ Play Talk';
      els.transcriptPlayBtn.title = 'Play talk from beginning';
    }
  }

  async function openTranscriptDrawer(episodeId, targetOpts = null, options = {}) {
    const loadSeq = ++state._transcriptLoadSeq;
    resetLexCompanion();
    toggleToolbarActions(false);
    if (state.activeTab !== 'transcript-view') {
      state.previousTab = state.activeTab;
    }
    if (els.tabTranscriptBtn) {
      els.tabTranscriptBtn.style.display = 'inline-flex';
    }
    switchTab('transcript-view', { skipHistory: true });

    if (!options.skipHistory) {
      const cleanHash = `#talk/${episodeId}`;
      if (window.location.hash !== cleanHash) {
        state.historyDepth++;
        window.history.pushState({ route: cleanHash }, '', cleanHash);
      }
    }

    if (!targetOpts) {
      scrollContentTo(0, 'smooth');
    }

    if (els.drawerTurns) {
      els.drawerTurns.innerHTML = '<div class="loading-spinner">Loading transcript turns...</div>';
    }

    try {
      const ep = await dbService.getEpisode(episodeId);
      if (loadSeq !== state._transcriptLoadSeq) return;
      if (!ep) {
        if (els.drawerTurns) {
          els.drawerTurns.innerHTML = '<div class="empty-state"><p>Episode details could not be loaded.</p></div>';
        }
        return;
      }
      state.currentEpisode = ep;
      updateHeaderPlayButton();
      BookmarkStore.syncUiButtons();

      if (els.drawerTitle) els.drawerTitle.textContent = ep.title;
      if (els.drawerDateTag) els.drawerDateTag.textContent = ep.date || `Year ${ep.year}`;
      const durMin = Math.round((ep.duration_sec || 0) / 60);
      if (els.drawerMetaInfo) {
        els.drawerMetaInfo.innerHTML = `
          ${renderTeacherBadgesHtml(ep)}
          <span class="bullet-sep">•</span>
          <span>${durMin} mins</span>
          <span class="bullet-sep">•</span>
          <span>${ep.segments ? ep.segments.length : 0} speech turns</span>
        `;
      }

      if (els.drawerPodbeanLink) {
        if (ep.permalink) {
          els.drawerPodbeanLink.href = getPodbeanUrl(ep.permalink);
          els.drawerPodbeanLink.style.display = 'inline-flex';
        } else {
          els.drawerPodbeanLink.style.display = 'none';
        }
      }

      if (els.drawerShareBtn) {
        els.drawerShareBtn.onclick = () => {
          let shareUrl = `${getShareBaseUrl()}/#talk/${ep.id}`;
          if (els.nativeAudio && !els.nativeAudio.paused && state.currentEpisode && state.currentEpisode.id === ep.id && els.nativeAudio.currentTime > 5) {
            shareUrl += `?t=${Math.floor(els.nativeAudio.currentTime)}`;
          }
          copyTextToClipboard(shareUrl, 'Talk link copied to clipboard!');
        };
      }

      if (!ep.segments || ep.segments.length === 0) {
        els.drawerTurns.innerHTML = `
          <div class="empty-state">
            <p>This talk is currently in the catalog and scheduled for GPU transcription.</p>
          </div>
        `;
        return;
      }

      function renderDrawerTurns() {
        let html = '';
        ep.segments.forEach((seg, idx) => {
          const tIdx = seg.turn_index !== undefined ? Number(seg.turn_index) : idx;
          const startStr = formatSeconds(seg.start_sec);
          const formattedText = window.WordSync
            ? window.WordSync.formatTurnParagraphs(seg.text, tIdx)
            : formatTranscriptParagraphs(seg.text);
          const spkColor = getSpeakerColor(seg.speaker_slug, seg.speaker_display);
          const initials = getSpeakerInitials(seg.speaker_display || 'Speaker');
          html += `
            <div class="transcript-turn" id="turn-${tIdx}" data-turn-idx="${tIdx}" data-start="${seg.start_sec}" style="--spk-color: ${spkColor};">
              <div class="turn-header">
                <span class="turn-speaker">
                  <span class="turn-speaker-badge" title="${escapeHtml(seg.speaker_display || 'Speaker')}">${escapeHtml(initials)}</span>
                  ${escapeHtml(seg.speaker_display || 'Speaker')}
                </span>
                <div class="turn-actions">
                  <button type="button" class="turn-time-btn" data-start="${seg.start_sec}" title="Seek audio to this turn">
                    ▶ ${startStr}
                  </button>
                  <button type="button" class="turn-share-btn" data-turn-idx="${tIdx}" data-start="${seg.start_sec}" title="Copy shareable link to this moment">
                    🔗
                  </button>
                </div>
              </div>
              <div class="turn-text">${formattedText}</div>
            </div>
          `;
        });

        els.drawerTurns.innerHTML = html;
      }

      window.renderActiveTranscript = renderDrawerTurns;

      let initialStartedSec = null;

      function applyTargetOpts(opts, isEnriched = false) {
        if (!opts || (typeof opts.turnIndex !== 'number' && typeof opts.fallbackSec !== 'number')) {
          return;
        }
        let tIdx = typeof opts.turnIndex === 'number' ? opts.turnIndex : 0;
        const sIdx = typeof opts.sentIdxInTurn === 'number' ? opts.sentIdxInTurn : 0;
        const wOffset = typeof opts.wordOffsetInTurn === 'number' ? opts.wordOffsetInTurn : 0;
        let exactWordSec = typeof opts.fallbackSec === 'number' ? opts.fallbackSec : 0;

        // If turnIndex was not explicitly given, find the turn matching fallbackSec
        if (typeof opts.turnIndex !== 'number' && typeof opts.fallbackSec === 'number' && ep.segments && ep.segments.length > 0) {
          const sec = opts.fallbackSec;
          for (let i = 0; i < ep.segments.length; i++) {
            const s = ep.segments[i];
            const nextStart = ep.segments[i + 1] ? ep.segments[i + 1].start_sec : Infinity;
            if (sec >= s.start_sec && sec < nextStart) {
              tIdx = s.turn_index !== undefined ? Number(s.turn_index) : i;
              break;
            }
          }
        }
        let targetWordEl = null;

        // 1. Resolve exact word timestamp and DOM element from WordSync turnWordMap if available
        const sentEl = document.getElementById(`turn-${tIdx}-sent-${sIdx}`);
        const turnEl = document.getElementById(`turn-${tIdx}`);

        if (window.WordSync && window.WordSync.turnWordMap && window.WordSync.turnWordMap[tIdx]) {
          const turnWords = window.WordSync.turnWordMap[tIdx];
          if (turnWords.length > 0) {
            const clampedIdx = Math.max(0, Math.min(turnWords.length - 1, wOffset));
            const matchedW = turnWords[clampedIdx];
            if (matchedW && typeof matchedW.s === 'number') {
              exactWordSec = matchedW.s;
              targetWordEl = document.getElementById(matchedW.domId || matchedW.id);
            }
          }
        }

        // Guard against any minor token alignment drift: keep targetWordEl anchored inside sentEl
        if (sentEl && (!targetWordEl || !sentEl.contains(targetWordEl))) {
          const sentWords = sentEl.querySelectorAll('.transcript-word');
          if (sentWords.length > 0) {
            targetWordEl = sentWords[0];
            const parsedStart = parseFloat(targetWordEl.dataset.start);
            if (!isNaN(parsedStart)) {
              exactWordSec = parsedStart;
            }
          }
        }

        // 2. Scroll target cleanly into the unobstructed reading area between sticky toolbar and player bar
        const scrollTarget = targetWordEl || sentEl || turnEl;
        if (scrollTarget) {
          scrollElementIntoReadingZone(scrollTarget, 'auto');
          requestAnimationFrame(() => {
            if (state.currentEpisode && state.currentEpisode.id === ep.id) {
              scrollElementIntoReadingZone(scrollTarget, 'auto');
            }
          });
        }

        if (sentEl) {
          sentEl.classList.add('target-sentence-flash');
          setTimeout(() => sentEl.classList.remove('target-sentence-flash'), 4000);
        } else if (turnEl) {
          turnEl.classList.add('target-turn-flash');
          setTimeout(() => turnEl.classList.remove('target-turn-flash'), 4000);
        }

        if (targetWordEl) {
          if (window.WordSync) {
            window.WordSync.setActiveWordElement(targetWordEl);
          } else {
            targetWordEl.classList.add('active-word');
          }
        }

        if (opts.autoPlay !== false && ep.media_url) {
          const shouldSeekOrPlay = !isEnriched || initialStartedSec === null || Math.abs(exactWordSec - initialStartedSec) > 0.15;
          if (shouldSeekOrPlay) {
            initialStartedSec = exactWordSec;
            playAudioSegment({
              episode_id: ep.id,
              media_url: ep.media_url,
              title: ep.title,
              teacher: ep.primary_display,
              start_sec: exactWordSec,
            });
          }
        }
      }

      // 1. Prepare word timings synchronously if words_blob is already attached (prevents stale turnWordMap!)
      const wordsReadySync = window.WordSync ? window.WordSync.prepareEpisodeSync(ep) : false;
      const paliReadySync = Boolean(state.lexCompanion.loadedOnce && window.WordSync && window.WordSync.paliTermsMap.size > 0);
      renderDrawerTurns();
      if (targetOpts) {
        applyTargetOpts(targetOpts, false);
      }

      // 2. Concurrently load Pali lexicon terms, binary word sidecar (if not sync-ready), and companion cards
      const epLoadToken = ep.id;
      const enrichmentTasks = [ensurePaliTermsLoaded()];
      if (window.WordSync && !wordsReadySync) {
        enrichmentTasks.push(window.WordSync.prepareEpisode(ep));
      }

      Promise.all(enrichmentTasks).then(() => {
        if (loadSeq !== state._transcriptLoadSeq) return;
        if (!state.currentEpisode || state.currentEpisode.id !== epLoadToken) return;
        if (
          window.WordSync &&
          window.WordSync.wordsEpisodeId === ep.id &&
          window.WordSync.turnWordMapEpisodeId !== ep.id &&
          ep.segments &&
          window.WordSync.words.length > 0
        ) {
          window.WordSync.indexWordsByTurn(ep.segments, ep.id);
        }
        const hasRenderedWords = Boolean(els.drawerTurns && els.drawerTurns.querySelector('.transcript-word'));
        const needsReRender = !(wordsReadySync && paliReadySync) || !hasRenderedWords;
        if (needsReRender) {
          renderDrawerTurns();
          if (window.WordSync) {
            window.WordSync._teleprompterLine = null;
            window.WordSync.activeWordEl = null;
            window.WordSync.activeWordIdx = -1;
            if (
              window.WordSync.isPlayingCurrentTranscript() &&
              window.WordSync.isSeekLocked() &&
              window.WordSync._lockedWordIdx >= 0 &&
              window.WordSync.words[window.WordSync._lockedWordIdx]
            ) {
              const lockedW = window.WordSync.words[window.WordSync._lockedWordIdx];
              const lockedEl = document.getElementById(lockedW.domId || lockedW.id);
              if (lockedEl) {
                window.WordSync.setActiveWordElement(lockedEl, window.WordSync._lockedWordIdx);
              }
            }
          }
        }
        buildCompanionTermsList();
        if (targetOpts && needsReRender) {
          applyTargetOpts(targetOpts, true);
        }
        if (state.playingEpisode && state.currentEpisode && state.playingEpisode.id === state.currentEpisode.id && els.nativeAudio && els.nativeAudio.currentTime > 0) {
          const rawCur = els.nativeAudio.currentTime;
          const physCur = window.WordSync ? window.WordSync.getPhysicalTime(rawCur) : rawCur;
          if (window.WordSync && (needsReRender || !window.WordSync.activeWordEl)) {
            window.WordSync.update(rawCur);
          }
          updateActiveCompanionTerm(physCur);
        }
        updateHeaderPlayButton();
      }).catch(enrichErr => {
        console.warn('[Transcript] Progressive enrichment notice:', enrichErr);
      });
    } catch (err) {
      console.error('[Transcript] Failed to load transcript:', err);
      if (els.drawerTurns) {
        els.drawerTurns.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">⚠️</div>
            <p>Failed to load transcript.</p>
            <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem;">${escapeHtml(err.message || String(err))}</p>
            <button type="button" class="btn-primary" style="margin-top: 1rem;" onclick="window.resetDeeperDhammaCache()">
              🔄 Reset Cache & Reload
            </button>
          </div>
        `;
      }
    }
  }

  window.resetDeeperDhammaCache = async function () {
    try {
      if (dbService && dbService.worker && typeof dbService.worker.terminate === 'function') {
        try {
          dbService.worker.terminate();
        } catch (_) {}
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const reg of registrations) {
          await reg.unregister();
        }
      }
      if ('caches' in window) {
        const cacheKeys = await caches.keys();
        for (const key of cacheKeys) {
          await caches.delete(key);
        }
      }
      if (navigator.storage && typeof navigator.storage.getDirectory === 'function') {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry('deeper-dhamma-opfs', { recursive: true });
        } catch (_) {}
      }
      if (window.indexedDB && window.indexedDB.databases) {
        const dbs = await window.indexedDB.databases();
        for (const db of dbs) {
          if (db.name && db.name.includes('dhamma')) {
            window.indexedDB.deleteDatabase(db.name);
          }
        }
      } else {
        window.indexedDB.deleteDatabase('dhamma_web_v1');
        window.indexedDB.deleteDatabase('deeper_dhamma_cache');
      }
      localStorage.clear();
      sessionStorage.clear();
      window.location.reload();
    } catch (e) {
      console.warn('Cache clear error:', e);
      window.location.reload();
    }
  };

  Object.assign(DD, {
    state,
    els,
    dbService,
    router,
    registerServiceWorker,
    init,
    loadArchiveStats,
    attachCardEventListeners,
    setupEventListeners,
    switchTab,
    updateHeaderPlayButton,
    openTranscriptDrawer,
  });

  // Start app on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
