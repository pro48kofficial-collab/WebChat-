const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e7 // 10MB limit
});

app.use(express.json({ limit: '15mb' }));
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
        timestamp TEXT,
        reactions TEXT,
        edited INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS blocks (
        user1 TEXT,
        user2 TEXT
    )`);
});

const activeUsers = {};

io.on('connection', (socket) => {
    console.log(`Підключення: ${socket.id}`);

    socket.on('register', (data) => {
        const { username, nickname, avatar } = data;
        if (!username || !nickname) {
            socket.emit('register_error', 'Заповніть юзернейм та нікнейм!');
            return;
        }

        const cleanUsername = username.startsWith('@') ? username : '@' + username;
        const defaultAvatar = avatar || 'https://i.imgur.com/6VBx3io.png';

        db.get(`SELECT * FROM users WHERE username = ?`, [cleanUsername], (err, row) => {
            if (row) {
                const finalAvatar = avatar || row.avatar;
                db.run(`UPDATE users SET nickname = ?, avatar = ? WHERE username = ?`, [nickname, finalAvatar, cleanUsername], (updateErr) => {
                    if (updateErr) {
                        socket.emit('register_error', 'Помилка оновлення.');
                        return;
                    }
                    activeUsers[cleanUsername] = socket.id;
                    socket.emit('register_success', { username: cleanUsername, nickname, avatar: finalAvatar });
                    io.emit('status_update', { username: cleanUsername, online: true });
                });
            } else {
                db.run(`INSERT INTO users (username, nickname, avatar) VALUES (?, ?, ?)`, [cleanUsername, nickname, defaultAvatar], (insertErr) => {
                    if (insertErr) {
                        socket.emit('register_error', 'Помилка збереження користувача.');
                        return;
                    }
                    activeUsers[cleanUsername] = socket.id;
                    socket.emit('register_success', { username: cleanUsername, nickname, avatar: defaultAvatar });
                    io.emit('status_update', { username: cleanUsername, online: true });
                });
            }
        });
    });

    socket.on('update_profile', (data) => {
        let { oldUsername, newUsername, nickname, avatar } = data;
        newUsername = newUsername.startsWith('@') ? newUsername : '@' + newUsername;
        
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
                    db.run(`UPDATE users SET nickname = ?, avatar = ? WHERE username = ?`, [nickname, avatar, oldUsername]);
                }
                
                activeUsers[newUsername] = socket.id;
                socket.emit('profile_updated', { username: newUsername, nickname, avatar });
            });
        });
    });

    socket.on('search_user', (searchName) => {
        const cleanSearch = searchName.startsWith('@') ? searchName : '@' + searchName;
        db.get(`SELECT username, nickname, avatar FROM users WHERE username = ?`, [cleanSearch], (err, user) => {
            if (user) {
                socket.emit('user_found', { ...user, online: !!activeUsers[user.username] });
            } else {
                socket.emit('user_not_found');
            }
        });
    });

    socket.on('get_chats', (username) => {
        db.all(`
            SELECT DISTINCT 
                CASE WHEN sender = ? THEN recipient ELSE sender END as partner
            FROM messages 
            WHERE sender = ? OR recipient = ?
        `, [username, username, username], (err, rows) => {
            if (err) return;
            const partners = (rows || []).map(r => r.partner);
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

    socket.on('get_messages', (data) => {
        const { user1, user2 } = data;
        db.all(`
            SELECT * FROM messages 
            WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
            ORDER BY timestamp ASC
        `, [user1, user2, user2, user1], (err, rows) => {
            const formatted = (rows || []).map(r => ({
                ...r,
                reactions: r.reactions ? JSON.parse(r.reactions) : {}
            }));
            socket.emit('chat_history', formatted);
        });
    });

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
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                reactions: {},
                edited: 0
            };

            db.run(`INSERT INTO messages (id, sender, recipient, text, fileData, fileName, timestamp, reactions, edited) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [msgData.id, msgData.sender, msgData.recipient, msgData.text, msgData.fileData, msgData.fileName, msgData.timestamp, JSON.stringify(msgData.reactions), 0], () => {
                    
                    socket.emit('new_message', msgData);
                    const recipientSocketId = activeUsers[recipient];
                    if (recipientSocketId) {
                        io.to(recipientSocketId).emit('new_message', msgData);
                    }
                });
        });
    });

    socket.on('edit_message', (data) => {
        const { id, newText, user } = data;
        db.run(`UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND sender = ?`, [newText, id, user], function(err) {
            if (this.changes > 0) {
                db.get(`SELECT * FROM messages WHERE id = ?`, [id], (err, row) => {
                    if (row) {
                        const updatedMsg = { ...row, reactions: row.reactions ? JSON.parse(row.reactions) : {} };
                        io.emit('message_updated', updatedMsg);
                    }
                });
            }
        });
    });

    socket.on('delete_message', (data) => {
        const { id, user } = data;
        db.run(`DELETE FROM messages WHERE id = ? AND sender = ?`, [id, user], function(err) {
            if (this.changes > 0) {
                io.emit('message_deleted', { id });
            }
        });
    });

    socket.on('add_reaction', (data) => {
        const { id, emoji, user } = data;
        db.get(`SELECT * FROM messages WHERE id = ?`, [id], (err, row) => {
            if (!row) return;
            let reactions = row.reactions ? JSON.parse(row.reactions) : {};
            
            // Якщо користувач вже ставив цю ж реакцію — знімаємо, інакше ставимо/переключаємо
            if (reactions[user] === emoji) {
                delete reactions[user];
            } else {
                reactions[user] = emoji;
            }

            db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(reactions), id], () => {
                const updatedMsg = { ...row, reactions };
                io.emit('message_updated', updatedMsg);
            });
        });
    });

    socket.on('block_user', (data) => {
        const { user1, user2 } = data;
        db.run(`INSERT INTO blocks (user1, user2) VALUES (?, ?)`, [user1, user2], () => {
            socket.emit('chat_blocked');
            const targetSocketId = activeUsers[user2];
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat_blocked');
            }
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
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер працює на порту ${PORT}`);
});
                        
