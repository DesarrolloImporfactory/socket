const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const notificaciones = require('../services/notificaciones.service');

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* Todas las rutas trabajan sobre las notificaciones DEL USUARIO de la sesión:
   id_configuracion solo filtra cuáles de las suyas ve (las de esa cuenta y las
   generales), nunca le da acceso a las de otro. */

// GET /notificaciones?id_configuracion=&solo_no_leidas=1&limit=&offset=
exports.listar = catchAsync(async (req, res) => {
  const id_sub_usuario = req.sessionUser.id_sub_usuario;
  const id_configuracion = toInt(req.query.id_configuracion);
  const limit = Math.min(50, toInt(req.query.limit) || 20);
  const offset = toInt(req.query.offset) || 0;

  const [lista, no_leidas] = await Promise.all([
    notificaciones.listar({
      id_sub_usuario,
      id_configuracion,
      soloNoLeidas: String(req.query.solo_no_leidas || '') === '1',
      limit,
      offset,
    }),
    notificaciones.contarNoLeidas({ id_sub_usuario, id_configuracion }),
  ]);

  res.json({
    isSuccess: true,
    data: { ...lista, no_leidas },
  });
});

// GET /notificaciones/conteo?id_configuracion=   (lo consulta la campana)
exports.conteo = catchAsync(async (req, res) => {
  const no_leidas = await notificaciones.contarNoLeidas({
    id_sub_usuario: req.sessionUser.id_sub_usuario,
    id_configuracion: toInt(req.query.id_configuracion),
  });
  res.json({ isSuccess: true, data: { no_leidas } });
});

// PATCH /notificaciones/:id/leida
exports.marcarLeida = catchAsync(async (req, res, next) => {
  const id = toInt(req.params.id);
  if (!id) return next(new AppError('id inválido', 400));
  await notificaciones.marcarLeida({
    id_sub_usuario: req.sessionUser.id_sub_usuario,
    id,
  });
  res.json({ isSuccess: true });
});

// POST /notificaciones/leer-todas  { id_configuracion? }
exports.marcarTodasLeidas = catchAsync(async (req, res) => {
  await notificaciones.marcarTodasLeidas({
    id_sub_usuario: req.sessionUser.id_sub_usuario,
    id_configuracion: toInt(req.body?.id_configuracion),
  });
  res.json({ isSuccess: true });
});
