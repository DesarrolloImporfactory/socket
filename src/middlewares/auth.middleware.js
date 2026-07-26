const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const { db, db_2 } = require('../database/config');

const jwt = require('jsonwebtoken');

/*  Este middleware protege las rutas privadas
 *  — lee el header Authorization: Bearer <token>
 *
 *  IMPORTANTE: todos los 401 de sesión de este middleware devuelven un `code`
 *  explícito (TOKEN_MISSING | TOKEN_EXPIRED | TOKEN_INVALID | USER_NOT_FOUND |
 *  TOKEN_REVOKED). El front (interceptor de chatcenter.js) se apoya en ese
 *  `code` para saber que la sesión murió y avisar + limpiar + redirigir.
 *  NO depender del error handler global para esto: hay 401 en la app que NO son
 *  de sesión (contraseña actual incorrecta, token de Shopify inválido,
 *  permisos de configuración…) y esos no deben expulsar al usuario.
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
    return res.status(401).json({
      status: 'fail',
      code: 'TOKEN_MISSING',
      message: 'No has iniciado sesión. Inicia sesión para continuar.',
    });
  }

  // 3) Decode token (Verification token)
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.SECRET_JWT_SEED);
  } catch (err) {
    const expirado = err.name === 'TokenExpiredError';
    return res.status(401).json({
      status: 'fail',
      code: expirado ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      message: expirado
        ? 'Tu sesión ha caducado. Vuelve a iniciar sesión.'
        : 'Sesión inválida. Vuelve a iniciar sesión.',
    });
  }

  // 4) Check if user still exists
  const user = await Sub_usuarios_chat_center.findOne({
    where: {
      id_sub_usuario: decoded.id_sub_usuario,
    },
  });
  if (!user) {
    return res.status(401).json({
      status: 'fail',
      code: 'USER_NOT_FOUND',
      message: 'El usuario de esta sesión ya no existe.',
    });
  }

  // 5) Single sign-out: si users.logout_at > iat, el token fue revocado.
  // Mapeamos por email (no por id_usuario): id_usuario es de la BD chatcenter
  // y NO corresponde al id_users de imporsuit. El email sí es común a ambas BDs.
  const email = user.email;
  const usuario = user.usuario;
  const iat = decoded.iat;
  if ((email || usuario) && iat) {
    try {
      const [row] = await db_2.query(
        `SELECT UNIX_TIMESTAMP(logout_at) AS ts
           FROM users
          WHERE email_users = ? OR usuario_users = ?
          LIMIT 1`,
        {
          replacements: [email || '', usuario || email || ''],
          type: db_2.QueryTypes.SELECT,
        },
      );
      const logoutAt = row && row.ts ? Number(row.ts) : 0;
      if (logoutAt > iat) {
        return res.status(401).json({
          status: 'fail',
          code: 'TOKEN_REVOKED',
          message: 'Sesión cerrada en otro dispositivo',
        });
      }
    } catch (err) {
      // fail-open: si la consulta falla no bloqueamos al usuario
      console.warn('protect: error consultando users.logout_at —', err.message);
    }
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

// Restringe a super_administrador (usa la columna `rol` del sub-usuario).
// Requiere haber pasado antes por auth.protect (setea req.sessionUser).
exports.requireSuperAdmin = catchAsync(async (req, res, next) => {
  const rol = req.sessionUser?.rol;
  if (rol !== 'super_administrador') {
    return next(
      new AppError('Acción permitida solo para super administradores', 403),
    );
  }
  next();
});

// Si viene id_log, resuelve su id_configuracion y lo inyecta al body
// para que protectConfigOwner valide la propiedad normalmente.
// (el flujo retry desde el front manda solo { id_log })
exports.resolverConfigDesdeLog = catchAsync(async (req, res, next) => {
  const idLog = Number(req.body?.id_log);
  if (idLog && !req.body?.id_configuracion) {
    const [row] = await db.query(
      `SELECT id_configuracion FROM dropi_auto_ordenes_log WHERE id = ? LIMIT 1`,
      { replacements: [idLog], type: db.QueryTypes.SELECT },
    );
    if (!row) return next(new AppError(`No existe log #${idLog}`, 404));
    req.body.id_configuracion = row.id_configuracion;
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
