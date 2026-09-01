const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const FacebookComments = require('../services/facebook_comments.service');

// El aislamiento por cuenta lo hace `protectConfigOwner` en la ruta: valida que
// la configuración exista y pertenezca al usuario autenticado. Acá el
// id_configuracion ya llega verificado, así que se usa tal cual en el WHERE.
const leerIdConfiguracion = (req) => Number(req.query.id_configuracion);

// GET /api/v1/facebook_comentarios/posts?id_configuracion=10&pagina=1&limite=20&solo_pendientes=1
exports.listarPosts = catchAsync(async (req, res) => {
  const { pagina, limite, solo_pendientes } = req.query;

  const data = await FacebookComments.listarPosts({
    id_configuracion: leerIdConfiguracion(req),
    pagina,
    limite,
    solo_pendientes: solo_pendientes === '1' || solo_pendientes === 'true',
  });

  res.json({ ok: true, ...data });
});

// GET /api/v1/facebook_comentarios/posts/:id_facebook_post/comentarios?id_configuracion=10
exports.listarComentarios = catchAsync(async (req, res, next) => {
  const id_facebook_post = Number(req.params.id_facebook_post);
  if (!Number.isInteger(id_facebook_post) || id_facebook_post <= 0) {
    return next(new AppError('id_facebook_post inválido', 400));
  }

  const data = await FacebookComments.listarComentarios({
    id_configuracion: leerIdConfiguracion(req),
    id_facebook_post,
    // Los ocultos se devuelven marcados, no se esconden: el negocio necesita
    // ver qué ocultó para poder revertirlo.
    incluir_ocultos: req.query.incluir_ocultos !== '0',
  });

  res.json({ ok: true, id_facebook_post, ...data });
});

// GET /api/v1/facebook_comentarios/resumen?id_configuracion=10
exports.resumen = catchAsync(async (req, res) => {
  const data = await FacebookComments.resumen({
    id_configuracion: leerIdConfiguracion(req),
  });
  res.json({ ok: true, ...data });
});

// En los POST el id_configuracion viaja en el body — protectConfigOwner lo
// busca en body, query y params, así que sigue validando igual.
const leerIdConfiguracionBody = (req) =>
  Number(req.body?.id_configuracion ?? req.query?.id_configuracion);

// POST /api/v1/facebook_comentarios/responder
// body: { id_configuracion, comment_id, mensaje }
exports.responder = catchAsync(async (req, res, next) => {
  const { comment_id, mensaje } = req.body;
  if (!comment_id || !String(mensaje || '').trim()) {
    return next(new AppError('comment_id y mensaje son requeridos', 400));
  }

  try {
    const data = await FacebookComments.responder({
      id_configuracion: leerIdConfiguracionBody(req),
      comment_id,
      mensaje,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    // Publicar en Facebook falla por motivos del negocio, no del servidor:
    // comentario borrado, página desconectada, token sin permisos. Devolverlo
    // como 400 con el detalle deja que la bandeja muestre algo accionable en
    // vez de un 500 genérico.
    return next(new AppError(err.message, 400));
  }
});

// POST /api/v1/facebook_comentarios/responder-privado
// body: { id_configuracion, comment_id, mensaje }
exports.responderEnPrivado = catchAsync(async (req, res, next) => {
  const { comment_id, mensaje } = req.body;
  if (!comment_id || !String(mensaje || '').trim()) {
    return next(new AppError('comment_id y mensaje son requeridos', 400));
  }

  try {
    const data = await FacebookComments.responderEnPrivado({
      id_configuracion: leerIdConfiguracionBody(req),
      comment_id,
      mensaje,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    return next(new AppError(err.message, 400));
  }
});
