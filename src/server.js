require('dotenv').config();
const fs = require('fs');
const https = require('https');
const { db } = require('./database/config');
const chatController = require('./controllers/chat.controller');
const app = require('./app');
const initModel = require('./models/initModels');
const { Server } = require('socket.io');
const Sockets = require('./sockets/index');

// Configuración de la base de datos
db.authenticate()
  .then(() => {
    console.log('Database connected 😀');
  })
  .catch((err) => {
    console.log('Error connecting to database 😞', err);
  });

initModel();
db.sync({
  force: false,
})
  .then(() => {
    console.log('Database synced 😁');
  })
  .catch((err) => {
    console.log('Error syncing database 😞', err);
  });

// Configuración HTTPS con certificados SSL
const sslOptions = {
  key: fs.readFileSync(
    '/etc/letsencrypt/live/chat.imporfactory.app/privkey.pem'
  ),
  cert: fs.readFileSync(
    '/etc/letsencrypt/live/chat.imporfactory.app/fullchain.pem'
  ),
};

// Crear el servidor HTTPS
const server = https.createServer(sslOptions, app);

// Inicializar Socket.io con el servidor HTTPS
const io = new Server(server, {
  cors: {
    origin: 'https://chat.imporfactory.app', // Especifica el dominio permitido
    methods: ['GET', 'POST'],
    credentials: true, // Si necesitas manejar cookies o sesiones
  },
});

// Configuración del controlador de sockets
chatController.setSocketIo(io);
new Sockets(io);

// Iniciar el servidor HTTPS en el puerto especificado
server.listen(443, () => {
  console.log('Servidor HTTPS escuchando en el puerto 443');
});
