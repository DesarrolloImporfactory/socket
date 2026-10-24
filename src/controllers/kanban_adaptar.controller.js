/* Rutas de "Adaptar el bot a mi negocio". Van montadas bajo
   /kanban_plantillas/adaptar/* a propósito: ese prefijo ya está exento del
   sanitizador de app.js, y la ficha y los prompts llevan texto con "<" y
   corchetes que el sanitizador mutilaría. */

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const adaptar = require('../services/kanban_adaptar.service');

const idConfigDe = (req) => {
  const id = Number(req.body?.id_configuracion);
  return Number.isFinite(id) && id > 0 ? id : null;
};

const pasarError = (next, err) =>
  next(
    err instanceof AppError
      ? err
      : Object.assign(new AppError(err.message, err.statusCode || 500), {
          code: err.code,
        }),
  );

exports.cuestionario = catchAsync(async (req, res) => {
  // Con cuenta, la pregunta del modelo trae las opciones de su proveedor.
  const data = await adaptar.cuestionarioPara(idConfigDe(req));
  res.json({ success: true, data });
});

exports.estado = catchAsync(async (req, res, next) => {
  const id_configuracion = idConfigDe(req);
  if (!id_configuracion) return next(new AppError('Falta id_configuracion', 400));
  try {
    res.json({ success: true, data: await adaptar.estado(id_configuracion) });
  } catch (err) {
    pasarError(next, err);
  }
});

exports.comprender = catchAsync(async (req, res, next) => {
  const id_configuracion = idConfigDe(req);
  if (!id_configuracion) return next(new AppError('Falta id_configuracion', 400));
  const respuestas = req.body?.respuestas;
  if (!respuestas || typeof respuestas !== 'object')
    return next(new AppError('Faltan las respuestas del cuestionario', 400));
  if (!String(respuestas.que_ofreces || '').trim())
    return next(new AppError('Cuéntanos qué ofreces: sin eso no hay nada que adaptar', 400));
  try {
    const data = await adaptar.comprender({ id_configuracion, respuestas });
    res.json({ success: true, data });
  } catch (err) {
    pasarError(next, err);
  }
});

exports.construir = catchAsync(async (req, res, next) => {
  const id_configuracion = idConfigDe(req);
  if (!id_configuracion) return next(new AppError('Falta id_configuracion', 400));
  const { ficha, respuestas } = req.body || {};
  if (!ficha || typeof ficha !== 'object')
    return next(new AppError('Falta la ficha del negocio', 400));
  try {
    const data = await adaptar.construir({
      id_configuracion,
      ficha,
      respuestas: respuestas && typeof respuestas === 'object' ? respuestas : null,
      id_usuario: req.sessionUser?.id_usuario || null,
    });
    res.json({ success: true, data });
  } catch (err) {
    pasarError(next, err);
  }
});
