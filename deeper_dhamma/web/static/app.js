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

    // Transcript View Elements
    transcriptBackBtn: document.getElementById('transcript-back-btn'),
    drawerTitle: document.getElementById('drawer-episode-title'),
    drawerDateTag: document.getElementById('drawer-date-tag'),
    drawerMetaInfo: document.getElementById('drawer-meta-info'),
    drawerPlayFullBtn: document.getElementById('drawer-play-full-btn'),
    drawerPodbeanLink: document.getElementById('drawer-podbean-link'),
    drawerTurns: document.getElementById('drawer-turns-container'),

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



    // Lexicon Search
    if (els.lexiconInput) {
      els.lexiconInput.addEventListener('input', () => {
        const term = els.lexiconInput.value.trim();
        clearTimeout(state.lexiconDebounceTimer);
        state.lexiconDebounceTimer = setTimeout(() => {
          executeLexiconSearch(term);
        }, 250);
      });
    }

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // '/' to focus search
      if (e.key === '/' && document.activeElement !== els.searchInput && document.activeElement !== els.lexiconInput) {
        e.preventDefault();
        els.searchInput.focus();
        els.searchInput.select();
      }
      // 'Escape' returns to previous view
      if (e.key === 'Escape' && state.activeTab === 'transcript-view') {
        switchTab(state.previousTab || 'search-view');
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
        limit: 50,
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

  function renderSearchResults(data) {
    const { results, count, meta, elapsed_ms, query } = data;

    // Extract distinct episodes for archive export
    const distinctEpisodes = [];
    const seenIds = new Set();
    results.forEach(r => {
      if (r.episode_id && !seenIds.has(r.episode_id)) {
        seenIds.add(r.episode_id);
        distinctEpisodes.push({
          id: r.episode_id,
          title: r.title,
          date: r.date,
          teacher: r.teacher,
          media_url: r.media_url,
          duration_sec: r.duration_sec,
        });
      }
    });

    state.currentFilteredTalks = distinctEpisodes;

    els.searchEmptyState.style.display = 'none';
    els.searchResultsList.style.display = 'flex';
    els.searchMetaBar.style.display = 'flex';
    if (els.filteredArchiveDropdownWrapper) {
      els.filteredArchiveDropdownWrapper.style.display = 'inline-block';
    }
    els.searchCountBadge.textContent = String(count);

    if (els.filteredArchiveCount) els.filteredArchiveCount.textContent = String(distinctEpisodes.length);
    if (els.btnDownloadFilteredArchive) els.btnDownloadFilteredArchive.disabled = distinctEpisodes.length === 0;

    // Meta bar
    const tierDisplay = formatTierName(meta ? meta.tier : 'none');
    els.queryTierBadge.textContent = tierDisplay;
    els.queryMetaText.textContent = `Found ${count} matching segment${count === 1 ? '' : 's'} across ${distinctEpisodes.length} talk${distinctEpisodes.length === 1 ? '' : 's'} in ${elapsed_ms}ms`;

    if (count === 0) {
      els.searchResultsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <h2>No matching segments found</h2>
          <p>Try broadening your query, unchecking "Exact Phrase Only", or searching for key doctrinal words like <i>hindrances</i>, <i>breath</i>, or <i>samadhi</i>.</p>
        </div>
      `;
      return;
    }

    let html = '';
    results.forEach((item, idx) => {
      const startTime = formatSeconds(item.start_sec);
      const endTime = formatSeconds(item.end_sec);
      const duration = formatSeconds(item.end_sec - item.start_sec);
      const spkColor = getSpeakerColor(item.speaker_slug || item.teacher_slug, item.teacher || item.speaker_display);

      html += `
        <article class="result-card" data-idx="${idx}">
          <div class="result-header">
            <div class="result-title-group">
              <h3 class="result-title">${escapeHtml(item.title)}</h3>
              <div class="result-meta-line">
                ${renderTeacherBadgesHtml(item)}
                <span>📅 ${escapeHtml(item.date || '')}</span>
                <span>⏱️ Turn at ${startTime}</span>
              </div>
            </div>

            <button type="button" class="play-timestamp-btn" data-action="play-result" data-idx="${idx}" title="Stream from this turn on Podbean CDN">
              ▶ Play (${startTime})
            </button>
          </div>

          <div class="result-snippet">
            ${item.snippet_text}
          </div>

          <div class="result-actions">
            <button type="button" class="link-btn" data-action="view-transcript" data-episode-id="${escapeHtml(item.episode_id)}">
              📜 View Full Transcript
            </button>
            <div class="download-dropdown-wrapper">
              <button type="button" class="btn-secondary download-dropdown-btn" data-action="toggle-card-download" title="Download transcript">
                📥 Download ▾
              </button>
              <div class="download-dropdown-menu">
                <div class="dropdown-menu-header">Export Transcript</div>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(item.episode_id)}" data-format="md">
                  <span class="download-opt-icon">📝</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Markdown</span>
                    <span class="download-opt-desc">Formatted notes (.md)</span>
                  </div>
                  <span class="download-opt-badge">.md</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(item.episode_id)}" data-format="txt">
                  <span class="download-opt-icon">📄</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">Plain Text</span>
                    <span class="download-opt-desc">Clean transcript text (.txt)</span>
                  </div>
                  <span class="download-opt-badge">.txt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(item.episode_id)}" data-format="srt">
                  <span class="download-opt-icon">🎬</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">SubRip Subtitles</span>
                    <span class="download-opt-desc">For VLC / media players (.srt)</span>
                  </div>
                  <span class="download-opt-badge">.srt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(item.episode_id)}" data-format="vtt">
                  <span class="download-opt-icon">🌐</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">WebVTT Captions</span>
                    <span class="download-opt-desc">Web caption track (.vtt)</span>
                  </div>
                  <span class="download-opt-badge">.vtt</span>
                </button>
                <button type="button" class="download-option" data-action="download-card-format" data-ep-id="${escapeHtml(item.episode_id)}" data-format="json">
                  <span class="download-opt-icon">📊</span>
                  <div class="download-opt-text">
                    <span class="download-opt-title">JSON Data</span>
                    <span class="download-opt-desc">Structured turn array (.json)</span>
                  </div>
                  <span class="download-opt-badge">.json</span>
                </button>
              </div>
            </div>
            ${item.permalink ? `
              <a href="${getPodbeanUrl(item.permalink)}" target="_blank" rel="noopener noreferrer" class="external-link">
                ↗ Podbean Page
              </a>
            ` : ''}
          </div>
        </article>
      `;
    });

    els.searchResultsList.innerHTML = html;

    // Attach click events on results list
    els.searchResultsList.querySelectorAll('[data-action="play-result"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(btn.dataset.idx, 10);
        const item = results[idx];
        if (item) {
          playAudioSegment({
            episode_id: item.episode_id,
            media_url: item.media_url,
            title: item.title,
            teacher: item.teacher,
            start_sec: item.start_sec,
          });
        }
      });
    });

    els.searchResultsList.querySelectorAll('[data-action="view-transcript"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const epId = btn.dataset.episodeId;
        openTranscriptDrawer(epId);
      });
    });
  }

  function formatTierName(tier) {
    switch (tier) {
      case 'explicit': return 'Explicit Syntax';
      case 'exact_phrase': return 'Tier 1: Exact Phrase';
      case 'exact_word': return 'Tier 1: Exact Word';
      case 'proximity': return 'Tier 2: Proximity Match (NEAR)';
      case 'prefix': return 'Tier 3: Prefix Stemming';
      case 'fuzzy': return 'Tier 4: Auto-Corrected';
      case 'bm25_any': return 'Tier 5: Ranked Match';
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

  async function executeLexiconSearch(term) {
    if (!term) {
      els.lexiconResults.innerHTML = '<div class="empty-state-subtle">Enter a Buddhist term above to view canonical definitions and phonetic rules.</div>';
      return;
    }

    try {
      // Direct lookup
      const lookupData = await dbService.lookupLexicon(term);

      // Contextual search
      const searchResults = await dbService.searchLexicon(term, 10);

      let entries = [];
      if (lookupData.found && lookupData.data) {
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
        els.lexiconResults.innerHTML = `
          <div class="empty-state" style="padding: 2rem;">
            <p>No lexicon entry found for "${escapeHtml(term)}".</p>
          </div>
        `;
        return;
      }

      let html = '';
      entries.forEach(item => {
        const diacritic = item.pali_diacritic ? `(${escapeHtml(item.pali_diacritic)})` : '';
        const english = item.english_description || item.english_translation || item.preferred_translation || '';
        
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

        const notes = item.context_keywords || item.doctrinal_notes || '';
        const source = item.source_title ? `${item.source_title}${item.source_author ? ' — ' + item.source_author : ''}` : (item.source || 'SuttaCentral / Bodhinyana Reference');

        html += `
          <div class="lexicon-card">
            <div class="lexicon-term-title">
              <span class="pali-term">${escapeHtml(item.pali_plain)}</span>
              <span class="lexicon-diacritic">${diacritic}</span>
              ${item.category ? `<span class="category-badge">${escapeHtml(item.category.replace(/_/g, ' '))}</span>` : ''}
            </div>
            ${english ? `
              <div class="lexicon-meaning">
                <strong>Doctrinal Definition:</strong> ${escapeHtml(english)}
              </div>
            ` : ''}
            ${teacherGloss.length > 0 ? `
              <div class="lexicon-teacher-glosses">
                <div class="glosses-title">Teacher Translations:</div>
                ${teacherGloss.join('')}
              </div>
            ` : ''}
            ${notes ? `<div class="lexicon-meta"><strong>Context / Keywords:</strong> ${escapeHtml(notes)}</div>` : ''}
            <div class="lexicon-meta"><strong>Authority Source:</strong> ${escapeHtml(source)}</div>
          </div>
        `;
      });

      els.lexiconResults.innerHTML = html;
    } catch (err) {
      console.error('Lexicon search failed:', err);
    }
  }

  // ==========================================================================
  // Transcript Drawer / Modal
  // ==========================================================================

  async function openTranscriptDrawer(episodeId) {
    if (state.activeTab !== 'transcript-view') {
      state.previousTab = state.activeTab;
    }
    if (els.tabTranscriptBtn) {
      els.tabTranscriptBtn.style.display = 'inline-flex';
    }
    switchTab('transcript-view');
    window.scrollTo({ top: 0, behavior: 'smooth' });

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
          const startStr = formatSeconds(seg.start_sec);
          const formattedText = window.WordSync
            ? window.WordSync.formatTurnParagraphs(seg.text, idx)
            : formatTranscriptParagraphs(seg.text);
          const spkColor = getSpeakerColor(seg.speaker_slug, seg.speaker_display);
          const initials = getSpeakerInitials(seg.speaker_display || 'Speaker');
          html += `
            <div class="transcript-turn" id="turn-${idx}" data-start="${seg.start_sec}" style="--spk-color: ${spkColor};">
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
          });
        });
      }

      window.renderActiveTranscript = renderDrawerTurns;

      if (window.WordSync) {
        await window.WordSync.prepareEpisode(ep);
      }

      renderDrawerTurns();
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

    function safeSeek(targetPhysicalTime) {
      const dur = Number.isFinite(audio.duration) ? audio.duration : Infinity;
      const clampedPhys = Math.max(0, Math.min(dur, targetPhysicalTime));
      const doSeek = () => {
        try {
          const streamSeek = window.WordSync
            ? window.WordSync.prepareSeek(clampedPhys)
            : clampedPhys;
          audio.currentTime = Math.max(0, Math.min(dur, streamSeek));
        } catch (err) {
          console.warn('Seek error:', err);
        }
      };
      // HAVE_METADATA (1) is enough to seek a remote stream; waiting for
      // HAVE_CURRENT_DATA (2) drops seeks while buffering.
      if (audio.readyState >= 1) {
        doSeek();
      } else {
        audio.addEventListener('canplay', doSeek, { once: true });
        audio.addEventListener('loadeddata', doSeek, { once: true });
      }
    }

    function syncProgress() {
      if (isScrubbing) return; // Do not overwrite slider while user is dragging
      const rawCur = audio.currentTime;
      const physCur = window.WordSync ? window.WordSync.getPhysicalTime(rawCur) : rawCur;
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      els.timeCurrent.textContent = formatSeconds(physCur);
      if (dur > 0) {
        els.timeTotal.textContent = formatSeconds(dur);
        els.scrubber.value = Math.min(100, Math.max(0, (physCur / dur) * 100));
      }
      if (window.WordSync && state.activeTab === 'transcript-view') {
        window.WordSync.update(rawCur);
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
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (dur > 0) {
        const previewTime = (parseFloat(els.scrubber.value) / 100) * dur;
        els.timeCurrent.textContent = formatSeconds(previewTime);
      }
    });

    const commitScrub = () => {
      if (!isScrubbing || scrubCommitted) return; // change + mouseup both fire; seek once
      scrubCommitted = true;
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
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
    const useLocalAudioRoute = Boolean(
      epId &&
      window.location.protocol !== 'file:' &&
      !state.localAudioRouteUnavailable
    );
    const desiredSrcUrl = useLocalAudioRoute
      ? `/audio/${encodeURIComponent(epId)}.mp3`
      : media_url;

    if (window.WordSync) {
      window.WordSync.streamMode = useLocalAudioRoute ? 'local' : 'cdn';
    }

    const isDifferentSource = state.currentMediaUrl !== media_url || state.currentStreamUrl !== desiredSrcUrl;
    state.currentMediaUrl = media_url;
    state.currentStreamUrl = desiredSrcUrl;

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
        audio.addEventListener('loadedmetadata', doSeek, { once: true });
        audio.addEventListener('canplay', doSeek, { once: true });
        audio.addEventListener('loadeddata', doSeek, { once: true });
      }
    }

    // If WordSync has not loaded this episode's VBR profile yet (e.g. playing from Search tab),
    // asynchronously load it and refine the seek position as soon as it arrives.
    if (window.WordSync && epId && window.WordSync.currentEpisodeId !== epId) {
      window.WordSync.ensureEpisodeLoaded(epId).then(() => {
        if (state.currentMediaUrl === media_url && targetTime > 0) {
          performSeek(targetTime, rawTarget);
        }
      });
    }

    if (isDifferentSource) {
      audio.src = desiredSrcUrl;
      audio.playbackRate = state.playbackSpeed;

      if (useLocalAudioRoute) {
        const onLocalStreamError = () => {
          if (state.currentStreamUrl === desiredSrcUrl && media_url) {
            state.localAudioRouteUnavailable = true;
            state.currentStreamUrl = media_url;
            if (window.WordSync) window.WordSync.streamMode = 'cdn';
            audio.src = media_url;
            audio.playbackRate = state.playbackSpeed;
            if (targetTime > 0) {
              performSeek(targetTime, rawTarget);
            }
            audio.play().catch(() => {});
          }
        };
        audio.addEventListener('error', onLocalStreamError, { once: true });
      }

      if (targetTime > 0) {
        performSeek(targetTime, rawTarget);
      } else if (window.WordSync) {
        window.WordSync.prepareSeek(0, 0);
      }

      // Call audio.play() synchronously directly inside the user gesture
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          console.warn('Playback gesture error:', e);
        });
      }
    } else {
      performSeek(targetTime, rawTarget);
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => console.warn('Play error:', e));
      }
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
