/**
 * NEXUS Store — API Client
 * Replaces the old localStorage data layer with fetch() calls to the server.
 * The crypto layer (AES-256-GCM, PBKDF2) stays entirely client-side —
 * the server only ever sees encrypted payloads and password hashes.
 */

const Store = (() => {

  /* ── Token helpers ──────────────────────────────────────────────────────── */
  function getToken()       { return sessionStorage.getItem('nexus:token'); }
  function clearToken()     { sessionStorage.removeItem('nexus:token'); }
  function saveToken(tok)   { sessionStorage.setItem('nexus:token', tok); }

  /* ── Generic fetch wrapper ──────────────────────────────────────────────── */
  async function api(path, options = {}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res  = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ── Users ──────────────────────────────────────────────────────────────── */

  async function userExists(username) {
    try {
      const d = await api(`/api/users/${encodeURIComponent(username.toLowerCase())}`);
      return d.exists;
    } catch { return false; }
  }

  /**
   * Register a new account.
   * The password hash is computed client-side (PBKDF2); we send only the hash.
   */
  async function register(username, hash, salt) {
    await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, hash, salt }),
    });
  }

  /**
   * Login — sends pre-hashed password, gets back a JWT.
   */
  async function login(username, hash) {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, hash }),
    });
    saveToken(data.token);
    return data; // { token, username }
  }

  /* ── Conversations ──────────────────────────────────────────────────────── */

  /** Returns [{ partner: string, last_ts: number }, ...] ordered newest first. */
  async function getConversations() {
    return api('/api/conversations');
  }

  /* ── Messages ────────────────────────────────────────────────────────────── */

  /** Returns raw encrypted messages between currentUser and partner. */
  async function getMessages(partner) {
    return api(`/api/messages/${encodeURIComponent(partner.toLowerCase())}`);
  }

  /**
   * Save and push an encrypted message.
   * Returns the saved message object from the server.
   */
  async function sendMessage(to, payload) {
    return api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ to, payload }),
    });
  }

  /* ── Exports ─────────────────────────────────────────────────────────────── */
  return {
    getToken,
    clearToken,
    userExists,
    register,
    login,
    getConversations,
    getMessages,
    sendMessage,
  };
})();
