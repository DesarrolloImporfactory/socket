'use strict';

/**
 * utils/unified/conexionCanal.js
 *
 * Unicidad de la IDENTIDAD EXTERNA de una conexión (tarjeta) por canal.
 *
 * Regla, igual que la del número de WhatsApp en configuraciones.controller:
 * una misma identidad de Meta solo puede estar conectada a UNA configuración
 * activa a la vez, globalmente (no por usuario).
 *
 *   WhatsApp   → configuraciones.telefono   (ya validado en su controlador)
 *   Messenger  → messenger_pages.page_id
 *   Instagram  → instagram_pages.ig_id (y su page_id)
 *
 * POR QUÉ IMPORTA
 * El webhook de Meta manda el evento UNA vez y el backend resuelve a qué
 * configuración pertenece buscando esa identidad:
 *
 *   messenger.service.js  → SELECT id_configuracion FROM messenger_pages
 *                           WHERE page_id = ? AND status='active' LIMIT 1
 *   instagram.service.js  → SELECT ... FROM instagram_pages
 *                           WHERE ig_id = ? AND status='active' LIMIT 1
 *
 * Ese LIMIT 1 sin desempate significa que, con la misma página en dos
 * tarjetas, TODOS los mensajes se van a una sola y la otra queda muda. No se
 * duplican los mensajes: se pierden para una de las dos conexiones.
 *
 * Al suspender una conexión su identidad queda libre otra vez (ver
 * liberarConexionesDeConfiguracion), igual que pasa con el número.
 */

const { db } = require('../../database/config');
const AppError = require('../appError');

function errorEnUso(mensaje) {
  const err = new AppError(mensaje, 409);
  // el error controller reenvía err.code al front, que lo usa para mostrar
  // el aviso correcto (mismo patrón que TELEFONO_EN_USO)
  err.code = 'CANAL_EN_USO';
  return err;
}

/**
 * Lanza 409 si la página de Facebook ya está conectada a OTRA configuración
 * activa. Reconectarla a la misma configuración es válido (es un refresh de
 * token), por eso se excluye la propia.
 */
async function verificarPaginaMessengerDisponible({
  page_id,
  id_configuracion,
}) {
  if (!page_id || !id_configuracion) return;

  const [enUso] = await db.query(
    `SELECT mp.id_configuracion, c.nombre_configuracion, c.id_usuario
       FROM messenger_pages mp
       JOIN configuraciones c ON c.id = mp.id_configuracion
      WHERE mp.page_id = ?
        AND mp.status = 'active'
        AND mp.id_configuracion <> ?
        AND c.suspendido = 0
      LIMIT 1`,
    {
      replacements: [String(page_id), Number(id_configuracion)],
      type: db.QueryTypes.SELECT,
    },
  );

  if (enUso) {
    throw errorEnUso(
      `Esta página de Facebook ya está conectada a la conexión "${
        enUso.nombre_configuracion || enUso.id_configuracion
      }". Desconéctala de allí antes de usarla aquí: una misma página no puede recibir mensajes en dos conexiones.`,
    );
  }
}

/**
 * Igual que la anterior pero para Instagram. Se valida por las DOS identidades
 * porque el webhook enruta por ig_id mientras que el envío usa el page_id:
 * si cualquiera de las dos ya está tomada, la conexión quedaría rota.
 */
async function verificarCuentaInstagramDisponible({
  page_id,
  ig_id,
  id_configuracion,
}) {
  if (!id_configuracion || (!page_id && !ig_id)) return;

  const [enUso] = await db.query(
    `SELECT ip.id_configuracion, ip.ig_username, c.nombre_configuracion
       FROM instagram_pages ip
       JOIN configuraciones c ON c.id = ip.id_configuracion
      WHERE ip.status = 'active'
        AND ip.id_configuracion <> ?
        AND c.suspendido = 0
        AND ( (? IS NOT NULL AND ip.ig_id = ?)
           OR (? IS NOT NULL AND ip.page_id = ?) )
      LIMIT 1`,
    {
      replacements: [
        Number(id_configuracion),
        ig_id || null,
        ig_id || null,
        page_id ? String(page_id) : null,
        page_id ? String(page_id) : null,
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  if (enUso) {
    throw errorEnUso(
      `Esta cuenta de Instagram${
        enUso.ig_username ? ` (@${enUso.ig_username})` : ''
      } ya está conectada a la conexión "${
        enUso.nombre_configuracion || enUso.id_configuracion
      }". Desconéctala de allí antes de usarla aquí: una misma cuenta no puede recibir mensajes en dos conexiones.`,
    );
  }
}

/**
 * Al suspender una conexión, sus páginas de Messenger/Instagram dejan de estar
 * activas. Sin esto la fila queda "active" para siempre y sigue ganando el
 * LIMIT 1 del enrutado: los mensajes se van a una tarjeta suspendida y la
 * conexión nueva del mismo cliente no recibe nada. (Caso real: la página
 * 1129626313566156 quedó apuntando a la config 491, ya suspendida, mientras
 * la activa era la 626.)
 *
 * Al reactivar NO se vuelven a activar solas a propósito: hay que reconectar
 * desde el panel, que es cuando se revalida que la identidad siga libre.
 */
async function liberarConexionesDeConfiguracion(id_configuracion) {
  if (!id_configuracion) return;
  for (const tabla of ['messenger_pages', 'instagram_pages']) {
    await db
      .query(
        `UPDATE ${tabla}
            SET status = 'inactive'
          WHERE id_configuracion = ? AND status = 'active'`,
        {
          replacements: [Number(id_configuracion)],
          type: db.QueryTypes.UPDATE,
        },
      )
      .catch((e) =>
        console.log(
          `[conexionCanal] no se pudo liberar ${tabla} de cfg ${id_configuracion}:`,
          e?.message,
        ),
      );
  }
}

module.exports = {
  verificarPaginaMessengerDisponible,
  verificarCuentaInstagramDisponible,
  liberarConexionesDeConfiguracion,
};
