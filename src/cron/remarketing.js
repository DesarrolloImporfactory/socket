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
  verificarVentana24h,
  isWindowClosedError,
} = require('../utils/whatsappTemplate.helpers');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const MensajesClientes = require('../models/mensaje_cliente.model');
const {
  isWabaThrottled,
  markWabaThrottled,
  processBucHeader,
} = require('../utils/wabaThrottleGuard');

/* ================================================================
   Detectores de tipo de error
   ================================================================ */
function isMetaRateLimit(err) {
  const s = err?.response?.status || err?.meta_status;
  const c = err?.response?.data?.error?.code || err?.meta_error?.code;
  return (
    s === 429 || c === 130429 || c === 80008 || err?.meta_error?.local === true
  );
}

function isScontentExpiredUrl(url) {
  if (!url) return false;
  return (
    url.includes('scontent.whatsapp.net') || url.includes('lookaside.fbsbx.com')
  );
}

function isTemplateNotFoundError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('no hay url de media') ||
    msg.includes('no se encontró la plantilla') ||
    msg.includes('template no existe')
  );
}

/* ================================================================
   uploadMediaToMeta (sin cambios)
   ================================================================ */
const MAX_SIZES_MB = { IMAGE: 5, VIDEO: 16, DOCUMENT: 100 };

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

  let download;
  try {
    download = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      validateStatus: () => true,
    });
  } catch (e) {
    const err = new Error(`[uploadMedia] Error descargando: ${e.message}`);
    err.isDownloadError = true;
    err.isUrlExpired = isScontentExpiredUrl(mediaUrl);
    throw err;
  }

  if (download.status < 200 || download.status >= 300) {
    const err = new Error(
      `[uploadMedia] URL devolvió ${download.status}${isScontentExpiredUrl(mediaUrl) ? ' (URL scontent expirada)' : ''}`,
    );
    err.isDownloadError = true;
    err.isUrlExpired = isScontentExpiredUrl(mediaUrl);
    throw err;
  }

  const sizeBytes = download.data.byteLength;
  const sizeMB = sizeBytes / (1024 * 1024);
  const maxMB = MAX_SIZES_MB[fmt] || 5;

  if (sizeMB > maxMB) {
    const err = new Error(
      `[uploadMedia] Archivo ${sizeMB.toFixed(2)}MB excede ${maxMB}MB para ${fmt}`,
    );
    err.isSizeError = true;
    throw err;
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', Buffer.from(download.data), {
    filename: `media.${ext}`,
    contentType: mimeType,
  });

  const uploadRes = await axios.post(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${business_phone_id}/media`,
    form,
    {
      headers: { Authorization: `Bearer ${accessToken}`, ...form.getHeaders() },
      timeout: 60000,
      validateStatus: () => true,
    },
  );

  processBucHeader(uploadRes.headers, 'uploadMedia');

  if (!uploadRes.data?.id) {
    const err = new Error(
      `[uploadMedia] No se obtuvo media_id: ${JSON.stringify(uploadRes.data)}`,
    );
    err.meta_error = uploadRes.data?.error || null;
    throw err;
  }

  return uploadRes.data.id;
}

/* ================================================================
   ✨ NUEVO: enviarRespuestaRapidaUniversal
   Envía un mensaje free-form (text/image/video/audio/document)
   usando `link` para evitar el upload paso intermedio.
   ================================================================ */
async function enviarRespuestaRapidaUniversal({
  phone_number_id,
  access_token,
  phoneNorm,
  tplRapido,
}) {
  const tipo = String(tplRapido.tipo_mensaje || 'text').toLowerCase();
  const texto = tplRapido.mensaje || '';

  const buildLink = (ruta) => {
    if (!ruta) return null;
    return /^https?:\/\//i.test(ruta)
      ? ruta
      : `https://new.imporsuitpro.com/${String(ruta).replace(/^\//, '')}`;
  };

  let payload;

  if (tipo === 'text' || !tplRapido.ruta_archivo) {
    payload = {
      messaging_product: 'whatsapp',
      to: phoneNorm,
      type: 'text',
      text: { body: texto },
    };
  } else {
    const link = buildLink(tplRapido.ruta_archivo);
    if (!link) {
      throw new Error('[RR] tipo media sin ruta_archivo válida');
    }

    const mediaObj = { link };

    if (tipo === 'document') {
      if (tplRapido.file_name) mediaObj.filename = tplRapido.file_name;
      if (texto) mediaObj.caption = texto;
    } else if (tipo === 'image' || tipo === 'video') {
      if (texto) mediaObj.caption = texto;
    }
    // audio no acepta caption ni filename

    payload = {
      messaging_product: 'whatsapp',
      to: phoneNorm,
      type: tipo,
      [tipo]: mediaObj,
    };
  }

  const sendRes = await axios.post(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${phone_number_id}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    },
  );

  processBucHeader(sendRes.headers, 'remarketing-rr-send');

  if (sendRes.status < 200 || sendRes.status >= 300 || sendRes.data?.error) {
    const metaErr =
      sendRes.data?.error?.message || `Meta HTTP ${sendRes.status}`;
    const err = new Error(`[Meta RR] ${metaErr}`);
    err.meta_status = sendRes.status;
    err.meta_error = sendRes.data?.error || sendRes.data;
    throw err;
  }

  return {
    wamid: sendRes.data?.messages?.[0]?.id || null,
    payload,
    tipo,
    texto,
    ruta_archivo: tplRapido.ruta_archivo || null,
    file_name: tplRapido.file_name || null,
    mime_type: tplRapido.mime_type || null,
  };
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
    if (!row || Number(row.got) !== 1) return;
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
   handleRecordError (sin cambios)
   ================================================================ */
async function handleRecordError(record, err, waba_id) {
  const intentosActuales = Number(record.intentos || 0) + 1;
  const maxIntentos = Number(record.max_intentos || 3);

  if (isMetaRateLimit(err)) {
    if (waba_id) markWabaThrottled(waba_id, 60);
    return false;
  }

  const urlExpirada =
    err?.isUrlExpired || isScontentExpiredUrl(record.header_media_url);

  if (err?.isDownloadError && urlExpirada) {
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1, error_message = ?, ultimo_intento_at = NOW()
       WHERE id = ?`,
      {
        replacements: [
          `URL scontent expirada: ${err.message}`.slice(0, 500),
          record.id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    console.log(`🚫 [remarketing] id=${record.id} CANCELADO (URL expirada)`);
    return true;
  }

  if (err?.isSizeError) {
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1, error_message = ?, ultimo_intento_at = NOW()
       WHERE id = ?`,
      {
        replacements: [err.message.slice(0, 500), record.id],
        type: db.QueryTypes.UPDATE,
      },
    );
    return true;
  }

  if (isTemplateNotFoundError(err)) {
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1, error_message = ?, ultimo_intento_at = NOW()
       WHERE id = ?`,
      {
        replacements: [
          `Template no existe: ${err.message}`.slice(0, 500),
          record.id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    return true;
  }

  if (intentosActuales >= maxIntentos) {
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1, intentos = ?, error_message = ?, ultimo_intento_at = NOW()
       WHERE id = ?`,
      {
        replacements: [
          intentosActuales,
          `Agotó ${maxIntentos} intentos. Último: ${err.message}`.slice(0, 500),
          record.id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    return true;
  }

  await db.query(
    `UPDATE remarketing_pendientes
     SET intentos = ?, error_message = ?, ultimo_intento_at = NOW()
     WHERE id = ?`,
    {
      replacements: [intentosActuales, err.message.slice(0, 500), record.id],
      type: db.QueryTypes.UPDATE,
    },
  );
  return true;
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
         WHERE enviado = 0 
           AND cancelado = 0 
           AND tiempo_disparo <= NOW()
           AND tiempo_disparo > NOW() - INTERVAL 3 DAY
           AND intentos < max_intentos
         ORDER BY tiempo_disparo ASC
         LIMIT 50`,
        { type: db.QueryTypes.SELECT },
      );

      if (!pendientes.length) return;

      console.log(`📋 [remarketing] Pendientes: ${pendientes.length}`);

      let rateLimitHitsThisCycle = 0;
      const MAX_RATE_LIMIT_HITS = 5;
      const wabasAffectedThisCycle = new Set();

      for (const record of pendientes) {
        if (rateLimitHitsThisCycle >= MAX_RATE_LIMIT_HITS) {
          console.log(
            `⏸ [remarketing] ${rateLimitHitsThisCycle} rate limits — pausando ciclo`,
          );
          break;
        }

        let wabaIdForLog = null;

        try {
          // 1) Cliente
          const cliente = await ClientesChatCenter.findByPk(
            record.id_cliente_chat_center,
          );
          if (!cliente) {
            await db.query(
              `UPDATE remarketing_pendientes
               SET cancelado = 1, error_message = 'Cliente no encontrado'
               WHERE id = ?`,
              { replacements: [record.id], type: db.QueryTypes.UPDATE },
            );
            continue;
          }

          // 2) Estado cambió → cancelar
          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            await db.query(
              `UPDATE remarketing_pendientes
               SET cancelado = 1, error_message = 'Estado cambió'
               WHERE id = ?`,
              { replacements: [record.id], type: db.QueryTypes.UPDATE },
            );
            continue;
          }

          // 3) Config
          const cfg = await getConfigFromDB(Number(record.id_configuracion));
          if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID || !cfg?.WABA_ID) {
            throw new Error('Config incompleta o config suspendida');
          }
          wabaIdForLog = cfg.WABA_ID;

          // 4) WABA throttled?
          if (isWabaThrottled(cfg.WABA_ID)) {
            console.log(
              `⏸ [remarketing] id=${record.id} WABA ${cfg.WABA_ID} throttled, skip`,
            );
            continue;
          }

          const telefonoLimpio = onlyDigits(record.telefono || '');

          // ══════════════════════════════════════════════════════
          // ✨ NUEVO PASO: ¿Enviar respuesta rápida?
          // ══════════════════════════════════════════════════════
          let envioPorRR = false;
          let rrInfo = null;

          if (record.usar_respuesta_rapida && record.id_template_rapido) {
            const dentroVentana = await verificarVentana24h(
              record.id_configuracion,
              telefonoLimpio,
            );

            if (dentroVentana) {
              const [tplRapido] = await db.query(
                `SELECT id_template, atajo, mensaje, tipo_mensaje, ruta_archivo, mime_type, file_name
                 FROM templates_chat_center
                 WHERE id_template = ? AND id_configuracion = ?
                 LIMIT 1`,
                {
                  replacements: [
                    record.id_template_rapido,
                    record.id_configuracion,
                  ],
                  type: db.QueryTypes.SELECT,
                },
              );

              if (tplRapido) {
                try {
                  rrInfo = await enviarRespuestaRapidaUniversal({
                    phone_number_id: cfg.PHONE_NUMBER_ID,
                    access_token: cfg.ACCESS_TOKEN,
                    phoneNorm: telefonoLimpio,
                    tplRapido,
                  });
                  envioPorRR = true;
                  console.log(
                    `✅ [remarketing] id=${record.id} RR enviada (${rrInfo.tipo})`,
                  );
                } catch (rrErr) {
                  if (isWindowClosedError(rrErr)) {
                    console.log(
                      `↩ [remarketing] id=${record.id} ventana cerrada, fallback a template`,
                    );
                    // No bloquea: cae al template Meta abajo
                  } else if (isMetaRateLimit(rrErr)) {
                    throw rrErr; // lo manejamos como rate limit normal
                  } else {
                    // Cualquier otro error de RR → fallback al template
                    console.log(
                      `⚠️ [remarketing] id=${record.id} RR falló (${rrErr.message}), fallback a template`,
                    );
                  }
                }
              }
            }
          }

          // ══════════════════════════════════════════════════════
          // Si NO se envió por RR → usar template Meta (lógica original)
          // ══════════════════════════════════════════════════════
          if (!envioPorRR) {
            const headerFormatNorm = String(
              record.header_format || '',
            ).toUpperCase();
            const esMediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
              headerFormatNorm,
            );

            if (esMediaHeader) {
              const tplData = await obtenerTextoPlantilla(
                record.nombre_template,
                cfg.ACCESS_TOKEN,
                cfg.WABA_ID,
              );

              const mediaUrlFuente = (
                record.header_media_url || tplData?.header?.media_url
              )?.replace(/&amp;/g, '&');

              if (!mediaUrlFuente) {
                throw new Error(
                  `No hay URL de media para "${record.nombre_template}"`,
                );
              }

              if (isScontentExpiredUrl(mediaUrlFuente)) {
                const ageHours =
                  (Date.now() -
                    new Date(
                      record.creado_en || record.tiempo_disparo,
                    ).getTime()) /
                  (1000 * 60 * 60);
                if (ageHours > 24) {
                  const err = new Error(
                    `URL scontent con edad ${ageHours.toFixed(1)}h, probablemente expirada`,
                  );
                  err.isDownloadError = true;
                  err.isUrlExpired = true;
                  throw err;
                }
              }

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

              const LANGUAGE_CODE =
                record.language_code || tplData?.language || 'es';

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

              const sendRes = await axios.post(
                `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.PHONE_NUMBER_ID}/messages`,
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

              processBucHeader(sendRes.headers, 'remarketing-send');

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

                if (sendRes.data?.error?.code === 80008) {
                  markWabaThrottled(cfg.WABA_ID, 60);
                }
                throw err;
              }

              const wamid = sendRes.data?.messages?.[0]?.id || null;
              const uid_whatsapp = telefonoLimpio;

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
                const nuevo = await ClientesChatCenter.create({
                  id_configuracion: record.id_configuracion,
                  uid_cliente: cfg.PHONE_NUMBER_ID,
                  nombre_cliente: '',
                  apellido_cliente: '',
                  celular_cliente: telefonoLimpio,
                });
                clienteId = nuevo.id;
              }

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
            } else {
              // Template texto puro
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
          } else {
            // ══════════════════════════════════════════════════════
            // ✨ Guardar la RR enviada en mensajes_clientes
            // ══════════════════════════════════════════════════════
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
              const nuevo = await ClientesChatCenter.create({
                id_configuracion: record.id_configuracion,
                uid_cliente: cfg.PHONE_NUMBER_ID,
                nombre_cliente: '',
                apellido_cliente: '',
                celular_cliente: telefonoLimpio,
              });
              clienteId = nuevo.id;
            }

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

            // ruta_archivo según tipo (matching tu estructura existente)
            let rutaArchivoFinal = null;
            if (rrInfo.tipo === 'document') {
              rutaArchivoFinal = JSON.stringify({
                ruta: rrInfo.ruta_archivo,
                nombre: rrInfo.file_name || 'Documento',
                size: 0,
                mimeType: rrInfo.mime_type || '',
              });
            } else if (rrInfo.tipo !== 'text') {
              rutaArchivoFinal = rrInfo.ruta_archivo;
            }

            await MensajesClientes.create({
              id_configuracion: record.id_configuracion,
              id_cliente: id_cliente_configuracion || clienteId,
              mid_mensaje: cfg.PHONE_NUMBER_ID,
              tipo_mensaje: rrInfo.tipo,
              rol_mensaje: 1,
              celular_recibe: clienteId,
              responsable: 'cron_remarketing_rr',
              texto_mensaje: rrInfo.texto || '',
              ruta_archivo: rutaArchivoFinal,
              visto: 1,
              uid_whatsapp: telefonoLimpio,
              id_wamid_mensaje: rrInfo.wamid,
            });
          }

          // ══════════════════════════════════════════════════════
          // Lógica de secuencia (sin cambios excepto los nuevos campos)
          // ══════════════════════════════════════════════════════
          const secuenciaActual = Number(record.secuencia || 1);

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
            await db.query(
              `UPDATE remarketing_pendientes
               SET cancelado = 1
               WHERE id_cliente_chat_center = ?
                 AND id_configuracion = ?
                 AND enviado = 0
                 AND cancelado = 0
                 AND id != ?`,
              {
                replacements: [
                  record.id_cliente_chat_center,
                  record.id_configuracion,
                  record.id,
                ],
                type: db.QueryTypes.UPDATE,
              },
            );

            const tiempoDisparo = new Date(
              Date.now() + siguienteConfig.tiempo_espera_horas * 60 * 60 * 1000,
            );

            await db.query(
              `INSERT INTO remarketing_pendientes
               (id_cliente_chat_center, id_configuracion, telefono,
                telefono_configuracion, nombre_template, language_code,
                header_format, header_media_url, header_media_name, header_parameters,
                estado_contacto_origen, estado_destino,
                id_template_rapido, usar_respuesta_rapida,
                tiempo_disparo, enviado, cancelado, secuencia)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
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
                  record.estado_destino || record.estado_contacto_origen,
                  siguienteConfig.estado_destino || null,
                  siguienteConfig.id_template_rapido || null,
                  siguienteConfig.usar_respuesta_rapida ? 1 : 0,
                  tiempoDisparo,
                  secuenciaActual + 1,
                ],
                type: db.QueryTypes.INSERT,
              },
            );
          }

          // Mover columna
          if (record.estado_destino) {
            await ClientesChatCenter.update(
              { estado_contacto: record.estado_destino },
              { where: { id: record.id_cliente_chat_center } },
            );
          } else if (!siguienteConfig) {
            await ClientesChatCenter.update(
              { estado_contacto: 'seguimiento' },
              { where: { id: record.id_cliente_chat_center } },
            );
          }

          await db.query(
            `UPDATE remarketing_pendientes
             SET enviado = 1, ultimo_intento_at = NOW()
             WHERE id = ?`,
            { replacements: [record.id], type: db.QueryTypes.UPDATE },
          );

          console.log(
            `✅ [remarketing] id=${record.id} enviado (${envioPorRR ? 'RR' : 'template'})`,
          );

          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          if (isMetaRateLimit(err)) {
            if (wabaIdForLog) {
              markWabaThrottled(wabaIdForLog, 60);
              wabasAffectedThisCycle.add(wabaIdForLog);
            }
            rateLimitHitsThisCycle++;
            console.error(
              `🛑 [remarketing] RATE LIMIT #${rateLimitHitsThisCycle} id=${record.id}`,
            );
            continue;
          }

          try {
            const handled = await handleRecordError(record, err, wabaIdForLog);
            if (!handled) {
              if (wabaIdForLog) wabasAffectedThisCycle.add(wabaIdForLog);
              rateLimitHitsThisCycle++;
            }
          } catch (handleErr) {
            console.error(
              `⚠️ [remarketing] Error en handleRecordError id=${record.id}:`,
              handleErr.message,
            );
          }
        }
      }
    });
  } finally {
    isRunning = false;
  }
});

console.log('🚀 [remarketing] Cron registrado (cada 1 min)');
