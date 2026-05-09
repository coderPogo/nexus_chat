/**
 * NEXUS — Server
 * Express REST API + WebSocket real-time layer + sql.js SQLite persistence.
 *
 * sql.js is pure JavaScript (no native compilation), works on any Node version.
 * The DB is loaded from / saved to disk on every write.
 */

'use strict';

const express   = require('express');
const { WebSocketServer } = require('ws');
const initSqlJs = require('sql.js');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');

/* ─── Config ─────────────────────────────────────────────────────────────── */
const PORT       = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'nexus-dev-secret-CHANGE-IN-PRODUCTION';
const DATA_DIR   = path.join(__dirname, 'data');
const DB_PATH    = path.join(DATA_DIR, 'nexus.db');

if (JWT_SECRET === 'nexus-dev-secret-CHANGE-IN-PRODUCTION') {
  console.warn('[WARN] Using default JWT_SECRET. Set JWT_SECRET env var in production!');
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ─── Boot (async — wait for sql.js WASM to load) ───────────────────────── */
initSqlJs().then(SQL => {

  /* ── Open or create the SQLite database ── */
  let db;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  /** Flush the in-memory DB to disk after every write. */
  function persist() {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  /* ── Schema ── */
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      username   TEXT PRIMARY KEY,
      hash       TEXT NOT NULL,
      salt       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id        TEXT PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user   TEXT NOT NULL,
      payload   TEXT NOT NULL,
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (from_user, to_user, ts);
  `);
  persist();

  /* ── Helper: run a SELECT and return rows as plain objects ── */
  function query(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function queryOne(sql, params = []) {
    return query(sql, params)[0] || null;
  }

  /* ─── Express App ──────────────────────────────────────────────────────── */
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  // Serve frontend static files from the project root
  app.use(express.static(path.join(__dirname), {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  /* ── Auth Middleware ── */
  function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing token' });
    }
    try {
      req.user = jwt.verify(auth.slice(7), JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  /* ── Routes ── */

  app.get('/api/users/:username', (req, res) => {
    const uname = req.params.username.toLowerCase().trim();
    const row   = queryOne('SELECT username FROM users WHERE username = ?', [uname]);
    res.json({ exists: !!row });
  });

  app.post('/api/register', (req, res) => {
    const { username, hash, salt } = req.body || {};
    if (!username || !hash || !salt) return res.status(400).json({ error: 'Missing fields' });

    const uname = username.toLowerCase().trim();
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) return res.status(400).json({ error: 'Invalid username' });
    if (queryOne('SELECT 1 FROM users WHERE username = ?', [uname])) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    db.run('INSERT INTO users (username, hash, salt, created_at) VALUES (?,?,?,?)',
      [uname, hash, salt, Date.now()]);
    persist();
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const { username, hash } = req.body || {};
    if (!username || !hash) return res.status(400).json({ error: 'Missing fields' });

    const uname = username.toLowerCase().trim();
    const user  = queryOne('SELECT * FROM users WHERE username = ?', [uname]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Constant-time comparison
    const expected = Buffer.from(user.hash);
    const provided  = Buffer.from(hash);
    const match = expected.length === provided.length &&
                  crypto.timingSafeEqual(expected, provided);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    const token = jwt.sign({ username: uname }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: uname });
  });

  app.get('/api/conversations', requireAuth, (req, res) => {
    const me = req.user.username;
    const rows = query(`
      SELECT
        CASE WHEN from_user = ? THEN to_user ELSE from_user END AS partner,
        MAX(ts) AS last_ts
      FROM messages
      WHERE from_user = ? OR to_user = ?
      GROUP BY partner
      ORDER BY last_ts DESC
    `, [me, me, me]);
    res.json(rows);
  });

  app.get('/api/messages/:partner', requireAuth, (req, res) => {
    const me      = req.user.username;
    const partner = req.params.partner.toLowerCase().trim();
    const msgs    = query(`
      SELECT id, from_user, to_user, payload, ts FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY ts ASC
    `, [me, partner, partner, me]);
    res.json(msgs);
  });

  app.post('/api/messages', requireAuth, (req, res) => {
    const me              = req.user.username;
    const { to, payload } = req.body || {};
    if (!to || !payload) return res.status(400).json({ error: 'Missing fields' });

    const toUser = to.toLowerCase().trim();
    if (!queryOne('SELECT 1 FROM users WHERE username = ?', [toUser])) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const msg = {
      id:        crypto.randomUUID(),
      from_user: me,
      to_user:   toUser,
      payload,
      ts:        Date.now(),
    };
    db.run('INSERT INTO messages (id, from_user, to_user, payload, ts) VALUES (?,?,?,?,?)',
      [msg.id, msg.from_user, msg.to_user, msg.payload, msg.ts]);
    persist();

    // Push to recipient via WebSocket if online
    const recipientWs = clients.get(toUser);
    if (recipientWs && recipientWs.readyState === 1) {
      recipientWs.send(JSON.stringify({ type: 'msg', ...msg }));
    }

    res.json(msg);
  });

  /* ─── HTTP + WebSocket Server ──────────────────────────────────────────── */
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✦ NEXUS server running → http://localhost:${PORT}`);
  });

  const wss     = new WebSocketServer({ server });
  const clients = new Map(); // username → WebSocket

  wss.on('connection', (ws) => {
    let authedUser = null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'auth') {
        try {
          const payload = jwt.verify(msg.token, JWT_SECRET);
          authedUser = payload.username;
          clients.set(authedUser, ws);
          ws.send(JSON.stringify({ type: 'auth_ok', username: authedUser }));
          console.log(`[WS] ${authedUser} connected (${clients.size} online)`);
        } catch {
          ws.send(JSON.stringify({ type: 'auth_err', error: 'Invalid token' }));
          ws.close();
        }
      }
    });

    ws.on('close', () => {
      if (authedUser) {
        clients.delete(authedUser);
        console.log(`[WS] ${authedUser} disconnected (${clients.size} online)`);
      }
    });

    ws.on('error', err => console.error('[WS error]', err.message));
  });

  /* ─── Graceful Shutdown ────────────────────────────────────────────────── */
  process.on('SIGTERM', () => {
    console.log('Shutting down…');
    persist();
    server.close(() => { db.close(); process.exit(0); });
  });

}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
