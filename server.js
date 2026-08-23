const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10mb' })); // Для прийому картинок (Base64)
app.use(express.static(__dirname));

// Ініціалізація бази даних SQLite
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error('Помилка БД:', err.message);
    else console.log('Підключено до бази даних SQLite.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        nickname TEXT,
        avatar TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT,
        recipient TEXT,
        text TEXT,
        timestamp TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS blocks (
        user1 TEXT,
        user2 TEXT
    )`);
});

const activeSockets = {}; // username -> socket.id

io.on('connection', (socket) => {
    console.log(`Користувач підключився: ${socket.id}`);

    // Реєстрація / Вхід
    socket.on('register', (data) => {
        const { username, nickname, avatar } = data;
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
            if (row) {
                // Якщо користувач вже існує — оновлюємо дані і впускаємо
                db.run(`UPDATE users SET nickname = ?, avatar = ? WHERE username = ?`, [nickname, avatar || 'https://i.imgur.com/6VBx3io.png', username], () => {
                    activeSockets[username] = socket.id;
                    socket.emit('register_success', { username, nickname, avatar: avatar || row.avatar });
                });
            } else {
                // Створюємо нового
                const defaultAvatar = avatar || 'https://i.imgur.com/6VBx3io.png';
                db.run(`INSERT INTO users (username, nickname, avatar) VALUES (?, ?, ?)`, [username, nickname, defaultAvatar], (err) => {
                    if (err) {
                        socket.emit('register_error', 'Помилка реєстрації!');
                        return;
                    }
                    activeSockets[username] = socket.id;
                    socket.emit('register_success', { username, nickname, avatar: defaultAvatar });
                });
            }
        });
    });

    // Пошук користувача
    socket.on('search_user', (searchName) => {
        db.get(`SELECT username, nickname, avatar FROM users WHERE username = ?`, [searchName], (err, user) => {
            if (user) {
                socket.emit('user_found', user);
            } else {
                socket.emit('user_not_found');
            }
        });
    });

    // Завантаження історії чатів (хто з ким спілкувався)
    socket.on('get_chats', (username) => {
        db.all(`
            SELECT DISTINCT 
                CASE WHEN sender = ? THEN recipient ELSE sender END as partner
            FROM messages 
            WHERE sender = ? OR recipient = ?
        `, [username, username, username], (err, rows) => {
            if (err) return;
            const partners = rows.map(r => r.partner);
            if (partners.length === 0) {
                socket.emit('chats_list', []);
                return;
            }
            
            const placeholders = partners.map(() => '?').join(',');
            db.all(`SELECT username, nickname, avatar FROM users WHERE username IN (${placeholders})`, partners, (err, usersList) => {
                socket.emit('chats_list', usersList || []);
            });
        });
    });

    // Завантаження повідомлень конкретного чату
    socket.on('get_messages', (data) => {
        const { user1, user2 } = data;
        db.all(`
            SELECT * FROM messages 
            WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
            ORDER BY timestamp ASC
        `, [user1, user2, user2, user1], (err, rows) => {
            socket.emit('chat_history', rows || []);
        });
    });

    // Надсилання повідомлення
    socket.on('send_message', (data) => {
        const { sender, recipient, text } = data;
        
        // Перевірка на блокування
        db.get(`SELECT * FROM blocks WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)`, 
        [sender, recipient, recipient, sender], (err, row) => {
            if (row) {
                socket.emit('error_msg', 'Цей чат заблоковано.');
                return;
            }

            const msgData = {
                id: Date.now().toString() + Math.random(),
                sender,
                recipient,
                text,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            db.run(`INSERT INTO messages (id, sender, recipient, text, timestamp) VALUES (?, ?, ?, ?, ?)`,
                [msgData.id, msgData.sender, msgData.recipient, msgData.text, msgData.timestamp], () => {
                    
                    socket.emit('new_message', msgData);
                    const recipientSocketId = activeSockets[recipient];
                    if (recipientSocketId) {
                        io.to(recipientSocketId).emit('new_message', msgData);
                    }
                });
        });
    });

    // Блокування / Видалення чату
    socket.on('block_user', (data) => {
        const { user1, user2 } = data;
        db.run(`INSERT INTO blocks (user1, user2) VALUES (?, ?)`, [user1, user2], () => {
            db.run(`DELETE FROM messages WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)`, 
                [user1, user2, user2, user1], () => {
                    socket.emit('chat_blocked');
                    const targetSocketId = activeSockets[user2];
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('chat_blocked');
                    }
                });
        });
    });

    socket.on('disconnect', () => {
        for (let [username, id] of Object.entries(activeSockets)) {
            if (id === socket.id) {
                delete activeSockets[username];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер працює: http://localhost:${PORT}`);
});
            
