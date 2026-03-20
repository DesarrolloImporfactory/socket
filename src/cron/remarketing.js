// cron/remarketing.js
const cron = require('node-cron');
const axios = require('axios');
const { db } = require('../database/config');
const {
  sendWhatsappMessage,
  sendWhatsappMessageTemplateScheduled,
} = require('../services/whatsapp.service');
const ClientesChatCenter = require('../models/clientes_chat_center.model');

async function withLock(lockName, fn) {
  // Usa conexión dedicada fuera del pool para no bloquear conexiones de la API
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
      bind: undefined,
    });
    if (!row || Number(row.got) !== 1) {
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
  } finally {
    db.connectionManager.releaseConnection(conn);
  }
}

let isRunning = false;

cron.schedule('*/1 * * * *', async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    await withLock('remarketing_cron_lock', async () => {
      /* console.log('⏱️ Ejecutando tarea de remarketing'); */

      const pendientes = await db.query(
        `SELECT * FROM remarketing_pendientes 
       WHERE enviado = 0 AND cancelado = 0 AND tiempo_disparo <= NOW()`,
        { type: db.QueryTypes.SELECT },
      );

      for (const record of pendientes) {
        try {
          // 1️⃣ Verificar estado actual del cliente
          const cliente = await ClientesChatCenter.findByPk(
            record.id_cliente_chat_center,
          );

          if (!cliente) continue;

          // Si el estado cambió, cancelar
          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            await db.query(
              `UPDATE remarketing_pendientes
         SET cancelado = 1
         WHERE id = ?`,
              {
                replacements: [record.id],
                type: db.QueryTypes.UPDATE,
              },
            );
            continue;
          }

          // 2️⃣ Enviar plantilla
          await sendWhatsappMessageTemplateScheduled({
            telefono: record.telefono,
            telefono_configuracion: record.telefono_configuracion || null,
            id_configuracion: record.id_configuracion,
            nombre_template: record.nombre_template,
            language_code: record.language_code,
            template_parameters: [], // si luego quieres dinámicos los agregamos
            responsable: 'cron_remarketing_estado',
          });

          // 3️⃣ Actualizar estado automáticamente (opcional)
          /* await ClientesChatCenter.update(
          { estado_contacto: 'seguimiento' },
          { where: { id: record.id_cliente_chat_center } },
        ); */

          const estadoDestino = record.estado_destino || 'seguimiento';
          await ClientesChatCenter.update(
            { estado_contacto: estadoDestino },
            { where: { id: record.id_cliente_chat_center } },
          );

          // 4️⃣ Marcar como enviado
          await db.query(
            `UPDATE remarketing_pendientes
       SET enviado = 1
       WHERE id = ?`,
            {
              replacements: [record.id],
              type: db.QueryTypes.UPDATE,
            },
          );
        } catch (err) {
          console.error('❌ Error en cron remarketing:', err.message);
        }
      }
    });
  } finally {
    isRunning = false;
  }
});
