/**
 * me2u — Core Application Logic
 * WebRTC P2P file sharing via PeerJS
 *
 * Security practices implemented:
 * - Cryptographically secure room IDs (crypto.getRandomValues)
 * - File data never leaves the browser pair; no server storage
 * - All WebRTC connections are DTLS-encrypted by default
 * - Input sanitisation: only safe text content used, no innerHTML with user data
 * - Connection timeouts and cleanup on all paths
 * - Memory cleanup after transfer (URL.revokeObjectURL)
 */

'use strict';

/* ────────────────────────────────────────────────────────────
   Constants & Config
   ──────────────────────────────────────────────────────────── */
const CHUNK_SIZE    = 64 * 1024;   // 64 KB per WebRTC chunk
const CONNECT_TIMEOUT_MS = 60_000; // 60s timeout for waiting
const MAX_FILE_SIZE_BYTES = 0;     // 0 = no limit (P2P, unlimited)

// PeerJS signaling server
// Change this to your Render URL (or 'localhost:9000' for local dev)
const SIGNALING_HOST = 'me2u-signal.onrender.com';

const PEERJS_CONFIG = {
  host: SIGNALING_HOST,
  port: 443,
  secure: true,
  path: '/me2u',
  pingInterval: 5000,
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  }
};
const MAX_RETRIES = 5;
let retryCount = 0;

/* ────────────────────────────────────────────────────────────
   State
   ──────────────────────────────────────────────────────────── */
const state = {
  peer:             null,
  conn:             null,
  files:            [],       // array of selected files
  currentFileIndex: 0,        // which file is being sent (sender)
  mode:             'send',   // 'send' | 'receive'
  totalBytes:       0,
  sentBytes:        0,
  receivedBytes:    0,
  chunks:           [],
  startTime:        0,
  connectTimer:     null,
  sessionTransfers: 0,
  sessionDataSent:  0,
  downloadUrl:      null,
  writableStream:   null,
  fallbackChunks:   [],
  isPausedByReceiver: false,
  pendingWritesCount: 0,
  isSenderPaused:     false,
  resumeSender:       null,
  pendingFiles:       [],     // queue of incoming file metas (receiver)
};

/* ────────────────────────────────────────────────────────────
   DOM Helpers
   ──────────────────────────────────────────────────────────── */

/** Safely set text content (never innerHTML) */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function getEl(id) { return document.getElementById(id); }

function show(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('hidden'); el.style.display = ''; }
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function showStatus(id, msg, type = 'info') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg visible ${type}`;
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️' };
  el.setAttribute('aria-label', `${icons[type] || ''} ${msg}`);
}

function hideStatus(id) {
  const el = document.getElementById(id);
  if (el) el.className = 'status-msg';
}

/* ────────────────────────────────────────────────────────────
   Utility Functions
   ──────────────────────────────────────────────────────────── */

function generateSecureId() {
  // Return a 16-character hex string using crypto API for uniqueness
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/** Extract peer ID from a full share URL or raw code */
function extractPeerId(input) {
  const trimmed = (input || '').trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (code && /^[a-z0-9]{6,24}$/.test(code)) return code;
  } catch (_) { /* not a URL */ }
  // Accept raw code (alphanumeric, 6-24 chars)
  if (/^[a-z0-9]{6,24}$/.test(trimmed)) return trimmed;
  return null;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function fileTypeIcon(name = '', type = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: '📕', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊',
    ppt: '📊', pptx: '📊', txt: '📃', md: '📃',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', ico: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', m4a: '🎵',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    js: '💻', ts: '💻', py: '💻', html: '💻', css: '💻', json: '💻',
    exe: '⚙️', msi: '⚙️', dmg: '⚙️', apk: '⚙️',
  };
  return map[ext] || (type.startsWith('image') ? '🖼️'
       : type.startsWith('video') ? '🎬'
       : type.startsWith('audio') ? '🎵'
       : '📄');
}

function updateStats() {
  setText('statTransfers', state.sessionTransfers.toString());
  setText('statDataSent', formatBytes(state.sessionDataSent));
  setText('statPeers', state.peer ? '1' : '0');
}

/* ────────────────────────────────────────────────────────────
   Particle Canvas Background
   ──────────────────────────────────────────────────────────── */
function initParticles() {
  const canvas = document.getElementById('particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const particles = [];
  
  // Use RGB values so we can easily control alpha dynamically
  const COLORS = ['108, 99, 255', '0, 212, 255', '255, 45, 120', '0, 255, 157'];

  // Track mouse position
  let mouse = { x: null, y: null, radius: 180 };

  window.addEventListener('mousemove', (e) => {
    mouse.x = e.x;
    mouse.y = e.y;
  });

  window.addEventListener('mouseout', () => {
    mouse.x = null;
    mouse.y = null;
  });

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function createParticle() {
    return {
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 2 + 0.5,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      baseAlpha: Math.random() * 0.4 + 0.1,
    };
  }

  resize();
  window.addEventListener('resize', resize);
  
  // Increase count for a dense network
  for (let i = 0; i < 80; i++) particles.push(createParticle());

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    for (let i = 0; i < particles.length; i++) {
      let p = particles[i];
      
      // Move
      p.x += p.vx; 
      p.y += p.vy;
      
      // Bounce off walls
      if (p.x < 0 || p.x > canvas.width)  p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

      let opacity = p.baseAlpha;

      // Mouse Interaction
      if (mouse.x != null && mouse.y != null) {
        let dx = mouse.x - p.x;
        let dy = mouse.y - p.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < mouse.radius) {
          // Particles glow brighter near the mouse
          opacity = Math.min(1, p.baseAlpha + (1 - distance / mouse.radius));
          
          // Slight parallax repel effect (push away softly)
          const force = (mouse.radius - distance) / mouse.radius;
          p.x -= (dx / distance) * force * 0.5;
          p.y -= (dy / distance) * force * 0.5;

          // Draw connection line to mouse
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${p.color}, ${0.15 * (1 - distance / mouse.radius)})`;
          ctx.lineWidth = 1;
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
        }
      }

      // Draw particle dot
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.color}, ${opacity})`;
      ctx.fill();
      
      // Connect to nearby particles to form a web
      for (let j = i + 1; j < particles.length; j++) {
        let p2 = particles[j];
        let dx = p.x - p2.x;
        let dy = p.y - p2.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        
        // Connect if close enough
        if (dist < 120) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${p.color}, ${0.08 * (1 - dist / 120)})`;
          ctx.lineWidth = 0.5;
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(animate);
  }
  animate();
}

/* ────────────────────────────────────────────────────────────
   Progress Updater
   ──────────────────────────────────────────────────────────── */
function updateProgress(prefix, received, total) {
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
  const fill = document.getElementById(`${prefix}ProgressFill`);
  const track = document.getElementById(`${prefix}ProgressTrack`);

  if (fill) fill.style.width = `${pct}%`;
  if (track) track.setAttribute('aria-valuenow', pct);

  setText(`${prefix}ProgressBytes`, `${formatBytes(received)} / ${formatBytes(total)}`);
  setText(`${prefix}ProgressPct`, `${pct}%`);

  const elapsed = (Date.now() - state.startTime) / 1000;
  if (elapsed > 0) {
    const speed = received / elapsed;
    setText(`${prefix}Speed`, formatSpeed(speed));
  }
}

/* ────────────────────────────────────────────────────────────
   Tab Switching
   ──────────────────────────────────────────────────────────── */
function switchMode(mode) {
  state.mode = mode;
  const sendPanel    = getEl('sendPanel');
  const receivePanel = getEl('receivePanel');
  const sendTab      = getEl('sendTabBtn');
  const receiveTab   = getEl('receiveTabBtn');

  if (mode === 'send') {
    sendPanel.classList.remove('hidden');
    receivePanel.classList.add('hidden');
    sendTab.classList.add('active');
    sendTab.setAttribute('aria-selected', 'true');
    receiveTab.classList.remove('active');
    receiveTab.setAttribute('aria-selected', 'false');
  } else {
    sendPanel.classList.add('hidden');
    receivePanel.classList.remove('hidden');
    receiveTab.classList.add('active');
    receiveTab.setAttribute('aria-selected', 'true');
    sendTab.classList.remove('active');
    sendTab.setAttribute('aria-selected', 'false');
  }
}

/* ────────────────────────────────────────────────────────────
   File Selection
   ──────────────────────────────────────────────────────────── */
function handleFilesSelected(files) {
  if (!files || files.length === 0) return;
  state.files = Array.from(files);
  state.currentFileIndex = 0;

  // Show preview
  const preview = getEl('filePreview');
  preview.classList.add('visible');

  const totalSize = state.files.reduce((s, f) => s + f.size, 0);
  if (state.files.length === 1) {
    const f = state.files[0];
    setText('fileName', f.name);
    setText('fileMeta', `${formatBytes(f.size)} · ${f.type || 'Unknown type'}`);
    getEl('fileTypeIcon').textContent = fileTypeIcon(f.name, f.type);
  } else {
    setText('fileName', `${state.files.length} files selected`);
    setText('fileMeta', `Total: ${formatBytes(totalSize)}`);
    getEl('fileTypeIcon').textContent = '📦';
  }

  getEl('startSendBtn').disabled = false;
  hideStatus('sendStatus');

  // Update drop zone icon
  getEl('dropZone').querySelector('.drop-zone-icon').textContent = '✅';
}

/* ────────────────────────────────────────────────────────────
   Peer Initialisation (Sender)
   ──────────────────────────────────────────────────────────── */
function initSenderPeer() {
  destroyPeer(); // clean up any previous instance

  const id = generateSecureId();
  const peer = new Peer(id, PEERJS_CONFIG);
  state.peer = peer;

  peer.on('open', (assignedId) => {
    // Build share link
    const url = new URL(window.location.href);
    url.searchParams.set('code', assignedId);

    getEl('shareLinkInput').value = url.toString();

    // QR Code via free API (no data stored, just an image service)
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(url.toString())}&bgcolor=ffffff&color=07080f&margin=4`;
    const qrImg = document.createElement('img');
    qrImg.src = qrUrl;
    qrImg.alt = 'QR code for share link';
    qrImg.width = 80;
    qrImg.height = 80;
    getEl('qrCode').innerHTML = '';
    getEl('qrCode').appendChild(qrImg);

    show('waitingIndicator');
    getEl('waitingIndicator').classList.remove('hidden');
    getEl('shareSection').classList.add('visible');
    getEl('sendProgressSection').classList.remove('visible');

    // Timeout: if no connection in 60s, warn user
    state.connectTimer = setTimeout(() => {
      if (!state.conn) {
        showStatus('sendStatus', '⚠️ No one connected yet. Share the link and keep this tab open.', 'warn');
      }
    }, CONNECT_TIMEOUT_MS);
  });

  peer.on('connection', (conn) => {
    state.conn = conn;
    clearTimeout(state.connectTimer);
    getEl('waitingIndicator').classList.add('hidden');
    setupSenderConnection(conn);
  });

  peer.on('error', (err) => {
    const safeMsg = sanitiseErrorMessage(err.type || 'error');
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      showStatus('sendStatus', `Connection issue, retrying (${retryCount}/${MAX_RETRIES})…`, 'warn');
      destroyPeer();
      setTimeout(() => initSenderPeer(), 2000 * retryCount);
    } else {
      showStatus('sendStatus', `Connection error: ${safeMsg}`, 'error');
      retryCount = 0;
      destroyPeer();
    }
  });

  peer.on('disconnected', () => {
    try { peer.reconnect(); } catch(_) {}
  });
}

/** Map PeerJS error types to safe, user-friendly messages */
function sanitiseErrorMessage(type) {
  const map = {
    'not-open-yet':         'Connecting to signalling server…',
    'network':              'Network error. Check your internet connection.',
    'peer-unavailable':     'The sender is not available. The link may have expired.',
    'invalid-id':           'Invalid share code. Please check and try again.',
    'unavailable-id':       'This session ID is already in use. Please regenerate.',
    'ssl-unavailable':      'SSL is required. Please use HTTPS.',
    'server-error':         'Signalling server error. Please try again.',
    'socket-error':         'Socket error. Check your firewall or network.',
    'socket-closed':        'Connection closed unexpectedly.',
    'browser-incompatible': 'Your browser does not support WebRTC. Try Chrome or Firefox.',
  };
  return map[type] || 'An unexpected error occurred.';
}

/* ────────────────────────────────────────────────────────────
   Send File in Chunks
   ──────────────────────────────────────────────────────────── */
function setupSenderConnection(conn) {
  showStatus('sendStatus', '✅ Receiver connected! Starting transfer…', 'success');

  conn.on('open', () => {
    hideStatus('sendStatus');
    startSending(conn);
  });

  conn.on('data', (data) => {
    if (data && data.type === 'ack-accept') {
      hideStatus('sendStatus');
      beginChunking(conn, data.resumeOffset || 0);
    } else if (data && data.type === 'ack-done') {
      markSendComplete(conn);
    } else if (data && data.type === 'pause-transfer') {
      state.isPausedByReceiver = true;
    } else if (data && data.type === 'resume-transfer') {
      if (state.isPausedByReceiver) {
        state.isPausedByReceiver = false;
        if (state.resumeSender) {
          state.resumeSender();
        }
      }
    }
  });

  conn.on('close', () => {
    if (state.sentBytes < state.totalBytes) {
      showStatus('sendStatus', '⚠️ Connection lost. Keep this tab open; the receiver can reconnect to resume the transfer.', 'warn');
    }
  });

  conn.on('error', () => {
    showStatus('sendStatus', '❌ Connection error during transfer.', 'error');
  });
}

function startSending(conn) {
  if (state.files.length === 0) return;
  state.currentFileIndex = 0;
  sendNextFileMeta(conn);
}

function sendNextFileMeta(conn) {
  const idx = state.currentFileIndex;
  if (idx >= state.files.length) {
    allFilesSent(conn);
    return;
  }

  const file = state.files[idx];
  state.totalBytes = file.size;
  state.sentBytes  = 0;
  state.startTime  = Date.now();

  // Show progress
  getEl('sendProgressSection').classList.add('visible');
  updateProgress('send', 0, state.totalBytes);

  if (state.files.length > 1) {
    showStatus('sendStatus', `Sending file ${idx + 1} of ${state.files.length}...`, 'info');
    setText('sendProgressLabel', `File ${idx + 1}/${state.files.length}`);
  }

  // Send metadata
  conn.send({
    type:      'meta',
    fileIndex: idx,
    name:      sanitiseFilename(file.name),
    size:      file.size,
    mimeType:  file.type || 'application/octet-stream',
  });

  showStatus('sendStatus', 'Waiting for receiver to accept the file...', 'info');
}

function beginChunking(conn, startOffset = 0) {
  const file = state.files[state.currentFileIndex];
  if (!file) return;

  showStatus('sendStatus', '✅ Receiver accepted! Transferring…', 'success');

  const dc = conn.dataChannel;
  const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB
  if (dc) {
    dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD;
  }

  // Chunked file reading via FileReader API
  let offset = startOffset;
  let isNetworkPaused = false;

  state.isPausedByReceiver = false;

  function sendNextChunk() {
    if (offset >= file.size) return; // All chunks sent; wait for ACK

    // 1. Receiver-side backpressure (disk busy writing)
    if (state.isPausedByReceiver) return;

    // 2. Sender-side backpressure (network buffer full)
    if (dc && dc.bufferedAmount > BUFFER_THRESHOLD) {
      if (!isNetworkPaused) {
        isNetworkPaused = true;
        dc.addEventListener('bufferedamountlow', onBufferLow, { once: true });
      }
      return;
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        conn.send({ type: 'chunk', data: e.target.result });
        offset += e.target.result.byteLength;
        state.sentBytes = offset;
        updateProgress('send', state.sentBytes, state.totalBytes);
        sendNextChunk();
      } catch (err) {
        showStatus('sendStatus', '❌ Failed to send chunk. Connection may have dropped.', 'error');
      }
    };

    reader.onerror = () => {
      showStatus('sendStatus', '❌ Failed to read file. Please try again.', 'error');
    };

    reader.readAsArrayBuffer(slice);
  }

  function onBufferLow() {
    isNetworkPaused = false;
    sendNextChunk();
  }

  state.resumeSender = sendNextChunk;
  sendNextChunk();
}

function markSendComplete(conn) {
  state.sessionTransfers++;
  state.sessionDataSent += state.files[state.currentFileIndex].size;

  // Move to next file
  state.currentFileIndex++;
  if (state.currentFileIndex < state.files.length) {
    sendNextFileMeta(conn);
    return;
  }

  allFilesSent(conn);
}

function allFilesSent(conn) {
  const fill = getEl('sendProgressFill');
  if (fill) fill.classList.add('done');

  const dot = getEl('sendStatusDot');
  if (dot) { dot.classList.remove(); dot.className = 'progress-status-dot done'; }

  setText('sendProgressLabel', 'All files sent!');
  updateProgress('send', state.totalBytes, state.totalBytes);
  updateStats();

  setTimeout(() => {
    getEl('sendProgressSection').classList.remove('visible');
    getEl('shareSection').classList.remove('visible');
    getEl('sendSuccess').classList.add('visible');
  }, 800);
}

/* ────────────────────────────────────────────────────────────
   Receive Side
   ──────────────────────────────────────────────────────────── */
function connectToSender(rawInput) {
  const senderId = extractPeerId(rawInput);
  if (!senderId) {
    showStatus('receiveStatus', '❌ Invalid code or link. Please check and try again.', 'error');
    return;
  }

  showStatus('receiveStatus', '🔗 Connecting to sender…', 'info');
  getEl('connectBtn').disabled = true;

  destroyPeer();

  const peer = new Peer(generateSecureId(), PEERJS_CONFIG);
  state.peer = peer;

  peer.on('open', () => {
    const conn = peer.connect(senderId, {
      reliable: true,
      serialization: 'binary',
    });
    state.conn = conn;
    setupReceiverConnection(conn);
  });

  peer.on('error', (err) => {
    const safeMsg = sanitiseErrorMessage(err.type || 'error');
    showStatus('receiveStatus', `❌ ${safeMsg}`, 'error');
    getEl('connectBtn').disabled = false;
    destroyPeer();
  });
}

function setupReceiverConnection(conn) {
  conn.on('open', () => {
    showStatus('receiveStatus', '✅ Connected! Waiting for file info…', 'success');
    if (state.receivedBytes === 0) {
      state.fallbackChunks = [];
      state.writableStream = null;
      state.totalBytes     = 0;
      state.pendingWritesCount = 0;
      state.isSenderPaused = false;
    }
    state.startTime = Date.now();
  });

  conn.on('data', async (data) => {
    if (!data || !data.type) return;

    if (data.type === 'meta') {
      // Received file metadata
      state.totalBytes = data.size || 0;
      const safeName   = sanitiseFilename(data.name || 'file');
      const fileIndex  = data.fileIndex || 0;

      getEl('incomingFilePreview').classList.add('visible');
      setText('incomingFileName', safeName);
      setText('incomingFileMeta', `${formatBytes(data.size)} · ${data.mimeType || 'Unknown type'}`);
      getEl('incomingFileTypeIcon').textContent = fileTypeIcon(safeName, data.mimeType);

      // If multiple files, show which file we're on
      if (fileIndex > 0) {
        showStatus('receiveStatus', `Receiving file ${fileIndex + 1}...`, 'info');
      }

      // If we already have bytes, this is a reconnection/resumption
      if (state.receivedBytes > 0) {
        showStatus('receiveStatus', `🔄 Connection restored! Resuming transfer from ${formatBytes(state.receivedBytes)}…`, 'success');
        
        if (state.writableStream) {
          try {
            await state.writableStream.seek(state.receivedBytes);
          } catch (seekErr) {
            console.error('Failed to seek stream, resuming may write from wrong offset:', seekErr);
          }
        }
        
        state.startTime = Date.now();
        getEl('receiveProgressSection').classList.add('visible');
        conn.send({ type: 'ack-accept', resumeOffset: state.receivedBytes, fileIndex });
      } else {
        // Reset per-file state
        state.receivedBytes = 0;
        state.fallbackChunks = [];
        state.writableStream = null;
        state.pendingWritesCount = 0;
        state.isSenderPaused = false;

        // Mobile RAM limit warning if showSaveFilePicker is not supported
        if (!('showSaveFilePicker' in window) && data.size > 150 * 1024 * 1024) {
          showStatus('receiveStatus', '⚠️ Warning: Mobile browsers have strict RAM limits. Files > 150MB may crash the browser tab. We suggest using a desktop browser (Chrome/Edge) for large files.', 'warn');
        } else {
          hideStatus('receiveStatus');
        }
        
        const acceptBtn = getEl('acceptDownloadBtn');
        if (acceptBtn) {
          acceptBtn.style.display = 'block';
          acceptBtn.onclick = async () => {
            acceptBtn.style.display = 'none';
            
            if ('showSaveFilePicker' in window) {
              try {
                const handle = await window.showSaveFilePicker({ suggestedName: safeName });
                state.writableStream = await handle.createWritable();
              } catch (err) {
                showStatus('receiveStatus', '❌ Download cancelled or failed to open file picker.', 'error');
                return;
              }
            } else {
              // Show foreground warning for mobile/Safari
              showStatus('receiveStatus', '⚠️ Keep this page open in the foreground. Switching apps will interrupt the transfer.', 'warn');
            }
            
            state.startTime = Date.now();
            getEl('receiveProgressSection').classList.add('visible');
            updateProgress('receive', 0, state.totalBytes);
            conn.send({ type: 'ack-accept', fileIndex });
          };
        }
      }

    } else if (data.type === 'chunk') {
      state.receivedBytes += data.data.byteLength;
      
      if (state.writableStream) {
        state.pendingWritesCount++;
        
        // Backpressure: if disk write queue builds up (> 32 chunks / ~2MB), pause the sender
        if (state.pendingWritesCount > 32 && !state.isSenderPaused) {
          state.isSenderPaused = true;
          conn.send({ type: 'pause-transfer' });
        }

        state.writableStream.write(data.data).then(() => {
          state.pendingWritesCount--;
          
          // Resume sender when queue drops below low-watermark (8 chunks / 512KB)
          if (state.pendingWritesCount <= 8 && state.isSenderPaused) {
            state.isSenderPaused = false;
            conn.send({ type: 'resume-transfer' });
          }

          // If all chunks received and all writes flushed, assemble and complete
          if (state.receivedBytes >= state.totalBytes && state.pendingWritesCount === 0) {
            assembleAndDownload(conn);
          }
        }).catch(err => {
          console.error('Disk write error:', err);
          showStatus('receiveStatus', '❌ Failed to write file to disk. Check disk space.', 'error');
        });

      } else {
        state.fallbackChunks.push(data.data);
        if (state.receivedBytes >= state.totalBytes) {
          assembleAndDownload(conn);
        }
      }

      updateProgress('receive', state.receivedBytes, state.totalBytes);
    }
  });

  conn.on('close', () => {
    if (state.receivedBytes < state.totalBytes && state.totalBytes > 0) {
      showStatus('receiveStatus', '❌ Connection lost. Make sure the sender tab is still open, and click "Reconnect & Resume" to try again.', 'error');
      const connectBtn = getEl('connectBtn');
      if (connectBtn) {
        connectBtn.disabled = false;
        const labelSpan = connectBtn.querySelector('span:nth-child(2)');
        if (labelSpan) labelSpan.textContent = 'Reconnect & Resume';
      }
    }
  });

  conn.on('error', () => {
    showStatus('receiveStatus', '❌ Connection error during transfer.', 'error');
  });
}

async function assembleAndDownload(conn) {
  const fill = getEl('receiveProgressFill');
  if (fill) fill.classList.add('done');
  const dot = getEl('receiveStatusDot');
  if (dot) dot.className = 'progress-status-dot done';
  setText('receiveProgressLabel', 'Download complete!');

  const nameEl = getEl('incomingFileName');
  const fileName = nameEl ? nameEl.textContent : 'download';
  const safeName = sanitiseFilename(fileName);

  if (state.writableStream) {
    await state.writableStream.close();
    state.writableStream = null;
    setText('receiveSuccessMsg', `"${safeName}" was saved successfully.`);
  } else {
    const blob = new Blob(state.fallbackChunks);
    const url  = URL.createObjectURL(blob);
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = url;

    // Trigger download
    const a = document.createElement('a');
    a.href     = url;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => {
      URL.revokeObjectURL(url);
      state.downloadUrl = null;
    }, 10_000);

    state.fallbackChunks = [];
    setText('receiveSuccessMsg', `"${safeName}" was saved to your Downloads folder.`);
  }

  // Signal sender this file is done (sender will send next meta or finish)
  state.sessionTransfers++;
  updateStats();

  // Hide progress, show success briefly, then wait for next file
  getEl('receiveProgressSection').classList.remove('visible');
  getEl('receiveSuccess').classList.add('visible');

  // Send ack-done so sender moves to next file
  try { conn.send({ type: 'ack-done' }); } catch (_) { /* ignore */ }

  // Auto-hide success after 3s to prepare for next file (if more coming)
  setTimeout(() => {
    getEl('receiveSuccess').classList.remove('visible');
    getEl('incomingFilePreview').classList.remove('visible');
  }, 3000);
}

/* ────────────────────────────────────────────────────────────
   Security: Filename Sanitisation
   ──────────────────────────────────────────────────────────── */
function sanitiseFilename(name) {
  // Remove null bytes, control chars, path traversal components, and limit length
  return (name || 'file')
    .replace(/\0/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/(\.\.)+/g, '_')
    .slice(0, 255)
    .trim() || 'file';
}

/* ────────────────────────────────────────────────────────────
   Cleanup
   ──────────────────────────────────────────────────────────── */
function destroyPeer() {
  clearTimeout(state.connectTimer);
  if (state.conn) {
    try { state.conn.close(); } catch (_) {}
    state.conn = null;
  }
  if (state.peer) {
    try { state.peer.destroy(); } catch (_) {}
    state.peer = null;
  }
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
}

function resetSendUI() {
  state.files = [];
  state.currentFileIndex = 0;
  state.sentBytes = 0;
  state.totalBytes = 0;
  state.chunks    = [];
  destroyPeer();

  getEl('filePreview').classList.remove('visible');
  getEl('shareSection').classList.remove('visible');
  getEl('sendProgressSection').classList.remove('visible');
  getEl('sendSuccess').classList.remove('visible');
  getEl('waitingIndicator').classList.add('hidden');
  getEl('startSendBtn').disabled = true;
  getEl('dropZone').querySelector('.drop-zone-icon').textContent = '📁';
  getEl('fileInput').value = '';
  hideStatus('sendStatus');

  const fill = getEl('sendProgressFill');
  if (fill) { fill.style.width = '0%'; fill.classList.remove('done'); }
}

function resetReceiveUI() {
  destroyPeer();
  state.fallbackChunks = [];
  state.pendingFiles = [];
  if (state.writableStream) {
    state.writableStream.close().catch(()=>{}).finally(()=>{ state.writableStream = null; });
  }
  state.receivedBytes = 0;

  getEl('incomingFilePreview').classList.remove('visible');
  getEl('receiveProgressSection').classList.remove('visible');
  getEl('receiveSuccess').classList.remove('visible');
  getEl('codeInput').value = '';
  
  const connectBtn = getEl('connectBtn');
  if (connectBtn) {
    connectBtn.disabled = false;
    const labelSpan = connectBtn.querySelector('span:nth-child(2)');
    if (labelSpan) labelSpan.textContent = 'Connect & Receive';
  }
  
  hideStatus('receiveStatus');

  const fill = getEl('receiveProgressFill');
  if (fill) { fill.style.width = '0%'; fill.classList.remove('done'); }
}

/* ────────────────────────────────────────────────────────────
   Copy to Clipboard
   ──────────────────────────────────────────────────────────── */
async function copyShareLink() {
  const input = getEl('shareLinkInput');
  if (!input || !input.value) return;

  try {
    await navigator.clipboard.writeText(input.value);
  } catch (_) {
    // Fallback for older browsers
    input.select();
    document.execCommand('copy');
  }

  const btn      = getEl('copyBtn');
  const copyIcon = getEl('copyIcon');
  const copyText = getEl('copyText');

  btn.classList.add('copied');
  if (copyIcon) copyIcon.textContent = '✅';
  if (copyText) copyText.textContent = 'Copied!';

  setTimeout(() => {
    btn.classList.remove('copied');
    if (copyIcon) copyIcon.textContent = '📋';
    if (copyText) copyText.textContent = 'Copy';
  }, 2500);
}

/* ────────────────────────────────────────────────────────────
   Drop Zone Drag Events
   ──────────────────────────────────────────────────────────── */
function initDropZone() {
  const zone = getEl('dropZone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) handleFilesSelected(files);
  });

  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      getEl('fileInput').click();
    }
  });
}

/* ────────────────────────────────────────────────────────────
   Auto-detect receive mode from URL param
   ──────────────────────────────────────────────────────────── */
function checkUrlForCode() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  if (code) {
    switchMode('receive');
    const codeInput = getEl('codeInput');
    if (codeInput) codeInput.value = code;
    // Auto-connect after a brief paint delay
    setTimeout(() => connectToSender(code), 400);
  }
}

/* ────────────────────────────────────────────────────────────
   App Bootstrap
   ──────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Wake up signaling server if sleeping
  pingSignalingServer();

  // Particles
  initParticles();

  // 3D Parallax Tilt
  initTilt();

  // Drop zone
  initDropZone();

  // Check for ?code= in URL
  checkUrlForCode();

  // Update stats
  updateStats();

  /* ── Event Listeners ── */

  // Tab switching
  getEl('sendTabBtn').addEventListener('click', () => switchMode('send'));
  getEl('receiveTabBtn').addEventListener('click', () => switchMode('receive'));

  // File input
  getEl('browseBtn').addEventListener('click', () => getEl('fileInput').click());
  getEl('dropZone').addEventListener('click', (e) => {
    if (e.target !== getEl('browseBtn') && !getEl('browseBtn').contains(e.target)) {
      getEl('fileInput').click();
    }
  });
  getEl('fileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesSelected(e.target.files);
    }
  });

  // Remove file
  getEl('fileRemove').addEventListener('click', (e) => {
    e.stopPropagation();
    resetSendUI();
  });

  // Start send (generate link)
  getEl('startSendBtn').addEventListener('click', () => {
    if (state.files.length === 0) {
      showStatus('sendStatus', '⚠️ Please select files first.', 'warn');
      return;
    }
    getEl('startSendBtn').disabled = true;
    getEl('cancelSendBtn').style.display = 'inline-flex';
    showStatus('sendStatus', '🔗 Creating secure session…', 'info');
    initSenderPeer();
  });

  // Cancel send
  getEl('cancelSendBtn').addEventListener('click', () => {
    resetSendUI();
    getEl('cancelSendBtn').style.display = 'none';
  });

  // Copy link
  getEl('copyBtn').addEventListener('click', copyShareLink);

  // Also allow clicking the link input to copy
  getEl('shareLinkInput').addEventListener('click', function () {
    this.select();
  });

  // Native share (mobile)
  const shareLinkInput = getEl('shareLinkInput');
  if (navigator.share && shareLinkInput) {
    const shareBtn = document.createElement('button');
    shareBtn.className = 'copy-btn';
    shareBtn.style.marginTop = '8px';
    shareBtn.innerHTML = '<span>📤</span> <span>Share</span>';
    shareBtn.addEventListener('click', async () => {
      if (shareLinkInput.value) {
        try { await navigator.share({ url: shareLinkInput.value }); } catch (_) {}
      }
    });
    getEl('shareSection')?.appendChild(shareBtn);
  }

  // Receive: connect
  getEl('connectBtn').addEventListener('click', () => {
    const input = getEl('codeInput').value.trim();
    if (!input) {
      showStatus('receiveStatus', '⚠️ Please enter a code or link.', 'warn');
      return;
    }
    connectToSender(input);
  });

  // Receive input: allow Enter key
  getEl('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') getEl('connectBtn').click();
  });

  // Send Again
  getEl('sendAgainBtn').addEventListener('click', () => {
    resetSendUI();
  });

  // Receive Again
  getEl('receiveAgainBtn').addEventListener('click', () => {
    resetReceiveUI();
  });

  // Cleanup on tab/window close
  window.addEventListener('beforeunload', destroyPeer);
});

async function pingSignalingServer() {
  try {
    // Send a silent check request to Render signaling server to wake it up
    const protocol = SIGNALING_HOST.includes('localhost') ? 'http' : 'https';
    const pingUrl = `${protocol}://${SIGNALING_HOST}/me2u`;
    await fetch(pingUrl, { mode: 'no-cors' });
    console.log('[*] Signaling server pinged:', pingUrl);
  } catch (e) {
    console.warn('[*] Failed to ping signaling server:', e);
  }
}

function initTilt() {
  const cards = document.querySelectorAll('.card');
  cards.forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      // Calculate rotation (max 8 degrees for a subtle, elegant feel)
      const rotateX = ((centerY - y) / centerY) * 8;
      const rotateY = ((x - centerX) / centerX) * -8;
      
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.015, 1.015, 1.015)`;
    });
    
    card.addEventListener('mouseleave', () => {
      card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
    });
  });
}
