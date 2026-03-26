const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data'); // ← ESTE ES EL FIX — requiere el paquete npm
const { db } = require('../database/config');
const {
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
  const EXT = { IMAGE: 'jpg', VIDEO: 'mp4', DOCUMENT: 'pdf' };

  const fmt = String(headerFormat || '').toUpperCase();
  const mimeType = MIME[fmt] || 'application/octet-stream';
  const ext = EXT[fmt] || 'bin';

  console.log(`⬆️ [uploadMedia] Iniciando descarga de: ${mediaUrl}`);
  console.log(`⬆️ [uploadMedia] fmt=${fmt} mimeType=${mimeType}`);

  // 1) Descargar el archivo
  let download;
  try {
    download = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    console.log(
      `⬆️ [uploadMedia] Descarga OK — tamaño: ${download.data.byteLength} bytes, status: ${download.status}`,
    );
  } catch (dlErr) {
    console.error(`❌ [uploadMedia] Error descargando archivo:`, dlErr.message);
    throw dlErr;
  }

  // 2) Construir form-data (paquete npm, no global browser)
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', Buffer.from(download.data), {
    filename: `media.${ext}`,
    contentType: mimeType,
  });

  const uploadHeaders = {
    Authorization: `Bearer ${accessToken}`,
    ...form.getHeaders(), // ← solo funciona con el paquete npm
  };

  console.log(
    `⬆️ [uploadMedia] Subiendo a Meta phone_id=${business_phone_id}...`,
  );

  let uploadRes;
  try {
    uploadRes = await axios.post(
      `https://graph.facebook.com/v22.0/${business_phone_id}/media`,
      form,
      { headers: uploadHeaders, timeout: 60000, validateStatus: () => true },
    );
    console.log(
      `⬆️ [uploadMedia] Respuesta Meta upload — status: ${uploadRes.status}`,
      JSON.stringify(uploadRes.data),
    );
  } catch (upErr) {
    console.error(`❌ [uploadMedia] Error en POST a Meta:`, upErr.message);
    throw upErr;
  }

  if (!uploadRes.data?.id) {
    throw new Error(
      `[uploadMedia] No se obtuvo media_id: ${JSON.stringify(uploadRes.data)}`,
    );
  }

  console.log(`✅ [uploadMedia] media_id obtenido: ${uploadRes.data.id}`);
  return uploadRes.data.id;
}

// withLock igual
async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) {
      console.log('🔒 No se obtuvo lock');
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

      if (!pendientes.length) return;
      console.log(`📋 [remarketing] Pendientes: ${pendientes.length}`);

      for (const record of pendientes) {
        try {
          console.log(
            `\n🔄 [remarketing] Procesando id=${record.id} tel=${record.telefono} template="${record.nombre_template}"`,
          );
          console.log(
            `🔄 [remarketing] header_format="${record.header_format}" header_media_url="${record.header_media_url}"`,
          );

          const cliente = await ClientesChatCenter.findByPk(
            record.id_cliente_chat_center,
          );
          if (!cliente) {
            console.warn(
              `⚠️ [remarketing] Cliente no encontrado id=${record.id_cliente_chat_center}`,
            );
            continue;
          }

          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            console.log(
              `🚫 [remarketing] Estado cambió (${record.estado_contacto_origen} → ${cliente.estado_contacto}), cancelando id=${record.id}`,
            );
            await db.query(
              `UPDATE remarketing_pendientes SET cancelado = 1 WHERE id = ?`,
              { replacements: [record.id], type: db.QueryTypes.UPDATE },
            );
            continue;
          }

          const headerFormatNorm = String(
            record.header_format || '',
          ).toUpperCase();
          const esMediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
            headerFormatNorm,
          );
          console.log(
            `🔄 [remarketing] esMediaHeader=${esMediaHeader} headerFormatNorm="${headerFormatNorm}"`,
          );

          if (esMediaHeader) {
            const cfg = await getConfigFromDB(Number(record.id_configuracion));
            if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID || !cfg?.WABA_ID) {
              throw new Error('Config incompleta para envío de media');
            }

            // URL fresca desde Meta como fallback
            const tplData = await obtenerTextoPlantilla(
              record.nombre_template,
              cfg.ACCESS_TOKEN,
              cfg.WABA_ID,
            );

            console.log(
              `🔄 [remarketing] tplData.header =`,
              JSON.stringify(tplData?.header),
            );

            const mediaUrlFuente =
              record.header_media_url || tplData?.header?.media_url;
            console.log(
              `🔄 [remarketing] mediaUrlFuente = "${mediaUrlFuente}"`,
            );

            if (!mediaUrlFuente) {
              throw new Error(
                `No hay URL de media disponible para "${record.nombre_template}"`,
              );
            }

            // Upload → media_id (evita 403)
            const mediaId = await uploadMediaToMeta(
              mediaUrlFuente,
              headerFormatNorm,
              cfg.ACCESS_TOKEN,
              cfg.PHONE_NUMBER_ID,
            );

            const mediaType = headerFormatNorm.toLowerCase();
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

            const bodyParams = record.template_parameters
              ? JSON.parse(record.template_parameters || '[]')
              : [];
            if (bodyParams.length > 0) {
              components.push({
                type: 'body',
                parameters: bodyParams.map((p) => ({
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

            console.log(
              `📤 [remarketing] Payload a Meta:`,
              JSON.stringify(payload, null, 2),
            );

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

            console.log(
              `📤 [remarketing] Respuesta Meta send — status: ${sendRes.status}`,
              JSON.stringify(sendRes.data),
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
          } else {
            console.log(
              `📤 [remarketing] Enviando template de texto con sendWhatsappMessageTemplateScheduled`,
            );
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

          const estadoDestino = record.estado_destino || 'seguimiento';
          await ClientesChatCenter.update(
            { estado_contacto: estadoDestino },
            { where: { id: record.id_cliente_chat_center } },
          );

          await db.query(
            `UPDATE remarketing_pendientes SET enviado = 1 WHERE id = ?`,
            { replacements: [record.id], type: db.QueryTypes.UPDATE },
          );

          console.log(`✅ [remarketing] id=${record.id} marcado como enviado`);
        } catch (err) {
          console.error(`❌ [remarketing] Error id=${record.id}:`, err.message);
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
