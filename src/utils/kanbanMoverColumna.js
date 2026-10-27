'use strict';

/* Mueve un contacto a una columna del kanban respetando el tablero al que
   pertenece esa columna. `estado_db` es único por cuenta, así que la
   columna dice sola dónde va:

     - tablero PRINCIPAL (kanban_columnas.id_tablero IS NULL): se escribe en
       clientes_chat_center.estado_contacto, que es lo que leen el bot, el
       remarketing y el webhook.
     - tablero SECUNDARIO: se escribe en clientes_estados_tablero (un
       contacto ocupa una sola columna por tablero) y NO se toca
       estado_contacto, para no sacarlo del embudo principal.

   Lo usa el cron de masivos (estado_destino de flujos masivos). Antes el
   cron escribía siempre estado_contacto, así que elegir como destino una
   columna de un tablero secundario dejaba al contacto con un estado que el
   principal no conocía (huérfano) y no aparecía en el tablero elegido. */

const { db } = require('../database/config');

const cacheColumnas = new Map(); // `${cfg}:${estado}` -> { id_tablero } | null
const CACHE_MS = 60 * 1000;

async function columnaDe(id_configuracion, estado_db) {
  const k = `${id_configuracion}:${estado_db}`;
  const hit = cacheColumnas.get(k);
  if (hit && hit.hasta > Date.now()) return hit.col;
  const [col] = await db.query(
    `SELECT id, id_tablero FROM kanban_columnas
      WHERE id_configuracion = ? AND estado_db = ? AND activo = 1
      LIMIT 1`,
    {
      replacements: [id_configuracion, estado_db],
      type: db.QueryTypes.SELECT,
    },
  );
  cacheColumnas.set(k, { col: col || null, hasta: Date.now() + CACHE_MS });
  return col || null;
}

/**
 * @returns {Promise<'principal'|'tablero'|'sin_columna'>}
 */
async function moverContactoAColumna({ id_configuracion, id_cliente, estado_db }) {
  const destino = String(estado_db || '').trim();
  if (!id_configuracion || !id_cliente || !destino) return 'sin_columna';

  const col = await columnaDe(Number(id_configuracion), destino);

  /* Sin columna conocida se conserva el comportamiento histórico (escribir
     estado_contacto): las cuentas sin kanban configurado mueven igual. */
  if (!col || col.id_tablero == null) {
    await db.query(
      `UPDATE clientes_chat_center
          SET estado_contacto = ?
        WHERE id = ? AND id_configuracion = ? AND deleted_at IS NULL`,
      {
        replacements: [destino, id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
    return 'principal';
  }

  await db.query(
    `INSERT INTO clientes_estados_tablero
       (id_configuracion, id_tablero, id_cliente, estado_db)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE estado_db = VALUES(estado_db)`,
    {
      replacements: [id_configuracion, col.id_tablero, id_cliente, destino],
      type: db.QueryTypes.INSERT,
    },
  );
  return 'tablero';
}

module.exports = { moverContactoAColumna };
