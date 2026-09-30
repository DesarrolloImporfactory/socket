'use strict';

/**
 * Repara los borrados hechos desde la app de WhatsApp Business que quedaron
 * como un globito suelto en vez de marcar el mensaje original.
 *
 * Contexto (2026-09-30, cfg 548): el dueño de la cuenta borró desde su celular
 * un mensaje del bot. El revoke llegó como echo con el wamid en formato de la
 * app (LID del chat) y no coincidía textual con el wamid guardado (formato
 * Cloud API, teléfono del cliente), así que el webhook insertó una fila
 * tipo 'revoke' ("🚫 Mensaje eliminado por el usuario", responsable
 * "Whatsapp Business") a la hora del borrado. En el chat se leía como un
 * mensaje NUEVO enviado desde el celular, y el original seguía intacto.
 *
 * El webhook ya empareja por el id interno del wamid (ver idInternoDeWamid en
 * webhook_meta_whatsapp.controller.js). Este script arregla lo que ya quedó
 * guardado: por cada fila 'revoke' con `original_message_id` cuyo original no
 * esté marcado, busca el original en el mismo chat por id interno, le pone
 * eliminado_at (la fecha del revoke) y da de baja la fila suelta (deleted_at),
 * que es lo mismo que habría pasado si el webhook lo hubiera encontrado.
 *
 * Uso:
 *   node scripts/repararRevokesDesdeApp.js                 # simula, todas las cuentas, 7 días
 *   node scripts/repararRevokesDesdeApp.js --cfg=548       # simula, una cuenta
 *   node scripts/repararRevokesDesdeApp.js --dias=30       # ventana más larga
 *   node scripts/repararRevokesDesdeApp.js --cfg=548 --chat=945896   # un solo chat (id de clientes_chat_center)
 *   node scripts/repararRevokesDesdeApp.js --cfg=548 --aplicar
 *
 * Nota: la carga del chat (chat.service getChatsByClient) filtra deleted_at
 * IS NULL; sin eso la fila suelta seguiría pintándose aunque esté de baja.
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }),
);
const APLICAR = !!args.aplicar;
const CFG = args.cfg ? Number(args.cfg) : null;
const CHAT = args.chat ? Number(args.chat) : null;
const DIAS = Number(args.dias || 7);

function idInternoDeWamid(wamid) {
  const b64 = String(wamid || '').replace(/^wamid\./, '');
  if (!b64) return null;
  try {
    const crudo = Buffer.from(b64, 'base64').toString('latin1');
    const m = crudo.match(/([0-9A-F]{16,})[^0-9A-F]*$/i);
    return m ? m[1].toUpperCase() : null;
  } catch (_) {
    return null;
  }
}

(async () => {
  const revokes = await db.query(
    `SELECT id, id_configuracion, celular_recibe, ruta_archivo, created_at
       FROM mensajes_clientes
      WHERE tipo_mensaje = 'revoke'
        AND deleted_at IS NULL
        AND ruta_archivo LIKE '{"original_message_id"%'
        AND created_at >= NOW() - INTERVAL :dias DAY
        ${CFG ? 'AND id_configuracion = :cfg' : ''}
        ${CHAT ? 'AND celular_recibe = :chat' : ''}
      ORDER BY id`,
    {
      replacements: { dias: DIAS, cfg: CFG, chat: CHAT },
      type: db.QueryTypes.SELECT,
    },
  );

  console.log(
    `${APLICAR ? 'APLICANDO' : 'SIMULACIÓN'} · ${revokes.length} revoke(s) sueltos en ${DIAS} días${CFG ? ` · cfg ${CFG}` : ''}${CHAT ? ` · chat ${CHAT}` : ''}`,
  );

  let reparados = 0;
  let sinOriginal = 0;
  for (const r of revokes) {
    let wamid = null;
    try {
      wamid = JSON.parse(r.ruta_archivo)?.original_message_id || null;
    } catch (_) {}
    const idBuscado = idInternoDeWamid(wamid);
    if (!idBuscado) {
      sinOriginal++;
      continue;
    }

    // Mensajes del mismo chat anteriores al revoke (ventana de WhatsApp: 2 días)
    const candidatos = await db.query(
      `SELECT id, id_wamid_mensaje, rol_mensaje, responsable, eliminado_at,
              LEFT(texto_mensaje, 80) AS txt, created_at
         FROM mensajes_clientes
        WHERE id_configuracion = :cfg
          AND celular_recibe = :chat
          AND id < :idRevoke
          AND id_wamid_mensaje IS NOT NULL
          AND created_at >= DATE_SUB(:fecha, INTERVAL 3 DAY)
        ORDER BY id DESC
        LIMIT 400`,
      {
        replacements: {
          cfg: r.id_configuracion,
          chat: r.celular_recibe,
          idRevoke: r.id,
          fecha: r.created_at,
        },
        type: db.QueryTypes.SELECT,
      },
    );
    const original = candidatos.find(
      (c) => idInternoDeWamid(c.id_wamid_mensaje) === idBuscado,
    );
    if (!original) {
      sinOriginal++;
      console.log(
        `  revoke ${r.id} (cfg ${r.id_configuracion}, chat ${r.celular_recibe}): original ${idBuscado} no está en la BD, se deja como está`,
      );
      continue;
    }

    console.log(
      `  revoke ${r.id} (cfg ${r.id_configuracion}, chat ${r.celular_recibe}) → original ${original.id} [${original.responsable || (original.rol_mensaje === 0 ? 'cliente' : 'saliente')}] "${(original.txt || '').replace(/\n/g, ' ')}" ${original.eliminado_at ? '(ya marcado)' : ''}`,
    );
    reparados++;

    if (!APLICAR) continue;

    await db.query(
      `UPDATE mensajes_clientes
          SET eliminado_at = COALESCE(eliminado_at, :fecha),
              texto_original = COALESCE(texto_original, texto_mensaje),
              updated_at = NOW()
        WHERE id = :id`,
      {
        replacements: { id: original.id, fecha: r.created_at },
        type: db.QueryTypes.UPDATE,
      },
    );
    await db.query(
      `UPDATE mensajes_clientes SET deleted_at = NOW() WHERE id = :id`,
      { replacements: { id: r.id }, type: db.QueryTypes.UPDATE },
    );
    // Si la fila suelta era el último mensaje del chat, el sidebar la mostraba
    // como preview: se recalcula con el último mensaje vivo.
    await db.query(
      `UPDATE clientes_chat_center c
         JOIN (SELECT id, texto_mensaje, tipo_mensaje, rol_mensaje, ruta_archivo, created_at
                 FROM mensajes_clientes
                WHERE celular_recibe = :chat AND id_configuracion = :cfg AND deleted_at IS NULL
                ORDER BY id DESC LIMIT 1) u
          SET c.ultimo_msg_id = u.id, c.ultimo_texto = u.texto_mensaje,
              c.ultimo_tipo_mensaje = u.tipo_mensaje, c.ultimo_rol_mensaje = u.rol_mensaje,
              c.ultimo_ruta_archivo = u.ruta_archivo, c.ultimo_mensaje_at = u.created_at
        WHERE c.id = :chat AND c.ultimo_msg_id = :idRevoke`,
      {
        replacements: {
          chat: r.celular_recibe,
          cfg: r.id_configuracion,
          idRevoke: r.id,
        },
        type: db.QueryTypes.UPDATE,
      },
    );
  }

  console.log(
    `\n${APLICAR ? 'Reparados' : 'Reparables'}: ${reparados} · sin original en la BD: ${sinOriginal}`,
  );
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
