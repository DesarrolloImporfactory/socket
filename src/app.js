const AppError = require('./utils/appError');
const cors = require('cors');
const express = require('express');
const globalErrorHandler = require('./controllers/error.controller');
const helmet = require('helmet');
const hpp = require('hpp');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const sanitizer = require('perfect-express-sanitizer');

const productRouter = require('./routes/product.routes');
const whatsappRouter = require('./routes/whatsapp.routes');
const etiquetasChatCenterRouter = require('./routes/etiquetas_chat_center.routes');
const etiquetasAsignadasRouter = require('./routes/etiquetas_asignadas.routes');

const plataformaRouter = require('./routes/plataformas.routes');

const clientes_chat_centerRouter = require('./routes/clientes_chat_center.routes');

const configuracionesRouter = require('./routes/configuraciones.routes');

const detalle_fact_cotRouter = require('./routes/detalle_fact_cot.routes');

const facturas_cotRouter = require('./routes/facturas_cot.routes');

const bodegaRouter = require('./routes/bodega.routes');

const openai_assistantsRouter = require('./routes/openai_assistants.routes');

const remarketing_pendientesRouter = require('./routes/remarketing_pendientes.routes');

const authRouter = require('./routes/auth.routes');

const userRouter = require('./routes/user.routes');

const webhookRouter = require('./routes/webhook.routes');

const dropiWebhookRouter = require('./routes/dropi_webhook.routes');

const chat_serviceRouter = require('./routes/chat_service.routes');

const planesRouter = require('./routes/planes.routes');

const messengerRouter = require('./routes/messenger.routes');

const tikTokRouter = require('./routes/tiktok.routes');

const usuarios_chat_centerRouter = require('./routes/usuarios_chat_center.routes');

const departamentos_chat_centerRouter = require('./routes/departamentos_chat_center.routes');

const stripeRouter = require('./routes/stripe_plan.routes');

const stripe_webhookController = require('./controllers/stripe_webhook.controller');

const stripe_pago_webhookController = require('./controllers/stripe_pago_webhook.controller');

const categorias_chat_centerRouter = require('./routes/categorias_chat_center.routes');

const productos_chat_centerRouter = require('./routes/productos_chat_center.routes');

const automatizadorRouter = require('./routes/automatizador.routes');

const calendarsRouter = require('./routes/calendars.routes');

const appointmentsRouter = require('./routes/appointments.routes');

const debugRouter = require('./routes/debug.routes');

const googleAuthRoutes = require('./routes/google_auth.routes');

const pedidosRouter = require('./routes/pedidos.routes');

const webhook_meta_whatsappRouter = require('./routes/webhook_meta_whatsapp.routes');

const instagramRouter = require('./routes/instagram.routes');

const stripeproRouter = require('./routes/stripepro.routes');

const stripeproPagosRouter = require('./routes/stripepro_pagos.routes');

const droppiIntegrationsRouter = require('./routes/dropi_integrations.routes');

const cotizacionesRouter = require('./routes/cotizaciones.routes');
const mediaRouter = require('./routes/media.routes');

const path = require('path');

const app = express();

const limiter = rateLimit({
  max: 100000,
  windowMs: 60 * 60 * 1000,

  message: 'Too many requests from this IP, please try again in an hour!',
});

// WEBHOOK: este debe ir antes del body parser y fuera del router
app.post(
  '/api/v1/stripe_plan/stripeWebhook',
  express.raw({ type: 'application/json' }),
  stripe_webhookController.stripeWebhook,
);

app.post(
  '/api/v1/stripe_plan_pago/webhook',
  express.raw({ type: 'application/json' }),
  stripe_pago_webhookController.stripeWebhook,
);

app.use(helmet());

app.use(hpp());

const allowlist = [
  'https://automatizador.imporsuitpro.com',
  'https://chatcenter.imporfactory.app',
  'https://new.imporsuitpro.com',
  'https://desarrollo.imporsuitpro.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'https://dev.imporfactory.app',
];

// helper para comprobar si la petición trae cookies/credenciales desde el cliente
function requestIsCredentialed(req) {
  // heurística: si el cliente envía una cabecera 'Cookie' o la petición viene con Authorization,
  // lo tratamos como credentialed. En frontends normalmente será withCredentials: true.
  return !!(
    req.get('Cookie') ||
    req.get('Authorization') ||
    req.get('X-Requested-With')
  );
}

if (process.env.NODE_ENV === 'prod') {
  app.use(morgan('production'));

  // middleware CORS dinámico
  app.use((req, res, next) => {
    const origin = req.get('Origin');

    if (!origin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, OPTIONS, DELETE, PATCH',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Timestamp, X-Requested-With',
      );
      return next();
    }

    const isTrusted = allowlist.includes(origin);
    const isCredentialed = requestIsCredentialed(req);

    if (isTrusted) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, OPTIONS, DELETE, PATCH',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Timestamp, X-Requested-With',
      );

      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, OPTIONS, DELETE, PATCH',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Timestamp, X-Requested-With',
      );

      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    }

    if (isCredentialed) {
      return res.status(403).json({
        success: false,
        message: 'CORS: origin no permitido para requests con credenciales',
      });
    }
  });
} else if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
  app.use(cors({ origin: true, credentials: true }));
}

// ⚠️ Para validar la firma necesitamos el raw body SOLO en el endpoint de Messenger
app.use(
  '/api/v1/messenger/webhook',
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // <- guardamos el cuerpo crudo
    },
  }),
);

//Para ig necesitamos el raw body solo en su webhoook
app.use(
  '/api/v1/instagram/webhook',
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

//Raw body solo para TikTok Webhook(necesario para validar firma)
app.use(
  '/api/v1/tiktok/webhook/receive',
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Solo aplicar express.json a todo EXCEPTO al webhook de Stripe y Messenger e Instagram
app.use((req, res, next) => {
  // Usa req.path para no fallar por querystrings
  const skipPaths = [
    '/api/v1/stripe_plan/stripeWebhook',
    '/api/v1/messenger/webhook',
    '/api/v1/instagram/webhook',
    '/api/v1/tiktok/webhook/receive',
    '/api/v1/stripe_plan_pago/webhook',
  ];
  if (skipPaths.includes(req.path)) return next();
  return express.json()(req, res, next);
});

//Sanitizer para TODO lo demás (no tocar webhooks)
app.use((req, res, next) => {
  const skipPaths = [
    '/api/v1/stripe_plan/stripeWebhook',
    '/api/v1/messenger/webhook',
    '/api/v1/instagram/webhook',
    '/api/v1/tiktok/webhook/receive',
    '/api/v1/stripe_plan_pago/webhook',
  ];
  if (skipPaths.includes(req.path)) return next();

  return sanitizer.clean({
    xss: true,
    noSql: true,
    sql: false,
  })(req, res, next);
});

app.use('/api/v1', limiter);
// routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/whatsapp', webhookRouter);
app.use('/api/v1/product', productRouter);
app.use('/api/v1/whatsapp_managment', whatsappRouter);
app.use('/api/v1/plataformas', plataformaRouter);
app.use('/api/v1/clientes_chat_center', clientes_chat_centerRouter);
app.use('/api/v1/configuraciones', configuracionesRouter);
app.use('/api/v1/detalle_fact_cot', detalle_fact_cotRouter);
app.use('/api/v1/facturas_cot', facturas_cotRouter);
app.use('/api/v1/bodega', bodegaRouter);
app.use('/api/v1/openai_assistants', openai_assistantsRouter);
app.use('/api/v1/remarketing', remarketing_pendientesRouter);
app.use('/api/v1/etiquetas_chat_center', etiquetasChatCenterRouter);
app.use('/api/v1/etiquetas_asignadas', etiquetasAsignadasRouter);
app.use('/api/v1/chat_service', chat_serviceRouter);
app.use('/api/v1/planes', planesRouter);
app.use('/api/v1/usuarios_chat_center', usuarios_chat_centerRouter);
app.use('/api/v1/departamentos_chat_center', departamentos_chat_centerRouter);
app.use('/api/v1/stripe_plan', stripeRouter);
app.use('/api/v1/categorias', categorias_chat_centerRouter);
app.use('/api/v1/productos', productos_chat_centerRouter);
app.use('/api/v1/automatizador', automatizadorRouter);
app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));
app.use('/api/v1/calendars', calendarsRouter);
app.use('/api/v1/appointments', appointmentsRouter);
app.use('/api/v1/debug', debugRouter);
app.use('/api/v1', googleAuthRoutes);
app.use('/api/v1/pedidos', pedidosRouter);
app.use('/api/v1/messenger', messengerRouter);
app.use('/api/v1/tiktok', tikTokRouter);
app.use('/api/v1/webhook_meta', webhook_meta_whatsappRouter);
app.use('/api/v1/instagram', instagramRouter);
app.use('/api/v1/stripepro', stripeproRouter);
app.use('/api/v1/stripepro_pagos', stripeproPagosRouter);
app.use('/api/v1/dropi_integrations', droppiIntegrationsRouter);
app.use('/api/v1/cotizaciones', cotizacionesRouter);
app.use('/api/v1/dropi_webhook', dropiWebhookRouter);
app.use('/api/v1/media', mediaRouter);

app.all('*', (req, res, next) => {
  return next(
    new AppError(`Can't find ${req.originalUrl} on this server! 🧨`, 404),
  );
});

app.use(globalErrorHandler);
module.exports = app;
