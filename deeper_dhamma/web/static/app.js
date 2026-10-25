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
    catalog: [],
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
    btnPlayPause: document.getElementById('btn-play-pause'),
    btnSkipBack: document.getElementById('btn-skip-back'),
    btnSkipFwd: document.getElementById('btn-skip-fwd'),
    scrubber: document.getElementById('audio-scrubber'),
    timeCurrent: document.getElementById('time-current'),
    timeTotal: document.getElementById('time-total'),
    speedBtns: document.querySelectorAll('.speed-btn'),
    volumeSlider: document.getElementById('volume-slider'),
    volIcon: document.getElementById('vol-icon'),
  };

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

  function init() {
    loadArchiveStats();
    setupEventListeners();
    setupAudioEngine();
    loadBrowseCatalog();
  }

  // ==========================================================================
  // Stats & Metadata Loading
  // ==========================================================================

  async function loadArchiveStats() {
    try {
      const data = await dbService.getStats();
      state.stats = data;

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

      html += `
        <article class="result-card" data-idx="${idx}">
          <div class="result-header">
            <div class="result-title-group">
              <h3 class="result-title">${escapeHtml(item.title)}</h3>
              <div class="result-meta-line">
                <span class="teacher-badge">${escapeHtml(item.teacher || 'BSWA Monastic')}</span>
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
    const opts = {
      transcribedOnly: true,
      limit: 60,
    };
    const teacherVal = (els.browseTeacherFilter && els.browseTeacherFilter.value) || (els.teacherFilter && els.teacherFilter.value) || '';
    const yearVal = (els.browseYearFilter && els.browseYearFilter.value) || (els.yearFilter && els.yearFilter.value) || '';
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
                <span class="teacher-badge">${escapeHtml(ep.teacher || 'Monastic')}</span>
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
      els.drawerMetaInfo.textContent = `${ep.primary_display || 'Monastic'} • ${durMin} mins • ${ep.segments ? ep.segments.length : 0} speech turns`;

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
        html += `
          <div class="transcript-turn" id="turn-${idx}" data-start="${seg.start_sec}">
            <div class="turn-header">
              <span class="turn-speaker">${escapeHtml(seg.speaker_display || 'Speaker')}</span>
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

    audio.addEventListener('timeupdate', () => {
      const cur = audio.currentTime;
      const dur = audio.duration || 0;
      els.timeCurrent.textContent = formatSeconds(cur);
      if (dur > 0) {
        els.timeTotal.textContent = formatSeconds(dur);
        els.scrubber.value = (cur / dur) * 100;
      }
    });

    audio.addEventListener('play', () => {
      els.btnPlayPause.textContent = '⏸';
      els.btnPlayPause.setAttribute('title', 'Pause');
    });

    audio.addEventListener('pause', () => {
      els.btnPlayPause.textContent = '▶';
      els.btnPlayPause.setAttribute('title', 'Play');
    });

    els.btnPlayPause.addEventListener('click', togglePlayPause);

    els.btnSkipBack.addEventListener('click', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 15);
    });

    els.btnSkipFwd.addEventListener('click', () => {
      audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 15);
    });

    els.scrubber.addEventListener('input', () => {
      const dur = audio.duration || 0;
      if (dur > 0) {
        audio.currentTime = (els.scrubber.value / 100) * dur;
      }
    });

    // Speed selector
    els.speedBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        audio.playbackRate = speed;
        state.playbackSpeed = speed;
        els.speedBtns.forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    // Volume slider
    els.volumeSlider.addEventListener('input', () => {
      audio.volume = parseFloat(els.volumeSlider.value);
      els.volIcon.textContent = audio.volume === 0 ? '🔇' : (audio.volume < 0.5 ? '🔉' : '🔊');
    });
  }

  function playAudioSegment({ media_url, title, teacher, start_sec }) {
    if (!media_url) {
      alert('Podbean CDN streaming URL is not available for this talk.');
      return;
    }

    const audio = els.nativeAudio;
    els.playerTitle.textContent = title || 'BSWA Dhamma Talk';
    els.playerSpeaker.textContent = teacher || 'Monastic';

    const isDifferentSource = state.currentMediaUrl !== media_url;
    state.currentMediaUrl = media_url;
    const targetTime = Math.max(0, start_sec || 0);

    if (isDifferentSource) {
      audio.src = media_url;
      audio.playbackRate = state.playbackSpeed;

      if (targetTime > 0) {
        audio.addEventListener('loadedmetadata', () => {
          try {
            audio.currentTime = targetTime;
          } catch (e) {
            console.warn('Seek error on load:', e);
          }
        }, { once: true });
      }

      // CRITICAL: Call audio.play() synchronously directly inside the user gesture
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          console.warn('Playback gesture error:', e);
        });
      }
    } else {
      try {
        audio.currentTime = targetTime;
      } catch (e) {
        console.warn('Seek error:', e);
      }
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

  // Start app on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
