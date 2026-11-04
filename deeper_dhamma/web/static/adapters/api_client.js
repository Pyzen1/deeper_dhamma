/**
 * Deeper Dhamma — Local Development API Client (Bottle.py)
 * Queries live Python REST endpoints on http://127.0.0.1:34266.
 * Used exclusively during local development to reflect database updates instantly.
 */

'use strict';

class ApiDatabaseClient {
  constructor() {
    this.readyPromise = Promise.resolve(true);
  }

  async init() {
    return this.readyPromise;
  }

  async getStats() {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch stats`);
    return res.json();
  }

  async search(query, options = {}) {
    const params = new URLSearchParams({
      q: query,
      limit: String(options.limit || 500),
      exact: options.exact ? '1' : '0',
    });
    if (options.teacher) params.set('teacher', options.teacher);
    if (options.year) params.set('year', options.year);
    if (options.startDate) params.set('start_date', options.startDate);
    if (options.endDate) params.set('end_date', options.endDate);
    if (options.sort) params.set('sort', options.sort);
    const res = await fetch(`/api/search?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: Search request failed`);
    return res.json();
  }

  async getEpisodes(options = {}) {
    const params = new URLSearchParams({
      transcribed_only: options.transcribedOnly ? '1' : '0',
      limit: String(options.limit !== undefined ? options.limit : 60),
    });
    if (options.teacher) params.set('teacher', options.teacher);
    if (options.year) params.set('year', options.year);
    if (options.startDate) params.set('start_date', options.startDate);
    if (options.endDate) params.set('end_date', options.endDate);
    if (options.sort) params.set('sort', options.sort);
    if (options.offset) params.set('offset', String(options.offset));
    const res = await fetch(`/api/episodes?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch episodes`);
    return res.json();
  }

  async getEpisode(episodeId) {
    const res = await fetch(`/api/episodes/${encodeURIComponent(episodeId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch episode`);
    return res.json();
  }

  async getAllTerms() {
    const res = await fetch('/api/lexicon/all_terms');
    if (!res.ok) return [];
    return res.json();
  }

  async searchLexicon(query, limit = 10) {
    const res = await fetch(`/api/lexicon/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  }

  async lookupLexicon(term) {
    const res = await fetch(`/api/lexicon/lookup?term=${encodeURIComponent(term)}`);
    if (!res.ok) return { term, found: false, data: null };
    return res.json();
  }

  async getLexiconPage(options = {}) {
    const params = new URLSearchParams();
    if (options.mode) params.set('mode', options.mode);
    if (options.category) params.set('category', options.category);
    if (options.letter) params.set('letter', options.letter);
    if (options.sort) params.set('sort', options.sort);
    if (options.page) params.set('page', String(options.page));
    if (options.limit) params.set('limit', String(options.limit));
    const res = await fetch(`/api/lexicon/page?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch lexicon page`);
    return res.json();
  }

  async getSourceDocuments() {
    const res = await fetch('/api/lexicon/sources');
    if (!res.ok) return [];
    return res.json();
  }

  async getSourceDocument(query) {
    const res = await fetch(`/api/lexicon/source_doc?query=${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    return res.json();
  }
}

window.DeeperDhammaDB = ApiDatabaseClient;
