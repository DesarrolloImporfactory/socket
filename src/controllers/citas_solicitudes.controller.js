const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const servicio = require('../services/citas_solicitudes.service');

/* Bandeja de solicitudes de cita: lo que el bot levantó y todavía no existe en
   el calendario. Ver el detalle de por qué existe esto en
   services/citas_solicitudes.service.js. */

exports.listar = catchAsync(async (req, res, next) => {
  const { id_configuracion, estado, limite } = req.body;
  if (!id_configuracion) return next(new AppError('Falta id_configuracion', 400));

  const data = await servicio.listarSolicitudes({
    id_configuracion,
    estado,
    limite,
  });

  return res.status(200).json({
    status: 'success',
    data,
    pendientes: await servicio.contarPendientes(id_configuracion),
  });
});

exports.confirmar = catchAsync(async (req, res, next) => {
  const { id, id_configuracion, inicio, duracion_minutos, nombre, telefono, notas } =
    req.body;

  if (!id || !id_configuracion) {
    return next(new AppError('Faltan id e id_configuracion', 400));
  }

  const r = await servicio.confirmarSolicitud({
    id,
    id_configuracion,
    inicio,
    duracion_minutos,
    nombre,
    telefono,
    notas,
    id_usuario: req.sessionUser?.id_usuario || req.sessionUser?.id || null,
  });

  /* Los choques de horario vuelven como 409 y no como 500: es la respuesta más
     común de todas —quien confirma elige una hora que ya estaba tomada— y
     merece un mensaje que se pueda mostrar tal cual, no un "error interno". */
  if (!r.ok) {
    return next(new AppError(r.motivo || 'No se pudo crear la cita', 409));
  }

  return res.status(200).json({ status: 'success', data: r });
});

exports.descartar = catchAsync(async (req, res, next) => {
  const { id, id_configuracion, motivo } = req.body;
  if (!id || !id_configuracion) {
    return next(new AppError('Faltan id e id_configuracion', 400));
  }

  const r = await servicio.descartarSolicitud({
    id,
    id_configuracion,
    motivo,
    id_usuario: req.sessionUser?.id_usuario || req.sessionUser?.id || null,
  });

  return res.status(200).json({ status: 'success', data: r });
});
