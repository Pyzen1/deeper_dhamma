/**
 * Deeper Dhamma — Cross-Browser VBR Neutralized & Podbean CDN Audio Player Engine
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
    formatSeconds,
    getSpeakerColor,
    isCompanionBottomSheet,
    toggleMobileLexSheet,
    updateActiveCompanionTerm,
  } = DD;
  const updateHeaderPlayButton = (...args) => DD.updateHeaderPlayButton(...args);

  // ==========================================================================
  // Audio Player Engine (Cross-Browser VBR Neutralized & Podbean CDN Streaming)
  // ==========================================================================

  function setupAudioEngine() {
    const audio = els.nativeAudio;
    let isScrubbing = false;
    let scrubCommitted = false;

    const mainEl = document.getElementById('main-content');
    function updateLayoutChromeVars() {
      if (els.playerBar) {
        const rectH = els.playerBar.getBoundingClientRect().height;
        const h = Math.ceil(rectH) || els.playerBar.offsetHeight || 78;
        document.documentElement.style.setProperty('--player-height', `${h}px`);
      }
      if (mainEl) {
        const rectMh = mainEl.getBoundingClientRect().height;
        if (rectMh > 0) {
          document.documentElement.style.setProperty('--main-height', `${Math.floor(rectMh)}px`);
        }
      }
      if (els.transcriptStickyToolbar && !els.transcriptStickyToolbar.classList.contains('is-actions-open')) {
        const rectTh = els.transcriptStickyToolbar.getBoundingClientRect().height;
        if (rectTh > 0) {
          const th = Math.ceil(rectTh);
          document.documentElement.style.setProperty('--toolbar-height', `${th}px`);
        }
      }
    }
    updateLayoutChromeVars();
    window.addEventListener('resize', () => {
      updateLayoutChromeVars();
      if (!isCompanionBottomSheet() && els.lexCompanion && els.lexCompanion.classList.contains('is-expanded')) {
        toggleMobileLexSheet(false);
      }
      document.querySelectorAll('.download-dropdown-wrapper.open').forEach((w) => {
        clampFloatingPanelToViewport(w, w.querySelector('.download-dropdown-menu'));
      });
      document.querySelectorAll('.browse-popover-wrapper.open').forEach((w) => {
        clampFloatingPanelToViewport(w, w.querySelector('.browse-popover-panel'));
      });
    }, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => updateLayoutChromeVars());
      if (els.playerBar) ro.observe(els.playerBar);
      if (mainEl) ro.observe(mainEl);
      if (els.transcriptStickyToolbar) ro.observe(els.transcriptStickyToolbar);
    }

    if (window.WordSync) {
      window.WordSync.bindAudio(audio);
      window.WordSync.onClockTick = () => syncProgress(true);
    }

    function getTotalDuration() {
      const vbr =
        window.WordSync && typeof window.WordSync.getPlayingVbrData === 'function'
          ? window.WordSync.getPlayingVbrData()
          : window.WordSync && window.WordSync.vbrData;
      if (vbr && vbr.totalDurSec > 0) {
        return vbr.totalDurSec;
      }
      return Number.isFinite(audio.duration) ? audio.duration : 0;
    }

    function safeSeek(targetPhysicalTime) {
      const totalDur = getTotalDuration();
      const dur = totalDur > 0 ? totalDur : Infinity;
      const clampedPhys = Math.max(0, Math.min(dur, targetPhysicalTime));
      const seekWordIdx = window.WordSync && window.WordSync.words && window.WordSync.words.length > 0
        ? window.WordSync.findWordIndex(clampedPhys + 0.05)
        : -1;
      const seekSeq = window.WordSync
        ? window.WordSync.beginSeek({ wordIdx: seekWordIdx, companionIdx: -1, wordStartSec: null })
        : ++state._audioSeekSeq;
      state._audioSeekSeq = seekSeq;

      const onSettled = () => {
        if (!audio.seeking && scrubCommitted) {
          scrubCommitted = false;
          isScrubbing = false;
        }
        syncProgress();
      };

      if (state.currentMediaUrl) {
        seekAudioWithVbrCascade({
          audio,
          mediaUrl: state.currentMediaUrl,
          seekSeq,
          physSec: clampedPhys,
          wordStartSec: null,
          shouldPlay: !audio.paused,
          maxDurFallback: dur,
          onSettled,
        });
      } else {
        launchAudioStreamAndSeek({
          audio,
          streamUrl: state.currentStreamUrl || audio.src,
          mode: window.WordSync ? window.WordSync.streamMode : 'cdn',
          seekSeq,
          physSec: clampedPhys,
          wordStartSec: null,
          shouldPlay: !audio.paused,
          maxDurFallback: dur,
          onSettled,
        });
      }
    }
    DD.safeSeek = safeSeek;

    function syncProgress(fromWordSync = false) {
      if (isScrubbing) return; // Do not overwrite slider while user is dragging
      if (audio.seeking || (window.WordSync && window.WordSync.isSeekLocked())) {
        return;
      }
      const rawCur = audio.currentTime;
      const physCur = window.WordSync ? window.WordSync.getPhysicalTime(rawCur) : rawCur;
      const dur = getTotalDuration();
      els.timeCurrent.textContent = formatSeconds(physCur);
      if (dur > 0) {
        els.timeTotal.textContent = formatSeconds(dur);
        els.scrubber.value = Math.min(100, Math.max(0, (physCur / dur) * 100));
      }
      if (state.activeTab === 'transcript-view') {
        const isViewingPlaying = state.playingEpisode && state.currentEpisode && (state.playingEpisode.id === state.currentEpisode.id);
        if (isViewingPlaying) {
          if (!fromWordSync && window.WordSync) {
            window.WordSync.update(rawCur);
          }
          updateActiveCompanionTerm(physCur);
        }
      }
    }

    ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked'].forEach(evt => {
      audio.addEventListener(evt, () => syncProgress(false));
    });

    ['play', 'pause', 'ended'].forEach(evt => {
      audio.addEventListener(evt, () => {
        updateHeaderPlayButton();
        if (evt !== 'play') {
          syncProgress(false);
        }
      });
    });

    audio.addEventListener('seeked', () => {
      if (scrubCommitted) {
        scrubCommitted = false;
        isScrubbing = false;
        syncProgress();
      }
    });

    audio.addEventListener('play', () => {
      const iconSpan = els.btnPlayPause.querySelector('.material-symbols-outlined');
      if (iconSpan) iconSpan.textContent = 'pause';
      els.btnPlayPause.setAttribute('title', 'Pause (Space)');
      els.btnPlayPause.setAttribute('aria-label', 'Pause');
    });

    audio.addEventListener('pause', () => {
      const iconSpan = els.btnPlayPause.querySelector('.material-symbols-outlined');
      if (iconSpan) iconSpan.textContent = 'play_arrow';
      els.btnPlayPause.setAttribute('title', 'Play (Space)');
      els.btnPlayPause.setAttribute('aria-label', 'Play');
    });

    // If a partial progressive Blob reaches the end of its initial slice before
    // the full talk duration, seamlessly upgrade to the newly buffered chunks at physCur.
    audio.addEventListener('ended', () => {
      const playingVbr =
        window.WordSync && typeof window.WordSync.getPlayingVbrData === 'function'
          ? window.WordSync.getPlayingVbrData()
          : window.WordSync && window.WordSync.vbrData;
      if (
        window.WordSync &&
        window.WordSync.streamMode === 'patched_blob' &&
        playingVbr &&
        state.currentMediaUrl
      ) {
        const dur = Number.isFinite(audio.duration) ? audio.duration : playingVbr.totalDurSec;
        const physCur = window.WordSync.getPhysicalTime(audio.currentTime);
        if (dur > 0 && physCur < dur - 5) {
          const mediaUrl = state.currentMediaUrl;
          const upgradeSeq = state._audioSeekSeq;
          window.WordSync.waitForPatchedBlobUrl(mediaUrl, physCur + 30).then(blobUrl => {
            if (!blobUrl || upgradeSeq !== state._audioSeekSeq || state.currentMediaUrl !== mediaUrl) return;
            launchAudioStreamAndSeek({
              audio,
              streamUrl: blobUrl,
              mode: 'patched_blob',
              seekSeq: upgradeSeq,
              physSec: physCur,
              shouldPlay: true,
            });
          });
        }
      }
    });

    audio.addEventListener('error', () => {
      if (audio.error && window.WordSync && state.currentMediaUrl) {
        window.WordSync._awaitingInitialSeek = false;
        window.WordSync._pendingProgrammaticSeek = false;
        window.WordSync._syncPhase = 'idle';
      }
    });

    els.btnPlayPause.addEventListener('click', togglePlayPause);

    if (els.btnPrevTrack) {
      els.btnPrevTrack.addEventListener('click', playPrevTrack);
    }

    if (els.btnNextTrack) {
      els.btnNextTrack.addEventListener('click', playNextTrack);
    }

    els.btnSkipBack.addEventListener('click', () => {
      const curPhys = window.WordSync ? window.WordSync.getPhysicalTime(audio.currentTime) : audio.currentTime;
      safeSeek(curPhys - 15);
    });

    els.btnSkipFwd.addEventListener('click', () => {
      const curPhys = window.WordSync ? window.WordSync.getPhysicalTime(audio.currentTime) : audio.currentTime;
      safeSeek(curPhys + 15);
    });

    // Scrubber: show preview during drag, seek only on commit to prevent stream thrashing
    els.scrubber.addEventListener('input', () => {
      isScrubbing = true;
      scrubCommitted = false;
      const dur = getTotalDuration();
      if (dur > 0) {
        const previewTime = (parseFloat(els.scrubber.value) / 100) * dur;
        els.timeCurrent.textContent = formatSeconds(previewTime);
      }
    });

    const commitScrub = () => {
      if (!isScrubbing || scrubCommitted) return; // change + mouseup both fire; seek once
      scrubCommitted = true;
      const dur = getTotalDuration();
      if (dur > 0) {
        const target = (parseFloat(els.scrubber.value) / 100) * dur;
        safeSeek(target);
      }
      // Release on 'seeked'; fallback timeout in case the seek is dropped
      setTimeout(() => {
        if (scrubCommitted) {
          scrubCommitted = false;
          isScrubbing = false;
        }
      }, 1500);
    };

    els.scrubber.addEventListener('change', commitScrub);
    els.scrubber.addEventListener('mouseup', commitScrub);
    els.scrubber.addEventListener('touchend', commitScrub);

    // Player Settings View toggle & close handlers
    function syncPlayerSettingsIndicators() {
      const vol = els.nativeAudio ? els.nativeAudio.volume : 1.0;
      const spd = state.playbackSpeed || 1.0;
      if (els.playerSettingsSpeedVal) {
        els.playerSettingsSpeedVal.textContent = Number.isInteger(spd) ? `${spd.toFixed(1)}x` : `${spd}x`;
      }
      if (els.playerSettingsVolVal) {
        els.playerSettingsVolVal.textContent = vol === 0 ? 'Muted' : `${Math.round(vol * 100)}%`;
      }
      if (els.btnPlayerSettings) {
        els.btnPlayerSettings.classList.toggle('has-custom', spd !== 1.0 || vol === 0);
      }
    }

    if (els.btnPlayerSettings && els.playerSettingsView) {
      els.btnPlayerSettings.addEventListener('click', () => {
        if (isPlayerSettingsOpen()) {
          closePlayerSettings();
        } else {
          openPlayerSettings();
        }
      });
    }

    if (els.btnClosePlayerSettings) {
      els.btnClosePlayerSettings.addEventListener('click', () => {
        closePlayerSettings();
      });
    }

    if (els.playerSettingsView) {
      els.playerSettingsView.addEventListener('click', (e) => {
        if (e.target === els.playerSettingsView) {
          closePlayerSettings();
        }
      });
    }

    // Speed selector
    els.speedBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        audio.playbackRate = speed;
        state.playbackSpeed = speed;
        els.speedBtns.forEach(b => b.classList.toggle('active', b === btn));
        syncPlayerSettingsIndicators();
      });
    });

    // Volume handling
    function updateVolumeIcon(vol) {
      if (els.volIcon) {
        let iconName = 'volume_up';
        if (vol === 0) {
          iconName = 'volume_off';
          if (els.volToggleBtn) els.volToggleBtn.title = 'Unmute audio';
        } else if (vol < 0.5) {
          iconName = 'volume_down';
          if (els.volToggleBtn) els.volToggleBtn.title = 'Mute audio';
        } else {
          if (els.volToggleBtn) els.volToggleBtn.title = 'Mute audio';
        }
        const iconSpan = els.volIcon.querySelector('.material-symbols-outlined');
        if (iconSpan) {
          iconSpan.textContent = iconName;
        } else {
          els.volIcon.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${iconName}</span>`;
        }
      }
      syncPlayerSettingsIndicators();
    }

    let lastVolume = 1.0;
    if (els.volToggleBtn) {
      els.volToggleBtn.addEventListener('click', () => {
        if (audio.volume > 0) {
          lastVolume = audio.volume;
          audio.volume = 0;
          if (els.volumeSlider) els.volumeSlider.value = 0;
        } else {
          audio.volume = lastVolume > 0 ? lastVolume : 1.0;
          if (els.volumeSlider) els.volumeSlider.value = audio.volume;
        }
        updateVolumeIcon(audio.volume);
      });
    }

    if (els.volumeSlider) {
      els.volumeSlider.addEventListener('input', () => {
        audio.volume = parseFloat(els.volumeSlider.value);
        updateVolumeIcon(audio.volume);
      });
    }

    syncPlayerSettingsIndicators();
  }

  function isPlayerSettingsOpen() {
    return Boolean(els.playerSettingsView && els.playerSettingsView.style.display !== 'none');
  }

  function openPlayerSettings() {
    if (!els.playerSettingsView) return;
    els.playerSettingsView.style.display = 'flex';
    if (els.btnPlayerSettings) {
      els.btnPlayerSettings.setAttribute('aria-expanded', 'true');
    }
    if (els.btnClosePlayerSettings) {
      els.btnClosePlayerSettings.focus();
    }
  }

  function closePlayerSettings() {
    if (!isPlayerSettingsOpen()) return false;
    const activeWasInside = document.activeElement && els.playerSettingsView.contains(document.activeElement);
    els.playerSettingsView.style.display = 'none';
    if (els.btnPlayerSettings) {
      els.btnPlayerSettings.setAttribute('aria-expanded', 'false');
      if (activeWasInside) {
        els.btnPlayerSettings.focus();
      }
    }
    return true;
  }

  function switchToCatalogEpisode(ep) {
    if (!ep) return;
    const epId = ep.id || ep.episode_id;
    playAudioSegment({
      episode_id: epId,
      media_url: ep.media_url,
      title: ep.title,
      teacher: ep.teacher || ep.primary_display,
      start_sec: 0,
    });
    if (epId && state.activeTab === 'transcript-view' && typeof DD.openTranscriptDrawer === 'function') {
      DD.openTranscriptDrawer(epId);
    }
  }

  function playPrevTrack() {
    if (!state.catalog || state.catalog.length === 0) return;
    const currentIdx = state.catalog.findIndex(ep => ep.media_url === state.currentMediaUrl);
    if (currentIdx > 0) {
      switchToCatalogEpisode(state.catalog[currentIdx - 1]);
    } else {
      if (window.WordSync) window.WordSync.prepareSeek(0);
      els.nativeAudio.currentTime = 0;
    }
  }

  function playNextTrack() {
    if (!state.catalog || state.catalog.length === 0) return;
    const currentIdx = state.catalog.findIndex(ep => ep.media_url === state.currentMediaUrl);
    if (currentIdx >= 0 && currentIdx < state.catalog.length - 1) {
      switchToCatalogEpisode(state.catalog[currentIdx + 1]);
    }
  }

  // 500ms lead time to first word for any/all seek reference points
  const SEEK_REF_LEAD_TIME_SEC = 0.50;

  function resolveEpisodeId(explicitId, mediaUrl) {
    if (explicitId) return explicitId;
    if (state.playingEpisode && state.playingEpisode.media_url === mediaUrl) {
      return state.playingEpisode.id || state.playingEpisode.episode_id;
    }
    if (state.currentEpisode && state.currentEpisode.media_url === mediaUrl) {
      return state.currentEpisode.id || state.currentEpisode.episode_id;
    }
    if (state.catalog && state.catalog.length > 0) {
      const found = state.catalog.find(e => e.media_url === mediaUrl);
      if (found) return found.id || found.episode_id;
    }
    if (mediaUrl) {
      const m = mediaUrl.match(/(pb\d+)/i);
      if (m) return m[1];
    }
    return null;
  }

  function unlockAudioGestureSync(audio) {
    if (state.audioGestureUnlocked || !audio) return;
    state.audioGestureUnlocked = true;
    if (!audio.src || audio.src === window.location.href || audio.src.endsWith('/')) {
      try {
        audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        const p = audio.play();
        if (p !== undefined) p.catch(() => {});
        audio.pause();
      } catch (_) {}
    }
  }

  function launchAudioStreamAndSeek({
    audio,
    streamUrl,
    mode,
    seekSeq,
    physSec,
    wordStartSec = null,
    shouldPlay = false,
    maxDurFallback = Infinity,
    onSettled = null,
  }) {
    if (!audio) return;
    if (shouldPlay) {
      state.audioGestureUnlocked = true;
    }
    if (window.WordSync) {
      window.WordSync.streamMode = mode;
    }
    const isDifferentSource = state.currentStreamUrl !== streamUrl;
    state.currentStreamUrl = streamUrl;

    if (state._pendingOnReadySeek) {
      audio.removeEventListener('loadedmetadata', state._pendingOnReadySeek);
      audio.removeEventListener('loadeddata', state._pendingOnReadySeek);
      audio.removeEventListener('canplay', state._pendingOnReadySeek);
      state._pendingOnReadySeek = null;
    }

    const isStillCurrent = () => (
      window.WordSync ? window.WordSync.isCurrentSeek(seekSeq) : seekSeq === state._audioSeekSeq
    );

    const doSeek = () => {
      if (!isStillCurrent()) return;
      try {
        if (window.WordSync) {
          window.WordSync._awaitingInitialSeek = false;
        }
        const curDur = Number.isFinite(audio.duration) ? audio.duration : maxDurFallback;
        const rawTarget = window.WordSync
          ? window.WordSync.prepareSeek(physSec, wordStartSec)
          : physSec;
        const clampedSeek = Math.max(0, Math.min(curDur, rawTarget));
        const didChangeTime = Math.abs((audio.currentTime || 0) - clampedSeek) > 0.002;
        audio.currentTime = clampedSeek;
        if (window.WordSync && !didChangeTime && !audio.seeking) {
          window.WordSync._pendingProgrammaticSeek = false;
          window.WordSync._syncPhase = (shouldPlay || !audio.paused) ? 'playing' : 'idle';
        }
        if (onSettled) onSettled(clampedSeek);
      } catch (err) {
        console.warn('Seek error:', err);
      }
    };

    const scheduleSeekOnReady = () => {
      if (audio.readyState >= 1) {
        doSeek();
        return;
      }
      if (window.WordSync) {
        window.WordSync._awaitingInitialSeek = true;
        if (physSec > 0) {
          window.WordSync._pendingProgrammaticSeek = true;
          window.WordSync._syncPhase = 'seeking';
        }
      }
      const onReady = () => {
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('loadeddata', onReady);
        audio.removeEventListener('canplay', onReady);
        if (state._pendingOnReadySeek === onReady) {
          state._pendingOnReadySeek = null;
        }
        doSeek();
      };
      state._pendingOnReadySeek = onReady;
      audio.addEventListener('loadedmetadata', onReady);
      audio.addEventListener('loadeddata', onReady);
      audio.addEventListener('canplay', onReady);
    };

    if (window.WordSync && physSec > 0) {
      window.WordSync._seekTargetWordTime = (typeof wordStartSec === 'number' && wordStartSec > 0) ? wordStartSec : null;
      window.WordSync._pendingProgrammaticSeek = true;
      window.WordSync._syncPhase = 'seeking';
      if (isDifferentSource || audio.readyState < 1) {
        window.WordSync._awaitingInitialSeek = true;
      }
    }

    if (isDifferentSource) {
      audio.src = streamUrl;
      audio.playbackRate = state.playbackSpeed;
      if (physSec > 0) {
        scheduleSeekOnReady();
      } else {
        if (window.WordSync) {
          window.WordSync._awaitingInitialSeek = false;
          window.WordSync._pendingProgrammaticSeek = false;
          window.WordSync.seekOffset = 0.0;
          window.WordSync._seekTargetWordTime = (typeof wordStartSec === 'number' && wordStartSec > 0) ? wordStartSec : null;
          window.WordSync._syncPhase = shouldPlay ? 'playing' : 'idle';
        }
        if (onSettled) onSettled(0);
      }
    } else {
      scheduleSeekOnReady();
    }

    if (shouldPlay) {
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          console.warn('Playback gesture error:', e);
        });
      }
    }
  }

  function seekAudioWithVbrCascade(opts) {
    const {
      audio,
      mediaUrl,
      seekSeq,
      physSec,
      wordStartSec = null,
      shouldPlay = false,
      maxDurFallback = Infinity,
      onSettled = null,
    } = opts;
    if (!audio) return;

    const isStillCurrent = () => (
      (window.WordSync ? window.WordSync.isCurrentSeek(seekSeq) : seekSeq === state._audioSeekSeq) &&
      state.currentMediaUrl === mediaUrl
    );

    const getActiveVbr = () => (
      window.WordSync && typeof window.WordSync.getPlayingVbrData === 'function'
        ? window.WordSync.getPlayingVbrData()
        : (window.WordSync && window.WordSync.vbrData)
    );

    const runPatchedOrCdn = () => {
      if (!isStillCurrent()) return;
      if (window.WordSync && getActiveVbr() && mediaUrl) {
        window.WordSync.resetMseSession();
        const readyBlobUrl = window.WordSync.getReadyPatchedBlobUrl(mediaUrl, physSec);
        if (readyBlobUrl) {
          launchAudioStreamAndSeek({ ...opts, streamUrl: readyBlobUrl, mode: 'patched_blob' });
          return;
        }
        if (physSec > 0) {
          window.WordSync._seekTargetWordTime = (typeof wordStartSec === 'number' && wordStartSec > 0) ? wordStartSec : null;
          window.WordSync._pendingProgrammaticSeek = true;
          window.WordSync._awaitingInitialSeek = true;
          window.WordSync._syncPhase = 'buffering';
        }
        if (shouldPlay) {
          unlockAudioGestureSync(audio);
        }
        window.WordSync.waitForPatchedBlobUrl(mediaUrl, physSec).then(blobUrl => {
          if (!isStillCurrent()) return;
          if (blobUrl) {
            launchAudioStreamAndSeek({ ...opts, streamUrl: blobUrl, mode: 'patched_blob' });
          } else {
            launchAudioStreamAndSeek({ ...opts, streamUrl: mediaUrl, mode: 'cdn' });
          }
        });
        return;
      }
      if (window.WordSync) {
        window.WordSync.resetMseSession();
      }
      launchAudioStreamAndSeek({ ...opts, streamUrl: mediaUrl, mode: 'cdn' });
    };

    // Tier 1: O(1) VBR1 frame-aligned HTTP Range + MediaSource seeking when supported (Chromium)
    if (
      window.WordSync &&
      getActiveVbr() &&
      mediaUrl &&
      window.WordSync.isMseVbrSupported() &&
      !window.WordSync._mseFailed[mediaUrl]
    ) {
      if (shouldPlay) {
        unlockAudioGestureSync(audio);
      }
      const msePromise = window.WordSync.mseSeekAndLoad(audio, mediaUrl, physSec, seekSeq, shouldPlay);
      if (window.WordSync._mse && window.WordSync._mse.objectUrl) {
        state.currentStreamUrl = window.WordSync._mse.objectUrl;
      }
      msePromise.then(res => {
        if (!isStillCurrent()) return;
        if (res && res.ok) {
          state.currentStreamUrl = audio.src;
          if (onSettled) onSettled(audio.currentTime);
          return;
        }
        if (res && res.aborted) return;
        runPatchedOrCdn();
      });
      return;
    }

    runPatchedOrCdn();
  }

  function playAudioSegment({ episode_id, media_url, title, teacher, start_sec, word_id = null, companion_idx = -1 }) {
    if (!media_url) {
      alert('Podbean CDN streaming URL is not available for this talk.');
      return;
    }

    const audio = els.nativeAudio;
    els.playerTitle.textContent = title || 'BSWA Dhamma Talk';
    const spkColor = getSpeakerColor('', teacher);
    els.playerSpeaker.innerHTML = `<span class="player-speaker-dot" style="background-color: ${spkColor}; box-shadow: 0 0 8px ${spkColor};"></span> ${escapeHtml(teacher || 'Monastic')}`;

    const epId = resolveEpisodeId(episode_id, media_url);
    state.currentMediaUrl = media_url;
    state.playingEpisode = {
      id: epId,
      media_url: media_url,
      title: title,
      teacher: teacher,
    };

    // Apply exactly 500ms lead time to first word for any/all seek ref points (clamped to 0)
    const rawTarget = typeof start_sec === 'number' ? start_sec : parseFloat(start_sec || 0);
    const targetTime = Math.max(0, rawTarget > 0 ? (rawTarget - SEEK_REF_LEAD_TIME_SEC) : 0);

    let clickedWordEl = null;
    let resolvedWordIdx = -1;
    let resolvedCompanionIdx = typeof companion_idx === 'number' ? companion_idx : -1;
    const viewingThisEp = Boolean(state.currentEpisode && state.currentEpisode.id === epId);

    if (word_id && viewingThisEp) {
      const el = document.getElementById(word_id);
      if (el && el.classList.contains('transcript-word')) {
        clickedWordEl = el;
        if (el.id && el.id.startsWith('tw-')) {
          const parsedIdx = parseInt(el.id.slice(3), 10);
          if (!isNaN(parsedIdx)) resolvedWordIdx = parsedIdx;
        }
      }
      if (resolvedCompanionIdx < 0 && state.lexCompanion.allTerms && state.lexCompanion.allTerms.length > 0) {
        resolvedCompanionIdx = state.lexCompanion.allTerms.findIndex(t => t.wordId === word_id);
      }
    }
    if (
      resolvedWordIdx < 0 &&
      window.WordSync &&
      window.WordSync.wordsEpisodeId === epId &&
      window.WordSync.words &&
      window.WordSync.words.length > 0
    ) {
      resolvedWordIdx = window.WordSync.findWordIndex(rawTarget > 0 ? rawTarget + 0.01 : 0.01);
    }

    if (window.WordSync) {
      window.WordSync.playingEpisodeId = epId;
    }
    const playSeq = window.WordSync
      ? window.WordSync.beginSeek({
          wordIdx: resolvedWordIdx,
          wordEl: clickedWordEl,
          companionIdx: resolvedCompanionIdx,
          wordStartSec: rawTarget,
        })
      : ++state._audioSeekSeq;
    state._audioSeekSeq = playSeq;

    if (els.btnPlayerTranscript) {
      els.btnPlayerTranscript.style.display = 'inline-flex';
    }
    if (els.timeCurrent && viewingThisEp && targetTime > 0) {
      els.timeCurrent.textContent = formatSeconds(targetTime);
    }
    updateHeaderPlayButton();
    BookmarkStore.syncUiButtons();

    function startWithLoadedProfile() {
      const stillCurrent = window.WordSync
        ? window.WordSync.isCurrentSeek(playSeq)
        : playSeq === state._audioSeekSeq;
      if (!stillCurrent || state.currentMediaUrl !== media_url) return;

      if (
        window.WordSync &&
        window.WordSync.words &&
        window.WordSync.words.length > 0 &&
        (!epId || window.WordSync.wordsEpisodeId === epId) &&
        window.WordSync._lockedWordIdx < 0
      ) {
        const lockIdx = window.WordSync.findWordIndex(rawTarget > 0 ? rawTarget + 0.01 : 0.01);
        window.WordSync._lockedWordIdx = lockIdx;
        if (
          lockIdx >= 0 &&
          (typeof window.WordSync.isPlayingCurrentTranscript !== 'function' ||
            window.WordSync.isPlayingCurrentTranscript())
        ) {
          const w = window.WordSync.words[lockIdx];
          const el = w ? document.getElementById(w.domId || w.id) : null;
          if (el) {
            window.WordSync.setActiveWordElement(el, lockIdx);
          }
        }
      }

      seekAudioWithVbrCascade({
        audio,
        mediaUrl: media_url,
        seekSeq: playSeq,
        physSec: targetTime,
        wordStartSec: rawTarget,
        shouldPlay: true,
        onSettled: (settledStreamTime) => {
          if (
            window.WordSync &&
            !audio.seeking &&
            state.activeTab === 'transcript-view' &&
            state.currentEpisode &&
            state.currentEpisode.id === epId
          ) {
            window.WordSync.update(settledStreamTime);
            updateActiveCompanionTerm(window.WordSync.getPhysicalTime(settledStreamTime));
          }
        },
      });
    }

    // If WordSync has not loaded this episode's VBR profile yet (e.g. playing from Search tab
    // or clicking a turn button while the words shard is still loading), await the sidecar first.
    const needsWordsLoad = Boolean(
      window.WordSync &&
        epId &&
        (typeof window.WordSync.isEpisodeWordsLoaded === 'function'
          ? !window.WordSync.isEpisodeWordsLoaded(epId)
          : window.WordSync.currentEpisodeId !== epId ||
            window.WordSync.wordsEpisodeId !== epId ||
            !window.WordSync.words ||
            window.WordSync.words.length === 0)
    );
    if (needsWordsLoad) {
      unlockAudioGestureSync(audio);
      window.WordSync.ensureEpisodeLoaded(epId)
        .then(() => {
          startWithLoadedProfile();
        })
        .catch(() => {
          startWithLoadedProfile();
        });
    } else {
      if (
        window.WordSync &&
        epId &&
        window.WordSync.wordsEpisodeId !== epId &&
        window.WordSync.vbrCache &&
        window.WordSync.vbrCache[epId]
      ) {
        window.WordSync.ensureEpisodeLoaded(epId);
      }
      startWithLoadedProfile();
    }
  }

  async function togglePlayPause() {
    const audio = els.nativeAudio;

    // If no audio track is active yet, auto-play first available talk
    if (!audio.src || audio.src === window.location.href || audio.src.endsWith('/')) {
      const epToPlay = state.playingEpisode || state.currentEpisode;
      if (epToPlay && epToPlay.media_url) {
        playAudioSegment({
          episode_id: epToPlay.id || epToPlay.episode_id,
          media_url: epToPlay.media_url,
          title: epToPlay.title,
          teacher: epToPlay.primary_display || epToPlay.teacher,
          start_sec: 0,
        });
        return;
      }

      if (state.catalog && state.catalog.length > 0 && state.catalog[0].media_url) {
        const firstEp = state.catalog[0];
        playAudioSegment({
          episode_id: firstEp.id || firstEp.episode_id,
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
            episode_id: ep.id || ep.episode_id,
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

  Object.assign(DD, {
    setupAudioEngine,
    isPlayerSettingsOpen,
    openPlayerSettings,
    closePlayerSettings,
    playPrevTrack,
    playNextTrack,
    SEEK_REF_LEAD_TIME_SEC,
    resolveEpisodeId,
    unlockAudioGestureSync,
    launchAudioStreamAndSeek,
    seekAudioWithVbrCascade,
    playAudioSegment,
    togglePlayPause,
  });
})();
