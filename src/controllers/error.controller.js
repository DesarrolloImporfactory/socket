const AppError = require('../utils/appError');
const logger = require('../utils/logger');

const handleCastError23505 = () => {
  return new AppError('Duplicate field value: please use another value', 400);
};
const handleJWTExpiredError = () => {
  const err = new AppError(
    'Tu sesión ha caducado. Vuelve a iniciar sesión.',
    401,
  );
  err.code = 'TOKEN_EXPIRED';
  return err;
};

const handleJWTError = () => {
  const err = new AppError('Sesión inválida. Vuelve a iniciar sesión.', 401);
  err.code = 'TOKEN_INVALID';
  return err;
};

// body-parser (raw-body) rechaza el cuerpo ANTES de que la petición llegue al
// controlador: JSON malformado, un primitivo donde se espera un objeto, cuerpo
// demasiado grande… Esos errores traen `type` y un `status` 400/413/415, pero
// no son AppError: al no tener `isOperational` caían al else de sendErrorProd y
// el cliente recibía un 500 "Something went very wrong!" que no decía nada.
// Pasó con el botón "Buscar nuevas" de comentarios: axios manda Content-Type
// application/json por defecto, así que un post con body `null` viaja como el
// texto "null" y el parser estricto (solo objetos y arrays) lo rechaza.
const ERRORES_BODY = {
  'entity.parse.failed': 'El cuerpo de la petición no es un JSON válido.',
  'entity.too.large': 'El cuerpo de la petición es demasiado grande.',
  'request.aborted': 'La petición se cortó antes de terminar de enviarse.',
  'request.size.invalid': 'El tamaño declarado del cuerpo no coincide.',
  'encoding.unsupported': 'La codificación del cuerpo no está soportada.',
  'charset.unsupported': 'El charset del cuerpo no está soportado.',
};
const handleBodyParseError = (err) => {
  // El detalle real solo va al log: puede arrastrar el cuerpo de la petición.
  logger.error(`[BODY] ${err.type}: ${err.message}`);
  return new AppError(
    ERRORES_BODY[err.type],
    err.statusCode || err.status || 400,
  );
};


const sendErrorDev = (err, res) => {
  logger.info(err);
  res.status(err.statusCode).json({
    status: err.status,
    ...(err.code ? { code: err.code } : {}),
    message: err.message,
    stack: err.stack,
    error: err,
  });
};
const sendErrorProd = (err, res) => {
  logger.error(err.stack || err.message);
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      status: err.status,
      ...(err.code ? { code: err.code } : {}),
      message: err.message,
    });

    // Programming or other unknown error: don't leak error details
  } else {
    logger.error('UNHANDLED ERROR:', err);
    return res.status(500).json({
      status: 'fail',
      message: 'Something went very wrong! 🧨',
    });
  }
};

const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'fail';

  // El mapeo de errores conocidos se hace SIEMPRE, no sólo en producción:
  // antes, un TokenExpiredError en cualquier entorno distinto de 'production'
  // salía como 500 y el front no podía detectar la sesión caducada.
  let error = err;
  if (ERRORES_BODY[error.type]) error = handleBodyParseError(error);
  if (error.parent?.code === '23505') error = handleCastError23505();
  if (error.name === 'TokenExpiredError') error = handleJWTExpiredError();
  if (error.name === 'JsonWebTokenError') error = handleJWTError();

  // Si la respuesta ya se envió, delegamos a Express (evita ERR_HTTP_HEADERS_SENT)
  if (res.headersSent) return next(error);

  // Ojo: cualquier NODE_ENV que no sea exactamente 'development' se trata como
  // producción. Antes, con NODE_ENV vacío o mal escrito NO se enviaba NINGUNA
  // respuesta y la petición quedaba colgada hasta el timeout del cliente.
  if (process.env.NODE_ENV === 'development') {
    return sendErrorDev(error, res);
  }
  return sendErrorProd(error, res);
};

module.exports = globalErrorHandler;
