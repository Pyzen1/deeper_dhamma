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
    currentMediaUrl: '',
    playbackSpeed: 1.0,
    activeTab: 'search-view',
    previousTab: 'search-view',
    stats: null,
    teachers: {},
    catalog: [],
    currentFilteredTalks: [],
    dateFilterMode: 'year',
    archiveCancelRequested: false,
    lexicon: {
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
    speakerMute: `<svg class="fluent-icon fluent-speaker-mute" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19.0356 20.7181L24.9692 26.6519C25.4342 27.1161 26.1866 27.1161 26.6509 26.6511C27.1151 26.1869 27.1151 25.4337 26.6509 24.9694L6.83142 5.14994C6.36718 4.6857 5.61394 4.6857 5.1497 5.14994C4.68545 5.61418 4.68545 6.36742 5.1497 6.83167L7.31807 9.00012H3.80282C2.80707 9.00012 2 9.84717 2 10.8922V21.108C2 22.1531 2.80707 23.0001 3.80282 23.0001L7.99756 23.0011L16.6106 26.8309C17.7343 27.3705 19.0356 26.5512 19.0356 25.3045V20.7181ZM17.0356 18.718V24.8311L9.99756 21.7016L9.99758 11.6797L17.0356 18.718Z" fill="currentColor"/><path d="M21.9999 16.0233C21.9999 16.5266 21.8782 17.0015 21.6626 17.4201L17.0356 12.7931V7.03206C17.0261 7.03178 17.0165 7.03168 17.0069 7.03177C16.9385 7.03241 16.9011 7.04231 16.8926 7.04455L16.8909 7.04498L13.0805 8.83799L11.5774 7.33491L16.0474 5.23153C17.1704 4.70349 19.0356 5.2552 19.0356 6.49651V12.9697C20.6809 13.0176 21.9999 14.3664 21.9999 16.0233Z" fill="currentColor"/></svg>`,
    mic: `<svg class="fluent-icon fluent-mic" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17.2889 2H14.7289C12.1789 2 10.0989 4.07 10.0989 6.63V8.12H14.8589C15.2789 8.12 15.6089 8.46 15.6089 8.87C15.6089 9.27999 15.2789 9.62 14.8589 9.62H10.0989V11.3101H14.8589C15.2789 11.3101 15.6089 11.6401 15.6089 12.0601C15.6089 12.4701 15.2789 12.8101 14.8589 12.8101H10.0989V14.49H14.8589C15.2789 14.49 15.6089 14.83 15.6089 15.24C15.6089 15.65 15.2789 15.99 14.8589 15.99H10.0989V17.37C10.0989 19.93 12.1689 22 14.7289 22H17.2889C19.8489 22 21.9189 19.93 21.9189 17.37V6.63C21.9189 4.07 19.8389 2 17.2889 2ZM21.9188 8.12V9.62H17.1588C16.7388 9.62 16.4088 9.27999 16.4088 8.87C16.4088 8.46 16.7388 8.12 17.1588 8.12H21.9188ZM17.1588 11.3101H21.9188V12.8101H17.1588C16.7388 12.8101 16.4088 12.4701 16.4088 12.0601C16.4088 11.6401 16.7388 11.3101 17.1588 11.3101ZM21.9188 14.49V15.99H17.1588C16.7388 15.99 16.4088 15.65 16.4088 15.24C16.4088 14.83 16.7388 14.49 17.1588 14.49H21.9188Z" fill="currentColor"/><path d="M23.9189 12.88C24.4712 12.88 24.9189 13.3277 24.9189 13.88V18.17C24.9189 21.9419 21.8618 24.9994 18.0901 25H18.0889L13.8289 25.01C10.0655 25.01 7.00891 21.9512 7.00891 18.18V13.89C7.00891 13.3377 7.45663 12.89 8.00891 12.89C8.5612 12.89 9.00891 13.3377 9.00891 13.89V18.18C9.00891 20.8485 11.1717 23.0094 13.8278 23.01H13.8289L18.0889 23C20.7566 23 22.9189 20.8377 22.9189 18.17V13.88C22.9189 13.3277 23.3666 12.88 23.9189 12.88Z" fill="currentColor"/><path d="M11.2889 26H13.819V25.01H18.209V26H20.7289C21.6589 26 22.5089 26.51 22.9389 27.32L23.9289 29.14C24.1388 29.53 23.8588 30 23.4188 30H8.58885C8.14885 30 7.86885 29.53 8.07885 29.14L9.06885 27.32C9.50885 26.51 10.3689 26 11.2889 26Z" fill="currentColor"/></svg>`
  };

  // DOM Elements Cache
  const els = {
    // Inputs & Filters
    searchInput: document.getElementById('search-input'),
    clearSearchBtn: document.getElementById('clear-search-btn'),
    exactCheckbox: document.getElementById('exact-mode-checkbox'),
    teacherFilter: document.getElementById('teacher-filter-select'),
    yearFilter: document.getElementById('year-filter-select'),
    browseTeacherFilter: document.getElementById('browse-teacher-filter-select'),
    browseYearFilter: document.getElementById('browse-year-filter-select'),
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
    tabLexiconBtn: document.getElementById('tab-lexicon-btn'),
    tabTranscriptBtn: document.getElementById('tab-transcript-btn'),
    searchCountBadge: document.getElementById('search-count-badge'),
    browseCountBadge: document.getElementById('browse-count-badge'),

    // Views
    searchView: document.getElementById('search-view'),
    browseView: document.getElementById('browse-view'),
    lexiconView: document.getElementById('lexicon-view'),
    transcriptView: document.getElementById('transcript-view'),
    
    // Search Content
    searchMetaBar: document.getElementById('search-meta-bar'),
    queryMetaText: document.getElementById('query-meta-text'),
    queryTierBadge: document.getElementById('query-tier-badge'),
    searchEmptyState: document.getElementById('search-empty-state'),
    searchResultsList: document.getElementById('search-results-list'),
    exampleChips: document.getElementById('example-queries'),

    // Browse Content
    browseGrid: document.getElementById('browse-episodes-grid'),

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
    docChipRetrieved: document.getElementById('doc-chip-retrieved'),
    docChipFormat: document.getElementById('doc-chip-format'),
    docChipSize: document.getElementById('doc-chip-size'),
    docChipSha: document.getElementById('doc-chip-sha'),
    docFilterInput: document.getElementById('doc-filter-input'),
    clearDocFilterBtn: document.getElementById('clear-doc-filter-btn'),
    docFilterCount: document.getElementById('doc-filter-count'),
    docRenderedBody: document.getElementById('doc-rendered-body'),

    // Transcript View Elements
    transcriptBackBtn: document.getElementById('transcript-back-btn'),
    drawerTitle: document.getElementById('drawer-episode-title'),
    drawerDateTag: document.getElementById('drawer-date-tag'),
    drawerMetaInfo: document.getElementById('drawer-meta-info'),
    drawerPlayFullBtn: document.getElementById('drawer-play-full-btn'),
    drawerPodbeanLink: document.getElementById('drawer-podbean-link'),
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

  function extractTeachers(item) {
    if (!item) return [{ name: 'BSWA Monastic', color: '#f59e0b', slug: 'bswa_monastic' }];

    const results = [];
    const seen = new Set();

    // 1. Check identified_teachers field from database (e.g. "Venerable Bodhidhaja, Ajahn Cunda")
    const identified = (item.identified_teachers || '').trim();
    if (identified) {
      const names = identified.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
      for (const name of names) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            name,
            color: getSpeakerColor('', name),
            slug: key.replace(/[^a-z0-9]+/g, '_')
          });
        }
      }
      if (results.length > 0) return results;
    }

    // 2. Split teacher string on delimiters: '&', 'and', ',', '/'
    const teacherStr = (item.teacher || item.primary_display || '').trim();
    if (teacherStr && (/[&,/]|\band\b/i.test(teacherStr))) {
      const names = teacherStr.split(/\s*(?:&|\band\b|,|\/)\s*/i).map(s => s.trim()).filter(Boolean);
      for (const name of names) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            name,
            color: getSpeakerColor('', name),
            slug: key.replace(/[^a-z0-9]+/g, '_')
          });
        }
      }
      if (results.length > 0) return results;
    }

    // 3. Scan title and teacher string against known monastic teachers in database
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

    // 4. Fallback: single teacher
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

  // ==========================================================================
  // Database Service (Injected Adapter: ApiDatabaseClient or WasmDatabaseClient)
  // ==========================================================================

  const dbService = window.DeeperDhammaDB ? new window.DeeperDhammaDB() : null;
  if (!dbService) {
    console.error('[App] No DeeperDhammaDB database client found. Ensure db_client.js is loaded.');
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  async function init() {
    setupEventListeners();
    setupAudioEngine();
    if (window.WordSync) {
      window.WordSync.init();
    }
    if (!dbService) return;
    try {
      await dbService.init();
      await Promise.all([
        loadArchiveStats(),
        loadBrowseCatalog(),
        ensurePaliTermsLoaded(),
      ]);
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

      if (els.statEpisodes) {
        els.statEpisodes.textContent = `${data.transcribed_episodes} transcribed talks • ${data.transcribed_hours} hrs indexed`;
      }

      // Populate filter dropdowns
      if (data.teachers) {
        data.teachers.forEach(t => {
          if (els.teacherFilter) {
            const opt1 = document.createElement('option');
            opt1.value = t;
            opt1.textContent = t;
            els.teacherFilter.appendChild(opt1);
          }
          if (els.browseTeacherFilter) {
            const opt2 = document.createElement('option');
            opt2.value = t;
            opt2.textContent = t;
            els.browseTeacherFilter.appendChild(opt2);
          }
        });
      }

      if (data.years) {
        data.years.forEach(y => {
          if (els.yearFilter) {
            const opt1 = document.createElement('option');
            opt1.value = y;
            opt1.textContent = y;
            els.yearFilter.appendChild(opt1);
          }
          if (els.browseYearFilter) {
            const opt2 = document.createElement('option');
            opt2.value = y;
            opt2.textContent = y;
            els.browseYearFilter.appendChild(opt2);
          }
        });
      }

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

  function setupDownloadDropdowns() {
    function closeAllDropdowns() {
      document.querySelectorAll('.download-dropdown-wrapper.open').forEach(w => {
        w.classList.remove('open');
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
            const pc = w.closest('.episode-card, .result-card');
            if (pc) pc.classList.remove('dropdown-active');
          }
        });

        const willOpen = !isOpen;
        wrapper.classList.toggle('open', willOpen);
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
          const pc = wrapper.closest('.episode-card, .result-card');
          if (pc) pc.classList.remove('dropdown-active');
        }

        if (wrapper && wrapper.id === 'filtered-archive-dropdown-wrapper') {
          const talks = state.currentFilteredTalks || [];
          compileAndDownloadArchive(talks, format, 'filtered_transcripts');
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
        if (els.sortOrderSelect) els.sortOrderSelect.value = 'date_desc';
        state.dateFilterMode = 'year';
        if (els.btnModeYear) els.btnModeYear.classList.add('active');
        if (els.btnModeRange) els.btnModeRange.classList.remove('active');
        if (els.yearFilter) els.yearFilter.style.display = 'inline-block';
        if (els.dateRangeInputs) els.dateRangeInputs.style.display = 'none';
        executeSearch('');
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

    if (els.browseTeacherFilter) {
      els.browseTeacherFilter.addEventListener('change', () => {
        loadBrowseCatalog();
      });
    }

    if (els.browseYearFilter) {
      els.browseYearFilter.addEventListener('change', () => {
        loadBrowseCatalog();
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
          executeSearch(query);
        }
      });
    }

    // Tabs
    els.tabSearchBtn.addEventListener('click', () => switchTab('search-view'));
    els.tabBrowseBtn.addEventListener('click', () => switchTab('browse-view'));
    els.tabLexiconBtn.addEventListener('click', () => switchTab('lexicon-view'));
    if (els.tabDocsBtn) {
      els.tabDocsBtn.addEventListener('click', () => switchTab('documents-view'));
    }
    if (els.tabTranscriptBtn) {
      els.tabTranscriptBtn.addEventListener('click', () => switchTab('transcript-view'));
    }

    if (els.transcriptBackBtn) {
      els.transcriptBackBtn.addEventListener('click', () => {
        switchTab(state.previousTab || 'search-view');
      });
    }

    const btnToggleWordSync = document.getElementById('btn-toggle-word-sync');
    if (btnToggleWordSync) {
      btnToggleWordSync.addEventListener('click', () => {
        if (window.WordSync) {
          const isEnabled = window.WordSync.toggle();
          if (isEnabled && !els.nativeAudio.paused) {
            window.WordSync.update(els.nativeAudio.currentTime);
          }
        }
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
            activeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      });
    }

    if (window.WordSync) {
      window.WordSync.onPaliTermSpoken = (key, termObj, options) => {
        handleSpokenPaliTerm(key, termObj, options);
      };
    }



    // Lexicon Search & Controls
    if (els.lexiconInput) {
      els.lexiconInput.addEventListener('input', () => {
        const term = els.lexiconInput.value.trim();
        clearTimeout(state.lexiconDebounceTimer);
        state.lexiconDebounceTimer = setTimeout(() => {
          if (!term) {
            if (els.lexCategoryBar) els.lexCategoryBar.style.display = 'flex';
            if (els.lexAlphabetBar && state.lexicon.mode === 'all') els.lexAlphabetBar.style.display = 'flex';
            loadLexiconView();
          } else {
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
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }
    if (els.btnLexPrev) {
      els.btnLexPrev.addEventListener('click', () => {
        if (state.lexicon.page > 1) {
          state.lexicon.page--;
          loadLexiconView();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }
    if (els.btnLexNext) {
      els.btnLexNext.addEventListener('click', () => {
        if (state.lexicon.page < state.lexicon.totalPages) {
          state.lexicon.page++;
          loadLexiconView();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }
    if (els.btnLexLast) {
      els.btnLexLast.addEventListener('click', () => {
        if (state.lexicon.page < state.lexicon.totalPages) {
          state.lexicon.page = state.lexicon.totalPages;
          loadLexiconView();
          window.scrollTo({ top: 0, behavior: 'smooth' });
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

    // Delegated clicks on lexicon cards (Find Talks & View Offline Document)
    if (els.lexiconResults) {
      els.lexiconResults.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-lexicon-talks');
        if (btn) {
          const term = btn.dataset.term;
          if (term) {
            switchTab('search-view');
            if (els.searchInput) {
              els.searchInput.value = term;
              executeSearch(term);
            }
          }
          return;
        }

        const docBtn = e.target.closest('.btn-lexicon-view-doc');
        if (docBtn) {
          const docId = docBtn.dataset.docId || 1;
          const term = docBtn.closest('.lexicon-card')?.querySelector('.pali-term')?.textContent || '';
          switchTab('documents-view');
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

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // 'Escape' clears doc filter or returns to previous view
      if (e.key === 'Escape') {
        if (state.activeTab === 'documents-view' && els.docFilterInput && els.docFilterInput.value) {
          els.docFilterInput.value = '';
          filterActiveDocument('');
          return;
        }
        if (state.activeTab === 'transcript-view') {
          switchTab(state.previousTab || 'search-view');
          return;
        }
      }
      // '/' to focus search
      if (e.key === '/' && document.activeElement !== els.searchInput && document.activeElement !== els.lexiconInput && document.activeElement !== els.docFilterInput) {
        e.preventDefault();
        els.searchInput.focus();
        els.searchInput.select();
      }
      // Space toggles audio (when not typing in an input)
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        togglePlayPause();
      }
    });
  }

  function switchTab(viewId) {
    state.activeTab = viewId;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === viewId);
    });
    document.querySelectorAll('.view-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === viewId);
    });
    if (viewId === 'browse-view' && (!state.catalog || state.catalog.length === 0)) {
      loadBrowseCatalog();
    }
    if (viewId === 'lexicon-view' && (!state.lexicon || !state.lexicon.loadedOnce)) {
      loadLexiconView();
    }
    if (viewId === 'documents-view') {
      loadDocumentInView(state.documents.activeDocId, state.documents.filterQuery);
    }
  }

  // ==========================================================================
  // Full-Text Search Execution
  // ==========================================================================

  async function executeSearch(query) {
    state.currentQuery = query;
    const teacherVal = (els.teacherFilter && els.teacherFilter.value) || '';
    const yearVal = (els.yearFilter && els.yearFilter.value) || '';
    const startDateVal = (els.startDateInput && els.startDateInput.value) || '';
    const endDateVal = (els.endDateInput && els.endDateInput.value) || '';
    const sortVal = (els.sortOrderSelect && els.sortOrderSelect.value) || 'date_desc';

    const hasFilters = Boolean(
      teacherVal ||
      (state.dateFilterMode === 'year' && yearVal) ||
      (state.dateFilterMode === 'range' && (startDateVal || endDateVal)) ||
      sortVal !== 'date_desc'
    );

    // If no text query and no filters, show empty state
    if (!query && !hasFilters) {
      els.searchEmptyState.style.display = 'block';
      els.searchResultsList.style.display = 'none';
      els.searchMetaBar.style.display = 'none';
      if (els.filteredArchiveDropdownWrapper) {
        els.filteredArchiveDropdownWrapper.style.display = 'none';
      }
      els.searchCountBadge.textContent = '0';
      state.currentFilteredTalks = [];
      if (els.filteredArchiveCount) els.filteredArchiveCount.textContent = '0';
      if (els.btnDownloadFilteredArchive) els.btnDownloadFilteredArchive.disabled = true;
      return;
    }

    // Make sure we are on search tab
    switchTab('search-view');

    // Case 1: Search query provided (FTS search)
    if (query) {
      const searchOpts = {
        limit: 500,
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

    // Case 2: No search query, but filters active (Browse by Filter)
    try {
      const filterOpts = {
        transcribedOnly: true,
        limit: 100,
        sort: sortVal,
      };
      if (teacherVal) filterOpts.teacher = teacherVal;
      if (state.dateFilterMode === 'year' && yearVal) filterOpts.year = yearVal;
      if (state.dateFilterMode === 'range') {
        if (startDateVal) filterOpts.startDate = startDateVal;
        if (endDateVal) filterOpts.endDate = endDateVal;
      }

      const data = await dbService.getEpisodes(filterOpts);
      renderFilterResults(data);
    } catch (err) {
      console.error('Filter search failed:', err);
    }
  }

  function renderFilterResults(data) {
    const episodes = data.episodes || [];
    state.currentFilteredTalks = episodes;

    els.searchEmptyState.style.display = 'none';
    els.searchResultsList.style.display = 'flex';
    els.searchMetaBar.style.display = 'flex';
    if (els.filteredArchiveDropdownWrapper) {
      els.filteredArchiveDropdownWrapper.style.display = 'inline-block';
    }
    els.searchCountBadge.textContent = String(episodes.length);

    els.queryTierBadge.textContent = 'Filtered Catalog';
    els.queryMetaText.textContent = `Showing ${episodes.length} talk${episodes.length === 1 ? '' : 's'} matching active filters`;

    if (els.filteredArchiveCount) els.filteredArchiveCount.textContent = String(episodes.length);
    if (els.btnDownloadFilteredArchive) els.btnDownloadFilteredArchive.disabled = episodes.length === 0;

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
              <span>📅 ${escapeHtml(ep.date || '')}</span>
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

  /**
   * Extracts sentence-level matches from a segment turn's full text,
   * preserving sentence index, word offset within the turn, and estimated word timestamp.
   */
  function extractSentenceMatchesFromSegment(segItem, query, effectiveQuery) {
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

    // Build regex terms from query and effectiveQuery
    const rawTerms = [];
    const sourceQ = `${query || ''} ${effectiveQuery || ''}`;
    const STOP_OPS = new Set(['and', 'or', 'not', 'near']);
    const parsedWords = sourceQ.match(/[a-zA-Z0-9]+/g) || [];
    parsedWords.forEach(w => {
      const lw = w.toLowerCase();
      if (!STOP_OPS.has(lw) && lw.length >= 2 && !/^\d+$/.test(lw)) {
        if (!rawTerms.includes(lw)) rawTerms.push(lw);
      }
    });

    // Also inspect any <b>...</b> highlighted words in snippet_text (handles Tier 4 fuzzy corrections)
    if (segItem.snippet_text) {
      const bMatches = segItem.snippet_text.match(/<b>([^<]+)<\/b>/gi) || [];
      bMatches.forEach(bm => {
        const cleanW = bm.replace(/<\/?b>/gi, '').trim().toLowerCase();
        if (cleanW && !rawTerms.includes(cleanW)) rawTerms.push(cleanW);
      });
    }

    // Sort longest first so multi-char stems don't get shadowed
    rawTerms.sort((a, b) => b.length - a.length);

    const escapedTerms = rawTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Match exact word or prefix stem
    const wordMatchRegex = escapedTerms.length > 0
      ? new RegExp(`\\b(${escapedTerms.join('|')})[a-zA-Z]*\\b`, 'gi')
      : null;

    // Split turn text into sentences using the same boundary rule as WordSync.formatTurnParagraphs
    let paragraphs = [];
    if (rawText.includes('\n\n')) {
      paragraphs = rawText
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
    } else {
      const rawSentences = rawText.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [rawText];
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
      const sents = pText.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [pText];
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
    const matchedSentences = [];

    allSentences.forEach(sObj => {
      if (!sObj.text) return;
      let firstMatchedWordIdx = -1;

      if (wordMatchRegex) {
        for (const wEntry of sObj.words) {
          wordMatchRegex.lastIndex = 0;
          if (wordMatchRegex.test(wEntry.token)) {
            firstMatchedWordIdx = wEntry.wordIdxInTurn;
            break;
          }
        }
      }

      if (firstMatchedWordIdx >= 0) {
        const escapedSent = escapeHtml(sObj.text);
        const highlightedHtml = wordMatchRegex
          ? escapedSent.replace(wordMatchRegex, '<b>$&</b>')
          : escapedSent;

        const wordRatio = firstMatchedWordIdx / totalTurnWords;
        const estWordSec = startSec + wordRatio * turnDur;

        matchedSentences.push({
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
        });
      }
    });

    // Fallback if FTS matched the turn (e.g. speaker name or stem) but regex didn't catch a sentence
    if (matchedSentences.length === 0 && allSentences.length > 0) {
      const firstS = allSentences[0];
      matchedSentences.push({
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
      });
    }

    return matchedSentences;
  }

  function renderSearchResults(data) {
    const { results, count, meta, elapsed_ms, query } = data;
    const effectiveQuery = (meta && meta.effective_query) || query || '';

    // Group matching segments & extracted sentences by transcript (episode_id)
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
          teacher: r.teacher,
          teacher_slug: r.teacher_slug,
          identified_teachers: r.identified_teachers,
          media_url: r.media_url,
          permalink: r.permalink,
          duration_sec: r.duration_sec,
          matches: [],
        };
        episodeGroupsMap.set(epId, group);
        episodeGroups.push(group);
      }

      const sentMatches = extractSentenceMatchesFromSegment(r, query, effectiveQuery);
      sentMatches.forEach(m => {
        group.matches.push(m);
        totalSentenceMatches++;
      });
    });

    // Sort matches chronologically within each transcript card so the listener sees them in talk order
    episodeGroups.forEach(group => {
      group.matches.sort((a, b) => (a.turn_index - b.turn_index) || (a.word_offset_in_turn - b.word_offset_in_turn));
    });

    // Sort transcript cards according to user's selected sort order
    const sortVal = (els.sortOrderSelect && els.sortOrderSelect.value) || 'date_desc';
    if (sortVal === 'date_asc') {
      episodeGroups.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id));
    } else if (sortVal === 'date_desc') {
      episodeGroups.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));
    } else if (sortVal === 'duration_desc') {
      episodeGroups.sort((a, b) => (b.duration_sec || 0) - (a.duration_sec || 0));
    } else if (sortVal === 'rank') {
      episodeGroups.sort((a, b) => b.matches.length - a.matches.length);
    }

    state.currentFilteredTalks = episodeGroups;
    state.currentSearchGroups = episodeGroups;

    els.searchEmptyState.style.display = 'none';
    els.searchResultsList.style.display = 'flex';
    els.searchMetaBar.style.display = 'flex';
    if (els.filteredArchiveDropdownWrapper) {
      els.filteredArchiveDropdownWrapper.style.display = 'inline-block';
    }
    els.searchCountBadge.textContent = String(totalSentenceMatches);

    if (els.filteredArchiveCount) els.filteredArchiveCount.textContent = String(episodeGroups.length);
    if (els.btnDownloadFilteredArchive) els.btnDownloadFilteredArchive.disabled = episodeGroups.length === 0;

    // Meta bar
    const tierDisplay = formatTierName(meta ? meta.tier : 'none');
    els.queryTierBadge.textContent = tierDisplay;
    let metaMsg = `Found ${totalSentenceMatches} match${totalSentenceMatches === 1 ? '' : 'es'} across ${episodeGroups.length} talk${episodeGroups.length === 1 ? '' : 's'} in ${elapsed_ms}ms`;
    if (meta && meta.corrected && meta.effective_query) {
      metaMsg += ` (auto-corrected to "${meta.effective_query}")`;
    }
    els.queryMetaText.textContent = metaMsg;

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
                <span>📅 ${escapeHtml(group.date || '')}</span>
                ${durMin > 0 ? `<span>• ⏱️ ${durMin} mins</span>` : ''}
              </div>
            </div>

            <div class="result-header-badges">
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
  // Browse Catalog View
  // ==========================================================================

  async function loadBrowseCatalog() {
    const teacherVal = (els.browseTeacherFilter && els.browseTeacherFilter.value) || (els.teacherFilter && els.teacherFilter.value) || '';
    const yearVal = (els.browseYearFilter && els.browseYearFilter.value) || (els.yearFilter && els.yearFilter.value) || '';
    const opts = {
      transcribedOnly: !teacherVal,
      limit: 60,
    };
    if (teacherVal) opts.teacher = teacherVal;
    if (yearVal) opts.year = yearVal;

    try {
      const data = await dbService.getEpisodes(opts);
      state.catalog = data.episodes || [];

      els.browseCountBadge.textContent = String(data.total || data.episodes.length);

      if (!data.episodes || data.episodes.length === 0) {
        els.browseGrid.innerHTML = `
          <div class="empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">📂</div>
            <h3>No transcribed episodes match the selected filter</h3>
          </div>
        `;
        return;
      }

      let html = '';
      data.episodes.forEach(ep => {
        const durMin = Math.round((ep.duration_sec || 0) / 60);
        html += `
          <div class="episode-card">
            <div>
              <div class="result-meta-line" style="margin-bottom: 0.5rem;">
                ${renderTeacherBadgesHtml(ep)}
                <span>📅 ${escapeHtml(ep.date || '')}</span>
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

      els.browseGrid.innerHTML = html;
      attachCardEventListeners(els.browseGrid, data.episodes);
    } catch (err) {
      console.error('Failed to load browse catalog:', err);
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
      sourceHtml += ` <button type="button" class="btn-lexicon-view-doc" data-doc-id="${escapeHtml(String(item.source_document_id))}" title="Read offline reference document in viewer">📜 View Offline Document</button>`;
    }

    return `
      <div class="lexicon-card">
        <div class="lexicon-term-title">
          <span class="pali-term">${escapeHtml(item.pali_plain)}</span>
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
        <div class="lexicon-actions">
          <button type="button" class="btn-lexicon-talks" data-term="${escapeHtml(item.pali_plain)}" title="Search transcripts for this Pali term">
            🔍 Find Talks Mentioning "${escapeHtml(item.pali_plain)}"
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

  async function loadDocumentInView(docId = 1, filterTerm = '') {
    state.documents.activeDocId = parseInt(docId, 10) || 1;

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
        els.docFilterInput.value = filterTerm || '';
        filterActiveDocument(filterTerm || '');
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

  function filterActiveDocument(query) {
    const rawQ = (query || '').trim().toLowerCase();
    const q = normalizePaliSearch(rawQ);
    state.documents.filterQuery = rawQ;

    if (els.clearDocFilterBtn) {
      els.clearDocFilterBtn.style.display = rawQ ? 'inline-block' : 'none';
    }

    const tableRows = els.docRenderedBody ? els.docRenderedBody.querySelectorAll('.doc-table-data-row') : [];
    if (tableRows.length > 0) {
      let visibleCount = 0;
      tableRows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const normText = normalizePaliSearch(text);
        const matches = !q || text.includes(rawQ) || normText.includes(q);
        row.classList.toggle('doc-row-hidden', !matches);
        if (matches) visibleCount++;
      });
      if (els.docFilterCount) {
        els.docFilterCount.textContent = rawQ 
          ? `Showing ${visibleCount.toLocaleString()} of ${tableRows.length.toLocaleString()} terms`
          : `${tableRows.length.toLocaleString()} terms`;
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
          activeCard.scrollIntoView({ behavior: 'auto', block: 'nearest' });
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
    switchTab('lexicon-view');
    if (els.lexiconInput) {
      els.lexiconInput.value = termKey;
    }
    if (els.lexAlphabetBar) els.lexAlphabetBar.style.display = 'none';
    if (els.lexPagination) els.lexPagination.style.display = 'none';
    if (els.lexCountText) els.lexCountText.textContent = `Search results for "${termKey}"`;
    executeLexiconSearch(termKey);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    const detailsBtn = `<button type="button" class="lex-card-link-btn" title="View full lexicon entry for ${paliTitle}">Lexicon ↗</button>`;

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

    // Clicking Lexicon link opens full entry in Lexicon view
    const lBtn = card.querySelector('.lex-card-link-btn');
    if (lBtn) {
      lBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFullLexiconEntry(term.pali_plain || term.pali_diacritic);
      });
    }

    // Clicking anywhere else on card seeks audio and scrolls transcript to word
    card.addEventListener('click', () => {
      jumpToCompanionTerm(idx);
    });

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
        english_description: termData.english_description,
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

    // 2. Scroll transcript smoothly to spoken word or turn
    let scrollTarget = null;
    if (term.wordId) {
      scrollTarget = document.getElementById(term.wordId);
    }
    if (!scrollTarget) {
      scrollTarget = document.getElementById(`turn-${term.turnIdx}`);
    }

    if (scrollTarget) {
      scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    // 3. Highlight this card in companion
    setActiveCompanionTerm(idx, { scrollCompanion: true });
  }

  function setActiveCompanionTerm(idx, options = {}) {
    const terms = state.lexCompanion.allTerms;
    if (!terms || !terms[idx]) return;
    state.lexCompanion.currentActiveIdx = idx;
    const term = terms[idx];

    // 1. Update card highlights and keep in rolling 5-term view
    if (els.lexiconStack) {
      const cards = els.lexiconStack.querySelectorAll('.lex-stack-card');
      cards.forEach(c => {
        const cardIdx = parseInt(c.dataset.idx, 10);
        if (cardIdx === idx) {
          c.classList.add('current-companion-term');
          if (options.scrollCompanion !== false) {
            c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  async function openTranscriptDrawer(episodeId, targetOpts = null) {
    resetLexCompanion();
    if (state.activeTab !== 'transcript-view') {
      state.previousTab = state.activeTab;
    }
    if (els.tabTranscriptBtn) {
      els.tabTranscriptBtn.style.display = 'inline-flex';
    }
    switchTab('transcript-view');
    if (!targetOpts) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    els.drawerTurns.innerHTML = '<div class="loading-spinner">Loading transcript turns...</div>';

    try {
      const ep = await dbService.getEpisode(episodeId);
      if (!ep) {
        els.drawerTurns.innerHTML = '<div class="empty-state"><p>Episode details could not be loaded.</p></div>';
        return;
      }
      state.currentEpisode = ep;

      els.drawerTitle.textContent = ep.title;
      els.drawerDateTag.textContent = ep.date || `Year ${ep.year}`;
      const durMin = Math.round((ep.duration_sec || 0) / 60);
      els.drawerMetaInfo.innerHTML = `
        ${renderTeacherBadgesHtml(ep)}
        <span class="bullet-sep">•</span>
        <span>${durMin} mins</span>
        <span class="bullet-sep">•</span>
        <span>${ep.segments ? ep.segments.length : 0} speech turns</span>
      `;

      if (ep.permalink) {
        els.drawerPodbeanLink.href = getPodbeanUrl(ep.permalink);
        els.drawerPodbeanLink.style.display = 'inline-flex';
      } else {
        els.drawerPodbeanLink.style.display = 'none';
      }

      els.drawerPlayFullBtn.onclick = () => {
        playAudioSegment({
          episode_id: ep.id,
          media_url: ep.media_url,
          title: ep.title,
          teacher: ep.primary_display,
          start_sec: 0,
        });
      };

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
                <button type="button" class="turn-time-btn" data-start="${seg.start_sec}" title="Seek audio to this turn">
                  ▶ ${startStr}
                </button>
              </div>
              <div class="turn-text">${formattedText}</div>
            </div>
          `;
        });

        els.drawerTurns.innerHTML = html;

        // Click on any timestamp in drawer seeks audio!
        els.drawerTurns.querySelectorAll('.turn-time-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const start = parseFloat(btn.dataset.start);
            playAudioSegment({
              episode_id: ep.id,
              media_url: ep.media_url,
              title: ep.title,
              teacher: ep.primary_display,
              start_sec: start,
            });
          });
        });

        // Click on any word in drawer seeks audio to that exact second!
        els.drawerTurns.querySelectorAll('.transcript-word').forEach(wSpan => {
          wSpan.addEventListener('click', (e) => {
            e.stopPropagation();
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
          });
        });

        // Click on any un-timed Pali term in sentence fallback mode
        els.drawerTurns.querySelectorAll('.pali-term:not(.transcript-word)').forEach(pSpan => {
          pSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            if (pSpan.dataset.pali) {
              handleSpokenPaliTerm(pSpan.dataset.pali, null, { userClicked: true });
            }
          });
        });
      }

      window.renderActiveTranscript = renderDrawerTurns;

      await ensurePaliTermsLoaded();

      if (window.WordSync) {
        await window.WordSync.prepareEpisode(ep);
      }

      renderDrawerTurns();
      buildCompanionTermsList();
      if (els.nativeAudio && els.nativeAudio.currentTime > 0) {
        const rawCur = els.nativeAudio.currentTime;
        const physCur = window.WordSync ? window.WordSync.getPhysicalTime(rawCur) : rawCur;
        updateActiveCompanionTerm(physCur);
      }

      // If opened from a sentence context match, scroll to that sentence/word and start audio at exact word time!
      if (targetOpts && typeof targetOpts.turnIndex === 'number') {
        const tIdx = targetOpts.turnIndex;
        const sIdx = typeof targetOpts.sentIdxInTurn === 'number' ? targetOpts.sentIdxInTurn : 0;
        const wOffset = typeof targetOpts.wordOffsetInTurn === 'number' ? targetOpts.wordOffsetInTurn : 0;

        let exactWordSec = typeof targetOpts.fallbackSec === 'number' ? targetOpts.fallbackSec : 0;
        let targetWordEl = null;

        // 1. Resolve exact word timestamp and DOM element from WordSync turnWordMap if available
        if (window.WordSync && window.WordSync.turnWordMap && window.WordSync.turnWordMap[tIdx]) {
          const turnWords = window.WordSync.turnWordMap[tIdx];
          if (turnWords.length > 0) {
            const clampedIdx = Math.max(0, Math.min(turnWords.length - 1, wOffset));
            const matchedW = turnWords[clampedIdx];
            if (matchedW && typeof matchedW.s === 'number') {
              exactWordSec = matchedW.s;
              targetWordEl = document.getElementById(matchedW.id);
            }
          }
        }

        // 2. Locate target sentence element and turn element for smooth scrolling & highlight
        const sentEl = document.getElementById(`turn-${tIdx}-sent-${sIdx}`);
        const turnEl = document.getElementById(`turn-${tIdx}`);
        const scrollTarget = sentEl || targetWordEl || turnEl;

        if (scrollTarget) {
          requestAnimationFrame(() => {
            scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

        if (targetOpts.autoPlay !== false && ep.media_url) {
          playAudioSegment({
            episode_id: ep.id,
            media_url: ep.media_url,
            title: ep.title,
            teacher: ep.primary_display,
            start_sec: exactWordSec,
          });
        }
      }
    } catch (err) {
      els.drawerTurns.innerHTML = '<div class="empty-state"><p>Failed to load transcript.</p></div>';
      console.error(err);
    }
  }

  // ==========================================================================
  // Audio Player Engine (Cross-Browser VBR Neutralized & Podbean CDN Streaming)
  // ==========================================================================

  function setupAudioEngine() {
    const audio = els.nativeAudio;
    let isScrubbing = false;
    let scrubCommitted = false;

    function updatePlayerHeight() {
      if (els.playerBar) {
        const h = els.playerBar.offsetHeight || 78;
        document.documentElement.style.setProperty('--player-height', `${h}px`);
      }
    }
    updatePlayerHeight();
    window.addEventListener('resize', updatePlayerHeight, { passive: true });
    if (typeof ResizeObserver !== 'undefined' && els.playerBar) {
      const ro = new ResizeObserver(() => updatePlayerHeight());
      ro.observe(els.playerBar);
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
      const rawCur = audio.currentTime;
      const physCur = window.WordSync ? window.WordSync.getPhysicalTime(rawCur) : rawCur;
      const dur = getTotalDuration();
      els.timeCurrent.textContent = formatSeconds(physCur);
      if (dur > 0) {
        els.timeTotal.textContent = formatSeconds(dur);
        els.scrubber.value = Math.min(100, Math.max(0, (physCur / dur) * 100));
      }
      if (state.activeTab === 'transcript-view') {
        if (window.WordSync) {
          window.WordSync.update(rawCur);
        }
        updateActiveCompanionTerm(physCur);
      }
    }

    ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked'].forEach(evt => {
      audio.addEventListener(evt, syncProgress);
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

    // Speed selector
    els.speedBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        audio.playbackRate = speed;
        state.playbackSpeed = speed;
        els.speedBtns.forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    // Volume handling
    function updateVolumeIcon(vol) {
      if (!els.volIcon) return;
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

    let lastVolume = 1.0;
    if (els.volToggleBtn) {
      els.volToggleBtn.addEventListener('click', () => {
        if (audio.volume > 0) {
          lastVolume = audio.volume;
          audio.volume = 0;
          els.volumeSlider.value = 0;
        } else {
          audio.volume = lastVolume > 0 ? lastVolume : 1.0;
          els.volumeSlider.value = audio.volume;
        }
        updateVolumeIcon(audio.volume);
      });
    }

    els.volumeSlider.addEventListener('input', () => {
      audio.volume = parseFloat(els.volumeSlider.value);
      updateVolumeIcon(audio.volume);
    });

    if (window.WordSync) {
      window.WordSync.bindAudio(audio);
    }
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

    // Apply exactly 500ms lead time to first word for any/all seek ref points (clamped to 0)
    const rawTarget = typeof start_sec === 'number' ? start_sec : parseFloat(start_sec || 0);
    const targetTime = Math.max(0, rawTarget > 0 ? (rawTarget - SEEK_REF_LEAD_TIME_SEC) : 0);

    function performSeek(physSec, wordStartSec) {
      if (physSec < 0) return;
      const doSeek = () => {
        try {
          const streamSeekTime = window.WordSync
            ? window.WordSync.prepareSeek(physSec, wordStartSec)
            : physSec;
          audio.currentTime = streamSeekTime;
          if (window.WordSync && state.activeTab === 'transcript-view') {
            window.WordSync.update(streamSeekTime);
          }
        } catch (e) {
          console.warn('Seek error:', e);
        }
      };
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

      if (isDifferentSource) {
        audio.src = streamUrl;
        audio.playbackRate = state.playbackSpeed;
        if (targetTime > 0) {
          performSeek(targetTime, rawTarget);
        } else if (window.WordSync) {
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
      if (state.currentEpisode && state.currentEpisode.media_url) {
        playAudioSegment({
          episode_id: state.currentEpisode.id || state.currentEpisode.episode_id,
          media_url: state.currentEpisode.media_url,
          title: state.currentEpisode.title,
          teacher: state.currentEpisode.primary_display || state.currentEpisode.teacher,
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
    const rawSentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [trimmed];
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
      if (window.indexedDB && window.indexedDB.databases) {
        const dbs = await window.indexedDB.databases();
        for (const db of dbs) {
          if (db.name && db.name.includes('dhamma')) {
            window.indexedDB.deleteDatabase(db.name);
          }
        }
      } else {
        window.indexedDB.deleteDatabase('dhamma_web_v1');
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
