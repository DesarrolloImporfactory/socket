'use strict';

/**
 * Rescate de turnos de IA perdidos (reinicios del servidor).
 *
 * El webhook responde 200 a Meta apenas guarda el mensaje y la IA corre
 * después, en el mismo proceso: si el servidor se reinicia en ese medio
 * (deploy a producción, crash), el mensaje QUEDA guardado pero el cliente
 * nunca recibe respuesta — y Meta no reintenta porque ya le dimos el 200.
 * Caso real (2026-08-19, cfg 403, Silvana): "Quiero comprar el Cubre Canas"
 * a las 19:40, cero respuesta, y un humano tuvo que asignarse el chat una
 * hora después.
 *
 * Cada 5 minutos: busca chats cuyo ÚLTIMO mensaje es del cliente (rol 0) con
 * entre 5 y 120 minutos de antigüedad — esa sola condición descarta los ya
 * respondidos (habría un rol 1 después), los tomados por un humano (la
 * notificación de asignación es rol 3 y también queda después) y los que el
 * cliente sigue escribiendo (su mensaje nuevo corre por el webhook normal).
 * A cada candidato le corre el MISMO turno de IA del webhook
 * (enviarAsistenteKanban → procesarMensajeKanban), que re-valida por dentro
 * todos los gates (bot apagado, plan, columna sin IA) y responde por el canal
 * de siempre.
 *
 * Doble candado contra corridas dobles (la BD es compartida entre prod, dev
 * y local — ver misma-bd-dev-y-prod):
 *   1. Solo corre con NODE_ENV=production (el que atiende los webhooks).
 *   2. GET_LOCK de MySQL durante el barrido: si otro proceso lo tiene, este
 *      ciclo se salta entero.
 */

const cron = require('node-cron');
const { db } = require('../database/config');

const VENTANA_MIN_MINUTOS = 5; // más nuevo = puede estar procesándose aún
const VENTANA_MAX_MINUTOS = 120; // más viejo = respuesta tardía sin sentido
const MAX_POR_CORRIDA = 20; // tope tras una caída larga: se drena de a 20
const LOCK_NOMBRE = 'cron_rescate_ia';

let corriendo = false;

async function barrido() {
  if (corriendo) return;
  corriendo = true;

  // Lock global entre procesos, sostenido durante TODO el barrido. La
  // transacción es solo para fijar la conexión: GET_LOCK vive por conexión.
  const t = await db.transaction();
  try {
    const [lock] = await db.query(`SELECT GET_LOCK(?, 0) AS ok`, {
      replacements: [LOCK_NOMBRE],
      type: db.QueryTypes.SELECT,
      transaction: t,
    });
    if (Number(lock?.ok) !== 1) {
      await t.commit();
      corriendo = false;
      return; // otro proceso está barriendo
    }

    // Cota por id además de la fecha: obliga el rango por PK aunque el
    // optimizador no elija el índice de created_at (tabla de millones).
    const [{ mx }] = await db.query(
      `SELECT MAX(id) AS mx FROM mensajes_clientes`,
      { type: db.QueryTypes.SELECT },
    );

    /* TODA la detección en una consulta (la primera versión iteraba ~900
       grupos con 3 queries cada uno y tardaba minutos):
       - el último mensaje del cliente por chat, dentro de la ventana;
       - NOT EXISTS nada posterior (respuesta rol 1, asignación rol 3, o un
         mensaje nuevo del cliente — ese lo atiende el webhook normal);
       - cliente con bot prendido y chat abierto;
       - configuración kanban viva y con credenciales;
       - y la columna del cliente con IA ACTIVA: medido con datos reales, el
         83% de los chats "sin responder" están en columnas con la IA apagada
         a propósito (asesor, guía generada, cancelados…) — ahí el silencio
         es correcto y barrerlos cada 5 minutos era puro desperdicio. */
    const grupos = await db.query(
      `SELECT g.id_configuracion, g.id_cliente, g.ultimo_cli_id, g.ultimo_cli_at,
              c.celular_cliente, c.estado_contacto,
              cf.api_key_openai, cf.token, cf.id_telefono
         FROM (
           SELECT m.id_configuracion, m.celular_recibe AS id_cliente,
                  MAX(m.id) AS ultimo_cli_id, MAX(m.created_at) AS ultimo_cli_at
             FROM mensajes_clientes m
            WHERE m.id > :idDesde
              AND m.created_at >= NOW() - INTERVAL :vmax MINUTE
              AND m.created_at <  NOW() - INTERVAL :vmin MINUTE
              AND m.rol_mensaje = 0 AND m.deleted_at IS NULL
            GROUP BY m.id_configuracion, m.celular_recibe
         ) g
         JOIN clientes_chat_center c
           ON c.id = CAST(g.id_cliente AS UNSIGNED)
          AND c.id_configuracion = g.id_configuracion
          AND c.bot_openia = 1 AND c.chat_cerrado = 0
         JOIN configuraciones cf
           ON cf.id = g.id_configuracion
          AND cf.tipo_configuracion = 'kanban'
          AND cf.suspendido = 0 AND cf.openai_activo = 1
          AND cf.api_key_openai IS NOT NULL
          AND cf.token IS NOT NULL AND cf.id_telefono IS NOT NULL
        WHERE NOT EXISTS (
                SELECT 1 FROM mensajes_clientes x
                 WHERE x.celular_recibe = g.id_cliente
                   AND x.id_configuracion = g.id_configuracion
                   AND x.id > g.ultimo_cli_id AND x.deleted_at IS NULL
              )
          AND EXISTS (
                SELECT 1 FROM kanban_columnas k
                 WHERE k.id_configuracion = g.id_configuracion
                   AND k.estado_db = c.estado_contacto
                   AND k.activa_ia = 1
              )
        ORDER BY g.ultimo_cli_id ASC
        LIMIT :tope`,
      {
        replacements: {
          idDesde: Math.max(0, Number(mx || 0) - 500000),
          vmax: VENTANA_MAX_MINUTOS,
          vmin: VENTANA_MIN_MINUTOS,
          tope: MAX_POR_CORRIDA,
        },
        type: db.QueryTypes.SELECT,
      },
    );
    if (!grupos.length) return;

    let rescatados = 0;
    for (const g of grupos) {
      /* Re-chequeo justo antes de correr la IA: entre la consulta y este
         punto pasan segundos (cada rescate anterior llama a OpenAI) y el
         webhook normal pudo haber contestado ya — cualquier mensaje
         posterior descarta el candidato. */
      const [algoDespues] = await db.query(
        `SELECT 1 AS x FROM mensajes_clientes
          WHERE celular_recibe = ? AND id_configuracion = ?
            AND id > ? AND deleted_at IS NULL LIMIT 1`,
        {
          replacements: [g.id_cliente, g.id_configuracion, g.ultimo_cli_id],
          type: db.QueryTypes.SELECT,
        },
      );
      if (algoDespues) continue;

      const cli = { celular_cliente: g.celular_cliente, estado_contacto: g.estado_contacto };
      const cfg = {
        api_key_openai: g.api_key_openai,
        token: g.token,
        id_telefono: g.id_telefono,
      };

      // Todo lo que el cliente escribió desde la última respuesta del bot:
      // si mandó varios mensajes durante la caída, van juntos como una ráfaga.
      const pendientes = await db.query(
        `SELECT texto_mensaje FROM mensajes_clientes
          WHERE celular_recibe = ? AND id_configuracion = ?
            AND rol_mensaje = 0 AND deleted_at IS NULL
            AND id > COALESCE((SELECT MAX(m2.id) FROM mensajes_clientes m2
                                WHERE m2.celular_recibe = ? AND m2.id_configuracion = ?
                                  AND m2.rol_mensaje = 1 AND m2.deleted_at IS NULL), 0)
          ORDER BY id ASC LIMIT 10`,
        {
          replacements: [
            g.id_cliente,
            g.id_configuracion,
            g.id_cliente,
            g.id_configuracion,
          ],
          type: db.QueryTypes.SELECT,
        },
      );
      const mensaje = pendientes
        .map((m) => String(m.texto_mensaje || '').trim())
        .filter(Boolean)
        .join('\n');
      if (!mensaje) continue;

      console.log(
        `[RescateIA] cfg=${g.id_configuracion} cliente=${g.id_cliente} sin respuesta desde ${g.ultimo_cli_at}: se corre el turno perdido`,
      );

      try {
        /* require acá adentro y no arriba: funcciones_asistente arrastra
           kanban_ia y medio mundo; cargarlo al registrar el cron alarga el
           arranque y arriesga requires circulares. */
        const {
          enviarAsistenteKanban,
        } = require('../utils/webhook_whatsapp/funcciones_asistente');

        const r = await enviarAsistenteKanban({
          mensaje,
          id_configuracion: g.id_configuracion,
          id_cliente: Number(g.id_cliente),
          telefono: cli.celular_cliente,
          api_key_openai: cfg.api_key_openai,
          business_phone_id: cfg.id_telefono,
          accessToken: cfg.token,
          estado_contacto: cli.estado_contacto,
        });
        rescatados++;
        console.log(
          `[RescateIA] cfg=${g.id_configuracion} cliente=${g.id_cliente} → ${JSON.stringify(r).slice(0, 200)}`,
        );
      } catch (e) {
        console.log(
          `[RescateIA] cfg=${g.id_configuracion} cliente=${g.id_cliente} falló: ${e?.message}`,
        );
      }
    }
    if (rescatados)
      console.log(`[RescateIA] corrida completa: ${rescatados} rescatados`);
  } catch (e) {
    console.log(`[RescateIA] barrido falló: ${e?.message}`);
  } finally {
    try {
      await db.query(`SELECT RELEASE_LOCK(?) AS ok`, {
        replacements: [LOCK_NOMBRE],
        type: db.QueryTypes.SELECT,
        transaction: t,
      });
      await t.commit();
    } catch (_) {
      try {
        await t.rollback();
      } catch (__) {}
    }
    corriendo = false;
  }
}

if (process.env.NODE_ENV === 'production') {
  cron.schedule('*/5 * * * *', barrido);
  console.log('[RescateIA] cron registrado (cada 5 min)');
} else {
  // La BD es la de producción también en local/dev: si esto corriera acá,
  // una laptop respondería chats reales (y en doble con el server).
  console.log('[RescateIA] desactivado (NODE_ENV != production)');
}

module.exports = { barrido };
