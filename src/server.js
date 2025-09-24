require('dotenv').config();
const { db } = require('./database/config');
const chatController = require('./controllers/chat.controller');
const app = require('./app');
const initModel = require('./models/initModels');
const { Server } = require('socket.io');

const attachMessengerGateway = require('./sockets/messenger.gateway');
const MessengerService = require('./services/messenger.service');
const Store = require('./services/messenger_store.service');
const fb = require('./utils/facebookGraph');

const attachInstagramGateway = require('./sockets/instagram.gateway');
const InstagramService = require('./services/instagram.service');
const IGStore = require('./services/instagram_store.service');

const Sockets = require('./sockets/index');

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

// Aquí ejecutamos el cron de remarketing
require('./cron/remarketing');

// Se agrega el puerto desde las variables de entorno -😁
const server = app.listen(process.env.PORT, () => {
  console.log(`Server listening on port ${process.env.PORT}`);
});

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

chatController.setSocketIo(io);

new Sockets(io);

//inyecta io al servicio de Messenger para emitir desde webhook
MessengerService.setIO(io);

//adjunta el gateway de Messenger (eventos MS_JOIN_CONV / MS_SEND ..)
attachMessengerGateway(io, {
  Store,
  fb,
  db,
  //helpers que usa el gateway para enviar mensajes y mapear cfg:
  getPageTokenByPageId: async (page_id) => {
    const [row] = await db.query(
      `SELECT page_access_token
        FROM messenger_pages
        WHERE page_id = ? AND status = 'active'
        LIMIT 1`,
      {
        replacements: [page_id],
        type: db.QueryTypes.SELECT,
      }
    );
    return row?.page_access_token || null;
  },
  getConfigIdByPageId: async (page_id) => {
    const [row] = await db.query(
      `SELECT id_configuracion FROM messenger_pages
      WHERE page_id = ? AND status='active' LIMIT 1`,
      { replacements: [page_id], type: db.QueryTypes.SELECT }
    );
    return row?.id_configuracion || null;
  },
});

InstagramService.setIO(io);
attachInstagramGateway(io, {
  db,
  IGStore,
  getIGPageTokenByPageId: InstagramService.getPageTokenByPageId,
});
