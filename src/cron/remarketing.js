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

function isMediaError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('demasiado grande') ||
    msg.includes('no se obtuvo media_id') ||
    msg.includes('invalid parameter') ||
    err?.response?.data?.error?.code === 100
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
   uploadMediaToMeta — con validación de tamaño
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

  // 1) Descargar con manejo de URL expirada
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

  // 2) Validar tamaño ANTES de subir
  if (sizeMB > maxMB) {
    const err = new Error(
      `[uploadMedia] Archivo ${sizeMB.toFixed(2)}MB excede ${maxMB}MB para ${fmt}`,
    );
    err.isSizeError = true;
    throw err;
  }

  // 3) Subir a Meta
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

  // Procesar header de rate limit (aunque sea exitoso)
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
   Manejador de errores centralizado
   
   Retorna true  = error manejado (cancelado o reintento registrado)
   Retorna false = rate limit (debe propagarse como WABA-level)
   ================================================================ */

async function handleRecordError(record, err, waba_id) {
  const intentosActuales = Number(record.intentos || 0) + 1;
  const maxIntentos = Number(record.max_intentos || 3);

  // CASO 1: Rate limit → NO manejar aquí, dejar que el caller lo capture
  if (isMetaRateLimit(err)) {
    if (waba_id) markWabaThrottled(waba_id, 60);
    return false; // señal: rate limit, caller debe manejarlo
  }

  // CASO 2: URL expirada de scontent → CANCELAR permanentemente
  const urlExpirada =
    err?.isUrlExpired || isScontentExpiredUrl(record.header_media_url);

  if (err?.isDownloadError && urlExpirada) {
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1,
           error_message = ?,
           ultimo_intento_at = NOW()
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

  // CASO 3: Archivo muy grande → CANCELAR permanentemente
  if (err?.isSizeError) {
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1,
           error_message = ?,
           ultimo_intento_at = NOW()
       WHERE id = ?`,
      {
        replacements: [err.message.slice(0, 500), record.id],
        type: db.QueryTypes.UPDATE,
      },
    );
    console.log(`🚫 [remarketing] id=${record.id} CANCELADO (archivo grande)`);
    return true;
  }

  // CASO 4: Template no existe → CANCELAR permanentemente
  if (isTemplateNotFoundError(err)) {
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1,
           error_message = ?,
           ultimo_intento_at = NOW()
       WHERE id = ?`,
      {
        replacements: [
          `Template no existe: ${err.message}`.slice(0, 500),
          record.id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    console.log(`🚫 [remarketing] id=${record.id} CANCELADO (template)`);
    return true;
  }

  // CASO 5: Error temporal → incrementar intentos
  if (intentosActuales >= maxIntentos) {
    // Se agotaron → cancelar con error
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1,
           intentos = ?,
           error_message = ?,
           ultimo_intento_at = NOW()
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
    console.log(
      `🚫 [remarketing] id=${record.id} CANCELADO (agotó ${maxIntentos} intentos)`,
    );
    return true;
  }

  // Solo incrementar contador para reintento futuro
  await db.query(
    `UPDATE remarketing_pendientes
     SET intentos = ?,
         error_message = ?,
         ultimo_intento_at = NOW()
     WHERE id = ?`,
    {
      replacements: [intentosActuales, err.message.slice(0, 500), record.id],
      type: db.QueryTypes.UPDATE,
    },
  );
  console.log(
    `🔁 [remarketing] id=${record.id} intento ${intentosActuales}/${maxIntentos}`,
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
      // Selección con filtros anti-zombie:
      // - Máximo 3 días de antigüedad (más viejos = zombies)
      // - Intentos < max_intentos
      // - Límite por ciclo para no saturar
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

      // ══════════════════════════════════════════════════════════════
      // CIRCUIT BREAKER POR CICLO:
      // - UNA WABA con rate limit NO detiene el ciclo (se protege y sigue)
      // - Si MUCHAS WABAs distintas fallan (5+), pausar por precaución
      // - Así las WABAs sanas pueden seguir enviando normalmente
      // ══════════════════════════════════════════════════════════════
      let rateLimitHitsThisCycle = 0;
      const MAX_RATE_LIMIT_HITS = 5;
      const wabasAffectedThisCycle = new Set();

      for (const record of pendientes) {
        // Safety stop: si demasiadas WABAs distintas fallaron este ciclo
        if (rateLimitHitsThisCycle >= MAX_RATE_LIMIT_HITS) {
          console.log(
            `⏸ [remarketing] ${rateLimitHitsThisCycle} rate limits detectados en ${wabasAffectedThisCycle.size} WABAs distintas — pausando ciclo`,
          );
          break;
        }

        let wabaIdForLog = null;

        try {
          // 1) Verificar cliente
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
            console.warn(`⚠️ [remarketing] id=${record.id} cliente no existe`);
            continue;
          }

          // 2) Si el estado cambió, cancelar
          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            await db.query(
              `UPDATE remarketing_pendientes
               SET cancelado = 1, error_message = 'Estado cambió'
               WHERE id = ?`,
              { replacements: [record.id], type: db.QueryTypes.UPDATE },
            );
            continue;
          }

          // 3) Obtener config para saber la WABA (para el throttle guard)
          const cfg = await getConfigFromDB(Number(record.id_configuracion));
          if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID || !cfg?.WABA_ID) {
            throw new Error('Config incompleta o config suspendida');
          }
          wabaIdForLog = cfg.WABA_ID;

          // 4) CIRCUIT BREAKER: Si esta WABA está throttled, skip sin tocar Meta
          if (isWabaThrottled(cfg.WABA_ID)) {
            console.log(
              `⏸ [remarketing] id=${record.id} WABA ${cfg.WABA_ID} throttled, skip`,
            );
            // No incrementamos intento porque no es error del record
            continue;
          }

          const headerFormatNorm = String(
            record.header_format || '',
          ).toUpperCase();
          const esMediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
            headerFormatNorm,
          );

          // ══════════════════════════════════════════════════════
          // CASO A: Template con media
          // ══════════════════════════════════════════════════════
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

            // Chequeo temprano: si es URL scontent, probablemente está expirada
            // Esto ahorra intento de descarga
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

            // Procesar header de rate limit SIEMPRE (éxito o fallo)
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

              // Si es 80008, marcar la WABA explícitamente
              if (sendRes.data?.error?.code === 80008) {
                markWabaThrottled(cfg.WABA_ID, 60);
              }
              throw err;
            }

            const wamid = sendRes.data?.messages?.[0]?.id || null;
            const uid_whatsapp = telefonoLimpio;

            // Guardar en mensajes_clientes (lógica original)
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
            // ══════════════════════════════════════════════════════
            // CASO B: Template de texto
            // ══════════════════════════════════════════════════════
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

          // ── Lógica de secuencia ──
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
                  record.estado_destino || record.estado_contacto_origen,
                  siguienteConfig.estado_destino || null,
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

          // Marcar como enviado
          await db.query(
            `UPDATE remarketing_pendientes
             SET enviado = 1, ultimo_intento_at = NOW()
             WHERE id = ?`,
            { replacements: [record.id], type: db.QueryTypes.UPDATE },
          );

          console.log(`✅ [remarketing] id=${record.id} enviado`);

          // Pequeña pausa para no saturar
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          // ══════════════════════════════════════════════════════════
          // MANEJO DE ERRORES POR RECORD
          // - Rate limit: protege SOLO esa WABA, sigue con las demás
          // - Errores permanentes: cancela el record
          // - Errores temporales: incrementa intentos
          // ══════════════════════════════════════════════════════════
          if (isMetaRateLimit(err)) {
            if (wabaIdForLog) {
              markWabaThrottled(wabaIdForLog, 60);
              wabasAffectedThisCycle.add(wabaIdForLog);
            }
            rateLimitHitsThisCycle++;
            console.error(
              `🛑 [remarketing] RATE LIMIT #${rateLimitHitsThisCycle} id=${record.id} waba=${wabaIdForLog} — WABA protegida, sigo con otras`,
            );
            // NO aborta el ciclo: continúa procesando records de otras WABAs
            continue;
          }

          // Otros errores: delegar al handler (cancelar o incrementar intento)
          try {
            const handled = await handleRecordError(record, err, wabaIdForLog);
            if (!handled) {
              // handleRecordError retornó false = era rate limit
              // (ya debería haberse detectado arriba, pero por si acaso)
              if (wabaIdForLog) {
                wabasAffectedThisCycle.add(wabaIdForLog);
              }
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

      // Resumen del ciclo
      if (rateLimitHitsThisCycle > 0) {
        console.log(
          `📊 [remarketing] Ciclo terminado — ${rateLimitHitsThisCycle} rate limits en ${wabasAffectedThisCycle.size} WABAs distintas`,
        );
      }
    });
  } finally {
    isRunning = false;
  }
});

console.log('🚀 [remarketing] Cron registrado (cada 1 min)');
