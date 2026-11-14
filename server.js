'use strict';
/**
 * Vibe — месенджер у стилі Telegram.
 * HTTP + Server-Sent Events. Дані зберігаються:
 *   • у PostgreSQL, якщо задано змінну DATABASE_URL (потрібен пакет pg);
 *   • інакше у файлі data.json (лише для локальних тестів).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const MAX_MESSAGES = 5000;            // скільки повідомлень тримаємо в памʼяті
const PER_CHAT = 200;                 // скільки останніх повідомлень чату віддаємо клієнту
const SESSION_TTL = 90 * 864e5;       // вхід діє 90 днів

/* ---------------- дані в памʼяті (кеш над сховищем) ---------------- */
const db = { users: {}, messages: [], reads: {}, sessions: {} };

/* ---------------- сховище: файл ---------------- */
function fileStore() {
  let timer = null;
  function flush() {
    timer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('Не вдалося зберегти файл:', e.message); }
  }
  const save = () => { if (!timer) timer = setTimeout(flush, 400); };
  return {
    name: 'файл data.json',
    async init() {
      try { Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* перший запуск */ }
    },
    userSave: save, sessionPut: save, sessionDel: save, msgAdd: save, msgDel: save, readSet: save,
    async close() { if (timer) clearTimeout(timer); flush(); }
  };
}

/* ---------------- сховище: PostgreSQL ---------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
  color INT NOT NULL DEFAULT 0, created BIGINT NOT NULL, last_seen BIGINT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, t BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
  t BIGINT NOT NULL, reply JSONB
);
CREATE INDEX IF NOT EXISTS messages_t_idx ON messages (t);
CREATE TABLE IF NOT EXISTS reads (
  chat_id TEXT NOT NULL, username TEXT NOT NULL, t BIGINT NOT NULL,
  PRIMARY KEY (chat_id, username)
);`;

function pgStore() {
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch (e) { console.error('Для DATABASE_URL потрібен пакет pg. Виконайте: npm install'); process.exit(1); }
  const noSsl = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL) || process.env.PGSSL === 'disable';
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: noSsl ? false : { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (e) => console.error('Помилка зʼєднання з БД:', e.message));

  // усі записи йдуть по черзі, щоб зберігався порядок
  let queue = Promise.resolve();
  const run = (sql, params) => {
    queue = queue.then(() => pool.query(sql, params)).catch((e) => console.error('Помилка запису в БД:', e.message));
  };

  return {
    name: 'PostgreSQL',
    async init() {
      await pool.query(SCHEMA);
      const u = await pool.query('SELECT key, name, salt, hash, color, created, last_seen, settings FROM users');
      for (const r of u.rows) {
        db.users[r.key] = {
          name: r.name, salt: r.salt, hash: r.hash, color: r.color, created: Number(r.created),
          lastSeen: r.last_seen == null ? null : Number(r.last_seen), settings: r.settings || {}
        };
      }
      const cutoff = Date.now() - SESSION_TTL;
      await pool.query('DELETE FROM sessions WHERE t <= $1', [cutoff]);
      const s = await pool.query('SELECT token_hash, username, t FROM sessions');
      for (const r of s.rows) if (db.users[r.username]) db.sessions[r.token_hash] = { username: r.username, t: Number(r.t) };
      const m = await pool.query('SELECT id, chat_id, sender, text, t, reply FROM messages ORDER BY t DESC LIMIT $1', [MAX_MESSAGES]);
      db.messages = m.rows.reverse().map((r) => {
        const o = { id: r.id, chatId: r.chat_id, from: r.sender, text: r.text, t: Number(r.t) };
        if (r.reply) o.reply = r.reply;
        return o;
      });
      const rd = await pool.query('SELECT chat_id, username, t FROM reads');
      for (const r of rd.rows) { (db.reads[r.chat_id] = db.reads[r.chat_id] || {})[r.username] = Number(r.t); }
    },
    userSave(key) {
      const u = db.users[key];
      if (!u) return;
      run('INSERT INTO users (key, name, salt, hash, color, created, last_seen, settings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
          'ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, salt = EXCLUDED.salt, hash = EXCLUDED.hash, ' +
          'color = EXCLUDED.color, last_seen = EXCLUDED.last_seen, settings = EXCLUDED.settings',
          [key, u.name, u.salt, u.hash, u.color, u.created, u.lastSeen || null, JSON.stringify(u.settings || {})]);
    },
    sessionPut(hash, s) {
      run('INSERT INTO sessions (token_hash, username, t) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO UPDATE SET t = EXCLUDED.t',
          [hash, s.username, s.t]);
    },
    sessionDel(hash) { run('DELETE FROM sessions WHERE token_hash = $1', [hash]); },
    msgAdd(m) {
      run('INSERT INTO messages (id, chat_id, sender, text, t, reply) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
          [m.id, m.chatId, m.from, m.text, m.t, m.reply ? JSON.stringify(m.reply) : null]);
    },
    msgDel(id) { run('DELETE FROM messages WHERE id = $1', [id]); },
    readSet(chatId, user, t) {
      run('INSERT INTO reads (chat_id, username, t) VALUES ($1,$2,$3) ON CONFLICT (chat_id, username) DO UPDATE SET t = EXCLUDED.t',
          [chatId, user, t]);
    },
    async close() { try { await queue; await pool.end(); } catch (e) { /* ignore */ } }
  };
}

const store = DATABASE_URL ? pgStore() : fileStore();

/* ---------------- допоміжне ---------------- */
const conns = new Map(); // username -> Set(res) відкритих SSE-зʼєднань
const USERNAME_RE = /^[\p{L}\p{N}_.]{3,20}$/u;

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(8).toString('hex');

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function checkPassword(user, password) {
  const a = Buffer.from(hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(key) {
  const u = db.users[key];
  return { username: key, name: u.name, color: u.color, online: conns.has(key), lastSeen: u.lastSeen || null };
}
function allUsers() { return Object.keys(db.users).map(publicUser); }

function makeSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const h = sha(token);
  db.sessions[h] = { username, t: Date.now() };
  store.sessionPut(h, db.sessions[h]);
  return token;
}
function tokenFrom(req, url) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('token') || '';
}
function authUser(req, url) {
  const t = tokenFrom(req, url);
  if (!t) return null;
  const h = sha(t);
  const s = db.sessions[h];
  if (!s || !db.users[s.username]) return null;
  if (Date.now() - s.t > SESSION_TTL) { delete db.sessions[h]; store.sessionDel(h); return null; }
  return s.username;
}

/* обмеження частоти запитів */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (n > b.reset) buckets.delete(k); }, 60000).unref();
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'ip';
}

/* шпалери: перевірка того, що прислав клієнт */
function cleanWallpaper(w) {
  if (!w || typeof w !== 'object') return null;
  const kinds = ['default', 'preset', 'image', 'color'];
  const kind = kinds.includes(w.kind) ? w.kind : 'default';
  const out = { kind, id: '', value: '', dim: 0, blur: 0 };
  out.dim = Math.max(0, Math.min(70, Math.round(Number(w.dim) || 0)));
  out.blur = Math.max(0, Math.min(12, Math.round(Number(w.blur) || 0)));
  if (kind === 'preset') {
    out.id = String(w.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
    if (!out.id) out.kind = 'default';
  } else if (kind === 'color') {
    if (/^#[0-9a-fA-F]{6}$/.test(String(w.value))) out.value = String(w.value);
    else out.kind = 'default';
  } else if (kind === 'image') {
    const v = String(w.value || '');
    if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 450000) out.value = v;
    else out.kind = 'default';
  }
  return out;
}

/* ---------------- чати ---------------- */
function chatMembers(chatId) {
  if (chatId === 'general') return Object.keys(db.users);
  const m = /^dm:([^|]+)\|([^|]+)$/.exec(chatId);
  return m ? [m[1], m[2]] : null;
}
function canUse(chatId, me) {
  if (chatId === 'general') return true;
  const m = /^dm:([^|]+)\|([^|]+)$/.exec(chatId);
  if (!m || m[1] >= m[2]) return false;
  if (!db.users[m[1]] || !db.users[m[2]]) return false;
  return m[1] === me || m[2] === me;
}

/* ---------------- SSE ---------------- */
function sse(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function broadcast(names, event, data) {
  for (const n of names) {
    const set = conns.get(n);
    if (set) for (const res of set) sse(res, event, data);
  }
}
setInterval(() => { for (const set of conns.values()) for (const res of set) res.write(': ping\n\n'); }, 25000).unref();

/* ---------------- маршрути API ---------------- */
async function api(req, res, url) {
  const route = url.pathname;

  if (route === '/api/stream' && req.method === 'GET') {
    const me = authUser(req, url);
    if (!me) return json(res, 401, { error: 'Потрібен вхід' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    let set = conns.get(me);
    const first = !set;
    if (!set) { set = new Set(); conns.set(me, set); }
    set.add(res);
    if (first) broadcast(Object.keys(db.users), 'presence', { username: me, online: true });
    req.on('close', () => {
      set.delete(res);
      if (!set.size) {
        conns.delete(me);
        db.users[me].lastSeen = Date.now();
        store.userSave(me);
        broadcast(Object.keys(db.users), 'presence', { username: me, online: false, lastSeen: db.users[me].lastSeen });
      }
    });
    return;
  }

  if (route === '/api/register' || route === '/api/login') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Метод не підтримується' });
    if (limited('auth:' + clientIp(req), 30, 10 * 60 * 1000)) return json(res, 429, { error: 'Забагато спроб, зачекайте кілька хвилин' });
    const body = await readBody(req, 30000);
    const name = String(body.username || '').trim();
    const password = String(body.password || '');
    const key = name.toLowerCase();
    if (route === '/api/register') {
      if (!USERNAME_RE.test(name)) return json(res, 400, { error: 'Імʼя: 3–20 символів, літери, цифри, _ або .' });
      if (password.length < 6 || password.length > 100) return json(res, 400, { error: 'Пароль має містити від 6 символів' });
      if (db.users[key]) return json(res, 409, { error: 'Це імʼя вже зайняте. Якщо це ваш акаунт, оберіть «Вхід»' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[key] = { name, salt, hash: hashPassword(password, salt), color: crypto.randomInt(0, 7), created: Date.now(), settings: {} };
      store.userSave(key);
      broadcast(Object.keys(db.users), 'user', publicUser(key));
      return json(res, 200, { token: makeSession(key), me: publicUser(key) });
    }
    const user = db.users[key];
    if (!user || !checkPassword(user, password)) return json(res, 401, { error: 'Невірне імʼя або пароль' });
    return json(res, 200, { token: makeSession(key), me: publicUser(key) });
  }

  const me = authUser(req, url);
  if (!me) return json(res, 401, { error: 'Потрібен вхід' });

  if (route === '/api/logout' && req.method === 'POST') {
    const h = sha(tokenFrom(req, url));
    delete db.sessions[h];
    store.sessionDel(h);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/state' && req.method === 'GET') {
    const perChat = {};
    const out = [];
    for (let i = db.messages.length - 1; i >= 0; i--) {
      const m = db.messages[i];
      if (!canUse(m.chatId, me)) continue;
      perChat[m.chatId] = (perChat[m.chatId] || 0) + 1;
      if (perChat[m.chatId] <= PER_CHAT) out.push(m);
    }
    out.reverse();
    const reads = {};
    for (const c of Object.keys(db.reads)) if (canUse(c, me)) reads[c] = db.reads[c];
    return json(res, 200, {
      me: publicUser(me), users: allUsers(), messages: out, reads,
      settings: db.users[me].settings || {}, now: Date.now()
    });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'Не знайдено' });
  const body = await readBody(req, route === '/api/settings' ? 600000 : 30000);

  if (route === '/api/settings') {
    if (limited('set:' + me, 30, 60000)) return json(res, 429, { error: 'Занадто часто' });
    const wp = cleanWallpaper(body.wallpaper);
    if (!wp) return json(res, 400, { error: 'Некоректні налаштування' });
    db.users[me].settings = Object.assign({}, db.users[me].settings, { wallpaper: wp });
    store.userSave(me);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/send') {
    if (limited('send:' + me, 20, 10000)) return json(res, 429, { error: 'Занадто швидко' });
    const chatId = String(body.chatId || '');
    if (!canUse(chatId, me)) return json(res, 400, { error: 'Чат недоступний' });
    const text = String(body.text || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    if (!text) return json(res, 400, { error: 'Порожнє повідомлення' });
    const msg = { id: rid(), chatId, from: me, text, t: Date.now() };
    if (body.reply && typeof body.reply === 'object') {
      msg.reply = { name: String(body.reply.name || '').slice(0, 60), text: String(body.reply.text || '').slice(0, 120) };
    }
    db.messages.push(msg);
    if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
    (db.reads[chatId] = db.reads[chatId] || {})[me] = msg.t;
    store.msgAdd(msg);
    store.readSet(chatId, me, msg.t);
    broadcast(chatMembers(chatId), 'msg', msg);
    return json(res, 200, { message: msg });
  }

  if (route === '/api/delete') {
    const id = String(body.id || '');
    const i = db.messages.findIndex((m) => m.id === id);
    if (i < 0) return json(res, 404, { error: 'Не знайдено' });
    const m = db.messages[i];
    if (m.from !== me) return json(res, 403, { error: 'Можна видаляти лише свої повідомлення' });
    db.messages.splice(i, 1);
    store.msgDel(m.id);
    broadcast(chatMembers(m.chatId), 'del', { id: m.id, chatId: m.chatId });
    return json(res, 200, { ok: true });
  }

  if (route === '/api/read') {
    const chatId = String(body.chatId || '');
    if (!canUse(chatId, me)) return json(res, 400, { error: 'Чат недоступний' });
    const t = Date.now();
    (db.reads[chatId] = db.reads[chatId] || {})[me] = t;
    store.readSet(chatId, me, t);
    broadcast(chatMembers(chatId), 'read', { chatId, user: me, t });
    return json(res, 200, { t });
  }

  if (route === '/api/typing') {
    const chatId = String(body.chatId || '');
    if (!canUse(chatId, me)) return json(res, 400, { error: 'Чат недоступний' });
    broadcast(chatMembers(chatId).filter((n) => n !== me), 'typing', { chatId, user: me });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Не знайдено' });
}

/* ---------------- HTTP ---------------- */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(INDEX_FILE, (err, buf) => {
        if (err) { res.writeHead(500); return res.end('index.html не знайдено'); }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer'
        });
        res.end(buf);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Сторінку не знайдено');
  } catch (e) {
    if (res.headersSent) return res.end();
    const code = e.message === 'too_large' ? 413 : e.message === 'bad_json' ? 400 : 500;
    json(res, code, { error: code === 500 ? 'Помилка сервера' : 'Некоректний запит' });
    if (code === 500) console.error(e);
  }
});

['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, async () => { await store.close(); process.exit(0); }));

store.init().then(() => {
  server.listen(PORT, () => console.log('Vibe працює на порту ' + PORT + '. Сховище: ' + store.name +
    '. Користувачів: ' + Object.keys(db.users).length + ', повідомлень: ' + db.messages.length));
}).catch((e) => {
  console.error('Не вдалося підключитися до сховища:', e.message);
  process.exit(1);
});
