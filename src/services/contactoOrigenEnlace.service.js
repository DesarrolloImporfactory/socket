'use strict';

/**
 * Enlace "contacto origen ↔ orden Dropi".
 *
 * Problema: a veces el cliente chatea desde un número y la orden se crea con
 * OTRO teléfono (deja otro número). Las automatizaciones (mover de columna por
 * estado Dropi + mensajes) van al número de la ORDEN, así que el contacto
 * original (el que el bot capturó) queda atascado en generar_guia.
 *
 * Solución: al crear la orden DESDE nuestro sistema guardamos el enlace
 * dropi_order_id → id_cliente_origen. Cuando el notifier mueve al contacto de la
 * orden por el estado de Dropi, también mueve al contacto origen — EN SILENCIO
 * (sin mensaje; los templates Meta van solo al número de la orden, por costo).
 */

const { db } = require('../database/config');

async function enlazarOrdenContactoOrigen({
  id_configuracion,
  dropi_order_id,
  id_cliente_origen,
  telefono_orden = null,
}) {
  if (!id_configuracion || !dropi_order_id || !id_cliente_origen) return;
  try {
    await db.query(
      `INSERT IGNORE INTO dropi_orden_contacto_origen
         (id_configuracion, dropi_order_id, id_cliente_origen, telefono_orden)
       VALUES (?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          dropi_order_id,
          id_cliente_origen,
          telefono_orden,
        ],
      },
    );
  } catch (_) {}
}

/**
 * Mueve el contacto ORIGEN enlazado a la misma columna, en silencio. No envía
 * ningún mensaje. Idempotente (no toca si ya está en esa columna).
 */
async function moverContactoOrigenPorOrden({
  id_configuracion,
  dropi_order_id,
  columnaDestino,
}) {
  if (!id_configuracion || !dropi_order_id || !columnaDestino) return false;
  try {
    const [link] = await db.query(
      `SELECT id_cliente_origen FROM dropi_orden_contacto_origen
        WHERE id_configuracion = ? AND dropi_order_id = ? LIMIT 1`,
      {
        replacements: [id_configuracion, dropi_order_id],
        type: db.QueryTypes.SELECT,
      },
    );
    if (!link?.id_cliente_origen) return false;

    await db.query(
      `UPDATE clientes_chat_center
          SET estado_contacto = ?
        WHERE id = ? AND id_configuracion = ? AND deleted_at IS NULL
          AND (estado_contacto IS NULL OR estado_contacto != ?)`,
      {
        replacements: [
          columnaDestino,
          link.id_cliente_origen,
          id_configuracion,
          columnaDestino,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { enlazarOrdenContactoOrigen, moverContactoOrigenPorOrden };
