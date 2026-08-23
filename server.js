const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Роздаємо файли прямо з кореневої папки
app.use(express.static(__dirname));

// База даних у пам'яті
const users = {};       // socket.id -> { username, nickname, avatar }
const usernames = {};   // username -> socket.id
const blocks = new Set(); // пари заблокованих ("user1:user2")

io.on('connection', (socket) => {
    console.log(`Користувач підключився: ${socket.id}`);

    // Реєстрація
    socket.on('register', (data) => {
        const { username, nickname, avatar } = data;
        if (usernames[username]) {
            socket.emit('register_error', 'Цей юзернейм вже зайнятий!');
            return;
        }

        users[socket.id] = { username, nickname, avatar: avatar || 'https://i.imgur.com/6VBx3io.png' };
        usernames[username] = socket.id;
        socket.emit('register_success', users[socket.id]);
    });

    // Пошук користувача
    socket.on('search_user', (searchName) => {
        const targetSocketId = usernames[searchName];
        if (targetSocketId && targetSocketId !== socket.id) {
            socket.emit('user_found', users[targetSocketId]);
        } else {
            socket.emit('user_not_found');
        }
    });

    // Надсилання повідомлення
    socket.on('send_message', (data) => {
        const { recipientUsername, text } = data;
        const sender = users[socket.id];
        const recipientSocketId = usernames[recipientUsername];

        if (!sender || !recipientSocketId) return;

        // Перевірка на блокування
        const blockKey1 = `${sender.username}:${recipientUsername}`;
        const blockKey2 = `${recipientUsername}:${sender.username}`;
        if (blocks.has(blockKey1) || blocks.has(blockKey2)) return;

        const messageData = {
            id: Date.now().toString(),
            sender: sender.username,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        io.to(recipientSocketId).emit('new_message', messageData);
        socket.emit('new_message', messageData);
    });

    // Блокування (видалення чату для обох)
    socket.on('block_user', (targetUsername) => {
        const sender = users[socket.id];
        const targetSocketId = usernames[targetUsername];
        if (!sender) return;

        blocks.add(`${sender.username}:${targetUsername}`);
        blocks.add(`${targetUsername}:${sender.username}`);

        socket.emit('chat_blocked');
        if (targetSocketId) {
            io.to(targetSocketId).emit('chat_blocked');
        }
    });

    // Відключення
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete usernames[user.username];
            delete users[socket.id];
        }
        console.log(`Користувач вийшов: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущено: http://localhost:${PORT}`);
});
            
