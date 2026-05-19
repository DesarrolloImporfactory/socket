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

function isOpenAISinSaldo(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  const msg = err?.response?.data?.error?.message || err?.message || '';
  return (
    (status === 429 && code === 'insufficient_quota') ||
    status === 402 ||
    msg.toLowerCase().includes('exceeded your current quota') ||
    msg.toLowerCase().includes('insufficient_quota')
  );
}

/* ================================================================
   uploadMediaToMeta
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
   enviarRespuestaRapidaUniversal
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
   generarMensajeRemarketingIA
   ================================================================ */
async function generarMensajeRemarketingIA({
  id_thread,
  assistant_id,
  prompt_ia,
  api_key_openai,
  max_tokens = 300,
}) {
  console.log(
    `🟦 [DEBUG IA] >>> Llamando OpenAI thread=${id_thread} assistant=${assistant_id} max_tokens=${max_tokens}`,
  );

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const runRes = await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/runs`,
    {
      assistant_id,
      additional_instructions: prompt_ia,
      additional_messages: [
        {
          role: 'user',
          content:
            '[ACCIÓN INTERNA: GENERAR_REMARKETING] Sigue ESTRICTAMENTE las instrucciones de remarketing en additional_instructions. NO saludes, NO te presentes, NO preguntes ciudad ni datos nuevos, NO actúes como si fuera un primer contacto. Devuelve ÚNICAMENTE el mensaje de remarketing según el ángulo y estructura indicados.',
        },
      ],
      max_completion_tokens: max_tokens,
    },
    { headers, timeout: 60000 },
  );
  const run_id = runRes?.data?.id;
  console.log(`🟦 [DEBUG IA] run_id=${run_id} status=${runRes?.data?.status}`);
  if (!run_id) throw new Error('No se pudo crear run de OpenAI');

  let statusRun = 'queued';
  let attempts = 0;
  while (statusRun !== 'completed' && statusRun !== 'failed' && attempts < 25) {
    await new Promise((r) => setTimeout(r, 1200));
    attempts++;
    const statusRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
      { headers },
    );
    statusRun = statusRes.data.status;
    console.log(`🟦 [DEBUG IA] poll intento=${attempts} status=${statusRun}`);
    if (statusRun === 'failed') {
      throw new Error(
        `Run falló: ${JSON.stringify(statusRes.data.last_error)}`,
      );
    }
  }
  if (statusRun !== 'completed') {
    throw new Error(`Run no completó (status=${statusRun})`);
  }

  const messagesRes = await axios.get(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    { headers },
  );
  const mensajes = messagesRes.data.data || [];
  const textBlock = mensajes
    .reverse()
    .find((m) => m.role === 'assistant' && m.run_id === run_id)
    ?.content?.[0]?.text;

  if (!textBlock?.value) {
    throw new Error('Sin respuesta del asistente');
  }

  let texto = textBlock.value;
  const anns = textBlock.annotations || [];
  for (let i = anns.length - 1; i >= 0; i--) {
    const a = anns[i];
    if (
      typeof a?.start_index === 'number' &&
      typeof a?.end_index === 'number'
    ) {
      texto = texto.slice(0, a.start_index) + texto.slice(a.end_index);
    }
  }
  texto = texto
    .replace(/【[^】]*】/g, '')
    .replace(/\[\d+:\d+†[^\]]*\]/g, '')
    .replace(/\[source\]/gi, '')
    .replace(/\[doc\d+\]/gi, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (
    (texto.startsWith('"') && texto.endsWith('"')) ||
    (texto.startsWith('"') && texto.endsWith('"'))
  ) {
    texto = texto.slice(1, -1).trim();
  }

  console.log(
    `🟦 [DEBUG IA] texto generado len=${texto.length} preview="${texto.slice(0, 80)}..."`,
  );
  return texto;
}

/* ================================================================
   enviarTextoLibreWhatsApp
   ================================================================ */
async function enviarTextoLibreWhatsApp({
  phone_number_id,
  access_token,
  phoneNorm,
  texto,
}) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNorm,
    type: 'text',
    text: { body: texto },
  };

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

  processBucHeader(sendRes.headers, 'remarketing-ia-send');

  if (sendRes.status < 200 || sendRes.status >= 300 || sendRes.data?.error) {
    const metaErr =
      sendRes.data?.error?.message || `Meta HTTP ${sendRes.status}`;
    const err = new Error(`[Meta IA] ${metaErr}`);
    err.meta_status = sendRes.status;
    err.meta_error = sendRes.data?.error || sendRes.data;
    throw err;
  }

  return { wamid: sendRes.data?.messages?.[0]?.id || null };
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
   handleRecordError
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
        // ══════════════════════════════════════════════════════
        // 🟦 DEBUG: Estado inicial del record
        // ══════════════════════════════════════════════════════
        console.log(
          `\n🟦 [DEBUG] ━━━━━━━━━━ INICIO id=${record.id} ━━━━━━━━━━`,
        );
        console.log(
          `🟦 [DEBUG] metodo_dentro_24h_RAW="${record.metodo_dentro_24h}"`,
        );
        console.log(
          `🟦 [DEBUG] usar_respuesta_rapida=${record.usar_respuesta_rapida}`,
        );
        console.log(
          `🟦 [DEBUG] prompt_ia=${record.prompt_ia ? `SI (${record.prompt_ia.length} chars)` : 'NO/NULL'}`,
        );
        console.log(
          `🟦 [DEBUG] estado_contacto_origen="${record.estado_contacto_origen}"`,
        );
        console.log(`🟦 [DEBUG] id_configuracion=${record.id_configuracion}`);
        console.log(`🟦 [DEBUG] telefono="${record.telefono}"`);

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
            console.log(`🟦 [DEBUG] ❌ Cliente NO encontrado`);
            await db.query(
              `UPDATE remarketing_pendientes
               SET cancelado = 1, error_message = 'Cliente no encontrado'
               WHERE id = ?`,
              { replacements: [record.id], type: db.QueryTypes.UPDATE },
            );
            continue;
          }

          console.log(
            `🟦 [DEBUG] cliente.estado_contacto="${cliente.estado_contacto}"`,
          );

          // 2) Estado cambió → cancelar
          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            console.log(
              `🟦 [DEBUG] ❌ ESTADO CAMBIÓ (${cliente.estado_contacto} ≠ ${record.estado_contacto_origen}) — cancelando`,
            );
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
          console.log(`🟦 [DEBUG] config OK waba=${cfg.WABA_ID}`);

          // 4) WABA throttled?
          if (isWabaThrottled(cfg.WABA_ID)) {
            console.log(
              `⏸ [remarketing] id=${record.id} WABA ${cfg.WABA_ID} throttled, skip`,
            );
            continue;
          }

          const telefonoLimpio = onlyDigits(record.telefono || '');

          // ══════════════════════════════════════════════════════
          // Detectar método dentro de 24h (con compat legacy)
          // ══════════════════════════════════════════════════════
          const metodo24h =
            record.metodo_dentro_24h && record.metodo_dentro_24h !== 'ninguno'
              ? record.metodo_dentro_24h
              : record.usar_respuesta_rapida
                ? 'respuesta_rapida'
                : 'ninguno';

          console.log(`🟦 [DEBUG] metodo24h CALCULADO="${metodo24h}"`);

          let envioPorRR = false;
          let envioPorIA = false;
          let rrInfo = null;
          let iaTextoEnviado = null;
          let iaWamid = null;

          // Verificar ventana 24h una sola vez si es necesario
          let dentroVentana = false;
          if (metodo24h === 'respuesta_rapida' || metodo24h === 'ia') {
            dentroVentana = await verificarVentana24h(
              record.id_configuracion,
              telefonoLimpio,
            );
          }

          console.log(`🟦 [DEBUG] dentroVentana=${dentroVentana}`);
          console.log(
            `🟦 [DEBUG] ¿Entra IA? metodo24h==='ia':${metodo24h === 'ia'} && dentroVentana:${dentroVentana} && hasPrompt:${!!record.prompt_ia}`,
          );

          // ══════════════════════════════════════════════════════
          // Intento 1: RESPUESTA RÁPIDA
          // ══════════════════════════════════════════════════════
          if (
            dentroVentana &&
            metodo24h === 'respuesta_rapida' &&
            record.id_template_rapido
          ) {
            console.log(`🟦 [DEBUG] >>> Entrando a bloque RR`);
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
                } else if (isMetaRateLimit(rrErr)) {
                  throw rrErr;
                } else {
                  console.log(
                    `⚠️ [remarketing] id=${record.id} RR falló (${rrErr.message}), fallback a template`,
                  );
                }
              }
            }
          }

          // ══════════════════════════════════════════════════════
          // Intento 2: IA (solo si no fue por RR)
          // ══════════════════════════════════════════════════════
          if (
            !envioPorRR &&
            dentroVentana &&
            metodo24h === 'ia' &&
            record.prompt_ia
          ) {
            console.log(`🟦 [DEBUG] >>> Entrando a bloque IA`);
            try {
              const [cfgRow] = await db.query(
                `SELECT api_key_openai, openai_activo FROM configuraciones WHERE id = ? LIMIT 1`,
                {
                  replacements: [record.id_configuracion],
                  type: db.QueryTypes.SELECT,
                },
              );
              console.log(
                `🟦 [DEBUG IA] cfgRow: api_key=${cfgRow?.api_key_openai ? 'SI' : 'NO'} openai_activo=${cfgRow?.openai_activo}`,
              );

              if (!cfgRow?.api_key_openai) {
                throw new Error('Sin api_key_openai en configuración');
              }
              if (cfgRow.openai_activo === 0) {
                throw new Error('OpenAI marcado inactivo (sin saldo)');
              }
              const api_key_openai = cfgRow.api_key_openai;

              const [colRow] = await db.query(
                `SELECT assistant_id, max_tokens FROM kanban_columnas
                 WHERE id_configuracion = ?
                   AND LOWER(estado_db) = LOWER(?)
                   AND activo = 1
                 LIMIT 1`,
                {
                  replacements: [
                    record.id_configuracion,
                    record.estado_contacto_origen,
                  ],
                  type: db.QueryTypes.SELECT,
                },
              );
              console.log(
                `🟦 [DEBUG IA] colRow: assistant_id=${colRow?.assistant_id || 'NO'} max_tokens=${colRow?.max_tokens}`,
              );

              if (!colRow?.assistant_id) {
                throw new Error(
                  `Columna kanban "${record.estado_contacto_origen}" sin assistant_id`,
                );
              }

              const [threadRow] = await db.query(
                `SELECT thread_id FROM openai_threads
                 WHERE id_cliente_chat_center = ?
                 LIMIT 1`,
                {
                  replacements: [record.id_cliente_chat_center],
                  type: db.QueryTypes.SELECT,
                },
              );
              console.log(
                `🟦 [DEBUG IA] threadRow: thread_id=${threadRow?.thread_id || 'NO'}`,
              );

              if (!threadRow?.thread_id) {
                throw new Error('Cliente sin thread de OpenAI');
              }

              const textoIA = await generarMensajeRemarketingIA({
                id_thread: threadRow.thread_id,
                assistant_id: colRow.assistant_id,
                prompt_ia: record.prompt_ia,
                api_key_openai,
                max_tokens: colRow.max_tokens || 300,
              });

              if (!textoIA || textoIA.trim().length < 5) {
                throw new Error('IA devolvió texto vacío o muy corto');
              }

              const iaSent = await enviarTextoLibreWhatsApp({
                phone_number_id: cfg.PHONE_NUMBER_ID,
                access_token: cfg.ACCESS_TOKEN,
                phoneNorm: telefonoLimpio,
                texto: textoIA,
              });

              envioPorIA = true;
              iaTextoEnviado = textoIA;
              iaWamid = iaSent.wamid;
              console.log(
                `🤖 [remarketing] id=${record.id} IA enviada (${textoIA.length} chars) wamid=${iaWamid}`,
              );
            } catch (iaErr) {
              console.log(
                `🟦 [DEBUG IA] ❌ ERROR EN BLOQUE IA: ${iaErr.message}`,
              );
              if (iaErr.response?.data) {
                console.log(
                  `🟦 [DEBUG IA] OpenAI response data: ${JSON.stringify(iaErr.response.data).slice(0, 500)}`,
                );
              }

              if (isMetaRateLimit(iaErr)) {
                throw iaErr;
              }
              if (isOpenAISinSaldo(iaErr)) {
                await db.query(
                  `UPDATE configuraciones
                   SET openai_activo = 0,
                       openai_error_at = NOW(),
                       openai_error_msg = ?
                   WHERE id = ?`,
                  {
                    replacements: [
                      'Sin saldo OpenAI (detectado en cron remarketing)',
                      record.id_configuracion,
                    ],
                    type: db.QueryTypes.UPDATE,
                  },
                );
                console.log(
                  `🚨 [remarketing] id=${record.id} OpenAI SIN SALDO, marcado inactivo. Fallback a template.`,
                );
              } else {
                console.log(
                  `⚠️ [remarketing] id=${record.id} IA falló (${iaErr.message}), fallback a template`,
                );
              }
            }
          } else {
            console.log(`🟦 [DEBUG] >>> NO entró a bloque IA. Razones:`);
            console.log(`🟦 [DEBUG]     - !envioPorRR: ${!envioPorRR}`);
            console.log(`🟦 [DEBUG]     - dentroVentana: ${dentroVentana}`);
            console.log(
              `🟦 [DEBUG]     - metodo24h === 'ia': ${metodo24h === 'ia'}`,
            );
            console.log(
              `🟦 [DEBUG]     - record.prompt_ia: ${!!record.prompt_ia}`,
            );
          }

          // ══════════════════════════════════════════════════════
          // Intento 3: TEMPLATE META (si no fue por RR ni IA)
          // ══════════════════════════════════════════════════════
          if (!envioPorRR && !envioPorIA) {
            console.log(`🟦 [DEBUG] >>> FALLBACK a template Meta`);

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
          } else if (envioPorRR) {
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
          } else if (envioPorIA) {
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

            await MensajesClientes.create({
              id_configuracion: record.id_configuracion,
              id_cliente: id_cliente_configuracion || clienteId,
              mid_mensaje: cfg.PHONE_NUMBER_ID,
              tipo_mensaje: 'text',
              rol_mensaje: 1,
              celular_recibe: clienteId,
              responsable: 'cron_remarketing_ia',
              texto_mensaje: iaTextoEnviado,
              ruta_archivo: JSON.stringify({
                source: 'cron_remarketing_ia',
                secuencia: record.secuencia,
                prompt_usado: String(record.prompt_ia || '').slice(0, 2000),
              }),
              visto: 1,
              uid_whatsapp: telefonoLimpio,
              id_wamid_mensaje: iaWamid,
            });
          }

          // ══════════════════════════════════════════════════════
          // Lógica de secuencia
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
                metodo_dentro_24h, prompt_ia,
                tiempo_disparo, enviado, cancelado, secuencia)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
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
                  siguienteConfig.metodo_dentro_24h || 'ninguno',
                  siguienteConfig.prompt_ia || null,
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

          const tipoEnvio = envioPorIA ? 'IA' : envioPorRR ? 'RR' : 'template';
          console.log(
            `✅ [remarketing] id=${record.id} enviado (${tipoEnvio})`,
          );
          console.log(`🟦 [DEBUG] ━━━━━━━━━━ FIN id=${record.id} ━━━━━━━━━━\n`);

          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          console.log(
            `🟦 [DEBUG] ❌ ERROR PRINCIPAL id=${record.id}: ${err.message}`,
          );

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

console.log(
  '🚀 [remarketing] Cron registrado (cada 1 min) - VERSION DEBUG IA v2',
);
