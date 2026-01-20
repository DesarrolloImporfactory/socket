require('dotenv').config();
const { db } = require('./database/config');
const chatController = require('./controllers/chat.controller');
const app = require('./app');
const initModel = require('./models/initModels');
const { Server } = require('socket.io');

const Sockets = require('./sockets/index');

// Gateways
// const attachMessengerGateway = require('./sockets/messenger.gateway');
// const attachInstagramGateway = require('./sockets/instagram.gateway');
const attachUnifiedGateway = require('./sockets/unified.gateway');

// Services / utils
const ChatService = require('./services/chat.service');

const MessengerService = require('./services/messenger.service');
const Store = require('./services/messenger_store.service');
const fb = require('./utils/facebookGraph');

const InstagramService = require('./services/instagram.service');
const IGStore = require('./services/instagram_store.service');
const ig = require('./utils/instagramGraph'); // ✅ IMPORTANTE

db.authenticate()
  .then(() => console.log('Database connected 😀'))
  .catch((err) => console.log('Error connecting to database 😞', err));

initModel();

db.sync({ force: false })
  .then(() => console.log('Database synced 😁'))
  .catch((err) => console.log('Error syncing database 😞', err));

// Cron
require('./cron/remarketing');
require('./cron/aviso_calendarios');

// Server HTTP
const server = app.listen(process.env.PORT, () => {
  console.log(`Server listening on port ${process.env.PORT}`);
});

// Socket.IO
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Controller socket reference
chatController.setSocketIo(io);

// Sockets base (WA y otros eventos existentes)
new Sockets(io);

// Inyectar io a servicios que emiten desde webhooks
MessengerService.setIO(io);
InstagramService.setIO(io);

// ✅ Gateway Messenger (legacy / actual)
// attachMessengerGateway(io, {
//   Store,
//   fb,
//   db,
//   getPageTokenByPageId: async (page_id) => {
//     const [row] = await db.query(
//       `SELECT page_access_token
//          FROM messenger_pages
//         WHERE page_id = ? AND status = 'active'
//         LIMIT 1`,
//       { replacements: [page_id], type: db.QueryTypes.SELECT },
//     );
//     return row?.page_access_token || null;
//   },
//   getConfigIdByPageId: async (page_id) => {
//     const [row] = await db.query(
//       `SELECT id_configuracion
//          FROM messenger_pages
//         WHERE page_id = ? AND status='active'
//         LIMIT 1`,
//       { replacements: [page_id], type: db.QueryTypes.SELECT },
//     );
//     return row?.id_configuracion || null;
//   },
// });

// ✅ Gateway Instagram (legacy / actual)
// attachInstagramGateway(io, {
//   db,
//   IGStore,
//   getPageTokenByPageId: InstagramService.getPageTokenByPageId,
// });

attachUnifiedGateway(io, {
  db,
  fb,
  ig,
  chatService: new ChatService(),
  getPageTokenByPageId: async (page_id, source) => {
    if (source === 'ms') {
      const [row] = await db.query(
        `SELECT page_access_token
           FROM messenger_pages
          WHERE page_id = ? AND status='active'
          LIMIT 1`,
        { replacements: [page_id], type: db.QueryTypes.SELECT },
      );
      return row?.page_access_token || null;
    }

    if (source === 'ig') {
      const [row] = await db.query(
        `SELECT page_access_token
           FROM instagram_pages
          WHERE page_id = ? AND status='active'
          LIMIT 1`,
        { replacements: [page_id], type: db.QueryTypes.SELECT },
      );
      return row?.page_access_token || null;
    }

    return null;
  },
});
