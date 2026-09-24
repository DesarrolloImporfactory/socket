'use strict';

/**
 * Rescate de turnos de IA perdidos (reinicios del servidor, cuenta de OpenAI
 * sin saldo, errores transitorios de OpenAI).
 *
 * El webhook responde 200 a Meta apenas guarda el mensaje y la IA corre
 * después, en el mismo proceso: si el servidor se reinicia en ese medio
 * (deploy a producción, crash), el mensaje QUEDA guardado pero el cliente
 * nunca recibe respuesta — y Meta no reintenta porque ya le dimos el 200.
 * Caso real (2026-08-19, cfg 403, Silvana): "Quiero comprar el Cubre Canas"
 * a las 19:40, cero respuesta, y un humano tuvo que asignarse el chat una
 * hora después.
 *
 * Dos modos, misma detección y mismo turno:
 *
 * 1. CRON (cada 5 minutos): busca en TODAS las cuentas los chats cuyo ÚLTIMO
 *    mensaje es del cliente (rol 0) con entre 5 y 120 minutos de antigüedad —
 *    esa sola condición descarta los ya respondidos (habría un rol 1 después),
 *    los tomados por un humano (la notificación de asignación es rol 3 y
 *    también queda después) y los que el cliente sigue escribiendo (su
 *    mensaje nuevo corre por el webhook normal). A cada candidato le corre el
 *    MISMO turno de IA del webhook (enviarAsistenteKanban →
 *    procesarMensajeKanban), que re-valida por dentro todos los gates (bot
 *    apagado, plan, columna sin IA) y responde por el canal de siempre.
 *
 * 2. RECARGA (a pedido, una cuenta): cuando una cuenta vuelve a tener saldo
 *    en OpenAI —lo detecta la primera llamada exitosa del bot o el botón
 *    "Ya pagué" de /asistentes— se recorren TODOS sus chats que quedaron sin
 *    respuesta en las últimas 23 h y se les corre el turno con el contexto
 *    de siempre, así el bot retoma la venta donde quedó. El tope de 23 h es
 *    la ventana de servicio de Meta: pasadas 24 h desde el último mensaje del
 *    cliente ya no se puede responder con texto libre. Caso real (2026-09-24,
 *    cfg 320): sin saldo de 06:02 a 08:24, 15 contactos nuevos esperando
 *    hasta 89 minutos, y el cron no los tocaba porque la cuenta estaba
 *    marcada inactiva.
 *
 * Los avisos que el propio bot deja en el chat cuando no pudo responder
 * (rol 3, responsable 'sistema_ia', ver kanban_ia.service) NO cuentan como
 * "algo posterior": el chat sigue pendiente hasta que el bot o un humano
 * conteste de verdad.
 *
 * Doble candado contra corridas dobles (la BD es compartida entre prod, dev
 * y local — ver misma-bd-dev-y-prod):
 *   1. Solo corre con NODE_ENV=production (el que atiende los webhooks).
 *   2. GET_LOCK de MySQL durante el barrido: el cron no espera (si otro
 *      proceso lo tiene, se salta el ciclo); la reanudación por recarga sí
 *      espera hasta 5 minutos, porque no vuelve a dispararse sola.
 */

const cron = require('node-cron');
const { db } = require('../database/config');
const { leerApiKeyOpenAI } = require('../utils/openia/apiKeyOpenAI');

const VENTANA_MIN_MINUTOS = 5; // más nuevo = puede estar procesándose aún
const VENTANA_MAX_MINUTOS = 120; // más viejo = respuesta tardía sin sentido
const VENTANA_RECARGA_MINUTOS = 23 * 60; // ventana de servicio de Meta (24 h)
const MAX_POR_CORRIDA = 20; // tope tras una caída larga: se drena de a 20
const MAX_POR_RECARGA = 200; // una cuenta sin saldo un día entero
const LOCK_NOMBRE = 'cron_rescate_ia';
const RESPONSABLE_AVISO_SISTEMA = 'sistema_ia';

const enCurso = new Set(); // 'global' | 'cfg:<id>' — candado en memoria

/**
 * Detecta y corre los turnos pendientes.
 *
 * @param {object} opts
 *   id_configuracion  solo esa cuenta (null = todas)
 *   ventanaMinMinutos / ventanaMaxMinutos  antigüedad del último mensaje
 *   tope              máximo de chats por corrida
 *   esperaLockSeg     cuánto esperar el GET_LOCK (0 = no esperar)
 *   motivo            'cron' | 'recarga' (solo para el log)
 * @returns {{ rescatados: number, candidatos: number, motivo?: string }}
 */
async function rescatarPendientes({
  id_configuracion = null,
  ventanaMinMinutos = VENTANA_MIN_MINUTOS,
  ventanaMaxMinutos = VENTANA_MAX_MINUTOS,
  tope = MAX_POR_CORRIDA,
  esperaLockSeg = 0,
  motivo = 'cron',
} = {}) {
  if (process.env.NODE_ENV !== 'production') {
    // La BD es la de producción también en local/dev: si esto corriera acá,
    // una laptop respondería chats reales (y en doble con el server).
    return { rescatados: 0, candidatos: 0, motivo: 'no_produccion' };
  }

  const clave = id_configuracion ? `cfg:${id_configuracion}` : 'global';
  if (enCurso.has(clave))
    return { rescatados: 0, candidatos: 0, motivo: 'en_curso' };
  enCurso.add(clave);

  const etiqueta = `[RescateIA${motivo === 'recarga' ? ':recarga' : ''}]`;

  // Lock global entre procesos, sostenido durante TODO el barrido. La
  // transacción es solo para fijar la conexión: GET_LOCK vive por conexión.
  // Es el MISMO lock para el cron y para la recarga: si corrieran a la vez
  // podrían tomar el mismo chat y el cliente recibiría dos respuestas.
  const t = await db.transaction();
  let rescatados = 0;
  let candidatos = 0;
  try {
    const [lock] = await db.query(`SELECT GET_LOCK(?, ?) AS ok`, {
      replacements: [LOCK_NOMBRE, Number(esperaLockSeg) || 0],
      type: db.QueryTypes.SELECT,
      transaction: t,
    });
    if (Number(lock?.ok) !== 1) {
      await t.commit();
      enCurso.delete(clave);
      // otro proceso está barriendo
      return { rescatados: 0, candidatos: 0, motivo: 'lock_ocupado' };
    }

    // Cota por id además de la fecha: obliga el rango por PK aunque el
    // optimizador no elija el índice de created_at (tabla de millones).
    // 2.000.000 de ids son unas 3 semanas de mensajes; sobra para 23 h.
    const [{ mx }] = await db.query(
      `SELECT MAX(id) AS mx FROM mensajes_clientes`,
      { type: db.QueryTypes.SELECT },
    );

    /* TODA la detección en una consulta (la primera versión iteraba ~900
       grupos con 3 queries cada uno y tardaba minutos):
       - el último mensaje del cliente por chat, dentro de la ventana;
       - NOT EXISTS nada posterior (respuesta rol 1, asignación rol 3, o un
         mensaje nuevo del cliente — ese lo atiende el webhook normal),
         salvo los avisos del propio bot ('sistema_ia'), que no cuentan;
       - cliente con bot prendido y chat abierto;
       - configuración kanban viva y con credenciales;
       - y la columna del cliente con IA ACTIVA: medido con datos reales, el
         83% de los chats "sin responder" están en columnas con la IA apagada
         a propósito (asesor, guía generada, cancelados…) — ahí el silencio
         es correcto y barrerlos cada 5 minutos era puro desperdicio. */
    const filtroCfg = id_configuracion ? 'AND m.id_configuracion = :cfg' : '';
    const grupos = await db.query(
      `SELECT g.id_configuracion, g.id_cliente, g.ultimo_cli_id, g.ultimo_cli_at,
              c.celular_cliente, c.estado_contacto,
              cf.api_key_openai, cf.token, cf.id_telefono
         FROM (
           SELECT m.id_configuracion, m.celular_recibe AS id_cliente,
                  MAX(m.id) AS ultimo_cli_id, MAX(m.created_at) AS ultimo_cli_at
             FROM mensajes_clientes m
            WHERE m.id > :idDesde
              ${filtroCfg}
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
                   AND NOT (x.rol_mensaje = 3 AND x.responsable = :aviso)
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
          idDesde: Math.max(0, Number(mx || 0) - 2000000),
          cfg: id_configuracion,
          vmax: ventanaMaxMinutos,
          vmin: ventanaMinMinutos,
          tope,
          aviso: RESPONSABLE_AVISO_SISTEMA,
        },
        type: db.QueryTypes.SELECT,
      },
    );
    candidatos = grupos.length;
    if (!grupos.length) return { rescatados: 0, candidatos: 0 };

    if (motivo === 'recarga')
      console.log(
        `${etiqueta} cfg=${id_configuracion}: ${grupos.length} chat(s) sin respuesta en las últimas ${ventanaMaxMinutos} min, se reanudan`,
      );

    for (const g of grupos) {
      /* Re-chequeo justo antes de correr la IA: entre la consulta y este
         punto pasan segundos (cada rescate anterior llama a OpenAI) y el
         webhook normal pudo haber contestado ya — cualquier mensaje
         posterior (que no sea un aviso del sistema) descarta el candidato. */
      const [algoDespues] = await db.query(
        `SELECT 1 AS x FROM mensajes_clientes
          WHERE celular_recibe = ? AND id_configuracion = ?
            AND id > ? AND deleted_at IS NULL
            AND NOT (rol_mensaje = 3 AND responsable = ?)
          LIMIT 1`,
        {
          replacements: [
            g.id_cliente,
            g.id_configuracion,
            g.ultimo_cli_id,
            RESPONSABLE_AVISO_SISTEMA,
          ],
          type: db.QueryTypes.SELECT,
        },
      );
      if (algoDespues) continue;

      const cli = {
        celular_cliente: g.celular_cliente,
        estado_contacto: g.estado_contacto,
      };
      const cfg = {
        api_key_openai: leerApiKeyOpenAI(g.api_key_openai),
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
        `${etiqueta} cfg=${g.id_configuracion} cliente=${g.id_cliente} sin respuesta desde ${g.ultimo_cli_at}: se corre el turno perdido`,
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
        if (r?.ok) rescatados++;
        console.log(
          `${etiqueta} cfg=${g.id_configuracion} cliente=${g.id_cliente} → ${JSON.stringify(r).slice(0, 200)}`,
        );

        /* Si la cuenta volvió a quedarse sin saldo a mitad de la reanudación
           no tiene sentido seguir quemando el resto: cada turno fallaría y
           dejaría su aviso. Se corta y la próxima recarga los retoma. */
        if (r?.motivo === 'sin_saldo_openai') {
          console.log(
            `${etiqueta} cfg=${g.id_configuracion} sin saldo otra vez: se corta la corrida`,
          );
          break;
        }
      } catch (e) {
        console.log(
          `${etiqueta} cfg=${g.id_configuracion} cliente=${g.id_cliente} falló: ${e?.message}`,
        );
      }
    }
    if (rescatados || motivo === 'recarga')
      console.log(
        `${etiqueta} corrida completa: ${rescatados} rescatados de ${candidatos}`,
      );
  } catch (e) {
    console.log(`${etiqueta} barrido falló: ${e?.message}`);
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
    enCurso.delete(clave);
  }
  return { rescatados, candidatos };
}

/** Barrido del cron: todas las cuentas, ventana 5–120 min, sin esperar el lock. */
async function barrido() {
  return rescatarPendientes({ motivo: 'cron' });
}

/**
 * Reanudar los chats que una cuenta dejó sin responder (p. ej. porque se
 * quedó sin saldo en OpenAI). Se llama cuando la cuenta vuelve a responder.
 * Fire-and-forget: nunca lanza ni bloquea al que lo llama.
 */
function reanudarChatsPendientes(id_configuracion, origen = 'recarga') {
  const id = Number(id_configuracion);
  if (!id) return;
  setImmediate(() => {
    rescatarPendientes({
      id_configuracion: id,
      ventanaMinMinutos: 0,
      ventanaMaxMinutos: VENTANA_RECARGA_MINUTOS,
      tope: MAX_POR_RECARGA,
      esperaLockSeg: 300,
      motivo: 'recarga',
    }).catch((e) =>
      console.log(
        `[RescateIA:recarga] cfg=${id} (${origen}) falló: ${e?.message}`,
      ),
    );
  });
}

if (process.env.NODE_ENV === 'production') {
  cron.schedule('*/5 * * * *', barrido);
  console.log('[RescateIA] cron registrado (cada 5 min)');
} else {
  // La BD es la de producción también en local/dev: si esto corriera acá,
  // una laptop respondería chats reales (y en doble con el server).
  console.log('[RescateIA] desactivado (NODE_ENV != production)');
}

module.exports = {
  barrido,
  rescatarPendientes,
  reanudarChatsPendientes,
  RESPONSABLE_AVISO_SISTEMA,
};
