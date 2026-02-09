const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { promisify } = require('util');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');

const jwt = require('jsonwebtoken');

/*  Este middleware protege las rutas privadas
 *  — lee primero el header Authorization: Bearer <token>
 *  — si no existe, intenta con la cookie chat_token
 */
exports.protect = catchAsync(async (req, res, next) => {
  let token;
  // 1) Getting token and check of it's there
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }
  // 3) Decode token (Verification token)
  const decoded = await promisify(jwt.verify)(
    token,
    process.env.SECRET_JWT_SEED,
  );
  // 4) Check if user still exists
  const user = await Sub_usuarios_chat_center.findOne({
    where: {
      id_sub_usuario: decoded.id_sub_usuario,
    },
  });
  if (!user) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        401,
      ),
    );
  }
  req.sessionUser = user;
  next();
});

function pickIdConfiguracion(req) {
  // soporta POST body, GET query y params
  return (
    req.body?.id_configuracion ??
    req.query?.id_configuracion ??
    req.params?.id_configuracion ??
    null
  );
}

exports.protectConfigOwner = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(pickIdConfiguracion(req));

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  // dueño = id_usuario del subusuario autenticado
  const ownerId = Number(req.sessionUser?.id_usuario);

  if (!ownerId) {
    return next(new AppError('No autenticado o sesión inválida', 401));
  }

  const cfg = await Configuraciones.findOne({
    where: {
      id: id_configuracion,
      id_usuario: ownerId,
      suspendido: 0, // opcional pero recomendado
    },
  });

  if (!cfg) {
    return next(
      new AppError('Configuración no válida o no pertenece a esta cuenta', 403),
    );
  }
  next();
});

/* exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.sessionUser.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }
    next();
  };
};
 */
