// cron/remarketing.js
const cron = require('node-cron');
const axios = require('axios');
const { db } = require('../database/config');
const {
  sendWhatsappMessage,
  sendWhatsappMessageTemplateScheduled,
} = require('../services/whatsapp.service');

const { getConfigFromDB } = require('../utils/whatsappTemplate.helpers');
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
      const pendientes = await db.query(
        `SELECT * FROM remarketing_pendientes 
         WHERE enviado = 0 AND cancelado = 0 AND tiempo_disparo <= NOW()`,
        { type: db.QueryTypes.SELECT },
      );

      for (const record of pendientes) {
        try {
          const cliente = await ClientesChatCenter.findByPk(
            record.id_cliente_chat_center,
          );
          if (!cliente) continue;

          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            await db.query(
              `UPDATE remarketing_pendientes SET cancelado = 1 WHERE id = ?`,
              { replacements: [record.id], type: db.QueryTypes.UPDATE },
            );
            continue;
          }

          // ══════════════════════════════════════════════════════════
          // SOLUCIÓN: Si el template tiene header de media (IMAGE/VIDEO/
          // DOCUMENT), obtenemos la URL fresca desde Meta en el momento
          // del envío — nunca usamos la URL guardada en BD que ya expiró.
          // obtenerTextoPlantilla tiene cache de 30 min y pagina Meta,
          // así que la URL que devuelve siempre es reciente y válida.
          // ══════════════════════════════════════════════════════════
          let headerMediaUrl = record.header_media_url || null;
          const headerFormatNorm = String(
            record.header_format || '',
          ).toUpperCase();

          if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormatNorm)) {
            try {
              const cfg = await getConfigFromDB(
                Number(record.id_configuracion),
              );

              if (cfg?.ACCESS_TOKEN && cfg?.WABA_ID) {
                const tplData = await obtenerTextoPlantilla(
                  record.nombre_template,
                  cfg.ACCESS_TOKEN,
                  cfg.WABA_ID,
                );

                if (tplData?.header?.media_url) {
                  headerMediaUrl = tplData.header.media_url;
                  console.log(
                    `🔄 [remarketing] URL de media refrescada para "${record.nombre_template}"`,
                  );
                } else {
                  console.warn(
                    `⚠️ [remarketing] No se obtuvo media_url fresca para "${record.nombre_template}", usando la guardada en BD`,
                  );
                }
              }
            } catch (refreshErr) {
              console.warn(
                `⚠️ [remarketing] Error refrescando media_url (usando BD como fallback):`,
                refreshErr.message,
              );
              // headerMediaUrl sigue siendo record.header_media_url — fallback seguro
            }
          }

          // ══════════════════════════════════════════════════════════
          // Envío — igual que antes, solo cambia headerMediaUrl
          // ══════════════════════════════════════════════════════════
          await sendWhatsappMessageTemplateScheduled({
            telefono: record.telefono,
            telefono_configuracion: record.telefono_configuracion || null,
            id_configuracion: record.id_configuracion,
            nombre_template: record.nombre_template,
            language_code: record.language_code,
            template_parameters: [],
            responsable: 'cron_remarketing_estado',

            header_format: record.header_format || null,
            header_media_url: headerMediaUrl, // ← URL fresca
            header_media_name: record.header_media_name || null,
            header_parameters: record.header_parameters
              ? JSON.parse(record.header_parameters)
              : null,
          });

          const estadoDestino = record.estado_destino || 'seguimiento';
          await ClientesChatCenter.update(
            { estado_contacto: estadoDestino },
            { where: { id: record.id_cliente_chat_center } },
          );

          await db.query(
            `UPDATE remarketing_pendientes SET enviado = 1 WHERE id = ?`,
            { replacements: [record.id], type: db.QueryTypes.UPDATE },
          );
        } catch (err) {
          console.error('❌ Error en cron remarketing:', err.message);
          if (err?.meta_status || err?.meta_error) {
            console.error('🧾 [Meta error detail]', {
              meta_status: err.meta_status,
              meta_error: err.meta_error,
            });
          }
        }
      }
    });
  } finally {
    isRunning = false;
  }
});
