require('dotenv').config();
const { db, db_2 } = require('./database/config');
const chatController = require('./controllers/chat.controller');
const app = require('./app');
const initModel = require('./models/initModels');
const { Server } = require('socket.io');

const Sockets = require('./sockets/index');

// Gateways
const attachUnifiedGateway = require('./sockets/unified.gateway');

// Services / utils
const ChatService = require('./services/chat.service');

const MessengerService = require('./services/messenger.service');
const fb = require('./utils/facebookGraph');

const InstagramService = require('./services/instagram.service');
const ig = require('./utils/instagramGraph');

let server;
let io;
let shuttingDown = false;

async function startServer() {
  try {
    await Promise.all([db.authenticate(), db_2.authenticate()]);

    console.log('Database connected 😀');
    console.log('Database 2 connected 😀');

    initModel();

    await Promise.all([
      db.sync({ force: false }).catch((err) => {
        if (shuttingDown) {
          console.warn('Database sync aborted because shutdown started');
          return;
        }
        throw err;
      }),
      db_2.sync({ force: false }).catch((err) => {
        if (shuttingDown) {
          console.warn('Database 2 sync aborted because shutdown started');
          return;
        }
        throw err;
      }),
    ]);

    if (shuttingDown) {
      console.warn('Startup aborted due to shutdown signal');
      return;
    }

    console.log('Database synced 😁');
    console.log('Database 2 synced 😁 (API & Cursos tables created)');

    // Cron
    require('./cron/remarketing');
    require('./cron/aviso_calendarios');
    require('./cron/templateProgramadoMasivo.js');
    require('./cron/syncDropiStock.js');
    require('./cron/syncDropiOrdersHourly.js');
    require('./cron/cronEncuestasEnvio.js');
    require('./cron/metricasSnapshot.js');
    require('./cron/imporsuitEmailSync.js');

    // Server HTTP
    server = app.listen(process.env.PORT, () => {
      console.log(`Server listening on port ${process.env.PORT}`);
    });

    // Socket.IO
    io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    // ===== PRESENCE (namespace separado) =====
    const socketAuth = require('./sockets/middlewares/socketAuth.js');
    const registerPresenceHandlers = require('./sockets/presence/registerPresenceHandlers');

    // Namespace dedicado para presencia (NO interfiere con chat center)
    const presenceNs = io.of('/presence');
    global.presenceIo = presenceNs;

    // Auth SOLO para presence
    presenceNs.use(socketAuth());

    // Handlers de presence
    presenceNs.on('connection', (socket) => {
      console.log('[PRESENCE] CONNECT', socket.user?.id_sub_usuario, socket.id);
      registerPresenceHandlers(presenceNs, socket);
    });

    // Controller socket reference
    chatController.setSocketIo(io);

    // Sockets base (GET_CHATS, etc.)
    new Sockets(io);

    // Inyectar io a servicios que emiten desde webhooks
    MessengerService.setIO(io);
    InstagramService.setIO(io);

    // ✅ Unified gateway (envío WA/MS/IG por un solo lugar)
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
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}

startServer();

// ─── Process-level error handlers ───────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  // Dar tiempo para logs y luego cerrar
  setTimeout(() => process.exit(1), 1000);
});

// ─── Graceful shutdown ──────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  console.log(`\n🔄 ${signal} received. Shutting down gracefully...`);
  shuttingDown = true;
  try {
    if (server) {
      server.close();
    }
    await db.close();
    await db_2.close();
    console.log('✅ All connections closed.');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
