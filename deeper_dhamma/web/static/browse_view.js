/**
 * Deeper Dhamma — Browse Catalog View & Multi-Faceted Filtering
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const {
    state,
    els,
    dbService,
    BookmarkStore,
    clampFloatingPanelToViewport,
    escapeHtml,
    formatEpisodeDateHtml,
    getPodbeanUrl,
    getSpeakerColor,
    highlightTitleText,
    renderBookmarkRibbonSvg,
    renderTeacherBadgesHtml,
    resetFloatingPanelPosition,
  } = DD;
  const attachCardEventListeners = (...args) => DD.attachCardEventListeners(...args);

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

  function renderTeachersChecklistInto(listEl, searchEl, selectedSlugs) {
    if (!listEl) return;
    const filterTerm = (searchEl && searchEl.value || '').trim().toLowerCase();
    const selectedSet = new Set(selectedSlugs || []);
    const items = (state.browseTeachers || []).filter((t) => {
      if (!filterTerm) return true;
      return t.name.toLowerCase().includes(filterTerm);
    });

    if (items.length === 0) {
      listEl.innerHTML = '<div class="popover-hint" style="padding: 0.4rem;">No matching monastics.</div>';
      return;
    }

    listEl.innerHTML = items.map((t) => {
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

  function renderBrowseTeachersChecklist() {
    renderTeachersChecklistInto(els.browseTeachersList, els.browseTeachersSearch, state.browse.teachers);
  }

  function renderYearsGridInto(gridEl, eraPresetsEl, selectedYears) {
    if (!gridEl) return;
    const years = state.browseYears || [];
    const counts = (state.stats && state.stats.year_counts) || {};
    const selectedSet = new Set(selectedYears || []);

    const existingBtns = gridEl.querySelectorAll('.year-chip-btn[data-year]');
    if (existingBtns.length === years.length && years.length > 0) {
      existingBtns.forEach((btn) => {
        const y = Number(btn.dataset.year);
        const isSel = selectedSet.has(y);
        btn.classList.toggle('selected', isSel);
        btn.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      });
    } else {
      gridEl.innerHTML = years.map((y) => {
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

    if (eraPresetsEl) {
      eraPresetsEl.querySelectorAll('.era-preset-btn').forEach((btn) => {
        const eraYears = getYearsForEraPreset(btn.dataset.era);
        const allSelected = eraYears.length > 0 && eraYears.every((y) => selectedSet.has(y));
        btn.classList.toggle('active', allSelected);
      });
    }
  }

  function renderBrowseYearsGrid() {
    renderYearsGridInto(els.browseYearsGrid, els.browseEraPresets, state.browse.years);
  }

  function populateYearRangeSelects(fromEl, toEl, years) {
    if (!fromEl || !toEl || !years || years.length === 0) return;
    const ascYears = [...years].sort((a, b) => a - b);
    const descYears = [...years].sort((a, b) => b - a);
    const prevFrom = fromEl.value;
    const prevTo = toEl.value;
    fromEl.innerHTML = '<option value="">From...</option>' +
      ascYears.map((y) => `<option value="${y}">${y}</option>`).join('');
    toEl.innerHTML = '<option value="">To...</option>' +
      descYears.map((y) => `<option value="${y}">${y}</option>`).join('');
    if (prevFrom) fromEl.value = prevFrom;
    if (prevTo) toEl.value = prevTo;
  }

  function populateFacetCountsInto(data, idPrefix = '') {
    if (!data) return;
    if (data.duration_counts) {
      Object.entries(data.duration_counts).forEach(([key, val]) => {
        const domKey = key === 'm15_30' ? '15_30' : (key === 'm30_60' ? '30_60' : (key === 'm60_90' ? '60_90' : key));
        const el = document.getElementById(`${idPrefix}dur-cnt-${domKey}`);
        if (el) el.textContent = Number(val || 0).toLocaleString();
      });
    }
    if (data.category_counts) {
      Object.entries(data.category_counts).forEach(([key, val]) => {
        const el = document.getElementById(`${idPrefix}cat-cnt-${key}`);
        if (el) el.textContent = Number(val || 0).toLocaleString();
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

    populateYearRangeSelects(els.browseYearFrom, els.browseYearTo, state.browseYears);
    populateFacetCountsInto(data, '');

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
            ${durMin > 0 ? `<span>• <span class="material-symbols-outlined ms-sm" aria-hidden="true">schedule</span> ${durMin} mins</span>` : ''}
          </div>
          <h3 class="episode-title">${titleHtml}</h3>
        </div>

        <div class="episode-footer">
          <button type="button" class="btn-primary" data-action="play-ep-start" data-ep-id="${escapeHtml(ep.id)}">
            <span class="material-symbols-outlined ms-inline" aria-hidden="true">play_arrow</span> Play Talk
          </button>
          ${isTranscribed ? `
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
            <div class="empty-icon material-symbols-outlined" aria-hidden="true">folder_open</div>
            <h3>No talks match the active filters</h3>
            <p style="margin-top: 0.4rem;">${escapeHtml(emptyHint)}</p>
            <div style="display: flex; gap: 0.6rem; justify-content: center; flex-wrap: wrap; margin-top: 1rem;">
              ${showSwitchToAnyBtn ? `<button type="button" class="btn-primary" id="btn-empty-switch-any">Switch Monastics to Any (OR)</button>` : ''}
              <button type="button" class="btn-secondary" id="btn-empty-reset-browse"><span class="material-symbols-outlined ms-sm" aria-hidden="true">close</span> Reset All Filters</button>
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

  Object.assign(DD, {
    BROWSE_COLLECTION_LABELS,
    BROWSE_FORMAT_LABELS,
    BROWSE_DURATION_LABELS,
    closeAllBrowsePopovers,
    getTeacherDisplayNameBySlug,
    getYearsForEraPreset,
    renderTeachersChecklistInto,
    renderYearsGridInto,
    populateYearRangeSelects,
    populateFacetCountsInto,
    renderBrowseTeachersChecklist,
    renderBrowseYearsGrid,
    populateBrowseFilterFacets,
    hasActiveBrowseFilters,
    formatYearsSummaryLabel,
    updateBrowseFilterButtonsAndSummary,
    syncBrowseFilterControlsFromState,
    buildBrowseQueryOpts,
    buildBrowseRouteHash,
    applyBrowseParamsFromRoute,
    resetBrowseFilters,
    setupBrowseFilterListeners,
    renderBrowseEpisodeCardHtml,
    loadBrowseCatalog,
  });
})();
