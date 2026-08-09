const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Створюємо папку для завантажених файлів, якщо її нема
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Налаштування multer для збереження фото/відео/файлів
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.static('public'));
app.use(express.json());

// База даних SQLite
const dbFile = path.join(__dirname, 'messenger.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Помилка БД:', err.message);
    else console.log('Підключено до бази даних SQLite.');
});

// Створення таблиць
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        display_name TEXT,
        avatar TEXT,
        status TEXT DEFAULT 'онлайн'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT,
        file_url TEXT,
        file_type TEXT,
        reactions TEXT DEFAULT '{}',
        is_edited INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS blocks (
        user_id TEXT,
        blocked_id TEXT,
        PRIMARY KEY (user_id, blocked_id)
    )`);
});

// Ендпоинт для завантаження файлів
app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
    res.json({ url: `/uploads/${req.file.filename}`, type: req.file.mimetype.startsWith('image') ? 'image' : 'file' });
});

// Socket.io події
io.on('connection', (socket) => {
    console.log(`Користувач підключився: ${socket.id}`);

    // Завантаження історії повідомлень при вході
    db.all("SELECT * FROM messages ORDER BY id ASC", [], (err, rows) => {
        if (!err) {
            rows.forEach(r => r.reactions = JSON.parse(r.reactions || '{}'));
            socket.emit('load history', rows);
        }
    });

    // Збереження / оновлення профілю юзера
    socket.on('set profile', (data) => {
        db.run(`INSERT INTO users (id, username, display_name, avatar, status) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET username=?, display_name=?, avatar=?`,
                [socket.id, data.username, data.displayName, data.avatar, data.status, data.username, data.displayName, data.avatar]);
    });

    // Нове повідомлення
    socket.on('chat message', (data) => {
        const reactionsObj = {};
        db.run(`INSERT INTO messages (sender_id, sender_name, text, file_url, file_type, reactions) VALUES (?, ?, ?, ?, ?, ?)`,
            [socket.id, data.name, data.text || '', data.fileUrl || '', data.fileType || '', JSON.stringify(reactionsObj)],
            function(err) {
                if (!err) {
                    const fullMsg = {
                        id: this.lastID,
                        sender_id: socket.id,
                        sender_name: data.name,
                        text: data.text || '',
                        file_url: data.fileUrl || '',
                        file_type: data.fileType || '',
                        reactions: reactionsObj,
                        is_edited: 0
                    };
                    io.emit('chat message', fullMsg);
                }
            }
        );
    });

    // Редагування повідомлення
    socket.on('edit message', (data) => {
        db.run(`UPDATE messages SET text = ?, is_edited = 1 WHERE id = ? AND sender_id = ?`, [data.newText, data.id, socket.id], function(err) {
            if (!err && this.changes > 0) {
                io.emit('message edited', { id: data.id, newText: data.newText });
            }
        });
    });

    // Видалення повідомлення
    socket.on('delete message', (msgId) => {
        db.run(`DELETE FROM messages WHERE id = ? AND sender_id = ?`, [msgId, socket.id], function(err) {
            if (!err && this.changes > 0) {
                io.emit('message deleted', msgId);
            }
        });
    });

    // Реакції на повідомлення
    socket.on('add reaction', (data) => {
        db.get(`SELECT reactions FROM messages WHERE id = ?`, [data.id], (err, row) => {
            if (row) {
                let reactions = JSON.parse(row.reactions || '{}');
                reactions[socket.id] = data.emoji;
                
                db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(reactions), data.id], () => {
                    io.emit('update reactions', { id: data.id, reactions });
                });
            }
        });
    });

    socket.on('disconnect', () => {
        console.log(`Користувач вийшов: ${socket.id}`);
    });
});

// Рендер автоматично передає порт через змінну середовища process.env.PORT, тому використовуємо її або 3000 для локального запуску
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер месенджера запущено на порту ${PORT}`);
});
        
