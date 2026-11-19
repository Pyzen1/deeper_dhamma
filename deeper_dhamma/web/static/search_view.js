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

  Object.assign(els, {
    searchTeachersDropdown: document.getElementById('search-teachers-dropdown'),
    searchTeachersBtn: document.getElementById('search-teachers-btn'),
    searchTeachersLabel: document.getElementById('search-teachers-label'),
    searchTeachersSearch: document.getElementById('search-teachers-search'),
    searchTeachersList: document.getElementById('search-teachers-list'),
    searchTeachersSelectedInfo: document.getElementById('search-teachers-selected-info'),
    searchTeachersModeHint: document.getElementById('search-teachers-mode-hint'),
    btnSearchTeacherModeAny: document.getElementById('btn-search-teacher-mode-any'),
    btnSearchTeacherModeAll: document.getElementById('btn-search-teacher-mode-all'),
    btnSearchTeachersClear: document.getElementById('btn-search-teachers-clear'),

    searchYearsDropdown: document.getElementById('search-years-dropdown'),
    searchYearsBtn: document.getElementById('search-years-btn'),
    searchYearsLabel: document.getElementById('search-years-label'),
    searchEraPresets: document.getElementById('search-era-presets'),
    searchYearFrom: document.getElementById('search-year-from'),
    searchYearTo: document.getElementById('search-year-to'),
    btnSearchYearRangeAdd: document.getElementById('btn-search-year-range-add'),
    searchYearsGrid: document.getElementById('search-years-grid'),
    btnSearchYearsClear: document.getElementById('btn-search-years-clear'),

    searchDurationDropdown: document.getElementById('search-duration-dropdown'),
    searchDurationBtn: document.getElementById('search-duration-btn'),
    searchDurationLabel: document.getElementById('search-duration-label'),
    searchDurationBuckets: document.getElementById('search-duration-buckets'),
    searchMinDuration: document.getElementById('search-min-duration'),
    searchMaxDuration: document.getElementById('search-max-duration'),
    btnSearchDurationClear: document.getElementById('btn-search-duration-clear'),

    searchCategoryDropdown: document.getElementById('search-category-dropdown'),
    searchCategoryBtn: document.getElementById('search-category-btn'),
    searchCategoryLabel: document.getElementById('search-category-label'),
    searchCollectionsList: document.getElementById('search-collections-list'),
    searchFormatsList: document.getElementById('search-formats-list'),
    searchCotaughtCheckbox: document.getElementById('search-cotaught-checkbox'),
    searchBookmarkedCheckbox: document.getElementById('search-bookmarked-checkbox'),
    searchCatCntBookmarked: document.getElementById('search-cat-cnt-bookmarked'),
    btnSearchCategoryClear: document.getElementById('btn-search-category-clear'),

    searchTitleDropdown: document.getElementById('search-title-dropdown'),
    searchTitleBtn: document.getElementById('search-title-btn'),
    searchTitleLabel: document.getElementById('search-title-label'),
    searchTitleInput: document.getElementById('search-title-input'),
    searchClearTitleBtn: document.getElementById('search-clear-title-btn'),
    searchTitleWordCheckbox: document.getElementById('search-title-word-checkbox'),
    btnSearchTitleClear: document.getElementById('btn-search-title-clear'),

    searchActiveChips: document.getElementById('search-active-chips'),
  });

  // ==========================================================================
  // Multi-Faceted Search Filters (Mirrors Browse View)
  // ==========================================================================

  function hasActiveSearchFilters() {
    const s = state.search;
    const startDateVal = (els.startDateInput && els.startDateInput.value) || '';
    const endDateVal = (els.endDateInput && els.endDateInput.value) || '';
    const sortVal = (els.sortOrderSelect && els.sortOrderSelect.value) || s.sort || 'rank';
    return Boolean(
      s.teachers.length > 0 ||
      (state.dateFilterMode === 'year' && s.years.length > 0) ||
      (state.dateFilterMode === 'range' && (startDateVal || endDateVal)) ||
      (s.titleQuery && s.titleQuery.trim()) ||
      s.titleWholeWord ||
      s.durationBuckets.length > 0 ||
      s.minDurationMin !== '' ||
      s.maxDurationMin !== '' ||
      s.collections.length > 0 ||
      s.formats.length > 0 ||
      s.coTaughtOnly ||
      s.bookmarkedOnly ||
      (sortVal && sortVal !== 'rank')
    );
  }

  function populateSearchFilterFacets(data) {
    if (!data) return;
    if (els.searchYearsGrid) els.searchYearsGrid.innerHTML = '';
    if (typeof DD.renderTeachersChecklistInto === 'function') {
      DD.renderTeachersChecklistInto(els.searchTeachersList, els.searchTeachersSearch, state.search.teachers);
    }
    if (typeof DD.renderYearsGridInto === 'function') {
      DD.renderYearsGridInto(els.searchYearsGrid, els.searchEraPresets, state.search.years);
    }
    if (typeof DD.populateYearRangeSelects === 'function') {
      DD.populateYearRangeSelects(els.searchYearFrom, els.searchYearTo, state.browseYears);
    }
    if (typeof DD.populateFacetCountsInto === 'function') {
      DD.populateFacetCountsInto(data, 'search-');
    }
    if (els.searchCatCntBookmarked) {
      els.searchCatCntBookmarked.textContent = BookmarkStore.count().toLocaleString();
    }
    syncSearchFilterControlsFromState();
  }

  function updateSearchFilterButtonsAndSummary() {
    const s = state.search;
    const colLabels = DD.BROWSE_COLLECTION_LABELS || {};
    const fmtLabels = DD.BROWSE_FORMAT_LABELS || {};
    const durLabels = DD.BROWSE_DURATION_LABELS || {};
    const getTeacherName = DD.getTeacherDisplayNameBySlug || ((slug) => slug);
    const fmtYearsLabel = DD.formatYearsSummaryLabel || ((yrs) => (yrs.length ? `Years: ${yrs.length}` : 'Years: All'));

    // 1. Monastics button
    if (els.searchTeachersLabel && els.searchTeachersBtn) {
      if (s.teachers.length === 0) {
        els.searchTeachersLabel.textContent = 'Monastics: All';
        els.searchTeachersBtn.classList.remove('has-selection');
      } else if (s.teachers.length === 1) {
        els.searchTeachersLabel.textContent = getTeacherName(s.teachers[0]);
        els.searchTeachersBtn.classList.add('has-selection');
      } else {
        const modeLabel = s.teacherMatch === 'all' ? 'All' : 'Any';
        els.searchTeachersLabel.textContent = `${s.teachers.length} Monastics (${modeLabel})`;
        els.searchTeachersBtn.classList.add('has-selection');
      }
    }
    if (els.searchTeachersSelectedInfo) {
      els.searchTeachersSelectedInfo.textContent = `${s.teachers.length} selected`;
    }
    if (els.btnSearchTeacherModeAny && els.btnSearchTeacherModeAll) {
      els.btnSearchTeacherModeAny.classList.toggle('active', s.teacherMatch !== 'all');
      els.btnSearchTeacherModeAll.classList.toggle('active', s.teacherMatch === 'all');
    }
    if (els.searchTeachersModeHint) {
      els.searchTeachersModeHint.innerHTML = s.teacherMatch === 'all'
        ? 'Show co-taught talks featuring <strong>all</strong> selected monastics together.'
        : 'Show talks featuring <strong>any</strong> selected monastic.';
    }

    // 2. Years button
    if (els.searchYearsLabel && els.searchYearsBtn) {
      els.searchYearsLabel.textContent = fmtYearsLabel(s.years);
      els.searchYearsBtn.classList.toggle('has-selection', s.years.length > 0);
    }

    // 3. Length button
    if (els.searchDurationLabel && els.searchDurationBtn) {
      const hasMin = s.minDurationMin !== '' && !Number.isNaN(Number(s.minDurationMin));
      const hasMax = s.maxDurationMin !== '' && !Number.isNaN(Number(s.maxDurationMin));
      if (hasMin || hasMax) {
        if (hasMin && hasMax) {
          els.searchDurationLabel.textContent = `Length: ${s.minDurationMin}–${s.maxDurationMin} min`;
        } else if (hasMin) {
          els.searchDurationLabel.textContent = `Length: ≥ ${s.minDurationMin} min`;
        } else {
          els.searchDurationLabel.textContent = `Length: ≤ ${s.maxDurationMin} min`;
        }
        els.searchDurationBtn.classList.add('has-selection');
      } else if (s.durationBuckets.length > 0) {
        if (s.durationBuckets.length === 1) {
          els.searchDurationLabel.textContent = `Length: ${durLabels[s.durationBuckets[0]] || s.durationBuckets[0]}`;
        } else {
          els.searchDurationLabel.textContent = `Length: ${s.durationBuckets.length} ranges`;
        }
        els.searchDurationBtn.classList.add('has-selection');
      } else {
        els.searchDurationLabel.textContent = 'Length: Any';
        els.searchDurationBtn.classList.remove('has-selection');
      }
    }

    // 4. Collection & Type button
    const catCount = s.collections.length + s.formats.length + (s.coTaughtOnly ? 1 : 0) + (s.bookmarkedOnly ? 1 : 0);
    if (els.searchCategoryLabel && els.searchCategoryBtn) {
      if (catCount === 0) {
        els.searchCategoryLabel.textContent = 'Collection & Type: All';
        els.searchCategoryBtn.classList.remove('has-selection');
      } else {
        const parts = [
          ...s.collections.map((c) => colLabels[c] || c),
          ...s.formats.map((f) => fmtLabels[f] || f),
        ];
        if (s.coTaughtOnly) parts.push('Co-taught');
        if (s.bookmarkedOnly) parts.push('Bookmarked');
        els.searchCategoryLabel.textContent = parts.length <= 2
          ? `Type: ${parts.join(', ')}`
          : `Type: ${parts.length} active`;
        els.searchCategoryBtn.classList.add('has-selection');
      }
    }

    // 5. Title button
    if (els.searchTitleLabel && els.searchTitleBtn) {
      const trimmedTitle = (s.titleQuery || '').trim();
      if (trimmedTitle) {
        const shortTitle = trimmedTitle.length > 18 ? `${trimmedTitle.slice(0, 17)}…` : trimmedTitle;
        els.searchTitleLabel.textContent = `Title: "${shortTitle}"`;
        els.searchTitleBtn.classList.add('has-selection');
      } else if (s.titleWholeWord) {
        els.searchTitleLabel.textContent = 'Title: Whole Word';
        els.searchTitleBtn.classList.add('has-selection');
      } else {
        els.searchTitleLabel.textContent = 'Title: Any';
        els.searchTitleBtn.classList.remove('has-selection');
      }
    }

    // 6. Active filter chips
    if (els.searchActiveChips) {
      const chips = [];
      if (s.titleQuery && s.titleQuery.trim()) {
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="title" title="Remove title filter">Title: "${escapeHtml(s.titleQuery.trim())}"${s.titleWholeWord ? ' (word)' : ''} ✕</button>`);
      }
      if (s.teachers.length >= 2) {
        const nextMode = s.teacherMatch === 'all' ? 'Any (OR)' : 'All / Co-taught (AND)';
        chips.push(`<button type="button" class="browse-filter-chip browse-filter-chip-mode" data-toggle-teacher-mode="1" title="Click to switch monastic matching between Any (OR) and All (AND)">Match: ${s.teacherMatch === 'all' ? 'All (AND)' : 'Any (OR)'} ⇄ ${nextMode}</button>`);
      }
      s.teachers.forEach((slug) => {
        chips.push(`<button type="button" class="browse-filter-chip" data-remove-teacher="${escapeHtml(slug)}" title="Remove ${escapeHtml(getTeacherName(slug))}">${escapeHtml(getTeacherName(slug))} ✕</button>`);
      });

      if (state.dateFilterMode === 'range') {
        const startVal = (els.startDateInput && els.startDateInput.value) || '';
        const endVal = (els.endDateInput && els.endDateInput.value) || '';
        if (startVal || endVal) {
          const rangeText = startVal && endVal ? `${startVal} – ${endVal}` : (startVal ? `From ${startVal}` : `Until ${endVal}`);
          chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="daterange" title="Clear date range">Dates: ${escapeHtml(rangeText)} ✕</button>`);
        }
      } else if (s.years.length > 0) {
        const sortedYears = [...s.years].sort((a, b) => b - a);
        if (sortedYears.length <= 4) {
          sortedYears.forEach((y) => {
            chips.push(`<button type="button" class="browse-filter-chip" data-remove-year="${y}" title="Remove year ${y}">${y} ✕</button>`);
          });
        } else {
          chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="years" title="Clear selected years">${escapeHtml(fmtYearsLabel(sortedYears))} ✕</button>`);
        }
      }

      if (s.minDurationMin !== '' || s.maxDurationMin !== '') {
        const label = (s.minDurationMin !== '' && s.maxDurationMin !== '')
          ? `${s.minDurationMin}–${s.maxDurationMin} min`
          : (s.minDurationMin !== '' ? `≥ ${s.minDurationMin} min` : `≤ ${s.maxDurationMin} min`);
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="duration" title="Clear length filter">Length: ${escapeHtml(label)} ✕</button>`);
      } else {
        s.durationBuckets.forEach((bk) => {
          chips.push(`<button type="button" class="browse-filter-chip" data-remove-dur="${escapeHtml(bk)}" title="Remove duration range">Length: ${escapeHtml(durLabels[bk] || bk)} ✕</button>`);
        });
      }

      s.collections.forEach((c) => {
        chips.push(`<button type="button" class="browse-filter-chip" data-remove-col="${escapeHtml(c)}">${escapeHtml(colLabels[c] || c)} ✕</button>`);
      });
      s.formats.forEach((f) => {
        chips.push(`<button type="button" class="browse-filter-chip" data-remove-fmt="${escapeHtml(f)}">${escapeHtml(fmtLabels[f] || f)} ✕</button>`);
      });
      if (s.coTaughtOnly) {
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="cotaught">Co-taught (2+) ✕</button>`);
      }
      if (s.bookmarkedOnly) {
        chips.push(`<button type="button" class="browse-filter-chip" data-clear-chip="bookmarked">🔖 Bookmarked ✕</button>`);
      }

      els.searchActiveChips.innerHTML = chips.join('');
    }
  }

  function syncSearchFilterControlsFromState() {
    const s = state.search;
    if (els.searchTitleInput) els.searchTitleInput.value = s.titleQuery || '';
    if (els.searchClearTitleBtn) els.searchClearTitleBtn.style.display = (s.titleQuery || '').trim() ? 'inline-block' : 'none';
    if (els.searchTitleWordCheckbox) els.searchTitleWordCheckbox.checked = Boolean(s.titleWholeWord);

    if (els.searchTeachersList) {
      const teacherCbs = els.searchTeachersList.querySelectorAll('input[data-teacher-slug]');
      if (teacherCbs.length > 0) {
        const tSet = new Set(s.teachers);
        teacherCbs.forEach((cb) => {
          cb.checked = tSet.has(cb.dataset.teacherSlug);
        });
      } else if (typeof DD.renderTeachersChecklistInto === 'function') {
        DD.renderTeachersChecklistInto(els.searchTeachersList, els.searchTeachersSearch, s.teachers);
      }
    }
    if (typeof DD.renderYearsGridInto === 'function') {
      DD.renderYearsGridInto(els.searchYearsGrid, els.searchEraPresets, s.years);
    }

    if (els.btnModeYear && els.btnModeRange) {
      els.btnModeYear.classList.toggle('active', state.dateFilterMode !== 'range');
      els.btnModeRange.classList.toggle('active', state.dateFilterMode === 'range');
    }
    if (els.searchYearsDropdown) {
      els.searchYearsDropdown.style.display = state.dateFilterMode === 'range' ? 'none' : 'inline-block';
    }
    if (els.dateRangeInputs) {
      els.dateRangeInputs.style.display = state.dateFilterMode === 'range' ? 'inline-flex' : 'none';
    }

    if (els.searchDurationBuckets) {
      const bucketSet = new Set(s.durationBuckets);
      els.searchDurationBuckets.querySelectorAll('input[data-dur-bucket]').forEach((cb) => {
        cb.checked = bucketSet.has(cb.dataset.durBucket);
      });
    }
    if (els.searchMinDuration) els.searchMinDuration.value = s.minDurationMin !== '' ? String(s.minDurationMin) : '';
    if (els.searchMaxDuration) els.searchMaxDuration.value = s.maxDurationMin !== '' ? String(s.maxDurationMin) : '';

    if (els.searchCollectionsList) {
      const colSet = new Set(s.collections);
      els.searchCollectionsList.querySelectorAll('input[data-collection]').forEach((cb) => {
        cb.checked = colSet.has(cb.dataset.collection);
      });
    }
    if (els.searchFormatsList) {
      const fmtSet = new Set(s.formats);
      els.searchFormatsList.querySelectorAll('input[data-format]').forEach((cb) => {
        cb.checked = fmtSet.has(cb.dataset.format);
      });
    }
    if (els.searchCotaughtCheckbox) els.searchCotaughtCheckbox.checked = Boolean(s.coTaughtOnly);
    if (els.searchBookmarkedCheckbox) els.searchBookmarkedCheckbox.checked = Boolean(s.bookmarkedOnly);
    if (els.sortOrderSelect) els.sortOrderSelect.value = s.sort || 'rank';

    updateSearchFilterButtonsAndSummary();
  }

  function buildSearchFilterOpts() {
    const s = state.search;
    const opts = {};
    if (s.teachers.length > 0) {
      opts.teachers = [...s.teachers];
      opts.teacherMatch = s.teacherMatch || 'any';
    }
    if (state.dateFilterMode === 'range') {
      const startDateVal = (els.startDateInput && els.startDateInput.value) || '';
      const endDateVal = (els.endDateInput && els.endDateInput.value) || '';
      if (startDateVal) opts.startDate = startDateVal;
      if (endDateVal) opts.endDate = endDateVal;
    } else if (s.years.length > 0) {
      opts.years = [...s.years];
    }
    if (s.titleQuery && s.titleQuery.trim()) {
      opts.titleQuery = s.titleQuery.trim();
      opts.titleWholeWord = Boolean(s.titleWholeWord);
    }
    if (s.minDurationMin !== '' && !Number.isNaN(Number(s.minDurationMin))) {
      opts.minDurationMin = Number(s.minDurationMin);
    }
    if (s.maxDurationMin !== '' && !Number.isNaN(Number(s.maxDurationMin))) {
      opts.maxDurationMin = Number(s.maxDurationMin);
    }
    if (opts.minDurationMin === undefined && opts.maxDurationMin === undefined && s.durationBuckets.length > 0) {
      opts.durationBuckets = [...s.durationBuckets];
    }
    if (s.collections.length > 0) opts.collections = [...s.collections];
    if (s.formats.length > 0) opts.formats = [...s.formats];
    if (s.coTaughtOnly) opts.coTaughtOnly = true;
    if (s.bookmarkedOnly) opts.episodeIds = BookmarkStore.getAll();
    return opts;
  }

  function buildSearchRouteHash(query = state.currentQuery) {
    const s = state.search;
    const qp = new URLSearchParams();
    if (query) qp.set('q', query);
    if (s.teachers.length > 0) qp.set('teachers', s.teachers.join(','));
    if (s.teachers.length > 1 && s.teacherMatch === 'all') qp.set('tmode', 'all');
    if (state.dateFilterMode === 'range') {
      const startVal = (els.startDateInput && els.startDateInput.value) || '';
      const endVal = (els.endDateInput && els.endDateInput.value) || '';
      if (startVal || endVal) {
        qp.set('dmode', 'range');
        if (startVal) qp.set('sdate', startVal);
        if (endVal) qp.set('edate', endVal);
      }
    } else if (s.years.length > 0) {
      qp.set('years', [...s.years].sort((a, b) => b - a).join(','));
    }
    if (s.titleQuery && s.titleQuery.trim()) qp.set('title', s.titleQuery.trim());
    if (s.titleWholeWord) qp.set('tword', '1');
    if (s.minDurationMin !== '') qp.set('minm', String(s.minDurationMin));
    if (s.maxDurationMin !== '') qp.set('maxm', String(s.maxDurationMin));
    if (s.minDurationMin === '' && s.maxDurationMin === '' && s.durationBuckets.length > 0) {
      qp.set('dur', s.durationBuckets.join(','));
    }
    if (s.collections.length > 0) qp.set('col', s.collections.join(','));
    if (s.formats.length > 0) qp.set('fmt', s.formats.join(','));
    if (s.coTaughtOnly) qp.set('cotaught', '1');
    if (s.bookmarkedOnly) qp.set('bmk', '1');
    const sortVal = (els.sortOrderSelect && els.sortOrderSelect.value) || s.sort || 'rank';
    if (sortVal && sortVal !== 'rank') qp.set('sort', sortVal);
    const qs = qp.toString();
    return qs ? `#search?${qs}` : '#search';
  }

  function applySearchParamsFromRoute(params = {}) {
    const s = state.search;
    const splitCsv = (val) => val ? String(val).split(',').map((item) => item.trim()).filter(Boolean) : [];
    s.teachers = splitCsv(params.teachers);
    s.teacherMatch = params.tmode === 'all' ? 'all' : 'any';
    if (params.dmode === 'range' || params.sdate || params.edate) {
      state.dateFilterMode = 'range';
      if (els.startDateInput) els.startDateInput.value = params.sdate || '';
      if (els.endDateInput) els.endDateInput.value = params.edate || '';
      s.years = [];
    } else {
      state.dateFilterMode = 'year';
      if (els.startDateInput) els.startDateInput.value = '';
      if (els.endDateInput) els.endDateInput.value = '';
      s.years = splitCsv(params.years).map((y) => Number(y)).filter((y) => y > 0);
    }
    s.titleQuery = params.title ? String(params.title) : '';
    s.titleWholeWord = params.tword === '1' || params.tword === 'true';
    s.minDurationMin = (params.minm !== undefined && params.minm !== '') ? String(params.minm) : '';
    s.maxDurationMin = (params.maxm !== undefined && params.maxm !== '') ? String(params.maxm) : '';
    s.durationBuckets = (s.minDurationMin === '' && s.maxDurationMin === '') ? splitCsv(params.dur) : [];
    s.collections = splitCsv(params.col);
    s.formats = splitCsv(params.fmt);
    s.coTaughtOnly = params.cotaught === '1' || params.cotaught === 'true';
    s.bookmarkedOnly = params.bmk === '1' || params.bmk === 'true';
    s.sort = params.sort || 'rank';
    syncSearchFilterControlsFromState();
  }

  function resetSearchFilters() {
    const s = state.search;
    if (els.searchInput) els.searchInput.value = '';
    if (els.clearSearchBtn) els.clearSearchBtn.style.display = 'none';
    if (els.exactCheckbox) els.exactCheckbox.checked = false;
    if (els.startDateInput) els.startDateInput.value = '';
    if (els.endDateInput) els.endDateInput.value = '';
    if (els.searchTeachersSearch) els.searchTeachersSearch.value = '';
    if (els.searchYearFrom) els.searchYearFrom.value = '';
    if (els.searchYearTo) els.searchYearTo.value = '';
    state.dateFilterMode = 'year';

    s.teachers = [];
    s.teacherMatch = 'any';
    s.years = [];
    s.titleQuery = '';
    s.titleWholeWord = false;
    s.durationBuckets = [];
    s.minDurationMin = '';
    s.maxDurationMin = '';
    s.collections = [];
    s.formats = [];
    s.coTaughtOnly = false;
    s.bookmarkedOnly = false;
    s.sort = 'rank';

    syncSearchFilterControlsFromState();
    executeSearch('');
  }

  function triggerSearchWithCurrentQuery() {
    const q = (els.searchInput && els.searchInput.value.trim()) || '';
    executeSearch(q);
  }

  function setupSearchFilterListeners() {
    // 0. Date Mode Toggle, Date Range, Sort & Reset
    if (els.btnModeYear && els.btnModeRange) {
      els.btnModeYear.addEventListener('click', () => {
        state.dateFilterMode = 'year';
        els.btnModeYear.classList.add('active');
        els.btnModeRange.classList.remove('active');
        if (els.searchYearsDropdown) els.searchYearsDropdown.style.display = 'inline-block';
        if (els.dateRangeInputs) els.dateRangeInputs.style.display = 'none';
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });

      els.btnModeRange.addEventListener('click', () => {
        state.dateFilterMode = 'range';
        els.btnModeRange.classList.add('active');
        els.btnModeYear.classList.remove('active');
        if (els.searchYearsDropdown) els.searchYearsDropdown.style.display = 'none';
        if (els.dateRangeInputs) els.dateRangeInputs.style.display = 'inline-flex';
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }

    if (els.startDateInput) {
      els.startDateInput.addEventListener('change', () => {
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }

    if (els.endDateInput) {
      els.endDateInput.addEventListener('change', () => {
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }

    if (els.sortOrderSelect) {
      els.sortOrderSelect.addEventListener('change', () => {
        state.search.sort = els.sortOrderSelect.value || 'rank';
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }

    if (els.resetFiltersBtn) {
      els.resetFiltersBtn.addEventListener('click', () => {
        resetSearchFilters();
      });
    }

    // Focus helpers when popovers open (popover open/close/clamp is handled globally by setupBrowseFilterListeners)
    if (els.searchTeachersBtn && els.searchTeachersSearch) {
      els.searchTeachersBtn.addEventListener('click', () => {
        if (els.searchTeachersDropdown && els.searchTeachersDropdown.classList.contains('open')) {
          setTimeout(() => els.searchTeachersSearch.focus(), 20);
        }
      });
    }
    if (els.searchTitleBtn && els.searchTitleInput) {
      els.searchTitleBtn.addEventListener('click', () => {
        if (els.searchTitleDropdown && els.searchTitleDropdown.classList.contains('open')) {
          setTimeout(() => els.searchTitleInput.focus(), 20);
        }
      });
    }

    // 1. Title filter + Whole Word toggle
    if (els.searchTitleInput) {
      els.searchTitleInput.addEventListener('input', () => {
        const val = els.searchTitleInput.value;
        state.search.titleQuery = val;
        if (els.searchClearTitleBtn) {
          els.searchClearTitleBtn.style.display = val.trim() ? 'inline-block' : 'none';
        }
        clearTimeout(state.search.debounceTimer);
        state.search.debounceTimer = setTimeout(() => {
          updateSearchFilterButtonsAndSummary();
          triggerSearchWithCurrentQuery();
        }, 160);
      });
    }
    if (els.searchClearTitleBtn) {
      els.searchClearTitleBtn.addEventListener('click', () => {
        state.search.titleQuery = '';
        if (els.searchTitleInput) {
          els.searchTitleInput.value = '';
          els.searchTitleInput.focus();
        }
        els.searchClearTitleBtn.style.display = 'none';
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.searchTitleWordCheckbox) {
      els.searchTitleWordCheckbox.addEventListener('change', () => {
        state.search.titleWholeWord = els.searchTitleWordCheckbox.checked;
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.btnSearchTitleClear) {
      els.btnSearchTitleClear.addEventListener('click', () => {
        state.search.titleQuery = '';
        state.search.titleWholeWord = false;
        if (els.searchTitleInput) els.searchTitleInput.value = '';
        if (els.searchClearTitleBtn) els.searchClearTitleBtn.style.display = 'none';
        if (els.searchTitleWordCheckbox) els.searchTitleWordCheckbox.checked = false;
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }

    // 2. Monastics multi-select
    if (els.searchTeachersSearch) {
      els.searchTeachersSearch.addEventListener('input', () => {
        if (typeof DD.renderTeachersChecklistInto === 'function') {
          DD.renderTeachersChecklistInto(els.searchTeachersList, els.searchTeachersSearch, state.search.teachers);
        }
      });
    }
    if (els.searchTeachersList) {
      els.searchTeachersList.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-teacher-slug]');
        if (!cb) return;
        const slug = cb.dataset.teacherSlug;
        const set = new Set(state.search.teachers);
        if (cb.checked) set.add(slug);
        else set.delete(slug);
        state.search.teachers = Array.from(set);
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    const setSearchTeacherMode = (mode) => {
      if (state.search.teacherMatch === mode) return;
      state.search.teacherMatch = mode;
      updateSearchFilterButtonsAndSummary();
      if (state.search.teachers.length >= 2) {
        triggerSearchWithCurrentQuery();
      }
    };
    if (els.btnSearchTeacherModeAny) {
      els.btnSearchTeacherModeAny.addEventListener('click', () => setSearchTeacherMode('any'));
    }
    if (els.btnSearchTeacherModeAll) {
      els.btnSearchTeacherModeAll.addEventListener('click', () => setSearchTeacherMode('all'));
    }
    if (els.btnSearchTeachersClear) {
      els.btnSearchTeachersClear.addEventListener('click', () => {
        state.search.teachers = [];
        if (els.searchTeachersSearch) els.searchTeachersSearch.value = '';
        if (typeof DD.renderTeachersChecklistInto === 'function') {
          DD.renderTeachersChecklistInto(els.searchTeachersList, els.searchTeachersSearch, state.search.teachers);
        }
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }

    // 3. Years grouping & multi-select
    if (els.searchYearsGrid) {
      els.searchYearsGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.year-chip-btn[data-year]');
        if (!btn) return;
        const y = Number(btn.dataset.year);
        const set = new Set(state.search.years);
        if (set.has(y)) set.delete(y);
        else set.add(y);
        state.search.years = Array.from(set).sort((a, b) => b - a);
        if (typeof DD.renderYearsGridInto === 'function') {
          DD.renderYearsGridInto(els.searchYearsGrid, els.searchEraPresets, state.search.years);
        }
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.searchEraPresets) {
      els.searchEraPresets.addEventListener('click', (e) => {
        const btn = e.target.closest('.era-preset-btn[data-era]');
        if (!btn || typeof DD.getYearsForEraPreset !== 'function') return;
        const eraYears = DD.getYearsForEraPreset(btn.dataset.era);
        if (eraYears.length === 0) return;
        const set = new Set(state.search.years);
        const allSelected = eraYears.every((y) => set.has(y));
        if (allSelected) eraYears.forEach((y) => set.delete(y));
        else eraYears.forEach((y) => set.add(y));
        state.search.years = Array.from(set).sort((a, b) => b - a);
        if (typeof DD.renderYearsGridInto === 'function') {
          DD.renderYearsGridInto(els.searchYearsGrid, els.searchEraPresets, state.search.years);
        }
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.btnSearchYearRangeAdd) {
      els.btnSearchYearRangeAdd.addEventListener('click', () => {
        const y1 = Number(els.searchYearFrom && els.searchYearFrom.value);
        const y2 = Number(els.searchYearTo && els.searchYearTo.value);
        if (!y1 && !y2) return;
        const lo = y1 && y2 ? Math.min(y1, y2) : (y1 || y2);
        const hi = y1 && y2 ? Math.max(y1, y2) : (y1 || y2);
        const set = new Set(state.search.years);
        (state.browseYears || []).forEach((y) => {
          if (y >= lo && y <= hi) set.add(y);
        });
        state.search.years = Array.from(set).sort((a, b) => b - a);
        if (typeof DD.renderYearsGridInto === 'function') {
          DD.renderYearsGridInto(els.searchYearsGrid, els.searchEraPresets, state.search.years);
        }
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.btnSearchYearsClear) {
      els.btnSearchYearsClear.addEventListener('click', () => {
        state.search.years = [];
        if (els.searchYearFrom) els.searchYearFrom.value = '';
        if (els.searchYearTo) els.searchYearTo.value = '';
        if (typeof DD.renderYearsGridInto === 'function') {
          DD.renderYearsGridInto(els.searchYearsGrid, els.searchEraPresets, state.search.years);
        }
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }

    // 4. Duration buckets & custom min/max
    if (els.searchDurationBuckets) {
      els.searchDurationBuckets.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-dur-bucket]');
        if (!cb) return;
        const bk = cb.dataset.durBucket;
        const set = new Set(state.search.durationBuckets);
        if (cb.checked) set.add(bk);
        else set.delete(bk);
        state.search.durationBuckets = Array.from(set);
        state.search.minDurationMin = '';
        state.search.maxDurationMin = '';
        if (els.searchMinDuration) els.searchMinDuration.value = '';
        if (els.searchMaxDuration) els.searchMaxDuration.value = '';
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    const onSearchCustomDurChange = () => {
      state.search.minDurationMin = els.searchMinDuration ? els.searchMinDuration.value.trim() : '';
      state.search.maxDurationMin = els.searchMaxDuration ? els.searchMaxDuration.value.trim() : '';
      if (state.search.minDurationMin !== '' || state.search.maxDurationMin !== '') {
        state.search.durationBuckets = [];
        if (els.searchDurationBuckets) {
          els.searchDurationBuckets.querySelectorAll('input[data-dur-bucket]').forEach((cb) => {
            cb.checked = false;
          });
        }
      }
      clearTimeout(state.search.debounceTimer);
      state.search.debounceTimer = setTimeout(() => {
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      }, 220);
    };
    if (els.searchMinDuration) els.searchMinDuration.addEventListener('input', onSearchCustomDurChange);
    if (els.searchMaxDuration) els.searchMaxDuration.addEventListener('input', onSearchCustomDurChange);
    if (els.btnSearchDurationClear) {
      els.btnSearchDurationClear.addEventListener('click', () => {
        state.search.durationBuckets = [];
        state.search.minDurationMin = '';
        state.search.maxDurationMin = '';
        syncSearchFilterControlsFromState();
        triggerSearchWithCurrentQuery();
      });
    }

    // 5. Collections, Formats & Attributes
    if (els.searchCollectionsList) {
      els.searchCollectionsList.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-collection]');
        if (!cb) return;
        const set = new Set(state.search.collections);
        if (cb.checked) set.add(cb.dataset.collection);
        else set.delete(cb.dataset.collection);
        state.search.collections = Array.from(set);
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.searchFormatsList) {
      els.searchFormatsList.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-format]');
        if (!cb) return;
        const set = new Set(state.search.formats);
        if (cb.checked) set.add(cb.dataset.format);
        else set.delete(cb.dataset.format);
        state.search.formats = Array.from(set);
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.searchCotaughtCheckbox) {
      els.searchCotaughtCheckbox.addEventListener('change', () => {
        state.search.coTaughtOnly = els.searchCotaughtCheckbox.checked;
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.searchBookmarkedCheckbox) {
      els.searchBookmarkedCheckbox.addEventListener('change', () => {
        state.search.bookmarkedOnly = els.searchBookmarkedCheckbox.checked;
        updateSearchFilterButtonsAndSummary();
        triggerSearchWithCurrentQuery();
      });
    }
    if (els.btnSearchCategoryClear) {
      els.btnSearchCategoryClear.addEventListener('click', () => {
        state.search.collections = [];
        state.search.formats = [];
        state.search.coTaughtOnly = false;
        state.search.bookmarkedOnly = false;
        syncSearchFilterControlsFromState();
        triggerSearchWithCurrentQuery();
      });
    }

    // 6. Active Filter Chips removal
    if (els.searchActiveChips) {
      els.searchActiveChips.addEventListener('click', (e) => {
        const btn = e.target.closest('.browse-filter-chip');
        if (!btn) return;
        if (btn.dataset.toggleTeacherMode) {
          state.search.teacherMatch = state.search.teacherMatch === 'all' ? 'any' : 'all';
        } else if (btn.dataset.removeTeacher) {
          state.search.teachers = state.search.teachers.filter((t) => t !== btn.dataset.removeTeacher);
        } else if (btn.dataset.removeYear) {
          const y = Number(btn.dataset.removeYear);
          state.search.years = state.search.years.filter((yr) => yr !== y);
        } else if (btn.dataset.removeDur) {
          state.search.durationBuckets = state.search.durationBuckets.filter((bk) => bk !== btn.dataset.removeDur);
        } else if (btn.dataset.removeCol) {
          state.search.collections = state.search.collections.filter((c) => c !== btn.dataset.removeCol);
        } else if (btn.dataset.removeFmt) {
          state.search.formats = state.search.formats.filter((f) => f !== btn.dataset.removeFmt);
        } else if (btn.dataset.clearChip === 'title') {
          state.search.titleQuery = '';
          state.search.titleWholeWord = false;
        } else if (btn.dataset.clearChip === 'years') {
          state.search.years = [];
        } else if (btn.dataset.clearChip === 'daterange') {
          if (els.startDateInput) els.startDateInput.value = '';
          if (els.endDateInput) els.endDateInput.value = '';
        } else if (btn.dataset.clearChip === 'duration') {
          state.search.durationBuckets = [];
          state.search.minDurationMin = '';
          state.search.maxDurationMin = '';
        } else if (btn.dataset.clearChip === 'cotaught') {
          state.search.coTaughtOnly = false;
        } else if (btn.dataset.clearChip === 'bookmarked') {
          state.search.bookmarkedOnly = false;
        }
        syncSearchFilterControlsFromState();
        triggerSearchWithCurrentQuery();
      });
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
    const sortVal = (els.sortOrderSelect && els.sortOrderSelect.value) || state.search.sort || 'rank';
    state.search.sort = sortVal;

    const hasFilters = hasActiveSearchFilters();
    updateSearchFilterButtonsAndSummary();

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
      const searchHash = buildSearchRouteHash(query);
      if (window.location.hash !== searchHash) {
        if (options.pushHistory) {
          state.historyDepth++;
          window.history.pushState({ route: searchHash }, '', searchHash);
        } else {
          window.history.replaceState({ route: searchHash }, '', searchHash);
        }
      }
    }

    const activeFilterOpts = buildSearchFilterOpts();

    // Case 1: Search query provided (FTS search, 50 talks per page)
    if (query) {
      state.search.filteredFilterOpts = null;
      const searchOpts = {
        ...activeFilterOpts,
        episodeLimit: state.search.limit,
        offset: state.search.offset,
        exact: els.exactCheckbox.checked,
        sort: sortVal,
      };

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
        ...activeFilterOpts,
        transcribedOnly: true,
        limit: state.search.limit,
        offset: state.search.offset,
        sort: sortVal === 'rank' ? 'year_desc' : sortVal,
      };

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
            <h3 class="episode-title">${typeof DD.highlightTitleText === 'function' ? DD.highlightTitleText(ep.title, state.search.titleQuery, state.search.titleWholeWord) : escapeHtml(ep.title)}</h3>
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
    hasActiveSearchFilters,
    populateSearchFilterFacets,
    updateSearchFilterButtonsAndSummary,
    syncSearchFilterControlsFromState,
    buildSearchFilterOpts,
    buildSearchRouteHash,
    applySearchParamsFromRoute,
    resetSearchFilters,
    setupSearchFilterListeners,
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
