// cron/remarketing.js
const cron = require('node-cron');
const axios = require('axios');
const { db } = require('../database/config');
const {
  sendWhatsappMessage,
  sendWhatsappMessageTemplateScheduled,
  obtenerTextoPlantilla,
} = require('../services/whatsapp.service');

const { getConfigFromDB } = require('../utils/whatsappTemplate.helpers');
const ClientesChatCenter = require('../models/clientes_chat_center.model');

async function uploadMediaToMeta(
  mediaUrl,
  headerFormat,
  accessToken,
  business_phone_id,
) {
  const MIME = {
    IMAGE: 'image/jpeg',
    VIDEO: 'video/mp4',
    DOCUMENT: 'application/pdf',
  };
  const EXT = {
    IMAGE: 'jpg',
    VIDEO: 'mp4',
    DOCUMENT: 'pdf',
  };

  const fmt = String(headerFormat || '').toUpperCase();
  const mimeType = MIME[fmt] || 'application/octet-stream';
  const ext = EXT[fmt] || 'bin';

  // 1) Descargar el archivo
  const download = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  // 2) Subir a Meta → obtenemos media_id
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', Buffer.from(download.data), {
    filename: `media.${ext}`,
    contentType: mimeType,
  });

  const uploadRes = await axios.post(
    `https://graph.facebook.com/v22.0/${business_phone_id}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...form.getHeaders(),
      },
      timeout: 60000,
    },
  );

  if (!uploadRes.data?.id) {
    throw new Error(
      `[uploadMedia] No se obtuvo media_id: ${JSON.stringify(uploadRes.data)}`,
    );
  }

  return uploadRes.data.id; // ← media_id fresco
}

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

          // ══════════════════════════════════════════════════
          // Si el template tiene header de media:
          // 1) Obtenemos config fresca
          // 2) Obtenemos la URL actual del template (puede ser
          //    header_handle o la guardada en BD)
          // 3) Subimos el archivo a Meta → media_id
          // 4) Construimos una URL especial "mediaid://ID" que
          //    le pasamos como header_media_url
          //
          // PERO sendWhatsappMessageTemplateScheduled solo
          // soporta { link } — así que hacemos el envío
          // directo aquí para el caso media y usamos la
          // función normal para texto.
          // ══════════════════════════════════════════════════
          const headerFormatNorm = String(
            record.header_format || '',
          ).toUpperCase();
          const esMediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
            headerFormatNorm,
          );

          if (esMediaHeader) {
            // ── Envío directo con media_id ──────────────────
            const cfg = await getConfigFromDB(Number(record.id_configuracion));
            if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID || !cfg?.WABA_ID) {
              throw new Error('Config incompleta para envío de media');
            }

            // Obtener URL más fresca posible del template
            const tplData = await obtenerTextoPlantilla(
              record.nombre_template,
              cfg.ACCESS_TOKEN,
              cfg.WABA_ID,
            );

            // Prioridad: URL guardada en BD (la que puso el usuario)
            // Fallback: header_handle fresco del template en Meta
            const mediaUrlFuente =
              record.header_media_url || tplData?.header?.media_url;

            if (!mediaUrlFuente) {
              throw new Error(
                `No hay URL de media disponible para "${record.nombre_template}"`,
              );
            }

            // Subir a Meta → media_id fresco (evita 403)
            console.log(
              `⬆️ [remarketing] Subiendo media a Meta para "${record.nombre_template}"...`,
            );
            const mediaId = await uploadMediaToMeta(
              mediaUrlFuente,
              headerFormatNorm,
              cfg.ACCESS_TOKEN,
              cfg.PHONE_NUMBER_ID,
            );
            console.log(`✅ [remarketing] media_id obtenido: ${mediaId}`);

            // Construir payload con { id } en lugar de { link }
            const mediaType = headerFormatNorm.toLowerCase(); // 'image'|'video'|'document'
            const mediaObj = { id: mediaId };
            if (mediaType === 'document' && record.header_media_name) {
              mediaObj.filename = record.header_media_name;
            }

            const components = [
              {
                type: 'header',
                parameters: [{ type: mediaType, [mediaType]: mediaObj }],
              },
            ];

            // Si hubiera parámetros de body
            if (
              record.template_parameters &&
              JSON.parse(record.template_parameters || '[]').length > 0
            ) {
              const params = JSON.parse(record.template_parameters);
              components.push({
                type: 'body',
                parameters: params.map((p) => ({
                  type: 'text',
                  text: String(p),
                })),
              });
            }

            const payload = {
              messaging_product: 'whatsapp',
              to: record.telefono.replace(/\D/g, ''),
              type: 'template',
              template: {
                name: record.nombre_template,
                language: {
                  code: record.language_code || tplData?.language || 'es',
                },
                components,
              },
            };

            const sendRes = await axios.post(
              `https://graph.facebook.com/v22.0/${cfg.PHONE_NUMBER_ID}/messages`,
              payload,
              {
                headers: {
                  Authorization: `Bearer ${cfg.ACCESS_TOKEN}`,
                  'Content-Type': 'application/json',
                },
                timeout: 30000,
                validateStatus: () => true,
              },
            );

            if (
              sendRes.status < 200 ||
              sendRes.status >= 300 ||
              sendRes.data?.error
            ) {
              const metaErr =
                sendRes.data?.error?.message || `Meta HTTP ${sendRes.status}`;
              const err = new Error(`[Meta Template Media] ${metaErr}`);
              err.meta_status = sendRes.status;
              err.meta_error = sendRes.data?.error || sendRes.data;
              throw err;
            }

            console.log(
              `✅ [remarketing] Template media enviado: ${record.nombre_template}`,
              sendRes.data,
            );
          } else {
            // ── Texto normal: usa la función existente ──────
            await sendWhatsappMessageTemplateScheduled({
              telefono: record.telefono,
              telefono_configuracion: record.telefono_configuracion || null,
              id_configuracion: record.id_configuracion,
              nombre_template: record.nombre_template,
              language_code: record.language_code,
              template_parameters: [],
              responsable: 'cron_remarketing_estado',
              header_format: null,
              header_media_url: null,
              header_media_name: null,
              header_parameters: null,
            });
          }

          // Mover columna y marcar enviado
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
