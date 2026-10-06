const cron = require('node-cron');
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const ChatService = require('../services/chat.service');

const BATCH_SIZE = 30;
const MAX_INTENTOS = 3;

/* Mensajes del cliente que cierran la conversación en vez de seguirla: un
   agradecimiento, un "ok", un emoji, una reacción. Si lo único que escribió
   después del cierre es esto, la encuesta sí se manda. */
const RE_ACUSE =
  /^(?:(?:muchas|mil|muchisimas)\s+)?gracias(?:\s+.{0,25})?$|^(?:ok|okey|okay|oki|listo|perfecto|dale|vale|de acuerdo|excelente|genial|bueno|ya|entendido|super|buenisimo|igualmente|bendiciones)(?:\s+(?:muchas\s+)?gracias)?$/;

function esAcuse(m) {
  const tipo = String(m?.tipo_mensaje || '').toLowerCase();
  if (tipo === 'reaction' || tipo === 'sticker') return true;
  if (tipo && tipo !== 'text') return false; // foto, audio, documento: sigue el caso
  const t = String(m?.texto_mensaje || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return !t || RE_ACUSE.test(t);
}

async function withLock(lockName, fn) {
  const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
    replacements: [lockName],
    type: QueryTypes.SELECT,
  });
  if (!row || Number(row.got) !== 1) {
    /* console.log('[cron-encuestas] 🔒 No se obtuvo lock, skip'); */
    return;
  }
  try {
    await fn();
  } finally {
    await db.query(`DO RELEASE_LOCK(?)`, {
      replacements: [lockName],
      type: QueryTypes.RAW,
    });
  }
}

async function procesarEnviosPendientes() {
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

  if (pendientes.length === 0) return;

  console.log(
    `[cron-encuestas] Procesando ${pendientes.length} envíos pendientes`,
  );

  const chatService = new ChatService();

  for (const envio of pendientes) {
    const [, claimedCount] = await db.query(
      `UPDATE encuestas_envios_programados
         SET estado = 'enviando', updated_at = NOW()
       WHERE id = :id AND estado = 'pendiente'`,
      { replacements: { id: envio.id }, type: QueryTypes.UPDATE },
    );
    if (!claimedCount) continue;

    let yaEnviadoAWhatsapp = false;
    try {
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

      /* El cliente siguió escribiendo después de que se programó la encuesta:
         la conversación no terminó. Mandarle "¿cómo fue tu experiencia?"
         encima de su pregunta sin contestar es justo lo contrario de lo que
         busca la encuesta (cfg 261, 2026-10-05: le llegó 6 segundos
         después de pedir fotos). Un "gracias" o un 👍 no cuentan: eso sí es
         el final. Se marca 'expirada' y no 'pendiente' para que el cooldown
         no bloquee la encuesta del próximo cierre. */
      const posteriores = await db.query(
        `SELECT m.tipo_mensaje, m.texto_mensaje
           FROM mensajes_clientes m
          WHERE m.celular_recibe = :chatId
            AND m.id_configuracion = :cfg
            AND m.rol_mensaje = 0 AND m.deleted_at IS NULL
            AND m.created_at > (SELECT e.created_at
                                  FROM encuestas_envios_programados e
                                 WHERE e.id = :id)
          ORDER BY m.id ASC LIMIT 8`,
        {
          replacements: {
            chatId: String(envio.id_cliente_chat_center),
            cfg: envio.id_configuracion,
            id: envio.id,
          },
          type: QueryTypes.SELECT,
        },
      );
      if (posteriores.some((m) => !esAcuse(m))) {
        await db.query(
          `UPDATE encuestas_envios_programados
           SET estado = 'cancelado', error_ultimo = 'cliente_siguio_escribiendo'
           WHERE id = :id`,
          { replacements: { id: envio.id }, type: QueryTypes.UPDATE },
        );
        await db.query(
          `UPDATE encuestas_respuestas SET estado = 'expirada', updated_at = NOW() WHERE id = :id`,
          { replacements: { id: envio.id_respuesta }, type: QueryTypes.UPDATE },
        );
        console.log(
          `[cron-encuestas] Cancelado envio=${envio.id} (el cliente siguió escribiendo tras el cierre)`,
        );
        continue;
      }

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

      const dataAdmin = await chatService.getDataAdmin(envio.id_configuracion);
      if (!dataAdmin)
        throw new Error(`No dataAdmin para config=${envio.id_configuracion}`);

      const to = String(envio.celular || '')
        .replace(/\s+/g, '')
        .replace(/^\+/, '');
      if (!to) throw new Error('Celular vacío');

      const resp2 = await chatService.sendMessage({
        mensaje: envio.mensaje,
        to,
        dataAdmin,
        tipo_mensaje: 'text',
        id_configuracion: envio.id_configuracion,
        nombre_encargado: 'Sistema de valoraciones',
        ruta_archivo: null,
      });
      yaEnviadoAWhatsapp = true;

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
      if (yaEnviadoAWhatsapp) {
        await db.query(
          `UPDATE encuestas_envios_programados
           SET estado = 'enviado', enviado_at = COALESCE(enviado_at, NOW()), error_ultimo = :err
           WHERE id = :id`,
          {
            replacements: {
              id: envio.id,
              err: `post-envio: ${String(err.message).substring(0, 480)}`,
            },
            type: QueryTypes.UPDATE,
          },
        );
        console.error(
          `[cron-encuestas] ⚠️ envio=${envio.id} entregado pero falló post-procesamiento: ${err.message}`,
        );
      } else {
        await db.query(
          `UPDATE encuestas_envios_programados
           SET intentos = intentos + 1,
               error_ultimo = :err,
               estado = IF(intentos + 1 >= :max, 'fallido', 'pendiente')
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
  }
}

cron.schedule('* * * * *', async () => {
  await withLock('encuestas_envio_lock', procesarEnviosPendientes);
});

console.log(
  '[cron-encuestas] ✅ Cron de envío de encuestas iniciado (cada 1 min)',
);

module.exports = { procesarEnviosPendientes };
