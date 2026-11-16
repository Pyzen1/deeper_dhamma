# Search Stopword Explosion, Pagination & Click-to-Jump Precision

## 1. Symptoms

1. **Stopword Match Explosion (`"mindfulness of breathing"`)**:
   Searching `"mindfulness of breathing"` returned thousands of noisy sentence matches highlighting standalone `"of"` (and prefix variants `"off"`, `"often"`, `"offer"`), drowning out actual `"mindfulness of breathing"` occurrences and inflating match counts.
2. **Unbounded Search Result Lists & Date-First Default**:
   Searching broad terms rendered hundreds of talk cards at once, defaulted to `date_desc` instead of relevance (`rank`), and `rank` sorting ordered talk cards by raw sentence-match count (`matches.length`) rather than SQLite FTS5 `bm25(transcripts_fts)`.
3. **Click-to-Jump Location Drift**:
   Clicking a search result sentence (including typo-corrected queries like `"mindfullness of breathing"`) did not always land on the spoken phrase or audio timestamp:
   - Clicking a second talk read stale `WordSync.turnWordMap` timestamps from the previous talk.
   - Asynchronous `WordSync.prepareEpisode()` finished after `applyTargetOpts()` had already started playback at a linear `est_word_sec` estimate, and never re-seeked audio to the real Whisper timestamp.
   - Pre-seek `0:00` / prior-position `loadedmetadata` and `requestAnimationFrame` frames drove `WordSync.update()` in `track` mode to scroll back to the top or old position.
   - `scrollIntoView({ block: 'center' })` ignored `#transcript-sticky-toolbar` and `#audio-player-bar`, leaving target words occluded or off-screen after DOM re-renders.

---

## 2. Root Cause & Architecture Flow

```text
+-----------------------------------------------------------------------------+
| 1. Stopword-Aware Two-Stage FTS5 Search & 50-Talk Pagination (db_worker.js) |
+-----------------------------------------------------------------------------+
| Query ("mindfulness of breathing"):                                         |
|  - Tier 1 (exact_phrase): keeps stopwords -> "mindfulness of breathing"     |
|  - Tiers 2-6 (NEAR, prefix AND, fuzzy, quorum, OR): uses content words only |
|    (['mindfulness', 'breathing']) and disables '*' on <3-char/numeric tokens |
|  - Candidate scan across talks_1..4 shards -> episode filter & BM25 sort    |
|  - Slices [offset, offset + 50) episodes and hydrates snippets for page     |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| 2. Phrase-First Sentence Extraction & Reading-Zone Jump (app.js, word_sync) |
+-----------------------------------------------------------------------------+
|  - extractSentenceMatchesFromSegment() ignores APP_SEARCH_STOPWORDS and     |
|    locates exact phrase offset via phraseRegex.exec()                       |
|  - WordSync.prepareEpisodeSync() clears stale turnWordMap and parses        |
|    attached words_blob synchronously before initial render/jump             |
|  - WordSync._awaitingInitialSeek blocks pre-seek 0:00 / stale frames        |
|  - scrollElementIntoReadingZone() centers target between sticky toolbar &   |
|    bottom audio player bar; re-seeks if async enrichment shifts > 0.15s     |
+-----------------------------------------------------------------------------+
```

---

## 3. Solutions Implemented

### 3.1 Stopword Filtering & Two-Stage Sharded Pagination
- **[db_worker.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/db_worker.js)**:
  - `SEARCH_STOPWORDS`, `getContentWords()`, and `toPrefixTerm()` preserve stopwords in Tier 1 exact phrase queries while excluding them from Tiers 2–6 (`NEAR`, prefix `AND`, fuzzy, quorum, `OR`).
  - `handleSearchFTS()` runs a lightweight candidate query across all `talks_*` shards (`bm25(transcripts_fts)`), applies episode filters (`matchesEpisodeFilters()` with word-boundary teacher matching) and global episode sorting (`rank` combining best segment BM25 with logarithmic hit density, `date_desc`, `date_asc`, `duration_desc`), caches the sorted episode list in `searchCache`, and hydrates `snippet()` only for the current `[offset, offset + 50)` slice while returning `total_episodes`, `total_segments`, and `all_episode_ids`.
- **[storage.py](file:///c:/dev/deeper_dhamma/deeper_dhamma/storage.py)**:
  - Mirrors the same stopword filtering and `_to_prefix_term()` behavior in `TranscriptDatabase.search_fts()`.

### 3.2 Phrase-First Sentence Highlighting & Pagination UI
- **[app.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/app.js)**, **[index.html](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/views/index.html)**, **[style.css](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/style.css)**:
  - `extractSentenceMatchesFromSegment()` excludes `APP_SEARCH_STOPWORDS`, uses `meta.highlight_terms` and `meta.phrase` (`buildDiacriticPattern()`), prioritizes exact-phrase sentences, and calculates `firstMatchedWordIdx` directly from `phraseRegex.exec()` instead of earlier standalone occurrences of the lead word.
  - `#sort-order-select` defaults to `rank` (`Best Match (Relevance)`), and `renderSearchResults()` preserves the worker's global sort order.
  - `#search-pagination` (`« First`, `‹ Prev 50`, `#search-page-indicator`, `Next 50 ›`, `Last »`) paginates both search and filter-only queries at `50` talks per page while `downloadFilteredArchive()` still exports all `filteredEpisodeIds`.

### 3.3 Deterministic Click-to-Jump & Audio Seek Synchronization
- **[word_sync.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/word_sync.js)** & **[app.js](file:///c:/dev/deeper_dhamma/deeper_dhamma/web/static/app.js)**:
  - `WordSync.prepareEpisodeSync(episode)` resets stale `turnWordMap` on episode switches and parses attached `words_blob` synchronously before `renderDrawerTurns()`.
  - `WordSync._awaitingInitialSeek` prevents pre-seek `0:00` or stale-position frames from hijacking `WordSync.update()` / `syncProgress()` until `doSeek()` sets `audio.currentTime`, while preserving `WordSync._seekTargetWordTime` across same-episode enrichment.
  - `applyTargetOpts()` uses `matchedW.domId || matchedW.id`, validates `sentEl.contains(targetWordEl)`, scrolls via `scrollElementIntoReadingZone()` inside the unobstructed `[toolbarBottom .. playerTop]` band, and re-seeks if async word enrichment moves `exactWordSec` by `> 0.15s`.

---

## 4. Verification

```powershell
pytest tests/test_export_web.py tests/test_browser_fuzzy_search.py tests/test_storage.py
```

Key regression tests:
- `test_search_fts_stopword_filtering_prevents_of_explosion` in [test_storage.py](file:///c:/dev/deeper_dhamma/tests/test_storage.py)
- `test_headless_chrome_search_pagination_and_stopword_quality` in [test_export_web.py](file:///c:/dev/deeper_dhamma/tests/test_export_web.py)
- `test_headless_chrome_search_jump_to_exact_phrase_location` in [test_export_web.py](file:///c:/dev/deeper_dhamma/tests/test_export_web.py)
