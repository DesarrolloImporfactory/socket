const AppError = require('../utils/appError');
const { db } = require('../database/config');
const checkPlanActivo = require('./checkPlanActivo.middleware');

/**
 * espiaAcceso — quién puede usar ImporKiller (/api/v1/espia).
 *
 * Desde el 04-11-2026 ImporKiller se vende en dos niveles:
 *
 *  - Buscador de productos y métricas (estado, productos, ficha, categorías,
 *    reporte): TODOS los usuarios con plan activo, sin importar el rol. El
 *    super administrador entra siempre (sin plan). Es `espiaAcceso`, el
 *    middleware por defecto del router.
 *
 *  - Complemento «ImporKiller» ($10/mes, addons_chat_center.imporkiller →
 *    usuarios_chat_center.imporkiller = 1): la extensión de Chrome (ventas
 *    estimadas debajo de cada producto de Dropi: /productos/lote) y todo lo
 *    de anuncios (Biblioteca de Meta: /anuncios, /radar, /tiendas). Es
 *    `espiaAddon`, que se suma en esas rutas. Sin complemento responde 403
 *    con code ADDON_REQUIRED: la pantalla y la extensión lo convierten en
 *    «actívalo en Productos adicionales».
 *
 *  - Operar el recolector y las cuentas de mapeo sigue siendo solo del super
 *    administrador (requireSuperAdmin en la ruta).
 *
 * Deja en req.espia { rol, id_usuario, super_admin, administrador, permanente,
 * addon, addon_comprado } para que el controlador recorte lo que cada uno ve
 * (p. ej. las cuentas de Dropi con las que se fotografía solo las ve el super
 * administrador). Debe ir después de protect (usa req.sessionUser).
 */

const ADDON_IMPORKILLER = { clave: 'imporkiller', nombre: 'ImporKiller', precio: 10 };

const esColumnaFaltante = (err) =>
  (err?.original?.code || err?.parent?.code || err?.code) === 'ER_BAD_FIELD_ERROR';

let avisadoSinColumna = false;

async function resolverAcceso(req) {
  if (req.espia) return req.espia;
  const id_sub_usuario = req.sessionUser?.id_sub_usuario;
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_sub_usuario || !id_usuario) throw new AppError('No autenticado', 401);

  const sql = (conAddon) =>
    `SELECT s.rol, u.permanente${conAddon ? ', u.imporkiller' : ''}
       FROM sub_usuarios_chat_center s
       JOIN usuarios_chat_center u ON u.id_usuario = s.id_usuario
      WHERE s.id_sub_usuario = ? AND s.id_usuario = ?
      LIMIT 1`;
  const opts = { replacements: [id_sub_usuario, id_usuario], type: db.QueryTypes.SELECT };
  let fila;
  try {
    [fila] = await db.query(sql(true), opts);
  } catch (err) {
    if (!esColumnaFaltante(err)) throw err;
    // Misma BD en dev y prod: mientras no se corra el ALTER de
    // espia_mercado_migration.sql (sección 04-11-2026 b) nadie tiene el complemento.
    if (!avisadoSinColumna) {
      avisadoSinColumna = true;
      console.warn('[espia-acceso] falta la columna usuarios_chat_center.imporkiller (espia_mercado_migration.sql): el complemento queda apagado para todos');
    }
    [fila] = await db.query(sql(false), opts);
  }
  if (!fila) throw new AppError('No autenticado', 401);

  const rol = fila.rol || null;
  const super_admin = rol === 'super_administrador';
  const permanente = Number(fila.permanente) === 1;
  const addon_comprado = Number(fila.imporkiller || 0) > 0;
  req.espia = {
    rol,
    id_usuario,
    super_admin,
    administrador: rol === 'administrador',
    // Las cuentas permanentes tienen acceso total a todo (checkToolAccess):
    // el complemento va incluido.
    permanente,
    addon: super_admin || permanente || addon_comprado,
    addon_comprado,
  };
  if (super_admin) req.sessionUser.rol = rol;
  return req.espia;
}

const espiaAcceso = async (req, res, next) => {
  try {
    const acceso = await resolverAcceso(req);
    if (acceso.super_admin) return next();
  } catch (err) {
    return next(err);
  }
  // Cliente: basta con tener el plan activo (cualquier plan, cualquier rol).
  return checkPlanActivo(req, res, next);
};

const espiaAddon = async (req, res, next) => {
  try {
    const acceso = await resolverAcceso(req);
    if (acceso.addon) return next();
  } catch (err) {
    return next(err);
  }
  return res.status(403).json({
    status: 'fail',
    code: 'ADDON_REQUIRED',
    addon: ADDON_IMPORKILLER.clave,
    message:
      `Esta función es parte del complemento ${ADDON_IMPORKILLER.nombre} ($${ADDON_IMPORKILLER.precio}/mes): ` +
      'ventas estimadas dentro de Dropi con la extensión de Chrome y descargador de anuncios de la Biblioteca de Meta. ' +
      'Actívalo en Planes y facturación → Productos adicionales.',
    redirectTo: '/complementos',
  });
};

module.exports = espiaAcceso;
module.exports.espiaAddon = espiaAddon;
module.exports.resolverAcceso = resolverAcceso;
module.exports.ADDON_IMPORKILLER = ADDON_IMPORKILLER;
