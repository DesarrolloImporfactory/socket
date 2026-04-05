/**
 * encuestaSatisfaccion.js
 *
 * Utilidad para enviar encuestas de satisfacción al cerrar un chat.
 *
 * FLUJO:
 *   1. Asesor cierra chat → se llama intentarEnviarEncuesta()
 *   2. Verifica si hay encuesta de satisfacción activa para esa conexión
 *   3. Verifica cooldown (no spamear al cliente)
 *   4. Si pasa validaciones → retorna el mensaje + link para que el caller lo envíe
 *   5. El caller (socket handler, API, etc.) envía el mensaje por WhatsApp
 *
 * NOTA: La lógica de envío WhatsApp NO está aquí.
 *       Esta utilidad solo decide SI enviar y devuelve el mensaje armado.
 *       Cuando esté todo funcional, se conecta al emisor de mensajes.
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');

/**
 * Intenta programar/enviar una encuesta de satisfacción al cerrar un chat.
 *
 * @param {Object} params
 * @param {number} params.idConfiguracion  - Conexión/número WA
 * @param {number} params.idClienteChatCenter - ID del cliente
 * @param {number} params.idEncargado - Sub-usuario que cerró el chat
 * @param {string} [params.nombreCliente] - Nombre del cliente (para personalizar mensaje)
 *
 * @returns {Object} { enviado, razon, mensaje?, link?, delay_minutos?, id_respuesta? }
 */
async function intentarEnviarEncuesta({
  idConfiguracion,
  idClienteChatCenter,
  idEncargado,
  nombreCliente,
}) {
  try {
    // ── 1. Buscar encuesta de satisfacción activa para esta conexión ──
    const [config] = await db.query(
      `
      SELECT
        e.id            AS id_encuesta,
        e.cooldown_horas,
        e.delay_envio_minutos,
        e.mensaje_envio,
        e.url_encuesta_publica,
        e.webhook_escalacion_url,
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
      return { enviado: false, razon: 'no_configurada' };
    }

    // ── 2. Verificar cooldown ──
    if (config.cooldown_horas > 0) {
      const [ultima] = await db.query(
        `
        SELECT created_at FROM encuestas_respuestas
        WHERE id_encuesta = :enc
          AND id_cliente_chat_center = :cli
          AND estado IN ('enviada', 'respondida')
        ORDER BY created_at DESC
        LIMIT 1
      `,
        {
          replacements: { enc: config.id_encuesta, cli: idClienteChatCenter },
          type: QueryTypes.SELECT,
        },
      );

      if (ultima) {
        const msDesdeUltima =
          Date.now() - new Date(ultima.created_at).getTime();
        const horasDesdeUltima = msDesdeUltima / (1000 * 60 * 60);

        if (horasDesdeUltima < config.cooldown_horas) {
          const horasRestantes = Math.ceil(
            config.cooldown_horas - horasDesdeUltima,
          );
          console.log(
            `[encuestaSatisfaccion] Cooldown activo para cliente=${idClienteChatCenter}, faltan ~${horasRestantes}h`,
          );
          return {
            enviado: false,
            razon: 'cooldown',
            horas_restantes: horasRestantes,
          };
        }
      }
    }

    // ── 3. Armar link y mensaje ──
    const baseUrl =
      config.url_encuesta_publica || 'http://18.205.94.210:3457/s';
    const link = `${baseUrl}?cid=${idClienteChatCenter}`;

    const mensajeTemplate =
      config.mensaje_envio ||
      '¡Gracias por comunicarte con nosotros, {nombre}! 🙏\n\nNos ayudarías mucho calificando tu experiencia:\n\n👉 {link}\n\n¡Solo toma 10 segundos!';

    const mensaje = mensajeTemplate
      .replace(/\{link\}/g, link)
      .replace(/\{nombre\}/g, nombreCliente || 'estimado cliente');

    // ── 4. Crear registro en estado 'enviada' (pendiente de respuesta) ──
    const [insertId] = await db.query(
      `
      INSERT INTO encuestas_respuestas
        (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
         source, score, respuestas, estado)
      VALUES (:enc, :cfg, :cli, :encargado, 'link', NULL, '{}', 'enviada')
    `,
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

    console.log(
      `[encuestaSatisfaccion] ✅ Encuesta programada: respuesta_id=${insertId} cliente=${idClienteChatCenter} encargado=${idEncargado} delay=${config.delay_envio_minutos}min`,
    );

    return {
      enviado: true,
      mensaje,
      link,
      id_encuesta: config.id_encuesta,
      id_respuesta: insertId,
      delay_minutos: config.delay_envio_minutos || 0,
    };
  } catch (err) {
    console.error('[encuestaSatisfaccion] ❌ ERROR:', err);
    return { enviado: false, razon: 'error', error: err.message };
  }
}

/**
 * Registra la calificación cuando el cliente responde la encuesta.
 * Llamado desde el sistema de satisfacción (18.205.94.210:3457).
 *
 * @param {Object} params
 * @param {number} params.idClienteChatCenter - cid de la URL
 * @param {number} params.score - 1 a 5
 * @param {string} [params.comentario]
 *
 * @returns {Object} { ok, escalado?, id_respuesta? }
 */
async function registrarCalificacion({
  idClienteChatCenter,
  score,
  comentario,
}) {
  try {
    // Buscar la última respuesta 'enviada' para este cliente
    const [pendiente] = await db.query(
      `
      SELECT er.id, er.id_encuesta, er.id_configuracion, er.id_encargado,
             e.webhook_escalacion_url, e.umbral_escalacion
      FROM encuestas_respuestas er
      JOIN encuestas e ON e.id = er.id_encuesta
      WHERE er.id_cliente_chat_center = :cli
        AND er.estado = 'enviada'
        AND e.tipo = 'satisfaccion'
      ORDER BY er.created_at DESC
      LIMIT 1
    `,
      {
        replacements: { cli: idClienteChatCenter },
        type: QueryTypes.SELECT,
      },
    );

    if (!pendiente) {
      // No hay encuesta pendiente, crear una nueva respuesta directa
      console.log(
        `[encuestaSatisfaccion] No hay encuesta pendiente para cliente=${idClienteChatCenter}, creando directa`,
      );

      // Buscar la encuesta de satisfacción del cliente
      const [cliente] = await db.query(
        `
        SELECT c.id_configuracion, c.id_encargado
        FROM clientes_chat_center c
        WHERE c.id = :cli AND c.deleted_at IS NULL
        LIMIT 1
      `,
        {
          replacements: { cli: idClienteChatCenter },
          type: QueryTypes.SELECT,
        },
      );

      if (!cliente) {
        return { ok: false, error: 'Cliente no encontrado' };
      }

      const [encuesta] = await db.query(
        `
        SELECT e.id AS id_encuesta, e.webhook_escalacion_url, e.umbral_escalacion
        FROM encuestas_conexiones ec
        JOIN encuestas e ON e.id = ec.id_encuesta
        WHERE ec.id_configuracion = :cfg
          AND e.tipo = 'satisfaccion'
          AND e.activa = 1
          AND ec.activa = 1
        LIMIT 1
      `,
        {
          replacements: { cfg: cliente.id_configuracion },
          type: QueryTypes.SELECT,
        },
      );

      if (!encuesta) {
        return {
          ok: false,
          error: 'No hay encuesta de satisfacción configurada',
        };
      }

      const escalado = score <= (encuesta.umbral_escalacion || 2) ? 1 : 0;

      const [insertId] = await db.query(
        `
        INSERT INTO encuestas_respuestas
          (id_encuesta, id_configuracion, id_cliente_chat_center, id_encargado,
           source, score, respuestas, estado, escalado)
        VALUES (:enc, :cfg, :cli, :encargado, 'link', :score, :resp, 'respondida', :escalado)
      `,
        {
          replacements: {
            enc: encuesta.id_encuesta,
            cfg: cliente.id_configuracion,
            cli: idClienteChatCenter,
            encargado: cliente.id_encargado,
            score,
            resp: JSON.stringify({ score, comentario: comentario || null }),
            escalado,
          },
          type: QueryTypes.INSERT,
        },
      );

      return { ok: true, id_respuesta: insertId, escalado: escalado === 1 };
    }

    // Actualizar la respuesta pendiente
    const escalado = score <= (pendiente.umbral_escalacion || 2) ? 1 : 0;

    await db.query(
      `
      UPDATE encuestas_respuestas
      SET score = :score,
          respuestas = :resp,
          estado = 'respondida',
          escalado = :escalado,
          updated_at = NOW()
      WHERE id = :id
    `,
      {
        replacements: {
          score,
          resp: JSON.stringify({ score, comentario: comentario || null }),
          escalado,
          id: pendiente.id,
        },
        type: QueryTypes.UPDATE,
      },
    );

    console.log(
      `[encuestaSatisfaccion] ✅ Calificación registrada: respuesta=${pendiente.id} score=${score} encargado=${pendiente.id_encargado} escalado=${escalado}`,
    );

    // TODO: Si escalado, disparar webhook de escalación
    // if (escalado && pendiente.webhook_escalacion_url) {
    //   dispararWebhookEscalacion(pendiente);
    // }

    return {
      ok: true,
      id_respuesta: pendiente.id,
      escalado: escalado === 1,
    };
  } catch (err) {
    console.error(
      '[encuestaSatisfaccion] ❌ ERROR registrarCalificacion:',
      err,
    );
    return { ok: false, error: err.message };
  }
}

module.exports = {
  intentarEnviarEncuesta,
  registrarCalificacion,
};
