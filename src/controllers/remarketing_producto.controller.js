// controllers/remarketing_producto.controller.js
// Remarketing por producto (menú Productos → Remarketing). Mismo patrón que
// producto_wizard.controller: id_configuracion en el body, errores del
// servicio con statusCode/codigo devueltos como JSON plano.
const catchAsync = require('../utils/catchAsync');
const servicio = require('../services/remarketing_producto.service');

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

const ambos = (req, res) => {
  const id_configuracion = idConfig(req);
  const id_producto = idProducto(req);
  if (!id_configuracion || !id_producto) {
    falla(res, 'id_configuracion e id_producto son obligatorios.');
    return null;
  }
  return { id_configuracion, id_producto };
};

exports.listar = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  if (!id_configuracion) return falla(res, 'id_configuracion es obligatorio.');
  const data = await servicio.listar(id_configuracion, {
    dias: req.body?.dias,
  });
  res.status(200).json({ status: 'success', data });
});

exports.obtener = conErrores(async (req, res) => {
  const ids = ambos(req, res);
  if (!ids) return;
  const data = await servicio.obtener(ids.id_configuracion, ids.id_producto);
  res.status(200).json({ status: 'success', data });
});

exports.guardar = conErrores(async (req, res) => {
  const ids = ambos(req, res);
  if (!ids) return;
  const data = await servicio.guardar(
    ids.id_configuracion,
    ids.id_producto,
    req.body?.config || req.body || {},
    { creado_por: req.user?.id_sub_usuario ?? req.user?.id ?? null },
  );
  res.status(200).json({ status: 'success', data });
});

exports.activar = conErrores(async (req, res) => {
  const ids = ambos(req, res);
  if (!ids) return;
  const activo = !(req.body?.activo === false || req.body?.activo === 0);
  const ok = await servicio.activar(ids.id_configuracion, ids.id_producto, activo);
  res.status(200).json({ status: 'success', activo, actualizado: ok });
});

exports.eliminar = conErrores(async (req, res) => {
  const ids = ambos(req, res);
  if (!ids) return;
  await servicio.eliminar(ids.id_configuracion, ids.id_producto);
  res.status(200).json({ status: 'success' });
});

exports.subirMedia = conErrores(async (req, res) => {
  const id_configuracion = idConfig(req);
  if (!id_configuracion) return falla(res, 'id_configuracion es obligatorio.');
  if (!req.file) return falla(res, 'Falta el archivo.');
  const data = await servicio.subirMedia({
    id_configuracion,
    buffer: req.file.buffer,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
  });
  res.status(200).json({ status: 'success', data });
});

exports.probar = conErrores(async (req, res) => {
  const ids = ambos(req, res);
  if (!ids) return;
  const data = await servicio.enviarPrueba({
    ...ids,
    telefono: req.body?.telefono,
    paso: Number(req.body?.paso) || 1,
    config: req.body?.config || null,
  });
  res.status(200).json({ status: 'success', data });
});
