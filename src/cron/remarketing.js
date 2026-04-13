const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data');
const { db } = require('../database/config');
const {
  sendWhatsappMessageTemplateScheduled,
  obtenerTextoPlantilla,
} = require('../services/whatsapp.service');
const {
  getConfigFromDB,
  onlyDigits,
} = require('../utils/whatsappTemplate.helpers');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const MensajesClientes = require('../models/mensaje_cliente.model');

/* ================================================================
   uploadMediaToMeta
   ================================================================ */
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

  console.log(`⬆️ [uploadMedia] Descargando: ${mediaUrl} fmt=${fmt}`);

  const download = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  console.log(
    `⬆️ [uploadMedia] Descarga OK — ${download.data.byteLength} bytes`,
  );

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
      headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
      timeout: 60000,
      validateStatus: () => true,
    },
  );

  console.log(
    `⬆️ [uploadMedia] Respuesta Meta upload — status: ${uploadRes.status}`,
    JSON.stringify(uploadRes.data),
  );

  if (!uploadRes.data?.id) {
    throw new Error(
      `[uploadMedia] No se obtuvo media_id: ${JSON.stringify(uploadRes.data)}`,
    );
  }

  console.log(`✅ [uploadMedia] media_id: ${uploadRes.data.id}`);
  return uploadRes.data.id;
}

/* ================================================================
   withLock
   ================================================================ */
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

/* ================================================================
   CRON
   ================================================================ */
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
            `\n🔄 [remarketing] id=${record.id} tel=${record.telefono} template="${record.nombre_template}"`,
          );
          console.log(
            `🔄 [remarketing] header_format="${record.header_format}" header_media_url="${record.header_media_url}"`,
          );

          // 1) Verificar cliente
          const cliente = await ClientesChatCenter.findByPk(
            record.id_cliente_chat_center,
          );
          if (!cliente) {
            console.warn(
              `⚠️ [remarketing] Cliente no encontrado id=${record.id_cliente_chat_center}`,
            );
            continue;
          }

          // 2) Si el estado cambió, cancelar
          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            console.log(
              `🚫 [remarketing] Estado cambió, cancelando id=${record.id}`,
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
          console.log(`🔄 [remarketing] esMediaHeader=${esMediaHeader}`);

          // ══════════════════════════════════════════════════════
          // CASO A: Template con media (IMAGE / VIDEO / DOCUMENT)
          // ══════════════════════════════════════════════════════
          if (esMediaHeader) {
            const cfg = await getConfigFromDB(Number(record.id_configuracion));
            if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID || !cfg?.WABA_ID) {
              throw new Error('Config incompleta para envío de media');
            }

            // Texto + header fresco desde Meta (con cache 30 min)
            const tplData = await obtenerTextoPlantilla(
              record.nombre_template,
              cfg.ACCESS_TOKEN,
              cfg.WABA_ID,
            );
            console.log(
              `🔄 [remarketing] tplData.header =`,
              JSON.stringify(tplData?.header),
            );

            const mediaUrlFuente = (
              record.header_media_url || tplData?.header?.media_url
            )?.replace(/&amp;/g, '&');
            console.log(
              `🔄 [remarketing] mediaUrlFuente = "${mediaUrlFuente}"`,
            );

            if (!mediaUrlFuente) {
              throw new Error(
                `No hay URL de media para "${record.nombre_template}"`,
              );
            }

            // Upload → media_id fresco (evita 403)
            const mediaId = await uploadMediaToMeta(
              mediaUrlFuente,
              headerFormatNorm,
              cfg.ACCESS_TOKEN,
              cfg.PHONE_NUMBER_ID,
            );
            const mediaType = headerFormatNorm.toLowerCase(); // 'image' | 'video' | 'document'
            const mediaObj = { id: mediaId };
            if (mediaType === 'document' && record.header_media_name) {
              mediaObj.filename = record.header_media_name;
            }

            // Construir components
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

            const LANGUAGE_CODE =
              record.language_code || tplData?.language || 'es';
            const telefonoLimpio = onlyDigits(record.telefono || '');

            const payload = {
              messaging_product: 'whatsapp',
              to: telefonoLimpio,
              type: 'template',
              template: {
                name: record.nombre_template,
                language: { code: LANGUAGE_CODE },
                components,
              },
            };

            console.log(
              `📤 [remarketing] Payload:`,
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
              `📤 [remarketing] Respuesta Meta — status: ${sendRes.status}`,
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

            // ── Guardar en MensajesClientes (misma lógica que sendWhatsappMessageTemplateScheduled) ──
            const wamid = sendRes.data?.messages?.[0]?.id || null;
            const uid_whatsapp = telefonoLimpio;

            // Cliente destino
            const [clienteRow] = await db.query(
              `SELECT id FROM clientes_chat_center
               WHERE REPLACE(celular_cliente, ' ', '') = ?
                 AND id_configuracion = ?
               LIMIT 1`,
              {
                replacements: [telefonoLimpio, record.id_configuracion],
                type: db.QueryTypes.SELECT,
              },
            );

            let clienteId = clienteRow?.id || null;
            if (!clienteId) {
              console.log(
                '[clientes_chat_center INSERT] cron/remarketing.js ~L300 — creando cliente para remarketing, celular:',
                telefonoLimpio,
                'id_configuracion:',
                record.id_configuracion,
              );
              const nuevo = await ClientesChatCenter.create({
                id_configuracion: record.id_configuracion,
                uid_cliente: cfg.PHONE_NUMBER_ID,
                nombre_cliente: '',
                apellido_cliente: '',
                celular_cliente: telefonoLimpio,
              });
              clienteId = nuevo.id;
            }

            // Cliente configuración
            let id_cliente_configuracion = null;
            const telCfg = record.telefono_configuracion
              ? onlyDigits(record.telefono_configuracion)
              : onlyDigits(cfg.telefono || '');

            if (telCfg) {
              const [cfgCliente] = await db.query(
                `SELECT id FROM clientes_chat_center
                 WHERE REPLACE(celular_cliente, ' ', '') = ?
                   AND id_configuracion = ?
                 LIMIT 1`,
                {
                  replacements: [telCfg, record.id_configuracion],
                  type: db.QueryTypes.SELECT,
                },
              );
              if (cfgCliente?.id) id_cliente_configuracion = cfgCliente.id;
            }

            const ruta_archivo = {
              body_parameters: bodyParams,
              header: {
                format: headerFormatNorm,
                parameters: null,
                media_url: mediaUrlFuente,
                media_name: record.header_media_name || null,
              },
              source: 'cron_remarketing',
            };

            await MensajesClientes.create({
              id_configuracion: record.id_configuracion,
              id_cliente: id_cliente_configuracion || clienteId,
              mid_mensaje: cfg.PHONE_NUMBER_ID,
              tipo_mensaje: 'template',
              rol_mensaje: 1,
              celular_recibe: clienteId,
              responsable: 'cron_remarketing_estado',
              texto_mensaje: tplData?.text || record.nombre_template,
              ruta_archivo: JSON.stringify(ruta_archivo),
              visto: 1,
              uid_whatsapp,
              id_wamid_mensaje: wamid,
              template_name: record.nombre_template,
              language_code: LANGUAGE_CODE,
            });

            console.log(
              `💾 [remarketing] MensajesClientes guardado — wamid=${wamid} clienteId=${clienteId}`,
            );

            // ══════════════════════════════════════════════════════
            // CASO B: Template de texto — usa la función existente
            // ══════════════════════════════════════════════════════
          } else {
            console.log(
              `📤 [remarketing] Template texto → sendWhatsappMessageTemplateScheduled`,
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

          // 3) Lógica de secuencia
          const secuenciaActual = Number(record.secuencia || 1);

          // Buscar si hay siguiente secuencia configurada para este estado
          const [siguienteConfig] = await db.query(
            `SELECT * FROM configuracion_remarketing
   WHERE id_configuracion = ? 
     AND estado_contacto = ? 
     AND secuencia = ? 
     AND activo = 1
   LIMIT 1`,
            {
              replacements: [
                record.id_configuracion,
                record.estado_contacto_origen,
                secuenciaActual + 1,
              ],
              type: db.QueryTypes.SELECT,
            },
          );

          if (siguienteConfig) {
            // ── SAFEGUARD: cancelar otros pendientes del cliente antes de insertar seq siguiente ──
            await db.query(
              `UPDATE remarketing_pendientes
     SET cancelado = 1
     WHERE id_cliente_chat_center = ?
       AND id_configuracion = ?
       AND enviado = 0
       AND cancelado = 0
       AND id != ?`, // no cancelar el actual (que ya se está procesando)
              {
                replacements: [
                  record.id_cliente_chat_center,
                  record.id_configuracion,
                  record.id,
                ],
                type: db.QueryTypes.UPDATE,
              },
            );

            // ── Hay siguiente → programarlo ──
            const tiempoDisparo = new Date(
              Date.now() + siguienteConfig.tiempo_espera_horas * 60 * 60 * 1000,
            );

            await db.query(
              `INSERT INTO remarketing_pendientes
   (id_cliente_chat_center, id_configuracion, telefono,
    telefono_configuracion, nombre_template, language_code,
    header_format, header_media_url, header_media_name, header_parameters,
    estado_contacto_origen, estado_destino,
    tiempo_disparo, enviado, cancelado, secuencia)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
              {
                replacements: [
                  record.id_cliente_chat_center,
                  record.id_configuracion,
                  record.telefono,
                  record.telefono_configuracion || null,
                  siguienteConfig.nombre_template,
                  siguienteConfig.language_code || 'es',
                  siguienteConfig.header_format || null,
                  siguienteConfig.header_media_url
                    ? String(siguienteConfig.header_media_url).replace(
                        /&amp;/g,
                        '&',
                      )
                    : null,
                  siguienteConfig.header_media_name || null,
                  siguienteConfig.header_parameters || null,
                  // ← estado donde quedó el cliente después de este envío
                  record.estado_destino || record.estado_contacto_origen,
                  siguienteConfig.estado_destino || null,
                  tiempoDisparo,
                  secuenciaActual + 1,
                ],
                type: db.QueryTypes.INSERT,
              },
            );

            console.log(
              `🔄 [remarketing] Secuencia ${secuenciaActual + 1} programada`,
            );
          }

          // ── Mover columna en CADA envío si tiene estado_destino ──
          if (record.estado_destino) {
            await ClientesChatCenter.update(
              { estado_contacto: record.estado_destino },
              { where: { id: record.id_cliente_chat_center } },
            );
            console.log(
              `📂 [remarketing] Cliente movido a "${record.estado_destino}" (secuencia=${secuenciaActual})`,
            );
          } else if (!siguienteConfig) {
            // Sin estado_destino y es el último → mover a seguimiento por defecto
            await ClientesChatCenter.update(
              { estado_contacto: 'seguimiento' },
              { where: { id: record.id_cliente_chat_center } },
            );
            console.log(
              `📂 [remarketing] Última secuencia sin destino, moviendo a "seguimiento"`,
            );
          }

          // 4) Marcar este registro como enviado (siempre)
          await db.query(
            `UPDATE remarketing_pendientes SET enviado = 1 WHERE id = ?`,
            { replacements: [record.id], type: db.QueryTypes.UPDATE },
          );

          console.log(
            `✅ [remarketing] id=${record.id} secuencia=${secuenciaActual} enviado y marcado OK`,
          );
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
