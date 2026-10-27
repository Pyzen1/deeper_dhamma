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
    } catch (err) {
      console.error('Failed to load archive stats:', err);
    }
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

    if (!query) {
      els.searchEmptyState.style.display = 'block';
      els.searchResultsList.style.display = 'none';
      els.searchMetaBar.style.display = 'none';
      els.searchCountBadge.textContent = '0';
      return;
    }

    // Make sure we are on search tab
    switchTab('search-view');

    const searchOpts = {
      limit: 40,
      exact: els.exactCheckbox.checked,
    };

    if (els.teacherFilter.value) searchOpts.teacher = els.teacherFilter.value;
    if (els.yearFilter.value) searchOpts.year = els.yearFilter.value;

    try {
      const data = await dbService.search(query, searchOpts);
      renderSearchResults(data);
    } catch (err) {
      console.error('Search failed:', err);
    }
  }

  function renderSearchResults(data) {
    const { results, count, meta, elapsed_ms, query } = data;

    els.searchEmptyState.style.display = 'none';
    els.searchResultsList.style.display = 'flex';
    els.searchMetaBar.style.display = 'flex';
    els.searchCountBadge.textContent = String(count);

    // Meta bar
    const tierDisplay = formatTierName(meta ? meta.tier : 'none');
    els.queryTierBadge.textContent = tierDisplay;
    els.queryMetaText.textContent = `Found ${count} matching speech segment${count === 1 ? '' : 's'} for "${escapeHtml(query)}" in ${elapsed_ms}ms`;

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
                <span>${escapeHtml(ep.date || '')}</span>
                <span>• ${durMin} mins</span>
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

      // Event listeners on cards
      els.browseGrid.querySelectorAll('[data-action="play-ep-start"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const epId = btn.dataset.epId;
          const ep = data.episodes.find(e => e.id === epId);
          if (ep) {
            playAudioSegment({
              media_url: ep.media_url,
              title: ep.title,
              teacher: ep.teacher,
              start_sec: 0,
            });
          }
        });
      });

      els.browseGrid.querySelectorAll('[data-action="view-transcript"]').forEach(btn => {
        btn.addEventListener('click', () => {
          openTranscriptDrawer(btn.dataset.epId);
        });
      });
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

      let html = '';
      ep.segments.forEach((seg, idx) => {
        const startStr = formatSeconds(seg.start_sec);
        const endStr = formatSeconds(seg.end_sec);
        const formattedText = formatTranscriptParagraphs(seg.text);
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
            media_url: ep.media_url,
            title: ep.title,
            teacher: ep.primary_display,
            start_sec: start,
          });
        });
      });
    } catch (err) {
      els.drawerTurns.innerHTML = '<div class="empty-state"><p>Failed to load transcript.</p></div>';
      console.error(err);
    }
  }

  // ==========================================================================
  // Audio Player Engine (Direct Podbean Streaming)
  // ==========================================================================

  function setupAudioEngine() {
    const audio = els.nativeAudio;
    let isScrubbing = false;
    let scrubCommitted = false;

    function safeSeek(targetTime) {
      const dur = Number.isFinite(audio.duration) ? audio.duration : Infinity;
      const clamped = Math.max(0, Math.min(dur, targetTime));
      // HAVE_METADATA (1) is enough to seek a remote stream; waiting for
      // HAVE_CURRENT_DATA (2) drops seeks while buffering.
      if (audio.readyState >= 1) {
        try {
          audio.currentTime = clamped;
        } catch (err) {
          console.warn('Seek error:', err);
        }
      } else {
        const onReady = () => {
          try {
            audio.currentTime = clamped;
          } catch (err) {
            console.warn('Seek on ready error:', err);
          }
        };
        audio.addEventListener('canplay', onReady, { once: true });
        audio.addEventListener('loadeddata', onReady, { once: true });
      }
    }

    function syncProgress() {
      if (isScrubbing) return; // Do not overwrite slider while user is dragging
      const cur = audio.currentTime;
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      els.timeCurrent.textContent = formatSeconds(cur);
      if (dur > 0) {
        els.timeTotal.textContent = formatSeconds(dur);
        els.scrubber.value = (cur / dur) * 100;
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
      safeSeek(audio.currentTime - 15);
    });

    els.btnSkipFwd.addEventListener('click', () => {
      safeSeek(audio.currentTime + 15);
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
  }

  function playPrevTrack() {
    if (!state.catalog || state.catalog.length === 0) return;
    const currentIdx = state.catalog.findIndex(ep => ep.media_url === state.currentMediaUrl);
    if (currentIdx > 0) {
      const prevEp = state.catalog[currentIdx - 1];
      playAudioSegment({
        media_url: prevEp.media_url,
        title: prevEp.title,
        teacher: prevEp.teacher || prevEp.primary_display,
        start_sec: 0,
      });
    } else {
      els.nativeAudio.currentTime = 0;
    }
  }

  function playNextTrack() {
    if (!state.catalog || state.catalog.length === 0) return;
    const currentIdx = state.catalog.findIndex(ep => ep.media_url === state.currentMediaUrl);
    if (currentIdx >= 0 && currentIdx < state.catalog.length - 1) {
      const nextEp = state.catalog[currentIdx + 1];
      playAudioSegment({
        media_url: nextEp.media_url,
        title: nextEp.title,
        teacher: nextEp.teacher || nextEp.primary_display,
        start_sec: 0,
      });
    }
  }

  // 500ms lead time to first word for any/all seek reference points
  const SEEK_REF_LEAD_TIME_SEC = 0.50;

  function playAudioSegment({ media_url, title, teacher, start_sec }) {
    if (!media_url) {
      alert('Podbean CDN streaming URL is not available for this talk.');
      return;
    }

    const audio = els.nativeAudio;
    els.playerTitle.textContent = title || 'BSWA Dhamma Talk';
    const spkColor = getSpeakerColor('', teacher);
    els.playerSpeaker.innerHTML = `<span class="player-speaker-dot" style="background-color: ${spkColor}; box-shadow: 0 0 8px ${spkColor};"></span> ${escapeHtml(teacher || 'Monastic')}`;

    const isDifferentSource = state.currentMediaUrl !== media_url;
    state.currentMediaUrl = media_url;

    // Apply exactly 500ms lead time to first word for any/all seek ref points (clamped to 0)
    const rawTarget = typeof start_sec === 'number' ? start_sec : parseFloat(start_sec || 0);
    const targetTime = Math.max(0, rawTarget > 0 ? (rawTarget - SEEK_REF_LEAD_TIME_SEC) : 0);

    function performSeek(sec) {
      if (sec < 0) return;
      const doSeek = () => {
        try {
          audio.currentTime = sec;
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

    if (isDifferentSource) {
      audio.src = media_url;
      audio.playbackRate = state.playbackSpeed;

      if (targetTime > 0) {
        performSeek(targetTime);
      }

      // Call audio.play() synchronously directly inside the user gesture
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          console.warn('Playback gesture error:', e);
        });
      }
    } else {
      performSeek(targetTime);
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
