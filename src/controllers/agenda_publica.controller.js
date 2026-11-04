// controllers/agenda_publica.controller.js — agenda pública de citas.
// Público: ver huecos y reservar (sin sesión), por slug de la cuenta o la
// principal. Panel: cada cuenta configura la suya (/mi/*, dueño validado por
// protectConfigOwner); el super admin administra la principal (/admin/*).
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const svc = require('../services/agenda_publica.service');

/* GET /api/v1/agenda_publica/disponibilidad?a=<slug>&previa=1
   previa: vista previa desde el panel (se ve aunque esté apagada). */
exports.disponibilidad = catchAsync(async (req, res) => {
  const data = await svc.disponibilidad({
    slug: req.query.a || null,
    previa: String(req.query.previa || '') === '1',
  });
  res.json({ status: 'success', data });
});

/* POST /api/v1/agenda_publica/reservar
   { slug?, nombre, email, codigo_pais, telefono, inicio (ISO), origen?, id_usuario_cuenta?, tz_cliente?, nota? } */
exports.reservar = catchAsync(async (req, res) => {
  const b = req.body || {};
  const data = await svc.reservar({
    slug: b.slug || null,
    nombre: b.nombre,
    email: b.email,
    codigo_pais: b.codigo_pais,
    telefono: b.telefono,
    inicio: b.inicio,
    origen: b.origen,
    id_usuario_cuenta: b.id_usuario_cuenta,
    tz_cliente: b.tz_cliente,
    nota: b.nota,
  });
  res.status(data.repetida ? 200 : 201).json({ status: 'success', data });
});

/* Qué cuenta administra la petición: la del dueño (/mi/*) o la principal
   (/admin/*, super admin). */
async function cuentaDe(req) {
  if (req.agendaPrincipal) {
    const cfg = await svc.configPrincipal();
    if (!cfg) throw new AppError('No hay agenda principal configurada', 404);
    return cfg.id_configuracion;
  }
  const id = Number(req.body?.id_configuracion ?? req.query?.id_configuracion);
  if (!id) throw new AppError('id_configuracion es requerido', 400);
  return id;
}

/* Solo administradores tocan la configuración; el resto del equipo la ve. */
function puedeEditar(req) {
  return ['administrador', 'super_administrador'].includes(req.sessionUser?.rol);
}

/* GET /api/v1/agenda_publica/mi/resumen?id_configuracion=  ·  GET /admin/resumen */
exports.resumen = catchAsync(async (req, res) => {
  const id = await cuentaDe(req);
  const data = await svc.resumen(id, { sesionSub: req.sessionUser?.id_sub_usuario || null });
  res.json({ status: 'success', data: { ...data, puede_editar: puedeEditar(req) } });
});

/* GET /mi/plantillas · /admin/plantillas — plantillas de Meta de la cuenta
   (aprobadas y pendientes) con su texto, para elegir y ver la de confirmación. */
exports.plantillas = catchAsync(async (req, res) => {
  const id = await cuentaDe(req);
  const data = await svc.plantillasDisponibles(id);
  res.json({ status: 'success', data });
});

/* POST /mi/google/usar { id_configuracion, link_id? }  — sin link_id usa el
   vínculo del sub-usuario de la sesión en el calendario de la agenda (el que
   acaba de conectar desde el panel). */
exports.googleUsar = catchAsync(async (req, res, next) => {
  if (!puedeEditar(req)) return next(new AppError('Solo un administrador puede cambiar la cuenta de Google', 403));
  const id = await cuentaDe(req);
  const link = await svc.usarGoogle(id, {
    link_id: req.body?.link_id || null,
    id_sub_usuario: req.body?.link_id ? null : req.sessionUser?.id_sub_usuario,
  });
  res.json({ status: 'success', data: { id: link.id, email: link.google_email } });
});

/* POST /mi/google/quitar */
exports.googleQuitar = catchAsync(async (req, res, next) => {
  if (!puedeEditar(req)) return next(new AppError('Solo un administrador puede cambiar la cuenta de Google', 403));
  const id = await cuentaDe(req);
  await svc.quitarGoogle(id);
  res.json({ status: 'success' });
});

/* POST /mi/google/importar — trae lo que ya existe en el Google de la agenda. */
exports.googleImportar = catchAsync(async (req, res, next) => {
  if (!puedeEditar(req)) return next(new AppError('Solo un administrador puede importar', 403));
  const id = await cuentaDe(req);
  const data = await svc.importarGoogle(id);
  res.json({ status: 'success', data });
});

/* POST /api/v1/agenda_publica/mi/config  ·  POST /admin/config */
exports.guardarConfig = catchAsync(async (req, res, next) => {
  if (!puedeEditar(req)) return next(new AppError('Solo un administrador puede cambiar la agenda', 403));
  const id = await cuentaDe(req);
  const { id_configuracion: _omit, ...datos } = req.body || {};
  const config = await svc.guardarConfig(id, datos, req.sessionUser?.id_sub_usuario || null);
  const { diasSet, guardada, __nueva, ...plano } = config;
  res.json({ status: 'success', data: plano });
});

/* POST /api/v1/agenda_publica/mi/asesores  { id_configuracion, asesores: [{ id_sub_usuario, activo, orden }] } */
exports.guardarAsesores = catchAsync(async (req, res, next) => {
  if (!puedeEditar(req)) return next(new AppError('Solo un administrador puede cambiar quién atiende', 403));
  const id = await cuentaDe(req);
  const lista = req.body?.asesores;
  if (!Array.isArray(lista)) return next(new AppError('Falta la lista de asesores', 400));
  const activos = await svc.guardarAsesores(id, lista);
  res.json({ status: 'success', data: { activos } });
});
