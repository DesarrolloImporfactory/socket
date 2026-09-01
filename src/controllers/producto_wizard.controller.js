// controllers/producto_wizard.controller.js
// Endpoints del wizard de producto (vista /productos2). Todo lo que genera con
// IA usa la API key de OpenAI del propio negocio (configuraciones.api_key_openai).
const catchAsync = require('../utils/catchAsync');
const servicio = require('../services/producto_wizard.service');
const { olvidarWizard } = require('../services/producto_wizard_runtime.service');
const {
  elegirRespuestaRapida,
  esSaludoOGenerico,
  pareceIntencionCompra,
} = require('../utils/wizardProducto/respuestasRapidas');

function idConfig(req) {
  const v = Number(req.body?.id_configuracion ?? req.query?.id_configuracion);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function idProducto(req) {
  const v = Number(req.body?.id_producto ?? req.params?.id_producto);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function falla(res, mensaje, status = 400, codigo = null) {
  return res.status(status).json({ status: 'fail', message: mensaje, codigo });
}

/* Los errores del servicio traen `statusCode` y `codigo`; se devuelven como
   JSON plano (igual que generarDescripcionIA) para que el front muestre el
   texto tal cual y no el genérico del interceptor. */
function conErrores(fn) {
  return catchAsync(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      if (e && (e.codigo || e.statusCode)) {
        return falla(res, e.message, e.statusCode || 400, e.codigo || null);
      }
      throw e;
    }
  });
}

exports.listar = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  if (!id_configuracion) return falla(res, 'id_configuracion es obligatorio.');
  const data = await servicio.listarProductosConWizard(id_configuracion);
  res.status(200).json({ status: 'success', data });
});

exports.obtener = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const data = await servicio.obtenerWizard(id_producto, id_configuracion);
  res.status(200).json({ status: 'success', data });
});

exports.guardar = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const data = await servicio.guardarWizard(
    id_producto,
    id_configuracion,
    req.body?.wizard || req.body || {},
  );
  olvidarWizard(id_producto);
  res.status(200).json({ status: 'success', data });
});

exports.eliminar = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const ok = await servicio.eliminarWizard(id_producto, id_configuracion);
  olvidarWizard(id_producto);
  res.status(200).json({ status: 'success', eliminado: ok });
});

exports.preview = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const data = await servicio.previewMensaje(
    id_producto,
    id_configuracion,
    req.body?.wizard || {},
  );
  res.status(200).json({ status: 'success', data });
});

exports.generarTextos = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const data = await servicio.generarTextos({
    id_configuracion,
    id_producto,
    wizardInput: req.body?.wizard || {},
  });
  res.status(200).json({ status: 'success', data });
});

exports.generarImagen = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const b = req.body || {};
  const data = await servicio.generarImagen({
    id_configuracion,
    id_producto,
    tipo: b.tipo || 'beneficios',
    bullets: b.bullets || [],
    texto_antes: b.texto_antes || '',
    texto_despues: b.texto_despues || '',
    instrucciones_extra: b.instrucciones_extra || '',
    prompt_personalizado: b.prompt || '',
    usar_referencia: b.usar_referencia !== false && b.usar_referencia !== 0,
  });
  res.status(200).json({ status: 'success', data });
});

/* Simulador del paso 4: responde un turno como el bot en vivo (respuesta rápida
   o IA de la columna inicial con la ficha del producto). No envía nada. */
exports.simular = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const b = req.body || {};
  const data = await servicio.simularTurno({
    id_configuracion,
    id_producto,
    mensaje: b.mensaje,
    wizardInput: b.wizard || {},
    mensaje_fijo: b.mensaje_fijo || '',
    previous_response_id: b.previous_response_id || null,
    id_columna: Number(b.id_columna) || null,
    historial: Array.isArray(b.historial) ? b.historial.slice(-40) : [],
    flujo_paso: Number.isInteger(b.flujo_paso) ? b.flujo_paso : null,
  });
  res.status(200).json({ status: 'success', data });
});

exports.fotoPrincipal = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    return falla(res, 'id_configuracion e id_producto son obligatorios.');
  }
  const data = await servicio.fotoPrincipal({
    id_configuracion,
    id_producto,
    url: req.body?.url,
  });
  olvidarWizard(id_producto);
  res.status(200).json({ status: 'success', data });
});

exports.subirMedia = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  if (!id_configuracion) return falla(res, 'id_configuracion es obligatorio.');
  const data = await servicio.subirMedia({ id_configuracion, file: req.file });
  res.status(200).json({ status: 'success', data });
});

/* Probador del front: "¿qué haría el bot con este mensaje?" sin mandar nada.
   Sirve para que el negocio afine las claves de sus respuestas rápidas. */
exports.probarRespuesta = conErrores(async (req, res) => {
  const mensaje = String(req.body?.mensaje || '');
  const faqs = Array.isArray(req.body?.respuestas_rapidas)
    ? req.body.respuestas_rapidas
    : [];
  const generico = esSaludoOGenerico(mensaje);
  const compra = pareceIntencionCompra(mensaje);
  const match = compra ? null : elegirRespuestaRapida(mensaje, faqs);
  let decision = 'ia';
  if (generico) decision = 'solo_paquete';
  else if (compra) decision = 'ia_cierre';
  else if (match) decision = 'respuesta_rapida';
  res.status(200).json({
    status: 'success',
    data: {
      decision,
      generico,
      intencion_compra: compra,
      respuesta: match ? match.faq : null,
      indice: match ? match.indice : null,
      score: match ? match.score : 0,
    },
  });
});
