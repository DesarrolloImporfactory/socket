// controllers/kanban_retiro_agencia.controller.js
// Switch "el bot ofrece retiro en agencia Servientrega" (piloto: config 10).
// Ver el encabezado de services/kanban_retiro_agencia.service.js para el
// detalle de qué mueve cada acción.

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const retiroAgencia = require('../services/kanban_retiro_agencia.service');

function validarIdConfig(req, next) {
  const id = Number(req.body?.id_configuracion);
  if (!id) {
    next(new AppError('Falta id_configuracion', 400));
    return null;
  }
  return id;
}

/* POST /kanban_columnas/retiro_agencia_estado  { id_configuracion } */
exports.estado = catchAsync(async (req, res, next) => {
  const id = validarIdConfig(req, next);
  if (!id) return;
  const data = await retiroAgencia.estado(id);
  res.status(200).json({ success: true, data });
});

/* POST /kanban_columnas/retiro_agencia_toggle  { id_configuracion, activo }
   Responde AL INSTANTE y el trabajo (subir/indexar el archivo + parchear los
   prompts) corre en segundo plano: puede tardar 30-60s y el axios del front
   corta antes. El front consulta retiro_agencia_estado hasta que
   data.trabajo.en_curso sea false. */
exports.toggle = catchAsync(async (req, res, next) => {
  const id = validarIdConfig(req, next);
  if (!id) return;

  if (!retiroAgencia.enPiloto(id)) {
    return next(
      new AppError('Esta función está en piloto y tu cuenta aún no la tiene', 403),
    );
  }

  const activo = Boolean(req.body?.activo);
  const id_sub_usuario = req.user?.id_sub_usuario || req.user?.id || null;

  try {
    retiroAgencia.lanzarToggle(id, activo, id_sub_usuario);
  } catch (e) {
    // Ya hay un trabajo corriendo para esta config (doble clic / doble pestaña)
    return next(new AppError(e.message, 409));
  }

  res.status(200).json({
    success: true,
    procesando: true,
    message: activo
      ? 'Activando: indexando el directorio de agencias en el asistente…'
      : 'Desactivando el retiro en agencia…',
    data: await retiroAgencia.estado(id),
  });
});

/* POST /kanban_columnas/retiro_agencia_preview  { id_configuracion }
   Devuelve el texto del archivo que el bot consulta — la respuesta a
   "¿por qué mi bot no ofreció tal agencia?". */
exports.preview = catchAsync(async (req, res, next) => {
  const id = validarIdConfig(req, next);
  if (!id) return;

  const contenido = await retiroAgencia.contenidoArchivo(id);
  if (!contenido) {
    return next(
      new AppError(
        'No hay archivo de agencias disponible para esta configuración',
        404,
      ),
    );
  }
  res.status(200).json({ success: true, data: contenido });
});
