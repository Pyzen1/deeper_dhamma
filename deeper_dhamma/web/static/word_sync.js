/**
 * Deeper Dhamma — Exact Word-Level Audio Synchronization & Serverless VBR Calibration Engine
 * 
 * Architecture (100% Static / Serverless Web Application):
 * - Compact Binary BLOB sidecars (`words/<episode_id>.bin`):
 *   - Section 1: 6 bytes/word `[uint32 start_ms, uint16 duration_ms]` in true 44.1 kHz PCM time.
 *   - Section 2: Optional `VBR1` seek calibration trailer containing `(pcm_ms, audio_byte_offset)`
 *     samples and the 100-byte `Xing` TOC across the full duration of the talk.
 * - Cross-Browser Direct Podbean CDN Streaming:
 *   - Chromium (Chrome / Edge / Brave / Safari): Streams directly from Podbean CDN via HTTP Range
 *     requests, translating physical timestamps via `xingSeekTimes` from the `.bin` `VBR1` trailer.
 *   - Mozilla Firefox (Gecko `MP3TrackDemuxer`): Gecko's raw `Xing` TOC demuxer uses an un-interpolated
 *     step function with 14-second dead zones at low-bitrate bucket boundaries. For VBR episodes in
 *     Firefox, `WordSync` progressively streams the Podbean CDN MP3 via CORS `fetch()`, patches the
 *     8-byte `Xing` header to `Info` (`flags = 3`) in client-side `Uint8Array` memory, and serves a
 *     zero-copy progressive `Blob` URL (`linearSeekTimes`) with zero backend dependencies.
 *   - Playback Clock Lock: Once any seek lands at physical time `P`, the browser's 44.1 kHz PCM decoder
 *     advances `audio.currentTime` at `1.000s` per `1.000s` of physical speech. Tracking
 *     `physTime = audio.currentTime + seekOffset` eliminates intra-turn VBR bitrate drift.
 * 
 * See `docs/troubleshooting_guide.md` for full mathematical and architectural details.
 */

(function () {
  'use strict';

  const STORAGE_KEY_ENABLED = 'deeper_dhamma_word_sync_enabled';

  const WordSync = {
    // State
    enabled: localStorage.getItem(STORAGE_KEY_ENABLED) !== 'false', // Default to true
    currentEpisodeId: null,
    currentEpisode: null,
    words: [], // Sorted array of exact physical words: [{ s, e, turnIdx, wordIdx, id }]
    turnWordMap: {}, // Map of turnIdx -> [words]
    vbrData: null, // Parsed VBR1 seek table if episode is VBR
    vbrCache: {}, // Cache of episodeId -> { words, vbrData, bytesLoaded }
    streamMode: 'cdn', // 'cdn' (direct Podbean CDN) or 'patched_blob' (client-side Info-patched Blob)
    seekOffset: 0.0, // Constant physical-minus-stream clock offset established at last seek
    _seekTargetWordTime: null, // Optional exact word start time targeted by the latest seek
    _pendingProgrammaticSeek: false,
    _ffStreams: {}, // Client-side progressive Fetch + Xing->Info patched Blob state keyed by media_url
    isFirefox: typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || ''),
    activeWordEl: null,
    activeWordIdx: -1,
    metrics: {
      format: 'binary_blob',
      bytesLoaded: 0,
      wordCount: 0,
      loadMs: 0,
    },

    _rafId: null,
    _boundAudio: null,

    /**
     * Initializes WordSync.
     */
    init: function () {
      this.updateUI();
    },

    /**
     * Binds an HTML5 audio element for high-frequency 60fps word synchronization.
     * Replaces sluggish 250ms timeupdate polling with a smooth animation frame loop.
     */
    bindAudio: function (audio) {
      if (!audio || this._boundAudio === audio) return;
      this._boundAudio = audio;

      const onPlay = () => this.startLoop();
      const onPause = () => this.stopLoop();
      const onSeeked = () => {
        if (this._pendingProgrammaticSeek) {
          this._pendingProgrammaticSeek = false;
        } else if (this.vbrData) {
          // External/native seek not initiated via prepareSeek: infer physical offset
          const rawT = audio.currentTime;
          if (rawT <= 0.05) {
            this.seekOffset = 0.0;
          } else if (this.streamMode === 'patched_blob') {
            const physT = this._interp(rawT, this.vbrData.linearSeekTimes, this.vbrData.pcmTimes);
            this.seekOffset = physT - rawT;
          } else if (this.isFirefox) {
            const k = Math.max(0, Math.min(99, Math.floor((rawT / this.vbrData.totalDurSec) * 100)));
            this.seekOffset = this.vbrData.ffBucketDeltas[k] || 0.0;
          } else {
            const physT = this._interp(rawT, this.vbrData.xingSeekTimes, this.vbrData.pcmTimes);
            this.seekOffset = physT - rawT;
          }
        }
        this.update(audio.currentTime);
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
        if (this._boundAudio && !this._boundAudio.paused) {
          this.update(this._boundAudio.currentTime);
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
     * Toggles word synchronization on or off.
     */
    toggle: function (forceState) {
      if (typeof forceState === 'boolean') {
        this.enabled = forceState;
      } else {
        this.enabled = !this.enabled;
      }
      localStorage.setItem(STORAGE_KEY_ENABLED, this.enabled ? 'true' : 'false');

      if (!this.enabled) {
        this.clearHighlights();
      }

      this.updateUI();
      return this.enabled;
    },

    /**
     * Clears active highlights.
     */
    clearHighlights: function () {
      if (this.activeWordEl) {
        this.activeWordEl.classList.remove('active-word');
        this.activeWordEl = null;
      }
      this.activeWordIdx = -1;
    },

    /**
     * Updates toggle button and metrics UI.
     */
    updateUI: function () {
      const btnToggle = document.getElementById('btn-toggle-word-sync');
      if (btnToggle) {
        const stateText = btnToggle.querySelector('.toggle-state-text');
        if (this.enabled) {
          btnToggle.classList.add('active');
          btnToggle.setAttribute('aria-pressed', 'true');
          if (stateText) stateText.textContent = 'ON';
        } else {
          btnToggle.classList.remove('active');
          btnToggle.setAttribute('aria-pressed', 'false');
          if (stateText) stateText.textContent = 'OFF';
        }
      }

      const metricsEl = document.getElementById('word-sync-metrics-badge');
      if (metricsEl) {
        if (this.words.length > 0) {
          const kb = (this.metrics.bytesLoaded / 1024).toFixed(1);
          metricsEl.textContent = `✓ Word Sync: ${this.words.length.toLocaleString()} words (${kb} KB, ${this.metrics.loadMs}ms)`;
          metricsEl.style.display = 'inline-flex';
        } else {
          metricsEl.style.display = 'none';
        }
      }
    },

    /**
     * Prepares exact word timestamps and VBR seek calibration for an episode.
     */
    prepareEpisode: async function (episode) {
      const epId = episode.id || episode.episode_id;
      this.currentEpisodeId = epId;
      this.currentEpisode = episode;
      this.words = [];
      this.vbrData = null;
      this.turnWordMap = {};
      this.clearHighlights();

      const t0 = performance.now();
      await this.loadWordsBlob(epId);
      this.metrics.loadMs = Math.round(performance.now() - t0);
      this.metrics.wordCount = this.words.length;

      // Group words by segment turn if turns exist
      if (episode.segments && this.words.length > 0) {
        this.indexWordsByTurn(episode.segments);
      }

      // In Firefox, proactively start progressive VBR stream buffering & in-memory Xing->Info patching
      if (this.isFirefox && this.vbrData && episode.media_url) {
        this.ensureFirefoxPatchedStream(episode.media_url);
      }

      this.updateUI();
    },

    /**
     * Ensures word timings and VBR calibration data are loaded for an episode ID
     * (e.g. when starting playback directly from a search result card).
     */
    ensureEpisodeLoaded: async function (episodeId) {
      if (!episodeId) return;
      if (this.currentEpisodeId === episodeId && this.words.length > 0) {
        return;
      }
      this.currentEpisodeId = episodeId;
      await this.loadWordsBlob(episodeId);
    },

    /**
     * Fetches and decodes compact binary word BLOB and optional `VBR1` trailer.
     * Binary Format:
     * - 4 bytes uint32: word_count (N)
     * - N * 6 bytes: [uint32 start_ms, uint16 duration_ms]
     * - Optional VBR1 Trailer:
     *   - 4B: "VBR1"
     *   - 12B: [uint32 total_dur_ms, uint32 id3_len, uint32 bytes_len]
     *   - 100B: uint8[100] Xing TOC
     *   - 4B: uint32 sample_count (M)
     *   - M * 8B: [uint32 pcm_ms, uint32 audio_byte_offset]
     */
    loadWordsBlob: async function (episodeId) {
      if (this.vbrCache[episodeId]) {
        const cached = this.vbrCache[episodeId];
        this.words = cached.words;
        this.vbrData = cached.vbrData;
        this.metrics.bytesLoaded = cached.bytesLoaded;
        this.metrics.format = 'option_c_bin';
        return;
      }

      const candidateUrls = [
        `./words/${encodeURIComponent(episodeId)}.bin`,
        `/static/words/${encodeURIComponent(episodeId)}.bin`,
        `/api/episodes/${encodeURIComponent(episodeId)}/words?format=bin`,
      ];

      for (const url of candidateUrls) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const buf = await res.arrayBuffer();
            this.metrics.bytesLoaded = buf.byteLength;
            if (buf.byteLength >= 4) {
              const view = new DataView(buf);
              const wordCount = view.getUint32(0, true);
              const words = [];
              let offset = 4;

              for (let i = 0; i < wordCount; i++) {
                if (offset + 6 > buf.byteLength) break;
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
              if (offset + 120 <= buf.byteLength) {
                const m0 = view.getUint8(offset);
                const m1 = view.getUint8(offset + 1);
                const m2 = view.getUint8(offset + 2);
                const m3 = view.getUint8(offset + 3);
                // 'VBR1' = 0x56, 0x42, 0x52, 0x31
                if (m0 === 0x56 && m1 === 0x42 && m2 === 0x52 && m3 === 0x31) {
                  vbrData = this._parseVbrTrailer(buf, view, offset);
                }
              }

              this.words = words;
              this.vbrData = vbrData;
              this.vbrCache[episodeId] = {
                words: words,
                vbrData: vbrData,
                bytesLoaded: buf.byteLength,
              };
              this.metrics.format = 'option_c_bin';
              return;
            }
          }
        } catch (_) {}
      }
      this.words = [];
      this.vbrData = null;
      this.metrics.bytesLoaded = 0;
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
    ensureFirefoxPatchedStream: function (mediaUrl) {
      if (!mediaUrl || !this.vbrData) return null;
      if (this._ffStreams[mediaUrl]) {
        return this._ffStreams[mediaUrl];
      }

      const id3Len = this.vbrData.id3Len || 0;
      const minHeaderBytes = id3Len + 1024;
      const state = {
        mediaUrl,
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
          const res = await fetch(mediaUrl);
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
          console.warn('[WordSync] Firefox progressive stream fetch fallback:', err);
          state.failed = true;
          notifyWaiters();
        }
      })();

      return state;
    },

    /**
     * Computes the byte offset in the MP3 file required to seek and play at `targetPhysicalSec`.
     */
    getRequiredBytesForTime: function (targetPhysicalSec) {
      if (!this.vbrData) return 0;
      const audioByteOff = this._interp(
        Math.max(0, targetPhysicalSec),
        this.vbrData.pcmTimes,
        this.vbrData.byteOffsets
      );
      // Include ID3 header + target audio byte offset + 128 KB read-ahead (~10s of audio)
      return Math.min(
        this.vbrData.id3Len + this.vbrData.bytesLen,
        Math.ceil(this.vbrData.id3Len + audioByteOff + 131072)
      );
    },

    /**
     * Synchronously returns a patched `blob:` URL if sufficient bytes are already buffered in RAM,
     * or `null` if still buffering.
     */
    getReadyFirefoxBlobUrl: function (mediaUrl, targetPhysicalSec) {
      if (!this.isFirefox || !this.vbrData || !mediaUrl) return null;
      const state = this.ensureFirefoxPatchedStream(mediaUrl);
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

    /**
     * Waits until the progressive Firefox stream has buffered enough bytes to cover
     * `targetPhysicalSec` and returns the patched `blob:` URL (or `null` on failure).
     */
    waitForFirefoxBlobUrl: async function (mediaUrl, targetPhysicalSec) {
      if (!this.isFirefox || !this.vbrData || !mediaUrl) return null;
      const readyUrl = this.getReadyFirefoxBlobUrl(mediaUrl, targetPhysicalSec);
      if (readyUrl) return readyUrl;

      const state = this.ensureFirefoxPatchedStream(mediaUrl);
      if (!state || state.failed) return null;

      const reqBytes = this.getRequiredBytesForTime(targetPhysicalSec);
      await new Promise(resolve => {
        if (state.failed || state.done || (state.patched && state.fetchedBytes >= reqBytes)) {
          resolve(state);
        } else {
          state.waiters.push({ requiredBytes: reqBytes, resolve });
        }
      });

      return this.getReadyFirefoxBlobUrl(mediaUrl, targetPhysicalSec);
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

      if (clampedPhys <= 0.01 || !this.vbrData) {
        this.seekOffset = 0.0;
        return clampedPhys;
      }

      if (this.streamMode === 'patched_blob') {
        // Client-side Info-patched Blob uses exact linear byte-offset seeking
        const seekTime = this._interp(clampedPhys, this.vbrData.pcmTimes, this.vbrData.linearSeekTimes);
        this.seekOffset = clampedPhys - seekTime;
        return Math.max(0, seekTime);
      }

      // Direct Podbean CDN streaming with raw Xing header
      if (this.isFirefox) {
        const dur = this.vbrData.totalDurSec;
        const bucketWidth = dur / 100.0;
        let bestS = clampedPhys;
        let bestErr = Infinity;
        let bestDelta = 0.0;

        for (let k = 0; k < 100; k++) {
          const delta = this.vbrData.ffBucketDeltas[k];
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
      const seekTime = this._interp(clampedPhys, this.vbrData.pcmTimes, this.vbrData.xingSeekTimes);
      this.seekOffset = clampedPhys - seekTime;
      return Math.max(0, seekTime);
    },

    /**
     * Converts raw `audio.currentTime` into true physical PCM time (seconds).
     */
    getPhysicalTime: function (rawCurrentTime) {
      if (typeof rawCurrentTime !== 'number' || isNaN(rawCurrentTime)) return 0;
      if (!this.vbrData) return rawCurrentTime;
      return Math.max(0, rawCurrentTime + (this.seekOffset || 0.0));
    },

    /**
     * Maps global words into turn buckets matching each segment's start/end window.
     */
    indexWordsByTurn: function (segments) {
      this.turnWordMap = {};
      let wordCursor = 0;

      segments.forEach((seg, turnIdx) => {
        const segSt = parseFloat(seg.start_sec || 0);
        const segEn = parseFloat(seg.end_sec || 0);
        const turnWords = [];

        // Advance cursor to words within this turn window
        while (wordCursor < this.words.length && this.words[wordCursor].s < segSt - 0.25) {
          wordCursor++;
        }

        let tempIdx = wordCursor;
        while (tempIdx < this.words.length && this.words[tempIdx].s <= segEn + 0.35) {
          const w = this.words[tempIdx];
          w.turnIdx = turnIdx;
          w.wordIdxInTurn = turnWords.length;
          turnWords.push(w);
          tempIdx++;
        }

        this.turnWordMap[turnIdx] = turnWords;
      });
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
        const rawSentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [trimmed];
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

      // If no exact word timings exist for this talk, render clean original paragraphs
      if (turnWords.length === 0) {
        return paragraphs.map(p => `<p class="turn-p">${this.escapeHtml(p)}</p>`).join('');
      }

      // If exact word timings ARE available, wrap words inline without changing any whitespace
      let wordCursorInTurn = 0;
      return paragraphs.map(pText => {
        const tokens = pText.split(/(\s+)/);
        const wrappedTokens = tokens.map(token => {
          if (!token || /^\s+$/.test(token)) {
            return token; // Preserves exact whitespace
          }
          if (wordCursorInTurn < turnWords.length) {
            const w = turnWords[wordCursorInTurn++];
            return `<span class="transcript-word" id="${w.id}" data-start="${w.s}" data-end="${w.e}" title="Click to seek to ${this.formatSeconds(w.s)}">${this.escapeHtml(token)}</span>`;
          }
          return this.escapeHtml(token);
        });
        return `<p class="turn-p">${wrappedTokens.join('')}</p>`;
      }).join('');
    },

    /**
     * Updates active word highlight based on raw audio.currentTime.
     * (Zero auto-scrolling: user retains complete natural scroll control).
     */
    update: function (rawCurrentTime) {
      if (!this.enabled || !this.words || this.words.length === 0) return;
      if (typeof rawCurrentTime !== 'number' || isNaN(rawCurrentTime)) return;

      const currentTime = this.getPhysicalTime(rawCurrentTime);

      // Clear seek lead-in target once playback passes the targeted word start
      if (this._seekTargetWordTime !== null && currentTime >= this._seekTargetWordTime) {
        this._seekTargetWordTime = null;
      }

      // Binary search across words for physical currentTime
      const targetIdx = this.findWordIndex(currentTime);
      if (targetIdx >= 0) {
        if (this.activeWordIdx !== targetIdx) {
          const targetWord = this.words[targetIdx];
          const newSpan = document.getElementById(targetWord.id);

          if (newSpan) {
            this.activeWordIdx = targetIdx;
            if (this.activeWordEl && this.activeWordEl !== newSpan) {
              this.activeWordEl.classList.remove('active-word');
            }
            newSpan.classList.add('active-word');
            this.activeWordEl = newSpan;
          }
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
      // If currently in the lead-in before a specifically sought word, highlight that word
      if (
        this._seekTargetWordTime !== null &&
        time >= this._seekTargetWordTime - 10.0 &&
        time < this._seekTargetWordTime
      ) {
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
