/**
 * Deeper Dhamma — Frontend Application Logic
 * Fast debounced full-text search, direct Podbean CDN audio streaming,
 * interactive transcript seeking, and Pali lexicon exploration.
 */

(function () {
  'use strict';

  // State Management
  const state = {
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
    documents: {
      activeDocId: 1,
      cachedDocs: {},
      loadedOnce: false,
      filterQuery: '',
    },
  };

  // ==========================================================================
  // Fluent Emoji High Contrast Media Control SVG Icons (Wikipedia Reference)
  // https://en.wikipedia.org/wiki/Media_control_symbols
  // ==========================================================================
  const FLUENT_ICONS = {
    play: `<svg class="fluent-icon fluent-play" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path class="fluent-symbol" d="M23.5 16.866C24.1667 16.4811 24.1667 15.5189 23.5 15.134L11.5 8.20577C10.8333 7.82087 10 8.302 10 9.0718L10 22.9282C10 23.698 10.8333 24.1791 11.5 23.7942L23.5 16.866Z" fill="currentColor"/><path class="fluent-frame" d="M6 1C3.23858 1 1 3.23858 1 6V26C1 28.7614 3.23858 31 6 31H26C28.7614 31 31 28.7614 31 26V6C31 3.23858 28.7614 1 26 1H6ZM3 6C3 4.34315 4.34315 3 6 3H26C27.6569 3 29 4.34315 29 6V26C29 27.6569 27.6569 29 26 29H6C4.34315 29 3 27.6569 3 26V6Z" fill="currentColor"/></svg>`,
    pause: `<svg class="fluent-icon fluent-pause" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path class="fluent-symbol" d="M11 10C11 9.44772 11.4477 9 12 9H14C14.5523 9 15 9.44772 15 10V22C15 22.5523 14.5523 23 14 23H12C11.4477 23 11 22.5523 11 22V10Z" fill="currentColor"/><path class="fluent-symbol" d="M18 9C17.4477 9 17 9.44772 17 10V22C17 22.5523 17.4477 23 18 23H20C20.5523 23 21 22.5523 21 22V10C21 9.44772 20.5523 9 20 9H18Z" fill="currentColor"/><path class="fluent-frame" d="M1 6C1 3.23858 3.23858 1 6 1H26C28.7614 1 31 3.23858 31 6V26C31 28.7614 28.7614 31 26 31H6C3.23858 31 1 28.7614 1 26V6ZM6 3C4.34315 3 3 4.34315 3 6V26C3 27.6569 4.34315 29 6 29H26C27.6569 29 29 27.6569 29 26V6C29 4.34315 27.6569 3 26 3H6Z" fill="currentColor"/></svg>`,
    rewind: `<svg class="fluent-icon fluent-rewind" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path class="fluent-symbol" d="M15 15.0378V9.68977C15 8.80811 13.9419 8.35788 13.3066 8.9692L6.74885 15.2794C6.34001 15.6728 6.34001 16.3272 6.74885 16.7206L13.3066 23.0308C13.9419 23.6421 15 23.1919 15 22.3102V16.9622L21.3066 23.0308C21.9419 23.6421 23 23.1919 23 22.3102V9.68977C23 8.80811 21.9419 8.35788 21.3066 8.9692L15 15.0378Z" fill="currentColor"/><path class="fluent-frame" d="M1 6C1 3.23858 3.23858 1 6 1H26C28.7614 1 31 3.23858 31 6V26C31 28.7614 28.7614 31 26 31H6C3.23858 31 1 28.7614 1 26V6ZM6 3C4.34315 3 3 4.34315 3 6V26C3 27.6569 4.34315 29 6 29H26C27.6569 29 29 27.6569 29 26V6C29 4.34315 27.6569 3 26 3H6Z" fill="currentColor"/></svg>`,
    fastForward: `<svg class="fluent-icon fluent-fast-forward" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path class="fluent-symbol" d="M17 15.0377L10.6934 8.9692C10.0581 8.35788 9 8.80811 9 9.68977L9 22.3102C9 23.1919 10.0581 23.6421 10.6934 23.0308L17 16.9622V22.3102C17 23.1919 18.0581 23.6421 18.6934 23.0308L25.2512 16.7206C25.66 16.3272 25.66 15.6728 25.2512 15.2794L18.6934 8.9692C18.0581 8.35788 17 8.80811 17 9.68977V15.0377Z" fill="currentColor"/><path class="fluent-frame" d="M1 6C1 3.23858 3.23858 1 6 1H26C28.7614 1 31 3.23858 31 6V26C31 28.7614 28.7614 31 26 31H6C3.23858 31 1 28.7614 1 26V6ZM6 3C4.34315 3 3 4.34315 3 6V26C3 27.6569 4.34315 29 6 29H26C27.6569 29 29 27.6569 29 26V6C29 4.34315 27.6569 3 26 3H6Z" fill="currentColor"/></svg>`,
    skipBack: `<svg class="fluent-icon fluent-skip-back" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path class="fluent-symbol" d="M17 9.68977V15.0378L23.3066 8.9692C23.9419 8.35788 25 8.80811 25 9.68977V22.3102C25 23.1919 23.9419 23.6421 23.3066 23.0308L17 16.9622V22.3102C17 23.1919 15.9419 23.6421 15.3066 23.0308L9 16.9623V22.5C9 22.7761 8.77614 23 8.5 23H7.5C7.22386 23 7 22.7761 7 22.5V9.5C7 9.22386 7.22386 9 7.5 9H8.5C8.77614 9 9 9.22386 9 9.5V15.0378L15.3066 8.9692C15.9419 8.35788 17 8.80811 17 9.68977Z" fill="currentColor"/><path class="fluent-frame" d="M6 1C3.23858 1 1 3.23858 1 6V26C1 28.7614 3.23858 31 6 31H26C28.7614 31 31 28.7614 31 26V6C31 3.23858 28.7614 1 26 1H6ZM3 6C3 4.34315 4.34315 3 6 3H26C27.6569 3 29 4.34315 29 6V26C29 27.6569 27.6569 29 26 29H6C4.34315 29 3 27.6569 3 26V6Z" fill="currentColor"/></svg>`,
    skipFwd: `<svg class="fluent-icon fluent-skip-fwd" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path class="fluent-symbol" d="M9.69338 8.9692L16 15.0378V9.68977C16 8.80811 17.0581 8.35788 17.6934 8.9692L24 15.0377V9.5C24 9.22386 24.2239 9 24.5 9H25.5C25.7761 9 26 9.22386 26 9.5V22.5C26 22.7761 25.7761 23 25.5 23H24.5C24.2239 23 24 22.7761 24 22.5V16.9622L17.6934 23.0308C17.0581 23.6421 16 23.1919 16 22.3102V16.9622L9.69338 23.0308C9.05807 23.6421 8 23.1919 8 22.3102L8 9.68977C8 8.80811 9.05807 8.35788 9.69338 8.9692Z" fill="currentColor"/><path class="fluent-frame" d="M6 1C3.23858 1 1 3.23858 1 6V26C1 28.7614 3.23858 31 6 31H26C28.7614 31 31 28.7614 31 26V6C31 3.23858 28.7614 1 26 1H6ZM3 6C3 4.34315 4.34315 3 6 3H26C27.6569 3 29 4.34315 29 6V26C29 27.6569 27.6569 29 26 29H6C4.34315 29 3 27.6569 3 26V6Z" fill="currentColor"/></svg>`,
    speakerHigh: `<svg class="fluent-icon fluent-speaker-high" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7.99756 23.001L16.6106 26.8308C17.7343 27.3704 19.0356 26.551 19.0356 25.3044V19.0768C20.6809 19.0289 21.9999 17.6801 21.9999 16.0232C21.9999 14.3663 20.6809 13.0175 19.0356 12.9696V6.49639C19.0356 5.25508 17.1704 4.70337 16.0474 5.23141L8.01223 9.0124V9H3.80282C2.80707 9 2 9.84705 2 10.8921V21.1079C2 22.153 2.80707 23 3.80282 23L7.99756 23.001ZM17.0356 7.03194V24.831L9.99756 21.7015L9.99758 10.2885L16.8909 7.04485L16.8926 7.04443C16.9011 7.04219 16.9385 7.03229 17.0069 7.03165C17.0165 7.03156 17.0261 7.03166 17.0356 7.03194Z" fill="currentColor"/><path d="M24.11 11.0695C23.9694 10.9151 23.8237 10.7676 23.6725 10.6276C23.035 10.0376 22 10.4914 22 11.3601V11.3876C22 11.6595 22.1181 11.9164 22.3175 12.1007C23.3031 13.0139 23.9212 14.3189 23.9212 15.7682C23.9212 17.2176 23.3037 18.5226 22.3175 19.4357C22.1119 19.6257 22 19.8964 22 20.1764C22 21.047 23.0369 21.4976 23.6756 20.9057C23.7419 20.8445 23.8069 20.782 23.8706 20.7176C25.2437 19.3445 25.9762 17.5014 25.9175 15.5514C25.8681 13.8932 25.2256 12.2976 24.11 11.0695Z" fill="currentColor"/><path d="M23.5063 7.97456C23.195 7.79455 23 7.46518 23 7.1058C23 6.3333 23.8369 5.85705 24.5056 6.24455C27.79 8.14705 30 11.6989 30 15.7683C30 19.8371 27.7906 23.3896 24.505 25.2921C23.8363 25.6796 22.9994 25.2027 22.9994 24.4302C22.9994 24.0714 23.1931 23.7427 23.5038 23.5627C24.1756 23.1739 24.8006 22.6952 25.3638 22.1321C27.0863 20.4096 28.0244 18.1121 27.9994 15.6721C27.9763 13.4202 27.1031 11.2471 25.56 9.60643C24.9475 8.95518 24.2556 8.40893 23.5063 7.97456Z" fill="currentColor"/></svg>`,
    speakerLow: `<svg class="fluent-icon fluent-speaker-low" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M16.6106 26.8308L7.99756 23.001L3.80282 23C2.80707 23 2 22.153 2 21.1079V10.8921C2 9.84705 2.80707 9 3.80282 9H8.01223V9.0124L16.0474 5.23141C17.1704 4.70337 19.0356 5.25508 19.0356 6.49639V12.9696C20.6809 13.0175 21.9999 14.3663 21.9999 16.0232C21.9999 17.6801 20.6809 19.0289 19.0356 19.0768V25.3044C19.0356 26.551 17.7343 27.3704 16.6106 26.8308ZM17.0356 24.831V7.03194C17.0261 7.03166 17.0165 7.03156 17.0069 7.03165C16.9385 7.03229 16.9011 7.04219 16.8926 7.04443L16.8909 7.04485L9.99758 10.2885L9.99756 21.7015L17.0356 24.831Z" fill="currentColor"/><path d="M24.11 11.0695C23.9694 10.9151 23.8237 10.7676 23.6725 10.6276C23.035 10.0376 22 10.4914 22 11.3601V11.3876C22 11.6595 22.1181 11.9164 22.3175 12.1007C23.3031 13.0139 23.9212 14.3189 23.9212 15.7682C23.9212 17.2176 23.3037 18.5226 22.3175 19.4357C22.1119 19.6257 22 19.8964 22 20.1764C22 21.047 23.0369 21.4976 23.6756 20.9057C23.7419 20.8445 23.8069 20.782 23.8706 20.7176C25.2437 19.3445 25.9762 17.5014 25.9175 15.5514C25.8681 13.8932 25.2256 12.2976 24.11 11.0695Z" fill="currentColor"/></svg>`,
    speakerMute: `<svg class="fluent-icon fluent-speaker-mute" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19.0356 20.7181L24.9692 26.6519C25.4342 27.1161 26.1866 27.1161 26.6509 26.6511C27.1151 26.1869 27.1151 25.4337 26.6509 24.9694L6.83142 5.14994C6.36718 4.6857 5.61394 4.6857 5.1497 5.14994C4.68545 5.61418 4.68545 6.36742 5.1497 6.83167L7.31807 9.00012H3.80282C2.80707 9.00012 2 9.84717 2 10.8922V21.108C2 22.1531 2.80707 23.0001 3.80282 23.0001L7.99756 23.0011L16.6106 26.8309C17.7343 27.3705 19.0356 26.5512 19.0356 25.3045V20.7181ZM17.0356 18.718V24.8311L9.99756 21.7016L9.99758 11.6797L17.0356 18.718Z" fill="currentColor"/><path d="M21.9999 16.0233C21.9999 16.5266 21.8782 17.0015 21.6626 17.4201L17.0356 12.7931V7.03206C17.0261 7.03178 17.0165 7.03168 17.0069 7.03177C16.9385 7.03241 16.9011 7.04231 16.8926 7.04455L16.8909 7.04498L13.0805 8.83799L11.5774 7.33491L16.0474 5.23153C17.1704 4.70349 19.0356 5.2552 19.0356 6.49651V12.9697C20.6809 13.0176 21.9999 14.3664 21.9999 16.0233Z" fill="currentColor"/></svg>`
  };

  function renderBookmarkRibbonSvg(isBookmarked = false) {
    return `<svg class="bookmark-ribbon-icon" viewBox="0 0 24 24" width="18" height="18" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${isBookmarked ? '1.5' : '2'}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5C6 2.67157 6.67157 2 7.5 2H16.5C17.3284 2 18 2.67157 18 3.5V21.25C18 21.7303 17.446 22.0028 17.0645 21.7099L12 17.8182L6.93553 21.7099C6.55403 22.0028 6 21.7303 6 21.25V3.5Z"></path></svg>`;
  }

  // DOM Elements Cache
  const els = {
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
  };

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
        if (typeof showToast === 'function') showToast('Removed from Bookmarks');
        return false;
      } else {
        this.add(idStr);
        if (typeof showToast === 'function') showToast('Saved to Bookmarks');
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
  // Database Service (Injected Adapter: ApiDatabaseClient or WasmDatabaseClient)
  // ==========================================================================

  const dbService = window.DeeperDhammaDB ? new window.DeeperDhammaDB() : null;
  if (!dbService) {
    console.error('[App] No DeeperDhammaDB database client found. Ensure db_client.js is loaded.');
  }
  window.dbClient = dbService;
  if (window.WordSync && dbService) {
    window.WordSync.setDbClient(dbService);
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

  // ==========================================================================
  // Client-Side Zero-Storage PKZIP Engine (SimpleZipWriter)
  // ==========================================================================

  class SimpleZipWriter {
    constructor() {
      this.files = [];
    }

    addFile(filename, content) {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      this.files.push({ filename, data });
    }

    static crcTable = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
          c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        }
        t[i] = c;
      }
      return t;
    })();

    static crc32(buf) {
      let crc = 0xFFFFFFFF;
      const table = SimpleZipWriter.crcTable;
      for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    static async deflateBytes(bytes) {
      if (typeof CompressionStream !== 'undefined') {
        try {
          const cs = new CompressionStream('deflate-raw');
          const writer = cs.writable.getWriter();
          writer.write(bytes);
          writer.close();
          const res = await new Response(cs.readable).arrayBuffer();
          return new Uint8Array(res);
        } catch (_) {}
      }
      return null;
    }

    async buildBlob() {
      const localHeaders = [];
      const centralDirs = [];
      let offset = 0;

      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

      for (const file of this.files) {
        const nameBytes = new TextEncoder().encode(file.filename);
        const crc = SimpleZipWriter.crc32(file.data);
        const uncompressedSize = file.data.length;

        const deflated = await SimpleZipWriter.deflateBytes(file.data);
        const compressionMethod = deflated ? 8 : 0;
        const fileBytes = deflated || file.data;
        const compressedSize = fileBytes.length;

        // Local file header (30 bytes + name + data)
        const lh = new Uint8Array(30 + nameBytes.length + compressedSize);
        const lhView = new DataView(lh.buffer);

        lhView.setUint32(0, 0x04034b50, true);
        lhView.setUint16(4, 20, true);
        lhView.setUint16(6, 0x0800, true); // UTF-8 language encoding flag
        lhView.setUint16(8, compressionMethod, true);
        lhView.setUint16(10, dosTime, true);
        lhView.setUint16(12, dosDate, true);
        lhView.setUint32(14, crc, true);
        lhView.setUint32(18, compressedSize, true);
        lhView.setUint32(22, uncompressedSize, true);
        lhView.setUint16(26, nameBytes.length, true);
        lhView.setUint16(28, 0, true);

        lh.set(nameBytes, 30);
        lh.set(fileBytes, 30 + nameBytes.length);
        localHeaders.push(lh);

        // Central directory header (46 bytes + name)
        const cd = new Uint8Array(46 + nameBytes.length);
        const cdView = new DataView(cd.buffer);

        cdView.setUint32(0, 0x02014b50, true);
        cdView.setUint16(4, 20, true);
        cdView.setUint16(6, 20, true);
        cdView.setUint16(8, 0x0800, true);
        cdView.setUint16(10, compressionMethod, true);
        cdView.setUint16(12, dosTime, true);
        cdView.setUint16(14, dosDate, true);
        cdView.setUint32(16, crc, true);
        cdView.setUint32(20, compressedSize, true);
        cdView.setUint32(24, uncompressedSize, true);
        cdView.setUint16(28, nameBytes.length, true);
        cdView.setUint16(30, 0, true);
        cdView.setUint16(32, 0, true);
        cdView.setUint16(34, 0, true);
        cdView.setUint16(36, 0, true);
        cdView.setUint32(38, 0, true);
        cdView.setUint32(42, offset, true);

        cd.set(nameBytes, 46);
        centralDirs.push(cd);

        offset += lh.length;
      }

      const cdOffset = offset;
      let cdTotalSize = 0;
      centralDirs.forEach(cd => cdTotalSize += cd.length);

      // End of central directory record (22 bytes)
      const eocd = new Uint8Array(22);
      const eocdView = new DataView(eocd.buffer);

      eocdView.setUint32(0, 0x06054b50, true);
      eocdView.setUint16(4, 0, true);
      eocdView.setUint16(6, 0, true);
      eocdView.setUint16(8, this.files.length, true);
      eocdView.setUint16(10, this.files.length, true);
      eocdView.setUint32(12, cdTotalSize, true);
      eocdView.setUint32(16, cdOffset, true);
      eocdView.setUint16(20, 0, true);

      return new Blob([...localHeaders, ...centralDirs, eocd], { type: 'application/zip' });
    }
  }

  // ==========================================================================
  // Client-Side On-The-Fly Transcript Exporter (Zero Storage)
  // ==========================================================================

  const TranscriptExporter = {
    formatTimestampHms(totalSeconds) {
      const s = Math.max(0, Math.floor(totalSeconds || 0));
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = s % 60;
      const pad = (n) => String(n).padStart(2, '0');
      if (hours > 0) {
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
      }
      return `${pad(minutes)}:${pad(seconds)}`;
    },

    formatTimestampSrt(totalSeconds) {
      const s = Math.max(0, totalSeconds || 0);
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = Math.floor(s % 60);
      const millis = Math.floor((s - Math.floor(s)) * 1000);
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
    },

    formatTimestampVtt(totalSeconds) {
      const s = Math.max(0, totalSeconds || 0);
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = Math.floor(s % 60);
      const millis = Math.floor((s - Math.floor(s)) * 1000);
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
    },

    sanitizeSlug(text) {
      if (!text) return 'talk';
      return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 60);
    },

    getFilename(ep, ext) {
      const dateStr = ep.date || (ep.year ? `${ep.year}-01-01` : '2023-01-01');
      const cleanDate = dateStr.includes('-') ? dateStr : `${dateStr}-01-01`;
      const slug = this.sanitizeSlug(ep.title || ep.id);
      return `${cleanDate}_${slug}_transcript.${ext}`;
    },

    toMarkdown(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const durHms = this.formatTimestampHms(ep.duration_sec || 0);
      const streamLink = ep.media_url ? `[Stream on Podbean](${ep.media_url})` : 'N/A';

      const lines = [
        `# ${ep.title}`,
        `- **Date**: ${ep.date || ep.year || 'Unknown'}`,
        `- **Primary Teacher**: ${teacher}`,
        `- **Audio Stream**: ${streamLink}`,
        `- **Duration**: ${durHms} (${Math.round(ep.duration_sec || 0)}s)`,
        '',
        '---',
        '',
      ];

      segments.forEach((seg) => {
        const ts = this.formatTimestampHms(seg.start_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(`### [${ts}] ${spk}`);
        lines.push(seg.text || '');
        lines.push('');
      });

      return lines.join('\n');
    },

    toPlainText(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const durHms = this.formatTimestampHms(ep.duration_sec || 0);

      const lines = [
        `Title: ${ep.title}`,
        `Date: ${ep.date || ep.year || 'Unknown'}`,
        `Teacher: ${teacher}`,
        `Duration: ${durHms}`,
        `Audio: ${ep.media_url || 'N/A'}`,
        '',
        '================================================================================',
        '',
      ];

      segments.forEach((seg) => {
        const ts = this.formatTimestampHms(seg.start_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(`[${ts}] ${spk}:`);
        lines.push(seg.text || '');
        lines.push('');
      });

      return lines.join('\n');
    },

    toSrt(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const lines = [];

      segments.forEach((seg, idx) => {
        const startStr = this.formatTimestampSrt(seg.start_sec);
        const endStr = this.formatTimestampSrt(seg.end_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(String(idx + 1));
        lines.push(`${startStr} --> ${endStr}`);
        lines.push(`[${spk}] ${seg.text || ''}`);
        lines.push('');
      });

      return lines.join('\n');
    },

    toVtt(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const lines = [
        'WEBVTT',
        `NOTE Title: ${ep.title}`,
        `NOTE Speaker: ${teacher}`,
        `NOTE Date: ${ep.date || ep.year || ''}`,
        '',
      ];

      segments.forEach((seg) => {
        const startStr = this.formatTimestampVtt(seg.start_sec);
        const endStr = this.formatTimestampVtt(seg.end_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(`${startStr} --> ${endStr}`);
        lines.push(`<v ${spk}>${seg.text || ''}`);
        lines.push('');
      });

      return lines.join('\n');
    },

    toJson(ep) {
      return JSON.stringify(ep, null, 2);
    },

    triggerDownload(filename, mimeType, content) {
      const blob = typeof content === 'string'
        ? new Blob([content], { type: mimeType })
        : (content instanceof Blob ? content : new Blob([content], { type: mimeType }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },

    async downloadSingle(epOrId, format = 'md') {
      let ep = epOrId;
      if (typeof epOrId === 'string' || !epOrId.segments) {
        const epId = typeof epOrId === 'string' ? epOrId : (epOrId.id || epOrId.episode_id);
        try {
          ep = await dbService.getEpisode(epId);
        } catch (err) {
          console.error(`Failed to load transcript for ${epId}:`, err);
        }
      }
      if (!ep || !ep.segments || ep.segments.length === 0) {
        alert('This episode has not yet been transcribed.');
        return;
      }

      let content = '';
      let mime = 'text/plain; charset=utf-8';
      let ext = format;

      switch (format) {
        case 'md':
          content = this.toMarkdown(ep);
          mime = 'text/markdown; charset=utf-8';
          break;
        case 'txt':
          content = this.toPlainText(ep);
          mime = 'text/plain; charset=utf-8';
          break;
        case 'srt':
          content = this.toSrt(ep);
          mime = 'application/x-subrip; charset=utf-8';
          break;
        case 'vtt':
          content = this.toVtt(ep);
          mime = 'text/vtt; charset=utf-8';
          break;
        case 'json':
          content = this.toJson(ep);
          mime = 'application/json; charset=utf-8';
          break;
        default:
          content = this.toMarkdown(ep);
          ext = 'md';
      }

      const filename = this.getFilename(ep, ext);
      this.triggerDownload(filename, mime, content);
    }
  };

  // ==========================================================================
  // Archive Compilation Queue & Progress Synchronization
  // ==========================================================================

  async function compileAndDownloadArchive(episodesList, format = 'md', archiveBasename = 'transcripts') {
    if (!episodesList || episodesList.length === 0) {
      alert('No transcribed talks found matching the selected filters.');
      return;
    }

    state.archiveCancelRequested = false;

    // Show modal
    if (els.archiveProgressModal) {
      els.archiveProgressModal.style.display = 'flex';
      els.archiveProgressBar.style.width = '0%';
      els.archiveProgressBar.classList.remove('complete');
      els.archiveProgressPercent.textContent = '0%';
      els.archiveProgressCount.textContent = `0 of ${episodesList.length}`;
      els.archiveModalTitle.textContent = 'Compiling Transcript Archive';
      els.archiveModalSubtitle.textContent = `Packaging ${episodesList.length} talks into ${format.toUpperCase()} (.zip)...`;
      els.archiveModalCurrentItem.textContent = 'Initializing in-memory zip archive...';
    }

    const zip = new SimpleZipWriter();
    let processedCount = 0;

    for (let i = 0; i < episodesList.length; i++) {
      if (state.archiveCancelRequested) {
        if (els.archiveProgressModal) els.archiveProgressModal.style.display = 'none';
        return;
      }

      const summary = episodesList[i];
      const epId = summary.id || summary.episode_id;
      if (els.archiveModalCurrentItem) {
        els.archiveModalCurrentItem.textContent = `[${i + 1}/${episodesList.length}] Compiling: "${summary.title}"...`;
      }

      let ep = summary;
      if (!ep.segments || ep.segments.length === 0) {
        try {
          ep = await dbService.getEpisode(epId);
        } catch (e) {
          console.warn(`Could not load segments for ${epId}:`, e);
        }
      }

      if (ep && ep.segments && ep.segments.length > 0) {
        let content = '';
        switch (format) {
          case 'md': content = TranscriptExporter.toMarkdown(ep); break;
          case 'txt': content = TranscriptExporter.toPlainText(ep); break;
          case 'srt': content = TranscriptExporter.toSrt(ep); break;
          case 'vtt': content = TranscriptExporter.toVtt(ep); break;
          case 'json': content = TranscriptExporter.toJson(ep); break;
          default: content = TranscriptExporter.toMarkdown(ep);
        }

        const filename = TranscriptExporter.getFilename(ep, format);
        zip.addFile(filename, content);
        processedCount++;
      }

      // Update progress
      const pct = Math.round(((i + 1) / episodesList.length) * 100);
      if (els.archiveProgressBar) els.archiveProgressBar.style.width = `${pct}%`;
      if (els.archiveProgressPercent) els.archiveProgressPercent.textContent = `${pct}%`;
      if (els.archiveProgressCount) els.archiveProgressCount.textContent = `${i + 1} of ${episodesList.length}`;

      // Yield execution to allow DOM render
      await new Promise(r => setTimeout(r, 0));
    }

    if (processedCount === 0) {
      if (els.archiveProgressModal) els.archiveProgressModal.style.display = 'none';
      alert('None of the selected episodes have transcripts available yet.');
      return;
    }

    if (els.archiveModalCurrentItem) {
      els.archiveModalCurrentItem.textContent = 'Finalizing compressed ZIP file...';
    }
    if (els.archiveProgressBar) {
      els.archiveProgressBar.classList.add('complete');
    }

    const zipBlob = await zip.buildBlob();
    const today = new Date().toISOString().split('T')[0];
    const zipFilename = `${today}_deeper_dhamma_${archiveBasename}_${format}.zip`;

    TranscriptExporter.triggerDownload(zipFilename, 'application/zip', zipBlob);

    if (els.archiveModalTitle) els.archiveModalTitle.textContent = '✓ Archive Ready!';
    if (els.archiveModalSubtitle) els.archiveModalSubtitle.textContent = `Downloaded ${processedCount} transcripts in ${format.toUpperCase()} format.`;
    if (els.archiveModalCurrentItem) els.archiveModalCurrentItem.textContent = `File: ${zipFilename}`;

    setTimeout(() => {
      if (els.archiveProgressModal) els.archiveProgressModal.style.display = 'none';
    }, 1800);
  }

  async function downloadFilteredArchive(format) {
    try {
      let talks = state.currentFilteredTalks || [];
      if (state.search.filteredEpisodeIds && state.search.filteredEpisodeIds.length > talks.length) {
        talks = await dbService.getEpisodesByIds(state.search.filteredEpisodeIds);
      } else if (state.search.filteredFilterOpts && state.search.totalEpisodes > talks.length) {
        const data = await dbService.getEpisodes({ ...state.search.filteredFilterOpts, limit: 0, offset: 0 });
        if (data && Array.isArray(data.episodes)) {
          talks = data.episodes;
        }
      }
      await compileAndDownloadArchive(talks, format, 'filtered_transcripts');
    } catch (err) {
      console.error('Failed to download filtered archive:', err);
      alert('Failed to load matching talks for download.');
    }
  }

  async function downloadBrowseFilteredArchive(format) {
    try {
      let talks = state.catalog || [];
      if (state.browse.filteredEpisodeIds && state.browse.filteredEpisodeIds.length > talks.length) {
        talks = await dbService.getEpisodesByIds(state.browse.filteredEpisodeIds);
      } else if (state.browse.total > talks.length) {
        const data = await dbService.getEpisodes(buildBrowseQueryOpts({ limit: 0, offset: 0 }));
        if (data && Array.isArray(data.episodes)) {
          talks = data.episodes;
        }
      }
      await compileAndDownloadArchive(talks, format, 'browse_filtered_transcripts');
    } catch (err) {
      console.error('Failed to download filtered browse archive:', err);
      alert('Failed to load matching talks for download.');
    }
  }

  async function downloadAllArchive(format) {
    try {
      const data = await dbService.getEpisodes({
        transcribedOnly: true,
        limit: 10000,
      });
      const episodes = data.episodes || [];
      if (!episodes.length) {
        alert('No transcribed episodes found in the database.');
        return;
      }
      await compileAndDownloadArchive(episodes, format, 'all_transcripts');
    } catch (err) {
      console.error('Failed to load all episodes:', err);
      alert('Failed to load archive catalog for download.');
    }
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

  function setupDownloadDropdowns() {
    function closeAllDropdowns() {
      document.querySelectorAll('.download-dropdown-wrapper.open').forEach(w => {
        w.classList.remove('open');
        resetFloatingPanelPosition(w.querySelector('.download-dropdown-menu'));
        const pc = w.closest('.episode-card, .result-card');
        if (pc) pc.classList.remove('dropdown-active');
      });
    }

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.download-dropdown-btn');
      if (btn) {
        if (btn.disabled) return;
        e.stopPropagation();
        const wrapper = btn.closest('.download-dropdown-wrapper');
        if (!wrapper) return;
        const isOpen = wrapper.classList.contains('open');

        // Close all other dropdowns
        document.querySelectorAll('.download-dropdown-wrapper.open').forEach(w => {
          if (w !== wrapper) {
            w.classList.remove('open');
            resetFloatingPanelPosition(w.querySelector('.download-dropdown-menu'));
            const pc = w.closest('.episode-card, .result-card');
            if (pc) pc.classList.remove('dropdown-active');
          }
        });

        const willOpen = !isOpen;
        wrapper.classList.toggle('open', willOpen);
        const menu = wrapper.querySelector('.download-dropdown-menu');
        if (menu) {
          if (willOpen) {
            clampFloatingPanelToViewport(wrapper, menu);
          } else {
            resetFloatingPanelPosition(menu);
          }
        }
        const parentCard = wrapper.closest('.episode-card, .result-card');
        if (parentCard) {
          parentCard.classList.toggle('dropdown-active', willOpen);
        }
        return;
      }

      const opt = e.target.closest('.download-option');
      if (opt) {
        e.stopPropagation();
        const format = opt.dataset.format;
        const wrapper = opt.closest('.download-dropdown-wrapper');
        if (wrapper) {
          wrapper.classList.remove('open');
          resetFloatingPanelPosition(wrapper.querySelector('.download-dropdown-menu'));
          const pc = wrapper.closest('.episode-card, .result-card');
          if (pc) pc.classList.remove('dropdown-active');
        }

        if (wrapper && wrapper.id === 'filtered-archive-dropdown-wrapper') {
          downloadFilteredArchive(format);
        } else if (wrapper && wrapper.id === 'browse-filtered-archive-dropdown-wrapper') {
          downloadBrowseFilteredArchive(format);
        } else if (wrapper && wrapper.id === 'all-archive-dropdown-wrapper') {
          downloadAllArchive(format);
        } else if (wrapper && wrapper.id === 'single-talk-dropdown-wrapper') {
          if (state.currentEpisode) {
            TranscriptExporter.downloadSingle(state.currentEpisode, format);
          }
        } else if (opt.dataset.action === 'download-card-format') {
          const epId = opt.dataset.epId;
          TranscriptExporter.downloadSingle(epId, format);
        }
        return;
      }

      // Click outside closes open dropdowns
      closeAllDropdowns();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllDropdowns();
      }
    });
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
          <div class="empty-icon">🔍</div>
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
              <span>• ⏱️ ${durMin} mins</span>
            </div>
            <h3 class="episode-title">${escapeHtml(ep.title)}</h3>
          </div>

          <div class="episode-footer">
            <button type="button" class="btn-primary" data-action="play-ep-start" data-ep-id="${escapeHtml(ep.id)}">
              ▶ Play Talk
            </button>
            <button type="button" class="btn-secondary" data-action="view-transcript" data-ep-id="${escapeHtml(ep.id)}">
              📜 Transcript
            </button>
            <div class="download-dropdown-wrapper">
              <button type="button" class="btn-secondary download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                📥 Download ▾
              </button>
              <div class="download-dropdown-menu">
                <div class="dropdown-menu-header">Export Transcript</div>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="md">
                  <span class="download-opt-icon">📝</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Markdown</span>
                    <span class="download-opt-desc">Formatted notes (.md)</span>
                  </div>
                  <span class="download-opt-badge">.md</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="txt">
                  <span class="download-opt-icon">📄</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Plain Text</span>
                    <span class="download-opt-desc">Clean transcript text (.txt)</span>
                  </div>
                  <span class="download-opt-badge">.txt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="srt">
                  <span class="download-opt-icon">🎬</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">SubRip Subtitles</span>
                    <span class="download-opt-desc">For VLC / media players (.srt)</span>
                  </div>
                  <span class="download-opt-badge">.srt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="vtt">
                  <span class="download-opt-icon">🌐</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">WebVTT Captions</span>
                    <span class="download-opt-desc">Web caption track (.vtt)</span>
                  </div>
                  <span class="download-opt-badge">.vtt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="json">
                  <span class="download-opt-icon">📊</span>
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
          <div class="empty-icon">🔍</div>
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
            <span class="sentence-time-pill" data-est-time="${m.est_word_sec}">▶ ${timeStr}</span>
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
                ${durMin > 0 ? `<span>• ⏱️ ${durMin} mins</span>` : ''}
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
              📜 View Full Transcript
            </button>
            <button type="button" class="link-btn" data-action="play-ep-start" data-ep-id="${escapeHtml(group.id)}" title="Play talk from the beginning">
              ▶ Play Talk from Start
            </button>
            <div class="download-dropdown-wrapper">
              <button type="button" class="btn-secondary download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                📥 Download ▾
              </button>
              <div class="download-dropdown-menu">
                <div class="dropdown-menu-header">Export Transcript</div>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="md">
                  <span class="download-opt-icon">📝</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Markdown</span>
                    <span class="download-opt-desc">Formatted notes (.md)</span>
                  </div>
                  <span class="download-opt-badge">.md</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="txt">
                  <span class="download-opt-icon">📄</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Plain Text</span>
                    <span class="download-opt-desc">Clean transcript text (.txt)</span>
                  </div>
                  <span class="download-opt-badge">.txt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="srt">
                  <span class="download-opt-icon">🎬</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">SubRip Subtitles</span>
                    <span class="download-opt-desc">For VLC / media players (.srt)</span>
                  </div>
                  <span class="download-opt-badge">.srt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="vtt">
                  <span class="download-opt-icon">🌐</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">WebVTT Captions</span>
                    <span class="download-opt-desc">Web caption track (.vtt)</span>
                  </div>
                  <span class="download-opt-badge">.vtt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(group.id)}" data-format="json">
                  <span class="download-opt-icon">📊</span>
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

  // ==========================================================================
  // Browse Catalog View & Multi-Faceted Filtering
  // ==========================================================================

  const BROWSE_COLLECTION_LABELS = {
    mn: 'MN',
    dn: 'DN',
    sn: 'SN',
    an: 'AN',
    kn: 'KN (Ud/Iti)',
    sutta: 'Any Sutta',
  };

  const BROWSE_FORMAT_LABELS = {
    retreat: 'Retreats',
    non_retreat: 'Non-Retreat',
    rains_retreat: 'Rains Retreat',
    nine_day_retreat: '9-Day Retreat',
    weekend_retreat: 'Weekend Retreat',
    qa: 'Q&A',
    meditation: 'Meditation',
    workshop: 'Workshops',
  };

  const BROWSE_DURATION_LABELS = {
    under_15: '< 15 min',
    '15_30': '15–30 min',
    '30_60': '30–60 min',
    '60_90': '60–90 min',
    over_90: '90+ min',
  };

  function closeAllBrowsePopovers(exceptWrapper = null) {
    let closedAny = false;
    document.querySelectorAll('.browse-popover-wrapper.open').forEach((w) => {
      if (w !== exceptWrapper) {
        w.classList.remove('open');
        const btn = w.querySelector('.browse-filter-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        resetFloatingPanelPosition(w.querySelector('.browse-popover-panel'));
        closedAny = true;
      }
    });
    return closedAny;
  }

  function getTeacherDisplayNameBySlug(slug) {
    if (state.teachers && state.teachers[slug] && state.teachers[slug].name) {
      return state.teachers[slug].name;
    }
    const found = (state.browseTeachers || []).find((t) => t.slug === slug);
    return found ? found.name : slug;
  }

  function getYearsForEraPreset(preset) {
    const avail = state.browseYears || [];
    switch (preset) {
      case 'recent3':
        return avail.slice(0, 3);
      case '2020s':
        return avail.filter((y) => y >= 2020 && y <= 2029);
      case '2010s':
        return avail.filter((y) => y >= 2010 && y <= 2019);
      case '2000s':
        return avail.filter((y) => y >= 2000 && y <= 2009);
      case '1990s':
        return avail.filter((y) => y >= 1990 && y <= 1999);
      default:
        return [];
    }
  }

  function renderBrowseTeachersChecklist() {
    if (!els.browseTeachersList) return;
    const filterTerm = (els.browseTeachersSearch && els.browseTeachersSearch.value || '').trim().toLowerCase();
    const selectedSet = new Set(state.browse.teachers);
    const items = (state.browseTeachers || []).filter((t) => {
      if (!filterTerm) return true;
      return t.name.toLowerCase().includes(filterTerm);
    });

    if (items.length === 0) {
      els.browseTeachersList.innerHTML = '<div class="popover-hint" style="padding: 0.4rem;">No matching monastics.</div>';
      return;
    }

    els.browseTeachersList.innerHTML = items.map((t) => {
      const checked = selectedSet.has(t.slug) ? ' checked' : '';
      return `
        <label class="popover-check-item">
          <input type="checkbox" value="${escapeHtml(t.slug)}" data-teacher-slug="${escapeHtml(t.slug)}"${checked}>
          <span class="popover-teacher-dot" style="background: ${escapeHtml(t.color || '#f59e0b')};"></span>
          <span class="check-item-label">${escapeHtml(t.name)}</span>
          <span class="check-item-count">${Number(t.count || 0).toLocaleString()}</span>
        </label>
      `;
    }).join('');
  }

  function renderBrowseYearsGrid() {
    if (!els.browseYearsGrid) return;
    const years = state.browseYears || [];
    const counts = (state.stats && state.stats.year_counts) || {};
    const selectedSet = new Set(state.browse.years);

    const existingBtns = els.browseYearsGrid.querySelectorAll('.year-chip-btn[data-year]');
    if (existingBtns.length === years.length && years.length > 0) {
      existingBtns.forEach((btn) => {
        const y = Number(btn.dataset.year);
        const isSel = selectedSet.has(y);
        btn.classList.toggle('selected', isSel);
        btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      });
    } else {
      els.browseYearsGrid.innerHTML = years.map((y) => {
        const selClass = selectedSet.has(y) ? ' selected' : '';
        const cnt = counts[y] || counts[String(y)] || 0;
        return `
          <button type="button" class="year-chip-btn${selClass}" data-year="${y}" aria-pressed="${selectedSet.has(y) ? 'true' : 'false'}">
            <span>${y}</span>
            <span class="year-chip-cnt">${cnt}</span>
          </button>
        `;
      }).join('');
    }

    if (els.browseEraPresets) {
      els.browseEraPresets.querySelectorAll('.era-preset-btn').forEach((btn) => {
        const eraYears = getYearsForEraPreset(btn.dataset.era);
        const allSelected = eraYears.length > 0 && eraYears.every((y) => selectedSet.has(y));
        btn.classList.toggle('active', allSelected);
      });
    }
  }

  function populateBrowseFilterFacets(data) {
    if (!data) return;
    if (Array.isArray(data.browse_teachers) && data.browse_teachers.length > 0) {
      state.browseTeachers = data.browse_teachers;
    } else if (Array.isArray(data.teachers)) {
      state.browseTeachers = data.teachers.map((name) => ({
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        name,
        color: getSpeakerColor('', name),
        count: 0,
      }));
    }

    state.browseYears = Array.isArray(data.years) ? [...data.years] : [];

    if (els.browseYearsGrid) els.browseYearsGrid.innerHTML = '';
    renderBrowseTeachersChecklist();
    renderBrowseYearsGrid();

    if (els.browseYearFrom && els.browseYearTo && state.browseYears.length > 0) {
      const ascYears = [...state.browseYears].sort((a, b) => a - b);
      const descYears = [...state.browseYears].sort((a, b) => b - a);
      const prevFrom = els.browseYearFrom.value;
      const prevTo = els.browseYearTo.value;
      els.browseYearFrom.innerHTML = '<option value="">From...</option>' +
        ascYears.map((y) => `<option value="${y}">${y}</option>`).join('');
      els.browseYearTo.innerHTML = '<option value="">To...</option>' +
        descYears.map((y) => `<option value="${y}">${y}</option>`).join('');
      if (prevFrom) els.browseYearFrom.value = prevFrom;
      if (prevTo) els.browseYearTo.value = prevTo;
    }

    if (data.duration_counts) {
      Object.entries(data.duration_counts).forEach(([key, val]) => {
        const domKey = key === 'm15_30' ? '15_30' : (key === 'm30_60' ? '30_60' : (key === 'm60_90' ? '60_90' : key));
        const el = document.getElementById(`dur-cnt-${domKey}`);
        if (el) el.textContent = Number(val || 0).toLocaleString();
      });
    }

    if (data.category_counts) {
      Object.entries(data.category_counts).forEach(([key, val]) => {
        const el = document.getElementById(`cat-cnt-${key}`);
        if (el) el.textContent = Number(val || 0).toLocaleString();
      });
    }

    if (els.catCntBookmarked) {
      els.catCntBookmarked.textContent = BookmarkStore.count().toLocaleString();
    }

    syncBrowseFilterControlsFromState();
  }

  function hasActiveBrowseFilters() {
    const b = state.browse;
    return Boolean(
      b.teachers.length > 0 ||
      b.years.length > 0 ||
      (b.titleQuery && b.titleQuery.trim()) ||
      b.titleWholeWord ||
      b.durationBuckets.length > 0 ||
      b.minDurationMin !== '' ||
      b.maxDurationMin !== '' ||
      b.collections.length > 0 ||
      b.formats.length > 0 ||
      b.coTaughtOnly ||
      b.bookmarkedOnly
    );
  }

  function formatYearsSummaryLabel(yearsArr) {
    if (!yearsArr || yearsArr.length === 0) return 'Years: All';
    if (yearsArr.length === 1) return `Year: ${yearsArr[0]}`;
    const sorted = [...yearsArr].sort((a, b) => a - b);
    let isContiguous = true;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        isContiguous = false;
        break;
      }
    }
    if (isContiguous && sorted.length >= 3) {
      return `Years: ${sorted[0]}–${sorted[sorted.length - 1]} (${sorted.length})`;
    }
    if (sorted.length <= 3) {
      return `Years: ${sorted.join(', ')}`;
    }
    return `Years: ${sorted.length} selected`;
  }

  function updateBrowseFilterButtonsAndSummary() {
    const b = state.browse;

    // 1. Monastics button
    if (els.browseTeachersLabel && els.browseTeachersBtn) {
      if (b.teachers.length === 0) {
        els.browseTeachersLabel.textContent = 'Monastics: All';
        els.browseTeachersBtn.classList.remove('has-selection');
      } else if (b.teachers.length === 1) {
        els.browseTeachersLabel.textContent = getTeacherDisplayNameBySlug(b.teachers[0]);
        els.browseTeachersBtn.classList.add('has-selection');
      } else {
        const modeLabel = b.teacherMatch === 'all' ? 'All' : 'Any';
        els.browseTeachersLabel.textContent = `${b.teachers.length} Monastics (${modeLabel})`;
        els.browseTeachersBtn.classList.add('has-selection');
      }
    }

    if (els.browseTeachersSelectedInfo) {
      els.browseTeachersSelectedInfo.textContent = `${b.teachers.length} selected`;
    }
    if (els.btnTeacherModeAny && els.btnTeacherModeAll) {
      els.btnTeacherModeAny.classList.toggle('active', b.teacherMatch !== 'all');
      els.btnTeacherModeAll.classList.toggle('active', b.teacherMatch === 'all');
    }
    if (els.browseTeachersModeHint) {
      els.browseTeachersModeHint.innerHTML = b.teacherMatch === 'all'
        ? 'Show co-taught talks featuring <strong>all</strong> selected monastics together.'
        : 'Show talks featuring <strong>any</strong> selected monastic.';
    }

    // 2. Years button
    if (els.browseYearsLabel && els.browseYearsBtn) {
      els.browseYearsLabel.textContent = formatYearsSummaryLabel(b.years);
      els.browseYearsBtn.classList.toggle('has-selection', b.years.length > 0);
    }

    // 3. Length button
    if (els.browseDurationLabel && els.browseDurationBtn) {
      const hasMin = b.minDurationMin !== '' && !Number.isNaN(Number(b.minDurationMin));
      const hasMax = b.maxDurationMin !== '' && !Number.isNaN(Number(b.maxDurationMin));
      if (hasMin || hasMax) {
        if (hasMin && hasMax) {
          els.browseDurationLabel.textContent = `Length: ${b.minDurationMin}–${b.maxDurationMin} min`;
        } else if (hasMin) {
          els.browseDurationLabel.textContent = `Length: ≥ ${b.minDurationMin} min`;
        } else {
          els.browseDurationLabel.textContent = `Length: ≤ ${b.maxDurationMin} min`;
        }
        els.browseDurationBtn.classList.add('has-selection');
      } else if (b.durationBuckets.length > 0) {
        if (b.durationBuckets.length === 1) {
          els.browseDurationLabel.textContent = `Length: ${BROWSE_DURATION_LABELS[b.durationBuckets[0]] || b.durationBuckets[0]}`;
        } else {
          els.browseDurationLabel.textContent = `Length: ${b.durationBuckets.length} ranges`;
        }
        els.browseDurationBtn.classList.add('has-selection');
      } else {
        els.browseDurationLabel.textContent = 'Length: Any';
        els.browseDurationBtn.classList.remove('has-selection');
      }
    }

    // 4. Collection & Type button
    const catCount = b.collections.length + b.formats.length + (b.coTaughtOnly ? 1 : 0) + (b.bookmarkedOnly ? 1 : 0);
    if (els.browseCategoryLabel && els.browseCategoryBtn) {
      if (catCount === 0) {
        els.browseCategoryLabel.textContent = 'Collection & Type: All';
        els.browseCategoryBtn.classList.remove('has-selection');
      } else {
        const parts = [
          ...b.collections.map((c) => BROWSE_COLLECTION_LABELS[c] || c),
          ...b.formats.map((f) => BROWSE_FORMAT_LABELS[f] || f),
        ];
        if (b.coTaughtOnly) parts.push('Co-taught');
        if (b.bookmarkedOnly) parts.push('Bookmarked');
        els.browseCategoryLabel.textContent = parts.length <= 2
          ? `Type: ${parts.join(', ')}`
          : `Type: ${parts.length} active`;
        els.browseCategoryBtn.classList.add('has-selection');
      }
    }

    // 5. Reset button
    const hasFilters = hasActiveBrowseFilters();
    if (els.browseResetFiltersBtn) {
      els.browseResetFiltersBtn.disabled = !hasFilters && b.sort === 'year_desc';
    }

    // 6. Active filter chips
    if (els.browseActiveChips) {
      const chips = [];
      if (b.titleQuery && b.titleQuery.trim()) {
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="title" title="Remove title filter">Title: "${escapeHtml(b.titleQuery.trim())}"${b.titleWholeWord ? ' (word)' : ''} ✕</button>`);
      }
      if (b.teachers.length >= 2) {
        const nextMode = b.teacherMatch === 'all' ? 'Any (OR)' : 'All / Co-taught (AND)';
        chips.push(`<button type="button" class="browse-filter-chip browse-filter-chip-mode" data-toggle-teacher-mode="1" title="Click to switch monastic matching between Any (OR) and All (AND)">Match: ${b.teacherMatch === 'all' ? 'All (AND)' : 'Any (OR)'} ⇄ ${nextMode}</button>`);
      }
      b.teachers.forEach((slug) => {
        chips.push(`<button type="button" class="browse-filter-chip" data-remove-teacher="${escapeHtml(slug)}" title="Remove ${escapeHtml(getTeacherDisplayNameBySlug(slug))}">${escapeHtml(getTeacherDisplayNameBySlug(slug))} ✕</button>`);
      });

      if (b.years.length > 0) {
        const sortedYears = [...b.years].sort((a, b2) => b2 - a);
        if (sortedYears.length <= 4) {
          sortedYears.forEach((y) => {
            chips.push(`<button type="button" class="browse-filter-chip" data-remove-year="${y}" title="Remove year ${y}">${y} ✕</button>`);
          });
        } else {
          chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="years" title="Clear selected years">${escapeHtml(formatYearsSummaryLabel(sortedYears))} ✕</button>`);
        }
      }

      if (b.minDurationMin !== '' || b.maxDurationMin !== '') {
        const label = (b.minDurationMin !== '' && b.maxDurationMin !== '')
          ? `${b.minDurationMin}–${b.maxDurationMin} min`
          : (b.minDurationMin !== '' ? `≥ ${b.minDurationMin} min` : `≤ ${b.maxDurationMin} min`);
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="duration" title="Clear length filter">Length: ${escapeHtml(label)} ✕</button>`);
      } else {
        b.durationBuckets.forEach((bk) => {
          chips.push(`<button type="button" class="browse-filter-chip" data-remove-dur="${escapeHtml(bk)}" title="Remove duration range">Length: ${escapeHtml(BROWSE_DURATION_LABELS[bk] || bk)} ✕</button>`);
        });
      }

      b.collections.forEach((c) => {
        chips.push(`<button type="button" class="browse-filter-chip" data-remove-col="${escapeHtml(c)}">${escapeHtml(BROWSE_COLLECTION_LABELS[c] || c)} ✕</button>`);
      });
      b.formats.forEach((f) => {
        chips.push(`<button type="button" class="browse-filter-chip" data-remove-fmt="${escapeHtml(f)}">${escapeHtml(BROWSE_FORMAT_LABELS[f] || f)} ✕</button>`);
      });
      if (b.coTaughtOnly) {
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="cotaught">Co-taught (2+) ✕</button>`);
      }
      if (b.bookmarkedOnly) {
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="bookmarked">🔖 Bookmarked ✕</button>`);
      }

      els.browseActiveChips.innerHTML = chips.join('');
    }
  }

  function syncBrowseFilterControlsFromState() {
    const b = state.browse;
    if (els.browseTitleInput) els.browseTitleInput.value = b.titleQuery || '';
    if (els.browseClearTitleBtn) els.browseClearTitleBtn.style.display = (b.titleQuery || '').trim() ? 'inline-block' : 'none';
    if (els.browseTitleWordCheckbox) els.browseTitleWordCheckbox.checked = Boolean(b.titleWholeWord);

    if (els.browseTeachersList) {
      const teacherCbs = els.browseTeachersList.querySelectorAll('input[data-teacher-slug]');
      if (teacherCbs.length > 0) {
        const tSet = new Set(b.teachers);
        teacherCbs.forEach((cb) => {
          cb.checked = tSet.has(cb.dataset.teacherSlug);
        });
      } else {
        renderBrowseTeachersChecklist();
      }
    }
    renderBrowseYearsGrid();

    if (els.browseDurationBuckets) {
      const bucketSet = new Set(b.durationBuckets);
      els.browseDurationBuckets.querySelectorAll('input[data-dur-bucket]').forEach((cb) => {
        cb.checked = bucketSet.has(cb.dataset.durBucket);
      });
    }
    if (els.browseMinDuration) els.browseMinDuration.value = b.minDurationMin !== '' ? String(b.minDurationMin) : '';
    if (els.browseMaxDuration) els.browseMaxDuration.value = b.maxDurationMin !== '' ? String(b.maxDurationMin) : '';

    if (els.browseCollectionsList) {
      const colSet = new Set(b.collections);
      els.browseCollectionsList.querySelectorAll('input[data-collection]').forEach((cb) => {
        cb.checked = colSet.has(cb.dataset.collection);
      });
    }
    if (els.browseFormatsList) {
      const fmtSet = new Set(b.formats);
      els.browseFormatsList.querySelectorAll('input[data-format]').forEach((cb) => {
        cb.checked = fmtSet.has(cb.dataset.format);
      });
    }
    if (els.browseCotaughtCheckbox) els.browseCotaughtCheckbox.checked = Boolean(b.coTaughtOnly);
    if (els.browseBookmarkedCheckbox) els.browseBookmarkedCheckbox.checked = Boolean(b.bookmarkedOnly);
    if (els.browseSortSelect) els.browseSortSelect.value = b.sort || 'year_desc';

    updateBrowseFilterButtonsAndSummary();
  }

  function buildBrowseQueryOpts({ limit = state.browse.limit, offset = state.browse.offset } = {}) {
    const b = state.browse;
    const opts = {
      transcribedOnly: true,
      limit,
      offset,
      sort: b.sort || 'year_desc',
    };
    if (b.teachers.length > 0) {
      opts.teachers = [...b.teachers];
      opts.teacherMatch = b.teacherMatch || 'any';
    }
    if (b.years.length > 0) {
      opts.years = [...b.years];
    }
    if (b.titleQuery && b.titleQuery.trim()) {
      opts.titleQuery = b.titleQuery.trim();
      opts.titleWholeWord = Boolean(b.titleWholeWord);
    }
    if (b.minDurationMin !== '' && !Number.isNaN(Number(b.minDurationMin))) {
      opts.minDurationMin = Number(b.minDurationMin);
    }
    if (b.maxDurationMin !== '' && !Number.isNaN(Number(b.maxDurationMin))) {
      opts.maxDurationMin = Number(b.maxDurationMin);
    }
    if (opts.minDurationMin === undefined && opts.maxDurationMin === undefined && b.durationBuckets.length > 0) {
      opts.durationBuckets = [...b.durationBuckets];
    }
    if (b.collections.length > 0) opts.collections = [...b.collections];
    if (b.formats.length > 0) opts.formats = [...b.formats];
    if (b.coTaughtOnly) opts.coTaughtOnly = true;
    if (b.bookmarkedOnly) opts.episodeIds = BookmarkStore.getAll();
    return opts;
  }

  function buildBrowseRouteHash() {
    const b = state.browse;
    const qp = new URLSearchParams();
    if (b.teachers.length > 0) qp.set('teachers', b.teachers.join(','));
    if (b.teachers.length > 1 && b.teacherMatch === 'all') qp.set('tmode', 'all');
    if (b.years.length > 0) qp.set('years', [...b.years].sort((a, c) => c - a).join(','));
    if (b.titleQuery && b.titleQuery.trim()) qp.set('title', b.titleQuery.trim());
    if (b.titleWholeWord) qp.set('tword', '1');
    if (b.minDurationMin !== '') qp.set('minm', String(b.minDurationMin));
    if (b.maxDurationMin !== '') qp.set('maxm', String(b.maxDurationMin));
    if (b.minDurationMin === '' && b.maxDurationMin === '' && b.durationBuckets.length > 0) {
      qp.set('dur', b.durationBuckets.join(','));
    }
    if (b.collections.length > 0) qp.set('col', b.collections.join(','));
    if (b.formats.length > 0) qp.set('fmt', b.formats.join(','));
    if (b.coTaughtOnly) qp.set('cotaught', '1');
    if (b.bookmarkedOnly) qp.set('bmk', '1');
    if (b.sort && b.sort !== 'year_desc') qp.set('sort', b.sort);
    const qs = qp.toString();
    return qs ? `#browse?${qs}` : '#browse';
  }

  function applyBrowseParamsFromRoute(params = {}) {
    const b = state.browse;
    const splitCsv = (val) => val ? String(val).split(',').map((s) => s.trim()).filter(Boolean) : [];
    b.teachers = splitCsv(params.teachers);
    b.teacherMatch = params.tmode === 'all' ? 'all' : 'any';
    b.years = splitCsv(params.years).map((y) => Number(y)).filter((y) => y > 0);
    b.titleQuery = params.title ? String(params.title) : '';
    b.titleWholeWord = params.tword === '1' || params.tword === 'true';
    b.minDurationMin = (params.minm !== undefined && params.minm !== '') ? String(params.minm) : '';
    b.maxDurationMin = (params.maxm !== undefined && params.maxm !== '') ? String(params.maxm) : '';
    b.durationBuckets = (b.minDurationMin === '' && b.maxDurationMin === '') ? splitCsv(params.dur) : [];
    b.collections = splitCsv(params.col);
    b.formats = splitCsv(params.fmt);
    b.coTaughtOnly = params.cotaught === '1' || params.cotaught === 'true';
    b.bookmarkedOnly = params.bmk === '1' || params.bmk === 'true';
    b.sort = params.sort || 'year_desc';
    syncBrowseFilterControlsFromState();
  }

  function resetBrowseFilters() {
    const b = state.browse;
    b.teachers = [];
    b.teacherMatch = 'any';
    b.years = [];
    b.titleQuery = '';
    b.titleWholeWord = false;
    b.durationBuckets = [];
    b.minDurationMin = '';
    b.maxDurationMin = '';
    b.collections = [];
    b.formats = [];
    b.coTaughtOnly = false;
    b.bookmarkedOnly = false;
    b.sort = 'year_desc';
    if (els.browseTeachersSearch) els.browseTeachersSearch.value = '';
    if (els.browseYearFrom) els.browseYearFrom.value = '';
    if (els.browseYearTo) els.browseYearTo.value = '';
    syncBrowseFilterControlsFromState();
    loadBrowseCatalog({ append: false });
  }

  function setupBrowseFilterListeners() {
    // 1. Popover open/close behavior
    document.querySelectorAll('.browse-popover-wrapper .browse-filter-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrapper = btn.closest('.browse-popover-wrapper');
        if (!wrapper) return;
        const willOpen = !wrapper.classList.contains('open');
        closeAllBrowsePopovers(willOpen ? wrapper : null);
        wrapper.classList.toggle('open', willOpen);
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        const panel = wrapper.querySelector('.browse-popover-panel');
        if (panel) {
          if (willOpen) {
            clampFloatingPanelToViewport(wrapper, panel);
          } else {
            resetFloatingPanelPosition(panel);
          }
        }
        if (willOpen && wrapper.id === 'browse-teachers-dropdown' && els.browseTeachersSearch) {
          setTimeout(() => els.browseTeachersSearch.focus(), 20);
        }
      });
    });

    document.querySelectorAll('.browse-popover-panel').forEach((panel) => {
      panel.addEventListener('click', (e) => e.stopPropagation());
    });

    document.addEventListener('click', () => {
      closeAllBrowsePopovers();
    });

    // 2. Title filter + Whole Word toggle
    if (els.browseTitleInput) {
      els.browseTitleInput.addEventListener('input', () => {
        const val = els.browseTitleInput.value;
        state.browse.titleQuery = val;
        if (els.browseClearTitleBtn) {
          els.browseClearTitleBtn.style.display = val.trim() ? 'inline-block' : 'none';
        }
        clearTimeout(state.browse.debounceTimer);
        state.browse.debounceTimer = setTimeout(() => {
          updateBrowseFilterButtonsAndSummary();
          loadBrowseCatalog({ append: false });
        }, 160);
      });
    }

    if (els.browseClearTitleBtn) {
      els.browseClearTitleBtn.addEventListener('click', () => {
        state.browse.titleQuery = '';
        if (els.browseTitleInput) {
          els.browseTitleInput.value = '';
          els.browseTitleInput.focus();
        }
        els.browseClearTitleBtn.style.display = 'none';
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.browseTitleWordCheckbox) {
      els.browseTitleWordCheckbox.addEventListener('change', () => {
        state.browse.titleWholeWord = els.browseTitleWordCheckbox.checked;
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    // 3. Monastics multi-select
    if (els.browseTeachersSearch) {
      els.browseTeachersSearch.addEventListener('input', () => {
        renderBrowseTeachersChecklist();
      });
    }

    if (els.browseTeachersList) {
      els.browseTeachersList.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-teacher-slug]');
        if (!cb) return;
        const slug = cb.dataset.teacherSlug;
        const set = new Set(state.browse.teachers);
        if (cb.checked) set.add(slug);
        else set.delete(slug);
        state.browse.teachers = Array.from(set);
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    const setTeacherMode = (mode) => {
      if (state.browse.teacherMatch === mode) return;
      state.browse.teacherMatch = mode;
      updateBrowseFilterButtonsAndSummary();
      if (state.browse.teachers.length >= 2) {
        loadBrowseCatalog({ append: false });
      }
    };
    if (els.btnTeacherModeAny) {
      els.btnTeacherModeAny.addEventListener('click', () => setTeacherMode('any'));
    }
    if (els.btnTeacherModeAll) {
      els.btnTeacherModeAll.addEventListener('click', () => setTeacherMode('all'));
    }
    if (els.btnBrowseTeachersClear) {
      els.btnBrowseTeachersClear.addEventListener('click', () => {
        state.browse.teachers = [];
        if (els.browseTeachersSearch) els.browseTeachersSearch.value = '';
        renderBrowseTeachersChecklist();
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    // 4. Years grouping & multi-select
    if (els.browseYearsGrid) {
      els.browseYearsGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.year-chip-btn[data-year]');
        if (!btn) return;
        const y = Number(btn.dataset.year);
        const set = new Set(state.browse.years);
        if (set.has(y)) set.delete(y);
        else set.add(y);
        state.browse.years = Array.from(set).sort((a, b) => b - a);
        renderBrowseYearsGrid();
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.browseEraPresets) {
      els.browseEraPresets.addEventListener('click', (e) => {
        const btn = e.target.closest('.era-preset-btn[data-era]');
        if (!btn) return;
        const eraYears = getYearsForEraPreset(btn.dataset.era);
        if (eraYears.length === 0) return;
        const set = new Set(state.browse.years);
        const allSelected = eraYears.every((y) => set.has(y));
        if (allSelected) {
          eraYears.forEach((y) => set.delete(y));
        } else {
          eraYears.forEach((y) => set.add(y));
        }
        state.browse.years = Array.from(set).sort((a, b) => b - a);
        renderBrowseYearsGrid();
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.btnBrowseYearRangeAdd) {
      els.btnBrowseYearRangeAdd.addEventListener('click', () => {
        const y1 = Number(els.browseYearFrom && els.browseYearFrom.value);
        const y2 = Number(els.browseYearTo && els.browseYearTo.value);
        if (!y1 && !y2) return;
        const lo = y1 && y2 ? Math.min(y1, y2) : (y1 || y2);
        const hi = y1 && y2 ? Math.max(y1, y2) : (y1 || y2);
        const set = new Set(state.browse.years);
        (state.browseYears || []).forEach((y) => {
          if (y >= lo && y <= hi) set.add(y);
        });
        state.browse.years = Array.from(set).sort((a, b) => b - a);
        renderBrowseYearsGrid();
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.btnBrowseYearsClear) {
      els.btnBrowseYearsClear.addEventListener('click', () => {
        state.browse.years = [];
        if (els.browseYearFrom) els.browseYearFrom.value = '';
        if (els.browseYearTo) els.browseYearTo.value = '';
        renderBrowseYearsGrid();
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    // 5. Talk Length / Duration
    if (els.browseDurationBuckets) {
      els.browseDurationBuckets.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-dur-bucket]');
        if (!cb) return;
        // Clear custom range when selecting preset buckets
        state.browse.minDurationMin = '';
        state.browse.maxDurationMin = '';
        if (els.browseMinDuration) els.browseMinDuration.value = '';
        if (els.browseMaxDuration) els.browseMaxDuration.value = '';

        const selected = [];
        els.browseDurationBuckets.querySelectorAll('input[data-dur-bucket]:checked').forEach((el) => {
          selected.push(el.dataset.durBucket);
        });
        state.browse.durationBuckets = selected;
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    const onCustomDurationChange = () => {
      const minVal = els.browseMinDuration ? els.browseMinDuration.value.trim() : '';
      const maxVal = els.browseMaxDuration ? els.browseMaxDuration.value.trim() : '';
      state.browse.minDurationMin = minVal;
      state.browse.maxDurationMin = maxVal;
      if (minVal !== '' || maxVal !== '') {
        state.browse.durationBuckets = [];
        if (els.browseDurationBuckets) {
          els.browseDurationBuckets.querySelectorAll('input[data-dur-bucket]').forEach((cb) => {
            cb.checked = false;
          });
        }
      }
      clearTimeout(state.browse.debounceTimer);
      state.browse.debounceTimer = setTimeout(() => {
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      }, 180);
    };

    if (els.browseMinDuration) els.browseMinDuration.addEventListener('input', onCustomDurationChange);
    if (els.browseMaxDuration) els.browseMaxDuration.addEventListener('input', onCustomDurationChange);

    if (els.btnBrowseDurationClear) {
      els.btnBrowseDurationClear.addEventListener('click', () => {
        state.browse.durationBuckets = [];
        state.browse.minDurationMin = '';
        state.browse.maxDurationMin = '';
        if (els.browseMinDuration) els.browseMinDuration.value = '';
        if (els.browseMaxDuration) els.browseMaxDuration.value = '';
        if (els.browseDurationBuckets) {
          els.browseDurationBuckets.querySelectorAll('input[data-dur-bucket]').forEach((cb) => {
            cb.checked = false;
          });
        }
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    // 6. Collection & Format
    if (els.browseCollectionsList) {
      els.browseCollectionsList.addEventListener('change', () => {
        const cols = [];
        els.browseCollectionsList.querySelectorAll('input[data-collection]:checked').forEach((cb) => {
          cols.push(cb.dataset.collection);
        });
        state.browse.collections = cols;
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.browseFormatsList) {
      els.browseFormatsList.addEventListener('change', () => {
        const fmts = [];
        els.browseFormatsList.querySelectorAll('input[data-format]:checked').forEach((cb) => {
          fmts.push(cb.dataset.format);
        });
        state.browse.formats = fmts;
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.browseCotaughtCheckbox) {
      els.browseCotaughtCheckbox.addEventListener('change', () => {
        state.browse.coTaughtOnly = els.browseCotaughtCheckbox.checked;
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.browseBookmarkedCheckbox) {
      els.browseBookmarkedCheckbox.addEventListener('change', () => {
        state.browse.bookmarkedOnly = els.browseBookmarkedCheckbox.checked;
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.btnBrowseCategoryClear) {
      els.btnBrowseCategoryClear.addEventListener('click', () => {
        state.browse.collections = [];
        state.browse.formats = [];
        state.browse.coTaughtOnly = false;
        state.browse.bookmarkedOnly = false;
        syncBrowseFilterControlsFromState();
        loadBrowseCatalog({ append: false });
      });
    }

    // 7. Sort & Reset
    if (els.browseSortSelect) {
      els.browseSortSelect.addEventListener('change', () => {
        state.browse.sort = els.browseSortSelect.value || 'year_desc';
        updateBrowseFilterButtonsAndSummary();
        loadBrowseCatalog({ append: false });
      });
    }

    if (els.browseResetFiltersBtn) {
      els.browseResetFiltersBtn.addEventListener('click', resetBrowseFilters);
    }

    // 8. Active Filter Chips Removal & Quick Mode Toggle
    if (els.browseActiveChips) {
      els.browseActiveChips.addEventListener('click', (e) => {
        const chip = e.target.closest('.browse-filter-chip');
        if (!chip) return;
        if (chip.dataset.toggleTeacherMode) {
          state.browse.teacherMatch = state.browse.teacherMatch === 'all' ? 'any' : 'all';
        } else if (chip.dataset.removeTeacher) {
          state.browse.teachers = state.browse.teachers.filter((s) => s !== chip.dataset.removeTeacher);
        } else if (chip.dataset.removeYear) {
          const y = Number(chip.dataset.removeYear);
          state.browse.years = state.browse.years.filter((v) => v !== y);
        } else if (chip.dataset.removeDur) {
          state.browse.durationBuckets = state.browse.durationBuckets.filter((d) => d !== chip.dataset.removeDur);
        } else if (chip.dataset.removeCol) {
          state.browse.collections = state.browse.collections.filter((c) => c !== chip.dataset.removeCol);
        } else if (chip.dataset.removeFmt) {
          state.browse.formats = state.browse.formats.filter((f) => f !== chip.dataset.removeFmt);
        } else if (chip.dataset.clearChip === 'title') {
          state.browse.titleQuery = '';
          state.browse.titleWholeWord = false;
        } else if (chip.dataset.clearChip === 'years') {
          state.browse.years = [];
        } else if (chip.dataset.clearChip === 'duration') {
          state.browse.durationBuckets = [];
          state.browse.minDurationMin = '';
          state.browse.maxDurationMin = '';
        } else if (chip.dataset.clearChip === 'cotaught') {
          state.browse.coTaughtOnly = false;
        } else if (chip.dataset.clearChip === 'bookmarked') {
          state.browse.bookmarkedOnly = false;
        }
        syncBrowseFilterControlsFromState();
        loadBrowseCatalog({ append: false });
      });
    }
  }

  function renderBrowseEpisodeCardHtml(ep) {
    const isTranscribed = Boolean(ep.is_transcribed);
    const durMin = Math.round((ep.duration_sec || 0) / 60);
    const isBmk = BookmarkStore.has(ep.id);
    const titleHtml = highlightTitleText(ep.title, state.browse.titleQuery, state.browse.titleWholeWord);
    return `
      <div class="episode-card" data-ep-id="${escapeHtml(ep.id)}">
        <button type="button" class="btn-bookmark-icon card-bookmark-btn${isBmk ? ' is-bookmarked' : ''}" data-action="toggle-bookmark" data-ep-id="${escapeHtml(ep.id)}" title="${isBmk ? 'Remove bookmark' : 'Bookmark this talk'}" aria-label="${isBmk ? 'Remove bookmark' : 'Bookmark this talk'}">
          ${renderBookmarkRibbonSvg(isBmk)}
        </button>
        <div>
          <div class="result-meta-line" style="margin-bottom: 0.5rem; padding-right: 2.5rem;">
            ${renderTeacherBadgesHtml(ep)}
            ${formatEpisodeDateHtml(ep)}
            ${durMin > 0 ? `<span>• ⏱️ ${durMin} mins</span>` : ''}
          </div>
          <h3 class="episode-title">${titleHtml}</h3>
        </div>

        <div class="episode-footer">
          <button type="button" class="btn-primary" data-action="play-ep-start" data-ep-id="${escapeHtml(ep.id)}">
            ▶ Play Talk
          </button>
          ${isTranscribed ? `
            <button type="button" class="btn-secondary" data-action="view-transcript" data-ep-id="${escapeHtml(ep.id)}">
              📜 Transcript
            </button>
            <div class="download-dropdown-wrapper">
              <button type="button" class="btn-secondary download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                📥 Download ▾
              </button>
              <div class="download-dropdown-menu">
                <div class="dropdown-menu-header">Export Transcript</div>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="md">
                  <span class="download-opt-icon">📝</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Markdown</span>
                    <span class="download-opt-desc">Formatted notes (.md)</span>
                  </div>
                  <span class="download-opt-badge">.md</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="txt">
                  <span class="download-opt-icon">📄</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Plain Text</span>
                    <span class="download-opt-desc">Clean transcript text (.txt)</span>
                  </div>
                  <span class="download-opt-badge">.txt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="srt">
                  <span class="download-opt-icon">🎬</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">SubRip Subtitles</span>
                    <span class="download-opt-desc">For VLC / media players (.srt)</span>
                  </div>
                  <span class="download-opt-badge">.srt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="vtt">
                  <span class="download-opt-icon">🌐</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">WebVTT Captions</span>
                    <span class="download-opt-desc">Web caption track (.vtt)</span>
                  </div>
                  <span class="download-opt-badge">.vtt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="json">
                  <span class="download-opt-icon">📊</span>
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
            <a href="${getPodbeanUrl(ep.permalink)}" target="_blank" rel="noopener noreferrer" class="link-btn">
              ↗ Podbean
            </a>
          ` : ''}
        </div>
      </div>
    `;
  }

  async function loadBrowseCatalog({ append = false, skipHistory = false, overrideLimit = null } = {}) {
    state.browse.loadedOnce = true;
    if (!append) {
      state.browse.offset = 0;
    }
    const reqLimit = overrideLimit !== null ? overrideLimit : state.browse.limit;
    const opts = buildBrowseQueryOpts({ limit: reqLimit, offset: state.browse.offset });

    if (!skipHistory && state.activeTab === 'browse-view') {
      const targetHash = buildBrowseRouteHash();
      if (window.location.hash !== targetHash) {
        window.history.replaceState({ route: targetHash }, '', targetHash);
      }
    }

    try {
      const data = await dbService.getEpisodes(opts);
      const batch = data.episodes || [];
      const total = data.total !== undefined ? data.total : batch.length;
      const totalHours = data.total_duration_sec ? (Math.round((data.total_duration_sec / 3600.0) * 10) / 10) : 0;

      state.browse.total = total;
      state.browse.totalDurationSec = data.total_duration_sec || 0;
      state.browse.filteredEpisodeIds = Array.isArray(data.all_episode_ids) ? data.all_episode_ids : [];

      if (append) {
        state.catalog = state.catalog.concat(batch);
      } else {
        state.catalog = batch;
      }

      if (els.browseCountBadge) {
        els.browseCountBadge.textContent = String(total);
      }
      if (els.browseFilteredArchiveCount) {
        els.browseFilteredArchiveCount.textContent = total.toLocaleString();
      }
      if (els.btnBrowseDownloadFiltered) {
        els.btnBrowseDownloadFiltered.disabled = total === 0;
      }

      if (els.browseResultStats) {
        const hasFilters = hasActiveBrowseFilters();
        if (total === 0) {
          els.browseResultStats.textContent = '0 talks match active filters';
        } else if (state.catalog.length < total) {
          els.browseResultStats.textContent =
            `Showing 1–${state.catalog.length.toLocaleString()} of ${total.toLocaleString()} ${hasFilters ? 'matching ' : ''}talks (${totalHours.toLocaleString()} hrs)`;
        } else {
          els.browseResultStats.textContent =
            `Showing all ${total.toLocaleString()} ${hasFilters ? 'matching ' : ''}talk${total === 1 ? '' : 's'} (${totalHours.toLocaleString()} hrs)`;
        }
      }

      updateBrowseFilterButtonsAndSummary();

      if (!state.catalog || state.catalog.length === 0) {
        if (els.browseLoadMoreWrap) els.browseLoadMoreWrap.style.display = 'none';
        const showSwitchToAnyBtn = state.browse.teachers.length >= 2 && state.browse.teacherMatch === 'all';
        const emptyHint = showSwitchToAnyBtn
          ? 'No co-taught talks include every selected monastic together. Try switching monastic match to "Any (OR)" or clearing filters.'
          : (state.browse.bookmarkedOnly && BookmarkStore.count() === 0
            ? 'You have no saved bookmarks yet. Click the ribbon icon (🔖) on any talk to bookmark it.'
            : 'Try broadening your monastic, year, length, or title filters.');
        els.browseGrid.innerHTML = `
          <div class="empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">📂</div>
            <h3>No talks match the active filters</h3>
            <p style="margin-top: 0.4rem;">${escapeHtml(emptyHint)}</p>
            <div style="display: flex; gap: 0.6rem; justify-content: center; flex-wrap: wrap; margin-top: 1rem;">
              ${showSwitchToAnyBtn ? `<button type="button" class="btn-primary" id="btn-empty-switch-any">Switch Monastics to Any (OR)</button>` : ''}
              <button type="button" class="btn-secondary" id="btn-empty-reset-browse">✕ Reset All Filters</button>
            </div>
          </div>
        `;
        const switchAnyBtn = document.getElementById('btn-empty-switch-any');
        if (switchAnyBtn) {
          switchAnyBtn.addEventListener('click', () => {
            state.browse.teacherMatch = 'any';
            syncBrowseFilterControlsFromState();
            loadBrowseCatalog({ append: false });
          });
        }
        const emptyResetBtn = document.getElementById('btn-empty-reset-browse');
        if (emptyResetBtn) {
          emptyResetBtn.addEventListener('click', resetBrowseFilters);
        }
        return;
      }

      if (append) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = batch.map(renderBrowseEpisodeCardHtml).join('');
        attachCardEventListeners(tempDiv, batch);
        while (tempDiv.firstElementChild) {
          els.browseGrid.appendChild(tempDiv.firstElementChild);
        }
      } else {
        els.browseGrid.innerHTML = batch.map(renderBrowseEpisodeCardHtml).join('');
        attachCardEventListeners(els.browseGrid, state.catalog);
      }

      if (els.browseLoadMoreWrap && els.btnBrowseLoadMore) {
        const remaining = Math.max(0, total - state.catalog.length);
        if (remaining > 0) {
          els.browseLoadMoreWrap.style.display = 'flex';
          const nextBatch = Math.min(state.browse.limit, remaining);
          els.btnBrowseLoadMore.textContent = `+ Load ${nextBatch} More (${state.catalog.length.toLocaleString()} of ${total.toLocaleString()} shown)`;
          if (els.btnBrowseShowAll) {
            if (remaining > state.browse.limit && remaining <= 300) {
              els.btnBrowseShowAll.style.display = 'inline-flex';
              els.btnBrowseShowAll.textContent = `Show All Remaining (${remaining})`;
            } else {
              els.btnBrowseShowAll.style.display = 'none';
            }
          }
        } else {
          els.browseLoadMoreWrap.style.display = 'none';
        }
      }
    } catch (err) {
      console.error('Failed to load browse catalog:', err);
    }
  }

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
          <div class="empty-icon">🔖</div>
          <h2>No Bookmarked Talks Yet</h2>
          <p>Click the bookmark ribbon icon (🔖) on any talk in Search or Browse to store it locally for fast recall.</p>
          <button type="button" class="btn-primary" style="margin-top: 1rem;" id="btn-bookmarks-go-browse">
            📚 Browse Talks Catalog
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
            <div class="empty-icon">⚠️</div>
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
          <div class="empty-icon">⚠️</div>
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
                ▲
              </button>
              <button type="button" class="btn-reorder btn-reorder-down" data-action="bookmark-down" data-ep-id="${escapeHtml(ep.id)}" ${isLast ? 'disabled' : ''} title="Move talk down" aria-label="Move Down">
                ▼
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
                ${durMin > 0 ? `<span class="bookmark-meta-item">• ⏱️ ${durMin}m</span>` : ''}
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
                ▶ Play Talk
              </button>
              ${isTranscribed ? `
                <button type="button" class="btn-secondary btn-sm" data-action="view-transcript" data-ep-id="${escapeHtml(ep.id)}">
                  📜 Transcript
                </button>
                <div class="download-dropdown-wrapper">
                  <button type="button" class="btn-secondary btn-sm download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                    📥 Download ▾
                  </button>
                  <div class="download-dropdown-menu">
                    <div class="dropdown-menu-header">Export Transcript</div>
                    <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="md">
                      <span class="download-opt-icon">📝</span>
                      <div class="download-opt-text">
                        <span class="download-opt-title">Markdown</span>
                        <span class="download-opt-desc">Formatted notes (.md)</span>
                      </div>
                      <span class="download-opt-badge">.md</span>
                    </button>
                    <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="txt">
                      <span class="download-opt-icon">📄</span>
                      <div class="download-opt-text">
                        <span class="download-opt-title">Plain Text</span>
                        <span class="download-opt-desc">Clean transcript text (.txt)</span>
                      </div>
                      <span class="download-opt-badge">.txt</span>
                    </button>
                    <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="srt">
                      <span class="download-opt-icon">🎬</span>
                      <div class="download-opt-text">
                        <span class="download-opt-title">SubRip Subtitles</span>
                        <span class="download-opt-desc">For VLC / media players (.srt)</span>
                      </div>
                      <span class="download-opt-badge">.srt</span>
                    </button>
                    <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="vtt">
                      <span class="download-opt-icon">🌐</span>
                      <div class="download-opt-text">
                        <span class="download-opt-title">WebVTT Captions</span>
                        <span class="download-opt-desc">Web caption track (.vtt)</span>
                      </div>
                      <span class="download-opt-badge">.vtt</span>
                    </button>
                    <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(ep.id)}" data-format="json">
                      <span class="download-opt-icon">📊</span>
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
        wordId: el.id || null,
      });
    });

    // Chronological order
    allTerms.sort((a, b) => a.startSec - b.startSec);
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

  function scrollElementIntoReadingZone(el, behavior = 'auto') {
    if (!el) return;
    const sc = getScrollContainer();
    const mainRect = sc !== window ? sc.getBoundingClientRect() : null;
    const viewportH = window.innerHeight || document.documentElement.clientHeight;
    const topFloor = mainRect ? Math.max(0, mainRect.top) : 0;
    let bottomLimit = mainRect ? Math.min(viewportH, mainRect.bottom) : viewportH;

    const toolbar = document.getElementById('transcript-sticky-toolbar');
    const toolbarBottom = toolbar ? Math.max(topFloor, toolbar.getBoundingClientRect().bottom) : topFloor;
    const playerBar = document.getElementById('audio-player-bar');
    if (playerBar) {
      bottomLimit = Math.min(bottomLimit, playerBar.getBoundingClientRect().top);
    }
    const companionBar = document.getElementById('transcript-lexicon-companion');
    if (companionBar) {
      const compStyle = window.getComputedStyle(companionBar);
      const viewportW = document.documentElement.clientWidth || window.innerWidth;
      const isBottomSheet = compStyle.position === 'fixed' || (sc !== window && viewportW <= 1024);
      if (compStyle.display !== 'none' && isBottomSheet) {
        const compRect = companionBar.getBoundingClientRect();
        if (compRect.height > 0) {
          bottomLimit = Math.min(bottomLimit, compRect.top);
        }
      }
    }

    const rect = el.getBoundingClientRect();
    const availableH = Math.max(80, bottomLimit - toolbarBottom);
    const desiredTopInViewport = toolbarBottom + Math.min(availableH * 0.35, Math.max(20, (availableH - rect.height) / 2));
    const targetScrollY = Math.max(0, getScrollTopPos() + (rect.top - desiredTopInViewport));
    scrollContentTo(targetScrollY, behavior);
  }

  function jumpToCompanionTerm(idx) {
    const terms = state.lexCompanion.allTerms;
    if (!terms || !terms[idx]) return;
    const term = terms[idx];

    // 1. Seek audio to term's start time
    if (state.currentEpisode) {
      playAudioSegment({
        episode_id: state.currentEpisode.id,
        media_url: state.currentEpisode.media_url,
        title: state.currentEpisode.title,
        teacher: state.currentEpisode.primary_display,
        start_sec: term.startSec,
      });
    }

    // 2. Scroll transcript cleanly to spoken word or turn
    let scrollTarget = null;
    if (term.wordId) {
      scrollTarget = document.getElementById(term.wordId);
    }
    if (!scrollTarget) {
      scrollTarget = document.getElementById(`turn-${term.turnIdx}`);
    }

    if (scrollTarget) {
      if (window.WordSync) {
        window.WordSync._userInteractedAt = 0;
        window.WordSync._teleprompterLine = null;
      }
      scrollElementIntoReadingZone(scrollTarget, 'smooth');
      if (term.wordId && scrollTarget.classList.contains('transcript-word')) {
        if (window.WordSync) {
          window.WordSync.clearHighlights();
          scrollTarget.classList.add('active-word');
          window.WordSync.activeWordEl = scrollTarget;
        }
      } else {
        scrollTarget.classList.add('target-turn-flash');
        setTimeout(() => scrollTarget.classList.remove('target-turn-flash'), 2500);
      }
    }

    // 3. Highlight this card in companion (scrolling only the companion stack)
    setActiveCompanionTerm(idx, { scrollCompanion: true });
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

    let targetIdx = -1;
    for (let i = terms.length - 1; i >= 0; i--) {
      if (terms[i].startSec <= currentTime + 0.35) {
        targetIdx = i;
        break;
      }
    }

    if (targetIdx === -1 && currentTime >= 0) {
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
      setActiveCompanionTerm(matchedIdx, { scrollCompanion: true });
    }

    if (options.userClicked && window.innerWidth <= 1024) {
      toggleMobileLexSheet(true);
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
            window.WordSync.clearHighlights();
            targetWordEl.classList.add('active-word');
            window.WordSync.activeWordEl = targetWordEl;
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
        if (!state.currentEpisode || state.currentEpisode.id !== epLoadToken) return;
        const needsReRender = !(wordsReadySync && paliReadySync);
        if (needsReRender) {
          renderDrawerTurns();
          if (window.WordSync) {
            window.WordSync._teleprompterLine = null;
            window.WordSync.activeWordEl = null;
            window.WordSync.activeWordIdx = -1;
          }
        }
        buildCompanionTermsList();
        if (targetOpts && needsReRender) {
          applyTargetOpts(targetOpts, true);
        }
        if (state.playingEpisode && state.currentEpisode && state.playingEpisode.id === state.currentEpisode.id && els.nativeAudio && els.nativeAudio.currentTime > 0) {
          const rawCur = els.nativeAudio.currentTime;
          const physCur = window.WordSync ? window.WordSync.getPhysicalTime(rawCur) : rawCur;
          if (window.WordSync && needsReRender) {
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

  // ==========================================================================
  // Audio Player Engine (Cross-Browser VBR Neutralized & Podbean CDN Streaming)
  // ==========================================================================

  function setupAudioEngine() {
    const audio = els.nativeAudio;
    let isScrubbing = false;
    let scrubCommitted = false;

    const mainEl = document.getElementById('main-content');
    function updateLayoutChromeVars() {
      if (els.playerBar) {
        const rectH = els.playerBar.getBoundingClientRect().height;
        const h = Math.ceil(rectH) || els.playerBar.offsetHeight || 78;
        document.documentElement.style.setProperty('--player-height', `${h}px`);
      }
      if (mainEl) {
        const rectMh = mainEl.getBoundingClientRect().height;
        if (rectMh > 0) {
          document.documentElement.style.setProperty('--main-height', `${Math.floor(rectMh)}px`);
        }
      }
      if (els.transcriptStickyToolbar && !els.transcriptStickyToolbar.classList.contains('is-actions-open')) {
        const rectTh = els.transcriptStickyToolbar.getBoundingClientRect().height;
        if (rectTh > 0) {
          const th = Math.ceil(rectTh);
          document.documentElement.style.setProperty('--toolbar-height', `${th}px`);
        }
      }
    }
    updateLayoutChromeVars();
    window.addEventListener('resize', () => {
      updateLayoutChromeVars();
      document.querySelectorAll('.download-dropdown-wrapper.open').forEach((w) => {
        clampFloatingPanelToViewport(w, w.querySelector('.download-dropdown-menu'));
      });
      document.querySelectorAll('.browse-popover-wrapper.open').forEach((w) => {
        clampFloatingPanelToViewport(w, w.querySelector('.browse-popover-panel'));
      });
    }, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => updateLayoutChromeVars());
      if (els.playerBar) ro.observe(els.playerBar);
      if (mainEl) ro.observe(mainEl);
      if (els.transcriptStickyToolbar) ro.observe(els.transcriptStickyToolbar);
    }

    function getTotalDuration() {
      if (window.WordSync && window.WordSync.vbrData && window.WordSync.vbrData.totalDurSec > 0) {
        return window.WordSync.vbrData.totalDurSec;
      }
      return Number.isFinite(audio.duration) ? audio.duration : 0;
    }

    function safeSeek(targetPhysicalTime) {
      const totalDur = getTotalDuration();
      const dur = totalDur > 0 ? totalDur : Infinity;
      const clampedPhys = Math.max(0, Math.min(dur, targetPhysicalTime));
      const doSeek = () => {
        try {
          const curDur = Number.isFinite(audio.duration) ? audio.duration : dur;
          const streamSeek = window.WordSync
            ? window.WordSync.prepareSeek(clampedPhys)
            : clampedPhys;
          audio.currentTime = Math.max(0, Math.min(curDur, streamSeek));
        } catch (err) {
          console.warn('Seek error:', err);
        }
      };

      // In Firefox on VBR talks, ensure the client-side patched progressive Blob covers clampedPhys
      if (
        window.WordSync &&
        window.WordSync.isFirefox &&
        window.WordSync.vbrData &&
        state.currentMediaUrl
      ) {
        const mediaUrl = state.currentMediaUrl;
        const wasPlaying = !audio.paused;
        const readyBlobUrl = window.WordSync.getReadyFirefoxBlobUrl(mediaUrl, clampedPhys);
        if (readyBlobUrl) {
          window.WordSync.streamMode = 'patched_blob';
          if (state.currentStreamUrl !== readyBlobUrl) {
            state.currentStreamUrl = readyBlobUrl;
            audio.src = readyBlobUrl;
            audio.playbackRate = state.playbackSpeed;
            audio.addEventListener('loadedmetadata', doSeek, { once: true });
            if (wasPlaying) audio.play().catch(() => {});
            return;
          }
        } else {
          window.WordSync.waitForFirefoxBlobUrl(mediaUrl, clampedPhys).then(blobUrl => {
            if (!blobUrl || state.currentMediaUrl !== mediaUrl) return;
            window.WordSync.streamMode = 'patched_blob';
            if (state.currentStreamUrl !== blobUrl) {
              state.currentStreamUrl = blobUrl;
              audio.src = blobUrl;
              audio.playbackRate = state.playbackSpeed;
              audio.addEventListener('loadedmetadata', doSeek, { once: true });
              if (wasPlaying) audio.play().catch(() => {});
            } else {
              doSeek();
            }
          });
          return;
        }
      }

      // HAVE_METADATA (1) is enough to seek a stream; waiting for
      // HAVE_CURRENT_DATA (2) drops seeks while buffering.
      if (audio.readyState >= 1) {
        doSeek();
      } else {
        const onReady = () => {
          audio.removeEventListener('loadedmetadata', onReady);
          audio.removeEventListener('loadeddata', onReady);
          audio.removeEventListener('canplay', onReady);
          doSeek();
        };
        audio.addEventListener('loadedmetadata', onReady);
        audio.addEventListener('loadeddata', onReady);
        audio.addEventListener('canplay', onReady);
      }
    }

    function syncProgress() {
      if (isScrubbing) return; // Do not overwrite slider while user is dragging
      if (window.WordSync && window.WordSync._awaitingInitialSeek) {
        return;
      }
      const rawCur = audio.currentTime;
      const physCur = window.WordSync ? window.WordSync.getPhysicalTime(rawCur) : rawCur;
      const dur = getTotalDuration();
      els.timeCurrent.textContent = formatSeconds(physCur);
      if (dur > 0) {
        els.timeTotal.textContent = formatSeconds(dur);
        els.scrubber.value = Math.min(100, Math.max(0, (physCur / dur) * 100));
      }
      if (state.activeTab === 'transcript-view') {
        const isViewingPlaying = state.playingEpisode && state.currentEpisode && (state.playingEpisode.id === state.currentEpisode.id);
        if (isViewingPlaying) {
          if (window.WordSync) {
            window.WordSync.update(rawCur);
          }
          updateActiveCompanionTerm(physCur);
        }
      }
    }

    ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked'].forEach(evt => {
      audio.addEventListener(evt, syncProgress);
    });

    ['play', 'pause', 'ended'].forEach(evt => {
      audio.addEventListener(evt, () => {
        updateHeaderPlayButton();
      });
    });

    audio.addEventListener('seeked', () => {
      if (scrubCommitted) {
        scrubCommitted = false;
        isScrubbing = false;
        syncProgress();
      }
    });

    audio.addEventListener('play', () => {
      els.btnPlayPause.innerHTML = FLUENT_ICONS.pause;
      els.btnPlayPause.setAttribute('title', 'Pause (Space)');
      els.btnPlayPause.setAttribute('aria-label', 'Pause');
    });

    audio.addEventListener('pause', () => {
      els.btnPlayPause.innerHTML = FLUENT_ICONS.play;
      els.btnPlayPause.setAttribute('title', 'Play (Space)');
      els.btnPlayPause.setAttribute('aria-label', 'Play');
    });

    // If a partial progressive Firefox Blob reaches the end of its initial slice before
    // the full talk duration, seamlessly upgrade to the newly buffered chunks at physCur.
    audio.addEventListener('ended', () => {
      if (
        window.WordSync &&
        window.WordSync.streamMode === 'patched_blob' &&
        window.WordSync.vbrData &&
        state.currentMediaUrl
      ) {
        const dur = Number.isFinite(audio.duration) ? audio.duration : window.WordSync.vbrData.totalDurSec;
        const physCur = window.WordSync.getPhysicalTime(audio.currentTime);
        if (dur > 0 && physCur < dur - 5) {
          const mediaUrl = state.currentMediaUrl;
          window.WordSync.waitForFirefoxBlobUrl(mediaUrl, physCur + 30).then(blobUrl => {
            if (!blobUrl || state.currentMediaUrl !== mediaUrl) return;
            state.currentStreamUrl = blobUrl;
            audio.src = blobUrl;
            audio.playbackRate = state.playbackSpeed;
            audio.addEventListener('loadedmetadata', () => {
              audio.currentTime = window.WordSync.prepareSeek(physCur);
              audio.play().catch(() => {});
            }, { once: true });
          });
        }
      }
    });

    els.btnPlayPause.addEventListener('click', togglePlayPause);

    if (els.btnPrevTrack) {
      els.btnPrevTrack.addEventListener('click', playPrevTrack);
    }

    if (els.btnNextTrack) {
      els.btnNextTrack.addEventListener('click', playNextTrack);
    }

    els.btnSkipBack.addEventListener('click', () => {
      const curPhys = window.WordSync ? window.WordSync.getPhysicalTime(audio.currentTime) : audio.currentTime;
      safeSeek(curPhys - 15);
    });

    els.btnSkipFwd.addEventListener('click', () => {
      const curPhys = window.WordSync ? window.WordSync.getPhysicalTime(audio.currentTime) : audio.currentTime;
      safeSeek(curPhys + 15);
    });

    // Scrubber: show preview during drag, seek only on commit to prevent stream thrashing
    els.scrubber.addEventListener('input', () => {
      isScrubbing = true;
      scrubCommitted = false;
      const dur = getTotalDuration();
      if (dur > 0) {
        const previewTime = (parseFloat(els.scrubber.value) / 100) * dur;
        els.timeCurrent.textContent = formatSeconds(previewTime);
      }
    });

    const commitScrub = () => {
      if (!isScrubbing || scrubCommitted) return; // change + mouseup both fire; seek once
      scrubCommitted = true;
      const dur = getTotalDuration();
      if (dur > 0) {
        const target = (parseFloat(els.scrubber.value) / 100) * dur;
        safeSeek(target);
      }
      // Release on 'seeked'; fallback timeout in case the seek is dropped
      setTimeout(() => {
        if (scrubCommitted) {
          scrubCommitted = false;
          isScrubbing = false;
        }
      }, 1500);
    };

    els.scrubber.addEventListener('change', commitScrub);
    els.scrubber.addEventListener('mouseup', commitScrub);
    els.scrubber.addEventListener('touchend', commitScrub);

    // Player Settings View toggle & close handlers
    function syncPlayerSettingsIndicators() {
      const vol = els.nativeAudio ? els.nativeAudio.volume : 1.0;
      const spd = state.playbackSpeed || 1.0;
      if (els.playerSettingsSpeedVal) {
        els.playerSettingsSpeedVal.textContent = Number.isInteger(spd) ? `${spd.toFixed(1)}x` : `${spd}x`;
      }
      if (els.playerSettingsVolVal) {
        els.playerSettingsVolVal.textContent = vol === 0 ? 'Muted' : `${Math.round(vol * 100)}%`;
      }
      if (els.btnPlayerSettings) {
        els.btnPlayerSettings.classList.toggle('has-custom', spd !== 1.0 || vol === 0);
      }
    }

    if (els.btnPlayerSettings && els.playerSettingsView) {
      els.btnPlayerSettings.addEventListener('click', () => {
        if (isPlayerSettingsOpen()) {
          closePlayerSettings();
        } else {
          openPlayerSettings();
        }
      });
    }

    if (els.btnClosePlayerSettings) {
      els.btnClosePlayerSettings.addEventListener('click', () => {
        closePlayerSettings();
      });
    }

    if (els.playerSettingsView) {
      els.playerSettingsView.addEventListener('click', (e) => {
        if (e.target === els.playerSettingsView) {
          closePlayerSettings();
        }
      });
    }

    // Speed selector
    els.speedBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        audio.playbackRate = speed;
        state.playbackSpeed = speed;
        els.speedBtns.forEach(b => b.classList.toggle('active', b === btn));
        syncPlayerSettingsIndicators();
      });
    });

    // Volume handling
    function updateVolumeIcon(vol) {
      if (els.volIcon) {
        if (vol === 0) {
          els.volIcon.innerHTML = FLUENT_ICONS.speakerMute;
          if (els.volToggleBtn) els.volToggleBtn.title = 'Unmute audio';
        } else if (vol < 0.5) {
          els.volIcon.innerHTML = FLUENT_ICONS.speakerLow;
          if (els.volToggleBtn) els.volToggleBtn.title = 'Mute audio';
        } else {
          els.volIcon.innerHTML = FLUENT_ICONS.speakerHigh;
          if (els.volToggleBtn) els.volToggleBtn.title = 'Mute audio';
        }
      }
      syncPlayerSettingsIndicators();
    }

    let lastVolume = 1.0;
    if (els.volToggleBtn) {
      els.volToggleBtn.addEventListener('click', () => {
        if (audio.volume > 0) {
          lastVolume = audio.volume;
          audio.volume = 0;
          if (els.volumeSlider) els.volumeSlider.value = 0;
        } else {
          audio.volume = lastVolume > 0 ? lastVolume : 1.0;
          if (els.volumeSlider) els.volumeSlider.value = audio.volume;
        }
        updateVolumeIcon(audio.volume);
      });
    }

    if (els.volumeSlider) {
      els.volumeSlider.addEventListener('input', () => {
        audio.volume = parseFloat(els.volumeSlider.value);
        updateVolumeIcon(audio.volume);
      });
    }

    syncPlayerSettingsIndicators();

    if (window.WordSync) {
      window.WordSync.bindAudio(audio);
    }
  }

  function isPlayerSettingsOpen() {
    return Boolean(els.playerSettingsView && els.playerSettingsView.style.display !== 'none');
  }

  function openPlayerSettings() {
    if (!els.playerSettingsView) return;
    els.playerSettingsView.style.display = 'flex';
    if (els.btnPlayerSettings) {
      els.btnPlayerSettings.setAttribute('aria-expanded', 'true');
    }
    if (els.btnClosePlayerSettings) {
      els.btnClosePlayerSettings.focus();
    }
  }

  function closePlayerSettings() {
    if (!isPlayerSettingsOpen()) return false;
    const activeWasInside = document.activeElement && els.playerSettingsView.contains(document.activeElement);
    els.playerSettingsView.style.display = 'none';
    if (els.btnPlayerSettings) {
      els.btnPlayerSettings.setAttribute('aria-expanded', 'false');
      if (activeWasInside) {
        els.btnPlayerSettings.focus();
      }
    }
    return true;
  }

  function playPrevTrack() {
    if (!state.catalog || state.catalog.length === 0) return;
    const currentIdx = state.catalog.findIndex(ep => ep.media_url === state.currentMediaUrl);
    if (currentIdx > 0) {
      const prevEp = state.catalog[currentIdx - 1];
      playAudioSegment({
        episode_id: prevEp.id || prevEp.episode_id,
        media_url: prevEp.media_url,
        title: prevEp.title,
        teacher: prevEp.teacher || prevEp.primary_display,
        start_sec: 0,
      });
    } else {
      if (window.WordSync) window.WordSync.prepareSeek(0);
      els.nativeAudio.currentTime = 0;
    }
  }

  function playNextTrack() {
    if (!state.catalog || state.catalog.length === 0) return;
    const currentIdx = state.catalog.findIndex(ep => ep.media_url === state.currentMediaUrl);
    if (currentIdx >= 0 && currentIdx < state.catalog.length - 1) {
      const nextEp = state.catalog[currentIdx + 1];
      playAudioSegment({
        episode_id: nextEp.id || nextEp.episode_id,
        media_url: nextEp.media_url,
        title: nextEp.title,
        teacher: nextEp.teacher || nextEp.primary_display,
        start_sec: 0,
      });
    }
  }

  // 500ms lead time to first word for any/all seek reference points
  const SEEK_REF_LEAD_TIME_SEC = 0.50;

  function resolveEpisodeId(explicitId, mediaUrl) {
    if (explicitId) return explicitId;
    if (state.playingEpisode && state.playingEpisode.media_url === mediaUrl) {
      return state.playingEpisode.id || state.playingEpisode.episode_id;
    }
    if (state.currentEpisode && state.currentEpisode.media_url === mediaUrl) {
      return state.currentEpisode.id || state.currentEpisode.episode_id;
    }
    if (state.catalog && state.catalog.length > 0) {
      const found = state.catalog.find(e => e.media_url === mediaUrl);
      if (found) return found.id || found.episode_id;
    }
    if (mediaUrl) {
      const m = mediaUrl.match(/(pb\d+)/i);
      if (m) return m[1];
    }
    return null;
  }

  function playAudioSegment({ episode_id, media_url, title, teacher, start_sec }) {
    if (!media_url) {
      alert('Podbean CDN streaming URL is not available for this talk.');
      return;
    }

    const audio = els.nativeAudio;
    els.playerTitle.textContent = title || 'BSWA Dhamma Talk';
    const spkColor = getSpeakerColor('', teacher);
    els.playerSpeaker.innerHTML = `<span class="player-speaker-dot" style="background-color: ${spkColor}; box-shadow: 0 0 8px ${spkColor};"></span> ${escapeHtml(teacher || 'Monastic')}`;

    const epId = resolveEpisodeId(episode_id, media_url);
    state.currentMediaUrl = media_url;
    state.playingEpisode = {
      id: epId,
      media_url: media_url,
      title: title,
      teacher: teacher,
    };
    if (window.WordSync) {
      window.WordSync.playingEpisodeId = epId;
    }
    if (els.btnPlayerTranscript) {
      els.btnPlayerTranscript.style.display = 'inline-flex';
    }
    updateHeaderPlayButton();
    BookmarkStore.syncUiButtons();

    // Apply exactly 500ms lead time to first word for any/all seek ref points (clamped to 0)
    const rawTarget = typeof start_sec === 'number' ? start_sec : parseFloat(start_sec || 0);
    const targetTime = Math.max(0, rawTarget > 0 ? (rawTarget - SEEK_REF_LEAD_TIME_SEC) : 0);

    function performSeek(physSec, wordStartSec) {
      if (physSec < 0) return;
      if (state._pendingOnReadySeek) {
        audio.removeEventListener('loadedmetadata', state._pendingOnReadySeek);
        audio.removeEventListener('loadeddata', state._pendingOnReadySeek);
        audio.removeEventListener('canplay', state._pendingOnReadySeek);
        state._pendingOnReadySeek = null;
      }
      const doSeek = () => {
        try {
          if (window.WordSync) {
            window.WordSync._awaitingInitialSeek = false;
          }
          const streamSeekTime = window.WordSync
            ? window.WordSync.prepareSeek(physSec, wordStartSec)
            : physSec;
          audio.currentTime = streamSeekTime;
          if (window.WordSync && state.activeTab === 'transcript-view' && state.currentEpisode && state.currentEpisode.id === epId) {
            window.WordSync.update(streamSeekTime);
          }
        } catch (e) {
          console.warn('Seek error:', e);
        }
      };
      if (audio.readyState >= 1) {
        doSeek();
      } else {
        if (window.WordSync) {
          window.WordSync._awaitingInitialSeek = true;
        }
        const onReady = () => {
          audio.removeEventListener('loadedmetadata', onReady);
          audio.removeEventListener('loadeddata', onReady);
          audio.removeEventListener('canplay', onReady);
          if (state._pendingOnReadySeek === onReady) {
            state._pendingOnReadySeek = null;
          }
          doSeek();
        };
        state._pendingOnReadySeek = onReady;
        audio.addEventListener('loadedmetadata', onReady);
        audio.addEventListener('loadeddata', onReady);
        audio.addEventListener('canplay', onReady);
      }
    }

    function unlockAudioGestureSync() {
      if (state.audioGestureUnlocked) return;
      state.audioGestureUnlocked = true;
      if (!audio.src || audio.src === window.location.href || audio.src.endsWith('/')) {
        try {
          audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
          const p = audio.play();
          if (p !== undefined) p.catch(() => {});
          audio.pause();
        } catch (_) {}
      }
    }

    function launchStreamAndSeek(streamUrl, mode) {
      state.audioGestureUnlocked = true;
      if (window.WordSync) {
        window.WordSync.streamMode = mode;
      }
      const isDifferentSource = state.currentStreamUrl !== streamUrl;
      state.currentStreamUrl = streamUrl;

      if (window.WordSync && targetTime > 0) {
        window.WordSync._seekTargetWordTime = rawTarget;
        window.WordSync._pendingProgrammaticSeek = true;
        if (isDifferentSource || audio.readyState < 1) {
          window.WordSync._awaitingInitialSeek = true;
        }
      }
      if (isDifferentSource) {
        audio.src = streamUrl;
        audio.playbackRate = state.playbackSpeed;
        if (targetTime > 0) {
          performSeek(targetTime, rawTarget);
        } else if (window.WordSync) {
          window.WordSync._awaitingInitialSeek = false;
          window.WordSync.prepareSeek(0, 0);
        }
      } else {
        performSeek(targetTime, rawTarget);
      }

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          console.warn('Playback gesture error:', e);
        });
      }
    }

    function startWithLoadedProfile() {
      if (state.currentMediaUrl !== media_url) return;

      // In Firefox on VBR episodes, use pure client-side progressive Fetch + Info-patched Blob
      if (window.WordSync && window.WordSync.isFirefox && window.WordSync.vbrData) {
        const readyBlobUrl = window.WordSync.getReadyFirefoxBlobUrl(media_url, targetTime);
        if (readyBlobUrl) {
          launchStreamAndSeek(readyBlobUrl, 'patched_blob');
          return;
        }
        unlockAudioGestureSync();
        window.WordSync.waitForFirefoxBlobUrl(media_url, targetTime).then(blobUrl => {
          if (state.currentMediaUrl !== media_url) return;
          if (blobUrl) {
            launchStreamAndSeek(blobUrl, 'patched_blob');
          } else {
            launchStreamAndSeek(media_url, 'cdn');
          }
        });
        return;
      }

      // Chromium / Safari / CBR episodes: stream directly from Podbean CDN
      launchStreamAndSeek(media_url, 'cdn');
    }

    // If WordSync has not loaded this episode's VBR profile yet (e.g. playing from Search tab),
    // load the compact .bin sidecar first and then start playback/seek.
    if (window.WordSync && epId && window.WordSync.currentEpisodeId !== epId) {
      unlockAudioGestureSync();
      window.WordSync.ensureEpisodeLoaded(epId).then(() => {
        startWithLoadedProfile();
      });
    } else {
      startWithLoadedProfile();
    }
  }

  async function togglePlayPause() {
    const audio = els.nativeAudio;

    // If no audio track is active yet, auto-play first available talk
    if (!audio.src || audio.src === window.location.href || audio.src.endsWith('/')) {
      const epToPlay = state.playingEpisode || state.currentEpisode;
      if (epToPlay && epToPlay.media_url) {
        playAudioSegment({
          episode_id: epToPlay.id || epToPlay.episode_id,
          media_url: epToPlay.media_url,
          title: epToPlay.title,
          teacher: epToPlay.primary_display || epToPlay.teacher,
          start_sec: 0,
        });
        return;
      }

      if (state.catalog && state.catalog.length > 0 && state.catalog[0].media_url) {
        const firstEp = state.catalog[0];
        playAudioSegment({
          episode_id: firstEp.id || firstEp.episode_id,
          media_url: firstEp.media_url,
          title: firstEp.title,
          teacher: firstEp.teacher,
          start_sec: 0,
        });
        return;
      }

      try {
        const data = await dbService.getEpisodes({ transcribedOnly: true, limit: 1 });
        if (data && data.episodes && data.episodes.length > 0 && data.episodes[0].media_url) {
          const ep = data.episodes[0];
          playAudioSegment({
            episode_id: ep.id || ep.episode_id,
            media_url: ep.media_url,
            title: ep.title,
            teacher: ep.teacher,
            start_sec: 0,
          });
          return;
        }
      } catch (err) {
        console.error('Failed to auto-load talk on play:', err);
      }
      return;
    }

    if (audio.paused) {
      audio.play().catch(e => console.warn('Play error:', e));
    } else {
      audio.pause();
    }
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

  // Start app on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
