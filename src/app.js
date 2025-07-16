const AppError = require('./utils/appError');
const cors = require('cors');
const express = require('express');
const globalErrorHandler = require('./controllers/error.controller');
const helmet = require('helmet');
const hpp = require('hpp');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const sanitizer = require('perfect-express-sanitizer');
const cookieParser = require('cookie-parser');

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

const authRouter = require('./routes/auth.routes');

const userRouter = require('./routes/user.routes');

const webhookRouter = require('./routes/webhook.routes');

const chat_serviceRouter = require('./routes/chat_service.routes');

const app = express();

const limiter = rateLimit({
  max: 100000,
  windowMs: 60 * 60 * 1000,

  message: 'Too many requests from this IP, please try again in an hour!',
});

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'OPTIONS', 'DELETE'],
  })
);
app.use(helmet());
app.use(hpp());
app.use(express.json());

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}
app.use(
  sanitizer.clean({
    xss: true,
    noSql: true,
    sql: false,
  })
);
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
app.use('/api/v1/etiquetas_chat_center', etiquetasChatCenterRouter);
app.use('/api/v1/etiquetas_asignadas', etiquetasAsignadasRouter);
app.use('/api/v1/chat_service', chat_serviceRouter);

app.all('*', (req, res, next) => {
  return next(
    new AppError(`Can't find ${req.originalUrl} on this server! 🧨`, 404)
  );
});

app.use(globalErrorHandler);
module.exports = app;
