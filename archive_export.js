/**
 * Deeper Dhamma — Client-Side PKZIP Engine & Transcript Exporter
 */

(function () {
  'use strict';

  const DD = (window.DeeperDhamma = window.DeeperDhamma || {});
  const {
    state,
    els,
    dbService,
    buildBrowseQueryOpts,
    clampFloatingPanelToViewport,
    resetFloatingPanelPosition,
  } = DD;

  // ==========================================================================
  // Client-Side Zero-Storage PKZIP Engine (SimpleZipWriter)
  // ==========================================================================

  class SimpleZipWriter {
    constructor() {
      this.files = [];
    }

    addFile(filename, content) {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      this.files.push({ filename, data });
    }

    static crcTable = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
          c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        }
        t[i] = c;
      }
      return t;
    })();

    static crc32(buf) {
      let crc = 0xFFFFFFFF;
      const table = SimpleZipWriter.crcTable;
      for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    static async deflateBytes(bytes) {
      if (typeof CompressionStream !== 'undefined') {
        try {
          const cs = new CompressionStream('deflate-raw');
          const writer = cs.writable.getWriter();
          writer.write(bytes);
          writer.close();
          const res = await new Response(cs.readable).arrayBuffer();
          return new Uint8Array(res);
        } catch (_) {}
      }
      return null;
    }

    async buildBlob() {
      const localHeaders = [];
      const centralDirs = [];
      let offset = 0;

      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

      for (const file of this.files) {
        const nameBytes = new TextEncoder().encode(file.filename);
        const crc = SimpleZipWriter.crc32(file.data);
        const uncompressedSize = file.data.length;

        const deflated = await SimpleZipWriter.deflateBytes(file.data);
        const compressionMethod = deflated ? 8 : 0;
        const fileBytes = deflated || file.data;
        const compressedSize = fileBytes.length;

        // Local file header (30 bytes + name + data)
        const lh = new Uint8Array(30 + nameBytes.length + compressedSize);
        const lhView = new DataView(lh.buffer);

        lhView.setUint32(0, 0x04034b50, true);
        lhView.setUint16(4, 20, true);
        lhView.setUint16(6, 0x0800, true); // UTF-8 language encoding flag
        lhView.setUint16(8, compressionMethod, true);
        lhView.setUint16(10, dosTime, true);
        lhView.setUint16(12, dosDate, true);
        lhView.setUint32(14, crc, true);
        lhView.setUint32(18, compressedSize, true);
        lhView.setUint32(22, uncompressedSize, true);
        lhView.setUint16(26, nameBytes.length, true);
        lhView.setUint16(28, 0, true);

        lh.set(nameBytes, 30);
        lh.set(fileBytes, 30 + nameBytes.length);
        localHeaders.push(lh);

        // Central directory header (46 bytes + name)
        const cd = new Uint8Array(46 + nameBytes.length);
        const cdView = new DataView(cd.buffer);

        cdView.setUint32(0, 0x02014b50, true);
        cdView.setUint16(4, 20, true);
        cdView.setUint16(6, 20, true);
        cdView.setUint16(8, 0x0800, true);
        cdView.setUint16(10, compressionMethod, true);
        cdView.setUint16(12, dosTime, true);
        cdView.setUint16(14, dosDate, true);
        cdView.setUint32(16, crc, true);
        cdView.setUint32(20, compressedSize, true);
        cdView.setUint32(24, uncompressedSize, true);
        cdView.setUint16(28, nameBytes.length, true);
        cdView.setUint16(30, 0, true);
        cdView.setUint16(32, 0, true);
        cdView.setUint16(34, 0, true);
        cdView.setUint16(36, 0, true);
        cdView.setUint32(38, 0, true);
        cdView.setUint32(42, offset, true);

        cd.set(nameBytes, 46);
        centralDirs.push(cd);

        offset += lh.length;
      }

      const cdOffset = offset;
      let cdTotalSize = 0;
      centralDirs.forEach(cd => cdTotalSize += cd.length);

      // End of central directory record (22 bytes)
      const eocd = new Uint8Array(22);
      const eocdView = new DataView(eocd.buffer);

      eocdView.setUint32(0, 0x06054b50, true);
      eocdView.setUint16(4, 0, true);
      eocdView.setUint16(6, 0, true);
      eocdView.setUint16(8, this.files.length, true);
      eocdView.setUint16(10, this.files.length, true);
      eocdView.setUint32(12, cdTotalSize, true);
      eocdView.setUint32(16, cdOffset, true);
      eocdView.setUint16(20, 0, true);

      return new Blob([...localHeaders, ...centralDirs, eocd], { type: 'application/zip' });
    }
  }

  // ==========================================================================
  // Client-Side On-The-Fly Transcript Exporter (Zero Storage)
  // ==========================================================================

  const TranscriptExporter = {
    formatTimestampHms(totalSeconds) {
      const s = Math.max(0, Math.floor(totalSeconds || 0));
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = s % 60;
      const pad = (n) => String(n).padStart(2, '0');
      if (hours > 0) {
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
      }
      return `${pad(minutes)}:${pad(seconds)}`;
    },

    formatTimestampSrt(totalSeconds) {
      const s = Math.max(0, totalSeconds || 0);
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = Math.floor(s % 60);
      const millis = Math.floor((s - Math.floor(s)) * 1000);
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
    },

    formatTimestampVtt(totalSeconds) {
      const s = Math.max(0, totalSeconds || 0);
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const seconds = Math.floor(s % 60);
      const millis = Math.floor((s - Math.floor(s)) * 1000);
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
    },

    sanitizeSlug(text) {
      if (!text) return 'talk';
      return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 60);
    },

    getFilename(ep, ext) {
      const dateStr = ep.date || (ep.year ? `${ep.year}-01-01` : '2023-01-01');
      const cleanDate = dateStr.includes('-') ? dateStr : `${dateStr}-01-01`;
      const slug = this.sanitizeSlug(ep.title || ep.id);
      return `${cleanDate}_${slug}_transcript.${ext}`;
    },

    toMarkdown(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const durHms = this.formatTimestampHms(ep.duration_sec || 0);
      const streamLink = ep.media_url ? `[Stream on Podbean](${ep.media_url})` : 'N/A';

      const lines = [
        `# ${ep.title}`,
        `- **Date**: ${ep.date || ep.year || 'Unknown'}`,
        `- **Primary Teacher**: ${teacher}`,
        `- **Audio Stream**: ${streamLink}`,
        `- **Duration**: ${durHms} (${Math.round(ep.duration_sec || 0)}s)`,
        '',
        '---',
        '',
      ];

      segments.forEach((seg) => {
        const ts = this.formatTimestampHms(seg.start_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(`### [${ts}] ${spk}`);
        lines.push(seg.text || '');
        lines.push('');
      });

      return lines.join('\n');
    },

    toPlainText(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const durHms = this.formatTimestampHms(ep.duration_sec || 0);

      const lines = [
        `Title: ${ep.title}`,
        `Date: ${ep.date || ep.year || 'Unknown'}`,
        `Teacher: ${teacher}`,
        `Duration: ${durHms}`,
        `Audio: ${ep.media_url || 'N/A'}`,
        '',
        '================================================================================',
        '',
      ];

      segments.forEach((seg) => {
        const ts = this.formatTimestampHms(seg.start_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(`[${ts}] ${spk}:`);
        lines.push(seg.text || '');
        lines.push('');
      });

      return lines.join('\n');
    },

    toSrt(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const lines = [];

      segments.forEach((seg, idx) => {
        const startStr = this.formatTimestampSrt(seg.start_sec);
        const endStr = this.formatTimestampSrt(seg.end_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(String(idx + 1));
        lines.push(`${startStr} --> ${endStr}`);
        lines.push(`[${spk}] ${seg.text || ''}`);
        lines.push('');
      });

      return lines.join('\n');
    },

    toVtt(ep) {
      const segments = ep.segments || [];
      const teacher = ep.primary_display || ep.teacher || 'BSWA Monastic';
      const lines = [
        'WEBVTT',
        `NOTE Title: ${ep.title}`,
        `NOTE Speaker: ${teacher}`,
        `NOTE Date: ${ep.date || ep.year || ''}`,
        '',
      ];

      segments.forEach((seg) => {
        const startStr = this.formatTimestampVtt(seg.start_sec);
        const endStr = this.formatTimestampVtt(seg.end_sec);
        const spk = seg.speaker_display || teacher;
        lines.push(`${startStr} --> ${endStr}`);
        lines.push(`<v ${spk}>${seg.text || ''}`);
        lines.push('');
      });

      return lines.join('\n');
    },

    toJson(ep) {
      return JSON.stringify(ep, null, 2);
    },

    triggerDownload(filename, mimeType, content) {
      const blob = typeof content === 'string'
        ? new Blob([content], { type: mimeType })
        : (content instanceof Blob ? content : new Blob([content], { type: mimeType }));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },

    async downloadSingle(epOrId, format = 'md') {
      let ep = epOrId;
      if (typeof epOrId === 'string' || !epOrId.segments) {
        const epId = typeof epOrId === 'string' ? epOrId : (epOrId.id || epOrId.episode_id);
        try {
          ep = await dbService.getEpisode(epId);
        } catch (err) {
          console.error(`Failed to load transcript for ${epId}:`, err);
        }
      }
      if (!ep || !ep.segments || ep.segments.length === 0) {
        alert('This episode has not yet been transcribed.');
        return;
      }

      let content = '';
      let mime = 'text/plain; charset=utf-8';
      let ext = format;

      switch (format) {
        case 'md':
          content = this.toMarkdown(ep);
          mime = 'text/markdown; charset=utf-8';
          break;
        case 'txt':
          content = this.toPlainText(ep);
          mime = 'text/plain; charset=utf-8';
          break;
        case 'srt':
          content = this.toSrt(ep);
          mime = 'application/x-subrip; charset=utf-8';
          break;
        case 'vtt':
          content = this.toVtt(ep);
          mime = 'text/vtt; charset=utf-8';
          break;
        case 'json':
          content = this.toJson(ep);
          mime = 'application/json; charset=utf-8';
          break;
        default:
          content = this.toMarkdown(ep);
          ext = 'md';
      }

      const filename = this.getFilename(ep, ext);
      this.triggerDownload(filename, mime, content);
    }
  };

  // ==========================================================================
  // Archive Compilation Queue & Progress Synchronization
  // ==========================================================================

  async function compileAndDownloadArchive(episodesList, format = 'md', archiveBasename = 'transcripts') {
    if (!episodesList || episodesList.length === 0) {
      alert('No transcribed talks found matching the selected filters.');
      return;
    }

    state.archiveCancelRequested = false;

    // Show modal
    if (els.archiveProgressModal) {
      els.archiveProgressModal.style.display = 'flex';
      els.archiveProgressBar.style.width = '0%';
      els.archiveProgressBar.classList.remove('complete');
      els.archiveProgressPercent.textContent = '0%';
      els.archiveProgressCount.textContent = `0 of ${episodesList.length}`;
      els.archiveModalTitle.textContent = 'Compiling Transcript Archive';
      els.archiveModalSubtitle.textContent = `Packaging ${episodesList.length} talks into ${format.toUpperCase()} (.zip)...`;
      els.archiveModalCurrentItem.textContent = 'Initializing in-memory zip archive...';
    }

    const zip = new SimpleZipWriter();
    let processedCount = 0;

    for (let i = 0; i < episodesList.length; i++) {
      if (state.archiveCancelRequested) {
        if (els.archiveProgressModal) els.archiveProgressModal.style.display = 'none';
        return;
      }

      const summary = episodesList[i];
      const epId = summary.id || summary.episode_id;
      if (els.archiveModalCurrentItem) {
        els.archiveModalCurrentItem.textContent = `[${i + 1}/${episodesList.length}] Compiling: "${summary.title}"...`;
      }

      let ep = summary;
      if (!ep.segments || ep.segments.length === 0) {
        try {
          ep = await dbService.getEpisode(epId);
        } catch (e) {
          console.warn(`Could not load segments for ${epId}:`, e);
        }
      }

      if (ep && ep.segments && ep.segments.length > 0) {
        let content = '';
        switch (format) {
          case 'md': content = TranscriptExporter.toMarkdown(ep); break;
          case 'txt': content = TranscriptExporter.toPlainText(ep); break;
          case 'srt': content = TranscriptExporter.toSrt(ep); break;
          case 'vtt': content = TranscriptExporter.toVtt(ep); break;
          case 'json': content = TranscriptExporter.toJson(ep); break;
          default: content = TranscriptExporter.toMarkdown(ep);
        }

        const filename = TranscriptExporter.getFilename(ep, format);
        zip.addFile(filename, content);
        processedCount++;
      }

      // Update progress
      const pct = Math.round(((i + 1) / episodesList.length) * 100);
      if (els.archiveProgressBar) els.archiveProgressBar.style.width = `${pct}%`;
      if (els.archiveProgressPercent) els.archiveProgressPercent.textContent = `${pct}%`;
      if (els.archiveProgressCount) els.archiveProgressCount.textContent = `${i + 1} of ${episodesList.length}`;

      // Yield execution to allow DOM render
      await new Promise(r => setTimeout(r, 0));
    }

    if (processedCount === 0) {
      if (els.archiveProgressModal) els.archiveProgressModal.style.display = 'none';
      alert('None of the selected episodes have transcripts available yet.');
      return;
    }

    if (els.archiveModalCurrentItem) {
      els.archiveModalCurrentItem.textContent = 'Finalizing compressed ZIP file...';
    }
    if (els.archiveProgressBar) {
      els.archiveProgressBar.classList.add('complete');
    }

    const zipBlob = await zip.buildBlob();
    const today = new Date().toISOString().split('T')[0];
    const zipFilename = `${today}_deeper_dhamma_${archiveBasename}_${format}.zip`;

    TranscriptExporter.triggerDownload(zipFilename, 'application/zip', zipBlob);

    if (els.archiveModalTitle) els.archiveModalTitle.textContent = '✓ Archive Ready!';
    if (els.archiveModalSubtitle) els.archiveModalSubtitle.textContent = `Downloaded ${processedCount} transcripts in ${format.toUpperCase()} format.`;
    if (els.archiveModalCurrentItem) els.archiveModalCurrentItem.textContent = `File: ${zipFilename}`;

    setTimeout(() => {
      if (els.archiveProgressModal) els.archiveProgressModal.style.display = 'none';
    }, 1800);
  }

  async function downloadFilteredArchive(format) {
    try {
      let talks = state.currentFilteredTalks || [];
      if (state.search.filteredEpisodeIds && state.search.filteredEpisodeIds.length > talks.length) {
        talks = await dbService.getEpisodesByIds(state.search.filteredEpisodeIds);
      } else if (state.search.filteredFilterOpts && state.search.totalEpisodes > talks.length) {
        const data = await dbService.getEpisodes({ ...state.search.filteredFilterOpts, limit: 0, offset: 0 });
        if (data && Array.isArray(data.episodes)) {
          talks = data.episodes;
        }
      }
      await compileAndDownloadArchive(talks, format, 'filtered_transcripts');
    } catch (err) {
      console.error('Failed to download filtered archive:', err);
      alert('Failed to load matching talks for download.');
    }
  }

  async function downloadBrowseFilteredArchive(format) {
    try {
      let talks = state.catalog || [];
      if (state.browse.filteredEpisodeIds && state.browse.filteredEpisodeIds.length > talks.length) {
        talks = await dbService.getEpisodesByIds(state.browse.filteredEpisodeIds);
      } else if (state.browse.total > talks.length) {
        const data = await dbService.getEpisodes(buildBrowseQueryOpts({ limit: 0, offset: 0 }));
        if (data && Array.isArray(data.episodes)) {
          talks = data.episodes;
        }
      }
      await compileAndDownloadArchive(talks, format, 'browse_filtered_transcripts');
    } catch (err) {
      console.error('Failed to download filtered browse archive:', err);
      alert('Failed to load matching talks for download.');
    }
  }

  async function downloadAllArchive(format) {
    try {
      const data = await dbService.getEpisodes({
        transcribedOnly: true,
        limit: 10000,
      });
      const episodes = data.episodes || [];
      if (!episodes.length) {
        alert('No transcribed episodes found in the database.');
        return;
      }
      await compileAndDownloadArchive(episodes, format, 'all_transcripts');
    } catch (err) {
      console.error('Failed to load all episodes:', err);
      alert('Failed to load archive catalog for download.');
    }
  }

  function setupDownloadDropdowns() {
    function closeAllDropdowns() {
      document.querySelectorAll('.download-dropdown-wrapper.open').forEach(w => {
        w.classList.remove('open');
        resetFloatingPanelPosition(w.querySelector('.download-dropdown-menu'));
        const pc = w.closest('.episode-card, .result-card');
        if (pc) pc.classList.remove('dropdown-active');
      });
    }

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.download-dropdown-btn');
      if (btn) {
        if (btn.disabled) return;
        e.stopPropagation();
        const wrapper = btn.closest('.download-dropdown-wrapper');
        if (!wrapper) return;
        const isOpen = wrapper.classList.contains('open');

        // Close all other dropdowns
        document.querySelectorAll('.download-dropdown-wrapper.open').forEach(w => {
          if (w !== wrapper) {
            w.classList.remove('open');
            resetFloatingPanelPosition(w.querySelector('.download-dropdown-menu'));
            const pc = w.closest('.episode-card, .result-card');
            if (pc) pc.classList.remove('dropdown-active');
          }
        });

        const willOpen = !isOpen;
        wrapper.classList.toggle('open', willOpen);
        const menu = wrapper.querySelector('.download-dropdown-menu');
        if (menu) {
          if (willOpen) {
            clampFloatingPanelToViewport(wrapper, menu);
          } else {
            resetFloatingPanelPosition(menu);
          }
        }
        const parentCard = wrapper.closest('.episode-card, .result-card');
        if (parentCard) {
          parentCard.classList.toggle('dropdown-active', willOpen);
        }
        return;
      }

      const opt = e.target.closest('.download-option');
      if (opt) {
        e.stopPropagation();
        const format = opt.dataset.format;
        const wrapper = opt.closest('.download-dropdown-wrapper');
        if (wrapper) {
          wrapper.classList.remove('open');
          resetFloatingPanelPosition(wrapper.querySelector('.download-dropdown-menu'));
          const pc = wrapper.closest('.episode-card, .result-card');
          if (pc) pc.classList.remove('dropdown-active');
        }

        if (wrapper && wrapper.id === 'filtered-archive-dropdown-wrapper') {
          downloadFilteredArchive(format);
        } else if (wrapper && wrapper.id === 'browse-filtered-archive-dropdown-wrapper') {
          downloadBrowseFilteredArchive(format);
        } else if (wrapper && wrapper.id === 'all-archive-dropdown-wrapper') {
          downloadAllArchive(format);
        } else if (wrapper && wrapper.id === 'single-talk-dropdown-wrapper') {
          if (state.currentEpisode) {
            TranscriptExporter.downloadSingle(state.currentEpisode, format);
          }
        } else if (opt.dataset.action === 'download-card-format') {
          const epId = opt.dataset.epId;
          TranscriptExporter.downloadSingle(epId, format);
        }
        return;
      }

      // Click outside closes open dropdowns
      closeAllDropdowns();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllDropdowns();
      }
    });
  }

  Object.assign(DD, {
    SimpleZipWriter,
    TranscriptExporter,
    compileAndDownloadArchive,
    downloadFilteredArchive,
    downloadBrowseFilteredArchive,
    downloadAllArchive,
    setupDownloadDropdowns,
  });
})();
