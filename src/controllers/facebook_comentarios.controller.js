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

// GET /api/v1/facebook_comentarios/comentarios
//   ?id_configuracion=10&estado=pendientes|respondidos|todos&orden=antiguos|nuevos&q=texto
//
// La bandeja plana: comentarios de toda la cuenta, sin agrupar por publicación.
exports.listarComentariosPlano = catchAsync(async (req, res) => {
  const { estado, orden, q, pagina, limite } = req.query;

  const data = await FacebookComments.listarComentariosPlano({
    id_configuracion: leerIdConfiguracion(req),
    // Se validan acá y no en el servicio para que un valor raro en la query no
    // acabe concatenado en el SQL.
    estado: ['pendientes', 'respondidos', 'todos'].includes(estado)
      ? estado
      : 'pendientes',
    orden: orden === 'nuevos' ? 'nuevos' : 'antiguos',
    q,
    pagina,
    limite,
  });

  res.json({ ok: true, ...data });
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

// GET /api/v1/facebook_comentarios/productos?id_configuracion=10&q=audifonos
//
// Catálogo para el selector de "producto de esta publicación".
exports.listarProductosVinculables = catchAsync(async (req, res) => {
  const data = await FacebookComments.listarProductosVinculables({
    id_configuracion: leerIdConfiguracion(req),
    q: req.query.q || '',
  });

  res.json({ ok: true, ...data });
});

// POST /api/v1/facebook_comentarios/vincular-producto
// body: { id_configuracion, post_id, id_producto }
//
// id_producto null desvincula. Vincular no cambia nada de lo publicado: solo
// decide qué sabe el asistente cuando redacte una sugerencia en ese post.
exports.vincularProducto = catchAsync(async (req, res, next) => {
  const { post_id, id_producto } = req.body;
  if (!post_id) return next(new AppError('post_id es requerido', 400));

  const data = await FacebookComments.vincularProducto({
    id_configuracion: leerIdConfiguracionBody(req),
    post_id,
    id_producto: id_producto || null,
  });

  res.json({ ok: true, ...data });
});

// GET /api/v1/facebook_comentarios/asistente?id_configuracion=10
//
// Lo que necesita la pantalla de configuración, incluida la vista previa del
// texto completo que recibiría el modelo.
exports.obtenerAsistente = catchAsync(async (req, res) => {
  const data = await FacebookComments.obtenerAsistenteComentarios({
    id_configuracion: leerIdConfiguracion(req),
  });

  res.json({ ok: true, ...data });
});

// PUT /api/v1/facebook_comentarios/asistente
// body: { id_configuracion, opciones, avanzado, nombre_bot, activo }
//
// Las opciones se normalizan en el servicio contra su propia lista: un campo
// nuevo en el formulario no puede colar un valor que el compositor no sepa
// usar, ni quitar las reglas del sistema (esas van por código, no por body).
exports.guardarAsistente = catchAsync(async (req, res) => {
  const { opciones, avanzado, nombre_bot, activo } = req.body;

  const data = await FacebookComments.guardarAsistenteComentarios({
    id_configuracion: leerIdConfiguracionBody(req),
    opciones,
    avanzado,
    nombre_bot,
    activo,
  });

  res.json({ ok: true, ...data });
});

// POST /api/v1/facebook_comentarios/probar-prompt
// body: { id_configuracion, texto, id_producto, opciones, avanzado }
//
// Prueba unas instrucciones SIN guardarlas y SIN publicar nada. El comentario
// es inventado, así que tampoco hace falta que exista en Facebook: se puede
// afinar el asistente entero con la app en revisión.
exports.probarPrompt = catchAsync(async (req, res, next) => {
  const { texto, id_producto, opciones, avanzado } = req.body;
  if (!String(texto || '').trim()) {
    return next(new AppError('Escribe un comentario de ejemplo', 400));
  }

  try {
    const data = await FacebookComments.probarPrompt({
      id_configuracion: leerIdConfiguracionBody(req),
      texto,
      id_producto: id_producto || null,
      opciones,
      avanzado,
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    // Falta la clave de OpenAI, el producto no es de la cuenta, el modelo
    // devolvió vacío: son cosas que el usuario puede arreglar, no errores del
    // servidor. Un 400 con el detalle le dice qué hacer.
    return next(new AppError(err.message, 400));
  }
});

// POST /api/v1/facebook_comentarios/sugerir
// body: { id_configuracion, comment_id }
//
// Devuelve un borrador para que el agente lo lea y decida. No publica nada:
// esa frontera es la que declaramos a Meta sobre pages_manage_engagement.
exports.sugerir = catchAsync(async (req, res, next) => {
  const { comment_id } = req.body;
  if (!comment_id) return next(new AppError('comment_id es requerido', 400));

  const data = await FacebookComments.sugerirRespuesta({
    id_configuracion: leerIdConfiguracionBody(req),
    comment_id,
  });

  res.json({ ok: true, ...data });
});

// POST /api/v1/facebook_comentarios/responder
// body: { id_configuracion, comment_id, mensaje, origen }
//
// `origen` dice si el texto lo escribió una persona, si salió de una respuesta
// rápida del producto o si lo redactó la IA, y si el agente lo editó después.
// El servicio valida el valor contra su propia lista: no se guarda lo que
// llegue, porque si no cualquiera podría marcar como "IA" algo que escribió él.
exports.responder = catchAsync(async (req, res, next) => {
  const { comment_id, mensaje, origen } = req.body;
  if (!comment_id || !String(mensaje || '').trim()) {
    return next(new AppError('comment_id y mensaje son requeridos', 400));
  }

  try {
    const data = await FacebookComments.responder({
      id_configuracion: leerIdConfiguracionBody(req),
      comment_id,
      mensaje,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
      origen,
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
