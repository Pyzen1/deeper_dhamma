# Multi-Faceted Browse Filtering, Teacher Disambiguation & Archival Date Parity

## 1. Symptoms & Gaps Identified

1. **Single-Value Browse Filters**:
   `#browse-view` only offered single-select `<select>` dropdowns for one monastic teacher and one year, with no title text filter, no talk-length filter, no collection/format facets, no sort selector, no reset control, and no filtered ZIP export.
2. **Teacher Substring Collision (`Ajahn Brahm` vs. `Ajahn Brahmali`)**:
   `handleGetEpisodes()` in `db_worker.js` matched teachers with `LIKE '%Ajahn Brahm%'`, causing a filter for **Ajahn Brahm** to also match 525 **Ajahn Brahmali** talks. In addition, `handleGetStats()` exposed `lay_questioner` (`Questioner`) and unregistered/zero-episode teachers in dropdowns, while some `identified_teachers` fields included trailing `(voiceprint 0.xx)` annotations or omitted secondary speakers present in `primary_display`.
3. **Archival Recording Year vs. Podbean Upload Date Mismatch**:
   Across 1,412 archival talks (e.g. 1994–2014 cassette/mini-disc recordings uploaded to Podbean years later), `episodes.year` holds the true recording year while `episodes.date` holds the Podbean upload date (`2015–2026`). Default `ORDER BY date DESC` sorted 2001 uploads into 2026 results, `matchesEpisodeFilters()` filtered Search by `(ep.date || '').startsWith(yStr)`, and cards displayed only `ep.date`.
4. **Naive Substring False Positives on Short Sutta Codes**:
   Filtering titles for short Nikāya codes like `"AN"` or `"DN"` via plain substring matching swept in hundreds of unrelated talks (`"Ajahn"`, `"Jhana"`, `"Kindness"`).
5. **Startup Initialization Race & Mobile Popover Overflow**:
   Waiting on `ensurePaliTermsLoaded()` before `router.handleRoute()` caused route initialization to run after initial UI readiness, and right-hand filter popovers overflowed narrow (`390px`) mobile viewports.

---

## 2. Architecture Flow

```text
+-------------------------------------------------------------------------------+
|               1. Worker In-Memory Metadata Index (db_worker.js)               |
+-------------------------------------------------------------------------------+
| rebuildEpisodesMetaCache() builds enriched metadata per episode:              |
|  - _teacherSlugs / teacher_slugs : union of episode_teachers + primary +      |
|    comma/delimiter-split identified_teachers & primary_display (stripped of   |
|    "(voiceprint ...)" notes; drops unknown_teacher when monastic identified)  |
|  - _normTitle     : foldDiacritics(title) for diacritic-insensitive matching  |
|  - _year          : true recorded year (fallback to date YYYY)                |
|  - _durMin/_durBucket : rounded minutes & bucket (<15, 15-30, 30-60, 60-90+)  |
|  - _categories    : boundary-safe Nikaya (MN/DN/SN/AN/KN), format & co-taught |
+-------------------------------------------------------------------------------+
                                       |
                                       v
+-------------------------------------------------------------------------------+
|           2. Multi-Faceted Query & Facet Counts (handleGetStats/Episodes)     |
+-------------------------------------------------------------------------------+
|  - Multi-monastic: teachers[] with teacherMatch = 'any' (OR) | 'all' (AND)    |
|  - Groupable years: years[] (OR union) + date range                           |
|  - Title query: matchesTitleQuery() supporting OR, "phrase", -exclude, and    |
|    letter/digit-boundary Whole Word mode ("AN" -> AN7.74, skips "Ajahn")      |
|  - Duration: multi-bucket selection or custom [minDurationMin, maxDurationMin]|
|  - Collection/Format/Attributes: OR within group, AND across groups           |
|  - Sort: year_desc (default in Browse), year_asc, date_desc/asc, duration, AZ |
+-------------------------------------------------------------------------------+
                                       |
                                       v
+-------------------------------------------------------------------------------+
|              3. Responsive Browse UI & URL State Sync (app.js)                |
+-------------------------------------------------------------------------------+
|  - Viewport-clamped filter popovers + active chip bar + in-place DOM updates  |
|  - highlightTitleText() diacritic-preserving <mark> highlighting              |
|  - buildBrowseRouteHash() / applyBrowseParamsFromRoute() (#browse?...)        |
|  - downloadBrowseFilteredArchive() ZIP export in md / txt / srt / vtt / json  |
+-------------------------------------------------------------------------------+
```

---

## 3. Solutions Implemented

- **[db_worker.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/db_worker.js)**:
  - `rebuildEpisodesMetaCache()`, `resolveTeacherToSlug()`, `classifyEpisodeCategories()`, `matchesTitleQuery()`, and `tokenMatchesTitle()`.
  - `handleGetStats()` returns `browse_teachers` (count-sorted active monastics), `year_counts`, `duration_counts`, and `category_counts` derived from the exact same cached metadata predicates used during filtering.
  - `handleGetEpisodes()` evaluates multi-monastic (`teachers`, `teacherMatch`), multi-year (`years`), title (`titleQuery`, `titleWholeWord`), duration (`durationBuckets`, `minDurationMin`, `maxDurationMin`), collection/format (`collections`, `formats`, `coTaughtOnly`, `episodeIds`), and sort options, returning `episodes`, `total`, `total_duration_sec`, and `all_episode_ids`.
  - `matchesEpisodeFilters()` uses exact slug matching and `ep._year` parity for Search filters as well.
- **[index.html](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/views/index.html)**, **[style.css](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/style.css)**, **[app.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/app.js)**:
  - Replaced the two single-select dropdowns with `#browse-filter-panel`, `#browse-active-summary`, and `#browse-filtered-archive-dropdown-wrapper`.
  - `setupBrowseFilterListeners()` manages viewport-clamped popovers, era presets (`Last 3 Yrs`, `2020s`–`1990s`), `Add Span` year ranges, custom duration bounds, active filter chips, and `✕ Reset`.
  - `init()` runs `loadArchiveStats()`, conditional `loadBrowseCatalog()`, and `router.handleRoute()` sequentially before preloading `ensurePaliTermsLoaded()` in the background.
  - `renderBrowseYearsGrid()` and `syncBrowseFilterControlsFromState()` preserve DOM nodes in place to maintain keyboard focus and checkbox state.

---

## 4. Verification

```powershell
python main.py web --build
pytest tests/test_export_web.py tests/test_browser_fuzzy_search.py tests/test_catalog.py tests/test_storage.py tests/test_cli.py tests/test_main_and_cli.py tests/test_lexicon_view.py -v
```

Key regression tests in [test_export_web.py](file:///c:/dev/deeper_dhamma/tests/test_export_web.py):
- `test_browse_multi_faceted_filtering_contract`
- `test_headless_chrome_browse_multi_faceted_filtering_e2e`
