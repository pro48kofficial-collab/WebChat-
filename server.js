const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

// Зберігаємо користувачів за їхнім постійним ID (юзернеймом)
const registeredUsers = {}; // ключ — це id юзера (наприклад, "@pro")

io.on('connection', (socket) => {
    console.log(`Підключився сокет: ${socket.id}`);

    // Збереження або оновлення профілю
    socket.on('set profile', (user) => {
        registeredUsers[user.id] = {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatar: user.avatar,
            bio: user.bio,
            online: true,
            socketId: socket.id // запам'ятовуємо поточний сокет
        };
        console.log(`Профіль оновлено: ${user.username}`);
    });

    // Пошук користувачів
    socket.on('search users', (query) => {
        const lowerQuery = query.toLowerCase();
        const results = Object.values(registeredUsers).filter(user => 
            user.username.toLowerCase().includes(lowerQuery) || 
            user.displayName.toLowerCase().includes(lowerQuery)
        );
        socket.emit('search results', results);
    });

    // Приєднання до кімнати чату
    socket.on('join chat', (chatId) => {
        socket.join(chatId);
    });

    // Обмін повідомленнями
    socket.on('chat message', (msgData) => {
        io.to(msgData.chatId).emit('chat message', msgData);
    });

    // Відключення
    socket.on('disconnect', () => {
        console.log(`Відключився сокет: ${socket.id}`);
        // Шукаємо користувача за socketId і ставимо оффлайн
        for (let userId in registeredUsers) {
            if (registeredUsers[userId].socketId === socket.id) {
                registeredUsers[userId].online = false;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер працює на http://localhost:${PORT}`);
});
    
