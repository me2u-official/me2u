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
const PEERJS_CONFIG = {
  debug: 0,          // 0 = silent in production
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

/* ────────────────────────────────────────────────────────────
   State
   ──────────────────────────────────────────────────────────── */
const state = {
  peer:         null,
  conn:         null,
  file:         null,
  mode:         'send',     // 'send' | 'receive'
  totalBytes:   0,
  sentBytes:    0,
  receivedBytes:0,
  chunks:       [],
  startTime:    0,
  connectTimer: null,
  sessionTransfers: 0,
  sessionDataSent:  0,
  downloadUrl:  null,
  writableStream: null,
  fallbackChunks: [],
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

/** Cryptographically secure random ID */
function generateSecureId() {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/** Extract peer ID from a full share URL or raw code */
function extractPeerId(input) {
  const trimmed = (input || '').trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (code && /^[0-9a-f]{24}$/.test(code)) return code;
  } catch (_) { /* not a URL */ }
  // Accept raw hex code
  if (/^[0-9a-f]{24}$/.test(trimmed)) return trimmed;
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
function handleFileSelected(file) {
  if (!file) return;
  state.file = file;

  // Show preview
  const preview = getEl('filePreview');
  preview.classList.add('visible');

  setText('fileName', file.name);
  setText('fileMeta', `${formatBytes(file.size)} · ${file.type || 'Unknown type'}`);
  getEl('fileTypeIcon').textContent = fileTypeIcon(file.name, file.type);

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
    showStatus('sendStatus', `Connection error: ${safeMsg}`, 'error');
    destroyPeer();
  });

  peer.on('disconnected', () => peer.reconnect());
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
      beginChunking(conn);
    } else if (data && data.type === 'ack-done') {
      markSendComplete();
    }
  });

  conn.on('close', () => {
    if (state.sentBytes < state.totalBytes) {
      showStatus('sendStatus', '❌ Receiver disconnected before transfer completed.', 'error');
    }
  });

  conn.on('error', () => {
    showStatus('sendStatus', '❌ Connection error during transfer.', 'error');
  });
}

function startSending(conn) {
  const file = state.file;
  if (!file) return;

  state.totalBytes = file.size;
  state.sentBytes  = 0;
  state.startTime  = Date.now();

  // Show progress (zero state initially)
  getEl('sendProgressSection').classList.add('visible');
  updateProgress('send', 0, state.totalBytes);

  // Send metadata first (no sensitive info, just name + size + type)
  conn.send({
    type:     'meta',
    name:     sanitiseFilename(file.name),
    size:     file.size,
    mimeType: file.type || 'application/octet-stream',
  });

  showStatus('sendStatus', 'Waiting for receiver to accept the file...', 'info');
}

function beginChunking(conn) {
  const file = state.file;
  if (!file) return;

  showStatus('sendStatus', '✅ Receiver accepted! Transferring…', 'success');

  // Chunked file reading via FileReader API
  let offset = 0;

  function sendNextChunk() {
    if (offset >= file.size) return; // All chunks sent; wait for ACK
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

  sendNextChunk();
}

function markSendComplete() {
  state.sessionTransfers++;
  state.sessionDataSent += state.totalBytes;

  const fill = getEl('sendProgressFill');
  if (fill) fill.classList.add('done');

  const dot = getEl('sendStatusDot');
  if (dot) { dot.classList.remove(); dot.className = 'progress-status-dot done'; }

  setText('sendProgressLabel', 'Transfer complete!');
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
    state.fallbackChunks = [];
    state.writableStream = null;
    state.receivedBytes  = 0;
    state.totalBytes     = 0;
    state.startTime      = Date.now();
  });

  conn.on('data', async (data) => {
    if (!data || !data.type) return;

    if (data.type === 'meta') {
      // Received file metadata
      state.totalBytes = data.size || 0;
      const safeName   = sanitiseFilename(data.name || 'file');

      getEl('incomingFilePreview').classList.add('visible');
      setText('incomingFileName', safeName);
      setText('incomingFileMeta', `${formatBytes(data.size)} · ${data.mimeType || 'Unknown type'}`);
      getEl('incomingFileTypeIcon').textContent = fileTypeIcon(safeName, data.mimeType);

      hideStatus('receiveStatus');
      
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
          }
          
          state.startTime = Date.now();
          getEl('receiveProgressSection').classList.add('visible');
          updateProgress('receive', 0, state.totalBytes);
          conn.send({ type: 'ack-accept' });
        };
      }

    } else if (data.type === 'chunk') {
      state.receivedBytes += data.data.byteLength;
      
      if (state.writableStream) {
        // Queue the write operation
        state.writableStream.write(data.data).catch(console.error);
      } else {
        state.fallbackChunks.push(data.data);
      }

      updateProgress('receive', state.receivedBytes, state.totalBytes);

      if (state.receivedBytes >= state.totalBytes) {
        // All chunks received
        assembleAndDownload(conn);
      }
    }
  });

  conn.on('close', () => {
    if (state.receivedBytes < state.totalBytes && state.totalBytes > 0) {
      showStatus('receiveStatus', '❌ Sender disconnected before transfer completed.', 'error');
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

  // ACK sender
  try { conn.send({ type: 'ack-done' }); } catch (_) { /* ignore */ }

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

    // Revoke after delay to ensure download starts
    setTimeout(() => {
      URL.revokeObjectURL(url);
      state.downloadUrl = null;
    }, 10_000);

    // Cleanup chunks from memory
    state.fallbackChunks = [];
    setText('receiveSuccessMsg', `"${safeName}" was saved to your Downloads folder.`);
  }

  state.sessionTransfers++;
  updateStats();

  setTimeout(() => {
    getEl('receiveProgressSection').classList.remove('visible');
    getEl('receiveSuccess').classList.add('visible');
    setText('receiveSuccessMsg', `"${safeName}" was saved to your Downloads folder.`);
  }, 800);
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
  state.file      = null;
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
  if (state.writableStream) {
    state.writableStream.close().catch(()=>{}).finally(()=>{ state.writableStream = null; });
  }
  state.receivedBytes = 0;

  getEl('incomingFilePreview').classList.remove('visible');
  getEl('receiveProgressSection').classList.remove('visible');
  getEl('receiveSuccess').classList.remove('visible');
  getEl('codeInput').value = '';
  getEl('connectBtn').disabled = false;
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
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelected(file);
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
  // Particles
  initParticles();

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
    const file = e.target.files?.[0];
    if (file) handleFileSelected(file);
  });

  // Remove file
  getEl('fileRemove').addEventListener('click', (e) => {
    e.stopPropagation();
    resetSendUI();
  });

  // Start send (generate link)
  getEl('startSendBtn').addEventListener('click', () => {
    if (!state.file) {
      showStatus('sendStatus', '⚠️ Please select a file first.', 'warn');
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
