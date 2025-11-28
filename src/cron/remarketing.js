// cron/remarketing.js
const cron = require('node-cron');
const axios = require('axios');
const { db } = require('../database/config');
const { sendWhatsappMessage } = require('../services/whatsapp.service');
const ClientesChatCenter = require('../models/clientes_chat_center.model');

async function withLock(lockName, fn) {
  // intenta tomar el lock hasta 1s
  const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
    replacements: [lockName],
    type: db.QueryTypes.SELECT,
  });
  if (!row || row.got !== 1) {
    console.log('🔒 No se obtuvo lock, otro proceso está ejecutando el cron');
    return;
  }
  try {
    await fn();
  } finally {
    await db.query(`DO RELEASE_LOCK(?)`, {
      replacements: [lockName],
      type: db.QueryTypes.RAW,
    });
  }
}

cron.schedule('*/5 * * * *', async () => {
  await withLock('remarketing_cron_lock', async () => {
    /* console.log('⏱️ Ejecutando tarea de remarketing'); */

    const pendientes = await db.query(
      `SELECT * FROM remarketing_pendientes 
       WHERE enviado = 0 AND cancelado = 0 AND tiempo_disparo <= NOW()`,
      { type: db.QueryTypes.SELECT }
    );

    for (const record of pendientes) {
      try {
        const headers = {
          Authorization: `Bearer ${record.openai_token}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2',
        };

        await axios.post(
          `https://api.openai.com/v1/threads/${record.id_thread}/messages`,
          {
            role: 'user',
            content:
              '📣 Haz un mensaje de remarketing basado en la última conversación. Sé persuasivo pero amigable.',
          },
          { headers }
        );

        const run = await axios.post(
          `https://api.openai.com/v1/threads/${record.id_thread}/runs`,
          {
            assistant_id: record.assistant_id,
            max_completion_tokens: 200,
          },
          { headers }
        );

        let status = 'queued';
        let intentos = 0;

        while (status !== 'completed' && status !== 'failed' && intentos < 20) {
          await new Promise((r) => setTimeout(r, 1000));
          intentos++;
          const res = await axios.get(
            `https://api.openai.com/v1/threads/${record.id_thread}/runs/${run.data.id}`,
            { headers }
          );
          status = res.data.status;
        }

        if (status === 'completed') {
          const mensajesRes = await axios.get(
            `https://api.openai.com/v1/threads/${record.id_thread}/messages`,
            { headers }
          );

          const mensajes = mensajesRes.data.data || [];
          const respuesta = mensajes
            .reverse()
            .find((m) => m.role === 'assistant' && m.run_id === run.data.id)
            ?.content[0]?.text?.value;

          if (respuesta) {
            await sendWhatsappMessage({
              telefono: record.telefono,
              mensaje: respuesta,
              business_phone_id: record.business_phone_id,
              accessToken: record.access_token,
              id_configuracion: record.id_configuracion,
              responsable: 'IA_remarketing',
            });

            await ClientesChatCenter.update(
              { estado_contacto: 'seguimiento' },
              { where: { id: record.id_cliente_chat_center } }
            );

            await db.query(
              `UPDATE remarketing_pendientes SET enviado = 1 WHERE id = ?`,
              { replacements: [record.id], type: db.QueryTypes.UPDATE }
            );
          }
        }
      } catch (err) {
        console.error('❌ Error en cron remarketing:', err.message);
      }
    }
  });
});
