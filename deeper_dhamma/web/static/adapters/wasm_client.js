/**
 * Deeper Dhamma — Static SQLite WASM Client
 * Runs in-browser SQLite queries via Web Worker off the main UI thread.
 * Absolutely zero external API or localhost dependencies.
 */

'use strict';

class WasmDatabaseClient {
  constructor() {
    this.worker = null;
    this.reqSeq = 0;
    this.pending = new Map();
    this.readyPromise = null;
    this.isSupported = true;
    this.errorMessage = null;
  }

  init() {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.Worker) {
        this.isSupported = false;
        this.errorMessage = 'Web Workers are not supported by this browser.';
        console.error('[WASM Client]', this.errorMessage);
        return reject(new Error(this.errorMessage));
      }

      try {
        const versionQuery = (typeof window !== 'undefined' && window.__DEEPER_DHAMMA_VERSION__)
          ? `?v=${encodeURIComponent(window.__DEEPER_DHAMMA_VERSION__)}`
          : '';
        this.worker = new Worker(`./db_worker.js${versionQuery}`);
        this.worker.onmessage = (e) => {
          const { id, success, data, error } = e.data || {};
          if (this.pending.has(id)) {
            const { resolve: res, reject: rej } = this.pending.get(id);
            this.pending.delete(id);
            if (success) res(data);
            else rej(new Error(error || 'Worker query failed'));
          }
        };

        this.worker.onerror = (err) => {
          console.error('[WASM Client] Web Worker error:', err);
          this.isSupported = false;
          this.errorMessage = 'Failed to load SQLite WASM worker engine.';
        };

        this.send('init', { dbUrl: './dhamma_web.db' })
          .then((res) => {
            console.log('[WASM Client] SQLite WASM Worker initialized successfully:', res);
            resolve(true);
          })
          .catch((err) => {
            console.error('[WASM Client] Worker init failed:', err);
            this.isSupported = false;
            this.errorMessage = err.message || 'SQLite WASM database initialization failed.';
            reject(err);
          });
      } catch (err) {
        console.error('[WASM Client] Worker instantiation failed:', err);
        this.isSupported = false;
        this.errorMessage = err.message || 'Worker initialization failed.';
        reject(err);
      }
    });

    return this.readyPromise;
  }

  send(type, payload) {
    const id = ++this.reqSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async getStats() {
    await this.init();
    return this.send('get_stats');
  }

  async search(query, options = {}) {
    await this.init();
    return this.send('search', { query, ...options });
  }

  async getEpisodes(options = {}) {
    await this.init();
    return this.send('get_episodes', options);
  }

  async getEpisode(episodeId) {
    await this.init();
    return this.send('get_episode', { episodeId });
  }

  async getEpisodeWords(episodeId) {
    await this.init();
    return this.send('get_episode_words', { episodeId });
  }

  async getEpisodesByIds(ids) {
    await this.init();
    return this.send('get_episodes_by_ids', { ids });
  }

  async getAllTerms() {
    await this.init();
    return this.send('get_all_terms');
  }

  async searchLexicon(query, limit = 10) {
    await this.init();
    return this.send('search_lexicon', { query, limit });
  }

  async lookupLexicon(term) {
    await this.init();
    const data = await this.send('lookup_lexicon', { term });
    return { term, found: !!data, data };
  }

  async getLexiconPage(options = {}) {
    await this.init();
    return this.send('get_lexicon_page', options);
  }

  async getSourceDocuments() {
    await this.init();
    return this.send('get_source_documents');
  }

  async getSourceDocument(query) {
    await this.init();
    return this.send('get_source_document', { query });
  }
}

window.DeeperDhammaDB = WasmDatabaseClient;
