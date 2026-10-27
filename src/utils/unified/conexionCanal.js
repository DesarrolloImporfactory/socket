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
  /* Hasta el 2026-10-27 esto hacía `SET status = 'inactive'`, pero `status`
     es un ENUM('active','revoked'): con STRICT_TRANS_TABLES MySQL rechazaba
     el UPDATE ("Data truncated") y el catch lo tragaba, así que suspender
     nunca liberó una página. Ahora se usa la misma desconexión del botón de
     /conexiones: se borra la fila (los chats quedan) y se des-suscribe en
     Meta solo si ningún otro canal activo usa la página. */
  for (const canal of ['ms', 'ig']) {
    await desconectarCanalDeConfiguracion({ canal, id_configuracion }).catch(
      (e) =>
        console.log(
          `[conexionCanal] no se pudo liberar ${canal} de cfg ${id_configuracion}:`,
          e?.message,
        ),
    );
  }
}

/**
 * Desconecta el inbox de Messenger o de Instagram de una conexión, a pedido
 * del cliente desde /conexiones (mismo botón que ya tenía Meta Ads).
 *
 * Qué hace y por qué así:
 *   - BORRA las filas de la tabla del canal para esa configuración. `status`
 *     es un ENUM('active','revoked'): no hay valor "desconectada" y 'revoked'
 *     no sirve porque el chequeo de salud revive una página 'revoked' cuyo
 *     token siga vivo (messenger_pages_health.service) → se reconectaría sola.
 *     Sin fila, el webhook ya no enruta esa página/cuenta a la conexión
 *     (getConfigIdByPageId / getPageRowByIgId devuelven null) y el envío no
 *     encuentra token: la conexión queda exactamente como antes de conectar.
 *   - Los CHATS no se tocan: clientes_chat_center y mensajes_clientes siguen
 *     ahí y se ven en /chat (solo lectura hasta volver a conectar). Si vuelve
 *     a conectar la MISMA página, los PSID/IGSID son los mismos y los chats
 *     continúan; si conecta OTRA página, los nuevos chats llegan aparte y los
 *     viejos quedan como historial.
 *   - En Meta se des-suscribe la app de la página (DELETE subscribed_apps)
 *     SOLO si ninguna otra fila activa sigue usando esa página: Messenger e
 *     Instagram comparten page_id (la cuenta IG cuelga de la página) y la
 *     suscripción es una sola por página; des-suscribir al quitar Instagram
 *     dejaría mudo al Messenger de la misma página. Es best-effort: si Meta
 *     falla, igual se borra la fila (el enrutado ya la ignora).
 *
 * @returns {{ paginas: Array<{page_id, page_name, meta_desuscrita}> }}
 */
async function desconectarCanalDeConfiguracion({ canal, id_configuracion }) {
  const tabla =
    canal === 'ig'
      ? 'instagram_pages'
      : canal === 'ms'
        ? 'messenger_pages'
        : null;
  if (!tabla || !id_configuracion) return { paginas: [] };
  const otraTabla = canal === 'ig' ? 'messenger_pages' : 'instagram_pages';

  const filas = await db.query(
    `SELECT page_id, page_name, page_access_token, status
       FROM ${tabla}
      WHERE id_configuracion = ?`,
    { replacements: [Number(id_configuracion)], type: db.QueryTypes.SELECT },
  );

  const paginas = [];
  for (const f of filas) {
    let meta_desuscrita = false;
    if (f.status === 'active' && f.page_access_token) {
      const [compartida] = await db.query(
        `SELECT 1 AS x FROM ${otraTabla}
          WHERE page_id = ? AND status = 'active'
          LIMIT 1`,
        { replacements: [String(f.page_id)], type: db.QueryTypes.SELECT },
      );
      if (!compartida) {
        try {
          const axios = require('axios');
          await axios.delete(
            `https://graph.facebook.com/v22.0/${f.page_id}/subscribed_apps`,
            { params: { access_token: f.page_access_token }, timeout: 8000 },
          );
          meta_desuscrita = true;
        } catch (e) {
          console.warn(
            `[conexionCanal] no se pudo des-suscribir la página ${f.page_id} (${canal}) en Meta:`,
            e?.response?.data?.error?.message || e?.message,
          );
        }
      } else {
        console.log(
          `[conexionCanal] página ${f.page_id} sigue en uso por ${otraTabla}: no se des-suscribe en Meta`,
        );
      }
    }
    paginas.push({ page_id: f.page_id, page_name: f.page_name, meta_desuscrita });
  }

  await db.query(`DELETE FROM ${tabla} WHERE id_configuracion = ?`, {
    replacements: [Number(id_configuracion)],
    type: db.QueryTypes.DELETE,
  });

  console.log(
    `[conexionCanal] ${canal} desconectado de cfg=${id_configuracion}: ` +
      (paginas.map((p) => `${p.page_name} (${p.page_id})`).join(', ') ||
        'sin páginas'),
  );
  return { paginas };
}

module.exports = {
  verificarPaginaMessengerDisponible,
  verificarCuentaInstagramDisponible,
  liberarConexionesDeConfiguracion,
  desconectarCanalDeConfiguracion,
};
