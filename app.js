/**
 * MUSE — Web DAW
 * app.js — Audio Engine + UI Logic
 *
 * Features:
 *  - Import MP3 / WAV via file picker or drag-and-drop
 *  - Waveform rendering (Web Audio API + Canvas)
 *  - Play / Pause / Stop / Prev / Next
 *  - Seek bar (click + drag)
 *  - Volume control
 *  - Loop toggle
 *  - Real-time frequency visualizer
 *  - File info panel (name, size, duration, sample rate)
 */

'use strict';

/* ══════════════════════════════════════
   STATE
══════════════════════════════════════ */
const state = {
  tracks: [],          // { id, name, ext, size, file, buffer, url, duration }
  currentIndex: -1,
  isPlaying: false,
  isLooping: false,
  volume: 0.8,
  playbackRate: 1.0,
  bpm: 120,
  seekPosition: 0,     // 0..1
  isSyncLimitActive: true, // Enabled by default
  crossfadeDuration: 4, // seconds of crossfade between tracks
};

/* ══════════════════════════════════════
   AUDIO CONTEXT
══════════════════════════════════════ */
let audioCtx        = null;
let sourceNode      = null;   // AudioBufferSourceNode (current)
let gainNode        = null;   // main gain for current track
let xfadeGainNode   = null;   // gain for outgoing crossfade track
let xfadeSourceNode = null;   // source for outgoing crossfade track
let analyserNode    = null;
let startTime       = 0;      // audioCtx.currentTime when playback started
let startOffset     = 0;      // offset in seconds where we started
let bpmTransitionId = null;   // interval ID for BPM interpolation

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
    gainNode     = audioCtx.createGain();
    xfadeGainNode = audioCtx.createGain();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    gainNode.connect(analyserNode);
    xfadeGainNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);
    gainNode.gain.value = state.volume;
    xfadeGainNode.gain.value = 0;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

/* ══════════════════════════════════════
   DOM REFS
══════════════════════════════════════ */
const $ = id => document.getElementById(id);

const ui = {
  fileInput:       $('file-input'),
  dropZone:        $('drop-zone'),
  trackList:       $('track-list'),

  waveformIdle:    $('waveform-idle'),
  waveformCanvas:  $('waveform-canvas'),
  waveformProgress: $('waveform-progress'),
  waveformOverlapA:$('waveform-overlap-a'),
  waveformCursor:  $('waveform-cursor'),

  // Deck B (incoming)
  deckA:           $('deck-a'),
  deckB:           $('deck-b'),
  deckAName:       $('deck-a-name'),
  deckBName:       $('deck-b-name'),
  waveformCanvasB:  $('waveform-canvas-b'),
  waveformProgressB: $('waveform-progress-b'),
  waveformOverlapB:$('waveform-overlap-b'),
  waveformCursorB:  $('waveform-cursor-b'),
  wtimeStart:      $('wtime-start'),
  wtimeEnd:        $('wtime-end'),

  btnPlay:         $('btn-play'),
  btnStop:         $('btn-stop'),
  btnPrev:         $('btn-prev'),
  btnNext:         $('btn-next'),
  btnLoop:         $('btn-loop'),

  bpmInput:        $('bpm-input'),
  bpmSlider:       $('bpm-slider'),
  bpmMinus:        $('bpm-minus'),
  bpmPlus:         $('bpm-plus'),
  bpmOriginal:     $('bpm-original'),
  syncLimit:       $('sync-limit'),
  speedSlider:     $('speed-slider'),
  speedValue:      $('speed-value'),

  iconPlay:        document.querySelector('.icon-play'),
  iconPause:       document.querySelector('.icon-pause'),

  nowPlayingName:  $('now-playing-name'),
  nowPlayingDetail: $('now-playing-detail'),
  timeDisplay:     $('time-display'),

  seekContainer:   $('seek-bar-container'),
  seekFill:        $('seek-bar-fill'),
  seekThumb:       $('seek-bar-thumb'),

  volumeSlider:    $('volume-slider'),

  xfadeSlider:     $('xfade-slider'),
  xfadeValue:      $('xfade-value'),

  syncBpmA:        $('sync-bpm-a'),
  syncBpmB:        $('sync-bpm-b'),
  syncArrow:       $('sync-arrow'),
  syncStatus:      $('sync-status-label'),
  syncProgress:    $('sync-progress'),

  infoCard:        $('info-card'),
  freqCanvas:      $('freq-canvas'),
  kickLightA:      $('kick-light-a'),
  kickLightB:      $('kick-light-b'),

  statusMsg:       $('status-msg'),
};

/* ══════════════════════════════════════
   UTILS
══════════════════════════════════════ */
function formatTime(sec) {
  if (!isFinite(sec) || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function setStatus(msg) {
  ui.statusMsg.textContent = msg;
}

function uniqueId() {
  return Math.random().toString(36).slice(2, 9);
}

/* ══════════════════════════════════════
   BPM DETECTION — Spectral Flux + Autocorrelation
   Multi-band energy analysis for accurate
   tempo estimation. Returns { bpm, offset }.
══════════════════════════════════════ */
function detectBPM(audioBuffer) {
  return new Promise(async (resolve) => {
    try {
      const sampleRate = audioBuffer.sampleRate;
      
      // ── Isolate Kicks using OfflineAudioContext (LowPass Filter) ──
      // We process the first 45 seconds for an accurate average
      const durationToProcess = Math.min(audioBuffer.duration, 45);
      const offlineCtx = new OfflineAudioContext(1, sampleRate * durationToProcess, sampleRate);
      
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      
      const filter = offlineCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 150; // Focus strictly on bass/kick
      filter.Q.value = 1.0;
      
      source.connect(filter);
      filter.connect(offlineCtx.destination);
      source.start(0);
      
      const renderedBuffer = await offlineCtx.startRendering();
      const lowData = renderedBuffer.getChannelData(0);

      // ── Step 1 : Downsample to ~11025 Hz for speed ──
      const factor = Math.max(1, Math.floor(sampleRate / 11025));
      const ds = [];
      for (let i = 0; i < lowData.length; i += factor) {
        ds.push(lowData[i]);
      }
      const dsRate = sampleRate / factor;

      // ── Step 2 : Compute energy in short frames ──
      const frameSize = Math.floor(dsRate * 0.02); // 20ms frames
      const hopSize   = Math.floor(frameSize / 2);  // 10ms hop
      const numFrames = Math.floor((ds.length - frameSize) / hopSize);
      const energies  = new Float32Array(numFrames);

      for (let f = 0; f < numFrames; f++) {
        const start = f * hopSize;
        let sum = 0;
        for (let i = 0; i < frameSize; i++) {
          const v = ds[start + i] || 0;
          sum += v * v;
        }
        energies[f] = sum;
      }

      // ── Step 3 : Spectral flux (half-wave rectified diff) ──
      const flux = new Float32Array(numFrames);
      for (let f = 1; f < numFrames; f++) {
        const diff = energies[f] - energies[f - 1];
        flux[f] = diff > 0 ? diff : 0; 
      }

      // Normalize flux
      let maxFlux = 0;
      for (let f = 0; f < flux.length; f++) {
        if (flux[f] > maxFlux) maxFlux = flux[f];
      }
      if (maxFlux > 0) {
        for (let f = 0; f < flux.length; f++) flux[f] /= maxFlux;
      }

      // ── Step 4 : Autocorrelation ──
      const minBPM = 60, maxBPM = 200;
      const framesPerSec = dsRate / hopSize;
      const minLag = Math.floor(framesPerSec * 60 / maxBPM);
      const maxLag = Math.floor(framesPerSec * 60 / minBPM);
      const acLen  = Math.min(flux.length, maxLag + 1);

      let bestLag = minLag;
      let bestCorr = -Infinity;

      for (let lag = minLag; lag <= Math.min(maxLag, acLen - 1); lag++) {
        let corr = 0;
        for (let i = 0; i < flux.length - lag; i++) {
          corr += flux[i] * flux[i + lag];
        }
        corr /= (flux.length - lag) || 1;

        // Weight toward common tempos (bias toward 100-160 BPM range)
        const bpmAtLag = (framesPerSec * 60) / lag;
        const centerBPM = 128;
        const weight = 1.0 - 0.3 * Math.abs(bpmAtLag - centerBPM) / 80;
        corr *= Math.max(weight, 0.5);

        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }

      let bpm = Math.round((framesPerSec * 60) / bestLag);

      // ── Step 5 : Octave correction ──
      const halfLag = bestLag * 2;
      const doubleLag = Math.floor(bestLag / 2);

      if (halfLag < acLen) {
        let halfCorr = 0;
        for (let i = 0; i < flux.length - halfLag; i++) {
          halfCorr += flux[i] * flux[i + halfLag];
        }
        halfCorr /= (flux.length - halfLag) || 1;
        if (halfCorr > bestCorr * 0.85 && bpm > 160) {
          bpm = Math.round(bpm / 2);
          bestCorr = halfCorr;
        }
      }
      if (doubleLag >= minLag) {
        let dblCorr = 0;
        for (let i = 0; i < flux.length - doubleLag; i++) {
          dblCorr += flux[i] * flux[i + doubleLag];
        }
        dblCorr /= (flux.length - doubleLag) || 1;
        if (dblCorr > bestCorr * 0.85 && bpm < 80) {
          bpm = Math.round(bpm * 2);
        }
      }

      // ── Step 6 : Find first beat offset ──
      // Now that the flux contains exclusively low frequencies (kicks),
      // finding the maximum phase alignment is extremely accurate.
      const periodFrames = Math.round((framesPerSec * 60) / bpm);
      let bestPhase = 0;
      let bestPhaseScore = -Infinity;

      for (let phase = 0; phase < periodFrames && phase < flux.length; phase++) {
        let score = 0;
        for (let k = phase; k < flux.length; k += periodFrames) {
          // Emphasize strong kicks
          score += Math.pow(flux[k], 2);
        }
        if (score > bestPhaseScore) {
          bestPhaseScore = score;
          bestPhase = phase;
        }
      }

      const approximateOffset = (bestPhase * hopSize * factor) / sampleRate;

      // Refine offset to the exact sample maximum in the low-passed data!
      const windowSamples = Math.floor(sampleRate * 0.02); 
      const startSample = Math.max(0, Math.floor(approximateOffset * sampleRate) - windowSamples);
      const endSample = Math.min(lowData.length, Math.floor(approximateOffset * sampleRate) + windowSamples);
      
      let maxEnergy = 0;
      let exactPeakSample = Math.floor(approximateOffset * sampleRate);
      for (let i = startSample; i < endSample; i++) {
        const energy = Math.abs(lowData[i]);
        if (energy > maxEnergy) {
          maxEnergy = energy;
          exactPeakSample = i;
        }
      }
      
      const offset = exactPeakSample / sampleRate;

      bpm = Math.max(20, Math.min(300, bpm));

      resolve({ bpm, offset });
    } catch (e) {
      console.warn('BPM detection failed:', e);
      resolve(null);
    }
  });
}

/* ══════════════════════════════════════
   FILE IMPORT
══════════════════════════════════════ */
async function importFiles(files) {
  ensureAudioContext();
  const validTypes = ['audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav'];
  const validExts  = ['mp3', 'wav'];

  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    const mime = file.type.toLowerCase();
    if (!validExts.includes(ext) && !validTypes.some(t => mime.includes(t.split('/')[1]))) {
      setStatus(`⚠ Fichier ignoré : ${file.name} (format non supporté)`);
      continue;
    }

    setStatus(`⏳ Décodage : ${file.name}…`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));

      const track = {
        id:       uniqueId(),
        name:     file.name.replace(/\.[^.]+$/, ''),
        ext:      ext.toUpperCase(),
        size:     file.size,
        file,
        buffer:   audioBuffer,
        duration: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate,
        channels:   audioBuffer.numberOfChannels,
        detectedBPM: null,
        beatOffset: 0,       // offset to the first beat in seconds
      };

      state.tracks.push(track);
      renderTrackItem(track);
      setStatus(`✔ ${track.name} chargé — Analyse du tempo…`);

      // BPM detection (async, non-blocking)
      detectBPM(audioBuffer).then(result => {
        if (result) {
          track.detectedBPM = result.bpm;
          track.beatOffset  = result.offset;
          setStatus(`✔ ${track.name} — ${result.bpm} BPM (offset: ${result.offset.toFixed(2)}s)`);
          // Auto-apply if this is the active track
          if (state.tracks[state.currentIndex]?.id === track.id) {
            updateBPM(result.bpm);
            updateInfoPanel(track);
          }
          // Re-render to show BPM in queue
          ui.trackList.innerHTML = '';
          state.tracks.forEach(t => renderTrackItem(t));
          updateActiveTrackUI();
        } else {
          setStatus(`✔ ${track.name} chargé (tempo non détecté)`);
        }
      });

      // Auto-load first track
      if (state.tracks.length === 1) {
        loadTrack(0);
      }
    } catch (err) {
      console.error(err);
      setStatus(`❌ Erreur de décodage : ${file.name}`);
    }
  }
}

/* ══════════════════════════════════════
   PLAYLIST RENDERING
══════════════════════════════════════ */
let draggedItemIndex = null;

function renderTrackItem(track) {
  const li = document.createElement('li');
  li.className = 'track-item';
  li.dataset.id = track.id;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');

  const idx = state.tracks.indexOf(track);
  const icon = track.ext === 'WAV' ? '🔊' : '🎵';
  const bpmTag = track.detectedBPM ? ` · ${track.detectedBPM}bpm` : '';

  li.innerHTML = `
    <div class="track-item__pos">${idx + 1}</div>
    <div class="track-item__icon">${icon}</div>
    <div class="track-item__info">
      <div class="track-item__name" title="${track.name}">${track.name}</div>
      <div class="track-item__meta">${track.ext} · ${formatTime(track.duration)}${bpmTag}</div>
    </div>
    <button class="track-item__remove" title="Retirer" data-remove="${track.id}" aria-label="Retirer ${track.name}">✕</button>
  `;

  li.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove]')) return;
    const idx = state.tracks.findIndex(t => t.id === track.id);
    if (idx !== -1) loadTrack(idx);
  });

  li.querySelector('[data-remove]').addEventListener('click', (e) => {
    e.stopPropagation();
    removeTrack(track.id);
  });

  // ── DRAG & DROP REORDERING ──
  li.draggable = true;
  
  li.addEventListener('dragstart', (e) => {
    draggedItemIndex = Array.from(ui.trackList.children).indexOf(li);
    e.dataTransfer.effectAllowed = 'move';
    li.style.opacity = '0.4';
  });

  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    li.style.borderTop = '2px solid var(--accent-bright)';
  });

  li.addEventListener('dragleave', () => {
    li.style.borderTop = 'none';
  });

  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.style.borderTop = 'none';
    const targetIndex = Array.from(ui.trackList.children).indexOf(li);
    
    if (draggedItemIndex !== null && draggedItemIndex !== targetIndex) {
      const draggedTrack = state.tracks.splice(draggedItemIndex, 1)[0];
      state.tracks.splice(targetIndex, 0, draggedTrack);
      
      // Update currentIndex if affected
      if (state.currentIndex === draggedItemIndex) {
        state.currentIndex = targetIndex;
      } else if (state.currentIndex > draggedItemIndex && state.currentIndex <= targetIndex) {
        state.currentIndex--;
      } else if (state.currentIndex < draggedItemIndex && state.currentIndex >= targetIndex) {
        state.currentIndex++;
      }
      
      // Re-render
      ui.trackList.innerHTML = '';
      state.tracks.forEach(t => renderTrackItem(t));
      updateActiveTrackUI();
      
      // Deck B preview might change
      const nextIndex = state.currentIndex + 1;
      const nextTrack = state.tracks[nextIndex];
      if (nextTrack && !_crossfading) {
        drawWaveformB(nextTrack);
        ui.deckBName.textContent = nextTrack.name;
        ui.deckB.classList.add('deck--inactive');
        ui.deckB.classList.remove('deck--active');
      } else if (!nextTrack && !_crossfading) {
        hideDeckB();
      }
    }
  });

  li.addEventListener('dragend', () => {
    li.style.opacity = '1';
    draggedItemIndex = null;
  });

  ui.trackList.appendChild(li);
}

function updateActiveTrackUI() {
  document.querySelectorAll('.track-item').forEach((el, i) => {
    const isActive = i === state.currentIndex;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', isActive ? 'true' : 'false');

    // Swap icon for EQ indicator when playing
    const iconEl = el.querySelector('.track-item__icon');
    if (isActive && state.isPlaying) {
      iconEl.innerHTML = `<div class="eq-indicator"><span></span><span></span><span></span></div>`;
    } else {
      const t = state.tracks[i];
      if (t) iconEl.textContent = t.ext === 'WAV' ? '🔊' : '🎵';
    }
  });
}

function removeTrack(id) {
  const idx = state.tracks.findIndex(t => t.id === id);
  if (idx === -1) return;

  if (idx === state.currentIndex) {
    stopPlayback();
    state.currentIndex = -1;
    resetPlayer();
  } else if (idx < state.currentIndex) {
    state.currentIndex--;
  }

  state.tracks.splice(idx, 1);

  // Re-render list
  ui.trackList.innerHTML = '';
  state.tracks.forEach(t => renderTrackItem(t));
  updateActiveTrackUI();

  if (state.tracks.length === 0) {
    resetPlayer();
    showWaveformIdle();
  } else if (state.currentIndex === -1 && state.tracks.length > 0) {
    loadTrack(0);
  }

  setStatus(state.tracks.length === 0 ? 'Playlist vide' : `${state.tracks.length} piste(s)`);
}

/* ══════════════════════════════════════
   TRACK LOADING
══════════════════════════════════════ */
function loadTrack(index, { crossfade = false } = {}) {
  if (index < 0 || index >= state.tracks.length) return;

  if (!crossfade) stopPlayback();
  state.currentIndex = index;
  if (!crossfade) startOffset = 0;

  const track = state.tracks[index];

  // Update transport info
  ui.nowPlayingName.textContent    = track.name;
  ui.nowPlayingDetail.textContent  = `${track.ext} · ${formatTime(track.duration)} · ${(track.sampleRate / 1000).toFixed(1)} kHz · ${track.channels}ch`;
  ui.wtimeEnd.textContent          = formatTime(track.duration);
  ui.wtimeStart.textContent        = '0:00';

  // Seek / progress reset
  if (!crossfade) updateSeek(0);

  // Waveform on Deck A
  if (!crossfade) {
    drawWaveform(track);
    ui.deckAName.textContent = track.name;
    hideDeckB();
    // Preview next track on Deck B
    const nextTrack = state.tracks[index + 1];
    if (nextTrack) {
      drawWaveformB(nextTrack);
      ui.deckBName.textContent = nextTrack.name;
      ui.deckB.classList.add('deck--inactive');
      ui.deckB.classList.remove('deck--active');
    }
  }

  // Info panel
  updateInfoPanel(track);

  // Auto-apply detected BPM if available (instant if no crossfade)
  if (track.detectedBPM && !crossfade) {
    updateBPM(track.detectedBPM);
  }

  // UI active state
  updateActiveTrackUI();

  setStatus(track.detectedBPM
    ? `Piste chargée : ${track.name} — ${track.detectedBPM} BPM`
    : `Piste chargée : ${track.name}`);
}

/* ══════════════════════════════════════
   PLAYBACK ENGINE
══════════════════════════════════════ */
function startPlayback(offset = 0) {
  ensureAudioContext();
  _crossfading = false;

  if (state.currentIndex === -1) return;
  const track = state.tracks[state.currentIndex];
  if (!track) return;

  // Destroy previous source
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch(_) {}
    sourceNode.disconnect();
  }

  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = track.buffer;
  sourceNode.loop   = state.isLooping;
  sourceNode.playbackRate.value = state.playbackRate;
  sourceNode.connect(gainNode);

  // Ensure main gain is at full volume
  gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  gainNode.gain.setValueAtTime(state.volume, audioCtx.currentTime);

  startOffset = Math.min(offset, track.duration);
  startTime   = audioCtx.currentTime;

  sourceNode.start(0, startOffset);

  state.isPlaying = true;
  setPlayPauseIcon(true);
  updateActiveTrackUI();

  sourceNode.onended = () => {
    if (state.isPlaying && !state.isLooping) {
      handleTrackEnded();
    }
  };

  startRenderLoop();
}

function pausePlayback() {
  if (!state.isPlaying) return;
  startOffset = getCurrentTime();
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch(_) {}
  }
  // Also stop any crossfade source
  cleanupCrossfade();
  state.isPlaying = false;
  setPlayPauseIcon(false);
  updateActiveTrackUI();
}

function stopPlayback() {
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch(_) {}
    sourceNode.disconnect();
    sourceNode = null;
  }
  cleanupCrossfade();
  _crossfading = false;
  state.isPlaying = false;
  startOffset = 0;
  setPlayPauseIcon(false);
  updateActiveTrackUI();
}

function cleanupCrossfade() {
  if (xfadeSourceNode) {
    try { xfadeSourceNode.stop(); } catch(_) {}
    xfadeSourceNode.disconnect();
    xfadeSourceNode = null;
  }
  if (xfadeGainNode) {
    xfadeGainNode.gain.cancelScheduledValues(audioCtx?.currentTime || 0);
    xfadeGainNode.gain.value = 0;
  }
  if (bpmTransitionId) {
    clearInterval(bpmTransitionId);
    bpmTransitionId = null;
  }
}

/**
 * DJ-style crossfade transition to next track:
 * Track 1 fades out but keeps its original tempo.
 * Track 2 fades in and ramps its tempo from Track 1's BPM to its own natural BPM during the crossfade.
 */
function crossfadeToNext() {
  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.tracks.length) {
    handleTrackEnded();
    return;
  }

  ensureAudioContext();
  const dur = Math.max(state.crossfadeDuration, 0.5); // minimum 0.5s
  const now = audioCtx.currentTime;
  const prevTrack = state.tracks[state.currentIndex];
  const nextTrack = state.tracks[nextIndex];
  const prevBPM = prevTrack?.detectedBPM || state.bpm;
  const nextBPM = nextTrack?.detectedBPM || prevBPM;

  const currentRate = state.playbackRate; 

  // Track 2 matches Track 1's tempo for the entire crossfade duration
  const track1BPM = prevBPM * currentRate;
  let targetBPMForB = track1BPM;

  // Apply Sync Limit if active: 
  // If difference is > 10 BPM, we limit the adjustment so 10 BPM of difference remains.
  // User example: A=140, B=100 => B=130 (10 BPM remaining gap)
  if (state.isSyncLimitActive) {
    const diff = track1BPM - nextTrack.detectedBPM;
    if (Math.abs(diff) > 10) {
      targetBPMForB = track1BPM - (Math.sign(diff) * 10);
    }
  }

  // Calculate the final target BPM for Track B (it must not exceed +/- 10 BPM of Track A)
  // Even after the ramp, B stays within 10 BPM of A's tempo.
  let finalBPMForB = nextBPM;
  if (state.isSyncLimitActive) {
    finalBPMForB = Math.max(track1BPM - 10, Math.min(track1BPM + 10, nextBPM));
  }
  const finalRateForB = finalBPMForB / nextBPM;

  const incomingSyncRate = targetBPMForB / nextBPM;
  const clampedIncomingRate = Math.max(0.1, Math.min(10.0, incomingSyncRate));
  
  _clampedIncomingRate = clampedIncomingRate;
  _finalRateForB = finalRateForB;

  // ── PHASE SYNC (Beatmatching) ──
  let syncDelay = 0;
  let startOffsetB = 0;

  if (prevTrack.detectedBPM && nextTrack.detectedBPM) {
    // Exact internal audio time of Track 1
    const elapsedRealTime = now - startTime;
    const internalTime1 = startOffset + elapsedRealTime * currentRate;
    
    const beatInterval1 = 60 / prevTrack.detectedBPM;
    
    // Find phase in audio time
    let currentPhase1 = (internalTime1 - prevTrack.beatOffset) % beatInterval1;
    if (currentPhase1 < 0) currentPhase1 += beatInterval1;
    
    // Real time until the next beat of Track 1
    syncDelay = (beatInterval1 - currentPhase1) / currentRate;
    
    // Cue Track 2 EXACTLY on its first beat
    startOffsetB = nextTrack.beatOffset; 
  }
  
  const startXfadeTime = now + syncDelay;

  _xfadeOutgoingTrack = prevTrack;
  _xfadeOutgoingStartOffset = getCurrentTime();
  _xfadeOutgoingStartTime = now;
  _xfadeOutgoingRate = currentRate;

  // ── 1. Move outgoing source to crossfade gain ──
  if (sourceNode) {
    sourceNode.onended = null;
    try { sourceNode.disconnect(); } catch(_) {}
    sourceNode.connect(xfadeGainNode);

    // Track 1 fades out over the full crossfade duration
    xfadeGainNode.gain.cancelScheduledValues(now);
    xfadeGainNode.gain.setValueAtTime(state.volume, now);
    xfadeGainNode.gain.setValueAtTime(state.volume, startXfadeTime);
    
    const fadeSteps = 20;
    for (let i = 1; i <= fadeSteps; i++) {
      const t = i / fadeSteps;
      const gain = state.volume * Math.pow(Math.cos(t * Math.PI * 0.5), 1.5);
      xfadeGainNode.gain.linearRampToValueAtTime(
        Math.max(gain, 0.001), startXfadeTime + t * dur
      );
    }

    // Track 1 maintains its exact tempo
    sourceNode.playbackRate.cancelScheduledValues(now);
    sourceNode.playbackRate.setValueAtTime(currentRate, now);

    // Auto-cleanup outgoing source after crossfade
    const outgoing = sourceNode;
    const stopTime = startXfadeTime + dur;
    setTimeout(() => {
      try { outgoing.stop(); outgoing.disconnect(); } catch(_) {}
      if (xfadeSourceNode === outgoing) xfadeSourceNode = null;
    }, (stopTime - now) * 1000 + 100);
    xfadeSourceNode = sourceNode;
    sourceNode = null;
  }

  // ── 2. Start incoming track ──
  drawWaveformB(nextTrack);
  ui.deckBName.textContent = nextTrack.name;

  loadTrack(nextIndex, { crossfade: true });
  startOffset = startOffsetB;

  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = nextTrack.buffer;
  sourceNode.loop   = state.isLooping;

  sourceNode.playbackRate.setValueAtTime(clampedIncomingRate, now);
  // Track 2 stays locked to synced tempo for the first 50% of the transition
  const rampStartTime = startXfadeTime + dur * 0.5;
  const rampEndTime = startXfadeTime + dur * 1.5; 
  sourceNode.playbackRate.setValueAtTime(clampedIncomingRate, rampStartTime);
  // THEN it adjusts toward final target (natural or limited)
  sourceNode.playbackRate.linearRampToValueAtTime(finalRateForB, rampEndTime);

  sourceNode.connect(gainNode);

  // Fade-in: steeper curve
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(0.001, now);
  gainNode.gain.setValueAtTime(0.001, startXfadeTime);
  
  const fadeSteps = 20;
  for (let i = 1; i <= fadeSteps; i++) {
    const t = i / fadeSteps;
    const gain = state.volume * Math.pow(Math.sin(t * Math.PI * 0.5), 1.5);
    gainNode.gain.linearRampToValueAtTime(Math.max(gain, 0.001), startXfadeTime + t * dur);
  }

  startTime = startXfadeTime; 
  sourceNode.start(startXfadeTime, startOffsetB);

  state.isPlaying = true;
  setPlayPauseIcon(true);
  updateActiveTrackUI();

  sourceNode.onended = () => {
    if (state.isPlaying && !state.isLooping) {
      handleTrackEnded();
    }
  };

  startRenderLoop();

  // ── 3. Smooth BPM display interpolation ──
  if (bpmTransitionId) clearInterval(bpmTransitionId);
  const totalUIDur = dur * 1.5; 
  const steps = Math.floor(totalUIDur * 20); // 20fps
  
  const rampStartRealTime = startXfadeTime + dur * 0.5; 
  const rampEndRealTime = startXfadeTime + dur * 1.5;
  
  // HUD Initial state
  ui.syncBpmA.textContent = Math.round(track1BPM);
  ui.syncBpmB.textContent = Math.round(targetBPMForB);
  ui.syncStatus.textContent = 'PHASE 1: LOCK';
  ui.syncArrow.textContent = '↔';
  ui.syncArrow.className = 'sync-hud__arrow lock';
  
  bpmTransitionId = setInterval(() => {
    const currentNow = audioCtx.currentTime;
    
    // Calculate the BPM we are actually synced to (considering limit)
    const currentSyncedBPM = targetBPMForB; 

    if (currentNow < rampStartRealTime) {
      // Still in phase 1 (locked tempo)
      const displayBPM = Math.round(currentSyncedBPM);
      state.bpm = displayBPM;
      ui.bpmInput.value = displayBPM;
      ui.bpmSlider.value = displayBPM;
      ui.speedValue.textContent = `${clampedIncomingRate.toFixed(2)}x`;
      ui.speedSlider.value = clampedIncomingRate;
      
      const p = Math.max(0, (currentNow - startXfadeTime) / (dur * 1.5));
      ui.syncProgress.style.width = `${(p * 100).toFixed(1)}%`;
      return;
    }
    
    // Tempo transition phase (50% to 150% of crossfade)
    const rampDur = rampEndRealTime - rampStartRealTime;
    const t = Math.min(1.0, (currentNow - rampStartRealTime) / rampDur);
    
    _updatingTempo = true;

    const ease = t * t * (3 - 2 * t);
    const currentDisplayRate = clampedIncomingRate + (finalRateForB - clampedIncomingRate) * ease;
    const currentDisplayBPM = Math.round(currentSyncedBPM + (finalBPMForB - currentSyncedBPM) * ease);

    state.bpm = currentDisplayBPM;
    ui.bpmInput.value = currentDisplayBPM;
    ui.bpmSlider.value = currentDisplayBPM;

    ui.speedValue.textContent = `${currentDisplayRate.toFixed(2)}x`;
    ui.speedSlider.value = currentDisplayRate;
    
    // Update HUD during ramp
    ui.syncBpmB.textContent = currentDisplayBPM;
    ui.syncStatus.textContent = 'PHASE 2: RAMP';
    if (finalBPMForB > currentSyncedBPM) {
      ui.syncArrow.textContent = '▲';
      ui.syncArrow.className = 'sync-hud__arrow up';
    } else if (finalBPMForB < currentSyncedBPM) {
      ui.syncArrow.textContent = '▼';
      ui.syncArrow.className = 'sync-hud__arrow down';
    } else {
      ui.syncArrow.textContent = '↔';
      ui.syncArrow.className = 'sync-hud__arrow lock';
    }
    
    const pTotal = Math.min(1.0, (currentNow - startXfadeTime) / (dur * 1.5));
    ui.syncProgress.style.width = `${(pTotal * 100).toFixed(1)}%`;

    _updatingTempo = false;

    if (t >= 1.0) {
      clearInterval(bpmTransitionId);
      bpmTransitionId = null;
      state.playbackRate = finalRateForB;
      ui.speedSlider.value = finalRateForB;
      ui.speedValue.textContent = `${finalRateForB.toFixed(2)}x`;
      updateBPM(finalBPMForB);

      _crossfading = false;
      drawWaveform(nextTrack);
      ui.deckAName.textContent = nextTrack.name;
      hideDeckB();

      const futureTrack = state.tracks[nextIndex + 1];
      if (futureTrack) {
        drawWaveformB(futureTrack);
        ui.deckBName.textContent = futureTrack.name;
        ui.deckB.classList.add('deck--inactive');
        ui.deckB.classList.remove('deck--active');
      }
    }
  }, 50);

  setStatus(`🎧 Transition → ${nextTrack.name} (Sync: ${syncDelay.toFixed(2)}s)`);
}

function handleTrackEnded() {
  state.isPlaying = false;
  setPlayPauseIcon(false);
  updateActiveTrackUI();
  updateSeek(0);
  ui.wtimeStart.textContent = '0:00';

  // Auto-advance playlist
  if (state.currentIndex < state.tracks.length - 1) {
    loadTrack(state.currentIndex + 1);
    startPlayback(0);
  } else {
    startOffset = 0;
    setStatus(`Lecture terminée`);
  }
}

function getCurrentTime() {
  if (!audioCtx || !state.isPlaying) return startOffset;
  return startOffset + (audioCtx.currentTime - startTime);
}

function seekTo(ratio) {
  const track = state.tracks[state.currentIndex];
  if (!track) return;
  const offset = ratio * track.duration;
  startOffset = offset;
  if (state.isPlaying) {
    startPlayback(offset);
  } else {
    updateSeek(ratio);
    ui.wtimeStart.textContent = formatTime(offset);
  }
}

/* ══════════════════════════════════════
   UI HELPERS
══════════════════════════════════════ */
function setPlayPauseIcon(playing) {
  ui.iconPlay.style.display  = playing ? 'none' : 'block';
  ui.iconPause.style.display = playing ? 'block' : 'none';
  ui.btnPlay.classList.toggle('playing', playing);
}

function resetPlayer() {
  ui.nowPlayingName.textContent    = '—';
  ui.nowPlayingDetail.textContent  = 'Aucun fichier';
  ui.timeDisplay.textContent       = '0:00 / 0:00';
  updateSeek(0);
  setPlayPauseIcon(false);
  ui.infoCard.innerHTML = '<div class="info-idle"><span>Aucune piste chargée</span></div>';
}

function updateSeek(ratio) {
  const pct = `${ratio * 100}%`;
  ui.seekFill.style.width     = pct;
  ui.seekThumb.style.left     = pct;
  ui.waveformProgress.style.width  = pct;
  ui.waveformCursor.style.left     = pct;
  ui.seekContainer.setAttribute('aria-valuenow', Math.round(ratio * 100));
}

function showWaveformIdle() {
  ui.waveformIdle.classList.remove('hidden');
  ui.waveformCanvas.classList.remove('visible');
  ui.waveformCursor.classList.remove('visible');
}

function updateInfoPanel(track) {
  const bpmDisplay = track.detectedBPM
    ? `<span class="info-value info-value--accent">${track.detectedBPM} BPM</span>`
    : `<span class="info-value info-value--dim">Analyse…</span>`;

  ui.infoCard.innerHTML = `
    <div class="info-row"><span class="info-label">Fichier</span><span class="info-value">${track.name.slice(0, 18)}${track.name.length > 18 ? '…' : ''}</span></div>
    <div class="info-row"><span class="info-label">Format</span><span class="info-value">${track.ext}</span></div>
    <div class="info-row"><span class="info-label">Durée</span><span class="info-value">${formatTime(track.duration)}</span></div>
    <div class="info-row"><span class="info-label">Tempo</span>${bpmDisplay}</div>
    <div class="info-row"><span class="info-label">Taille</span><span class="info-value">${formatBytes(track.size)}</span></div>
    <div class="info-row"><span class="info-label">Sample rate</span><span class="info-value">${(track.sampleRate / 1000).toFixed(1)} kHz</span></div>
    <div class="info-row"><span class="info-label">Canaux</span><span class="info-value">${track.channels === 2 ? 'Stéréo' : 'Mono'}</span></div>
  `;
}

/* ══════════════════════════════════════
   WAVEFORM RENDERING
══════════════════════════════════════ */
function drawWaveformOnCanvas(track, canvas, colorScheme = 'purple') {
  const buffer = track.buffer;
  const dpr    = window.devicePixelRatio || 1;
  canvas.width  = canvas.offsetWidth  * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  const ctx   = canvas.getContext('2d');
  const W     = canvas.width;
  const H     = canvas.height;
  ctx.scale(dpr, dpr);
  const cW = canvas.offsetWidth;
  const cH = canvas.offsetHeight;

  const rawData   = buffer.getChannelData(0);
  const samples   = cW * 2;
  const blockSize = Math.floor(rawData.length / samples);

  const peaks = [];
  for (let i = 0; i < samples; i++) {
    const start = i * blockSize;
    let min = 0, max = 0;
    for (let j = 0; j < blockSize; j++) {
      const v = rawData[start + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push({ min, max });
  }

  ctx.clearRect(0, 0, cW, cH);



  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, cH / 2);
  ctx.lineTo(cW, cH / 2);
  ctx.stroke();

  const barW = cW / samples;
  const mid  = cH / 2;

  // Color palettes
  const colors = colorScheme === 'green' ? {
    high:    ['rgba(240,109,109,0.9)', 'rgba(240,109,109,0.5)'],
    mid:     ['rgba(62,207,142,0.85)', 'rgba(46,180,120,0.5)'],
    low:     ['rgba(62,207,142,0.7)',  'rgba(46,160,110,0.4)'],
  } : {
    high:    ['rgba(240,109,109,0.9)', 'rgba(240,109,109,0.5)'],
    mid:     ['rgba(157,145,255,0.85)', 'rgba(124,108,248,0.5)'],
    low:     ['rgba(124,108,248,0.7)',  'rgba(62,207,142,0.4)'],
  };

  for (let i = 0; i < samples; i++) {
    const x      = i * barW;
    const { min, max } = peaks[i];
    const yTop   = mid + min * mid * 0.92;
    const yBot   = mid + max * mid * 0.92;
    const height = Math.max(yBot - yTop, 1);

    const amp = Math.max(Math.abs(min), Math.abs(max));
    const g   = ctx.createLinearGradient(0, yTop, 0, yBot);
    const pal = amp > 0.8 ? colors.high : amp > 0.5 ? colors.mid : colors.low;
    g.addColorStop(0, pal[0]);
    g.addColorStop(1, pal[1]);

    ctx.fillStyle = g;
    ctx.fillRect(x, yTop, Math.max(barW - 0.5, 0.5), height);
  }

  // Draw beat grid (kicks) over the waveform
  if (track.detectedBPM && track.beatOffset !== undefined) {
    const beatInterval = 60 / track.detectedBPM;
    const offset = track.beatOffset;
    let beatCount = 0;
    
    for (let t = offset; t < buffer.duration; t += beatInterval) {
      const x = (t / buffer.duration) * cW;
      const isDownbeat = (beatCount % 4 === 0);
      
      // Full height subtle line
      ctx.beginPath();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isDownbeat 
        ? (colorScheme === 'green' ? 'rgba(62,207,142,0.15)' : 'rgba(157,145,255,0.15)')
        : 'rgba(255,255,255,0.03)';
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cH);
      ctx.stroke();

      // Clearer tick at the bottom (like a ruler)
      ctx.beginPath();
      ctx.lineWidth = isDownbeat ? 2 : 1;
      ctx.strokeStyle = isDownbeat 
        ? (colorScheme === 'green' ? 'rgba(62,207,142,0.8)' : 'rgba(157,145,255,0.8)')
        : 'rgba(255,255,255,0.4)';
      const tickHeight = isDownbeat ? 14 : 8;
      ctx.moveTo(x, cH - tickHeight);
      ctx.lineTo(x, cH);
      ctx.stroke();

      // Clearer tick at the top
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, tickHeight);
      ctx.stroke();
      
      beatCount++;
    }
  }
}

function updateOverlapUI() {
  const dur = state.crossfadeDuration;
  
  // Deck A (Outgoing) - Overlap is at the END of the track
  const trackA = state.tracks[state.currentIndex];
  if (trackA && ui.waveformCanvas.classList.contains('visible')) {
    const totalA = trackA.duration;
    const overlapPercentA = Math.min((dur / totalA) * 100, 100);
    ui.waveformOverlapA.style.width = `${overlapPercentA}%`;
    ui.waveformOverlapA.classList.add('visible');
  } else {
    ui.waveformOverlapA.classList.remove('visible');
  }

  // Deck B (Incoming) - Overlap is at the BEGINNING of the track
  const nextIndex = state.currentIndex + 1;
  const trackB = state.tracks[nextIndex];
  if (trackB && ui.deckB.classList.contains('deck--active')) {
    const totalB = trackB.duration;
    const overlapPercentB = Math.min((dur / totalB) * 100, 100);
    ui.waveformOverlapB.style.width = `${overlapPercentB}%`;
    ui.waveformOverlapB.classList.add('visible');
  } else {
    ui.waveformOverlapB.classList.remove('visible');
  }
}

function drawWaveform(track) {
  if (!track) return;
  ui.waveformIdle.classList.add('hidden');
  ui.waveformCanvas.classList.add('visible');
  ui.waveformCursor.classList.add('visible');
  drawWaveformOnCanvas(track, ui.waveformCanvas, 'purple');
  updateOverlapUI();
}

function drawWaveformB(track) {
  if (!track) return;
  ui.waveformCanvasB.classList.add('visible');
  ui.waveformCursorB.classList.add('visible');
  ui.deckB.classList.remove('deck--inactive');
  ui.deckB.classList.add('deck--active');
  drawWaveformOnCanvas(track, ui.waveformCanvasB, 'green');
  updateOverlapUI();
}

function hideDeckB() {
  ui.deckB.classList.add('deck--inactive');
  ui.deckB.classList.remove('deck--active');
  ui.waveformCanvasB.classList.remove('visible');
  ui.waveformCursorB.classList.remove('visible');
  ui.waveformProgressB.style.width = '0%';
  ui.waveformCursorB.style.left = '0%';
  ui.deckBName.textContent = '—';
  updateOverlapUI();
}

/* ══════════════════════════════════════
   FREQUENCY VISUALIZER
══════════════════════════════════════ */
let rafId = null;
let _crossfading = false;
let _tempoRamping = false;
let _xfadeOutgoingTrack = null;
let _xfadeOutgoingStartOffset = 0;
let _xfadeOutgoingStartTime = 0;
let _xfadeOutgoingRate = 1.0;

let _clampedIncomingRate = 1.0;
let _finalRateForB = 1.0;

let _lastBeatA = -1;
let _lastBeatB = -1;

function checkKicks() {
  if (!state.isPlaying) {
    _lastBeatA = -1;
    _lastBeatB = -1;
    return;
  }

  const now = audioCtx ? audioCtx.currentTime : 0;

  // Deck A 
  const trackA = _crossfading ? _xfadeOutgoingTrack : state.tracks[state.currentIndex];
  if (trackA && trackA.detectedBPM) {
    let ctA = 0;
    let rateA = 1.0;
    if (_crossfading) {
      ctA = now - _xfadeOutgoingStartTime;
      rateA = _xfadeOutgoingRate;
    } else {
      ctA = now - startTime;
      rateA = state.playbackRate;
    }
    
    const internalTimeA = (_crossfading ? _xfadeOutgoingStartOffset : startOffset) + ctA * rateA;
    const beatIntervalA = 60 / trackA.detectedBPM;
    const currentBeatA = Math.floor((internalTimeA - trackA.beatOffset) / beatIntervalA);
    
    if (currentBeatA > _lastBeatA) {
      _lastBeatA = currentBeatA;
      ui.kickLightA.classList.add('flash');
      setTimeout(() => ui.kickLightA.classList.remove('flash'), 80);
    }

    if (!_crossfading) {
      ui.syncBpmA.textContent = Math.round(trackA.detectedBPM * rateA);
      ui.syncBpmB.textContent = '--';
      ui.syncStatus.textContent = 'READY';
      ui.syncArrow.textContent = '●';
      ui.syncArrow.className = 'sync-hud__arrow';
      ui.syncProgress.style.width = '0%';
    }
  }

  // Deck B
  const trackB = _crossfading ? state.tracks[state.currentIndex] : null;
  if (trackB && trackB.detectedBPM && _crossfading && sourceNode) {
    const elapsedRealTime = now - startTime; 
    
    // Calculate precise internal time by integrating playbackRate
    // We know the ramp starts at startTime + dur * 0.5
    const dur = state.crossfadeDuration;
    const rampStart = dur * 0.5;
    const rampEnd = dur * 1.5;
    
    let internalTimeB = startOffset;
    const initialRate = _clampedIncomingRate; // Need to store this globally
    const finalRate = _finalRateForB; // Need to store this globally
    
    if (elapsedRealTime < rampStart) {
      // Phase 1: Constant synced rate
      internalTimeB += elapsedRealTime * initialRate;
    } else if (elapsedRealTime < rampEnd) {
      // Phase 2: Ramping
      const tRamp = elapsedRealTime - rampStart;
      const rampDur = rampEnd - rampStart;
      // Integral of linear ramp: r0*t + 0.5 * (r1-r0)/D * t^2
      internalTimeB += rampStart * initialRate;
      internalTimeB += initialRate * tRamp + 0.5 * (finalRate - initialRate) / rampDur * (tRamp * tRamp);
    } else {
      // Phase 3: Constant final rate
      const rampDur = rampEnd - rampStart;
      internalTimeB += rampStart * initialRate;
      internalTimeB += 0.5 * (initialRate + finalRate) * rampDur; // Total integral during ramp
      internalTimeB += (elapsedRealTime - rampEnd) * finalRate;
    }

    const beatIntervalB = 60 / trackB.detectedBPM;
    const currentBeatB = Math.floor((internalTimeB - trackB.beatOffset) / beatIntervalB);
    
    if (currentBeatB > _lastBeatB) {
      _lastBeatB = currentBeatB;
      ui.kickLightB.classList.add('flash');
      setTimeout(() => ui.kickLightB.classList.remove('flash'), 80);
    }
  } else {
    _lastBeatB = -1;
  }
}

function startRenderLoop() {
  if (rafId) cancelAnimationFrame(rafId);

  const canvas = ui.freqCanvas;
  const ctx    = canvas.getContext('2d');
  const bufLen = analyserNode ? analyserNode.frequencyBinCount : 64;
  const dataArr = new Uint8Array(bufLen);

  function render() {
    rafId = requestAnimationFrame(render);

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width  = W;
    canvas.height = H;

    // ── Time update ──
    if (state.isPlaying && state.currentIndex !== -1) {
      const track = state.tracks[state.currentIndex];
      if (track) {
        const ct    = getCurrentTime();
        const ratio = Math.min(ct / track.duration, 1);

        if (_crossfading && _xfadeOutgoingTrack) {
          // Deck A (Outgoing) continues from where it was
          // We roughly estimate outgoing time progress
          const outgoingElapsed = (audioCtx.currentTime - _xfadeOutgoingStartTime) * _xfadeOutgoingRate;
          const outgoingCt = _xfadeOutgoingStartOffset + outgoingElapsed;
          const outgoingRatio = Math.min(outgoingCt / _xfadeOutgoingTrack.duration, 1);
          
          ui.waveformProgress.style.width = `${outgoingRatio * 100}%`;
          ui.waveformCursor.style.left    = `${outgoingRatio * 100}%`;
          ui.seekFill.style.width         = `${outgoingRatio * 100}%`;
          ui.seekThumb.style.left         = `${outgoingRatio * 100}%`;
          
          // Deck B (Incoming) uses the new track's time
          ui.waveformProgressB.style.width = `${ratio * 100}%`;
          ui.waveformCursorB.style.left    = `${ratio * 100}%`;
        } else {
          updateSeek(ratio);
        }

        ui.wtimeStart.textContent = formatTime(ct);
        ui.timeDisplay.textContent = `${formatTime(ct)} / ${formatTime(track.duration)}`;

        // ── Crossfade trigger ──
        const timeLeft = track.duration - ct;
        const hasNext = state.currentIndex < state.tracks.length - 1;
        if (hasNext && !state.isLooping && !_crossfading && timeLeft > 0 && timeLeft <= state.crossfadeDuration) {
          _crossfading = true;
          crossfadeToNext();
        }

        if (ct >= track.duration && !state.isLooping) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }
    }

    checkKicks();

    // ── Frequency bars ──
    if (!analyserNode) return;
    analyserNode.getByteFrequencyData(dataArr);

    ctx.clearRect(0, 0, W, H);

    const bars = Math.min(bufLen, 48);
    const barW = W / bars - 1.5;

    for (let i = 0; i < bars; i++) {
      const val    = dataArr[i];
      const barH   = (val / 255) * H;
      const x      = i * (barW + 1.5);
      const y      = H - barH;
      const norm   = val / 255;

      const g = ctx.createLinearGradient(0, y, 0, H);
      if (norm > 0.75) {
        g.addColorStop(0, '#f06c6c');
        g.addColorStop(1, '#f0b954');
      } else if (norm > 0.4) {
        g.addColorStop(0, '#9d91ff');
        g.addColorStop(1, '#7c6cf8');
      } else {
        g.addColorStop(0, '#3ecf8e');
        g.addColorStop(1, '#7c6cf8');
      }

      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
      ctx.fill();
    }
  }
  render();
}

/* ══════════════════════════════════════
   EVENT HANDLERS — FILE IMPORT
══════════════════════════════════════ */
ui.fileInput.addEventListener('change', e => {
  importFiles(Array.from(e.target.files));
  e.target.value = '';
});

ui.dropZone.addEventListener('click', () => ui.fileInput.click());

ui.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  ui.dropZone.classList.add('drag-over');
});
ui.dropZone.addEventListener('dragleave', () => ui.dropZone.classList.remove('drag-over'));
ui.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  ui.dropZone.classList.remove('drag-over');
  importFiles(Array.from(e.dataTransfer.files));
});

// Allow drag-drop anywhere on the page
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files).filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ['mp3', 'wav'].includes(ext);
  });
  if (files.length) importFiles(files);
});

/* ══════════════════════════════════════
   EVENT HANDLERS — TRANSPORT
══════════════════════════════════════ */
ui.btnPlay.addEventListener('click', () => {
  if (state.currentIndex === -1 && state.tracks.length > 0) loadTrack(0);
  if (state.currentIndex === -1) return;

  if (state.isPlaying) {
    pausePlayback();
    setStatus('En pause');
  } else {
    startPlayback(startOffset);
    setStatus(`▶ Lecture : ${state.tracks[state.currentIndex]?.name}`);
  }
});

ui.btnStop.addEventListener('click', () => {
  stopPlayback();
  startOffset = 0;
  updateSeek(0);
  if (state.currentIndex !== -1) {
    ui.wtimeStart.textContent = '0:00';
    ui.timeDisplay.textContent = `0:00 / ${formatTime(state.tracks[state.currentIndex]?.duration)}`;
  }
  setStatus('Arrêté');
});

ui.btnPrev.addEventListener('click', () => {
  const ct = getCurrentTime();
  if (ct > 3) {
    // Restart current track if more than 3s in
    seekTo(0);
    if (state.isPlaying) startPlayback(0);
  } else if (state.currentIndex > 0) {
    loadTrack(state.currentIndex - 1);
    if (state.isPlaying) startPlayback(0);
  }
});

ui.btnNext.addEventListener('click', () => {
  if (state.currentIndex < state.tracks.length - 1) {
    if (state.isPlaying) {
      _crossfading = true;
      crossfadeToNext();
    } else {
      loadTrack(state.currentIndex + 1);
    }
  }
});

ui.btnLoop.addEventListener('click', () => {
  state.isLooping = !state.isLooping;
  ui.btnLoop.classList.toggle('active', state.isLooping);
  if (sourceNode) sourceNode.loop = state.isLooping;
  setStatus(state.isLooping ? '🔁 Boucle activée' : 'Boucle désactivée');
});

/* ══════════════════════════════════════
   SEEK BAR — MOUSE EVENTS
══════════════════════════════════════ */
let isSeeking = false;

function getSeekRatio(e) {
  const rect = ui.seekContainer.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

ui.seekContainer.addEventListener('mousedown', e => {
  isSeeking = true;
  const ratio = getSeekRatio(e);
  updateSeek(ratio);
});

document.addEventListener('mousemove', e => {
  if (!isSeeking) return;
  const ratio = getSeekRatio(e);
  updateSeek(ratio);
});

document.addEventListener('mouseup', e => {
  if (!isSeeking) return;
  isSeeking = false;
  const ratio = getSeekRatio(e);
  seekTo(ratio);
});

// Also support clicking on the waveform canvas to seek
ui.waveformCanvas.addEventListener('click', e => {
  const rect = ui.waveformCanvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  seekTo(ratio);
});

/* ══════════════════════════════════════
   TEMPO & SPEED — Linked together
   BPM change → adjusts playback speed
   Speed change → adjusts BPM display
══════════════════════════════════════ */
let _updatingTempo = false; // guard against circular updates

function getOriginalBPM() {
  if (state.currentIndex === -1) return state.bpm;
  const track = state.tracks[state.currentIndex];
  return track?.detectedBPM || state.bpm;
}

function applyPlaybackRate(rate) {
  state.playbackRate = rate;
  ui.speedSlider.value = rate;
  ui.speedValue.textContent = `${rate.toFixed(2)}x`;
  if (sourceNode) {
    sourceNode.playbackRate.setTargetAtTime(rate, audioCtx.currentTime, 0.05);
  }
}

function updateBPM(val) {
  if (_updatingTempo) return;
  _updatingTempo = true;

  state.bpm = Math.max(20, Math.min(300, Math.round(val)));
  ui.bpmInput.value = state.bpm;
  ui.bpmSlider.value = state.bpm;

  // Calculate and apply the corresponding playback speed
  const originalBPM = getOriginalBPM();
  const newRate = Math.max(0.5, Math.min(2.0, state.bpm / originalBPM));
  applyPlaybackRate(newRate);

  setStatus(`Tempo : ${state.bpm} BPM · Vitesse : ${newRate.toFixed(2)}x`);
  _updatingTempo = false;
}

function updateSpeedFromSlider(rate) {
  if (_updatingTempo) return;
  _updatingTempo = true;

  state.playbackRate = rate;
  ui.speedValue.textContent = `${rate.toFixed(2)}x`;
  if (sourceNode) {
    sourceNode.playbackRate.setTargetAtTime(rate, audioCtx.currentTime, 0.05);
  }

  // Calculate and apply the corresponding BPM
  const originalBPM = getOriginalBPM();
  const newBPM = Math.max(20, Math.min(300, Math.round(originalBPM * rate)));
  state.bpm = newBPM;
  ui.bpmInput.value = newBPM;
  ui.bpmSlider.value = newBPM;

  setStatus(`Tempo : ${newBPM} BPM · Vitesse : ${rate.toFixed(2)}x`);
  _updatingTempo = false;
}

// ── Speed slider ──
ui.speedSlider.addEventListener('input', () => {
  updateSpeedFromSlider(parseFloat(ui.speedSlider.value));
});

// ── BPM controls ──
ui.bpmInput.addEventListener('change', () => {
  updateBPM(parseInt(ui.bpmInput.value) || 120);
});

ui.bpmSlider.addEventListener('input', (e) => {
  if (_updatingTempo) return;
  const val = parseFloat(e.target.value);
  updateBPM(val);
});

ui.syncLimit.addEventListener('click', () => {
  state.isSyncLimitActive = !state.isSyncLimitActive;
  ui.syncLimit.classList.toggle('btn--active', state.isSyncLimitActive);
  setStatus(state.isSyncLimitActive ? "Limite Sync 10 BPM activée" : "Limite Sync désactivée");
});

ui.bpmMinus.addEventListener('click', () => {
  updateBPM(state.bpm - 1);
});

ui.bpmPlus.addEventListener('click', () => {
  updateBPM(state.bpm + 1);
});

// ── Original button ──
ui.bpmOriginal.addEventListener('click', () => {
  const originalBPM = getOriginalBPM();
  _updatingTempo = true;

  state.bpm = originalBPM;
  ui.bpmInput.value = originalBPM;
  ui.bpmSlider.value = originalBPM;

  applyPlaybackRate(1.0);

  _updatingTempo = false;
  setStatus(`Tempo original restauré : ${originalBPM} BPM · 1.00x`);
});

/* ══════════════════════════════════════
   VOLUME
══════════════════════════════════════ */
ui.volumeSlider.addEventListener('input', () => {
  state.volume = parseFloat(ui.volumeSlider.value);
  if (gainNode) gainNode.gain.value = state.volume;
});

/* ══════════════════════════════════════
   CROSSFADE DURATION
══════════════════════════════════════ */
ui.xfadeSlider.addEventListener('input', () => {
  state.crossfadeDuration = parseFloat(ui.xfadeSlider.value);
  ui.xfadeValue.textContent = `${state.crossfadeDuration.toFixed(1)}s`;
  updateOverlapUI();
});

/* ══════════════════════════════════════
   KEYBOARD SHORTCUTS
══════════════════════════════════════ */
document.addEventListener('keydown', e => {
  // Ignore when typing in inputs
  if (e.target.tagName === 'INPUT') return;

  switch(e.code) {
    case 'Space':
      e.preventDefault();
      ui.btnPlay.click();
      break;
    case 'ArrowLeft':
      if (state.currentIndex !== -1) {
        const track = state.tracks[state.currentIndex];
        const ct    = getCurrentTime();
        seekTo(Math.max(0, ct - 5) / track.duration);
        if (state.isPlaying) startPlayback(Math.max(0, ct - 5));
      }
      break;
    case 'ArrowRight':
      if (state.currentIndex !== -1) {
        const track = state.tracks[state.currentIndex];
        const ct    = getCurrentTime();
        seekTo(Math.min(track.duration, ct + 5) / track.duration);
        if (state.isPlaying) startPlayback(Math.min(track.duration, ct + 5));
      }
      break;
    case 'KeyL':
      ui.btnLoop.click();
      break;
  }
});

/* ══════════════════════════════════════
   WAVEFORM REDRAW ON RESIZE
══════════════════════════════════════ */
const resizeObserver = new ResizeObserver(() => {
  if (state.currentIndex !== -1) {
    const track = state.tracks[state.currentIndex];
    if (track) drawWaveform(track);
  }
});
resizeObserver.observe(ui.waveformCanvas.parentElement);

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
setStatus('Prêt — Importez un fichier MP3 ou WAV pour commencer');
