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
};

/* ══════════════════════════════════════
   AUDIO CONTEXT
══════════════════════════════════════ */
let audioCtx     = null;
let sourceNode   = null;   // AudioBufferSourceNode (current)
let gainNode     = null;
let analyserNode = null;
let startTime    = 0;      // audioCtx.currentTime when playback started
let startOffset  = 0;      // offset in seconds where we started

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
    gainNode     = audioCtx.createGain();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    gainNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);
    gainNode.gain.value = state.volume;
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
  waveformCursor:  $('waveform-cursor'),
  wtimeStart:      $('wtime-start'),
  wtimeEnd:        $('wtime-end'),

  btnPlay:         $('btn-play'),
  btnStop:         $('btn-stop'),
  btnPrev:         $('btn-prev'),
  btnNext:         $('btn-next'),
  btnLoop:         $('btn-loop'),

  bpmInput:        $('bpm-input'),
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

  infoCard:        $('info-card'),
  freqCanvas:      $('freq-canvas'),

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
      };

      state.tracks.push(track);
      renderTrackItem(track);
      setStatus(`✔ ${track.name} chargé (${formatTime(track.duration)})`);

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
function renderTrackItem(track) {
  const li = document.createElement('li');
  li.className = 'track-item';
  li.dataset.id = track.id;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');

  const icon = track.ext === 'WAV' ? '🔊' : '🎵';

  li.innerHTML = `
    <div class="track-item__icon">${icon}</div>
    <div class="track-item__info">
      <div class="track-item__name" title="${track.name}">${track.name}</div>
      <div class="track-item__meta">${track.ext} · ${formatTime(track.duration)}</div>
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
function loadTrack(index) {
  if (index < 0 || index >= state.tracks.length) return;

  stopPlayback();
  state.currentIndex = index;
  startOffset = 0;

  const track = state.tracks[index];

  // Update transport info
  ui.nowPlayingName.textContent    = track.name;
  ui.nowPlayingDetail.textContent  = `${track.ext} · ${formatTime(track.duration)} · ${(track.sampleRate / 1000).toFixed(1)} kHz · ${track.channels}ch`;
  ui.wtimeEnd.textContent          = formatTime(track.duration);
  ui.wtimeStart.textContent        = '0:00';

  // Seek / progress reset
  updateSeek(0);

  // Waveform
  drawWaveform(track.buffer);

  // Info panel
  updateInfoPanel(track);

  // UI active state
  updateActiveTrackUI();

  setStatus(`Piste chargée : ${track.name}`);
}

/* ══════════════════════════════════════
   PLAYBACK ENGINE
══════════════════════════════════════ */
function startPlayback(offset = 0) {
  ensureAudioContext();

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
  state.isPlaying = false;
  startOffset = 0;
  setPlayPauseIcon(false);
  updateActiveTrackUI();
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
  ui.infoCard.innerHTML = `
    <div class="info-row"><span class="info-label">Fichier</span><span class="info-value">${track.name.slice(0, 18)}${track.name.length > 18 ? '…' : ''}</span></div>
    <div class="info-row"><span class="info-label">Format</span><span class="info-value">${track.ext}</span></div>
    <div class="info-row"><span class="info-label">Durée</span><span class="info-value">${formatTime(track.duration)}</span></div>
    <div class="info-row"><span class="info-label">Taille</span><span class="info-value">${formatBytes(track.size)}</span></div>
    <div class="info-row"><span class="info-label">Sample rate</span><span class="info-value">${(track.sampleRate / 1000).toFixed(1)} kHz</span></div>
    <div class="info-row"><span class="info-label">Canaux</span><span class="info-value">${track.channels === 2 ? 'Stéréo' : 'Mono'}</span></div>
  `;
}

/* ══════════════════════════════════════
   WAVEFORM RENDERING
══════════════════════════════════════ */
function drawWaveform(buffer) {
  ui.waveformIdle.classList.add('hidden');
  ui.waveformCanvas.classList.add('visible');
  ui.waveformCursor.classList.add('visible');

  const canvas = ui.waveformCanvas;
  const dpr    = window.devicePixelRatio || 1;
  canvas.width  = canvas.offsetWidth  * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  const ctx   = canvas.getContext('2d');
  const W     = canvas.width;
  const H     = canvas.height;
  ctx.scale(dpr, dpr);
  const cW = canvas.offsetWidth;
  const cH = canvas.offsetHeight;

  // Use averaged channels
  const rawData   = buffer.getChannelData(0);
  const samples   = cW * 2;
  const blockSize = Math.floor(rawData.length / samples);

  // Calculate peaks
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

  // Clear
  ctx.clearRect(0, 0, cW, cH);

  // Background subtle grid horizontal center
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, cH / 2);
  ctx.lineTo(cW, cH / 2);
  ctx.stroke();

  // Draw waveform bars
  const barW = cW / samples;
  const mid  = cH / 2;

  for (let i = 0; i < samples; i++) {
    const x      = i * barW;
    const { min, max } = peaks[i];
    const yTop   = mid + min * mid * 0.92;
    const yBot   = mid + max * mid * 0.92;
    const height = Math.max(yBot - yTop, 1);

    // Color gradient by amplitude
    const amp = Math.max(Math.abs(min), Math.abs(max));
    const g   = ctx.createLinearGradient(0, yTop, 0, yBot);
    if (amp > 0.8) {
      g.addColorStop(0, 'rgba(240,109,109,0.9)');
      g.addColorStop(1, 'rgba(240,109,109,0.5)');
    } else if (amp > 0.5) {
      g.addColorStop(0, 'rgba(157,145,255,0.85)');
      g.addColorStop(1, 'rgba(124,108,248,0.5)');
    } else {
      g.addColorStop(0, 'rgba(124,108,248,0.7)');
      g.addColorStop(1, 'rgba(62,207,142,0.4)');
    }

    ctx.fillStyle = g;
    ctx.fillRect(x, yTop, Math.max(barW - 0.5, 0.5), height);
  }
}

/* ══════════════════════════════════════
   FREQUENCY VISUALIZER
══════════════════════════════════════ */
let rafId = null;

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
        updateSeek(ratio);
        ui.wtimeStart.textContent = formatTime(ct);
        ui.timeDisplay.textContent = `${formatTime(ct)} / ${formatTime(track.duration)}`;

        if (ct >= track.duration && !state.isLooping) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }
    }

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
    loadTrack(state.currentIndex + 1);
    if (state.isPlaying) startPlayback(0);
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
   TEMPO & SPEED
══════════════════════════════════════ */
ui.speedSlider.addEventListener('input', () => {
  state.playbackRate = parseFloat(ui.speedSlider.value);
  ui.speedValue.textContent = `${state.playbackRate.toFixed(2)}x`;
  
  if (sourceNode) {
    // Smoothly transition playback rate to avoid clicks
    sourceNode.playbackRate.setTargetAtTime(state.playbackRate, audioCtx.currentTime, 0.05);
  }
});

ui.bpmInput.addEventListener('change', () => {
  let val = parseInt(ui.bpmInput.value);
  if (isNaN(val)) val = 120;
  state.bpm = Math.max(20, Math.min(300, val));
  ui.bpmInput.value = state.bpm;
  setStatus(`Tempo du projet : ${state.bpm} BPM`);
});

/* ══════════════════════════════════════
   VOLUME
══════════════════════════════════════ */
ui.volumeSlider.addEventListener('input', () => {
  state.volume = parseFloat(ui.volumeSlider.value);
  if (gainNode) gainNode.gain.value = state.volume;
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
    if (track) drawWaveform(track.buffer);
  }
});
resizeObserver.observe(ui.waveformCanvas.parentElement);

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
setStatus('Prêt — Importez un fichier MP3 ou WAV pour commencer');
