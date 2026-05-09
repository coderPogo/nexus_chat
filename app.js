/**
 * NEXUS App — Main Controller
 * Auth, routing, chat UI, real-time messaging via WebSocket.
 */

/* ─── State ─────────────────────────────────────────────────────────────── */
let currentUser = null;   // logged-in username (lowercase)
let activeConv  = null;   // currently open conversation partner
let wsConn      = null;   // WebSocket connection
let wsRetryMs   = 1000;   // reconnect backoff

/* ─── Animated Background ────────────────────────────────────────────────── */
(function initBg() {
  const canvas = document.getElementById('bg-canvas');
  const ctx    = canvas.getContext('2d');
  let W, H, dots;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
    buildDots();
  }

  function buildDots() {
    const count = Math.floor((W * H) / 14000);
    dots = Array.from({ length: count }, () => ({
      x:  Math.random() * W,
      y:  Math.random() * H,
      r:  Math.random() * 1.2 + 0.3,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(0,255,180,0.04)';
    ctx.lineWidth   = 0.5;
    const step = 60;
    for (let x = 0; x <= W; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y <= H; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    dots.forEach(d => {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0) d.x = W; if (d.x > W) d.x = 0;
      if (d.y < 0) d.y = H; if (d.y > H) d.y = 0;
    });
    dots.forEach((a, i) => {
      dots.slice(i + 1).forEach(b => {
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(0,255,180,${0.07 * (1 - dist / 100)})`;
          ctx.lineWidth   = 0.5;
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      });
      ctx.beginPath();
      ctx.fillStyle = 'rgba(0,255,180,0.5)';
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  draw();
})();

/* ─── Toast ──────────────────────────────────────────────────────────────── */
function showToast(msg, duration = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

/* ─── Tab Switch (Auth) ───────────────────────────────────────────────────── */
function switchTab(tab) {
  document.getElementById('login-form').classList.toggle('hidden',    tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('tab-login').classList.toggle('active',     tab === 'login');
  document.getElementById('tab-register').classList.toggle('active',  tab === 'register');
  document.getElementById('login-error').textContent = '';
  document.getElementById('reg-error').textContent   = '';
}

/* ─── Register ───────────────────────────────────────────────────────────── */
async function handleRegister(e) {
  e.preventDefault();
  const errEl    = document.getElementById('reg-error');
  const username = document.getElementById('reg-username').value.trim().toLowerCase();
  const pass     = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-confirm').value;

  errEl.textContent = '';

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    errEl.textContent = 'Username: 3–20 chars, letters/numbers/underscore only.'; return;
  }
  if (pass.length < 6)     { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if (pass !== confirm)    { errEl.textContent = 'Passwords do not match.'; return; }

  const btn = document.getElementById('register-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'CREATING…';

  try {
    const salt = username + ':nexus-v1';
    const hash = await NexusCrypto.hashPassword(pass, salt);
    await Store.register(username, hash, salt);
    showToast('✓ Account created. Please sign in.');
    switchTab('login');
    document.getElementById('login-username').value = username;
  } catch (err) {
    errEl.textContent = err.message || 'Registration failed.';
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'CREATE ACCOUNT';
  }
}

/* ─── Login ──────────────────────────────────────────────────────────────── */
async function handleLogin(e) {
  e.preventDefault();
  const errEl    = document.getElementById('login-error');
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const pass     = document.getElementById('login-password').value;

  errEl.textContent = '';

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'VERIFYING…';

  try {
    // We need the salt — it's deterministic (username:nexus-v1) so we can compute it client-side
    const salt = username + ':nexus-v1';
    const hash = await NexusCrypto.hashPassword(pass, salt);
    const data = await Store.login(username, hash);
    loginSuccess(data.username);
  } catch (err) {
    errEl.textContent = err.message || 'Login failed.';
    btn.disabled = false;
    btn.querySelector('span').textContent = 'AUTHENTICATE';
  }
}

/* ─── Login Success ──────────────────────────────────────────────────────── */
function loginSuccess(username) {
  currentUser = username;
  sessionStorage.setItem('nexus:session', username);

  // Update sidebar
  document.getElementById('sidebar-username').textContent = username;
  document.getElementById('sidebar-avatar').textContent   = username.charAt(0).toUpperCase();

  // Switch screens
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('auth-screen').classList.add('screen-hidden');
  document.getElementById('app-screen').classList.remove('screen-hidden');
  document.getElementById('app-screen').classList.add('active');

  // Connect WebSocket
  connectWebSocket();

  // Render conversation list
  renderConversationList();

  // Restore last active conv
  const last = sessionStorage.getItem('nexus:activeConv');
  if (last) openConvByPartner(last, false);
}

/* ─── Logout ─────────────────────────────────────────────────────────────── */
function logout() {
  currentUser = null;
  activeConv  = null;
  Store.clearToken();
  sessionStorage.clear();

  if (wsConn) { wsConn.close(); wsConn = null; }

  document.getElementById('app-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('screen-hidden');
  document.getElementById('auth-screen').classList.remove('screen-hidden');
  document.getElementById('auth-screen').classList.add('active');

  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').textContent = '';
  switchTab('login');
}

/* ─── Session Restore ────────────────────────────────────────────────────── */
(function restoreSession() {
  const savedUser  = sessionStorage.getItem('nexus:session');
  const savedToken = Store.getToken();
  if (savedUser && savedToken) {
    loginSuccess(savedUser);
  }
})();

/* ─── WebSocket ──────────────────────────────────────────────────────────── */
function connectWebSocket() {
  if (!currentUser) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url   = `${proto}//${location.host}`;

  wsConn = new WebSocket(url);

  wsConn.onopen = () => {
    wsRetryMs = 1000; // reset backoff on successful connect
    wsConn.send(JSON.stringify({ type: 'auth', token: Store.getToken() }));
  };

  wsConn.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'auth_ok') {
      console.log('[WS] Authenticated as', msg.username);
    } else if (msg.type === 'auth_err') {
      console.warn('[WS] Auth failed — logging out');
      logout();
    } else if (msg.type === 'msg') {
      await handleIncomingMessage(msg);
    }
  };

  wsConn.onclose = () => {
    if (!currentUser) return; // intentional logout
    // Exponential backoff reconnect
    setTimeout(() => {
      wsRetryMs = Math.min(wsRetryMs * 2, 30000);
      connectWebSocket();
    }, wsRetryMs);
  };

  wsConn.onerror = () => {}; // onclose will handle reconnect
}

/* Handle a message pushed from the server to this client. */
async function handleIncomingMessage(msg) {
  // Refresh sidebar for both sender and recipient
  renderConversationList();

  // If this chat is currently open, append the bubble
  const partner = msg.from_user === currentUser ? msg.to_user : msg.from_user;
  if (partner === activeConv) {
    const text    = await NexusCrypto.decrypt(msg.payload, currentUser, activeConv);
    const isSent  = msg.from_user === currentUser;
    const bubble  = createBubble(text, isSent, msg.ts);
    document.getElementById('messages').appendChild(bubble);
    scrollBottom();
  }
}

/* ─── Open Chat (from "To" form) ─────────────────────────────────────────── */
async function openChat(e) {
  e.preventDefault();
  const toField = document.getElementById('to-username');
  const target  = toField.value.trim().toLowerCase();
  toField.value = '';
  if (!target) return;
  if (target === currentUser) { showToast('You cannot message yourself.'); return; }
  await openConvByPartner(target, true);
}

async function openConvByPartner(partner, isNew) {
  if (isNew) {
    const exists = await Store.userExists(partner);
    if (!exists) { showToast(`User "@${partner}" not found.`); return; }
  }

  activeConv = partner;
  sessionStorage.setItem('nexus:activeConv', partner);

  // Update desktop header
  document.getElementById('chat-recipient-name').textContent = '@' + partner;
  document.getElementById('chat-avatar').textContent         = partner.charAt(0).toUpperCase();
  document.getElementById('chat-status-text').textContent    = 'Secure channel active';

  // Update mobile top bar & close drawer
  setMobileBar('chat', partner);
  if (isMobile()) closeSidebar();

  // Show chat view
  document.getElementById('chat-welcome').classList.add('hidden');
  document.getElementById('chat-view').classList.remove('hidden');

  // Refresh sidebar (don't await — let it update in background)
  renderConversationList();

  // Render messages
  await renderMessages();
  if (!isMobile()) document.getElementById('msg-input').focus();
}

/* ─── Conversation List ──────────────────────────────────────────────────── */
async function renderConversationList() {
  if (!currentUser) return;

  let convs = [];
  try { convs = await Store.getConversations(); } catch { return; }

  const list  = document.getElementById('conv-list');
  const empty = document.getElementById('conv-empty');

  // Remove old conv items
  list.querySelectorAll('.conv-item').forEach(el => el.remove());

  if (convs.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  convs.forEach(({ partner, last_ts }) => {
    const item = document.createElement('div');
    item.className   = 'conv-item' + (activeConv === partner ? ' active' : '');
    item.dataset.partner = partner;
    item.onclick = () => openConvByPartner(partner, false);

    item.innerHTML = `
      <div class="conv-avatar">${partner.charAt(0).toUpperCase()}</div>
      <div class="conv-info">
        <div class="conv-name">@${partner}</div>
        <div class="conv-last">🔒 Encrypted message</div>
      </div>
      <div class="conv-meta">
        ${last_ts ? `<div class="conv-time">${formatTime(last_ts)}</div>` : ''}
      </div>
    `;
    list.appendChild(item);
  });
}

function setActiveSidebarItem(partner) {
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.partner === partner);
  });
}

/* ─── Messages ───────────────────────────────────────────────────────────── */
async function renderMessages() {
  const container = document.getElementById('messages');
  container.innerHTML = '';

  let rawMsgs = [];
  try { rawMsgs = await Store.getMessages(activeConv); } catch { return; }

  if (rawMsgs.length === 0) {
    const sys = document.createElement('div');
    sys.className   = 'msg-system';
    sys.textContent = '🔒 Secure channel opened. Messages are AES-256-GCM encrypted.';
    container.appendChild(sys);
    scrollBottom();
    return;
  }

  let lastDate = null;
  for (const m of rawMsgs) {
    const d = dayLabel(m.ts);
    if (d !== lastDate) {
      const sep = document.createElement('div');
      sep.className   = 'date-sep';
      sep.textContent = d;
      container.appendChild(sep);
      lastDate = d;
    }
    const text   = await NexusCrypto.decrypt(m.payload, currentUser, activeConv);
    const isSent = m.from_user === currentUser;
    container.appendChild(createBubble(text, isSent, m.ts));
  }
  scrollBottom();
}

function createBubble(text, isSent, ts) {
  const wrap   = document.createElement('div');
  wrap.className = 'msg ' + (isSent ? 'sent' : 'recv');

  const bubble = document.createElement('div');
  bubble.className   = 'msg-bubble';
  bubble.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = `
    <svg class="msg-enc-icon" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
    ${formatTime(ts)}
  `;

  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  return wrap;
}

/* ─── Send Message ───────────────────────────────────────────────────────── */
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text  = input.value.trim();
  if (!text || !activeConv) return;

  input.value        = '';
  input.style.height = '';

  // Encrypt client-side
  const payload = await NexusCrypto.encrypt(text, currentUser, activeConv);

  try {
    const msg    = await Store.sendMessage(activeConv, payload);
    // Append sent bubble immediately (don't wait for WS echo)
    const bubble = createBubble(text, true, msg.ts);
    document.getElementById('messages').appendChild(bubble);
    scrollBottom();
    renderConversationList();
  } catch (err) {
    showToast('Failed to send: ' + (err.message || 'Unknown error'));
    input.value = text; // restore text on failure
  }
}

/* ─── Input Handling ─────────────────────────────────────────────────────── */
function handleMsgKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = '';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

/* ─── Scroll ─────────────────────────────────────────────────────────────── */
function scrollBottom() {
  const wrap = document.getElementById('messages-wrap');
  wrap.scrollTop = wrap.scrollHeight;
}

/* ─── Mobile Sidebar ─────────────────────────────────────────────────────── */
function isMobile() { return window.innerWidth <= 700; }

function openSidebar() {
  document.querySelector('.sidebar').classList.add('open');
  const ov = document.getElementById('sidebar-overlay');
  ov.style.display = 'block';
  requestAnimationFrame(() => ov.classList.add('visible'));
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  const ov = document.getElementById('sidebar-overlay');
  ov.classList.remove('visible');
  document.body.style.overflow = '';
  setTimeout(() => { ov.style.display = 'none'; }, 320);
}

function setMobileBar(mode, title = '') {
  const homeBar = document.getElementById('mob-home-bar');
  const chatBar = document.getElementById('mob-chat-bar');
  const titleEl = document.getElementById('mob-chat-title');
  if (mode === 'chat') {
    homeBar.style.display = 'none';
    chatBar.style.display = 'flex';
    titleEl.textContent   = title ? '@' + title : '';
  } else {
    homeBar.style.display = 'flex';
    chatBar.style.display = 'none';
  }
}

function goBackMobile() {
  activeConv = null;
  sessionStorage.removeItem('nexus:activeConv');
  document.getElementById('chat-view').classList.add('hidden');
  document.getElementById('chat-welcome').classList.remove('hidden');
  setMobileBar('home');
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
}

/* ─── Time Helpers ───────────────────────────────────────────────────────── */
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(ts) {
  const d     = new Date(ts);
  const today = new Date();
  const diff  = new Date(today.setHours(0,0,0,0)) - new Date(d.setHours(0,0,0,0));
  if (diff === 0)         return 'Today';
  if (diff === 86400000)  return 'Yesterday';
  return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
