'use strict';

/* Un chat en la columna "Resuelto" que vuelve a escribir es un caso nuevo: se
   devuelve a la columna principal para que lo atienda el bot (o el equipo) y
   no se quede sin respuesta en una columna sin IA. Pedido del brief de soporte
   IMPORSHOP (cfg 261), única cuenta con columna `resuelto` al 2026-10-01. */

const { db } = require('../database/config');

const ESTADO_RESUELTO = 'resuelto';

/** Devuelve el estado con el que debe seguir el turno (el mismo si no cambia). */
async function reabrirSiResuelto({ id_configuracion, id_cliente, estado_contacto }) {
  if (String(estado_contacto || '').toLowerCase() !== ESTADO_RESUELTO) {
    return estado_contacto;
  }
  try {
    const [principal] = await db.query(
      `SELECT estado_db FROM kanban_columnas
        WHERE id_configuracion = ? AND es_principal = 1 AND activo = 1
          AND id_tablero IS NULL
        LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    const destino = principal?.estado_db;
    if (!destino || destino === ESTADO_RESUELTO) return estado_contacto;

    await db.query(
      `UPDATE clientes_chat_center
          SET estado_contacto = ?, turnos_sin_avance = 0
        WHERE id = ? AND estado_contacto = ?`,
      {
        replacements: [destino, id_cliente, ESTADO_RESUELTO],
        type: db.QueryTypes.UPDATE,
      },
    );
    return destino;
  } catch (e) {
    console.warn(`[reabrirSiResuelto] cliente=${id_cliente}: ${e.message}`);
    return estado_contacto;
  }
}

module.exports = { reabrirSiResuelto, ESTADO_RESUELTO };
