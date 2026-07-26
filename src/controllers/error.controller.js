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
