const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

const FRONTEND_BASE_URL =
  process.env.FRONTEND_URL || 'https://chatcenter.imporfactory.app';
const MAX_DELAY_MINUTOS = 1380; // 23 horas
const VENTANA_WA_MS = 23.5 * 60 * 60 * 1000;

/**
 * Programa una encuesta de satisfacción.
 * Inserta en encuestas_envios_programados para que el cron la envíe.
 *
 * @returns {Object} { programado, razon? }
 */
async function intentarEnviarEncuesta({
  idConfiguracion,
  idClienteChatCenter,
  idEncargado,
  nombreCliente,
}) {
  try {
    // ── 1. Buscar encuesta de satisfacción activa ──
    const [config] = await db.query(
      `
      SELECT
        e.id AS id_encuesta,
        e.cooldown_horas,
        e.delay_envio_minutos,
        e.mensaje_envio,
        e.umbral_escalacion
      FROM encuestas_conexiones ec
      JOIN encuestas e ON e.id = ec.id_encuesta
      WHERE ec.id_configuracion = :cfg
        AND ec.activa = 1
        AND ec.auto_enviar_al_cerrar = 1
        AND e.activa = 1
        AND e.tipo = 'satisfaccion'
        AND e.deleted_at IS NULL
      LIMIT 1
    `,
      {
        replacements: { cfg: idConfiguracion },
        type: QueryTypes.SELECT,
      },
    );

    if (!config) {
      return { programado: false, razon: 'no_configurada' };
    }

    // ── 2. Obtener celular del cliente ──
    const [cliente] = await db.query(
      `SELECT celular_cliente FROM clientes_chat_center
       WHERE id = :id AND deleted_at IS NULL LIMIT 1`,
      {
        replacements: { id: idClienteChatCenter },
        type: QueryTypes.SELECT,
      },
    );

    if (!cliente?.celular_cliente) {
      return { programado: false, razon: 'sin_celular' };
    }

    const celular = cliente.celular_cliente;
    const delayMinutos = Math.min(
      config.delay_envio_minutos || 0,
      MAX_DELAY_MINUTOS,
    );

    // ── 3. Verificar ventana de 24h de WhatsApp ──
    const [ultimoMensaje] = await db.query(
      `SELECT MAX(created_at) AS last_incoming
       FROM mensajes_clientes
       WHERE celular_recibe = :chatId
         AND direction = 'in'
         AND deleted_at IS NULL`,
      {
        replacements: { chatId: String(idClienteChatCenter) },
        type: QueryTypes.SELECT,
      },
    );

    if (ultimoMensaje?.last_incoming) {
      const lastIncoming = new Date(ultimoMensaje.last_incoming).getTime();
      const delayMs = delayMinutos * 60 * 1000;
      const envioEn = Date.now() + delayMs;
      const ventanaExpira = lastIncoming + VENTANA_WA_MS;

      if (envioEn > ventanaExpira) {
        console.log(
          `[encuesta] ⚠️ Fuera de ventana 24h para cliente=${idClienteChatCenter}`,
        );
        return { programado: false, razon: 'fuera_ventana_24h' };
      }
    }

    // ── 4. Verificar cooldown ──
    if (config.cooldown_horas > 0) {
      const [ultima] = await db.query(
        `SELECT created_at FROM encuestas_respuestas
         WHERE id_encuesta = :enc
           AND id_cliente_chat_center = :cli
           AND estado IN ('pendiente', 'enviada', 'respondida')
         ORDER BY created_at DESC LIMIT 1`,
        {
          replacements: { enc: config.id_encuesta, cli: idClienteChatCenter },
          type: QueryTypes.SELECT,
        },
      );

      if (ultima) {
        const horasDesdeUltima =
          (Date.now() - new Date(ultima.created_at).getTime()) /
          (1000 * 60 * 60);
        if (horasDesdeUltima < config.cooldown_horas) {
          return {
            programado: false,
            razon: 'cooldown',
            horas_restantes: Math.ceil(
              config.cooldown_horas - horasDesdeUltima,
            ),
          };
        }
      }
    }

    // ── 5. Cancelar envíos pendientes anteriores del mismo cliente+encuesta ──
    await db.query(
      `UPDATE encuestas_envios_programados
       SET estado = 'cancelado'
       WHERE id_cliente_chat_center = :cli
         AND id_encuesta = :enc
         AND estado = 'pendiente'`,
      {
        replacements: { cli: idClienteChatCenter, enc: config.id_encuesta },
        type: QueryTypes.UPDATE,
      },
    );

    // ── 6. Armar link y mensaje ──
    const link = `${FRONTEND_BASE_URL}/encuesta-publica/${config.id_encuesta}?cid=${idClienteChatCenter}`;

    const mensajeTemplate =
      config.mensaje_envio ||
      '¡Hola {nombre}! 🙏\n\nGracias por comunicarte con nosotros. Nos encantaría saber cómo fue tu experiencia:\n\n👉 {link}\n\n¡Solo toma 10 segundos!';

    const mensaje = mensajeTemplate
      .replace(/\{link\}/g, link)
      .replace(/\{nombre\}/g, nombreCliente || 'estimado cliente');

    // ── 7. Crear registro en encuestas_respuestas ──
    const [idRespuesta] = await db.query(
      `INSERT INTO encuestas_respuestas
        (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
         source, score, respuestas, estado)
       VALUES (:enc, :cfg, :cli, :encargado, 'link', NULL, '{}', 'pendiente')`,
      {
        replacements: {
          enc: config.id_encuesta,
          cfg: idConfiguracion,
          cli: idClienteChatCenter,
          encargado: idEncargado,
        },
        type: QueryTypes.INSERT,
      },
    );

    // ── 8. Programar envío ──
    await db.query(
      `INSERT INTO encuestas_envios_programados
        (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
         id_respuesta, celular, mensaje, enviar_en)
       VALUES (:enc, :cfg, :cli, :encargado, :resp, :cel, :msg,
               DATE_ADD(NOW(), INTERVAL :delay MINUTE))`,
      {
        replacements: {
          enc: config.id_encuesta,
          cfg: idConfiguracion,
          cli: idClienteChatCenter,
          encargado: idEncargado,
          resp: idRespuesta,
          cel: celular,
          msg: mensaje,
          delay: delayMinutos,
        },
        type: QueryTypes.INSERT,
      },
    );

    console.log(
      `[encuesta] ✅ Programada: respuesta_id=${idRespuesta} cliente=${idClienteChatCenter} delay=${delayMinutos}min`,
    );

    return {
      programado: true,
      id_respuesta: idRespuesta,
      delay_minutos: delayMinutos,
    };
  } catch (err) {
    console.error('[encuesta] ❌ ERROR:', err);
    return { programado: false, razon: 'error', error: err.message };
  }
}

module.exports = { intentarEnviarEncuesta };
