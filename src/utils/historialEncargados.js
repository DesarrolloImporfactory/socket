/**
 * Historial de encargados: quién hizo cada cambio y quién puede transferir.
 *
 * Autor de la acción → columna historial_encargados.id_sub_usuario_accion
 * (ver historial_encargados_accion_migration.sql). Mientras la migración no
 * esté aplicada, `tieneColumnaAccion()` devuelve false y el historial se
 * sigue guardando exactamente como antes, solo que sin el autor.
 *
 * La columna NO está en el modelo a propósito: si lo estuviera, Sequelize la
 * incluiría en cada INSERT y todas las transferencias fallarían hasta correr
 * la migración. Se escribe con un UPDATE aparte.
 */
const { db } = require('../database/config');
const Historial_encargados = require('../models/historial_encargados.model');

let cache = null; // null = sin verificar
let cacheAt = 0;
const RECHECK_MS = 5 * 60 * 1000; // si aún no existe, se vuelve a mirar cada 5 min

async function tieneColumnaAccion() {
  const ahora = Date.now();
  if (cache === true) return true;
  if (cache === false && ahora - cacheAt < RECHECK_MS) return false;
  try {
    const rows = await db.query(
      "SHOW COLUMNS FROM historial_encargados LIKE 'id_sub_usuario_accion'",
      { type: db.QueryTypes.SELECT },
    );
    cache = rows.length > 0;
  } catch (_) {
    cache = false;
  }
  cacheAt = ahora;
  return cache;
}

/**
 * Crea la fila del historial y, si se puede, anota quién hizo la acción.
 * Perder el autor nunca debe tumbar una transferencia: si el UPDATE falla,
 * se registra en consola y la operación sigue.
 */
async function crearHistorial(datos, id_sub_usuario_accion) {
  const fila = await Historial_encargados.create(datos);

  if (id_sub_usuario_accion && (await tieneColumnaAccion())) {
    try {
      await db.query(
        'UPDATE historial_encargados SET id_sub_usuario_accion = ? WHERE id = ?',
        {
          replacements: [id_sub_usuario_accion, fila.id],
          type: db.QueryTypes.UPDATE,
        },
      );
    } catch (err) {
      console.warn(
        'historial_encargados: no se pudo guardar el autor —',
        err.message,
      );
    }
  }

  return fila;
}

/** Roles que pueden transferir cualquier chat de su cuenta. */
const ROLES_ADMIN = ['administrador', 'admin_limitado', 'super_administrador'];

/**
 * Subusuarios que pueden ASIGNARSE a sí mismos el chat de otro asesor, sin
 * ser administradores. Pedido del 2026-09-25: Johan Bonilla (377) hace el
 * seguimiento de las cotizaciones que no se cerraron desde «Seguimiento IA»
 * y, si le toca retomar a un cliente, se queda con el chat.
 *
 * Solo hacia sí mismos: no pueden pasarle el chat ajeno a un tercero.
 * Espejo de IA_AGENTES_HABILITADOS en chatcenter-front.
 */
const SUB_USUARIOS_AUTOASIGNAN = [377];

/**
 * Puede transferir quien tiene el chat, cualquiera si el chat está sin
 * asignar (los de «En espera», que cualquiera puede tomar), o un admin.
 * Además, los de SUB_USUARIOS_AUTOASIGNAN cuando el destino son ellos mismos.
 *
 * Es la misma regla que ya aplica la lista de chats; hacía falta repetirla
 * acá porque al chat también se llega por el kanban o por /chat/:id, que no
 * filtran por encargado.
 */
function puedeTransferir(actor, chat, idEncargadoDestino = null) {
  if (!actor || !chat) return false;
  if (ROLES_ADMIN.includes(actor.rol)) return true;
  if (chat.id_encargado == null) return true;
  if (String(chat.id_encargado) === String(actor.id_sub_usuario)) return true;
  return (
    SUB_USUARIOS_AUTOASIGNAN.includes(Number(actor.id_sub_usuario)) &&
    idEncargadoDestino != null &&
    String(idEncargadoDestino) === String(actor.id_sub_usuario)
  );
}

module.exports = {
  tieneColumnaAccion,
  crearHistorial,
  puedeTransferir,
};
