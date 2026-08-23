const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '15mb' })); // Збільшено ліміт для картинок/файлів
app.use(express.static(__dirname));

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
        fileData TEXT,
        fileName TEXT,
        timestamp TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS blocks (
        user1 TEXT,
        user2 TEXT
    )`);
});

const activeUsers = {}; // username -> socket.id

io.on('connection', (socket) => {
    console.log(`Підключення: ${socket.id}`);

    // Авторизація / Реєстрація
    socket.on('register', (data) => {
        const { username, nickname, avatar } = data;
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
            const defaultAvatar = avatar || 'https://i.imgur.com/6VBx3io.png';
            if (row) {
                db.run(`UPDATE users SET nickname = ?, avatar = ? WHERE username = ?`, [nickname, avatar || row.avatar, username], () => {
                    activeUsers[username] = socket.id;
                    socket.emit('register_success', { username, nickname, avatar: avatar || row.avatar });
                    io.emit('status_update', { username, online: true });
                });
            } else {
                db.run(`INSERT INTO users (username, nickname, avatar) VALUES (?, ?, ?)`, [username, nickname, defaultAvatar], (err) => {
                    if (err) {
                        socket.emit('register_error', 'Помилка реєстрації!');
                        return;
                    }
                    activeUsers[username] = socket.id;
                    socket.emit('register_success', { username, nickname, avatar: defaultAvatar });
                    io.emit('status_update', { username, online: true });
                });
            }
        });
    });

    // Зміна профілю (зміна юзернейму з оновленням у базі та історії)
    socket.on('update_profile', (data) => {
        const { oldUsername, newUsername, nickname, avatar } = data;
        
        db.get(`SELECT * FROM users WHERE username = ?`, [newUsername], (err, row) => {
            if (row && oldUsername !== newUsername) {
                socket.emit('register_error', 'Цей юзернейм вже зайнятий!');
                return;
            }

            db.serialize(() => {
                if (oldUsername !== newUsername) {
                    db.run(`UPDATE users SET username = ?, nickname = ?, avatar = ? WHERE username = ?`, [newUsername, nickname, avatar, oldUsername]);
                    db.run(`UPDATE messages SET sender = ? WHERE sender = ?`, [newUsername, oldUsername]);
                    db.run(`UPDATE messages SET recipient = ? WHERE recipient = ?`, [newUsername, oldUsername]);
                    db.run(`UPDATE blocks SET user1 = ? WHERE user1 = ?`, [newUsername, oldUsername]);
                    db.run(`UPDATE blocks SET user2 = ? WHERE user2 = ?`, [newUsername, oldUsername]);
                    
                    delete activeUsers[oldUsername];
                } else {
                    db.run(`UPDATE users SET nickname = ?, avatar = ? WHERE username = ?`, [nickname, avatar, username]);
                }
                
                activeUsers[newUsername] = socket.id;
                socket.emit('profile_updated', { username: newUsername, nickname, avatar });
            });
        });
    });

    // Перевірка статусів онлайн
    socket.on('check_online', (usernames) => {
        const statuses = {};
        usernames.forEach(u => {
            statuses[u] = !!activeUsers[u];
        });
        socket.emit('online_statuses', statuses);
    });

    // Пошук користувача
    socket.on('search_user', (searchName) => {
        db.get(`SELECT username, nickname, avatar FROM users WHERE username = ?`, [searchName], (err, user) => {
            if (user) {
                socket.emit('user_found', { ...user, online: !!activeUsers[user.username] });
            } else {
                socket.emit('user_not_found');
            }
        });
    });

    // Список чатів
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
                const result = (usersList || []).map(u => ({
                    ...u,
                    online: !!activeUsers[u.username]
                }));
                socket.emit('chats_list', result);
            });
        });
    });

    // Отримання повідомлень
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

    // Надсилання повідомлень (з підтримкою файлів/фото)
    socket.on('send_message', (data) => {
        const { sender, recipient, text, fileData, fileName } = data;
        
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
                text: text || '',
                fileData: fileData || null,
                fileName: fileName || null,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            db.run(`INSERT INTO messages (id, sender, recipient, text, fileData, fileName, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [msgData.id, msgData.sender, msgData.recipient, msgData.text, msgData.fileData, msgData.fileName, msgData.timestamp], () => {
                    
                    socket.emit('new_message', msgData);
                    const recipientSocketId = activeUsers[recipient];
                    if (recipientSocketId) {
                        io.to(recipientSocketId).emit('new_message', msgData);
                    }
                });
        });
    });

    // Блокування чату
    socket.on('block_user', (data) => {
        const { user1, user2 } = data;
        db.run(`INSERT INTO blocks (user1, user2) VALUES (?, ?)`, [user1, user2], () => {
            db.run(`DELETE FROM messages WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)`, 
                [user1, user2, user2, user1], () => {
                    socket.emit('chat_blocked');
                    const targetSocketId = activeUsers[user2];
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('chat_blocked');
                    }
                });
        });
    });

    socket.on('disconnect', () => {
        for (let [username, id] of Object.entries(activeUsers)) {
            if (id === socket.id) {
                delete activeUsers[username];
                io.emit('status_update', { username, online: false });
                break;
            }
        }
        console.log(`Відключення: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер працює: http://localhost:${PORT}`);
});
    
