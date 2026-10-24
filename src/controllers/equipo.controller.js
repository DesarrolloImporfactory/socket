const jwt = require('jsonwebtoken');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const { esEquipo, puedeTenerRolEquipo } = require('../utils/rolEquipo');

/*  Rutas de Team para el rol «equipo» (ver utils/rolEquipo.js). */

const DURACION_SESION = '8h';

/*  POST /api/v1/equipo/sesion — servidor de Team, con TEAM_EQUIPO_TOKEN.
 *  Team ya validó a su usuario y dice qué sub-usuario de IMPORCHAT le toca.
 *  Solo se emite para un sub-usuario vigente, con rol «equipo» y de una cuenta
 *  autorizada (ROL_EQUIPO_CUENTAS). El token lleva `origen: 'team'`: protect
 *  lo limita a /api/v1/equipo/ y le tapa los teléfonos.
 */
exports.sesion = catchAsync(async (req, res, next) => {
  const id_sub_usuario = Number(req.body?.id_sub_usuario);
  const team_usuario = String(req.body?.team_usuario || '').slice(0, 80);
  if (!Number.isInteger(id_sub_usuario) || id_sub_usuario <= 0) {
    return next(new AppError('id_sub_usuario es requerido', 400));
  }

  const sub = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);
  const motivo = !sub
    ? 'NO_EXISTE'
    : Number(sub.suspendido) === 1
      ? 'SUSPENDIDO'
      : !esEquipo(sub)
        ? 'SIN_ROL_EQUIPO'
        : !puedeTenerRolEquipo(sub.id_usuario)
          ? 'CUENTA_NO_HABILITADA'
          : null;

  console.log(
    '[EQUIPO_SESION]',
    JSON.stringify({ id_sub_usuario, team_usuario, ok: !motivo, motivo }),
  );
  if (motivo) {
    // Un solo mensaje para todos los casos: no dice qué sub-usuarios existen.
    return next(new AppError('Este usuario no puede entrar desde Team.', 403));
  }

  const token = jwt.sign(
    {
      id_sub_usuario,
      id_usuario: Number(sub.id_usuario),
      rol: sub.rol,
      nombre_encargado: sub.nombre_encargado,
      origen: 'team',
    },
    process.env.SECRET_JWT_SEED,
    { expiresIn: DURACION_SESION },
  );

  res.json({ status: 'success', token, expira_en: DURACION_SESION });
});

/*  GET /api/v1/equipo/yo — con la sesión de Team. Quién soy. */
exports.yo = catchAsync(async (req, res) => {
  const u = req.sessionUser;
  res.json({
    status: 'success',
    data: {
      id_sub_usuario: u.id_sub_usuario,
      id_usuario: u.id_usuario,
      nombre_encargado: u.nombre_encargado,
      rol: u.rol,
    },
  });
});
