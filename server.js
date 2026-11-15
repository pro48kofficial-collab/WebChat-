'use strict';
/**
 * Vibe — месенджер у стилі Telegram.
 * HTTP + Server-Sent Events. Дані зберігаються:
 *   • у PostgreSQL, якщо задано змінну DATABASE_URL (потрібен пакет pg);
 *   • інакше у файлах (data.json і папка media) — лише для локальних тестів.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const INDEX_FILE = path.join(__dirname, 'index.html');
const MAX_MESSAGES = 5000;            // скільки повідомлень тримаємо в памʼяті
const PER_CHAT = 200;                 // скільки останніх повідомлень чату віддаємо клієнту
const SESSION_TTL = 90 * 864e5;       // вхід діє 90 днів
const MB = 1024 * 1024;
const LIMITS = { image: 8 * MB, video: 25 * MB, audio: 10 * MB };
const MEDIA_TOTAL = (Number(process.env.MAX_MEDIA_MB) || 500) * MB;   // загальний ліміт сховища медіа
const REACTIONS = ['❤️', '👍', '🔥', '😂', '😮', '😢', '🎉', '👎'];

/* ---------------- дані в памʼяті (кеш над сховищем) ---------------- */
const db = { users: {}, messages: [], reads: {}, sessions: {}, rooms: {}, media: {} };

/* ---------------- сховище: файли ---------------- */
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
  const mfile = (id) => path.join(MEDIA_DIR, id);
  return {
    name: 'файли (data.json + media)',
    persistent: false,
    async init() {
      try { Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* перший запуск */ }
      db.rooms = db.rooms || {}; db.media = db.media || {};
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
    },
    userSave: save, sessionPut: save, sessionDel: save, msgAdd: save, msgDel: save, msgReact: save,
    readSet: save, roomSave: save, roomDel: save, mediaAttach: save,
    async mediaPut(id, meta, buf) { await fs.promises.writeFile(mfile(id), buf); save(); },
    async mediaGet(id) { try { return await fs.promises.readFile(mfile(id)); } catch (e) { return null; } },
    mediaDel(id) { fs.unlink(mfile(id), () => {}); save(); },
    chatDel(chatId, mediaIds) { mediaIds.forEach((id) => fs.unlink(mfile(id), () => {})); save(); },
    async close() { if (timer) clearTimeout(timer); flush(); }
  };
}

/* ---------------- сховище: PostgreSQL ---------------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    color INT NOT NULL DEFAULT 0, created BIGINT NOT NULL, last_seen BIGINT,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, t BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
    t BIGINT NOT NULL, reply JSONB)`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS media JSONB`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB`,
  `CREATE INDEX IF NOT EXISTS messages_t_idx ON messages (t)`,
  `CREATE TABLE IF NOT EXISTS reads (
    chat_id TEXT NOT NULL, username TEXT NOT NULL, t BIGINT NOT NULL, PRIMARY KEY (chat_id, username))`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    is_public BOOLEAN NOT NULL DEFAULT false, handle TEXT, invite TEXT, owner TEXT,
    color INT NOT NULL DEFAULT 0, created BIGINT NOT NULL, members JSONB NOT NULL DEFAULT '[]'::jsonb)`,
  `CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, owner TEXT NOT NULL, mime TEXT NOT NULL,
    size INT NOT NULL, t BIGINT NOT NULL, attached BOOLEAN NOT NULL DEFAULT false, data BYTEA NOT NULL)`
];

function pgStore() {
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch (e) { console.error('Для DATABASE_URL потрібен пакет pg. Виконайте: npm install'); process.exit(1); }
  const noSsl = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL) || process.env.PGSSL === 'disable';
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: noSsl ? false : { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (e) => console.error('Помилка зʼєднання з БД:', e.message));

  // усі записи йдуть по черзі, щоб зберігався порядок
  let queue = Promise.resolve();
  const runP = (sql, params) => {
    const p = queue.then(() => pool.query(sql, params));
    queue = p.catch(() => {});
    return p;
  };
  const run = (sql, params) => { runP(sql, params).catch((e) => console.error('Помилка запису в БД:', e.message)); };
  const J = (v) => (v == null ? null : JSON.stringify(v));

  return {
    name: 'PostgreSQL',
    persistent: true,
    async init() {
      for (const s of SCHEMA) await pool.query(s);
      const u = await pool.query('SELECT key, name, salt, hash, color, created, last_seen, settings, profile FROM users');
      for (const r of u.rows) {
        db.users[r.key] = {
          name: r.name, salt: r.salt, hash: r.hash, color: r.color, created: Number(r.created),
          lastSeen: r.last_seen == null ? null : Number(r.last_seen), settings: r.settings || {}, profile: r.profile || {}
        };
      }
      await pool.query('DELETE FROM sessions WHERE t <= $1', [Date.now() - SESSION_TTL]);
      const s = await pool.query('SELECT token_hash, username, t FROM sessions');
      for (const r of s.rows) if (db.users[r.username]) db.sessions[r.token_hash] = { username: r.username, t: Number(r.t) };
      const m = await pool.query('SELECT id, chat_id, sender, text, t, reply, media, reactions FROM messages ORDER BY t DESC LIMIT $1', [MAX_MESSAGES]);
      db.messages = m.rows.reverse().map((r) => {
        const o = { id: r.id, chatId: r.chat_id, from: r.sender, text: r.text, t: Number(r.t) };
        if (r.reply) o.reply = r.reply;
        if (r.media) o.media = r.media;
        if (r.reactions) o.reactions = r.reactions;
        return o;
      });
      const rd = await pool.query('SELECT chat_id, username, t FROM reads');
      for (const r of rd.rows) { (db.reads[r.chat_id] = db.reads[r.chat_id] || {})[r.username] = Number(r.t); }
      const rm = await pool.query('SELECT id, type, title, description, is_public, handle, invite, owner, color, created, members FROM rooms');
      for (const r of rm.rows) {
        db.rooms[r.id] = { id: r.id, type: r.type, title: r.title, description: r.description, isPublic: r.is_public,
          handle: r.handle || '', invite: r.invite || '', owner: r.owner, color: r.color, created: Number(r.created), members: r.members || [] };
      }
      const md = await pool.query('SELECT id, chat_id, owner, mime, size, t, attached FROM media');
      for (const r of md.rows) db.media[r.id] = { chatId: r.chat_id, owner: r.owner, mime: r.mime, size: r.size, t: Number(r.t), attached: r.attached };
    },
    userSave(key) {
      const u = db.users[key];
      if (!u) return;
      run('INSERT INTO users (key, name, salt, hash, color, created, last_seen, settings, profile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ' +
          'ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, salt = EXCLUDED.salt, hash = EXCLUDED.hash, ' +
          'color = EXCLUDED.color, last_seen = EXCLUDED.last_seen, settings = EXCLUDED.settings, profile = EXCLUDED.profile',
          [key, u.name, u.salt, u.hash, u.color, u.created, u.lastSeen || null, J(u.settings || {}), J(u.profile || {})]);
    },
    sessionPut(hash, s) {
      run('INSERT INTO sessions (token_hash, username, t) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO UPDATE SET t = EXCLUDED.t',
          [hash, s.username, s.t]);
    },
    sessionDel(hash) { run('DELETE FROM sessions WHERE token_hash = $1', [hash]); },
    msgAdd(m) {
      run('INSERT INTO messages (id, chat_id, sender, text, t, reply, media, reactions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
          [m.id, m.chatId, m.from, m.text, m.t, J(m.reply), J(m.media), J(m.reactions)]);
    },
    msgDel(id) { run('DELETE FROM messages WHERE id = $1', [id]); },
    msgReact(id, reactions) { run('UPDATE messages SET reactions = $2 WHERE id = $1', [id, J(reactions)]); },
    readSet(chatId, user, t) {
      run('INSERT INTO reads (chat_id, username, t) VALUES ($1,$2,$3) ON CONFLICT (chat_id, username) DO UPDATE SET t = EXCLUDED.t',
          [chatId, user, t]);
    },
    roomSave(id) {
      const r = db.rooms[id];
      if (!r) return;
      run('INSERT INTO rooms (id, type, title, description, is_public, handle, invite, owner, color, created, members) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ' +
          'ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, title = EXCLUDED.title, description = EXCLUDED.description, ' +
          'is_public = EXCLUDED.is_public, handle = EXCLUDED.handle, invite = EXCLUDED.invite, owner = EXCLUDED.owner, ' +
          'color = EXCLUDED.color, members = EXCLUDED.members',
          [r.id, r.type, r.title, r.description, !!r.isPublic, r.handle || null, r.invite || null, r.owner || null, r.color, r.created, J(r.members)]);
    },
    roomDel(id) { run('DELETE FROM rooms WHERE id = $1', [id]); },
    async mediaPut(id, meta, buf) {
      await runP('INSERT INTO media (id, chat_id, owner, mime, size, t, attached, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                 [id, meta.chatId, meta.owner, meta.mime, meta.size, meta.t, !!meta.attached, buf]);
    },
    async mediaGet(id) {
      const r = await runP('SELECT data FROM media WHERE id = $1', [id]);
      return r.rows[0] ? r.rows[0].data : null;
    },
    mediaAttach(id) { run('UPDATE media SET attached = true WHERE id = $1', [id]); },
    mediaDel(id) { run('DELETE FROM media WHERE id = $1', [id]); },
    chatDel(chatId) {
      run('DELETE FROM messages WHERE chat_id = $1', [chatId]);
      run('DELETE FROM media WHERE chat_id = $1', [chatId]);
      run('DELETE FROM reads WHERE chat_id = $1', [chatId]);
    },
    async close() { try { await queue; await pool.end(); } catch (e) { /* ignore */ } }
  };
}

const store = DATABASE_URL ? pgStore() : fileStore();

/* ---------------- допоміжне ---------------- */
const conns = new Map(); // username -> Set(res) відкритих SSE-зʼєднань
const USERNAME_RE = /^[\p{L}\p{N}_.]{3,20}$/u;
const HANDLE_RE = /^[a-z][a-z0-9_]{3,23}$/;

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj));
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readBody(req, limit) {
  const buf = await readRaw(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error('bad_json'); }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(8).toString('hex');
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function checkPassword(user, password) {
  const a = Buffer.from(hashPassword(password, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(key) {
  const u = db.users[key];
  const p = u.profile || {};
  return {
    username: key, name: u.name, color: u.color, online: conns.has(key), lastSeen: u.lastSeen || null,
    bio: p.bio || '', avatar: p.avatar || '', music: p.music || null, joined: u.created
  };
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

/* ---------------- медіа ---------------- */
const ftyp = (b) => b.length > 12 && ['ftyp', 'moov', 'free', 'mdat', 'wide', 'skip'].includes(b.slice(4, 8).toString('latin1'));
const ebml = (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
const MIME = {
  'image/jpeg': { kind: 'image', sniff: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { kind: 'image', sniff: (b) => b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/gif': { kind: 'image', sniff: (b) => b.length > 4 && b.slice(0, 4).toString('latin1') === 'GIF8' },
  'image/webp': { kind: 'image', sniff: (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  'video/mp4': { kind: 'video', sniff: ftyp },
  'video/quicktime': { kind: 'video', sniff: ftyp },
  'video/webm': { kind: 'video', sniff: ebml },
  'audio/mpeg': { kind: 'audio', sniff: (b) => b.length > 3 && (b.slice(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  'audio/mp4': { kind: 'audio', sniff: ftyp },
  'audio/x-m4a': { kind: 'audio', sniff: ftyp },
  'audio/aac': { kind: 'audio', sniff: (b) => b.length > 3 && ((b[0] === 0xff && (b[1] & 0xf0) === 0xf0) || ftyp(b)) },
  'audio/ogg': { kind: 'audio', sniff: (b) => b.length > 4 && b.slice(0, 4).toString('latin1') === 'OggS' },
  'audio/wav': { kind: 'audio', sniff: (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE' },
  'audio/webm': { kind: 'audio', sniff: ebml }
};
MIME['audio/x-wav'] = MIME['audio/wav']; MIME['audio/wave'] = MIME['audio/wav'];

function mediaTotal() { let n = 0; for (const k in db.media) n += db.media[k].size; return n; }
function dropMedia(id) {
  if (!db.media[id]) return;
  delete db.media[id];
  store.mediaDel(id);
}
// видаляємо завантажені, але нікуди не прикріплені файли старше години
function gcMedia() {
  const cut = Date.now() - 3600000;
  for (const id of Object.keys(db.media)) {
    const m = db.media[id];
    if (!m.attached && m.t < cut) dropMedia(id);
  }
}
setInterval(gcMedia, 3600000).unref();

function canPost(chatId, me) {
  const r = db.rooms[chatId];
  if (r && r.type === 'channel' && r.owner !== me) return false;
  return true;
}

async function uploadMedia(req, res, url, me) {
  if (limited('up:' + me, 12, 60000)) return json(res, 429, { error: 'Забагато завантажень, зачекайте хвилину' });
  const kind = url.searchParams.get('kind') || '';
  const chatId = url.searchParams.get('chatId') || '';
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const spec = MIME[mime];
  if (!spec || spec.kind !== kind) return json(res, 415, { error: 'Цей тип файлу не підтримується' });
  if (kind === 'audio') {
    if (chatId !== 'profile:' + me) return json(res, 400, { error: 'Музику можна додати лише до профілю' });
  } else {
    if (!canUse(chatId, me)) return json(res, 400, { error: 'Чат недоступний' });
    if (!canPost(chatId, me)) return json(res, 403, { error: 'Лише власник може публікувати в цьому каналі' });
  }
  const max = LIMITS[kind];
  const len = Number(req.headers['content-length']) || 0;
  if (len > max) return json(res, 413, { error: 'Файл завеликий (ліміт ' + Math.round(max / MB) + ' МБ)' });
  if (mediaTotal() + len > MEDIA_TOTAL) return json(res, 507, { error: 'Сховище медіа заповнене' });
  const buf = await readRaw(req, max);
  if (!buf.length || !spec.sniff(buf)) return json(res, 415, { error: 'Файл пошкоджений або має невірний формат' });
  const id = rid() + rid();
  const meta = { chatId, owner: me, mime, size: buf.length, t: Date.now(), attached: false };
  await store.mediaPut(id, meta, buf);
  db.media[id] = meta;
  return json(res, 200, { id, size: buf.length });
}

async function sendMedia(req, res, url, me) {
  const id = url.pathname.slice('/api/media/'.length);
  const meta = db.media[id];
  if (!meta) return json(res, 404, { error: 'Файл не знайдено' });
  const ok = meta.chatId.startsWith('profile:') ? true : canUse(meta.chatId, me);
  if (!ok) return json(res, 403, { error: 'Немає доступу' });
  const buf = await store.mediaGet(id);
  if (!buf) return json(res, 404, { error: 'Файл не знайдено' });
  res.writeHead(200, {
    'Content-Type': meta.mime,
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  });
  res.end(buf);
}

/* ---------------- чати та кімнати ---------------- */
const DM_RE = /^dm:([^|]+)\|([^|]+)$/;
function chatMembers(chatId) {
  const r = db.rooms[chatId];
  if (r) return r.members.slice();
  const m = DM_RE.exec(chatId);
  return m ? [m[1], m[2]] : null;
}
function canUse(chatId, me) {
  const r = db.rooms[chatId];
  if (r) return r.members.includes(me);
  const m = DM_RE.exec(chatId);
  if (!m || m[1] >= m[2]) return false;
  if (!db.users[m[1]] || !db.users[m[2]]) return false;
  return m[1] === me || m[2] === me;
}
function roomView(r, me) {
  const o = {
    id: r.id, type: r.type, title: r.title, description: r.description, isPublic: !!r.isPublic,
    handle: r.handle || '', color: r.color, owner: r.owner, count: r.members.length, created: r.created
  };
  if (r.members.includes(me)) o.members = r.members;
  if (r.owner === me) o.invite = r.invite;
  return o;
}
function pushRoom(r) { for (const n of r.members) broadcast([n], 'room', roomView(r, n)); }
function ensureGeneral() {
  let g = db.rooms.general, changed = false;
  if (!g) {
    g = db.rooms.general = { id: 'general', type: 'group', title: 'Загальний чат', description: 'Спільний чат для всіх користувачів Vibe',
      isPublic: true, handle: 'general', invite: '', owner: null, color: 3, created: Date.now(), members: [] };
    changed = true;
  }
  for (const k of Object.keys(db.users)) if (!g.members.includes(k)) { g.members.push(k); changed = true; }
  if (changed) store.roomSave('general');
}
function newInvite() { return crypto.randomBytes(9).toString('base64url'); }
function findByInvite(code) {
  code = String(code || '').trim();
  if (code.startsWith('@')) {
    const h = code.slice(1).toLowerCase();
    return Object.values(db.rooms).find((r) => r.isPublic && r.handle === h) || null;
  }
  if (!code) return null;
  return Object.values(db.rooms).find((r) => r.invite && r.invite === code) || null;
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

  if (route === '/api/info' && req.method === 'GET') {
    return json(res, 200, { persistent: !!store.persistent, storage: store.name });
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
      db.users[key] = { name, salt, hash: hashPassword(password, salt), color: crypto.randomInt(0, 7), created: Date.now(), settings: {}, profile: {} };
      store.userSave(key);
      ensureGeneral();
      broadcast(Object.keys(db.users), 'user', publicUser(key));
      pushRoom(db.rooms.general);
      return json(res, 200, { token: makeSession(key), me: publicUser(key) });
    }
    const user = db.users[key];
    if (!user) {
      return json(res, 401, { code: 'no_user', error: store.persistent
        ? 'Акаунт з таким імʼям не знайдено. Перевірте імʼя або зареєструйтесь'
        : 'Акаунт не знайдено. Сервер працює без бази даних, тому після «сну» Render усі акаунти стираються. Підключіть DATABASE_URL (див. README)' });
    }
    if (!checkPassword(user, password)) return json(res, 401, { code: 'bad_pass', error: 'Невірний пароль' });
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

  /* ---- завантаження та віддача медіа ---- */
  if (route === '/api/media' && req.method === 'POST') return uploadMedia(req, res, url, me);
  if (route.startsWith('/api/media/') && req.method === 'GET') return sendMedia(req, res, url, me);

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
    const rooms = Object.values(db.rooms).filter((r) => r.members.includes(me)).map((r) => roomView(r, me));
    return json(res, 200, {
      me: publicUser(me), users: allUsers(), rooms, messages: out, reads,
      settings: db.users[me].settings || {}, now: Date.now()
    });
  }

  /* ---- пошук і перегляд кімнат ---- */
  if (route === '/api/room/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '');
    const list = Object.values(db.rooms).filter((r) => r.isPublic && (!q || r.title.toLowerCase().includes(q) || (r.handle || '').includes(q)))
      .sort((a, b) => b.members.length - a.members.length).slice(0, 20)
      .map((r) => ({ id: r.id, type: r.type, title: r.title, description: r.description, handle: r.handle, count: r.members.length, color: r.color, joined: r.members.includes(me) }));
    return json(res, 200, { rooms: list });
  }
  if (route === '/api/room/preview' && req.method === 'GET') {
    const r = findByInvite(url.searchParams.get('code'));
    if (!r) return json(res, 404, { error: 'Запрошення недійсне або застаріле' });
    return json(res, 200, { room: { id: r.id, type: r.type, title: r.title, description: r.description, isPublic: !!r.isPublic,
      handle: r.handle, count: r.members.length, color: r.color, joined: r.members.includes(me) } });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'Не знайдено' });
  const body = await readBody(req, route === '/api/settings' ? 600000 : 40000);

  if (route === '/api/room/create') {
    if (limited('room:' + me, 10, 3600000)) return json(res, 429, { error: 'Забагато нових чатів за годину' });
    const type = body.type === 'channel' ? 'channel' : 'group';
    const title = cleanText(body.title, 40).trim();
    if (title.length < 2) return json(res, 400, { error: 'Назва має містити від 2 символів' });
    const isPublic = !!body.isPublic;
    let handle = '';
    if (isPublic) {
      handle = String(body.handle || '').trim().toLowerCase().replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) return json(res, 400, { error: 'Публічне посилання: 4–24 символи, лише a–z, 0–9 та _, починається з літери' });
      if (Object.values(db.rooms).some((r) => r.handle === handle)) return json(res, 409, { error: 'Це посилання вже зайняте' });
    }
    const r = { id: 'r_' + rid(), type, title, description: cleanText(body.description, 200).trim(), isPublic, handle,
      invite: newInvite(), owner: me, color: crypto.randomInt(0, 7), created: Date.now(), members: [me] };
    db.rooms[r.id] = r;
    store.roomSave(r.id);
    return json(res, 200, { room: roomView(r, me) });
  }

  if (route === '/api/room/join') {
    let r = null;
    if (body.id) { r = db.rooms[String(body.id)]; if (r && !r.isPublic) r = null; }
    else r = findByInvite(body.code);
    if (!r) return json(res, 404, { error: 'Чат не знайдено або запрошення недійсне' });
    if (!r.members.includes(me)) {
      r.members.push(me);
      store.roomSave(r.id);
      pushRoom(r);
    }
    return json(res, 200, { room: roomView(r, me) });
  }

  if (route === '/api/room/leave') {
    const r = db.rooms[String(body.id || '')];
    if (!r || !r.members.includes(me)) return json(res, 404, { error: 'Чат не знайдено' });
    if (r.owner === me) return json(res, 400, { error: 'Власник не може вийти. Видаліть чат, якщо він більше не потрібен' });
    r.members = r.members.filter((n) => n !== me);
    store.roomSave(r.id);
    broadcast([me], 'roomdel', { id: r.id });
    pushRoom(r);
    return json(res, 200, { ok: true });
  }

  if (route === '/api/room/update') {
    const r = db.rooms[String(body.id || '')];
    if (!r || r.owner !== me) return json(res, 403, { error: 'Лише власник може змінювати чат' });
    const title = cleanText(body.title, 40).trim();
    if (title.length < 2) return json(res, 400, { error: 'Назва має містити від 2 символів' });
    r.title = title;
    r.description = cleanText(body.description, 200).trim();
    store.roomSave(r.id);
    pushRoom(r);
    return json(res, 200, { room: roomView(r, me) });
  }

  if (route === '/api/room/invite') {
    const r = db.rooms[String(body.id || '')];
    if (!r || r.owner !== me) return json(res, 403, { error: 'Лише власник може створювати запрошення' });
    r.invite = newInvite();
    store.roomSave(r.id);
    return json(res, 200, { room: roomView(r, me) });
  }

  if (route === '/api/room/delete') {
    const r = db.rooms[String(body.id || '')];
    if (!r || r.owner !== me) return json(res, 403, { error: 'Лише власник може видалити чат' });
    const members = r.members.slice();
    const mediaIds = Object.keys(db.media).filter((id) => db.media[id].chatId === r.id);
    mediaIds.forEach((id) => delete db.media[id]);
    db.messages = db.messages.filter((m) => m.chatId !== r.id);
    delete db.reads[r.id];
    delete db.rooms[r.id];
    store.roomDel(r.id);
    store.chatDel(r.id, mediaIds);
    broadcast(members, 'roomdel', { id: r.id });
    return json(res, 200, { ok: true });
  }

  /* ---- профіль ---- */
  if (route === '/api/profile') {
    const u = db.users[me];
    u.profile = u.profile || {};
    if (body.name !== undefined) {
      const name = cleanText(body.name, 30).trim();
      if (name.length < 1) return json(res, 400, { error: 'Імʼя не може бути порожнім' });
      u.name = name;
    }
    if (body.bio !== undefined) u.profile.bio = cleanText(body.bio, 200).trim();
    if (body.avatar !== undefined) {
      if (body.avatar === null || body.avatar === '') u.profile.avatar = '';
      else if (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(body.avatar)) && String(body.avatar).length <= 30000) u.profile.avatar = String(body.avatar);
      else return json(res, 400, { error: 'Некоректне фото профілю' });
    }
    if (body.music !== undefined) {
      const old = u.profile.music;
      if (body.music === null) {
        if (old) dropMedia(old.mediaId);
        u.profile.music = null;
      } else {
        const mm = db.media[String(body.music.mediaId || '')];
        if (!mm || mm.owner !== me || mm.chatId !== 'profile:' + me || MIME[mm.mime].kind !== 'audio') return json(res, 400, { error: 'Файл музики не знайдено' });
        if (!mm.attached) { mm.attached = true; store.mediaAttach(String(body.music.mediaId)); }
        if (old && old.mediaId !== body.music.mediaId) dropMedia(old.mediaId);
        u.profile.music = { mediaId: String(body.music.mediaId), title: cleanText(body.music.title, 60).trim() || 'Без назви',
          artist: cleanText(body.music.artist, 60).trim(), mime: mm.mime, size: mm.size };
      }
    }
    store.userSave(me);
    const pu = publicUser(me);
    broadcast(Object.keys(db.users), 'user', pu);
    return json(res, 200, { me: pu });
  }

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
    if (!canPost(chatId, me)) return json(res, 403, { error: 'Лише власник може публікувати в цьому каналі' });
    const text = String(body.text || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    let media = null;
    if (body.media && typeof body.media === 'object') {
      const mid = String(body.media.id || '');
      const mm = db.media[mid];
      if (!mm || mm.owner !== me || mm.chatId !== chatId || mm.attached) return json(res, 400, { error: 'Файл не знайдено, завантажте його ще раз' });
      const kind = MIME[mm.mime].kind;
      if (kind === 'audio') return json(res, 400, { error: 'Некоректне вкладення' });
      const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
      const th = String(body.media.thumb || '');
      media = { id: mid, kind, mime: mm.mime, size: mm.size, w: num(body.media.w, 0, 12000), h: num(body.media.h, 0, 12000),
        dur: kind === 'video' ? num(body.media.dur, 0, 86400) : 0,
        thumb: /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1,4000}$/.test(th) ? th : '' };
      mm.attached = true;
      store.mediaAttach(mid);
    }
    if (!text && !media) return json(res, 400, { error: 'Порожнє повідомлення' });
    const msg = { id: rid(), chatId, from: me, text, t: Date.now() };
    if (media) msg.media = media;
    if (body.reply && typeof body.reply === 'object') {
      msg.reply = { name: cleanText(body.reply.name, 60), text: cleanText(body.reply.text, 120) };
    }
    db.messages.push(msg);
    if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
    (db.reads[chatId] = db.reads[chatId] || {})[me] = msg.t;
    store.msgAdd(msg);
    store.readSet(chatId, me, msg.t);
    broadcast(chatMembers(chatId), 'msg', msg);
    return json(res, 200, { message: msg });
  }

  if (route === '/api/react') {
    if (limited('react:' + me, 60, 60000)) return json(res, 429, { error: 'Занадто часто' });
    const m = db.messages.find((x) => x.id === String(body.id || ''));
    const emoji = String(body.emoji || '');
    if (!m || !canUse(m.chatId, me)) return json(res, 404, { error: 'Не знайдено' });
    if (!REACTIONS.includes(emoji)) return json(res, 400, { error: 'Така реакція не підтримується' });
    const rx = m.reactions || {};
    const had = (rx[emoji] || []).includes(me);
    for (const e of Object.keys(rx)) {      // одна реакція від користувача на повідомлення
      rx[e] = rx[e].filter((n) => n !== me);
      if (!rx[e].length) delete rx[e];
    }
    if (!had) (rx[emoji] = rx[emoji] || []).push(me);
    if (Object.keys(rx).length) m.reactions = rx; else delete m.reactions;
    store.msgReact(m.id, m.reactions || null);
    broadcast(chatMembers(m.chatId), 'react', { id: m.id, chatId: m.chatId, reactions: m.reactions || {}, by: me, emoji: had ? '' : emoji });
    return json(res, 200, { ok: true });
  }

  if (route === '/api/delete') {
    const id = String(body.id || '');
    const i = db.messages.findIndex((m) => m.id === id);
    if (i < 0) return json(res, 404, { error: 'Не знайдено' });
    const m = db.messages[i];
    const room = db.rooms[m.chatId];
    if (m.from !== me && !(room && room.owner === me)) return json(res, 403, { error: 'Можна видаляти лише свої повідомлення' });
    db.messages.splice(i, 1);
    store.msgDel(m.id);
    if (m.media) dropMedia(m.media.id);
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
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
    json(res, code, { error: code === 500 ? 'Помилка сервера' : (code === 413 ? 'Файл завеликий' : 'Некоректний запит') });
    if (code === 500) console.error(e);
  }
});

['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, async () => { await store.close(); process.exit(0); }));

store.init().then(() => {
  ensureGeneral();
  gcMedia();
  if (!store.persistent && (process.env.RENDER || process.env.NODE_ENV === 'production')) {
    console.warn('УВАГА: DATABASE_URL не задано. Акаунти й повідомлення зникнуть після перезапуску або «сну» сервера!');
  }
  server.listen(PORT, () => console.log('Vibe працює на порту ' + PORT + '. Сховище: ' + store.name +
    '. Користувачів: ' + Object.keys(db.users).length + ', повідомлень: ' + db.messages.length));
}).catch((e) => {
  console.error('Не вдалося підключитися до сховища:', e.message);
  process.exit(1);
});
