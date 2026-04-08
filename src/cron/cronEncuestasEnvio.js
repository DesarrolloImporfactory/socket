/**
 * cronEncuestasEnvio.js
 *
 * Cron que procesa encuestas programadas cada minuto.
 * Sobrevive reinicios del servidor.
 */

const cron = require('node-cron');
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const ChatService = require('../services/chat.service');

const BATCH_SIZE = 30;
const MAX_INTENTOS = 3;
let running = false;

async function procesarEnviosPendientes() {
  if (running) return;
  running = true;

  try {
    const pendientes = await db.query(
      `SELECT id, id_encuesta, id_configuracion, id_cliente_chat_center,
              id_respuesta, celular, mensaje
       FROM encuestas_envios_programados
       WHERE estado = 'pendiente'
         AND enviar_en <= NOW()
         AND intentos < :maxIntentos
       ORDER BY enviar_en ASC
       LIMIT :limit`,
      {
        replacements: { maxIntentos: MAX_INTENTOS, limit: BATCH_SIZE },
        type: QueryTypes.SELECT,
      },
    );

    if (pendientes.length === 0) {
      running = false;
      return;
    }

    console.log(
      `[cron-encuestas] Procesando ${pendientes.length} envíos pendientes`,
    );

    const chatService = new ChatService();

    for (const envio of pendientes) {
      try {
        // Verificar que la respuesta siga en estado pendiente (no fue cancelada/respondida)
        const [resp] = await db.query(
          `SELECT estado FROM encuestas_respuestas WHERE id = :id`,
          { replacements: { id: envio.id_respuesta }, type: QueryTypes.SELECT },
        );

        if (!resp || resp.estado !== 'pendiente') {
          await db.query(
            `UPDATE encuestas_envios_programados SET estado = 'cancelado' WHERE id = :id`,
            { replacements: { id: envio.id }, type: QueryTypes.UPDATE },
          );
          console.log(
            `[cron-encuestas] Cancelado envio=${envio.id} (respuesta ya no es pendiente)`,
          );
          continue;
        }

        // Verificar ventana 24h antes de enviar (pudo haber expirado durante el delay)
        const [ultimoMsg] = await db.query(
          `SELECT MAX(created_at) AS last_incoming
           FROM mensajes_clientes
           WHERE celular_recibe = :chatId AND direction = 'in' AND deleted_at IS NULL`,
          {
            replacements: { chatId: String(envio.id_cliente_chat_center) },
            type: QueryTypes.SELECT,
          },
        );

        if (ultimoMsg?.last_incoming) {
          const ventanaExpira =
            new Date(ultimoMsg.last_incoming).getTime() + 23.5 * 60 * 60 * 1000;
          if (Date.now() > ventanaExpira) {
            await db.query(
              `UPDATE encuestas_envios_programados
               SET estado = 'cancelado', error_ultimo = 'ventana_24h_expirada'
               WHERE id = :id`,
              { replacements: { id: envio.id }, type: QueryTypes.UPDATE },
            );
            await db.query(
              `UPDATE encuestas_respuestas SET estado = 'expirada', updated_at = NOW() WHERE id = :id`,
              {
                replacements: { id: envio.id_respuesta },
                type: QueryTypes.UPDATE,
              },
            );
            console.log(
              `[cron-encuestas] Ventana expirada para envio=${envio.id}`,
            );
            continue;
          }
        }

        // Enviar por WhatsApp
        const dataAdmin = await chatService.getDataAdmin(
          envio.id_configuracion,
        );
        if (!dataAdmin) {
          throw new Error(`No dataAdmin para config=${envio.id_configuracion}`);
        }

        const to = String(envio.celular || '')
          .replace(/\s+/g, '')
          .replace(/^\+/, '');
        if (!to) {
          throw new Error('Celular vacío');
        }

        const resp2 = await chatService.sendMessage({
          mensaje: envio.mensaje,
          to,
          dataAdmin,
          tipo_mensaje: 'text',
          id_configuracion: envio.id_configuracion,
          nombre_encargado: 'Sistema de valoraciones',
          ruta_archivo: null,
        });

        // Marcar como enviado
        await db.query(
          `UPDATE encuestas_envios_programados
           SET estado = 'enviado', enviado_at = NOW()
           WHERE id = :id`,
          { replacements: { id: envio.id }, type: QueryTypes.UPDATE },
        );

        await db.query(
          `UPDATE encuestas_respuestas SET estado = 'enviada', updated_at = NOW() WHERE id = :id`,
          { replacements: { id: envio.id_respuesta }, type: QueryTypes.UPDATE },
        );

        console.log(
          `[cron-encuestas] ✅ Enviado envio=${envio.id} to=${to} mid=${resp2?.mensajeNuevo?.id_wamid_mensaje || 'N/A'}`,
        );
      } catch (err) {
        // Incrementar intentos
        const [updated] = await db.query(
          `UPDATE encuestas_envios_programados
           SET intentos = intentos + 1,
               error_ultimo = :err,
               estado = IF(intentos + 1 >= :max, 'fallido', estado)
           WHERE id = :id`,
          {
            replacements: {
              id: envio.id,
              err: String(err.message).substring(0, 500),
              max: MAX_INTENTOS,
            },
            type: QueryTypes.UPDATE,
          },
        );

        console.error(
          `[cron-encuestas] ❌ Error envio=${envio.id}: ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.error('[cron-encuestas] ❌ Error general:', err);
  } finally {
    running = false;
  }
}

// Correr cada minuto
cron.schedule('* * * * *', procesarEnviosPendientes);

console.log(
  '[cron-encuestas] ✅ Cron de envío de encuestas iniciado (cada 1 min)',
);

module.exports = { procesarEnviosPendientes };
