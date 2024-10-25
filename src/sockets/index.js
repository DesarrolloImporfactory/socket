const ChatService = require('../services/chat.service');

const onlineUsers = [];

class Sockets {
  constructor(io) {
    this.io = io;
    this.socketEvents();
  }

  addUser(user, socketId) {
    const exists = onlineUsers.find((u) => u.id === user.id);
    if (!exists) {
      onlineUsers.push({ ...user, socketId });
    }
  }

  removeUser(socketId) {
    const index = onlineUsers.findIndex((user) => user.socketId === socketId);
    if (index !== -1) {
      onlineUsers.splice(index, 1); // Eliminar usuario desconectado
    }
  }

  socketEvents() {
    this.io.on('connection', (socket) => {
      socket.on('ADD_USER', (data) => {
        this.addUser(data, socket.id);
        this.io.emit('USER_ADDED', onlineUsers);
      });

      socket.on('GET_CHATS', async (id_plataforma) => {
        console.log(id_plataforma);
        const chatService = new ChatService();
        const chat = await chatService.findChats(id_plataforma);

        socket.emit('CHATS', chat);
      });

      socket.on('GET_CHATS_BOX', async ({ chatId, plataforma }) => {
        try {
          console.log(chatId, plataforma);
          const chatService = new ChatService();
          const chat = await chatService.getChatsByClient(chatId, plataforma);
          console.log(chat);
          // Enviar el chat al cliente que hizo la solicitud
          socket.emit('CHATS_BOX_RESPONSE', chat);
        } catch (error) {
          console.error('Error al obtener los chats:', error.message);

          // Enviar mensaje de error al cliente en caso de fallo
          socket.emit('ERROR_RESPONSE', {
            message: 'Error al obtener los chats. Intenta de nuevo más tarde.',
          });
        }
      });

      socket.on('disconnect', () => {
        this.removeUser(socket.id);
        this.io.emit('USER_ADDED', onlineUsers); // Actualizar lista
      });
    });
  }
}

module.exports = Sockets;
