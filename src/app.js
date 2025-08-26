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
const cloudapiRouter = require('./routes/cloudapi.routes');
const etiquetasChatCenterRouter = require('./routes/etiquetas_chat_center.routes');
const etiquetasAsignadasRouter = require('./routes/etiquetas_asignadas.routes');

const plataformaRouter = require('./routes/plataformas.routes');

const clientes_chat_centerRouter = require('./routes/clientes_chat_center.routes');

const configuracionesRouter = require('./routes/configuraciones.routes');

const detalle_fact_cotRouter = require('./routes/detalle_fact_cot.routes');

const facturas_cotRouter = require('./routes/facturas_cot.routes');

const bodegaRouter = require('./routes/bodega.routes');

const openai_assistantsRouter = require('./routes/openai_assistants.routes');

const authRouter = require('./routes/auth.routes');

const userRouter = require('./routes/user.routes');

const webhookRouter = require('./routes/webhook.routes');

const chat_serviceRouter = require('./routes/chat_service.routes');

const planesRouter = require('./routes/planes.routes');

const messengerRouter = require('./routes/messenger.routes');

const usuarios_chat_centerRouter = require('./routes/usuarios_chat_center.routes');

const departamentos_chat_centerRouter = require('./routes/departamentos_chat_center.routes');

const stripeRouter = require('./routes/stripe.routes');

const stripe_webhookController = require('./controllers/stripe_webhook.controller');

const categorias_chat_centerRouter = require('./routes/categorias_chat_center.routes');

const productos_chat_centerRouter = require('./routes/productos_chat_center.routes');

const calendarsRouter = require('./routes/calendars.routes');

const appointmentsRouter = require('./routes/appointments.routes');

const debugRouter = require('./routes/debug.routes');

const googleAuthRoutes = require('./routes/google_auth.routes');

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
  stripe_webhookController.stripeWebhook
);


app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'OPTIONS', 'DELETE', 'PATCH'],
  })
);
app.use(helmet());
app.use(hpp());

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ⚠️ Para validar la firma necesitamos el raw body SOLO en el endpoint de Messenger
app.use(
  '/api/v1/messenger/webhook',
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // <- guardamos el cuerpo crudo
    },
  })
);

//Monta primero el webhook de Messenger (sin sanitizer que lo rompa)
app.use('/api/v1/messenger', messengerRouter);


// Luego el resto del stack “normal”

// Solo aplicar express.json a todo EXCEPTO al webhook de Stripe
app.use((req, res, next) => {
  if (req.originalUrl === '/api/v1/stripe_plan/stripeWebhook') {
    return next();
  }
  return express.json()(req, res, next);
});


app.use((req, res, next) => {
  const isStripeWebhook =
    req.originalUrl === '/api/v1/stripe_plan/stripeWebhook';
  if (isStripeWebhook) return next(); // ¡No aplicar sanitizer aquí!

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
app.use('/api/v1/cloudapi', cloudapiRouter);
app.use('/api/v1/plataformas', plataformaRouter);
app.use('/api/v1/clientes_chat_center', clientes_chat_centerRouter);
app.use('/api/v1/configuraciones', configuracionesRouter);
app.use('/api/v1/detalle_fact_cot', detalle_fact_cotRouter);
app.use('/api/v1/facturas_cot', facturas_cotRouter);
app.use('/api/v1/bodega', bodegaRouter);
app.use('/api/v1/openai_assistants', openai_assistantsRouter);
app.use('/api/v1/etiquetas_chat_center', etiquetasChatCenterRouter);
app.use('/api/v1/etiquetas_asignadas', etiquetasAsignadasRouter);
app.use('/api/v1/chat_service', chat_serviceRouter);
app.use('/api/v1/planes', planesRouter);
app.use('/api/v1/usuarios_chat_center', usuarios_chat_centerRouter);
app.use('/api/v1/departamentos_chat_center', departamentos_chat_centerRouter);
app.use('/api/v1/stripe_plan', stripeRouter);
app.use('/api/v1/categorias', categorias_chat_centerRouter);
app.use('/api/v1/productos', productos_chat_centerRouter);
app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));
app.use('/api/v1/calendars', calendarsRouter);
app.use('/api/v1/appointments', appointmentsRouter);
app.use('/api/v1/debug', debugRouter);
app.use('/api/v1', googleAuthRoutes);

app.all('*', (req, res, next) => {
  return next(
    new AppError(`Can't find ${req.originalUrl} on this server! 🧨`, 404)
  );
});

app.use(globalErrorHandler);
module.exports = app;
