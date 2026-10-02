const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 30 * 1024 * 1024 });

app.use(express.json({ limit: "30mb" }));
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const DEFAULT_AVATAR = "https://i.imgur.com/6VBx3io.png";
const activeUsers = new Map(); // username -> Set(socket.id)
const sessions = new Map();    // socket.id -> username
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "CHANGE_ME";

const frames = [
  ["frame_neon","Neon Grid","linear-gradient(135deg,#00e5ff,#7c3aed,#ff2bd6)",3000],
  ["frame_fire","Fire","linear-gradient(135deg,#ff7a00,#ff1744,#ffd54f)",3500],
  ["frame_ice","Ice","linear-gradient(135deg,#d7f9ff,#38bdf8,#2563eb)",3500],
  ["frame_lime","Lime","linear-gradient(135deg,#b8ff3d,#22c55e,#14532d)",4000],
  ["frame_void","Void","linear-gradient(135deg,#111827,#4c1d95,#020617)",5000],
  ["frame_gold","Gold","linear-gradient(135deg,#fff7ae,#f59e0b,#92400e)",6000]
];
const badges = [
  ["crystals","💎","Кристали",500],
  ["webchat","💬","WebChat",500],
  ["donater","💰","Донатер",1000],
  ["creator","✨","Творець",1500],
  ["verified","✓","Підтверджений",2000],
  ["star","⭐","Зірка",800],
  ["crown","👑","Корона",3000]
];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      avatar TEXT,
      description TEXT DEFAULT '',
      crystals BIGINT DEFAULT 0,
      frame TEXT DEFAULT '',
      badge TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      description TEXT DEFAULT '',
      banner TEXT,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('group','channel')),
      verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      username TEXT REFERENCES users(username) ON DELETE CASCADE,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(chat_id, username)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      text TEXT DEFAULT '',
      file_data TEXT,
      file_name TEXT,
      file_type TEXT,
      reply_to TEXT,
      edited BOOLEAN DEFAULT FALSE,
      pinned BOOLEAN DEFAULT FALSE,
      reactions JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS direct_messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      text TEXT DEFAULT '',
      file_data TEXT,
      file_name TEXT,
      file_type TEXT,
      edited BOOLEAN DEFAULT FALSE,
      pinned BOOLEAN DEFAULT FALSE,
      reactions JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options JSONB NOT NULL,
      votes JSONB DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profile_channels (
      username TEXT REFERENCES users(username) ON DELETE CASCADE,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      PRIMARY KEY(username, chat_id)
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      reward BIGINT NOT NULL,
      activations_left INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_uses (
      code TEXT REFERENCES promo_codes(code) ON DELETE CASCADE,
      username TEXT NOT NULL,
      PRIMARY KEY(code, username)
    );
    CREATE TABLE IF NOT EXISTS inventory (
      username TEXT REFERENCES users(username) ON DELETE CASCADE,
      item_id TEXT,
      item_type TEXT,
      PRIMARY KEY(username, item_id, item_type)
    );
    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker TEXT,
      blocked TEXT,
      PRIMARY KEY(blocker, blocked)
    );
    CREATE TABLE IF NOT EXISTS channel_admins (
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      username TEXT REFERENCES users(username) ON DELETE CASCADE,
      can_delete BOOLEAN DEFAULT FALSE,
      can_edit BOOLEAN DEFAULT FALSE,
      can_edit_channel BOOLEAN DEFAULT FALSE,
      can_publish BOOLEAN DEFAULT FALSE,
      can_kick BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(chat_id, username)
    );
  `);
  for (const [id,name,style,price] of frames)
    await pool.query(`INSERT INTO inventory(username,item_id,item_type) SELECT 'SYSTEM', $1,'frame' WHERE FALSE ON CONFLICT DO NOTHING`, [id]);
}
initDb().catch(e => { console.error(e); process.exit(1); });

function uid(prefix="id") { return prefix+"_"+crypto.randomBytes(10).toString("hex"); }
function cleanUser(v) {
  v = String(v || "").trim();
  return v.startsWith("@") ? v : "@"+v;
}
function safeJson(v, fallback={}) {
  try { return typeof v === "string" ? JSON.parse(v) : (v || fallback); } catch { return fallback; }
}
function requireUser(socket) {
  const u = sessions.get(socket.id);
  if (!u) { socket.emit("error_msg","Потрібно увійти."); return null; }
  return u;
}
function broadcastUser(username, event, data) {
  for (const sid of (activeUsers.get(username) || [])) io.to(sid).emit(event,data);
}
function emitChat(chatId, event, data) {
  io.to("chat:"+chatId).emit(event,data);
}
async function channelPerms(chatId, username) {
  const c=(await pool.query("SELECT owner,kind FROM chats WHERE id=$1",[chatId])).rows[0];
  if(!c) return null;
  if(c.owner===username) return {owner:true,can_delete:true,can_edit:true,can_edit_channel:true,can_publish:true,can_kick:true};
  if(c.kind!=="channel") return {owner:false,can_delete:false,can_edit:false,can_edit_channel:false,can_publish:true,can_kick:false};
  const r=await pool.query("SELECT can_delete,can_edit,can_edit_channel,can_publish,can_kick FROM channel_admins WHERE chat_id=$1 AND username=$2",[chatId,username]);
  return {owner:false,can_delete:!!r.rows[0]?.can_delete,can_edit:!!r.rows[0]?.can_edit,can_edit_channel:!!r.rows[0]?.can_edit_channel,can_publish:!!r.rows[0]?.can_publish,can_kick:!!r.rows[0]?.can_kick};
}

const liveStreams = new Map(); // chatId -> {hostSocket, hostUsername}

io.on("connection", socket => {
  socket.on("register", async data => {
    try {
      const username = cleanUser(data.username);
      const nickname = String(data.nickname||"").trim().slice(0,60);
      if (!username || !nickname) return socket.emit("register_error","Заповніть юзернейм та нікнейм.");
      const avatar = data.avatar || DEFAULT_AVATAR;
      const q = await pool.query(`INSERT INTO users(username,nickname,avatar) VALUES($1,$2,$3)
        ON CONFLICT(username) DO UPDATE SET nickname=EXCLUDED.nickname, avatar=COALESCE(EXCLUDED.avatar,users.avatar)
        RETURNING username,nickname,avatar,description,crystals,frame,badge`, [username,nickname,avatar]);
      sessions.set(socket.id,username);
      if (!activeUsers.has(username)) activeUsers.set(username,new Set());
      activeUsers.get(username).add(socket.id);
      socket.emit("register_success",q.rows[0]);
      io.emit("status_update",{username,online:true});
    } catch(e){ console.error(e); socket.emit("register_error","Помилка сервера."); }
  });

  socket.on("update_profile", async d => {
    const old = requireUser(socket); if(!old) return;
    try {
      const nu=cleanUser(d.newUsername), nickname=String(d.nickname||"").trim().slice(0,60);
      const exists=await pool.query(`SELECT username FROM users WHERE username=$1 AND username<>$2`,[nu,old]);
      if(exists.rowCount) return socket.emit("register_error","Цей юзернейм вже зайнятий.");
      await pool.query("BEGIN");
      await pool.query(`UPDATE users SET username=$1,nickname=$2,avatar=$3,description=$4 WHERE username=$5`,
        [nu,nickname,d.avatar||DEFAULT_AVATAR,String(d.description||"").slice(0,300),old]);
      await pool.query(`UPDATE direct_messages SET sender=$1 WHERE sender=$2`,[nu,old]);
      await pool.query(`UPDATE direct_messages SET recipient=$1 WHERE recipient=$2`,[nu,old]);
      await pool.query(`UPDATE messages SET sender=$1 WHERE sender=$2`,[nu,old]);
      await pool.query(`UPDATE chat_members SET username=$1 WHERE username=$2`,[nu,old]);
      await pool.query(`UPDATE chats SET owner=$1 WHERE owner=$2`,[nu,old]);
      await pool.query(`UPDATE comments SET sender=$1 WHERE sender=$2`,[nu,old]);
      await pool.query(`UPDATE profile_channels SET username=$1 WHERE username=$2`,[nu,old]);
      await pool.query("COMMIT");
      const oldSet=activeUsers.get(old); if(oldSet){ activeUsers.delete(old); activeUsers.set(nu,oldSet); }
      sessions.set(socket.id,nu);
      const r=await pool.query(`SELECT username,nickname,avatar,description,crystals,frame,badge FROM users WHERE username=$1`,[nu]);
      socket.emit("profile_updated",r.rows[0]);
    } catch(e){ try{await pool.query("ROLLBACK")}catch{}; console.error(e); socket.emit("register_error","Не вдалося зберегти профіль."); }
  });

  socket.on("get_profile", async d => {
    try {
      const u=cleanUser(d.username), r=await pool.query(`SELECT username,nickname,avatar,description,crystals,frame,badge FROM users WHERE username=$1`,[u]);
      if(!r.rowCount) return socket.emit("user_not_found");
      const c=await pool.query(`SELECT c.* FROM chats c JOIN profile_channels p ON p.chat_id=c.id WHERE p.username=$1`,[u]);
      const owned=await pool.query(`SELECT * FROM chats WHERE owner=$1 AND kind='channel' ORDER BY created_at DESC`,[u]);
      socket.emit("profile_data",{...r.rows[0],online:!!activeUsers.get(u)?.size,channels:c.rows,ownedChannels:owned.rows});
    } catch(e){}
  });

  socket.on("search_user", async name => {
    const u=cleanUser(name);
    const r=await pool.query(`SELECT username,nickname,avatar,description,frame,badge FROM users WHERE username=$1`,[u]);
    if(r.rowCount) socket.emit("user_found",{...r.rows[0],online:!!activeUsers.get(u)?.size});
    else {
      const c=await pool.query(`SELECT id,name,avatar,description,banner,owner,kind,verified FROM chats WHERE lower(name)=lower($1) LIMIT 1`,[String(name).replace(/^@/,"")]);
      if(c.rowCount) socket.emit("chat_found",c.rows[0]); else socket.emit("user_not_found");
    }
  });

  socket.on("get_chats", async () => {
    const u=requireUser(socket); if(!u)return;
    const rooms=await pool.query(`SELECT c.*,cm.role FROM chats c JOIN chat_members cm ON cm.chat_id=c.id WHERE cm.username=$1 ORDER BY c.created_at DESC`,[u]);
    const dm=await pool.query(`SELECT DISTINCT ON (partner) partner, created_at FROM (SELECT CASE WHEN sender=$1 THEN recipient ELSE sender END AS partner, created_at FROM direct_messages WHERE sender=$1 OR recipient=$1) x ORDER BY partner, created_at DESC`,[u]);
    const partners=dm.rows.map(x=>x.partner);
    let direct=[];
    if(partners.length){
      const r=await pool.query(`SELECT username,nickname,avatar,description,frame,badge FROM users WHERE username=ANY($1::text[])`,[partners]);
      const by=new Map(r.rows.map(x=>[x.username,x]));
      direct=dm.rows.map(x=>({...(by.get(x.partner)||{username:x.partner,nickname:x.partner,avatar:null}),kind:'dm',name:by.get(x.partner)?.nickname||x.partner,online:!!activeUsers.get(x.partner)?.size,last_at:x.created_at}));
    }
    socket.emit("chats_list",[...direct,...rooms.rows]);
  });

  socket.on("create_chat", async d => {
    const u=requireUser(socket); if(!u)return;
    try {
      const id=uid("chat");
      await pool.query(`INSERT INTO chats(id,name,avatar,description,banner,owner,kind) VALUES($1,$2,$3,$4,$5,$6,'group')`,
        [id,String(d.name||"Група").slice(0,80),d.avatar||DEFAULT_AVATAR,String(d.description||"").slice(0,500),d.banner||null,u]);
      await pool.query(`INSERT INTO chat_members(chat_id,username,role) VALUES($1,$2,'owner')`,[id,u]);
      for(const m of (d.members||[]).map(cleanUser).filter(x=>x!==u)) {
        const ok=await pool.query("SELECT 1 FROM users WHERE username=$1",[m]);
        if(ok.rowCount) await pool.query(`INSERT INTO chat_members(chat_id,username) VALUES($1,$2) ON CONFLICT DO NOTHING`,[id,m]);
      }
      const c=(await pool.query("SELECT * FROM chats WHERE id=$1",[id])).rows[0];
      socket.emit("chat_created",c); io.emit("chat_changed",{id});
    }catch(e){console.error(e);socket.emit("error_msg","Не вдалося створити чат.");}
  });

  socket.on("create_channel", async d => {
    const u=requireUser(socket); if(!u)return;
    try {
      const name=String(d.name||"").trim().slice(0,80);
      if(!name)return socket.emit("error_msg","Введіть назву каналу.");
      const dup=await pool.query(`SELECT 1 FROM chats WHERE lower(name)=lower($1) AND kind='channel'`,[name]);
      if(dup.rowCount)return socket.emit("error_msg","Канал з такою назвою вже існує.");
      const id=uid("channel");
      await pool.query(`INSERT INTO chats(id,name,avatar,description,banner,owner,kind) VALUES($1,$2,$3,$4,$5,$6,'channel')`,
        [id,name,d.avatar||DEFAULT_AVATAR,String(d.description||"").slice(0,500),d.banner||null,u]);
      await pool.query(`INSERT INTO chat_members(chat_id,username,role) VALUES($1,$2,'owner')`,[id,u]);
      const c=(await pool.query("SELECT * FROM chats WHERE id=$1",[id])).rows[0];
      socket.emit("chat_created",c); io.emit("chat_changed",{id});
    }catch(e){console.error(e);socket.emit("error_msg","Не вдалося створити канал.");}
  });

  socket.on("find_channel", async d => {
    const r=await pool.query(`SELECT * FROM chats WHERE kind='channel' AND lower(name)=lower($1)`,[String(d.name||"").trim()]);
    if(r.rowCount) socket.emit("channel_found",r.rows[0]); else socket.emit("error_msg","Канал не знайдено.");
  });

  socket.on("join_chat", async d => {
    const u=requireUser(socket); if(!u)return;
    const id=d.chatId;
    const c=(await pool.query("SELECT * FROM chats WHERE id=$1",[id])).rows[0];
    if(!c)return socket.emit("error_msg","Чат не знайдено.");
    await pool.query(`INSERT INTO chat_members(chat_id,username,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`,[id,u]);
    socket.emit("joined_chat",c);
  });

  socket.on("leave_chat", async d => {
    const u=requireUser(socket); if(!u)return;
    const c=(await pool.query("SELECT * FROM chats WHERE id=$1",[d.chatId])).rows[0];
    if(!c)return;
    if(c.owner===u)return socket.emit("error_msg","Власник не може покинути групу/канал. Передайте власність або видаліть його.");
    await pool.query("DELETE FROM chat_members WHERE chat_id=$1 AND username=$2",[d.chatId,u]);
    socket.emit("left_chat",d.chatId);
  });

  socket.on("delete_chat", async d => {
    const u=requireUser(socket); if(!u)return;
    const c=(await pool.query("SELECT * FROM chats WHERE id=$1",[d.chatId])).rows[0];
    if(!c || c.owner!==u)return socket.emit("error_msg","Тільки власник може видалити чат.");
    await pool.query("DELETE FROM chats WHERE id=$1",[d.chatId]);
    io.emit("chat_deleted",d.chatId);
  });

  socket.on("edit_chat", async d => {
    const u=requireUser(socket); if(!u)return;
    const perms=await channelPerms(d.chatId,u);
    if(!perms || (!perms.owner && !perms.can_edit_channel)) return socket.emit("error_msg","У вас немає дозволу редагувати цей канал.");
    const r=await pool.query(`UPDATE chats SET name=$1,avatar=$2,description=$3,banner=$4 WHERE id=$5 RETURNING *`,
      [String(d.name||"").slice(0,80),d.avatar||DEFAULT_AVATAR,String(d.description||"").slice(0,500),d.banner||null,d.chatId]);
    if(r.rowCount){ emitChat(d.chatId,"chat_updated",r.rows[0]); socket.emit("chat_updated",r.rows[0]); }
  });

  socket.on("open_chat", async d => {
    const u=requireUser(socket); if(!u)return;
    const member=await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND username=$2",[d.chatId,u]);
    if(!member.rowCount)return socket.emit("error_msg","Спочатку приєднайтесь.");
    socket.join("chat:"+d.chatId);
    const c=(await pool.query("SELECT * FROM chats WHERE id=$1",[d.chatId])).rows[0];
    const m=(await pool.query(`SELECT m.*,u.nickname,u.avatar,u.frame,u.badge FROM messages m LEFT JOIN users u ON u.username=m.sender WHERE m.chat_id=$1 ORDER BY m.created_at ASC LIMIT 500`,[d.chatId])).rows;
    const p=(await pool.query("SELECT * FROM polls WHERE chat_id=$1",[d.chatId])).rows;
    const comments=(await pool.query("SELECT * FROM comments WHERE message_id IN (SELECT id FROM messages WHERE chat_id=$1) ORDER BY created_at ASC",[d.chatId])).rows;
    socket.emit("chat_opened",{chat:c,messages:m,polls:p,comments});
  });

  socket.on("send_chat_message", async d => {
    const u=requireUser(socket); if(!u)return;
    const mem=await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND username=$2",[d.chatId,u]);
    if(!mem.rowCount)return;
    const perms=await channelPerms(d.chatId,u);
    if(perms && !perms.can_publish)return socket.emit("error_msg","У вас немає дозволу публікувати повідомлення в цьому каналі.");
    const id=uid("msg");
    const r=await pool.query(`INSERT INTO messages(id,chat_id,sender,text,file_data,file_name,file_type,reply_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id,d.chatId,u,String(d.text||"").slice(0,5000),d.fileData||null,d.fileName||null,d.fileType||null,d.replyTo||null]);
    const msg=r.rows[0]; emitChat(d.chatId,"chat_new_message",msg); socket.emit("chat_new_message",msg);
  });

  socket.on("send_direct_message", async d => {
    const u=requireUser(socket); if(!u)return;
    const to=cleanUser(d.recipient);
    const blocked=await pool.query(`SELECT 1 FROM user_blocks WHERE (blocker=$1 AND blocked=$2) OR (blocker=$2 AND blocked=$1)`,[u,to]);
    if(blocked.rowCount)return socket.emit("error_msg","Цей чат заблоковано.");
    const id=uid("dm");
    const r=await pool.query(`INSERT INTO direct_messages(id,sender,recipient,text,file_data,file_name,file_type) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id,u,to,String(d.text||"").slice(0,5000),d.fileData||null,d.fileName||null,d.fileType||null]);
    const msg=r.rows[0];
    socket.emit("new_direct_message",msg); broadcastUser(to,"new_direct_message",msg);
  });

  socket.on("delete_direct_chat", async d => {
    const u=requireUser(socket); if(!u)return;
    const to=cleanUser(d.username);
    await pool.query(`DELETE FROM direct_messages WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)`,[u,to]);
    socket.emit("direct_chat_deleted",{username:to});
    broadcastUser(to,"direct_chat_deleted",{username:u});
  });

  socket.on("block_user", async d => {
    const u=requireUser(socket); if(!u)return;
    const to=cleanUser(d.username);
    if(u===to)return;
    await pool.query(`INSERT INTO user_blocks(blocker,blocked) VALUES($1,$2) ON CONFLICT DO NOTHING`,[u,to]);
    socket.emit("user_blocked",{username:to});
  });

  socket.on("get_direct_messages", async d => {
    const u=requireUser(socket); if(!u)return;
    const to=cleanUser(d.username);
    const r=await pool.query(`SELECT * FROM direct_messages WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1) ORDER BY created_at ASC LIMIT 500`,[u,to]);
    socket.emit("direct_history",r.rows);
  });

  socket.on("edit_message", async d => {
    const u=requireUser(socket); if(!u)return;
    let r=await pool.query(`SELECT * FROM messages WHERE id=$1`,[d.id]);
    if(r.rowCount){
      const m=r.rows[0], perms=await channelPerms(m.chat_id,u);
      if(m.sender!==u && !perms?.can_edit)return socket.emit("error_msg","У вас немає дозволу редагувати це повідомлення.");
      r=await pool.query(`UPDATE messages SET text=$1,edited=true WHERE id=$2 RETURNING *`,[String(d.newText||"").slice(0,5000),d.id]);
      emitChat(m.chat_id,"message_updated",r.rows[0]); return;
    }
    r=await pool.query(`UPDATE direct_messages SET text=$1,edited=true WHERE id=$2 AND sender=$3 RETURNING *`,[String(d.newText||"").slice(0,5000),d.id,u]);
    if(r.rowCount){ const m=r.rows[0]; broadcastUser(m.recipient,"message_updated",m); socket.emit("message_updated",m); }
  });
  socket.on("delete_message", async d => {
    const u=requireUser(socket); if(!u)return;
    let r=await pool.query(`SELECT * FROM messages WHERE id=$1`,[d.id]);
    if(r.rowCount){
      const m=r.rows[0], perms=await channelPerms(m.chat_id,u);
      if(m.sender!==u && !perms?.can_delete)return socket.emit("error_msg","У вас немає дозволу видаляти це повідомлення.");
      await pool.query(`DELETE FROM messages WHERE id=$1`,[d.id]); emitChat(m.chat_id,"message_deleted",{id:d.id}); return;
    }
    r=await pool.query(`DELETE FROM direct_messages WHERE id=$1 AND sender=$2 RETURNING id,recipient`,[d.id,u]);
    if(r.rowCount){ socket.emit("message_deleted",r.rows[0]); broadcastUser(r.rows[0].recipient,"message_deleted",{id:d.id}); }
  });
  socket.on("pin_message", async d => {
    const u=requireUser(socket); if(!u)return;
    let r=await pool.query(`UPDATE direct_messages SET pinned=true WHERE id=$1 AND sender=$2 RETURNING *`,[d.id,u]);
    if(r.rowCount){socket.emit("message_updated",r.rows[0]);broadcastUser(r.rows[0].recipient,"message_updated",r.rows[0]);return;}
    const owner=await pool.query(`SELECT c.owner FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.id=$1`,[d.id]);
    if(owner.rowCount && (owner.rows[0].owner===u)){
      r=await pool.query(`UPDATE messages SET pinned=true WHERE id=$1 RETURNING *`,[d.id]);
      if(r.rowCount)emitChat(r.rows[0].chat_id,"message_updated",r.rows[0]);
    }
  });

  socket.on("add_reaction", async d => {
    const u=requireUser(socket); if(!u)return;
    const emoji=String(d.emoji||"").slice(0,4);
    let r=await pool.query("SELECT * FROM direct_messages WHERE id=$1",[d.id]);
    if(r.rowCount){
      const reactions=safeJson(r.rows[0].reactions);
      if(reactions[u]===emoji) delete reactions[u]; else reactions[u]=emoji;
      const x=await pool.query(`UPDATE direct_messages SET reactions=$1 WHERE id=$2 RETURNING *`,[JSON.stringify(reactions),d.id]);
      socket.emit("message_updated",x.rows[0]); broadcastUser(x.rows[0].recipient,"message_updated",x.rows[0]); return;
    }
    r=await pool.query("SELECT * FROM messages WHERE id=$1",[d.id]);
    if(r.rowCount){
      const reactions=safeJson(r.rows[0].reactions);
      if(reactions[u]===emoji) delete reactions[u]; else reactions[u]=emoji;
      const x=await pool.query(`UPDATE messages SET reactions=$1 WHERE id=$2 RETURNING *`,[JSON.stringify(reactions),d.id]);
      emitChat(x.rows[0].chat_id,"message_updated",x.rows[0]);
    }
  });

  socket.on("create_poll", async d => {
    const u=requireUser(socket); if(!u)return;
    const mem=await pool.query(`SELECT 1 FROM chat_members WHERE chat_id=$1 AND username=$2`,[d.chatId,u]);
    if(!mem.rowCount)return;
    const perms=await channelPerms(d.chatId,u); if(!perms?.can_publish)return socket.emit("error_msg","У вас немає дозволу публікувати в цьому каналі.");
    const mid=uid("msg"), pid=uid("poll");
    await pool.query(`INSERT INTO messages(id,chat_id,sender,text) VALUES($1,$2,$3,$4)`,[mid,d.chatId,u,"📊 Опитування"]);
    const options=(d.options||[]).map(x=>String(x).slice(0,100)).filter(Boolean).slice(0,10);
    await pool.query(`INSERT INTO polls(id,chat_id,message_id,question,options,votes) VALUES($1,$2,$3,$4,$5,'{}')`,[pid,d.chatId,mid,String(d.question||"Опитування").slice(0,300),JSON.stringify(options)]);
    const poll=(await pool.query("SELECT * FROM polls WHERE id=$1",[pid])).rows[0];
    emitChat(d.chatId,"poll_created",{messageId:mid,poll});
  });

  socket.on("vote_poll", async d => {
    const u=requireUser(socket); if(!u)return;
    const r=await pool.query("SELECT * FROM polls WHERE id=$1",[d.pollId]);
    if(!r.rowCount)return;
    const p=r.rows[0], votes=safeJson(p.votes), options=safeJson(p.options,[]);
    if(!options.includes(d.option))return;
    votes[u]=d.option;
    const x=await pool.query(`UPDATE polls SET votes=$1 WHERE id=$2 RETURNING *`,[JSON.stringify(votes),d.pollId]);
    emitChat(p.chat_id,"poll_updated",x.rows[0]);
  });

  socket.on("add_comment", async d => {
    const u=requireUser(socket); if(!u)return;
    const r=await pool.query(`INSERT INTO comments(id,message_id,sender,text) VALUES($1,$2,$3,$4) RETURNING *`,[uid("comment"),d.messageId,u,String(d.text||"").slice(0,2000)]);
    const chat=await pool.query(`SELECT chat_id FROM messages WHERE id=$1`,[d.messageId]);
    if(chat.rowCount)emitChat(chat.rows[0].chat_id,"comment_added",r.rows[0]);
  });

  socket.on("channel_admin_data", async d => {
    const u=requireUser(socket); if(!u)return;
    const c=(await pool.query(`SELECT * FROM chats WHERE id=$1 AND kind='channel'`,[d.chatId])).rows[0];
    if(!c)return socket.emit("error_msg","Канал не знайдено.");
    const members=await pool.query(`SELECT cm.username,cm.role,u.nickname,u.avatar,ca.can_delete,ca.can_edit,ca.can_edit_channel,ca.can_publish,ca.can_kick FROM chat_members cm JOIN users u ON u.username=cm.username LEFT JOIN channel_admins ca ON ca.chat_id=cm.chat_id AND ca.username=cm.username WHERE cm.chat_id=$1 ORDER BY CASE WHEN cm.username=$2 THEN 0 WHEN cm.role='admin' THEN 1 ELSE 2 END,u.nickname`,[d.chatId,c.owner]);
    socket.emit("channel_admin_data",{chat:c,members:members.rows,permissions:await channelPerms(d.chatId,u)});
  });

  socket.on("set_channel_admin", async d => {
    const u=requireUser(socket); if(!u)return;
    const c=(await pool.query(`SELECT * FROM chats WHERE id=$1 AND kind='channel'`,[d.chatId])).rows[0];
    if(!c || c.owner!==u)return socket.emit("error_msg","Тільки власник може призначати адміністраторів.");
    const target=cleanUser(d.username); if(target===u)return;
    const member=await pool.query(`SELECT 1 FROM chat_members WHERE chat_id=$1 AND username=$2`,[d.chatId,target]);
    if(!member.rowCount)return socket.emit("error_msg","Користувач не є підписником каналу.");
    const p=d.permissions||{};
    await pool.query(`INSERT INTO channel_admins(chat_id,username,can_delete,can_edit,can_edit_channel,can_publish,can_kick) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chat_id,username) DO UPDATE SET can_delete=EXCLUDED.can_delete,can_edit=EXCLUDED.can_edit,can_edit_channel=EXCLUDED.can_edit_channel,can_publish=EXCLUDED.can_publish,can_kick=EXCLUDED.can_kick`,[d.chatId,target,!!p.can_delete,!!p.can_edit,!!p.can_edit_channel,!!p.can_publish,!!p.can_kick]);
    await pool.query(`UPDATE chat_members SET role='admin' WHERE chat_id=$1 AND username=$2`,[d.chatId,target]);
    emitChat(d.chatId,"channel_admin_changed",{username:target}); socket.emit("channel_admin_saved");
  });

  socket.on("remove_channel_admin", async d => {
    const u=requireUser(socket); if(!u)return;
    const c=(await pool.query(`SELECT owner FROM chats WHERE id=$1 AND kind='channel'`,[d.chatId])).rows[0];
    if(!c || c.owner!==u)return;
    await pool.query(`DELETE FROM channel_admins WHERE chat_id=$1 AND username=$2`,[d.chatId,cleanUser(d.username)]);
    await pool.query(`UPDATE chat_members SET role='member' WHERE chat_id=$1 AND username=$2`,[d.chatId,cleanUser(d.username)]);
    emitChat(d.chatId,"channel_admin_changed",{username:cleanUser(d.username)});
  });

  socket.on("kick_channel_member", async d => {
    const u=requireUser(socket); if(!u)return;
    const perms=await channelPerms(d.chatId,u); if(!perms?.can_kick)return socket.emit("error_msg","У вас немає дозволу видаляти підписників.");
    const target=cleanUser(d.username);
    const c=(await pool.query(`SELECT owner FROM chats WHERE id=$1`,[d.chatId])).rows[0];
    if(c?.owner===target)return;
    await pool.query(`DELETE FROM chat_members WHERE chat_id=$1 AND username=$2`,[d.chatId,target]);
    await pool.query(`DELETE FROM channel_admins WHERE chat_id=$1 AND username=$2`,[d.chatId,target]);
    emitChat(d.chatId,"channel_member_removed",{username:target});
    broadcastUser(target,"left_chat",d.chatId);
  });

  socket.on("profile_remove_channel", async d => {
    const u=requireUser(socket); if(!u)return;
    await pool.query(`DELETE FROM profile_channels WHERE username=$1 AND chat_id=$2`,[u,d.chatId]);
    socket.emit("profile_channel_removed",d.chatId);
  });

  socket.on("profile_add_channel", async d => {
    const u=requireUser(socket); if(!u)return;
    const c=await pool.query(`SELECT id FROM chats WHERE id=$1 AND owner=$2 AND kind='channel'`,[d.chatId,u]);
    if(c.rowCount)await pool.query(`INSERT INTO profile_channels(username,chat_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[u,d.chatId]);
  });

  socket.on("owner_list_channels", async d => {
    if(String(d.password||"")!==OWNER_PASSWORD)return;
    const r=await pool.query(`SELECT id,name,avatar,owner,verified,created_at FROM chats WHERE kind='channel' ORDER BY created_at DESC`);
    socket.emit("owner_channels",r.rows);
  });

  socket.on("owner_login", d => {
    if(String(d.password||"")===OWNER_PASSWORD) socket.emit("owner_auth", {ok:true});
    else socket.emit("owner_auth",{ok:false});
  });
  socket.on("owner_verify_channel", async d => {
    if(String(d.password||"")!==OWNER_PASSWORD)return;
    await pool.query(`UPDATE chats SET verified=$1 WHERE id=$2 AND kind='channel'`,[!!d.verified,d.chatId]);
    io.emit("chat_changed",{id:d.chatId});
  });
  socket.on("owner_delete_channel", async d => {
    if(String(d.password||"")!==OWNER_PASSWORD)return;
    const c=await pool.query(`SELECT * FROM chats WHERE id=$1 AND kind='channel'`,[d.chatId]);
    if(c.rowCount){await pool.query("DELETE FROM chats WHERE id=$1",[d.chatId]);io.emit("chat_deleted",d.chatId);}
  });

  socket.on("shop_catalog",async()=>{const u=requireUser(socket);if(!u)return;const owned=(await pool.query(`SELECT item_id,item_type FROM inventory WHERE username=$1`,[u])).rows;const mep=(await pool.query(`SELECT frame,badge FROM users WHERE username=$1`,[u])).rows[0]||{};socket.emit("shop_catalog",{frames,badges,owned,equipped:{frame:mep.frame||"",badge:mep.badge||""}})});
  socket.on("buy_item", async d=>{
    const u=requireUser(socket);if(!u)return;
    const itemType=d.type,itemId=d.id;
    const list=itemType==="frame"?frames:badges, item=list.find(x=>x[0]===itemId);
    if(!item)return;
    const price=item[3];
    const owned=await pool.query(`SELECT 1 FROM inventory WHERE username=$1 AND item_id=$2 AND item_type=$3`,[u,itemId,itemType]);
    if(owned.rowCount)return socket.emit("error_msg","Ви вже маєте цей предмет.");
    const r=await pool.query(`UPDATE users SET crystals=crystals-$1 WHERE username=$2 AND crystals >= $1 RETURNING crystals`,[price,u]);
    if(!r.rowCount)return socket.emit("error_msg","Недостатньо кристалів.");
    await pool.query(`INSERT INTO inventory(username,item_id,item_type) VALUES($1,$2,$3)`,[u,itemId,itemType]);
    socket.emit("balance_update",{crystals:r.rows[0].crystals});
  });
  socket.on("equip_item",async d=>{
    const u=requireUser(socket);if(!u)return;
    const ok=await pool.query(`SELECT 1 FROM inventory WHERE username=$1 AND item_id=$2 AND item_type=$3`,[u,d.id,d.type]);
    if(!ok.rowCount)return;
    const field=d.type==="frame"?"frame":"badge";
    const r=await pool.query(`UPDATE users SET ${field}=$1 WHERE username=$2 RETURNING ${field}`,[d.id,u]);
    socket.emit("equipped",{type:d.type,id:r.rows[0][field]});
  });

  socket.on("create_promo",async d=>{
    const u=requireUser(socket);if(!u)return;
    const code=String(d.code||"").trim().toUpperCase().replace(/[^A-Z0-9_-]/g,"").slice(0,32);
    const reward=Math.max(1,Math.floor(Number(d.reward)||0)), uses=Math.max(1,Math.floor(Number(d.activations)||0));
    if(!code||!reward||!uses)return socket.emit("error_msg","Заповніть код, нагороду та активації.");
    const cost=BigInt(reward)*BigInt(uses);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const bal=(await client.query("SELECT crystals FROM users WHERE username=$1 FOR UPDATE",[u])).rows[0];
      if(BigInt(bal.crystals)<cost){await client.query("ROLLBACK");return socket.emit("error_msg","Недостатньо кристалів для створення промокоду.");}
      await client.query("UPDATE users SET crystals=crystals-$1 WHERE username=$2",[cost.toString(),u]);
      await client.query("INSERT INTO promo_codes(code,owner,reward,activations_left) VALUES($1,$2,$3,$4)",[code,u,reward,uses]);
      await client.query("COMMIT");
      socket.emit("promo_created",{code,reward,activations:uses});
      const r=await pool.query("SELECT crystals FROM users WHERE username=$1",[u]);socket.emit("balance_update",{crystals:r.rows[0].crystals});
    }catch(e){await client.query("ROLLBACK");socket.emit("error_msg","Цей промокод вже існує або стався збій.");}finally{client.release();}
  });

  socket.on("redeem_promo",async d=>{
    const u=requireUser(socket);if(!u)return;
    const code=String(d.code||"").trim().toUpperCase();
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const p=(await client.query(`SELECT * FROM promo_codes WHERE code=$1 FOR UPDATE`,[code])).rows[0];
      if(!p||p.activations_left<=0)throw new Error("Промокод недійсний.");
      const used=await client.query("SELECT 1 FROM promo_uses WHERE code=$1 AND username=$2",[code,u]);
      if(used.rowCount)throw new Error("Ви вже активували цей промокод.");
      await client.query("INSERT INTO promo_uses(code,username) VALUES($1,$2)",[code,u]);
      await client.query("UPDATE promo_codes SET activations_left=activations_left-1 WHERE code=$1",[code]);
      const r=await client.query("UPDATE users SET crystals=crystals+$1 WHERE username=$2 RETURNING crystals",[p.reward,u]);
      await client.query("COMMIT");socket.emit("balance_update",{crystals:r.rows[0].crystals});
    }catch(e){await client.query("ROLLBACK");socket.emit("error_msg",e.message||"Не вдалося активувати промокод.");}finally{client.release();}
  });

  socket.on("get_inventory",async()=>{
    const u=requireUser(socket);if(!u)return;
    const r=await pool.query("SELECT * FROM inventory WHERE username=$1",[u]);socket.emit("inventory",r.rows);
  });

  socket.on("get_balance",async()=>{
    const u=requireUser(socket);if(!u)return;
    const r=await pool.query("SELECT crystals,frame,badge,description FROM users WHERE username=$1",[u]);socket.emit("balance_update",r.rows[0]);
  });

  socket.on("owner_balance",async d=>{
    if(String(d.password||"")!==OWNER_PASSWORD)return;
    const target=cleanUser(d.username);
    const r=await pool.query(`UPDATE users SET crystals=9223372036854775807 WHERE username=$1 RETURNING crystals`,[target]);
    if(r.rowCount)socket.emit("owner_balance_result",{username:target,crystals:"∞"});
  });

  socket.on("call_offer", d => {
    const u=requireUser(socket); if(!u || !d?.to || !d?.offer)return;
    const target=cleanUser(d.to);
    if(!(activeUsers.get(target)?.size)){ socket.emit("call_unavailable",{username:target,to:target}); return; }
    broadcastUser(target,"incoming_call",{from:u,offer:d.offer,type:d.type||"audio",callId:d.callId||socket.id});
    socket.emit("call_delivered",{to:target});
  });
  socket.on("call_answer", d => {
    const u=requireUser(socket); if(!u || !d?.to || !d?.answer)return;
    broadcastUser(d.to,"call_answer",{from:u,answer:d.answer});
  });
  socket.on("call_ice", d => {
    const u=requireUser(socket); if(!u || !d?.to || !d?.candidate)return;
    broadcastUser(d.to,"call_ice",{from:u,candidate:d.candidate});
  });
  socket.on("call_end", d => {
    const u=requireUser(socket); if(!u || !d?.to)return;
    broadcastUser(d.to,"call_ended",{from:u});
  });

  socket.on("live_start", d => {
    const u=requireUser(socket); if(!u || !d?.chatId)return;
    const id=String(d.chatId);
    pool.query("SELECT * FROM chats WHERE id=$1 AND kind='channel'",[id]).then(async r=>{
      const c=r.rows[0]; if(!c)return;
      const perms=await channelPerms(id,u); if(!perms?.can_publish)return socket.emit("error_msg","У вас немає дозволу на трансляцію.");
      liveStreams.set(id,{hostSocket:socket.id,hostUsername:u});
      io.to("chat:"+id).emit("live_started",{chatId:id,host:u});
    }).catch(()=>{});
  });
  socket.on("live_join", async d => {
    const u=requireUser(socket); if(!u || !d?.chatId)return;
    const id=String(d.chatId);
    const member=await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND username=$2",[id,u]);
    if(!member.rowCount)return socket.emit("error_msg","Спочатку підпишіться на канал.");
    const live=liveStreams.get(id);
    if(!live || live.hostSocket===socket.id)return socket.emit("error_msg","Трансляція зараз недоступна.");
    io.to(live.hostSocket).emit("live_viewer_join",{viewerSocket:socket.id,viewer:u});
  });
  socket.on("live_offer", d => {
    const u=requireUser(socket); if(!u || !d?.to || !d?.offer)return;
    io.to(String(d.to)).emit("live_offer",{offer:d.offer,fromSocket:socket.id});
  });
  socket.on("live_answer", d => {
    const u=requireUser(socket); if(!u || !d?.to || !d?.answer)return;
    io.to(String(d.to)).emit("live_answer",{answer:d.answer,viewerSocket:socket.id});
  });
  socket.on("live_ice", d => {
    const u=requireUser(socket); if(!u || !d?.to || !d?.candidate)return;
    io.to(String(d.to)).emit("live_ice",{candidate:d.candidate,fromSocket:socket.id});
  });
  socket.on("live_stop", d => {
    const u=requireUser(socket); if(!u || !d?.chatId)return;
    const id=String(d.chatId), live=liveStreams.get(id);
    if(live && live.hostSocket===socket.id){liveStreams.delete(id);io.to("chat:"+id).emit("live_stopped",{chatId:id});}
  });

  socket.on("disconnect",()=>{
    for(const [chatId,live] of liveStreams){if(live.hostSocket===socket.id){liveStreams.delete(chatId);io.to("chat:"+chatId).emit("live_stopped",{chatId});}}
    const u=sessions.get(socket.id); sessions.delete(socket.id);
    if(u){const s=activeUsers.get(u);if(s){s.delete(socket.id);if(!s.size){activeUsers.delete(u);io.emit("status_update",{username:u,online:false});}}}
  });
});

app.get("/api/health",async(req,res)=>{try{await pool.query("SELECT 1");res.json({ok:true,db:"postgresql"});}catch(e){res.status(500).json({ok:false});}});
app.get("*",(req,res)=>res.sendFile(require("path").join(__dirname,"index.html")));

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log("WebChat 2.0 запущено на порту",PORT));
