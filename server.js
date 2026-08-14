const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Роздаємо статичні файли (HTML, CSS, JS) з поточної папки
app.use(express.static(path.join(__dirname)));

// Зберігаємо активних користувачів у пам'яті сервера
const connectedUsers = {};

io.on('connection', (socket) => {
    console.log(`Користувач підключився: ${socket.id}`);

    // Збереження або оновлення профілю користувача
    socket.on('set profile', (user) => {
        connectedUsers[socket.id] = {
            id: socket.id,
            username: user.username,
            displayName: user.displayName,
            avatar: user.avatar,
            bio: user.bio,
            online: true
        };
        console.log(`Профіль збережено: ${user.username} (${socket.id})`);
    });

    // Запит на отримання всіх користувачів (якщо потрібно)
    socket.on('get all users', () => {
        const users = Object.values(connectedUsers).filter(u => u.id !== socket.id);
        socket.emit('search results', users);
    });

    // Пошук користувачів за юзернеймом або ім'ям
    socket.on('search users', (query) => {
        const lowerQuery = query.toLowerCase();
        const results = Object.values(connectedUsers).filter(user => 
            user.username.toLowerCase().includes(lowerQuery) || 
            user.displayName.toLowerCase().includes(lowerQuery)
        );
        socket.emit('search results', results);
    });

    // Приєднання до конкретної кімнати чату
    socket.on('join chat', (chatId) => {
        socket.join(chatId);
    });

    // Обмін повідомленнями
    socket.on('chat message', (msgData) => {
        // Пересилаємо повідомлення всім у кімнаті (включно з відправником)
        io.to(msgData.chatId).emit('chat message', msgData);
    });

    // Відключення користувача
    socket.on('disconnect', () => {
        console.log(`Користувач відключився: ${socket.id}`);
        if (connectedUsers[socket.id]) {
            connectedUsers[socket.id].online = false;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущено на http://localhost:${PORT}`);
});
                
