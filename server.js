'use strict';
/**
 * Vibe — месенджер у стилі Telegram. Чистий Node.js: HTTP + Server-Sent Events.
 *
 * Де що лежить:
 *  • База даних (PostgreSQL через DATABASE_URL, без неї — файл data.json) відповідає лише за
 *    «надсилання»: акаунти, повідомлення, канали, опитування, закріплення, описи стікерпаків.
 *    Це кілобайти текстових метаданих.
 *  • Файли (фото, відео, голосові, аватарки, шпалери, музика, стікери) НЕ в базі. Вони лежать у
 *    дисковому кеші MEDIA_DIR (найстаріші витісняються за MAX_MEDIA_MB) і в кеші на телефонах.
 *    Файл, якого вже немає на сервері, відновлюється з кешу будь-якого телефона, що його має:
 *    сервер звіряє SHA-256 з тим, що збережено в метаданих.
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
const MEDIA_TOTAL = (Number(process.env.MAX_MEDIA_MB) || 500) * MB;   // розмір дискового кешу файлів
const REACTIONS = ['❤️', '👍', '🔥', '😂', '😮', '😢', '🎉', '👎'];
const BUILTIN_STICKERS = ['😀', '😂', '🥰', '😎', '🤔', '😭', '😡', '🥳', '😴', '🤯', '👍', '👏',
  '🙏', '💪', '❤️', '🔥', '🎉', '💯', '🚀', '👀', '😱', '🤝', '🫶', '🤡'];
const MAX_PINS = 30;
const ID_RE = /^[a-f0-9]{32}$/;

/* ---------------- дані в памʼяті (кеш над сховищем) ---------------- */
const db = { users: {}, messages: [], reads: {}, sessions: {}, rooms: {}, media: {}, pins: {}, votes: {}, packs: {} };

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(8).toString('hex');
const newMediaId = () => crypto.randomBytes(16).toString('hex');
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);

/* ---------------- дисковий кеш файлів ---------------- */
const blobs = {
  present: new Map(),                 // id -> час останнього доступу
  file(id) { return path.join(MEDIA_DIR, id); },
  has(id) { return this.present.has(id); },
  async init() {
    await fs.promises.mkdir(MEDIA_DIR, { recursive: true });
    for (const f of await fs.promises.readdir(MEDIA_DIR)) {
      if (!ID_RE.test(f)) continue;
      if (!db.media[f]) { fs.unlink(this.file(f), () => {}); continue; }   // файл без метаданих
      try { this.present.set(f, (await fs.promises.stat(this.file(f))).mtimeMs); } catch (e) { /* ignore */ }
    }
  },
  async put(id, buf) {
    await fs.promises.writeFile(this.file(id), buf);
    this.present.set(id, Date.now());
    scheduleEvict();
  },
  async get(id) {
    if (!this.present.has(id)) return null;
    try {
      const b = await fs.promises.readFile(this.file(id));
      this.present.set(id, Date.now());
      return b;
    } catch (e) { this.present.delete(id); return null; }
  },
  del(id) { this.present.delete(id); fs.unlink(this.file(id), () => {}); }
};
// аватарки, шпалери, музика й стікери не витісняються (вони малі й обмежені квотами), лише файли з чатів
const SMALL_CTX = /^(profile|avatar|ravatar|sticker|wall):/;
const evictable = (meta) => !SMALL_CTX.test(meta.chatId);
let evictTimer = null;
function scheduleEvict() {
  if (evictTimer) return;
  evictTimer = setTimeout(() => { evictTimer = null; evict(); }, 500);
  evictTimer.unref();
}
function evict() {
  let total = 0; const list = [];
  for (const [id, last] of blobs.present) {
    const m = db.media[id];
    if (!m) continue;
    total += m.size;
    if (evictable(m)) list.push([id, last]);
  }
  if (total <= MEDIA_TOTAL) return;
  list.sort((a, b) => a[1] - b[1]);
  for (const [id] of list) {
    if (total <= MEDIA_TOTAL * 0.9) break;
    total -= db.media[id].size;
    blobs.del(id);
  }
}

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
  return {
    name: 'файли (data.json + media)',
    persistent: false,
    async init() {
      try { Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* перший запуск */ }
      for (const k of ['rooms', 'media', 'pins', 'votes', 'packs']) db[k] = db[k] || {};
    },
    async migrateBlobs() { /* файли вже на диску */ },
    userSave: save, sessionPut: save, sessionDel: save, msgAdd: save, msgDel: save, msgReact: save, msgPoll: save,
    readSet: save, roomSave: save, roomDel: save, mediaPut: save, mediaAttach: save, mediaDel: save,
    pinSet: save, voteSet: save, voteDel: save, packSave: save, packDel: save, chatDel: save,
    async close() { if (timer) clearTimeout(timer); flush(); }
  };
}

/* ---------------- сховище: PostgreSQL (лише метадані) ---------------- */
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
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker JSONB`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll JSONB`,
  `CREATE INDEX IF NOT EXISTS messages_t_idx ON messages (t)`,
  `CREATE INDEX IF NOT EXISTS messages_parent_idx ON messages (parent)`,
  `CREATE TABLE IF NOT EXISTS reads (
    chat_id TEXT NOT NULL, username TEXT NOT NULL, t BIGINT NOT NULL, PRIMARY KEY (chat_id, username))`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    is_public BOOLEAN NOT NULL DEFAULT false, handle TEXT, invite TEXT, owner TEXT,
    color INT NOT NULL DEFAULT 0, created BIGINT NOT NULL, members JSONB NOT NULL DEFAULT '[]'::jsonb)`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS avatar TEXT`,
  `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS comments BOOLEAN NOT NULL DEFAULT true`,
  // файли в базі не зберігаються: лише їхні метадані (з SHA-256 для відновлення)
  `CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, owner TEXT NOT NULL, mime TEXT NOT NULL,
    size INT NOT NULL, t BIGINT NOT NULL, attached BOOLEAN NOT NULL DEFAULT false)`,
  `ALTER TABLE media ADD COLUMN IF NOT EXISTS hash TEXT`,
  `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'media' AND column_name = 'data')
     THEN ALTER TABLE media ALTER COLUMN data DROP NOT NULL; END IF; END $$`,
  `CREATE TABLE IF NOT EXISTS pins (chat_id TEXT NOT NULL, msg_id TEXT NOT NULL, t BIGINT NOT NULL, PRIMARY KEY (chat_id, msg_id))`,
  `CREATE TABLE IF NOT EXISTS votes (msg_id TEXT NOT NULL, username TEXT NOT NULL, opts JSONB NOT NULL, PRIMARY KEY (msg_id, username))`,
  `CREATE TABLE IF NOT EXISTS packs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL, created BIGINT NOT NULL,
    stickers JSONB NOT NULL DEFAULT '[]'::jsonb)`
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
  let legacyIds = [];

  return {
    name: 'PostgreSQL (лише метадані)',
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
      const m = await pool.query('SELECT id, chat_id, sender, text, t, reply, media, reactions, parent, sticker, poll FROM messages ORDER BY t DESC LIMIT $1', [MAX_MESSAGES]);
      db.messages = m.rows.reverse().map((r) => {
        const o = { id: r.id, chatId: r.chat_id, from: r.sender, text: r.text, t: Number(r.t) };
        for (const k of ['reply', 'media', 'reactions', 'sticker', 'poll']) if (r[k]) o[k] = r[k];
        if (r.parent) o.parent = r.parent;
        return o;
      });
      const rd = await pool.query('SELECT chat_id, username, t FROM reads');
      for (const r of rd.rows) { (db.reads[r.chat_id] = db.reads[r.chat_id] || {})[r.username] = Number(r.t); }
      const rm = await pool.query('SELECT id, type, title, description, is_public, handle, invite, owner, color, created, members, avatar, comments FROM rooms');
      for (const r of rm.rows) {
        db.rooms[r.id] = { id: r.id, type: r.type, title: r.title, description: r.description, isPublic: r.is_public,
          handle: r.handle || '', invite: r.invite || '', owner: r.owner, color: r.color, created: Number(r.created),
          members: r.members || [], avatar: r.avatar || '', comments: r.comments !== false };
      }
      const md = await pool.query('SELECT id, chat_id, owner, mime, size, t, attached, hash FROM media');
      for (const r of md.rows) db.media[r.id] = { chatId: r.chat_id, owner: r.owner, mime: r.mime, size: r.size, t: Number(r.t), attached: r.attached, hash: r.hash || '' };
      const pn = await pool.query('SELECT chat_id, msg_id FROM pins ORDER BY t');
      for (const r of pn.rows) (db.pins[r.chat_id] = db.pins[r.chat_id] || []).push(r.msg_id);
      const vt = await pool.query('SELECT msg_id, username, opts FROM votes');
      for (const r of vt.rows) (db.votes[r.msg_id] = db.votes[r.msg_id] || {})[r.username] = r.opts;
      const pk = await pool.query('SELECT id, title, owner, created, stickers FROM packs');
      for (const r of pk.rows) db.packs[r.id] = { id: r.id, title: r.title, owner: r.owner, created: Number(r.created), stickers: r.stickers || [] };
      // файли, які раніше лежали в базі (колонка data), треба перенести на диск
      try { legacyIds = (await pool.query('SELECT id FROM media WHERE data IS NOT NULL')).rows.map((r) => r.id); } catch (e) { legacyIds = []; }
    },
    async migrateBlobs() {
      for (const id of legacyIds) {
        try {
          const r = await pool.query('SELECT data FROM media WHERE id = $1', [id]);
          const buf = r.rows[0] && r.rows[0].data;
          if (!buf) continue;
          if (!blobs.has(id) && db.media[id]) await blobs.put(id, buf);
          const h = sha(buf);
          if (db.media[id]) db.media[id].hash = h;
          await pool.query('UPDATE media SET data = NULL, hash = $2 WHERE id = $1', [id, h]);
        } catch (e) { console.error('Не вдалося перенести файл', id, e.message); }
      }
      if (legacyIds.length) console.log('Файлів перенесено з бази на диск: ' + legacyIds.length);
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
      run('INSERT INTO messages (id, chat_id, sender, text, t, reply, media, reactions, parent, sticker, poll) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING',
          [m.id, m.chatId, m.from, m.text, m.t, J(m.reply), J(m.media), J(m.reactions), m.parent || null, J(m.sticker), J(m.poll)]);
    },
    msgDel(id) { run('DELETE FROM messages WHERE id = $1', [id]); },
    msgReact(id, reactions) { run('UPDATE messages SET reactions = $2 WHERE id = $1', [id, J(reactions)]); },
    msgPoll(id, poll) { run('UPDATE messages SET poll = $2 WHERE id = $1', [id, J(poll)]); },
    readSet(chatId, user, t) {
      run('INSERT INTO reads (chat_id, username, t) VALUES ($1,$2,$3) ON CONFLICT (chat_id, username) DO UPDATE SET t = EXCLUDED.t',
          [chatId, user, t]);
    },
    roomSave(id) {
      const r = db.rooms[id];
      if (!r) return;
      run('INSERT INTO rooms (id, type, title, description, is_public, handle, invite, owner, color, created, members, avatar, comments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ' +
          'ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, title = EXCLUDED.title, description = EXCLUDED.description, ' +
          'is_public = EXCLUDED.is_public, handle = EXCLUDED.handle, invite = EXCLUDED.invite, owner = EXCLUDED.owner, ' +
          'color = EXCLUDED.color, members = EXCLUDED.members, avatar = EXCLUDED.avatar, comments = EXCLUDED.comments',
          [r.id, r.type, r.title, r.description, !!r.isPublic, r.handle || null, r.invite || null, r.owner || null, r.color, r.created, J(r.members), r.avatar || null, r.comments !== false]);
    },
    roomDel(id) { run('DELETE FROM rooms WHERE id = $1', [id]); },
    mediaPut(id, meta) {
      run('INSERT INTO media (id, chat_id, owner, mime, size, t, attached, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
          'ON CONFLICT (id) DO UPDATE SET attached = EXCLUDED.attached, hash = EXCLUDED.hash',
          [id, meta.chatId, meta.owner, meta.mime, meta.size, meta.t, !!meta.attached, meta.hash || null]);
    },
    mediaAttach(id) { run('UPDATE media SET attached = true WHERE id = $1', [id]); },
    mediaDel(id) { run('DELETE FROM media WHERE id = $1', [id]); },
    pinSet(chatId, msgId, on) {
      if (on) run('INSERT INTO pins (chat_id, msg_id, t) VALUES ($1,$2,$3) ON CONFLICT (chat_id, msg_id) DO NOTHING', [chatId, msgId, Date.now()]);
      else run('DELETE FROM pins WHERE chat_id = $1 AND msg_id = $2', [chatId, msgId]);
    },
    voteSet(msgId, user, opts) {
      if (opts && opts.length) run('INSERT INTO votes (msg_id, username, opts) VALUES ($1,$2,$3) ON CONFLICT (msg_id, username) DO UPDATE SET opts = EXCLUDED.opts', [msgId, user, J(opts)]);
      else run('DELETE FROM votes WHERE msg_id = $1 AND username = $2', [msgId, user]);
    },
    voteDel(msgId) { run('DELETE FROM votes WHERE msg_id = $1', [msgId]); },
    packSave(id) {
      const p = db.packs[id];
      if (!p) return;
      run('INSERT INTO packs (id, title, owner, created, stickers) VALUES ($1,$2,$3,$4,$5) ' +
          'ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, stickers = EXCLUDED.stickers',
          [p.id, p.title, p.owner, p.created, J(p.stickers)]);
    },
    packDel(id) { run('DELETE FROM packs WHERE id = $1', [id]); },
    chatDel(chatId) {
      run('DELETE FROM votes WHERE msg_id IN (SELECT id FROM messages WHERE chat_id = $1)', [chatId]);
      run('DELETE FROM messages WHERE chat_id = $1', [chatId]);
      run('DELETE FROM media WHERE chat_id = $1', [chatId]);
      run('DELETE FROM reads WHERE chat_id = $1', [chatId]);
      run('DELETE FROM pins WHERE chat_id = $1', [chatId]);
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
function canPost(chatId, me) {
  const r = db.rooms[chatId];
  return !(r && r.type === 'channel' && r.owner !== me);
}
function canPin(chatId, me) {
  if (chatId === 'general') return false;
  const r = db.rooms[chatId];
  if (r) return r.owner === me;
  return canUse(chatId, me);
}
function roomView(r, me) {
  const o = {
    id: r.id, type: r.type, title: r.title, description: r.description, isPublic: !!r.isPublic,
    handle: r.handle || '', color: r.color, owner: r.owner, count: r.members.length, created: r.created,
    avatar: r.avatar || '', comments: r.comments !== false
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
      isPublic: true, handle: 'general', invite: '', owner: null, color: 3, created: Date.now(), members: [], avatar: '', comments: true };
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

/* ---------------- повідомлення: коментарі, опитування, закріплення ---------------- */
const cc = new Map();                               // id поста -> кількість коментарів
function rebuildCC() {
  cc.clear();
  for (const m of db.messages) if (m.parent) cc.set(m.parent, (cc.get(m.parent) || 0) + 1);
}
function pollView(m, user) {
  const p = m.poll, v = db.votes[m.id] || {};
  const n = p.options.map(() => 0);
  let total = 0;
  for (const u of Object.keys(v)) { total++; for (const i of v[u]) if (n[i] !== undefined) n[i]++; }
  const voted = v[user] !== undefined;
  const mine = voted ? v[user].slice() : [];
  const showRes = p.closed || voted || m.from === user;
  const out = {
    q: p.q, multi: p.multi, anon: p.anon, quiz: p.quiz, closed: p.closed, total, mine, voted,
    options: p.options.map((o, i) => ({ t: o.t, n: showRes ? n[i] : null }))
  };
  if (p.quiz && (p.closed || voted || m.from === user)) { out.correct = p.correct; if (p.expl) out.expl = p.expl; }
  if (showRes && !p.anon) {
    out.who = p.options.map((o, i) => Object.keys(v).filter((u) => v[u].includes(i)).slice(0, 50).map((u) => (db.users[u] || { name: u }).name));
  }
  return out;
}
function view(m, user) {
  let o = m;
  if (m.poll) o = Object.assign({}, o, { poll: pollView(m, user) });
  if (!m.parent && cc.has(m.id)) o = Object.assign({}, o, { cc: cc.get(m.id) });
  return o;
}
function broadcastMsg(m) {
  const members = chatMembers(m.chatId) || [];
  if (!m.poll) return broadcast(members, 'msg', m);
  for (const n of members) broadcast([n], 'msg', view(m, n));
}
function broadcastPoll(m) {
  for (const n of chatMembers(m.chatId) || []) broadcast([n], 'poll', { id: m.id, chatId: m.chatId, poll: pollView(m, n) });
}
function cleanPoll(p, room) {
  if (!p || typeof p !== 'object' || !room) return null;
  const q = cleanText(p.q, 255).trim();
  const opts = (Array.isArray(p.options) ? p.options : []).map((x) => cleanText(x, 100).trim()).filter(Boolean).slice(0, 10);
  if (!q || opts.length < 2) return null;
  const quiz = !!p.quiz;
  let correct;
  if (quiz) {
    correct = Number(p.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= opts.length) return null;
  }
  return {
    q, options: opts.map((t) => ({ t })), multi: quiz ? false : !!p.multi,
    anon: room.type === 'channel' ? true : p.anon !== false, quiz, correct,
    expl: quiz ? cleanText(p.expl, 200).trim() : '', closed: false
  };
}
function unpin(chatId, id) {
  const a = db.pins[chatId];
  const j = a ? a.indexOf(id) : -1;
  if (j < 0) return false;
  a.splice(j, 1);
  if (!a.length) delete db.pins[chatId];
  store.pinSet(chatId, id, false);
  return true;
}
function removeMessage(m) {
  const i = db.messages.indexOf(m);
  if (i >= 0) db.messages.splice(i, 1);
  store.msgDel(m.id);
  if (m.media) dropMedia(m.media.id);
  unpin(m.chatId, m.id);
  if (db.votes[m.id]) { delete db.votes[m.id]; store.voteDel(m.id); }
  if (m.parent) {
    const n = (cc.get(m.parent) || 1) - 1;
    if (n > 0) cc.set(m.parent, n); else cc.delete(m.parent);
  }
}
function removeWithComments(m) {
  if (!m.parent) db.messages.filter((x) => x.parent === m.id).forEach(removeMessage);
  removeMessage(m);
  cc.delete(m.id);
}

/* ---------------- файли: метадані, доступ, завантаження ---------------- */
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

function dropMedia(id) {
  if (!db.media[id]) return;
  delete db.media[id];
  blobs.del(id);
  store.mediaDel(id);
}
function attachMedia(id) {
  const m = db.media[id];
  if (m && !m.attached) { m.attached = true; store.mediaAttach(id); }
}
// видаляємо завантажені, але нікуди не прикріплені файли старше години
function gcMedia() {
  const cut = Date.now() - 3600000;
  for (const id of Object.keys(db.media)) if (!db.media[id].attached && db.media[id].t < cut) dropMedia(id);
}
setInterval(gcMedia, 3600000).unref();

// файли профілю, аватарок і стікерів видно всім учасникам, файли чатів лише учасникам чату
function mediaAccess(meta, me) {
  const c = meta.chatId;
  if (/^(profile|avatar|ravatar|sticker):/.test(c)) return true;
  if (c.startsWith('wall:')) return c === 'wall:' + me;
  return canUse(c, me);
}
const IMG3 = ['image/jpeg', 'image/png', 'image/webp'];
function uploadSpec(ctx, kind, me) {
  let m;
  if (ctx === 'profile:' + me) return kind === 'audio' ? { max: LIMITS.audio } : { err: 'У профіль додається лише музика' };
  if (ctx === 'avatar:' + me) return kind === 'image' ? { max: 256 * 1024, mimes: IMG3 } : { err: 'Аватарка має бути зображенням' };
  if (ctx === 'wall:' + me) return kind === 'image' ? { max: Math.round(1.2 * MB), mimes: IMG3 } : { err: 'Шпалери мають бути зображенням' };
  if ((m = /^ravatar:(.+)$/.exec(ctx))) {
    const r = db.rooms[m[1]];
    if (!r || r.owner !== me) return { err: 'Лише власник може змінювати фото чату', code: 403 };
    return kind === 'image' ? { max: 256 * 1024, mimes: IMG3 } : { err: 'Фото чату має бути зображенням' };
  }
  if ((m = /^sticker:(.+)$/.exec(ctx))) {
    const p = db.packs[m[1]];
    if (!p || p.owner !== me) return { err: 'Лише власник може додавати стікери', code: 403 };
    return kind === 'image' ? { max: 512 * 1024, mimes: IMG3.concat('image/gif') } : { err: 'Стікер має бути зображенням' };
  }
  if (SMALL_CTX.test(ctx)) return { err: 'Недоступне призначення', code: 403 };
  if (!canUse(ctx, me)) return { err: 'Чат недоступний' };
  if (!canPost(ctx, me)) return { err: 'Лише власник може публікувати в цьому каналі', code: 403 };
  return { max: LIMITS[kind] };
}

async function uploadMedia(req, res, url, me) {
  if (limited('up:' + me, 30, 60000)) return json(res, 429, { error: 'Забагато завантажень, зачекайте хвилину' });
  const kind = url.searchParams.get('kind') || '';
  const ctx = url.searchParams.get('chatId') || '';
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const spec = MIME[mime];
  if (!spec || spec.kind !== kind) return json(res, 415, { error: 'Цей тип файлу не підтримується' });
  const us = uploadSpec(ctx, kind, me);
  if (us.err) return json(res, us.code || 400, { error: us.err });
  if (us.mimes && !us.mimes.includes(mime)) return json(res, 415, { error: 'Цей формат зображення тут не підтримується' });
  const len = Number(req.headers['content-length']) || 0;
  if (len > us.max) return json(res, 413, { error: 'Файл завеликий (ліміт ' + (us.max >= MB ? Math.round(us.max / MB) + ' МБ' : Math.round(us.max / 1024) + ' КБ') + ')' });
  const buf = await readRaw(req, us.max);
  if (!buf.length || !spec.sniff(buf)) return json(res, 415, { error: 'Файл пошкоджений або має невірний формат' });
  const id = newMediaId();
  const meta = { chatId: ctx, owner: me, mime, size: buf.length, t: Date.now(), attached: false, hash: sha(buf) };
  await blobs.put(id, buf);
  db.media[id] = meta;
  store.mediaPut(id, meta);
  return json(res, 200, { id, size: buf.length });
}

async function sendMedia(req, res, url, me) {
  const id = url.pathname.slice('/api/media/'.length);
  const meta = ID_RE.test(id) ? db.media[id] : null;
  if (!meta) return json(res, 404, { error: 'Файл не знайдено' });
  if (!mediaAccess(meta, me)) return json(res, 403, { error: 'Немає доступу' });
  const buf = await blobs.get(id);
  if (!buf) return json(res, 404, { code: 'evicted', error: 'Файл більше не зберігається на сервері' });
  res.writeHead(200, {
    'Content-Type': meta.mime,
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  });
  res.end(buf);
}

// відновлення файлу, якого вже немає на сервері, з кешу телефона (звіряємо SHA-256)
async function restoreMedia(req, res, url, me) {
  if (limited('rest:' + me, 60, 60000)) return json(res, 429, { error: 'Забагато запитів' });
  const id = url.searchParams.get('id') || '';
  const meta = ID_RE.test(id) ? db.media[id] : null;
  if (!meta || !mediaAccess(meta, me)) return json(res, 404, { error: 'Файл не знайдено' });
  if (blobs.has(id)) return json(res, 200, { ok: true, already: true });
  const buf = await readRaw(req, meta.size + 1024);
  if (!meta.hash || buf.length !== meta.size || sha(buf) !== meta.hash) return json(res, 400, { error: 'Файл не збігається з оригіналом' });
  await blobs.put(id, buf);
  return json(res, 200, { ok: true });
}

async function backfillHashes() {
  for (const id of Object.keys(db.media)) {
    const m = db.media[id];
    if (m.hash || !blobs.has(id)) continue;
    const b = await blobs.get(id);
    if (b) { m.hash = sha(b); store.mediaPut(id, m); }
  }
}
// аватарки та шпалери, що колись зберігалися як data-URL у профілі, переносимо у файли
async function storeDataUrl(url, ctx, owner) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) return '';
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || !MIME[m[1]].sniff(buf)) return '';
  const id = newMediaId();
  const meta = { chatId: ctx, owner, mime: m[1], size: buf.length, t: Date.now(), attached: true, hash: sha(buf) };
  await blobs.put(id, buf);
  db.media[id] = meta;
  store.mediaPut(id, meta);
  return id;
}
async function migrateLegacy() {
  for (const key of Object.keys(db.users)) {
    const u = db.users[key];
    let changed = false;
    const p = u.profile = u.profile || {};
    if (typeof p.avatar === 'string' && p.avatar.startsWith('data:image/')) {
      p.avatar = await storeDataUrl(p.avatar, 'avatar:' + key, key); changed = true;
    }
    const w = u.settings && u.settings.wallpaper;
    if (w && w.kind === 'image' && typeof w.value === 'string' && w.value.startsWith('data:image/')) {
      const id = await storeDataUrl(w.value, 'wall:' + key, key);
      if (id) w.value = id; else { w.kind = 'default'; w.value = ''; }
      changed = true;
    }
    if (changed) store.userSave(key);
  }
}

/* шпалери: перевірка того, що прислав клієнт */
function cleanWallpaper(w, me) {
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
    const mm = ID_RE.test(v) ? db.media[v] : null;
    if (mm && mm.owner === me && mm.chatId === 'wall:' + me) out.value = v;
    else out.kind = 'default';
  }
  return out;
}

/* ---------------- стікерпаки ---------------- */
function packView(p) {
  return { id: p.id, title: p.title, owner: p.owner, ownerName: (db.users[p.owner] || {}).name || p.owner,
    count: p.stickers.length, stickers: p.stickers };
}
function installPack(me, id) {
  const u = db.users[me];
  u.settings = u.settings || {};
  const list = Array.isArray(u.settings.packs) ? u.settings.packs : [];
  if (!list.includes(id)) list.push(id);
  u.settings.packs = list.slice(-40);
  store.userSave(me);
}
function myPacks(me) {
  const set = new Set(((db.users[me].settings || {}).packs) || []);
  for (const p of Object.values(db.packs)) if (p.owner === me) set.add(p.id);
  return [...set].map((id) => db.packs[id]).filter(Boolean).map(packView);
}
function stickerOk(s) {
  if (!s || typeof s !== 'object') return null;
  const pack = String(s.pack || ''), id = String(s.id || '');
  if (pack === 'vibe') return BUILTIN_STICKERS.includes(id) ? { pack, id } : null;
  const p = db.packs[pack];
  return p && p.stickers.some((x) => x.id === id) ? { pack, id } : null;
}

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

  /* ---- файли ---- */
  if (route === '/api/media' && req.method === 'POST') return uploadMedia(req, res, url, me);
  if (route === '/api/media/restore' && req.method === 'POST') return restoreMedia(req, res, url, me);
  if (route.startsWith('/api/media/') && req.method === 'GET') return sendMedia(req, res, url, me);

  if (route === '/api/state' && req.method === 'GET') {
    const perChat = {};
    const out = [];
    for (let i = db.messages.length - 1; i >= 0; i--) {
      const m = db.messages[i];
      if (m.parent || !canUse(m.chatId, me)) continue;      // коментарі завантажуються окремо
      perChat[m.chatId] = (perChat[m.chatId] || 0) + 1;
      if (perChat[m.chatId] <= PER_CHAT) out.push(view(m, me));
    }
    out.reverse();
    const reads = {}, pins = {};
    for (const c of Object.keys(db.reads)) if (canUse(c, me)) reads[c] = db.reads[c];
    for (const c of Object.keys(db.pins)) if (canUse(c, me)) pins[c] = db.pins[c].slice();
    const rooms = Object.values(db.rooms).filter((r) => r.members.includes(me)).map((r) => roomView(r, me));
    return json(res, 200, {
      me: publicUser(me), users: allUsers(), rooms, messages: out, reads, pins, packs: myPacks(me),
      settings: db.users[me].settings || {}, now: Date.now()
    });
  }

  if (route === '/api/comments' && req.method === 'GET') {
    const post = db.messages.find((x) => x.id === (url.searchParams.get('id') || ''));
    if (!post || post.parent || !canUse(post.chatId, me)) return json(res, 404, { error: 'Пост не знайдено' });
    const list = db.messages.filter((m) => m.parent === post.id).slice(-300).map((m) => view(m, me));
    return json(res, 200, { post: view(post, me), comments: list });
  }

  /* ---- пошук і перегляд кімнат та паків ---- */
  if (route === '/api/room/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '');
    const list = Object.values(db.rooms).filter((r) => r.isPublic && (!q || r.title.toLowerCase().includes(q) || (r.handle || '').includes(q)))
      .sort((a, b) => b.members.length - a.members.length).slice(0, 20)
      .map((r) => ({ id: r.id, type: r.type, title: r.title, description: r.description, handle: r.handle, count: r.members.length,
        color: r.color, avatar: r.avatar || '', joined: r.members.includes(me) }));
    return json(res, 200, { rooms: list });
  }
  if (route === '/api/room/preview' && req.method === 'GET') {
    const r = findByInvite(url.searchParams.get('code'));
    if (!r) return json(res, 404, { error: 'Запрошення недійсне або застаріле' });
    return json(res, 200, { room: { id: r.id, type: r.type, title: r.title, description: r.description, isPublic: !!r.isPublic,
      handle: r.handle, count: r.members.length, color: r.color, avatar: r.avatar || '', joined: r.members.includes(me) } });
  }
  if (route === '/api/pack/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const mine = new Set(myPacks(me).map((p) => p.id));
    const list = Object.values(db.packs).filter((p) => p.stickers.length && (!q || p.title.toLowerCase().includes(q)))
      .sort((a, b) => b.created - a.created).slice(0, 20).map((p) => Object.assign(packView(p), { installed: mine.has(p.id) }));
    return json(res, 200, { packs: list });
  }
  if (route === '/api/pack/get' && req.method === 'GET') {
    const p = db.packs[url.searchParams.get('id') || ''];
    if (!p) return json(res, 404, { error: 'Пак не знайдено' });
    return json(res, 200, { pack: Object.assign(packView(p), { installed: myPacks(me).some((x) => x.id === p.id) }) });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'Не знайдено' });
  const body = await readBody(req, 40000);

  if (route === '/api/media/missing') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 50).map(String).filter((i) => ID_RE.test(i));
    return json(res, 200, { missing: ids.filter((id) => db.media[id] && !blobs.has(id) && mediaAccess(db.media[id], me)) });
  }

  /* ---- кімнати ---- */
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
      invite: newInvite(), owner: me, color: crypto.randomInt(0, 7), created: Date.now(), members: [me], avatar: '', comments: true };
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
    if (body.avatar !== undefined) {
      if (!body.avatar) { if (r.avatar) dropMedia(r.avatar); r.avatar = ''; }
      else {
        const id = String(body.avatar), mm = ID_RE.test(id) ? db.media[id] : null;
        if (!mm || mm.owner !== me || mm.chatId !== 'ravatar:' + r.id) return json(res, 400, { error: 'Фото не знайдено, завантажте його ще раз' });
        if (r.avatar && r.avatar !== id) dropMedia(r.avatar);
        attachMedia(id);
        r.avatar = id;
      }
    }
    if (body.comments !== undefined && r.type === 'channel') r.comments = !!body.comments;
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
    if (r.avatar) mediaIds.push(r.avatar);
    const gone = new Set(db.messages.filter((m) => m.chatId === r.id).map((m) => m.id));
    gone.forEach((id) => { delete db.votes[id]; });
    db.messages = db.messages.filter((m) => !gone.has(m.id));
    gone.forEach((id) => cc.delete(id));
    mediaIds.forEach((id) => { delete db.media[id]; blobs.del(id); });
    delete db.reads[r.id];
    delete db.pins[r.id];
    delete db.rooms[r.id];
    store.roomDel(r.id);
    store.chatDel(r.id);
    if (r.avatar) store.mediaDel(r.avatar);
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
      if (!body.avatar) { if (u.profile.avatar) dropMedia(u.profile.avatar); u.profile.avatar = ''; }
      else {
        const id = String(body.avatar), mm = ID_RE.test(id) ? db.media[id] : null;
        if (!mm || mm.owner !== me || mm.chatId !== 'avatar:' + me) return json(res, 400, { error: 'Фото не знайдено, завантажте його ще раз' });
        if (u.profile.avatar && u.profile.avatar !== id) dropMedia(u.profile.avatar);
        attachMedia(id);
        u.profile.avatar = id;
      }
    }
    if (body.music !== undefined) {
      const old = u.profile.music;
      if (body.music === null) {
        if (old) dropMedia(old.mediaId);
        u.profile.music = null;
      } else {
        const mid = String(body.music.mediaId || '');
        const mm = ID_RE.test(mid) ? db.media[mid] : null;
        if (!mm || mm.owner !== me || mm.chatId !== 'profile:' + me || MIME[mm.mime].kind !== 'audio') return json(res, 400, { error: 'Файл музики не знайдено' });
        attachMedia(mid);
        if (old && old.mediaId !== mid) dropMedia(old.mediaId);
        u.profile.music = { mediaId: mid, title: cleanText(body.music.title, 60).trim() || 'Без назви',
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
    const wp = cleanWallpaper(body.wallpaper, me);
    if (!wp) return json(res, 400, { error: 'Некоректні налаштування' });
    const u = db.users[me];
    const old = u.settings && u.settings.wallpaper;
    if (old && old.kind === 'image' && old.value && old.value !== wp.value) dropMedia(old.value);
    if (wp.kind === 'image') attachMedia(wp.value);
    u.settings = Object.assign({}, u.settings, { wallpaper: wp });
    store.userSave(me);
    return json(res, 200, { ok: true });
  }

  /* ---- стікерпаки ---- */
  if (route === '/api/pack/create') {
    if (limited('pk:' + me, 10, 3600000)) return json(res, 429, { error: 'Забагато нових паків за годину' });
    const title = cleanText(body.title, 40).trim();
    if (title.length < 2) return json(res, 400, { error: 'Назва має містити від 2 символів' });
    if (Object.values(db.packs).filter((p) => p.owner === me).length >= 10) return json(res, 400, { error: 'Не більше 10 власних паків' });
    const p = { id: 'p_' + rid(), title, owner: me, created: Date.now(), stickers: [] };
    db.packs[p.id] = p;
    store.packSave(p.id);
    installPack(me, p.id);
    return json(res, 200, { pack: packView(p) });
  }
  if (route.startsWith('/api/pack/')) {
    const p = db.packs[String(body.packId || '')];
    if (!p) return json(res, 404, { error: 'Пак не знайдено' });
    if (route === '/api/pack/install') { installPack(me, p.id); return json(res, 200, { pack: packView(p) }); }
    if (route === '/api/pack/uninstall') {
      const u = db.users[me];
      u.settings = Object.assign({}, u.settings, { packs: ((u.settings || {}).packs || []).filter((x) => x !== p.id) });
      store.userSave(me);
      return json(res, 200, { ok: true });
    }
    if (p.owner !== me) return json(res, 403, { error: 'Лише власник може змінювати пак' });
    if (route === '/api/pack/update') {
      const title = cleanText(body.title, 40).trim();
      if (title.length < 2) return json(res, 400, { error: 'Назва має містити від 2 символів' });
      p.title = title;
      store.packSave(p.id);
      return json(res, 200, { pack: packView(p) });
    }
    if (route === '/api/pack/add') {
      if (p.stickers.length >= 30) return json(res, 400, { error: 'У паку може бути до 30 стікерів' });
      const mid = String(body.mediaId || ''), mm = ID_RE.test(mid) ? db.media[mid] : null;
      if (!mm || mm.owner !== me || mm.chatId !== 'sticker:' + p.id || mm.attached) return json(res, 400, { error: 'Файл не знайдено, завантажте його ще раз' });
      attachMedia(mid);
      p.stickers.push({ id: mid, e: cleanText(body.emoji, 8).trim() || '🙂' });
      store.packSave(p.id);
      return json(res, 200, { pack: packView(p) });
    }
    if (route === '/api/pack/remove') {
      const sid = String(body.id || '');
      if (!p.stickers.some((x) => x.id === sid)) return json(res, 404, { error: 'Стікер не знайдено' });
      p.stickers = p.stickers.filter((x) => x.id !== sid);
      dropMedia(sid);
      store.packSave(p.id);
      return json(res, 200, { pack: packView(p) });
    }
    if (route === '/api/pack/delete') {
      p.stickers.forEach((x) => dropMedia(x.id));
      delete db.packs[p.id];
      store.packDel(p.id);
      return json(res, 200, { ok: true });
    }
  }

  /* ---- повідомлення ---- */
  if (route === '/api/send') {
    if (limited('send:' + me, 20, 10000)) return json(res, 429, { error: 'Занадто швидко' });
    const chatId = String(body.chatId || '');
    if (!canUse(chatId, me)) return json(res, 400, { error: 'Чат недоступний' });
    const room = db.rooms[chatId];
    let parent = null;
    if (body.parent) {                                  // коментар до посту каналу
      const pm = db.messages.find((x) => x.id === String(body.parent));
      if (!pm || pm.chatId !== chatId || pm.parent || !room || room.type !== 'channel' || room.comments === false) {
        return json(res, 400, { error: 'Коментарі недоступні' });
      }
      parent = pm.id;
    } else if (!canPost(chatId, me)) return json(res, 403, { error: 'Лише власник може публікувати в цьому каналі' });

    const text = String(body.text || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    let media = null, sticker = null, poll = null;
    if (body.media && typeof body.media === 'object') {
      const mid = String(body.media.id || '');
      const mm = ID_RE.test(mid) ? db.media[mid] : null;
      if (!mm || mm.owner !== me || mm.chatId !== chatId || mm.attached) return json(res, 400, { error: 'Файл не знайдено, завантажте його ще раз' });
      const mk = MIME[mm.mime].kind;
      const kind = mk === 'audio' ? 'voice' : mk;
      const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
      const th = String(body.media.thumb || '');
      media = { id: mid, kind, mime: mm.mime, size: mm.size, w: num(body.media.w, 0, 12000), h: num(body.media.h, 0, 12000),
        dur: kind === 'image' ? 0 : num(body.media.dur, 0, kind === 'voice' ? 600 : 86400),
        thumb: kind !== 'voice' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1,4000}$/.test(th) ? th : '' };
      if (kind === 'voice') media.wave = (Array.isArray(body.media.wave) ? body.media.wave : []).slice(0, 64).map((n) => num(n, 0, 31));
      attachMedia(mid);
    }
    if (body.sticker) {
      sticker = stickerOk(body.sticker);
      if (!sticker) return json(res, 400, { error: 'Стікер не знайдено' });
    }
    if (body.poll) {
      if (parent || !room) return json(res, 400, { error: 'Опитування можна створювати в групах і каналах' });
      poll = cleanPoll(body.poll, room);
      if (!poll) return json(res, 400, { error: 'Некоректне опитування: потрібне питання й від 2 варіантів' });
    }
    if (!text && !media && !sticker && !poll) return json(res, 400, { error: 'Порожнє повідомлення' });
    const msg = { id: rid(), chatId, from: me, text, t: Date.now() };
    if (parent) msg.parent = parent;
    if (media) msg.media = media;
    if (sticker) msg.sticker = sticker;
    if (poll) msg.poll = poll;
    if (body.reply && typeof body.reply === 'object') {
      msg.reply = { name: cleanText(body.reply.name, 60), text: cleanText(body.reply.text, 120) };
    }
    db.messages.push(msg);
    if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
    store.msgAdd(msg);
    if (parent) cc.set(parent, (cc.get(parent) || 0) + 1);
    else { (db.reads[chatId] = db.reads[chatId] || {})[me] = msg.t; store.readSet(chatId, me, msg.t); }
    broadcastMsg(msg);
    if (parent) broadcast(chatMembers(chatId), 'cc', { chatId, id: parent, n: cc.get(parent) });
    return json(res, 200, { message: view(msg, me) });
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
    broadcast(chatMembers(m.chatId), 'react', { id: m.id, chatId: m.chatId, parent: m.parent, reactions: m.reactions || {}, by: me, emoji: had ? '' : emoji });
    return json(res, 200, { ok: true });
  }

  if (route === '/api/delete') {
    const m = db.messages.find((x) => x.id === String(body.id || ''));
    if (!m || !canUse(m.chatId, me)) return json(res, 404, { error: 'Не знайдено' });
    const room = db.rooms[m.chatId];
    if (m.from !== me && !(room && room.owner === me)) return json(res, 403, { error: 'Можна видаляти лише свої повідомлення' });
    const wasPinned = (db.pins[m.chatId] || []).includes(m.id);
    const members = chatMembers(m.chatId);
    removeWithComments(m);
    broadcast(members, 'del', { id: m.id, chatId: m.chatId, parent: m.parent });
    if (m.parent) broadcast(members, 'cc', { chatId: m.chatId, id: m.parent, n: cc.get(m.parent) || 0 });
    if (wasPinned) broadcast(members, 'pins', { chatId: m.chatId, pins: db.pins[m.chatId] || [] });
    return json(res, 200, { ok: true });
  }

  /* ---- опитування ---- */
  if (route === '/api/vote') {
    if (limited('vote:' + me, 60, 60000)) return json(res, 429, { error: 'Занадто часто' });
    const m = db.messages.find((x) => x.id === String(body.id || ''));
    if (!m || !m.poll || !canUse(m.chatId, me)) return json(res, 404, { error: 'Опитування не знайдено' });
    if (m.poll.closed) return json(res, 400, { error: 'Опитування завершено' });
    const opts = [...new Set((Array.isArray(body.options) ? body.options : []).map(Number))];
    if (opts.some((i) => !Number.isInteger(i) || i < 0 || i >= m.poll.options.length)) return json(res, 400, { error: 'Невірний варіант' });
    if (!m.poll.multi && opts.length > 1) return json(res, 400, { error: 'У цьому опитуванні можна обрати лише один варіант' });
    const votes = db.votes[m.id] = db.votes[m.id] || {};
    const had = votes[me] !== undefined;
    if (m.poll.quiz && (had || !opts.length)) return json(res, 400, { error: 'У вікторині відповідь можна дати лише раз' });
    if (opts.length) { votes[me] = opts; store.voteSet(m.id, me, opts); }
    else if (had) { delete votes[me]; store.voteSet(m.id, me, null); }
    if (!Object.keys(votes).length) delete db.votes[m.id];
    broadcastPoll(m);
    return json(res, 200, { poll: pollView(m, me) });
  }
  if (route === '/api/poll/close') {
    const m = db.messages.find((x) => x.id === String(body.id || ''));
    if (!m || !m.poll || !canUse(m.chatId, me)) return json(res, 404, { error: 'Опитування не знайдено' });
    const room = db.rooms[m.chatId];
    if (m.from !== me && !(room && room.owner === me)) return json(res, 403, { error: 'Завершити опитування може автор або власник' });
    m.poll.closed = true;
    store.msgPoll(m.id, m.poll);
    broadcastPoll(m);
    return json(res, 200, { poll: pollView(m, me) });
  }

  /* ---- закріплені повідомлення ---- */
  if (route === '/api/pin') {
    if (limited('pin:' + me, 30, 60000)) return json(res, 429, { error: 'Занадто часто' });
    const chatId = String(body.chatId || '');
    if (!canUse(chatId, me)) return json(res, 400, { error: 'Чат недоступний' });
    if (!canPin(chatId, me)) return json(res, 403, { error: 'Закріплювати може лише власник чату' });
    const m = db.messages.find((x) => x.id === String(body.id || ''));
    if (!m || m.chatId !== chatId || m.parent) return json(res, 404, { error: 'Повідомлення не знайдено' });
    if (body.on === false) unpin(chatId, m.id);
    else {
      const a = db.pins[chatId] = db.pins[chatId] || [];
      if (!a.includes(m.id)) {
        if (a.length >= MAX_PINS) return json(res, 400, { error: 'Можна закріпити до ' + MAX_PINS + ' повідомлень' });
        a.push(m.id);
        store.pinSet(chatId, m.id, true);
      }
    }
    const pins = (db.pins[chatId] || []).slice();
    broadcast(chatMembers(chatId), 'pins', { chatId, pins });
    return json(res, 200, { pins });
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

(async () => {
  await store.init();
  await blobs.init();
  await store.migrateBlobs();
  await backfillHashes();
  await migrateLegacy();
  rebuildCC();
  ensureGeneral();
  gcMedia();
  evict();
  if (!store.persistent && (process.env.RENDER || process.env.NODE_ENV === 'production')) {
    console.warn('УВАГА: DATABASE_URL не задано. Акаунти й повідомлення зникнуть після перезапуску або «сну» сервера!');
  }
  server.listen(PORT, () => console.log('Vibe працює на порту ' + PORT + '. Сховище: ' + store.name +
    '. Користувачів: ' + Object.keys(db.users).length + ', повідомлень: ' + db.messages.length +
    ', файлів у кеші: ' + blobs.present.size));
})().catch((e) => {
  console.error('Не вдалося запустити сервер:', e.message);
  process.exit(1);
});
