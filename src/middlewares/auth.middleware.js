const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Configuraciones = require('../models/configuraciones.model');
const { db } = require('../database/config');
const { sesionVigente } = require('../utils/sesionVigente');
const {
  esEquipo,
  sesionTeamValida,
  rutaPermitidaEquipo,
  envolverParaEquipo,
} = require('../utils/rolEquipo');

const jwt = require('jsonwebtoken');

const MENSAJES_SESION = {
  USER_NOT_FOUND: 'El usuario de esta sesión ya no existe.',
  USER_SUSPENDED: 'Tu acceso está suspendido. Habla con tu administrador.',
  TOKEN_REVOKED: 'Sesión cerrada en otro dispositivo',
  EQUIPO_SOLO_TEAM: 'Tu usuario entra solo desde Team.',
};

/*  Este middleware protege las rutas privadas
 *  — lee el header Authorization: Bearer <token>
 *
 *  IMPORTANTE: todos los 401 de sesión de este middleware devuelven un `code`
 *  explícito (TOKEN_MISSING | TOKEN_EXPIRED | TOKEN_INVALID | USER_NOT_FOUND |
 *  USER_SUSPENDED | TOKEN_REVOKED). El front (interceptor de chatcenter.js) se apoya en ese
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

  // 4-5) El usuario existe, no está suspendido y no cerró sesión en otro
  // lado (ver utils/sesionVigente.js; la misma comprobación usa el socket).
  const { ok, code, user } = await sesionVigente(decoded);
  if (!ok) {
    return res.status(401).json({
      status: 'fail',
      code,
      message: MENSAJES_SESION[code],
    });
  }

  // Rol «equipo» (ver utils/rolEquipo.js): solo con la sesión de Team, solo
  // rutas de /api/v1/equipo/ y con los teléfonos tapados en la respuesta.
  // Una sesión de Team tampoco sirve si al usuario le quitaron el rol (con otro
  // rol vería los teléfonos y todas las rutas), si la cuenta salió de
  // ROL_EQUIPO_CUENTAS o si el token no trae el sello de Team.
  if (esEquipo(user) || decoded.origen === 'team') {
    if (!sesionTeamValida(decoded, user)) {
      return res.status(401).json({
        status: 'fail',
        code: 'EQUIPO_SOLO_TEAM',
        message: MENSAJES_SESION.EQUIPO_SOLO_TEAM,
      });
    }
    if (!rutaPermitidaEquipo(req.originalUrl)) {
      return res.status(403).json({
        status: 'fail',
        code: 'EQUIPO_RUTA_NO_PERMITIDA',
        message: 'Tu rol no tiene acceso a esta sección',
      });
    }
    envolverParaEquipo(res);
    // Las rutas de Team miran esto, no el rol: un sub-usuario de prueba
    // (ROL_EQUIPO_PRUEBA_SUBS) entra con su rol de siempre.
    req.sesionTeam = true;
    // «Ver como» de gerencia: la sesión no sirve para enviar.
    req.sesionTeamSoloLectura = decoded.solo_lectura === true;
    req.sesionTeamUsuario = String(decoded.team_usuario || '').slice(0, 80);
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
