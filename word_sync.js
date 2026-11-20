/**
 * Deeper Dhamma — Exact Word-Level Audio Synchronization & Serverless VBR Calibration Engine
 * 
 * Architecture (100% Static / Serverless Web Application):
 * - Compact Binary BLOB sidecars (`words/<episode_id>.bin`):
 *   - Section 1: 6 bytes/word `[uint32 start_ms, uint16 duration_ms]` in true 44.1 kHz PCM time.
 *   - Section 2: Optional `VBR1` seek calibration trailer containing `(pcm_ms, audio_byte_offset)`
 *     samples and the 100-byte `Xing` TOC across the full duration of the talk.
 * - Cross-Browser Direct Podbean CDN & VBR Neutralized Streaming:
 *   - For VBR episodes (`VBR1` trailer), `WordSync` progressively fetches the Podbean CDN MP3 via
 *     CORS `fetch()`, patches the 8-byte `Xing` header to `Info` (`flags = 3`) in client-side
 *     `Uint8Array` memory, and serves a zero-copy progressive `Blob` URL (`streamMode = 'patched_blob'`,
 *     `linearSeekTimes`) across Chromium, Firefox, and Safari with zero backend dependencies.
 *   - Playback Clock Lock: Once any seek lands at physical time `P`, the browser's 44.1 kHz PCM decoder
 *     advances `audio.currentTime` at `1.000s` per `1.000s` of physical speech. Tracking
 *     `physTime = audio.currentTime + seekOffset` eliminates intra-turn VBR bitrate drift.
 * 
 * See `docs/troubleshooting/vbr_audio_sync.md` for full mathematical and architectural details.
 */

(function () {
  'use strict';

  const WordSync = {
    // Global in-memory word synchronization mode: 'off' | 'on' | 'track'
    mode: 'track',

    get enabled() {
      return this.mode !== 'off';
    },
    set enabled(val) {
      this.setMode(val ? 'track' : 'off');
    },

    currentEpisodeId: null,
    playingEpisodeId: null,
    currentEpisode: null,
    dbClient: null,
    words: [], // Sorted array of exact physical words: [{ s, e, turnIdx, wordIdx, id }]
    wordsEpisodeId: null,
    turnWordMap: {}, // Map of turnIdx -> [words]
    turnWordMapEpisodeId: null,
    vbrData: null, // Parsed VBR1 seek table if episode is VBR
    vbrCache: {}, // Cache of episodeId -> { words, vbrData, bytesLoaded }
    _loadingPromises: {}, // Deduplicated in-flight loadWordsBlob promises keyed by episodeId
    streamMode: 'cdn', // 'cdn' | 'patched_blob' | 'mse_vbr'
    seekOffset: 0.0, // Constant physical-minus-stream clock offset established at last seek
    _seekTargetWordTime: null, // Optional exact word start time targeted by the latest seek
    _pendingProgrammaticSeek: false,
    _awaitingInitialSeek: false,
    _syncPhase: 'idle', // 'idle' | 'buffering' | 'seeking' | 'playing'
    _seekSeq: 0,
    _lockedWordIdx: -1,
    _lockedCompanionIdx: -1,
    onCompanionLock: null,
    _ffStreams: {}, // Client-side progressive Fetch + Xing->Info patched Blob state keyed by media_url
    _mse: null, // Active MediaSource frame-aligned VBR session
    _mseFailed: {}, // Cache of media_url -> true when Range/MSE is unavailable
    isFirefox: typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || ''),
    activeWordEl: null,
    activeWordIdx: -1,
    paliTermsMap: new Map(),
    paliFirstWordsSet: new Set(),
    _lastSpokenWordId: null,
    onPaliTermSpoken: null,
    _lastClockSecond: -1,
    onClockTick: null,
    metrics: {
      format: 'binary_blob',
      bytesLoaded: 0,
      wordCount: 0,
      loadMs: 0,
    },

    _rafId: null,
    _boundAudio: null,
    _userInteractedAt: 0,
    _programmaticScrollUntil: 0,
    _scrollTarget: null, // { top, until, ratio } unified smooth-scroll target
    _teleprompterLine: null,

    /**
     * Initializes WordSync.
     */
    init: function () {
      this.updateUI();
      if (typeof window !== 'undefined') {
        window.addEventListener('wheel', (e) => this.handleUserInteraction(e), { passive: true });
        window.addEventListener('touchmove', (e) => this.handleUserInteraction(e), { passive: true });
        window.addEventListener('resize', () => { this._teleprompterLine = null; }, { passive: true });
      }
    },

    /**
     * Handles manual user interaction (wheel/touch) on the transcript view by pausing teleprompter auto-centering.
     * Scrolling inside the Lexicon Companion panel does not pause transcript tracking.
     */
    handleUserInteraction: function (evt) {
      if (evt && evt.target && evt.target.closest && evt.target.closest('#transcript-lexicon-companion')) {
        return;
      }
      this._programmaticScrollUntil = 0;
      this._scrollTarget = null;
      this._userInteractedAt = performance.now();
    },

    /**
     * Starts a canonical monotonic seek transaction across async fetches, <audio> seeks,
     * active word highlights, companion card locks, and reading-zone scrolling.
     */
    beginSeek: function (opts = {}) {
      const seq = ++this._seekSeq;
      if (this._mse && this._mse.abortCtrl) {
        try { this._mse.abortCtrl.abort(); } catch (_) {}
        this._mse.abortCtrl = null;
        this._mse.fetchingNext = false;
      }
      this._syncPhase = 'buffering';
      this._pendingProgrammaticSeek = true;
      this._awaitingInitialSeek = true;
      this._seekTargetWordTime = typeof opts.wordStartSec === 'number' ? opts.wordStartSec : null;
      this._teleprompterLine = null;
      this._lastClockSecond = -1;

      let lockedWordIdx = typeof opts.wordIdx === 'number' && !isNaN(opts.wordIdx) ? opts.wordIdx : -1;
      if (opts.wordEl) {
        this.setActiveWordElement(opts.wordEl, lockedWordIdx);
        lockedWordIdx = this.activeWordIdx;
      }
      this._lockedWordIdx = lockedWordIdx;
      this._lockedCompanionIdx = typeof opts.companionIdx === 'number' ? opts.companionIdx : -1;
      return seq;
    },

    isCurrentSeek: function (seq) {
      return seq === this._seekSeq;
    },

    isSeekLocked: function () {
      return this._syncPhase === 'buffering' || this._awaitingInitialSeek || Boolean(this._boundAudio && this._boundAudio.seeking && this._syncPhase === 'seeking');
    },

    isPlayingCurrentTranscript: function () {
      return !this.playingEpisodeId || this.currentEpisodeId === this.playingEpisodeId;
    },

    isEpisodeWordsLoaded: function (episodeId) {
      if (!episodeId) return false;
      if (this.wordsEpisodeId === episodeId && Array.isArray(this.words) && this.words.length > 0) {
        return true;
      }
      const cached = this.vbrCache && this.vbrCache[episodeId];
      return Boolean(cached && Array.isArray(cached.words) && cached.words.length > 0);
    },

    getPlayingVbrData: function () {
      if (this.playingEpisodeId) {
        if (this.vbrCache && this.vbrCache[this.playingEpisodeId]) {
          return this.vbrCache[this.playingEpisodeId].vbrData || null;
        }
        if (
          this.wordsEpisodeId === this.playingEpisodeId ||
          (!this.wordsEpisodeId && this.currentEpisodeId === this.playingEpisodeId)
        ) {
          return this.vbrData || null;
        }
        return null;
      }
      return this.vbrData || null;
    },

    /**
     * Injects the database service adapter for self-referential in-browser SQLite WASM queries.
     */
    setDbClient: function (client) {
      this.dbClient = client;
    },

    /**
     * Strips and normalizes Pali diacritics to standard Latin.
     * Features an instant ASCII fast-path to eliminate redundant NFD normalization
     * over standard English vocabulary.
     */
    foldDiacritics: function (str) {
      if (!str) return '';
      if (!/[^\x00-\x7F]/.test(str)) {
        return str.toLowerCase();
      }
      return str
        .replace(/[ṁṃŋ]/g, 'm')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    },

    /**
     * Ingests canonical Pali terms and establishes fast multi-keyed Map index
     * supporting single words, multi-word canonical phrases, hyphenated compounds,
     * and closed/spaced compound variants.
     */
    setPaliTerms: function (terms) {
      this.paliTermsMap.clear();
      this.paliFirstWordsSet.clear();
      if (!Array.isArray(terms)) return;

      const registerKey = (rawKey, termObj) => {
        if (!rawKey) return;
        const k = String(rawKey).trim().toLowerCase().replace(/\s+/g, ' ');
        if (!k) return;
        if (!this.paliTermsMap.has(k)) {
          this.paliTermsMap.set(k, termObj);
        }
        const firstW = k.split(' ')[0];
        if (firstW) {
          this.paliFirstWordsSet.add(firstW);
        }
        const folded = this.foldDiacritics(k);
        if (folded && !this.paliTermsMap.has(folded)) {
          this.paliTermsMap.set(folded, termObj);
        }
        if (folded) {
          const firstFolded = folded.split(' ')[0];
          if (firstFolded) {
            this.paliFirstWordsSet.add(firstFolded);
          }
        }
      };

      for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        if (!t) continue;
        if (t.pali_plain) {
          const plain = t.pali_plain.trim().toLowerCase();
          registerKey(plain, t);
          if (plain.includes('-')) {
            registerKey(plain.replace(/-/g, ' '), t);
            registerKey(plain.replace(/-/g, ''), t);
          }
          if (plain.includes(' ')) {
            registerKey(plain.replace(/\s+/g, ''), t);
            registerKey(plain.replace(/\s+/g, '-'), t);
          }
        }
        if (t.pali_diacritic) {
          const dia = t.pali_diacritic.trim().toLowerCase();
          registerKey(dia, t);
          if (dia.includes('-')) {
            registerKey(dia.replace(/-/g, ' '), t);
          }
          if (dia.includes(' ')) {
            registerKey(dia.replace(/\s+/g, '-'), t);
          }
        }
        let variants = t.phonetic_variants;
        if (typeof variants === 'string') {
          try {
            variants = JSON.parse(variants);
          } catch (_) {
            variants = [];
          }
        }
        if (Array.isArray(variants)) {
          for (let j = 0; j < variants.length; j++) {
            registerKey(variants[j], t);
          }
        }
      }
    },

    /**
     * Checks if a single token corresponds to a registered canonical Pali term.
     */
    matchPaliTerm: function (token) {
      if (!token || !this.paliTermsMap || this.paliTermsMap.size === 0) return null;
      const clean = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
      if (clean.length < 3) return null;
      if (
        this.paliFirstWordsSet.size > 0 &&
        !this.paliFirstWordsSet.has(clean) &&
        !this.paliFirstWordsSet.has(this.foldDiacritics(clean))
      ) {
        return null;
      }
      return this.paliTermsMap.get(clean) || this.paliTermsMap.get(this.foldDiacritics(clean)) || null;
    },

    /**
     * Greedily matches the longest canonical Pali phrase (up to 4 words) or single term
     * starting at `tokens[startIdx]` (where `tokens = sent.split(/(\s+)/)`).
     */
    matchPhraseAt: function (tokens, startIdx) {
      if (!tokens || startIdx >= tokens.length || !this.paliTermsMap || this.paliTermsMap.size === 0) {
        return null;
      }

      const rawTok0 = tokens[startIdx];
      if (!rawTok0 || /^\s+$/.test(rawTok0)) return null;
      const clean0 = rawTok0.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
      if (!clean0 || clean0.length < 3) return null;

      // Fast set lookup for the first word/prefix across all registered terms.
      // Skips candidate slicing and NFD normalization for ~98% of standard English vocabulary.
      if (
        this.paliFirstWordsSet.size > 0 &&
        !this.paliFirstWordsSet.has(clean0) &&
        !this.paliFirstWordsSet.has(this.foldDiacritics(clean0))
      ) {
        return null;
      }

      const candidates = [{ tokenIndex: startIdx, raw: rawTok0, clean: clean0 }];
      if (!/[,;:!?\)\]\u201d"']$/.test(rawTok0)) {
        for (let step = 1; step < 4; step++) {
          const ti = startIdx + step * 2;
          if (ti >= tokens.length) break;
          const rawTok = tokens[ti];
          if (!rawTok || /^\s+$/.test(rawTok)) break;
          const clean = rawTok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
          if (!clean) break;
          candidates.push({ tokenIndex: ti, raw: rawTok, clean });
          // Do not bridge across clause-separating punctuation at the end of a token
          if (/[,;:!?\)\]\u201d"']$/.test(rawTok)) break;
        }
      }

      for (let k = candidates.length; k >= 1; k--) {
        if (k === 1) {
          const single = candidates[0].clean;
          if (single.length < 3) return null;
          const term = this.paliTermsMap.get(single) || this.paliTermsMap.get(this.foldDiacritics(single));
          if (term) {
            return { term, wordCount: 1, endTokenIndex: candidates[0].tokenIndex };
          }
        } else {
          const slice = candidates.slice(0, k);
          const spaced = slice.map(c => c.clean).join(' ');
          const closed = slice.map(c => c.clean).join('');
          const term =
            this.paliTermsMap.get(spaced) ||
            this.paliTermsMap.get(this.foldDiacritics(spaced)) ||
            this.paliTermsMap.get(closed) ||
            this.paliTermsMap.get(this.foldDiacritics(closed));
          if (term) {
            return { term, wordCount: k, endTokenIndex: slice[k - 1].tokenIndex };
          }
        }
      }

      return null;
    },

    /**
     * Binds an HTML5 audio element for high-frequency 60fps word synchronization.
     * Replaces sluggish 250ms timeupdate polling with a smooth animation frame loop.
     */
    bindAudio: function (audio) {
      if (!audio || this._boundAudio === audio) return;
      this._boundAudio = audio;

      const onPlay = () => this.startLoop();
      const onPause = () => {
        if (!this._scrollTarget) {
          this.stopLoop();
        }
      };
      const onSeeked = () => {
        this._lastSpokenWordId = null;
        if (this._pendingProgrammaticSeek) {
          if (!audio.seeking) {
            this._pendingProgrammaticSeek = false;
            this._syncPhase = audio.paused ? 'idle' : 'playing';
          }
        } else {
          const vbr = this.getPlayingVbrData();
          if (vbr) {
            // External/native seek not initiated via prepareSeek: infer physical offset
            this._syncPhase = audio.paused ? 'idle' : 'playing';
            const rawT = audio.currentTime;
            if (this.streamMode === 'mse_vbr' || rawT <= 0.05) {
              this.seekOffset = 0.0;
            } else if (this.streamMode === 'patched_blob') {
              const physT = this._interp(rawT, vbr.linearSeekTimes, vbr.pcmTimes);
              this.seekOffset = physT - rawT;
            } else if (this.isFirefox) {
              const k = Math.max(0, Math.min(99, Math.floor((rawT / vbr.totalDurSec) * 100)));
              this.seekOffset = vbr.ffBucketDeltas[k] || 0.0;
            } else {
              const physT = this._interp(rawT, vbr.xingSeekTimes, vbr.pcmTimes);
              this.seekOffset = physT - rawT;
            }
          }
        }
        if (this.isPlayingCurrentTranscript()) {
          this.update(audio.currentTime);
        }
      };

      audio.addEventListener('play', onPlay);
      audio.addEventListener('playing', onPlay);
      audio.addEventListener('pause', onPause);
      audio.addEventListener('ended', onPause);
      audio.addEventListener('seeked', onSeeked);

      if (!audio.paused) {
        this.startLoop();
      }
    },

    startLoop: function () {
      if (this._rafId) return;
      const step = () => {
        if (this._scrollTarget) {
          this._stepScrollAnimation();
        }
        if (this._boundAudio && !this._boundAudio.paused) {
          if (this.streamMode === 'mse_vbr') {
            this.maybePrefetchMseNextChunk(this._boundAudio);
          }
          if (this.isPlayingCurrentTranscript()) {
            this.update(this._boundAudio.currentTime);
          }
          this._rafId = requestAnimationFrame(step);
        } else if (this._scrollTarget) {
          this._rafId = requestAnimationFrame(step);
        } else {
          this._rafId = null;
        }
      };
      this._rafId = requestAnimationFrame(step);
    },

    stopLoop: function () {
      if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
    },

    /**
     * Sets the word synchronization mode ('off' | 'on' | 'track').
     */
    setMode: function (newMode) {
      if (!['off', 'on', 'track'].includes(newMode)) return this.mode;
      this.mode = newMode;
      this._teleprompterLine = null;
      this._userInteractedAt = 0;
      if (this.mode === 'off') {
        this.clearHighlights();
      }
      this.updateUI();
      return this.mode;
    },

    /**
     * Cycles word synchronization mode: off -> on -> track -> off.
     */
    cycleMode: function () {
      const modes = ['off', 'on', 'track'];
      const nextIdx = (modes.indexOf(this.mode) + 1) % modes.length;
      return this.setMode(modes[nextIdx]);
    },

    /**
     * Toggles word synchronization on or off (backward compatibility).
     */
    toggle: function (forceState) {
      if (typeof forceState === 'boolean') {
        return this.setMode(forceState ? (this.mode === 'off' ? 'track' : this.mode) : 'off') !== 'off';
      }
      return this.setMode(this.mode === 'off' ? 'track' : 'off') !== 'off';
    },

    /**
     * Moves active word highlight cleanly to `el` (or clears when `el` is null)
     * while keeping `activeWordIdx` and `_lastSpokenWordId` synchronized.
     */
    setActiveWordElement: function (el, wordIdx) {
      if (this.activeWordEl && this.activeWordEl !== el) {
        this.activeWordEl.classList.remove('active-word');
      }
      if (el) {
        el.classList.add('active-word');
        this.activeWordEl = el;
        let resolvedIdx = typeof wordIdx === 'number' && !isNaN(wordIdx) ? wordIdx : -1;
        if (resolvedIdx < 0 && el.id && el.id.startsWith('tw-')) {
          const parsed = parseInt(el.id.slice(3), 10);
          if (!isNaN(parsed)) resolvedIdx = parsed;
        }
        this.activeWordIdx = resolvedIdx;
        this._lastSpokenWordId = el.id || null;
      } else {
        this.activeWordEl = null;
        this.activeWordIdx = -1;
        this._lastSpokenWordId = null;
      }
    },

    /**
     * Clears active highlights.
     */
    clearHighlights: function () {
      this.setActiveWordElement(null);
    },

    /**
     * Updates segmented word sync controls.
     */
    updateUI: function () {
      const segControl = document.getElementById('segmented-word-sync-control');
      if (segControl) {
        const btns = segControl.querySelectorAll('.seg-btn');
        btns.forEach(btn => {
          const btnMode = btn.dataset.mode;
          if (btnMode === this.mode) {
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');
          } else {
            btn.classList.remove('active');
            btn.setAttribute('aria-pressed', 'false');
          }
        });
      }
    },

    /**
     * Synchronously parses `episode.words_blob` and indexes `turnWordMap` when the BLOB
     * is already attached to `episode`. Returns true if word timings are immediately ready.
     */
    prepareEpisodeSync: function (episode) {
      if (!episode) return false;
      const epId = episode.id || episode.episode_id;
      const alreadyPrepared =
        this.currentEpisodeId === epId &&
        this.wordsEpisodeId === epId &&
        this.turnWordMapEpisodeId === epId &&
        this.words.length > 0 &&
        Object.keys(this.turnWordMap || {}).length > 0;
      if (alreadyPrepared) {
        this.currentEpisode = episode;
        return true;
      }

      const isSameEpisode = this.currentEpisodeId === epId;
      this.currentEpisodeId = epId;
      this.currentEpisode = episode;
      this.words = [];
      this.wordsEpisodeId = null;
      this.vbrData = null;
      this.turnWordMap = {};
      this.turnWordMapEpisodeId = null;
      this._teleprompterLine = null;
      this._userInteractedAt = 0;
      if (!isSameEpisode && (!this.playingEpisodeId || this.playingEpisodeId === epId)) {
        this._pendingProgrammaticSeek = false;
        this._awaitingInitialSeek = false;
        this._seekTargetWordTime = null;
        this._syncPhase = 'idle';
        this._lockedWordIdx = -1;
        this._lockedCompanionIdx = -1;
        this._scrollTarget = null;
        this._lastClockSecond = -1;
      }
      this.clearHighlights();

      if (episode.words_blob) {
        const parsed = this.parseWordsBuffer(episode.words_blob, epId);
        if (parsed && episode.segments && this.wordsEpisodeId === epId && this.words.length > 0) {
          this.indexWordsByTurn(episode.segments, epId);
          this.metrics.wordCount = this.words.length;
          return true;
        }
      } else if (this.vbrCache && this.vbrCache[epId]) {
        const cached = this.vbrCache[epId];
        this.words = cached.words || [];
        this.vbrData = cached.vbrData || null;
        this.wordsEpisodeId = epId;
        this.metrics.bytesLoaded = cached.bytesLoaded || 0;
        this.metrics.format = 'option_c_bin';
        if (episode.segments && this.words.length > 0) {
          this.indexWordsByTurn(episode.segments, epId);
          this.metrics.wordCount = this.words.length;
          return true;
        }
      }
      return false;
    },

    /**
     * Prepares exact word timestamps and VBR seek calibration for an episode.
     */
    prepareEpisode: async function (episode) {
      if (!episode) return;
      const epId = episode.id || episode.episode_id;
      const t0 = performance.now();
      const readySync = this.prepareEpisodeSync(episode);

      if (!readySync) {
        if (this.wordsEpisodeId !== epId || this.words.length === 0) {
          await this.loadWordsBlob(epId);
        }
        if (this.currentEpisodeId !== epId) {
          return;
        }
        // Group words by segment turn if turns exist
        if (episode.segments && this.wordsEpisodeId === epId && this.words.length > 0) {
          this.indexWordsByTurn(episode.segments, epId);
        }
      }

      if (this.currentEpisodeId !== epId) {
        return;
      }
      this.metrics.loadMs = Math.round(performance.now() - t0);
      this.metrics.wordCount = this.words.length;

      // Proactively start progressive VBR stream buffering ONLY when MSE audio/mpeg is unsupported or unavailable
      if (this.vbrData && episode.media_url && (!this.isMseVbrSupported() || this._mseFailed[episode.media_url])) {
        this.ensurePatchedStream(episode.media_url, this.vbrData);
      }

      this.updateUI();
    },

    /**
     * Ensures word timings and VBR calibration data are loaded for an episode ID
     * (e.g. when starting playback directly from a search result card).
     */
    ensureEpisodeLoaded: async function (episodeId) {
      if (!episodeId) return;
      if (this.currentEpisodeId === episodeId && this.wordsEpisodeId === episodeId && this.words.length > 0) {
        if (
          this.turnWordMapEpisodeId !== episodeId &&
          this.currentEpisode &&
          (this.currentEpisode.id || this.currentEpisode.episode_id) === episodeId &&
          this.currentEpisode.segments
        ) {
          this.indexWordsByTurn(this.currentEpisode.segments, episodeId);
        }
        return;
      }
      if (!this.currentEpisodeId || this.currentEpisodeId !== episodeId) {
        this.currentEpisodeId = episodeId;
        this.turnWordMap = {};
        this.turnWordMapEpisodeId = null;
      }
      await this.loadWordsBlob(episodeId);
      if (
        this.currentEpisodeId === episodeId &&
        this.wordsEpisodeId === episodeId &&
        this.words.length > 0 &&
        this.turnWordMapEpisodeId !== episodeId &&
        this.currentEpisode &&
        (this.currentEpisode.id || this.currentEpisode.episode_id) === episodeId &&
        this.currentEpisode.segments
      ) {
        this.indexWordsByTurn(this.currentEpisode.segments, episodeId);
      }
    },

    /**
     * Parses a binary words BLOB (ArrayBuffer, Uint8Array, or ArrayBufferView)
     * containing physical word timestamps and optional VBR1 trailer.
     */
    parseWordsBuffer: function (inputBuffer, episodeId) {
      if (!inputBuffer) return false;
      let buf = null;
      let view = null;
      if (inputBuffer instanceof ArrayBuffer) {
        buf = inputBuffer;
        view = new DataView(buf);
      } else if (ArrayBuffer.isView(inputBuffer)) {
        buf = inputBuffer.buffer.slice(
          inputBuffer.byteOffset,
          inputBuffer.byteOffset + inputBuffer.byteLength
        );
        view = new DataView(buf);
      } else if (inputBuffer.buffer && typeof inputBuffer.byteLength === 'number') {
        buf = inputBuffer.buffer;
        view = new DataView(buf, inputBuffer.byteOffset || 0, inputBuffer.byteLength);
      } else {
        return false;
      }

      const byteLength = buf.byteLength;
      if (byteLength < 4) return false;

      const wordCount = view.getUint32(0, true);
      const words = [];
      let offset = 4;

      for (let i = 0; i < wordCount; i++) {
        if (offset + 6 > byteLength) break;
        const stMs = view.getUint32(offset, true);
        const durMs = view.getUint16(offset + 4, true);
        words.push({
          id: `tw-${i}`,
          s: stMs / 1000,
          e: (stMs + durMs) / 1000,
          globalIdx: i,
        });
        offset += 6;
      }

      let vbrData = null;
      if (offset + 120 <= byteLength) {
        const m0 = view.getUint8(offset);
        const m1 = view.getUint8(offset + 1);
        const m2 = view.getUint8(offset + 2);
        const m3 = view.getUint8(offset + 3);
        // 'VBR1' = 0x56, 0x42, 0x52, 0x31
        if (m0 === 0x56 && m1 === 0x42 && m2 === 0x52 && m3 === 0x31) {
          vbrData = this._parseVbrTrailer(buf, view, offset);
        }
      }

      if (episodeId) {
        this.vbrCache[episodeId] = {
          words: words,
          vbrData: vbrData,
          bytesLoaded: byteLength,
        };
      }
      if (!episodeId || !this.currentEpisodeId || this.currentEpisodeId === episodeId) {
        this.words = words;
        this.vbrData = vbrData;
        this.wordsEpisodeId = episodeId || this.currentEpisodeId || null;
        this.metrics.bytesLoaded = byteLength;
        this.metrics.format = 'option_c_bin';
      }
      return true;
    },

    /**
     * Loads compact binary word BLOB and optional `VBR1` trailer.
     * First queries in-browser SQLite WASM database directly (100% self-referential / offline).
     * Falls back to network candidate URLs if running in standalone test harnesses.
     */
    loadWordsBlob: async function (episodeId) {
      if (!episodeId) return;
      if (this.vbrCache[episodeId]) {
        const cached = this.vbrCache[episodeId];
        if (!this.currentEpisodeId || this.currentEpisodeId === episodeId) {
          this.words = cached.words;
          this.vbrData = cached.vbrData;
          this.wordsEpisodeId = episodeId;
          this.metrics.bytesLoaded = cached.bytesLoaded;
          this.metrics.format = 'option_c_bin';
        }
        return;
      }

      if (this._loadingPromises && this._loadingPromises[episodeId]) {
        await this._loadingPromises[episodeId];
        if (this.vbrCache[episodeId] && (!this.currentEpisodeId || this.currentEpisodeId === episodeId)) {
          const cached = this.vbrCache[episodeId];
          this.words = cached.words;
          this.vbrData = cached.vbrData;
          this.wordsEpisodeId = episodeId;
          this.metrics.bytesLoaded = cached.bytesLoaded;
          this.metrics.format = 'option_c_bin';
        }
        return;
      }

      const loadPromise = (async () => {
        // 1. Direct from in-browser SQLite WASM database (100% self-referential / offline)
        const db = this.dbClient || window.dbClient || (window.__deeperDhammaDbClient || null);
        if (db && typeof db.getEpisodeWords === 'function') {
          try {
            const blob = await db.getEpisodeWords(episodeId);
            if (blob && (blob.byteLength || (blob.length && blob.buffer))) {
              const parsed = this.parseWordsBuffer(blob, episodeId);
              if (parsed) return true;
            }
          } catch (dbErr) {
            console.warn('[WordSync] Database query notice for words:', dbErr);
          }
        }

        // 2. Fallback to API endpoint if dynamic backend or running external test harness
        const candidateUrls = [
          `/api/episodes/${encodeURIComponent(episodeId)}/words`,
          `./api/episodes/${encodeURIComponent(episodeId)}/words`,
        ];

        for (const url of candidateUrls) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const buf = await res.arrayBuffer();
              if (this.parseWordsBuffer(buf, episodeId)) return true;
            }
          } catch (_) {}
        }
        return false;
      })();

      this._loadingPromises[episodeId] = loadPromise;
      try {
        const ok = await loadPromise;
        if (!ok && (!this.currentEpisodeId || this.currentEpisodeId === episodeId)) {
          this.words = [];
          this.vbrData = null;
          this.wordsEpisodeId = null;
          this.metrics.bytesLoaded = 0;
        }
      } finally {
        if (this._loadingPromises && this._loadingPromises[episodeId] === loadPromise) {
          delete this._loadingPromises[episodeId];
        }
      }
    },

    /**
     * Decodes the `VBR1` seek calibration trailer from the `.bin` ArrayBuffer.
     */
    _parseVbrTrailer: function (buf, view, offset) {
      const totalDurSec = view.getUint32(offset + 4, true) / 1000.0;
      const id3Len = view.getUint32(offset + 8, true);
      const bytesLen = view.getUint32(offset + 12, true);
      const toc = new Uint8Array(buf, offset + 16, 100);
      const sampleCount = view.getUint32(offset + 116, true);

      let pOff = offset + 120;
      const actualCount = Math.min(sampleCount, Math.floor((buf.byteLength - pOff) / 8));
      if (actualCount <= 0 || totalDurSec <= 0 || bytesLen <= 0) {
        return null;
      }

      const pcmTimes = new Float64Array(actualCount);
      const byteOffsets = new Float64Array(actualCount);
      const linearSeekTimes = new Float64Array(actualCount);
      const xingSeekTimes = new Float64Array(actualCount);

      for (let i = 0; i < actualCount; i++) {
        const pcmSec = view.getUint32(pOff, true) / 1000.0;
        const audioByteOff = view.getUint32(pOff + 4, true);
        pOff += 8;

        pcmTimes[i] = pcmSec;
        byteOffsets[i] = audioByteOff;
        const linearT = (audioByteOff / bytesLen) * totalDurSec;
        linearSeekTimes[i] = linearT;

        // Compute Chromium FFmpeg Xing TOC seek time
        const frac = (audioByteOff / bytesLen) * 256.0;
        let xingT = linearT;
        if (frac <= toc[0]) {
          xingT = toc[0] > 0 ? (frac / toc[0]) * (1.0 / 100.0) * totalDurSec : 0.0;
        } else {
          let found = false;
          for (let k = 0; k < 99; k++) {
            if (toc[k] <= frac && frac <= toc[k + 1]) {
              const d = toc[k + 1] - toc[k];
              const f = d > 0 ? (frac - toc[k]) / d : 0.0;
              xingT = ((k + f) / 100.0) * totalDurSec;
              found = true;
              break;
            }
          }
          if (!found) {
            const d = 256.0 - toc[99];
            const f = d > 0 ? (frac - toc[99]) / d : 0.0;
            xingT = ((99 + f) / 100.0) * totalDurSec;
          }
        }
        xingSeekTimes[i] = xingT;
      }

      // Precompute Firefox Gecko MP3TrackDemuxer bucket deltas for raw CDN fallback
      const ffBucketDeltas = new Float64Array(100);
      for (let k = 0; k < 100; k++) {
        const rawOff = Math.floor(bytesLen * (toc[k] / 256.0));
        const audioOff = Math.max(0, rawOff - id3Len);
        const tAvg = (audioOff / bytesLen) * totalDurSec;
        const tPhys = this._interp(audioOff, byteOffsets, pcmTimes);
        ffBucketDeltas[k] = tPhys - tAvg;
      }

      return {
        totalDurSec,
        id3Len,
        bytesLen,
        toc,
        pcmTimes,
        byteOffsets,
        linearSeekTimes,
        xingSeekTimes,
        ffBucketDeltas,
      };
    },

    /**
     * Pure Client-Side Progressive Fetch & In-Memory `Xing -> Info` Patcher for Firefox.
     * Streams the MP3 from Podbean CDN (`Access-Control-Allow-Origin: *`), patches the 8-byte
     * `Xing` header to `Info\x00\x00\x00\x03` in browser RAM (`Uint8Array`), and builds
     * progressive zero-copy `Blob` URLs so Firefox seeks linearly with zero dead zones
     * on any static web host without any backend server.
     */
    /**
     * Progressively fetches `mediaUrl` via CORS and patches its `Xing` header to `Info`
     * (`flags = 3`) in client-side RAM so all browsers (Chromium, Firefox, Safari) seek cleanly
     * via deterministic linear byte offsets without coarse `Xing TOC` quantization drift.
     */
    ensurePatchedStream: function (mediaUrl, vbrOverride = null) {
      const vbr = vbrOverride || this.getPlayingVbrData() || this.vbrData;
      if (!mediaUrl || !vbr) return null;
      if (this._ffStreams[mediaUrl]) {
        return this._ffStreams[mediaUrl];
      }

      // Evict oldest stream entries if more than 3 VBR talks are cached in memory
      const existingKeys = Object.keys(this._ffStreams);
      if (existingKeys.length >= 3) {
        const oldestKey = existingKeys[0];
        const evicted = this._ffStreams[oldestKey];
        delete this._ffStreams[oldestKey];
        if (evicted) {
          if (evicted.controller) {
            try { evicted.controller.abort(); } catch (_) {}
          }
          if (evicted.blobUrl) {
            const staleUrl = evicted.blobUrl;
            setTimeout(() => {
              try { URL.revokeObjectURL(staleUrl); } catch (_) {}
            }, 5000);
          }
        }
      }

      const id3Len = vbr.id3Len || 0;
      const minHeaderBytes = id3Len + 1024;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const state = {
        mediaUrl,
        controller,
        chunks: [],
        headerBufs: [],
        fetchedBytes: 0,
        patched: false,
        done: false,
        failed: false,
        blobUrl: null,
        blobBytes: 0,
        waiters: [],
      };
      this._ffStreams[mediaUrl] = state;

      const notifyWaiters = () => {
        for (let i = state.waiters.length - 1; i >= 0; i--) {
          const w = state.waiters[i];
          if (state.failed || state.done || (state.patched && state.fetchedBytes >= w.requiredBytes)) {
            state.waiters.splice(i, 1);
            w.resolve(state);
          }
        }
      };

      (async () => {
        try {
          const res = await fetch(mediaUrl, controller ? { signal: controller.signal } : undefined);
          if (!res.ok || !res.body) {
            state.failed = true;
            notifyWaiters();
            return;
          }
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              state.done = true;
              notifyWaiters();
              break;
            }
            if (value && value.byteLength > 0) {
              state.fetchedBytes += value.byteLength;
              if (!state.patched) {
                state.headerBufs.push(value);
                if (state.fetchedBytes >= minHeaderBytes) {
                  const merged = new Uint8Array(state.fetchedBytes);
                  let off = 0;
                  for (const b of state.headerBufs) {
                    merged.set(b, off);
                    off += b.byteLength;
                  }
                  state.headerBufs = [];
                  // Locate "Xing" (0x58, 0x69, 0x6e, 0x67) after id3Len and patch to "Info\x00\x00\x00\x03"
                  const searchEnd = Math.min(merged.byteLength - 8, id3Len + 4096);
                  for (let p = id3Len; p <= searchEnd; p++) {
                    if (
                      merged[p] === 0x58 &&
                      merged[p + 1] === 0x69 &&
                      merged[p + 2] === 0x6e &&
                      merged[p + 3] === 0x67
                    ) {
                      const patch = [0x49, 0x6e, 0x66, 0x6f, 0x00, 0x00, 0x00, 0x03];
                      for (let k = 0; k < 8; k++) {
                        merged[p + k] = patch[k];
                      }
                      break;
                    }
                  }
                  state.chunks.push(merged);
                  state.patched = true;
                }
              } else {
                state.chunks.push(value);
              }
              notifyWaiters();
            }
          }
        } catch (err) {
          if (!err || err.name !== 'AbortError') {
            console.warn('[WordSync] Progressive patched stream fetch fallback:', err);
          }
          state.failed = true;
          notifyWaiters();
        }
      })();

      return state;
    },

    /** Backward-compatible alias for Firefox stream helper callers. */
    ensureFirefoxPatchedStream: function (mediaUrl) {
      return this.ensurePatchedStream(mediaUrl);
    },

    /**
     * Computes the byte offset in the MP3 file required to seek and play at `targetPhysicalSec`.
     */
    getRequiredBytesForTime: function (targetPhysicalSec) {
      const vbr = this.getPlayingVbrData();
      if (!vbr) return 0;
      const audioByteOff = this._interp(
        Math.max(0, targetPhysicalSec),
        vbr.pcmTimes,
        vbr.byteOffsets
      );
      // Include ID3 header + target audio byte offset + 512 KB read-ahead (~45s of audio)
      return Math.min(
        vbr.id3Len + vbr.bytesLen,
        Math.ceil(vbr.id3Len + audioByteOff + 524288)
      );
    },

    /**
     * Synchronously returns a patched `blob:` URL if sufficient bytes are already buffered in RAM,
     * or `null` if still buffering.
     */
    getReadyPatchedBlobUrl: function (mediaUrl, targetPhysicalSec) {
      const vbr = this.getPlayingVbrData();
      if (!vbr || !mediaUrl) return null;
      const state = this.ensurePatchedStream(mediaUrl, vbr);
      if (!state || state.failed || !state.patched) return null;

      const reqBytes = this.getRequiredBytesForTime(targetPhysicalSec);
      if (!state.done && state.fetchedBytes < reqBytes) {
        return null;
      }

      if (
        !state.blobUrl ||
        (state.blobBytes < reqBytes && state.fetchedBytes > state.blobBytes) ||
        (state.done && state.blobBytes < state.fetchedBytes)
      ) {
        const prevUrl = state.blobUrl;
        if (prevUrl) {
          setTimeout(() => {
            try { URL.revokeObjectURL(prevUrl); } catch (_) {}
          }, 5000);
        }
        const blob = new Blob(state.chunks, { type: 'audio/mpeg' });
        state.blobUrl = URL.createObjectURL(blob);
        state.blobBytes = state.fetchedBytes;
      }
      return state.blobUrl;
    },

    /** Backward-compatible alias for Firefox Blob getter callers. */
    getReadyFirefoxBlobUrl: function (mediaUrl, targetPhysicalSec) {
      return this.getReadyPatchedBlobUrl(mediaUrl, targetPhysicalSec);
    },

    /**
     * Waits until the progressive patched stream has buffered enough bytes to cover
     * `targetPhysicalSec` and returns the patched `blob:` URL (or `null` on failure).
     */
    waitForPatchedBlobUrl: async function (mediaUrl, targetPhysicalSec) {
      const vbr = this.getPlayingVbrData();
      if (!vbr || !mediaUrl) return null;
      const readyUrl = this.getReadyPatchedBlobUrl(mediaUrl, targetPhysicalSec);
      if (readyUrl) return readyUrl;

      const state = this.ensurePatchedStream(mediaUrl, vbr);
      if (!state || state.failed) return null;

      const reqBytes = this.getRequiredBytesForTime(targetPhysicalSec);
      await new Promise(resolve => {
        if (state.failed || state.done || (state.patched && state.fetchedBytes >= reqBytes)) {
          resolve(state);
        } else {
          state.waiters.push({ requiredBytes: reqBytes, resolve });
        }
      });

      return this.getReadyPatchedBlobUrl(mediaUrl, targetPhysicalSec);
    },

    /** Backward-compatible alias for Firefox Blob waiter callers. */
    waitForFirefoxBlobUrl: async function (mediaUrl, targetPhysicalSec) {
      return this.waitForPatchedBlobUrl(mediaUrl, targetPhysicalSec);
    },

    /**
     * Checks whether the current browser supports frame-aligned MP3 MediaSource Extensions.
     */
    isMseVbrSupported: function () {
      return (
        typeof MediaSource !== 'undefined' &&
        typeof MediaSource.isTypeSupported === 'function' &&
        MediaSource.isTypeSupported('audio/mpeg') &&
        typeof AbortController !== 'undefined'
      );
    },

    /**
     * Disposes any active MediaSource VBR session and aborts in-flight range fetches.
     */
    resetMseSession: function () {
      const s = this._mse;
      if (!s) return;
      this._mse = null;
      if (s.abortCtrl) {
        try { s.abortCtrl.abort(); } catch (_) {}
      }
      if (s.abortOpen) {
        try { s.abortOpen(); } catch (_) {}
        s.abortOpen = null;
      }
      if (s.objectUrl) {
        const staleUrl = s.objectUrl;
        setTimeout(() => {
          try { URL.revokeObjectURL(staleUrl); } catch (_) {}
        }, 5000);
      }
    },

    _findVbrSampleIndexBefore: function (targetSec) {
      const vbr = this.getPlayingVbrData();
      if (!vbr || !vbr.pcmTimes.length) return 0;
      const goal = Math.max(0, targetSec - 0.10);
      const times = vbr.pcmTimes;
      let low = 0;
      let high = times.length - 1;
      let best = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (times[mid] <= goal) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return best;
    },

    _waitSourceBufferIdle: function (sb) {
      if (!sb || !sb.updating) return Promise.resolve();
      return new Promise((resolve) => {
        sb.addEventListener('updateend', () => resolve(), { once: true });
      });
    },

    _getBufferedWindowFor: function (sb, t) {
      if (!sb || !sb.buffered) return null;
      for (let i = 0; i < sb.buffered.length; i++) {
        const st = sb.buffered.start(i);
        const en = sb.buffered.end(i);
        if (t >= st - 0.05 && t <= en) {
          return { start: st, end: en };
        }
      }
      return null;
    },

    /**
     * O(1) VBR1 frame-aligned HTTP Range + MediaSource seek & load for Chromium browsers.
     * Fetches only a ~40s MPEG frame-aligned window around `targetPhysicalSec` with `seekOffset = 0.0`.
     */
    mseSeekAndLoad: async function (audio, mediaUrl, targetPhysicalSec, seekSeq, shouldPlay) {
      const vbr = this.getPlayingVbrData();
      if (!audio || !mediaUrl || !vbr || !this.isMseVbrSupported() || this._mseFailed[mediaUrl]) {
        return { ok: false, reason: 'unsupported' };
      }

      const totalSamples = vbr.pcmTimes.length;
      if (totalSamples === 0) return { ok: false, reason: 'no_samples' };

      const clampedPhys = Math.max(0, Math.min(Math.max(0, vbr.totalDurSec - 0.1), targetPhysicalSec));

      // Re-use or initialize MSE session for this mediaUrl
      let session = this._mse;
      if (!session || session.mediaUrl !== mediaUrl || audio.src !== session.objectUrl || session.failed) {
        this.resetMseSession();
        const ms = new MediaSource();
        const objectUrl = URL.createObjectURL(ms);
        session = {
          mediaUrl,
          mediaSource: ms,
          objectUrl,
          sourceBuffer: null,
          nextSampleIdx: 0,
          fetchingNext: false,
          abortCtrl: null,
          queue: Promise.resolve(),
          failed: false,
          openPromise: null,
          abortOpen: null,
        };
        session.openPromise = new Promise((resolve, reject) => {
          let settled = false;
          session.abortOpen = () => {
            if (!settled) {
              settled = true;
              const err = new Error('MSE session aborted');
              err.name = 'AbortError';
              reject(err);
            }
          };
          const onOpen = () => {
            if (settled) return;
            settled = true;
            session.abortOpen = null;
            try {
              ms.duration = vbr.totalDurSec;
              if (!session.sourceBuffer) {
                session.sourceBuffer = ms.addSourceBuffer('audio/mpeg');
              }
              resolve(session);
            } catch (err) {
              reject(err);
            }
          };
          if (ms.readyState === 'open') {
            onOpen();
          } else {
            ms.addEventListener('sourceopen', onOpen, { once: true });
          }
        });
        this._mse = session;
        audio.src = objectUrl;
      }

      const runTask = async () => {
        if (!this.isCurrentSeek(seekSeq) || session !== this._mse || session.failed) {
          return { ok: false, aborted: true };
        }
        await session.openPromise;
        if (!this.isCurrentSeek(seekSeq) || session !== this._mse || session.failed) {
          return { ok: false, aborted: true };
        }

        const sb = session.sourceBuffer;
        const ms = session.mediaSource;
        if (!sb || ms.readyState === 'closed') {
          return { ok: false, reason: 'closed' };
        }

        // Fast path: target is already buffered with adequate headroom
        const existingWin = this._getBufferedWindowFor(sb, clampedPhys);
        const atTalkEnd = session.nextSampleIdx >= totalSamples;
        if (existingWin && (atTalkEnd || existingWin.end - clampedPhys >= 4.0)) {
          this.streamMode = 'mse_vbr';
          const seekT = this.prepareSeek(clampedPhys, this._seekTargetWordTime);
          this._awaitingInitialSeek = false;
          const clampedSeek = Math.max(existingWin.start, Math.min(existingWin.end - 0.02, seekT));
          const didChangeTime = Math.abs((audio.currentTime || 0) - clampedSeek) > 0.002;
          audio.currentTime = clampedSeek;
          if (!didChangeTime && !audio.seeking) {
            this._pendingProgrammaticSeek = false;
            this._syncPhase = shouldPlay ? 'playing' : (audio.paused ? 'idle' : 'playing');
          }
          if (shouldPlay) audio.play().catch(() => {});
          return { ok: true, cached: true };
        }

        const i0 = this._findVbrSampleIndexBefore(clampedPhys);
        const CHUNK_STRIDE = 20; // ~40s MPEG frame-aligned window
        const i1 = Math.min(totalSamples, i0 + CHUNK_STRIDE);
        const b0 = vbr.id3Len + vbr.byteOffsets[i0];
        const b1 = i1 < totalSamples ? (vbr.id3Len + vbr.byteOffsets[i1] - 1) : (vbr.id3Len + vbr.bytesLen - 1);

        const abortCtrl = new AbortController();
        session.abortCtrl = abortCtrl;
        let resp;
        try {
          resp = await fetch(mediaUrl, {
            headers: { Range: `bytes=${b0}-${b1}` },
            signal: abortCtrl.signal,
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return { ok: false, aborted: true };
          throw err;
        }
        if (resp.status !== 206) {
          try { if (resp.body) await resp.body.cancel(); } catch (_) {}
          throw new Error(`HTTP Range not honored (${resp.status})`);
        }
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const buf = await resp.arrayBuffer();
        if (!this.isCurrentSeek(seekSeq) || session !== this._mse || session.failed) {
          return { ok: false, aborted: true };
        }

        await this._waitSourceBufferIdle(sb);
        try { sb.abort(); } catch (_) {}
        await this._waitSourceBufferIdle(sb);
        if (sb.buffered.length > 0) {
          sb.remove(0, Infinity);
          await this._waitSourceBufferIdle(sb);
        }
        if (!this.isCurrentSeek(seekSeq) || session !== this._mse) {
          return { ok: false, aborted: true };
        }

        sb.timestampOffset = vbr.pcmTimes[i0];
        sb.appendBuffer(buf);
        await this._waitSourceBufferIdle(sb);
        if (!this.isCurrentSeek(seekSeq) || session !== this._mse) {
          return { ok: false, aborted: true };
        }

        session.nextSampleIdx = i1;
        if (i1 >= totalSamples && ms.readyState === 'open' && !sb.updating) {
          try { ms.endOfStream(); } catch (_) {}
        }

        const win = this._getBufferedWindowFor(sb, clampedPhys) ||
          (sb.buffered.length ? { start: sb.buffered.start(0), end: sb.buffered.end(0) } : null);
        this.streamMode = 'mse_vbr';
        const seekT = this.prepareSeek(clampedPhys, this._seekTargetWordTime);
        this._awaitingInitialSeek = false;
        const clampedSeek = win
          ? Math.max(win.start, Math.min(Math.max(win.start, win.end - 0.02), seekT))
          : seekT;
        const didChangeTime = Math.abs((audio.currentTime || 0) - clampedSeek) > 0.002;
        audio.currentTime = clampedSeek;
        if (!didChangeTime && !audio.seeking) {
          this._pendingProgrammaticSeek = false;
          this._syncPhase = shouldPlay ? 'playing' : (audio.paused ? 'idle' : 'playing');
        }
        if (shouldPlay) audio.play().catch(() => {});
        return { ok: true };
      };

      const chained = session.queue.then(runTask, runTask);
      session.queue = chained.catch(() => {});
      try {
        return await chained;
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.warn('[WordSync] MSE VBR fallback to patched_blob:', err);
          this._mseFailed[mediaUrl] = true;
          session.failed = true;
          if (this._mse === session) {
            this.resetMseSession();
          }
        }
        return { ok: false, reason: 'error' };
      }
    },

    /**
     * Prefetches the next contiguous frame-aligned VBR1 window during MSE continuous playback.
     */
    maybePrefetchMseNextChunk: function (audio) {
      const s = this._mse;
      const vbr = this.getPlayingVbrData();
      if (!audio || !s || s.failed || s.fetchingNext || audio.src !== s.objectUrl || !vbr) return;
      const totalSamples = vbr.pcmTimes.length;
      if (s.nextSampleIdx >= totalSamples || !s.sourceBuffer) return;

      const sb = s.sourceBuffer;
      const win = this._getBufferedWindowFor(sb, audio.currentTime);
      if (!win || win.end - audio.currentTime > 18.0) return;

      s.fetchingNext = true;
      const i0 = s.nextSampleIdx;
      const CHUNK_STRIDE = 20;
      const i1 = Math.min(totalSamples, i0 + CHUNK_STRIDE);
      const b0 = vbr.id3Len + vbr.byteOffsets[i0];
      const b1 = i1 < totalSamples ? (vbr.id3Len + vbr.byteOffsets[i1] - 1) : (vbr.id3Len + vbr.bytesLen - 1);

      const abortCtrl = new AbortController();
      s.abortCtrl = abortCtrl;
      const doAppend = async () => {
        try {
          const resp = await fetch(s.mediaUrl, {
            headers: { Range: `bytes=${b0}-${b1}` },
            signal: abortCtrl.signal,
          });
          if (resp.status !== 206) {
            try { if (resp.body) await resp.body.cancel(); } catch (_) {}
            return;
          }
          const buf = await resp.arrayBuffer();
          if (s !== this._mse || s.failed || s.nextSampleIdx !== i0) return;

          await this._waitSourceBufferIdle(sb);
          if (win.start < audio.currentTime - 120) {
            sb.remove(0, audio.currentTime - 120);
            await this._waitSourceBufferIdle(sb);
          }
          if (s !== this._mse || s.failed || s.nextSampleIdx !== i0) return;
          sb.appendBuffer(buf);
          await this._waitSourceBufferIdle(sb);
          s.nextSampleIdx = i1;
          if (i1 >= totalSamples && s.mediaSource && s.mediaSource.readyState === 'open' && !sb.updating) {
            try { s.mediaSource.endOfStream(); } catch (_) {}
          }
        } catch (_) {
          // Aborted by newer seek or transient network drop
        } finally {
          if (s === this._mse) s.fetchingNext = false;
        }
      };
      s.queue = s.queue.then(doAppend, doAppend);
    },

    /**
     * Piecewise-linear interpolation helper over sorted arrays `xs` -> `ys`.
     */
    _interp: function (x, xs, ys) {
      const n = xs.length;
      if (n === 0) return x;
      if (x <= xs[0]) {
        const delta0 = ys[0] - xs[0];
        return Math.max(0, x + delta0);
      }
      if (x >= xs[n - 1]) {
        const deltaEnd = ys[n - 1] - xs[n - 1];
        return Math.max(0, x + deltaEnd);
      }
      let low = 0;
      let high = n - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (xs[mid] <= x) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      const idx = Math.max(0, low - 1);
      const x0 = xs[idx];
      const x1 = xs[idx + 1];
      const y0 = ys[idx];
      const y1 = ys[idx + 1];
      const ratio = x1 > x0 ? (x - x0) / (x1 - x0) : 0.0;
      return Math.max(0, y0 + ratio * (y1 - y0));
    },

    /**
     * Converts a desired physical PCM timestamp (seconds) into the browser stream's
     * seek coordinate `audio.currentTime`, updating `this.seekOffset` so subsequent
     * playback remains locked 1:1 to the 44.1 kHz audio clock.
     */
    prepareSeek: function (targetPhysicalSec, targetWordStartSec) {
      const clampedPhys = Math.max(0, Number(targetPhysicalSec) || 0);
      this._seekTargetWordTime = typeof targetWordStartSec === 'number' ? targetWordStartSec : null;
      this._pendingProgrammaticSeek = true;
      this._syncPhase = 'seeking';
      this._lastSpokenWordId = null;
      this._teleprompterLine = null;

      const vbr = this.getPlayingVbrData();
      if (this.streamMode === 'mse_vbr' || clampedPhys <= 0.01 || !vbr) {
        this.seekOffset = 0.0;
        return clampedPhys;
      }

      if (this.streamMode === 'patched_blob') {
        // Client-side Info-patched Blob uses exact linear byte-offset seeking
        const seekTime = this._interp(clampedPhys, vbr.pcmTimes, vbr.linearSeekTimes);
        this.seekOffset = clampedPhys - seekTime;
        return Math.max(0, seekTime);
      }

      // Direct Podbean CDN streaming with raw Xing header
      if (this.isFirefox) {
        const dur = vbr.totalDurSec;
        const bucketWidth = dur / 100.0;
        let bestS = clampedPhys;
        let bestErr = Infinity;
        let bestDelta = 0.0;

        for (let k = 0; k < 100; k++) {
          const delta = vbr.ffBucketDeltas[k];
          const sMin = k * bucketWidth;
          const sMax = (k + 1) * bucketWidth - 0.02;
          const candidateS = Math.max(sMin, Math.min(sMax, clampedPhys - delta));
          const landedPhys = candidateS + delta;
          const overJump = landedPhys - clampedPhys;
          // Strongly penalize jumping forward past the target word into mid-sentence
          const err = overJump > 0.35 ? overJump * 20.0 : Math.abs(overJump);
          if (err < bestErr) {
            bestErr = err;
            bestS = candidateS;
            bestDelta = delta;
          }
        }
        this.seekOffset = bestDelta;
        return Math.max(0, bestS);
      }

      // Chromium / Safari on direct Podbean CDN: interpolate Xing TOC seek curve
      const seekTime = this._interp(clampedPhys, vbr.pcmTimes, vbr.xingSeekTimes);
      this.seekOffset = clampedPhys - seekTime;
      return Math.max(0, seekTime);
    },

    /**
     * Converts raw `audio.currentTime` into true physical PCM time (seconds).
     */
    getPhysicalTime: function (rawCurrentTime) {
      if (typeof rawCurrentTime !== 'number' || isNaN(rawCurrentTime)) return 0;
      if (!this.getPlayingVbrData()) return rawCurrentTime;
      return Math.max(0, rawCurrentTime + (this.seekOffset || 0.0));
    },

    /**
     * Maps global words into turn buckets matching each segment's start/end window.
     * Enforces monotonic cursor progression and per-turn token counts so adjacent turns
     * separated by < 0.60s never duplicate or steal boundary words.
     */
    indexWordsByTurn: function (segments, episodeId = null) {
      this.turnWordMap = {};
      for (let i = 0; i < this.words.length; i++) {
        this.words[i].domId = this.words[i].id;
      }
      let wordCursor = 0;

      segments.forEach((seg, idx) => {
        const turnIdx = seg.turn_index !== undefined ? Number(seg.turn_index) : idx;
        const segSt = parseFloat(seg.start_sec || 0);
        const segEn = parseFloat(seg.end_sec || 0);
        const nextSegSt =
          idx + 1 < segments.length ? parseFloat(segments[idx + 1].start_sec || Infinity) : Infinity;
        const expectedTokens =
          typeof seg.text === 'string' && seg.text.trim()
            ? seg.text.trim().split(/\s+/).length
            : 0;
        const turnWords = [];

        // Advance cursor to words within this turn window without backing up into prior turns
        while (wordCursor < this.words.length && this.words[wordCursor].s < segSt - 0.25) {
          wordCursor++;
        }

        let tempIdx = wordCursor;
        while (tempIdx < this.words.length && this.words[tempIdx].s <= segEn + 0.35) {
          if (expectedTokens > 0 && turnWords.length >= expectedTokens) {
            break;
          }
          if (expectedTokens === 0 && this.words[tempIdx].s >= nextSegSt - 0.02) {
            break;
          }
          const w = this.words[tempIdx];
          w.turnIdx = turnIdx;
          w.wordIdxInTurn = turnWords.length;
          turnWords.push(w);
          tempIdx++;
        }

        wordCursor = tempIdx;
        this.turnWordMap[turnIdx] = turnWords;
      });
      this.turnWordMapEpisodeId = episodeId || this.wordsEpisodeId || this.currentEpisodeId || null;
    },

    /**
     * Splits a text string into sentences without dropping any characters or words.
     *
     * Why a linear scanner is used instead of regular expressions:
     * Fragile regex patterns like `/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g` fail when encountering
     * internal punctuation such as decimal numbers ('6.15', '5.30', '3.14'), spaced decimals ('6 .15'),
     * sutta citations ('46 .23'), or abbreviations ('e.g.'). When a match fails mid-string, RegExp.match()
     * skips and discards all leading characters until the next match, permanently dropping text from the DOM
     * and causing severe downstream word-highlight desynchronization.
     *
     * This deterministic scanner guarantees zero dropped characters:
     * 1. Scans character-by-character to locate terminal punctuation ('.', '!', '?').
     * 2. Allows closing quotes and brackets to attach to the sentence boundary (e.g. `"Let it go."`).
     * 3. Verifies that punctuation is followed by whitespace or EOF before treating it as a true boundary,
     *    protecting internal decimal points and abbreviations from premature splitting.
     * 4. Slices sentences cleanly from `start` to boundary `j`, consumes subsequent whitespace, and resets `start`.
     * 5. Appends any remaining trailing characters as the final sentence.
     */
    splitSentences: function (text) {
      if (!text) return [];
      const trimmed = text.trim();
      if (!trimmed) return [];

      const sents = [];
      let start = 0;
      let i = 0;
      const n = trimmed.length;

      while (i < n) {
        const ch = trimmed[i];

        // Check for potential sentence-ending punctuation marks
        if (ch === '.' || ch === '!' || ch === '?') {
          let j = i + 1;

          // Consume any immediately following closing quotes or brackets attached to the sentence
          // (e.g., 'said: "Let it go."' or '(retreat notes).')
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

          // A genuine sentence boundary occurs only at the end of the string or when immediately
          // followed by whitespace. If followed by non-whitespace (e.g. '6.15', '6 .15', '46.23', 'pi=3.14'),
          // it is an internal decimal or mid-token punctuation and must NOT trigger a sentence split.
          if (j >= n || /\s/.test(trimmed[j])) {
            const sent = trimmed.slice(start, j).trim();
            if (sent) {
              sents.push(sent);
            }

            // Advance past trailing inter-sentence whitespace to mark the start of the next sentence
            while (j < n && /\s/.test(trimmed[j])) {
              j++;
            }
            start = j;

            // Synchronize the outer loop cursor with the scanned boundary
            i = j - 1;
          }
        }
        i++;
      }

      // Capture any remaining tail segment (e.g., final sentence without terminal punctuation)
      const rem = trimmed.slice(start).trim();
      if (rem) {
        sents.push(rem);
      }

      return sents.length > 0 ? sents : [trimmed];
    },

    /**
     * Formats turn text into paragraphs preserving 100% of the original text structure,
     * wrapping non-whitespace tokens in inline word spans only when exact word timings are present.
     */
    formatTurnParagraphs: function (rawText, turnIdx) {
      if (!rawText) return '';
      const trimmed = rawText.trim();
      if (!trimmed) return '';

      // Original paragraph splitting logic
      let paragraphs = [];
      if (trimmed.includes('\n\n')) {
        paragraphs = trimmed
          .split(/\n\s*\n/)
          .map(p => p.trim())
          .filter(p => p.length > 0);
      } else {
        const rawSentences = this.splitSentences(trimmed);
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

      if (paragraphs.length === 0) {
        paragraphs = [trimmed];
      }

      const turnWords = this.turnWordMap[turnIdx] || [];
      let sentCursorInTurn = 0;

      // If no exact word timings exist for this talk, render clean original paragraphs with sentence spans
      if (turnWords.length === 0) {
        return paragraphs.map(pText => {
          const sents = this.splitSentences(pText);
          const wrappedSents = sents.map(sent => {
            const sIdx = sentCursorInTurn++;
            const tokens = sent.split(/(\s+)/);
            const wrappedTokens = [];
            for (let i = 0; i < tokens.length; i++) {
              const token = tokens[i];
              if (!token || /^\s+$/.test(token)) {
                wrappedTokens.push(token);
                continue;
              }
              const match = this.matchPhraseAt(tokens, i);
              if (match) {
                const pali = match.term;
                const phraseClass = match.wordCount > 1 ? ' pali-phrase' : '';
                const spanText = tokens.slice(i, match.endTokenIndex + 1).join('');
                wrappedTokens.push(
                  `<span class="pali-term${phraseClass}" data-pali="${this.escapeHtml(pali.pali_plain)}" title="Pali: ${this.escapeHtml(pali.pali_diacritic)} — Click to view definition">${this.escapeHtml(spanText)}</span>`
                );
                i = match.endTokenIndex;
              } else {
                wrappedTokens.push(this.escapeHtml(token));
              }
            }
            return `<span class="transcript-sentence" id="turn-${turnIdx}-sent-${sIdx}" data-turn-idx="${turnIdx}" data-sent-idx="${sIdx}">${wrappedTokens.join('')}</span>`;
          });
          return `<p class="turn-p">${wrappedSents.join('')}</p>`;
        }).join('');
      }

      // If exact word timings ARE available, wrap words and multi-word canonical phrases inline
      let wordCursorInTurn = 0;
      return paragraphs.map(pText => {
        const sents = this.splitSentences(pText);
        const wrappedSents = sents.map(sent => {
          const sIdx = sentCursorInTurn++;
          const tokens = sent.split(/(\s+)/);
          const wrappedTokens = [];
          for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (!token || /^\s+$/.test(token)) {
              wrappedTokens.push(token); // Preserves exact whitespace
              continue;
            }
            const match = this.matchPhraseAt(tokens, i);
            const pali = match ? match.term : null;
            const numWords = match ? match.wordCount : 1;
            const spanText = match ? tokens.slice(i, match.endTokenIndex + 1).join('') : token;
            const paliClass = pali ? (numWords > 1 ? ' pali-term pali-phrase' : ' pali-term') : '';
            const paliAttr = pali ? ` data-pali="${this.escapeHtml(pali.pali_plain)}"` : '';

            if (wordCursorInTurn < turnWords.length) {
              const wFirst = turnWords[wordCursorInTurn];
              let wLast = wFirst;
              for (let wStep = 0; wStep < numWords && wordCursorInTurn < turnWords.length; wStep++) {
                const w = turnWords[wordCursorInTurn++];
                w.domId = wFirst.id;
                wLast = w;
              }
              const titleText = pali
                ? `Pali: ${pali.pali_diacritic} — Click to seek / view definition`
                : `Click to seek to ${this.formatSeconds(wFirst.s)}`;
              wrappedTokens.push(
                `<span class="transcript-word${paliClass}" id="${wFirst.id}" data-turn-idx="${turnIdx}" data-word-idx="${wFirst.wordIdxInTurn}" data-start="${wFirst.s}" data-end="${wLast.e}"${paliAttr} title="${this.escapeHtml(titleText)}">${this.escapeHtml(spanText)}</span>`
              );
            } else if (pali) {
              wrappedTokens.push(
                `<span class="pali-term${numWords > 1 ? ' pali-phrase' : ''}"${paliAttr} title="Pali: ${this.escapeHtml(pali.pali_diacritic)} — Click to view definition">${this.escapeHtml(spanText)}</span>`
              );
            } else {
              wrappedTokens.push(this.escapeHtml(spanText));
            }

            if (match) {
              i = match.endTokenIndex;
            }
          }
          return `<span class="transcript-sentence" id="turn-${turnIdx}-sent-${sIdx}" data-turn-idx="${turnIdx}" data-sent-idx="${sIdx}">${wrappedTokens.join('')}</span>`;
        });
        return `<p class="turn-p">${wrappedSents.join('')}</p>`;
      }).join('');
    },

    getScrollContainer: function () {
      if (typeof document !== 'undefined') {
        const mainEl = document.getElementById('main-content');
        if (mainEl) return mainEl;
      }
      return typeof window !== 'undefined' ? window : null;
    },

    getScrollTop: function () {
      const sc = this.getScrollContainer();
      if (!sc) return 0;
      return sc === window ? (window.scrollY || window.pageYOffset || 0) : sc.scrollTop;
    },

    setScrollTop: function (y) {
      const sc = this.getScrollContainer();
      if (!sc) return;
      if (sc === window) {
        window.scrollTo(0, y);
      } else {
        sc.scrollTop = y;
      }
    },

    /**
     * Resolves the visual line geometry and speech timing for continuous teleprompter interpolation.
     * Caches line boundaries so lookup across words on the same line is O(1).
     */
    getLineInfo: function (targetIdx, wordEl) {
      if (this._teleprompterLine &&
          targetIdx >= this._teleprompterLine.lineStartIdx &&
          targetIdx < this._teleprompterLine.nextLineStartIdx) {
        return this._teleprompterLine;
      }

      const scrollTop = this.getScrollTop();
      const rect = wordEl.getBoundingClientRect();
      const currentDocY = rect.top + scrollTop;
      const wordHeight = rect.height || 28;
      const currentLineCenterY = currentDocY + wordHeight / 2;

      // 1. Scan backward for start of current line
      const curTurnIdx = this.words[targetIdx] ? this.words[targetIdx].turnIdx : undefined;
      let lineStartIdx = targetIdx;
      for (let i = targetIdx - 1; i >= Math.max(0, targetIdx - 25); i--) {
        if (curTurnIdx !== undefined && this.words[i].turnIdx !== undefined && this.words[i].turnIdx !== curTurnIdx) {
          break;
        }
        const prevSpan = document.getElementById(this.words[i].domId || this.words[i].id);
        if (!prevSpan) break;
        const prevDocY = prevSpan.getBoundingClientRect().top + scrollTop;
        if (Math.abs(prevDocY - currentDocY) > 8) {
          // Found previous line
          break;
        }
        lineStartIdx = i;
      }
      const lineStartTime = this.words[lineStartIdx].s;

      // 2. Scan forward for start of next line
      let nextLineStartIdx = this.words.length;
      let nextLineCenterY = currentLineCenterY + 32;
      let nextLineStartTime = lineStartTime + 4.0;

      for (let i = targetIdx + 1; i < Math.min(this.words.length, targetIdx + 30); i++) {
        if (curTurnIdx !== undefined && this.words[i].turnIdx !== undefined && this.words[i].turnIdx !== curTurnIdx) {
          break;
        }
        const nextSpan = document.getElementById(this.words[i].domId || this.words[i].id);
        if (!nextSpan) continue;
        const nextDocY = nextSpan.getBoundingClientRect().top + scrollTop;
        if (nextDocY > currentDocY + 10) {
          // Found first word on next line
          nextLineStartIdx = i;
          nextLineCenterY = nextDocY + (nextSpan.offsetHeight || wordHeight) / 2;
          nextLineStartTime = this.words[i].s;
          break;
        }
      }

      this._teleprompterLine = {
        lineStartIdx,
        lineStartTime,
        currentLineCenterY,
        nextLineStartIdx,
        nextLineStartTime,
        nextLineCenterY,
      };
      return this._teleprompterLine;
    },

    /**
     * Computes unobstructed reading bounds inside #main-content (or window fallback),
     * handling collapsing bottom-sheet transitions deterministically across all viewports.
     */
    getReadingZoneBounds: function () {
      const sc = this.getScrollContainer();
      const isShell = Boolean(sc && sc !== window);
      const mainRect = isShell ? sc.getBoundingClientRect() : null;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const topFloor = mainRect ? Math.max(0, mainRect.top) : 0;

      const toolbar = document.getElementById('transcript-sticky-toolbar');
      const toolbarBottom = toolbar ? Math.max(topFloor, toolbar.getBoundingClientRect().bottom) : topFloor;

      const playerBar = document.getElementById('audio-player-bar');
      let bottomLimit = mainRect ? Math.min(viewportHeight, mainRect.bottom) : viewportHeight;
      if (playerBar) {
        bottomLimit = Math.min(bottomLimit, playerBar.getBoundingClientRect().top);
      }

      const companionBar = document.getElementById('transcript-lexicon-companion');
      if (companionBar && typeof window !== 'undefined' && window.getComputedStyle) {
        const compStyle = window.getComputedStyle(companionBar);
        const tickerEl = document.getElementById('lex-mobile-ticker');
        const tickerStyle = tickerEl ? window.getComputedStyle(tickerEl) : null;
        const isBottomSheet = compStyle.display !== 'none' && (
          (tickerStyle && tickerStyle.display !== 'none') ||
          compStyle.position === 'fixed' ||
          (isShell && viewportWidth <= 1100)
        );
        if (isBottomSheet) {
          if (!companionBar.classList.contains('is-expanded') && tickerEl) {
            const tickerRect = tickerEl.getBoundingClientRect();
            const barH = tickerRect.height > 0 ? tickerRect.height + 12 : 52;
            const pTop = playerBar ? playerBar.getBoundingClientRect().top : bottomLimit;
            bottomLimit = Math.min(bottomLimit, Math.max(toolbarBottom + 80, pTop - barH));
          } else {
            const compRect = companionBar.getBoundingClientRect();
            if (compRect.height > 0) {
              bottomLimit = Math.min(bottomLimit, compRect.top);
            }
          }
        }
      }

      return {
        sc,
        toolbarBottom,
        bottomLimit,
        availableHeight: bottomLimit - toolbarBottom,
      };
    },

    _stepScrollAnimation: function () {
      const target = this._scrollTarget;
      if (!target) return;
      const now = performance.now();
      if (now >= target.until) {
        this.setScrollTop(target.top);
        this._scrollTarget = null;
        return;
      }
      const cur = this.getScrollTop();
      const diff = target.top - cur;
      if (Math.abs(diff) <= 0.75) {
        this.setScrollTop(target.top);
        this._scrollTarget = null;
        return;
      }
      this.setScrollTop(cur + diff * 0.18);
    },

    /**
     * Unified single-owner reading-zone scroll positioning used by companion jumps,
     * search phrase navigation, and deep links—avoids native vs rAF scroll fighting.
     */
    scrollToElement: function (el, options = {}) {
      if (!el) return;
      const behavior = options.behavior || 'auto';
      const bounds = this.getReadingZoneBounds();
      const availH = Math.max(80, bounds.availableHeight);
      const rect = el.getBoundingClientRect();
      const ratio = typeof options.ratio === 'number' ? options.ratio : 0.35;
      const desiredTop = bounds.toolbarBottom + Math.min(availH * ratio, Math.max(20, (availH - rect.height) / 2));
      const targetScrollY = Math.max(0, this.getScrollTop() + (rect.top - desiredTop));

      if (behavior === 'smooth') {
        this._programmaticScrollUntil = performance.now() + 500;
        this._scrollTarget = { top: targetScrollY, until: performance.now() + 500 };
        this.startLoop();
      } else {
        this._scrollTarget = null;
        this.setScrollTop(targetScrollY);
      }
    },

    /**
     * In 'track' mode, drives a continuous, seamless teleprompter scroll on every animation frame.
     * Continuously interpolates vertical document position across the duration of each line,
     * so text glides upward at a steady, gentle, constant velocity without jumping at line breaks.
     */
    updateTeleprompter: function (currentTime, targetIdx, wordEl) {
      if (this._scrollTarget) {
        this._stepScrollAnimation();
        return;
      }
      if (this.mode !== 'track' || !wordEl || !this.words || targetIdx < 0) return;

      const view = document.getElementById('transcript-view');
      if (view && !view.classList.contains('active')) return;

      // Pause teleprompter briefly during an explicit jump scroll or for 2.5s after manual user scroll
      const now = performance.now();
      if (now < this._programmaticScrollUntil || now - this._userInteractedAt < 2500) return;

      const bounds = this.getReadingZoneBounds();
      if (bounds.availableHeight <= 100) return;
      const centerLine = bounds.toolbarBottom + (bounds.availableHeight * 0.46);

      // 2. Line interpolation: continuous progress across the line
      const line = this.getLineInfo(targetIdx, wordEl);
      const lineDuration = Math.max(0.6, line.nextLineStartTime - line.lineStartTime);
      const progress = Math.max(0, Math.min(1, (currentTime - line.lineStartTime) / lineDuration));

      // Continuous document Y moving steadily from this line toward the next line
      const idealDocY = line.currentLineCenterY + progress * (line.nextLineCenterY - line.currentLineCenterY);
      const targetScrollY = Math.max(0, idealDocY - centerLine);

      // 3. Smooth continuous damping
      const currentScrollY = this.getScrollTop();
      const diff = targetScrollY - currentScrollY;

      if (Math.abs(diff) >= 0.4) {
        // Fast glide for seeks (> 150px), silky sub-pixel drift for continuous playback
        const factor = Math.abs(diff) > 150 ? 0.15 : 0.08;
        this.setScrollTop(currentScrollY + diff * factor);
      }
    },

    /**
     * Backward-compatible alias for unit test checks.
     */
    scrollToWordIfOffScreen: function (wordEl) {
      if (!wordEl || this.mode !== 'track') return;
      const curT = this.getPhysicalTime(this._boundAudio ? this._boundAudio.currentTime : 0);
      this.updateTeleprompter(curT, this.activeWordIdx, wordEl);
    },

    /**
     * Updates active word highlight based on raw audio.currentTime.
     * In 'track' mode, auto-scrolls with a smooth, continuous teleprompter glide.
     */
    update: function (rawCurrentTime) {
      if (!this.enabled || !this.words || this.words.length === 0) return;
      if (!this.isPlayingCurrentTranscript()) {
        return;
      }
      if (typeof rawCurrentTime !== 'number' || isNaN(rawCurrentTime)) return;
      // Ignore pre-seek old/0:00 frames until doSeek() assigns audio.currentTime
      if (this._awaitingInitialSeek) {
        return;
      }
      if (this._boundAudio && this._boundAudio.seeking && this._syncPhase === 'seeking') {
        return;
      }

      const currentTime = this.getPhysicalTime(rawCurrentTime);

      const floorSec = Math.floor(Math.max(0, currentTime));
      if (floorSec !== this._lastClockSecond) {
        this._lastClockSecond = floorSec;
        if (typeof this.onClockTick === 'function') {
          this.onClockTick(currentTime, rawCurrentTime);
        }
      }

      // Clear seek lead-in target & companion lock once playback passes the targeted word start
      if (this._seekTargetWordTime !== null && currentTime >= this._seekTargetWordTime) {
        this._seekTargetWordTime = null;
        this._lockedWordIdx = -1;
        this._lockedCompanionIdx = -1;
      }

      // Binary search across words for physical currentTime
      const targetIdx = this.findWordIndex(currentTime);
      if (targetIdx >= 0) {
        let activeSpan = this.activeWordEl && this.activeWordEl.isConnected ? this.activeWordEl : null;
        if (this.activeWordIdx !== targetIdx || !activeSpan) {
          const targetWord = this.words[targetIdx];
          const spanId = targetWord.domId || targetWord.id;
          const newSpan = document.getElementById(spanId);

          if (newSpan) {
            if (!activeSpan) {
              this._teleprompterLine = null;
            }
            this.activeWordIdx = targetIdx;
            if (this.activeWordEl && this.activeWordEl !== newSpan) {
              this.activeWordEl.classList.remove('active-word');
            }
            newSpan.classList.add('active-word');
            this.activeWordEl = newSpan;
            activeSpan = newSpan;

            // Trigger live companion lookup if word/phrase is an annotated Pali doctrinal term
            if (newSpan.classList.contains('pali-term') && newSpan.dataset && newSpan.dataset.pali) {
              if (this._lastSpokenWordId !== spanId) {
                this._lastSpokenWordId = spanId;
                const pKey = newSpan.dataset.pali;
                const spanStart = parseFloat(newSpan.dataset.start);
                if (typeof this.onPaliTermSpoken === 'function') {
                  this.onPaliTermSpoken(pKey, this.paliTermsMap.get(pKey), {
                    wordId: spanId,
                    startSec: !isNaN(spanStart) ? spanStart : targetWord.s,
                  });
                }
              }
            } else {
              this._lastSpokenWordId = null;
            }
          }
        }

        // Smooth continuous teleprompter scrolling (runs on every frame while playing in 'track' mode)
        if (this.mode === 'track' && activeSpan) {
          this.updateTeleprompter(currentTime, targetIdx, activeSpan);
        }
      } else {
        // Between turns or in silence
        this.clearHighlights();
      }
    },

    /**
     * Binary search to find the active word matching physical currentTime.
     */
    findWordIndex: function (time) {
      // Hold the sought target word only over its true lead-in window (wider 10s allowance reserved for raw Firefox VBR CDN fallback)
      const vbr = this.getPlayingVbrData();
      const leadWindowSec = (this.streamMode === 'cdn' && vbr && this.isFirefox) ? 10.0 : 0.90;
      if (
        this._seekTargetWordTime !== null &&
        time >= this._seekTargetWordTime - leadWindowSec &&
        time < this._seekTargetWordTime
      ) {
        if (this._lockedWordIdx >= 0 && this._lockedWordIdx < this.words.length) {
          return this._lockedWordIdx;
        }
        const leadIdx = this._findExactWordAtStart(this._seekTargetWordTime);
        if (leadIdx >= 0) return leadIdx;
      }

      let low = 0;
      let high = this.words.length - 1;

      while (low <= high) {
        const mid = (low + high) >> 1;
        const w = this.words[mid];

        if (time >= w.s && time <= w.e) {
          return mid;
        } else if (time < w.s) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }

      // Hold highlight smoothly across natural intra-sentence pauses (up to 350ms)
      if (high >= 0 && high < this.words.length) {
        const prev = this.words[high];
        if (time >= prev.s && time <= prev.e + 0.35) {
          return high;
        }
      }

      // Highlight upcoming first word of a turn during its 500ms seek lead-in
      if (low >= 0 && low < this.words.length) {
        const next = this.words[low];
        if (time >= next.s - 0.55 && time < next.s) {
          return low;
        }
      }

      return -1;
    },

    _findExactWordAtStart: function (targetStart) {
      let low = 0;
      let high = this.words.length - 1;
      let bestIdx = -1;
      let bestDiff = 0.05;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const w = this.words[mid];
        const diff = Math.abs(w.s - targetStart);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = mid;
        }
        if (w.s < targetStart) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return bestIdx;
    },

    /**
     * Format seconds helper (M:SS or H:MM:SS)
     */
    formatSeconds: function (sec) {
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
    },

    /**
     * HTML escaping utility
     */
    escapeHtml: function (str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
  };

  window.WordSync = WordSync;
})();
