const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../database/config');
const FormData = require('form-data');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const fs = require('fs').promises;
const os = require('os');

/**
 * Obtiene la config de la tabla 'configuraciones' según el id.
 * Devuelve: { WABA_ID, ACCESS_TOKEN, PHONE_NUMBER_ID }
 */
async function getConfigFromDB(id) {
  try {
    if (id == null) return null;
    const idNum = Number(id);
    if (!Number.isInteger(idNum)) return null;

    const rows = await db.query(
      `
      SELECT 
      telefono AS telefono_configuracion,
        id_whatsapp AS WABA_ID, 
        token AS ACCESS_TOKEN,
        id_telefono AS PHONE_NUMBER_ID
      FROM configuraciones
      WHERE suspendido = 0 AND id = :id
      LIMIT 1
      `,
      {
        replacements: { id: idNum },
        type: db.QueryTypes.SELECT,
      },
    );

    return rows[0] || null;
  } catch (error) {
    console.error('Error en getConfigFromDB:', error);
    throw error;
  }
}

function onlyDigits(s = '') {
  return String(s).replace(/\D/g, '');
}

function bytesMB(n) {
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function inferHeaderFormatFromMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.startsWith('image/')) return 'IMAGE';
  if (m.startsWith('video/')) return 'VIDEO';
  if (m.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}

function metaLimitsByFormat(format) {
  const KB = 1024;
  const MB = 1024 * 1024;

  const f = String(format || '').toUpperCase();

  if (f === 'IMAGE')
    return { max: 5 * MB, allowed: ['image/jpeg', 'image/png'] };

  if (f === 'VIDEO')
    return { max: 16 * MB, allowed: ['video/mp4', 'video/3gpp'] };

  if (f === 'AUDIO')
    return {
      max: 16 * MB,
      allowed: [
        'audio/aac',
        'audio/amr',
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
      ],
    };

  if (f === 'STICKER')
    return {
      max: 500 * KB,
      allowed: ['image/webp'],
    };

  return {
    max: 100 * MB,
    allowed: [
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/pdf',
    ],
  };
}

// Tope duro para el VIDEO *antes* de convertir: el conversor lo va a
// recomprimir por debajo del límite de Meta, así que validar los 16MB sobre el
// original solo bloquea videos que sí se podían enviar. Igual se corta lo
// absurdo para no quemar CPU/disco en un archivo gigante.
const VIDEO_PRE_CONVERT_MAX = 200 * 1024 * 1024;

/**
 * @param {'pre'|'final'} [stage] 'pre' = antes del conversor de video. En esa
 *   etapa, para VIDEO no se valida ni peso ni MIME (el conversor normaliza
 *   ambos a mp4/h264 dentro del límite); solo se corta el tamaño absurdo.
 *   La validación real corre en 'final', con el buffer ya convertido.
 */
function validateMetaMediaOrThrow({ file, format, stage = 'final' }) {
  if (!file?.buffer?.length) {
    const err = new Error('Archivo vacío o inválido.');
    err.statusCode = 400;
    err.code = 'EMPTY_FILE';
    throw err;
  }

  const f = String(format || '').toUpperCase();
  const { max, allowed } = metaLimitsByFormat(f);

  if (stage === 'pre' && f === 'VIDEO') {
    if (file.buffer.length > VIDEO_PRE_CONVERT_MAX) {
      const err = new Error(
        `El video es demasiado grande para procesarlo. ` +
          `Tamaño: ${bytesMB(file.buffer.length)}. Máximo: ${bytesMB(VIDEO_PRE_CONVERT_MAX)}.`,
      );
      err.statusCode = 400;
      err.code = 'META_SIZE_LIMIT';
      throw err;
    }
    return;
  }

  if (file.buffer.length > max) {
    const err = new Error(
      `Meta rechazará el archivo: supera el límite para ${f}. ` +
        `Tamaño: ${bytesMB(file.buffer.length)}. Máximo: ${bytesMB(max)}.`,
    );
    err.statusCode = 400;
    err.code = 'META_SIZE_LIMIT';
    throw err;
  }

  const mime = String(file.mimetype || '').toLowerCase();
  const allowedLower = allowed.map((x) => x.toLowerCase());

  if (mime && allowedLower.length && !allowedLower.includes(mime)) {
    const err = new Error(
      `Tipo MIME no permitido para ${f}. Recibido: "${file.mimetype}". Permitidos: ${allowed.join(', ')}`,
    );
    err.statusCode = 400;
    err.code = 'META_MIME_NOT_ALLOWED';
    throw err;
  }
}

async function uploadToUploader({
  buffer,
  originalname,
  mimetype,
  folder = 'media',
}) {
  const form = new FormData();

  const safeName = (originalname || `file-${Date.now()}`).replace(
    /[^\w.\-() ]+/g,
    '_',
  );

  form.append('file', buffer, {
    filename: `${folder}/${Date.now()}-${safeName}`,
    contentType: mimetype || 'application/octet-stream',
  });

  const uploaderResp = await axios.post(
    'https://uploader.imporfactory.app/api/files/upload',
    form,
    { headers: form.getHeaders(), timeout: 30000, validateStatus: () => true },
  );

  if (uploaderResp.status < 200 || uploaderResp.status >= 300) {
    const err = new Error(`Uploader HTTP ${uploaderResp.status}`);
    err.statusCode = 502;
    err.raw = uploaderResp.data;
    throw err;
  }

  const json = uploaderResp.data;

  if (!json?.success || !json?.data?.url) {
    const err = new Error(json?.message || 'Uploader no devolvió URL');
    err.statusCode = 502;
    err.raw = json;
    throw err;
  }

  return { fileUrl: json.data.url, data: json.data };
}

/* ================================================================
 *  uploadVideoToVideoAPI — Sube video a la Video API chunked
 *  Reemplaza uploadToUploader SOLO para formato VIDEO.
 *  Flujo: /Videos/init → /Videos/chunk ×N → /Videos/complete
 * ================================================================ */
async function uploadVideoToVideoAPI({
  buffer,
  originalname,
  mimetype,
  jwtToken,
}) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
  const CONCURRENCY = 8;
  const BASE = 'https://new.imporsuitpro.com/';

  const fileSize = buffer.length;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  // ── Extraer extensión con fallbacks ──────────────────────────────
  const extFromName =
    originalname && originalname.includes('.')
      ? originalname.split('.').pop().toLowerCase()
      : null;

  const extFromMime = mimetype
    ? mimetype.split('/').pop().replace('quicktime', 'mov').toLowerCase()
    : null;

  const ext = extFromName || extFromMime || 'mp4';

  const safeOriginalName = extFromName ? originalname : `video.${ext}`;

  // Fingerprint: md5(nombre + "_" + tamaño + "_" + timestamp)
  const fingerprint = crypto
    .createHash('md5')
    .update(`${safeOriginalName}_${fileSize}_${Date.now()}`)
    .digest('hex');

  console.log(
    `[VIDEO_API] Iniciando upload chunked: ${safeOriginalName} (${bytesMB(fileSize)}, ${totalChunks} chunks) ext: ${ext}`,
  );

  // ── 1. Init ───────────────────────────────────────────────────────
  const initRes = await axios.post(
    BASE + 'Videos/init',
    {
      fingerprint,
      original_name: safeOriginalName,
      file_size: fileSize,
      total_chunks: totalChunks,
      chunk_size: CHUNK_SIZE,
      extension: ext,
      mime_type: mimetype || `video/${ext}`,
    },
    {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    },
  );

  const init = initRes.data;
  if (init.status !== 200) {
    const err = new Error(
      init.message || 'Error inicializando upload de video en Video API',
    );
    err.statusCode = 502;
    err.code = 'VIDEO_API_INIT_FAILED';
    throw err;
  }

  const { upload_id } = init;
  const received = new Set(init.received_chunks || []);

  console.log(
    `[VIDEO_API] upload_id: ${upload_id} | resuming: ${init.resuming} | ya recibidos: ${received.size}`,
  );

  // ── 2. Subir chunks con ventana deslizante ────────────────────────
  const pending = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!received.has(i)) pending.push(i);
  }

  if (pending.length > 0) {
    await new Promise((resolve, reject) => {
      let active = 0;
      let pi = 0;
      let errored = false;

      const next = () => {
        while (active < CONCURRENCY && pi < pending.length && !errored) {
          const chunkIndex = pending[pi++];
          active++;

          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, fileSize);
          const chunkBuffer = buffer.slice(start, end);

          const form = new FormData();
          form.append('upload_id', upload_id);
          form.append('chunk_index', String(chunkIndex));
          form.append('total_chunks', String(totalChunks));
          form.append('chunk', chunkBuffer, {
            filename: `chunk_${chunkIndex}`,
            contentType: 'application/octet-stream',
          });

          // ⚠️ No enviar Authorization en /Videos/chunk (según la doc)
          axios
            .post(BASE + 'Videos/chunk', form, {
              headers: form.getHeaders(),
              timeout: 60000,
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
            })
            .then((res) => {
              if (res.data?.status !== 200) {
                throw new Error(
                  res.data?.message || `Error en chunk ${chunkIndex}`,
                );
              }
              console.log(
                `[VIDEO_API] Chunk ${chunkIndex + 1}/${totalChunks} ✓`,
              );
              active--;
              next();
            })
            .catch((err) => {
              if (!errored) {
                errored = true;
                reject(err);
              }
            });
        }

        if (active === 0 && pi >= pending.length && !errored) resolve();
      };

      next();
    });
  }

  // ── 3. Complete ───────────────────────────────────────────────────
  const completeRes = await axios.post(
    BASE + 'Videos/complete',
    { upload_id },
    {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    },
  );

  const complete = completeRes.data;
  if (complete.status !== 200) {
    const err = new Error(
      complete.message || 'Error completando upload de video en Video API',
    );
    err.statusCode = 502;
    err.code = 'VIDEO_API_COMPLETE_FAILED';
    throw err;
  }

  console.log(`[VIDEO_API] ✅ Video listo: ${complete.stream_url}`);

  return {
    video_id: complete.video_id,
    stream_url: complete.stream_url,
    fileUrl: complete.stream_url,
  };
}

async function uploadMediaToMeta({ ACCESS_TOKEN, PHONE_NUMBER_ID }, file) {
  const mediaUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${PHONE_NUMBER_ID}/media`;

  const mimeType = file.mimetype || 'application/octet-stream';
  const fileName = file.originalname || `file-${Date.now()}`;

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', file.buffer, {
    filename: fileName,
    contentType: mimeType,
  });

  const mediaResp = await axios.post(mediaUrl, form, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...form.getHeaders(),
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (
    mediaResp.status < 200 ||
    mediaResp.status >= 300 ||
    mediaResp.data?.error
  ) {
    return {
      ok: false,
      meta_status: mediaResp.status,
      error: mediaResp.data?.error || mediaResp.data,
    };
  }

  const mediaId = mediaResp.data?.id;
  if (!mediaId) {
    return {
      ok: false,
      meta_status: mediaResp.status,
      error: 'Meta no devolvió media_id',
      raw: mediaResp.data,
    };
  }

  return { ok: true, mediaId, raw: mediaResp.data };
}

/**
 * ¿El video YA cumple lo que exige WhatsApp? (MP4 + H.264 + pista de audio AAC
 * y dentro del límite de peso). Si es así no hay que re-encodear: volver a
 * convertir solo degrada la calidad (re-encode con pérdida) y quema CPU.
 *
 * Se apoya en ffprobe y es CONSERVADOR: ante cualquier duda o error devuelve
 * false, de modo que se convierta igual. Nunca deja pasar un video dudoso.
 */
async function videoYaCompatibleWhatsApp(inputPath, sizeBytes, targetSizeMB) {
  try {
    // Si pesa de más hay que recomprimir sí o sí.
    if (sizeBytes > targetSizeMB * 1024 * 1024) return false;

    const probe = await execAsync(
      `ffprobe -v error -print_format json -show_format -show_streams "${inputPath}"`,
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const info = JSON.parse(probe.stdout);
    const streams = Array.isArray(info?.streams) ? info.streams : [];

    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    const esMp4 = /mp4|m4a|isom/i.test(String(info?.format?.format_name || ''));
    const esH264 = String(video?.codec_name || '').toLowerCase() === 'h264';
    // WhatsApp NO acepta video sin audio: por eso el conversor inyecta una
    // pista silenciosa. Si no hay audio AAC, hay que convertir.
    const audioOk = String(audio?.codec_name || '').toLowerCase() === 'aac';

    return esMp4 && esH264 && audioOk;
  } catch (_) {
    return false; // ante la duda, convertir
  }
}

/**
 * Convierte video a MP4 (H.264/AAC) compatible con WhatsApp.
 *
 * Si el video YA es compatible, lo devuelve tal cual SIN re-encodear (evita
 * perder calidad y CPU al reutilizar el video de una plantilla).
 */
async function convertVideoForWhatsApp(
  fileBuffer,
  originalName,
  targetSizeMB = 15,
) {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input-${Date.now()}-${originalName}`);
  const outputPath = path.join(tempDir, `output-${Date.now()}.mp4`);

  try {
    await fs.writeFile(inputPath, fileBuffer);

    try {
      await execAsync('ffmpeg -version');
    } catch (e) {
      throw new Error('FFmpeg no está instalado en el servidor');
    }

    // Corto-circuito: ya cumple → se reutiliza sin tocar.
    if (
      await videoYaCompatibleWhatsApp(inputPath, fileBuffer.length, targetSizeMB)
    ) {
      console.log(
        '[VIDEO_CONVERT] El video ya es compatible (mp4/h264 + audio y dentro del límite): se reutiliza SIN re-encodear.',
      );
      await fs.unlink(inputPath).catch(() => {});
      return fileBuffer;
    }

    // 1) Obtener duración con ffprobe para calcular bitrate dinámico
    let duration = 60; // fallback 60s
    try {
      const probe = await execAsync(
        `ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${inputPath}"`,
      );
      const parsed = parseFloat(probe.stdout.trim());
      if (parsed > 0) duration = parsed;
    } catch (_) {}

    // 2) Calcular bitrate dinámico según targetSizeMB
    const MAX_BYTES = targetSizeMB * 1024 * 1024;
    const AUDIO_KBPS = 96;
    const totalKbps = Math.floor((MAX_BYTES * 8) / duration / 1000);
    const videoKbps = Math.max(100, totalKbps - AUDIO_KBPS);

    console.log(
      `[VIDEO_CONVERT] Duración: ${duration.toFixed(1)}s | Video bitrate objetivo: ${videoKbps}k | Target: ${targetSizeMB}MB`,
    );

    // Helper interno: construye el comando ffmpeg con los parámetros dados
    // - Escala manteniendo aspect ratio al máximo maxW x maxH
    // - Redondea ancho/alto a número par (libx264 lo exige)
    const buildCmd = (vKbps, maxW, maxH, aKbps) =>
      [
        `ffmpeg -i "${inputPath}"`,
        `-f lavfi -i anullsrc=r=44100:cl=mono`,
        `-c:v libx264 -preset ultrafast`,
        `-vf "scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"`,
        `-b:v ${vKbps}k -maxrate ${Math.floor(vKbps * 1.5)}k -bufsize ${vKbps * 2}k`,
        `-filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]"`,
        `-map 0:v -map "[aout]"`,
        `-c:a aac -b:a ${aKbps}k -ar 44100 -ac 1`,
        `-movflags +faststart -y "${outputPath}"`,
      ].join(' ');

    // 3) Intento 1 — 720p, bitrate calculado
    await execAsync(buildCmd(videoKbps, 1280, 720, AUDIO_KBPS), {
      maxBuffer: 50 * 1024 * 1024,
    });
    let statOut = await fs.stat(outputPath);
    console.log(
      `[VIDEO_CONVERT] Intento 1 (720p): ${(statOut.size / (1024 * 1024)).toFixed(2)} MB`,
    );

    // 4) Intento 2 — 480p, bitrate reducido al 55%, audio 64k
    if (statOut.size > MAX_BYTES) {
      const vKbps2 = Math.max(80, Math.floor(videoKbps * 0.55));
      console.warn(
        `[VIDEO_CONVERT] Supera límite → compresión agresiva 480p (${vKbps2}k)...`,
      );
      await execAsync(buildCmd(vKbps2, 854, 480, 64), {
        maxBuffer: 50 * 1024 * 1024,
      });
      statOut = await fs.stat(outputPath);
      console.log(
        `[VIDEO_CONVERT] Intento 2 (480p): ${(statOut.size / (1024 * 1024)).toFixed(2)} MB`,
      );
    }

    // 5) Intento 3 — 360p, bitrate mínimo, audio 48k
    if (statOut.size > MAX_BYTES) {
      const vKbps3 = Math.max(
        60,
        Math.floor(((MAX_BYTES * 8) / duration / 1000) * 0.8 - 48),
      );
      console.warn(
        `[VIDEO_CONVERT] Aún supera límite → compresión máxima 360p (${vKbps3}k)...`,
      );
      await execAsync(buildCmd(vKbps3, 640, 360, 48), {
        maxBuffer: 50 * 1024 * 1024,
      });
      statOut = await fs.stat(outputPath);
      console.log(
        `[VIDEO_CONVERT] Intento 3 (360p): ${(statOut.size / (1024 * 1024)).toFixed(2)} MB`,
      );
    }

    // 6) Si aún supera el límite, lanzar error descriptivo
    if (statOut.size > MAX_BYTES) {
      const finalMB = (statOut.size / (1024 * 1024)).toFixed(2);
      const err = new Error(
        `El video pesa demasiado (${finalMB}MB) y no fue posible comprimirlo por debajo de ${targetSizeMB}MB. Enviá un video más corto o de menor resolución.`,
      );
      err.isOversized = true;
      throw err;
    }

    const convertedBuffer = await fs.readFile(outputPath);
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});

    return convertedBuffer;
  } catch (err) {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    throw err;
  }
}

/**
 * Inyecta media_id en header del template (para envío a Meta).
 */
function injectHeaderMediaId(components = [], headerFormat, mediaId) {
  const format = String(headerFormat || '').toUpperCase();

  const typeLower =
    format === 'IMAGE' ? 'image' : format === 'VIDEO' ? 'video' : 'document';

  const idx = components.findIndex((c) => c?.type === 'header');

  const newHeader = {
    type: 'header',
    parameters: [
      {
        type: typeLower,
        [typeLower]: { id: String(mediaId) },
      },
    ],
  };

  if (idx >= 0) components[idx] = newHeader;
  else components.unshift(newHeader);

  return components;
}

/**
 * Parsea JSON flexible (si viene string o ya objeto/array).
 */
function parseMaybeJSON(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return fallback;
    }
  }

  return fallback;
}

/**
 * Normaliza arrays que a veces llegan como JSON string.
 */
function parseArrayField(value, fallback = []) {
  if (Array.isArray(value)) return value;
  const parsed = parseMaybeJSON(value, null);
  return Array.isArray(parsed) ? parsed : fallback;
}

/**
 * Construye payload base a partir de graphBody o modo clásico.
 */
function buildTemplatePayloadBase({
  graphBody = null,
  to,
  template_name,
  language_code = 'es',
  componentsFromReq = null,
}) {
  const toClean = onlyDigits(to);

  if (graphBody) {
    const payload = {
      messaging_product: graphBody.messaging_product || 'whatsapp',
      to: toClean,
      type: graphBody.type || 'template',
      template: {
        ...(graphBody.template || {}),
        name: template_name,
        language: { code: language_code || 'es' },
      },
    };

    if (
      !Array.isArray(payload.template.components) ||
      !payload.template.components.length
    ) {
      payload.template.components = [{ type: 'body', parameters: [] }];
    }

    return payload;
  }

  return {
    messaging_product: 'whatsapp',
    to: toClean,
    type: 'template',
    template: {
      name: template_name,
      language: { code: language_code || 'es' },
      components: Array.isArray(componentsFromReq)
        ? componentsFromReq
        : [{ type: 'body', parameters: [] }],
    },
  };
}

/**
 * Extrae body_json / body del req (multipart o JSON)
 */
function extractGraphBodyFromRequest(req) {
  let graphBody = null;

  if (req?.body?.body && typeof req.body.body === 'object') {
    graphBody = req.body.body;
  } else if (req?.body?.body_json) {
    try {
      graphBody = JSON.parse(req.body.body_json);
    } catch (e) {
      const err = new Error('body_json inválido (JSON mal formado)');
      err.statusCode = 400;
      err.code = 'INVALID_BODY_JSON';
      throw err;
    }
  }

  return graphBody;
}

/**
 * Procesa header para PROGRAMACIÓN (solo guarda histórico / URL; NO sube a Meta).
 *
 * CAMBIO: Para VIDEO → sube a Video API (/Videos/*) en vez de S3.
 *         Para IMAGE / DOCUMENT → sigue usando S3 (uploadToUploader).
 *
 * Requiere `jwtToken` en las opciones para autenticar contra la Video API.
 */
async function prepareHeaderAssetForScheduling({
  req,
  preferVideoConversion = true,
  jwtToken = null,
}) {
  let header_format = req.body?.header_format ?? null;

  let fileUrl = null;
  let processedBuffer = null;
  let processedMimetype = null;
  let processedFilename = null;
  let fmt = null;
  let videoApiResult = null;

  const headerDefaultAssetRaw = req.body?.header_default_asset;
  let header_default_asset = null;

  if (headerDefaultAssetRaw) {
    if (typeof headerDefaultAssetRaw === 'object') {
      header_default_asset = headerDefaultAssetRaw;
    } else if (typeof headerDefaultAssetRaw === 'string') {
      try {
        header_default_asset = JSON.parse(headerDefaultAssetRaw);
      } catch (_) {
        header_default_asset = null;
      }
    }
  }

  // ── Caso A: Vino archivo en req.file ──────────────────────────────
  if (req.file) {
    if (!header_format) {
      header_format = inferHeaderFormatFromMime(req.file.mimetype);
    }

    fmt = String(header_format || '').toUpperCase();

    if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(fmt)) {
      const err = new Error(
        'Vino header_file pero header_format no es válido para HEADER (IMAGE|VIDEO|DOCUMENT)',
      );
      err.statusCode = 400;
      err.code = 'INVALID_HEADER_FORMAT';
      throw err;
    }

    validateMetaMediaOrThrow({ file: req.file, format: fmt, stage: 'pre' });

    processedBuffer = req.file.buffer;
    processedMimetype = req.file.mimetype;
    processedFilename = req.file.originalname;

    // Convertir video si aplica
    if (fmt === 'VIDEO' && preferVideoConversion) {
      try {
        processedBuffer = await convertVideoForWhatsApp(
          req.file.buffer,
          req.file.originalname,
        );
        processedMimetype = 'video/mp4';
        processedFilename = req.file.originalname.replace(/\.[^.]+$/, '.mp4');
      } catch (convErr) {
        console.warn(
          '[SCHEDULE][VIDEO] No se pudo convertir. Se guarda original:',
          convErr.message,
        );
      }
    }

    // Validación real: sobre lo que efectivamente se va a subir.
    validateMetaMediaOrThrow({
      file: {
        buffer: processedBuffer,
        mimetype: processedMimetype,
        originalname: processedFilename,
        size: processedBuffer.length,
      },
      format: fmt,
    });

    // ── VIDEO → Video API | IMAGE/DOCUMENT → S3 ──
    if (fmt === 'VIDEO') {
      // Extraer JWT del request si no viene explícito
      const token = jwtToken || extractBearerToken(req);

      if (!token) {
        const err = new Error(
          'Se requiere JWT para subir video a la Video API.',
        );
        err.statusCode = 401;
        err.code = 'VIDEO_API_NO_TOKEN';
        throw err;
      }

      videoApiResult = await uploadVideoToVideoAPI({
        buffer: processedBuffer,
        originalname: processedFilename,
        mimetype: processedMimetype,
        jwtToken: token,
      });

      fileUrl = videoApiResult.fileUrl; // stream_url
    } else {
      // IMAGE / DOCUMENT → S3 como antes
      const folder =
        fmt === 'IMAGE'
          ? 'whatsapp/templates/header/images'
          : 'whatsapp/templates/header/documents';

      const upHist = await uploadToUploader({
        buffer: processedBuffer,
        originalname: processedFilename,
        mimetype: processedMimetype,
        folder,
      });

      fileUrl = upHist?.fileUrl || null;
    }

    return {
      header_format: fmt,
      header_media_url: fileUrl,
      header_media_name: processedFilename || req.file.originalname || null,
      file_info: {
        name: processedFilename || req.file.originalname,
        mime: processedMimetype || req.file.mimetype,
        size: processedBuffer ? processedBuffer.length : req.file.size,
        header_format: fmt,
        converted: fmt === 'VIDEO' && processedBuffer !== req.file.buffer,
        video_api: videoApiResult
          ? {
              video_id: videoApiResult.video_id,
              stream_url: videoApiResult.stream_url,
            }
          : null,
      },
    };
  }

  // ── Caso B: header_default_asset (URL predeterminada) ─────────────
  if (
    header_default_asset?.enabled === true &&
    header_default_asset?.url &&
    ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
      String(header_default_asset?.format || '').toUpperCase(),
    )
  ) {
    const fmtDefault = String(header_default_asset.format || '').toUpperCase();

    const rawDefaultUrl = String(header_default_asset.url || '').trim();
    const decodedDefaultUrl = rawDefaultUrl
      .replace(/&amp;/g, '&')
      .replace(/&#38;/g, '&');

    const dl = await axios.get(decodedDefaultUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      validateStatus: () => true,
    });

    if (dl.status < 200 || dl.status >= 300 || !dl.data) {
      const err = new Error(
        'No se pudo descargar el adjunto predeterminado del template',
      );
      err.statusCode = 400;
      err.code = 'DOWNLOAD_DEFAULT_ASSET_FAILED';
      err.extra = {
        http_status: dl.status,
        url: decodedDefaultUrl,
        raw_url: rawDefaultUrl,
      };
      throw err;
    }

    const downloadedBuffer = Buffer.from(dl.data);

    const responseMime = String(dl.headers?.['content-type'] || '')
      .split(';')[0]
      .trim();

    let defaultMime = responseMime;
    if (!defaultMime) {
      if (fmtDefault === 'IMAGE') defaultMime = 'image/jpeg';
      if (fmtDefault === 'VIDEO') defaultMime = 'video/mp4';
      if (fmtDefault === 'DOCUMENT') defaultMime = 'application/pdf';
    }

    const extByFmt =
      fmtDefault === 'IMAGE' ? 'jpg' : fmtDefault === 'VIDEO' ? 'mp4' : 'pdf';

    const defaultFilename =
      (header_default_asset?.name &&
        String(header_default_asset.name).trim()) ||
      `template_header_default.${extByFmt}`;

    validateMetaMediaOrThrow({
      file: {
        buffer: downloadedBuffer,
        mimetype: defaultMime,
        originalname: defaultFilename,
        size: downloadedBuffer.length,
      },
      format: fmtDefault,
      stage: 'pre',
    });

    // Lo que finalmente se sube. Cambia solo si el conversor devuelve un buffer
    // distinto (es decir, si el video NO era ya compatible y hubo que convertir).
    let defaultBufferFinal = downloadedBuffer;
    let defaultMimeFinal = defaultMime;
    let defaultFilenameFinal = defaultFilename;

    // ── VIDEO → Video API | IMAGE/DOCUMENT → S3 ──
    if (fmtDefault === 'VIDEO') {
      const token = jwtToken || extractBearerToken(req);

      if (!token) {
        const err = new Error(
          'Se requiere JWT para subir video a la Video API.',
        );
        err.statusCode = 401;
        err.code = 'VIDEO_API_NO_TOKEN';
        throw err;
      }

      // Antes este camino subía el video TAL CUAL: si el asset guardado nunca
      // se convirtió (o su conversión falló), llegaba crudo a WhatsApp. Ahora
      // pasa por el conversor, que NO re-encodea si el video ya es compatible.
      if (preferVideoConversion) {
        try {
          const buf = await convertVideoForWhatsApp(
            downloadedBuffer,
            defaultFilename,
          );
          if (buf !== downloadedBuffer) {
            defaultBufferFinal = buf;
            defaultMimeFinal = 'video/mp4';
            defaultFilenameFinal = defaultFilename.replace(/\.[^.]+$/, '.mp4');
          }
        } catch (convErr) {
          console.warn(
            '[SCHEDULE][VIDEO][default_asset] No se pudo convertir. Se sube original:',
            convErr.message,
          );
        }
      }

      validateMetaMediaOrThrow({
        file: {
          buffer: defaultBufferFinal,
          mimetype: defaultMimeFinal,
          originalname: defaultFilenameFinal,
          size: defaultBufferFinal.length,
        },
        format: fmtDefault,
      });

      videoApiResult = await uploadVideoToVideoAPI({
        buffer: defaultBufferFinal,
        originalname: defaultFilenameFinal,
        mimetype: defaultMimeFinal,
        jwtToken: token,
      });

      fileUrl = videoApiResult.fileUrl;
    } else {
      const folder =
        fmtDefault === 'IMAGE'
          ? 'whatsapp/templates/header/images'
          : 'whatsapp/templates/header/documents';

      const upHist = await uploadToUploader({
        buffer: downloadedBuffer,
        originalname: defaultFilename,
        mimetype: defaultMime,
        folder,
      });

      fileUrl = upHist?.fileUrl || decodedDefaultUrl || null;
    }

    return {
      header_format: fmtDefault,
      header_media_url: fileUrl,
      header_media_name: defaultFilenameFinal,
      file_info: {
        name: defaultFilenameFinal,
        mime: defaultMimeFinal,
        size: defaultBufferFinal.length,
        header_format: fmtDefault,
        // true solo si realmente hubo re-encode (buffer distinto al descargado)
        converted: defaultBufferFinal !== downloadedBuffer,
        default_asset: true,
        video_api: videoApiResult
          ? {
              video_id: videoApiResult.video_id,
              stream_url: videoApiResult.stream_url,
            }
          : null,
      },
    };
  }

  return {
    header_format: null,
    header_media_url: null,
    header_media_name: null,
    file_info: null,
  };
}

/**
 * Extrae el Bearer token del header Authorization del request.
 */
function extractBearerToken(req) {
  const auth = req?.headers?.authorization || req?.headers?.Authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

const VENTANA_HORAS = 24;

/**
 * Verifica si el cliente respondió en las últimas 24h.
 * @param {number} id_configuracion
 * @param {string} phoneNorm - teléfono limpio (solo dígitos)
 * @returns {Promise<boolean>}
 */
async function verificarVentana24h(id_configuracion, phoneNorm) {
  const { db } = require('../database/config');

  const [clienteRow] = await db.query(
    `SELECT id, ultimo_mensaje_at, ultimo_rol_mensaje
     FROM clientes_chat_center
     WHERE id_configuracion = ? AND deleted_at IS NULL
       AND (REPLACE(celular_cliente, ' ', '') = ? OR telefono_limpio = ? OR celular_cliente LIKE ?)
     ORDER BY id DESC LIMIT 1`,
    {
      replacements: [
        id_configuracion,
        phoneNorm,
        phoneNorm,
        `%${phoneNorm.slice(-9)}`,
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!clienteRow || !clienteRow.ultimo_mensaje_at) return false;

  if (String(clienteRow.ultimo_rol_mensaje) === '0') {
    const horasDiff =
      (Date.now() - new Date(clienteRow.ultimo_mensaje_at).getTime()) /
      (1000 * 60 * 60);
    return horasDiff < VENTANA_HORAS;
  }

  const [msgRow] = await db.query(
    `SELECT created_at FROM mensajes_clientes
     WHERE celular_recibe = ? AND id_configuracion = ? AND rol_mensaje = 0
     ORDER BY created_at DESC LIMIT 1`,
    {
      replacements: [clienteRow.id, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!msgRow?.created_at) return false;
  const horasDiff =
    (Date.now() - new Date(msgRow.created_at).getTime()) / (1000 * 60 * 60);
  return horasDiff < VENTANA_HORAS;
}

/**
 * Detecta si un error de Meta es por ventana de 24h cerrada.
 */
function isWindowClosedError(err) {
  const code = err?.meta_error?.code || err?.response?.data?.error?.code;
  return code === 131047 || code === 131051;
}

/**
 * Sube un archivo vía upload session resumable y devuelve el handle (h)
 * para usarlo en example.header_handle al crear plantillas con HEADER media.
 * Requiere process.env.FB_APP_ID y process.env.GRAPH_VERSION.
 */
async function uploadResumableAndGetHandle({
  accessToken,
  fileBuffer,
  mimeType,
  fileName,
}) {
  const FB_APP_ID = process.env.FB_APP_ID;
  if (!FB_APP_ID) {
    throw new Error('Falta FB_APP_ID');
  }

  const ax = axios.create({
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 30000,
    validateStatus: () => true,
  });

  // 1) Crear sesión de subida (upload session)
  const startUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${FB_APP_ID}/uploads`;
  const startResp = await ax.post(startUrl, null, {
    params: {
      file_length: fileBuffer.length,
      file_type: mimeType,
      file_name: fileName,
    },
  });

  if (startResp.status < 200 || startResp.status >= 300) {
    throw new Error(
      `No se pudo iniciar upload session: ${startResp.status} ${JSON.stringify(startResp.data)}`,
    );
  }

  const uploadSessionId = startResp.data?.id;
  if (!uploadSessionId) {
    throw new Error(`Upload session sin id: ${JSON.stringify(startResp.data)}`);
  }

  // 2) Subir binario
  const uploadUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${uploadSessionId}`;
  const uploadResp = await axios.post(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      file_offset: '0',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (uploadResp.status < 200 || uploadResp.status >= 300) {
    throw new Error(
      `No se pudo subir archivo: ${uploadResp.status} ${JSON.stringify(uploadResp.data)}`,
    );
  }

  const handle = uploadResp.data?.h;
  if (!handle) {
    throw new Error(
      `Respuesta sin handle (h): ${JSON.stringify(uploadResp.data)}`,
    );
  }

  return handle;
}

/**
 * Genera una clave única (timestamp + random).
 */
function generarClaveUnica() {
  const randomStr = Math.random().toString(36).substring(2, 8);
  return `key_${Date.now()}_${randomStr}`;
}

/**
 * Propietario único por config:
 *  - Si existe (propietario=1, deleted_at NULL) → UPDATE
 *  - Si no existe → INSERT
 * Devuelve el id del propietario.
 */
async function upsertOwnerByConfig({
  id_configuracion,
  uid_cliente = null,
  nombre_cliente = null,
  celular_cliente = null,
  source = 'owner',
  page_id = null,
  external_id = null,
  id_plataforma = null,
}) {
  // Solo dígitos: nunca guardar con '+' ni espacios (evita duplicados)
  if (celular_cliente != null) {
    celular_cliente = String(celular_cliente).replace(/\D/g, '');
  }

  // 1) Buscar propietario existente (único por config)
  const [owner] = await db.query(
    `SELECT id
       FROM clientes_chat_center
      WHERE id_configuracion = ?
        AND propietario = 1
        AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  // 2) Si existe -> actualizar
  if (owner?.id) {
    await db.query(
      `UPDATE clientes_chat_center
          SET uid_cliente     = COALESCE(?, uid_cliente),
              nombre_cliente  = COALESCE(?, nombre_cliente),
              celular_cliente = COALESCE(?, celular_cliente),
              source          = COALESCE(?, source),
              page_id         = COALESCE(?, page_id),
              external_id     = COALESCE(?, external_id),
              id_plataforma   = COALESCE(?, id_plataforma),
              updated_at      = NOW()
        WHERE id = ?`,
      {
        replacements: [
          uid_cliente,
          nombre_cliente,
          celular_cliente,
          source,
          page_id,
          external_id,
          id_plataforma,
          owner.id,
        ],
      },
    );

    return owner.id;
  }

  // 3) Si no existe -> crear
  const [ins] = await db.query(
    `INSERT INTO clientes_chat_center
      (id_configuracion, id_plataforma, uid_cliente, nombre_cliente, celular_cliente,
       propietario, source, page_id, external_id, created_at, updated_at)
     VALUES
      (?, ?, ?, ?, ?, 1, ?, ?, ?, NOW(), NOW())`,
    {
      replacements: [
        id_configuracion,
        id_plataforma,
        uid_cliente,
        nombre_cliente,
        celular_cliente,
        source,
        page_id,
        external_id,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return ins?.insertId ?? ins;
}

module.exports = {
  getConfigFromDB,
  onlyDigits,
  bytesMB,
  inferHeaderFormatFromMime,
  metaLimitsByFormat,
  validateMetaMediaOrThrow,
  uploadToUploader,
  uploadVideoToVideoAPI,
  uploadMediaToMeta,
  convertVideoForWhatsApp,
  injectHeaderMediaId,
  parseMaybeJSON,
  parseArrayField,
  buildTemplatePayloadBase,
  extractGraphBodyFromRequest,
  prepareHeaderAssetForScheduling,
  extractBearerToken,
  verificarVentana24h,
  isWindowClosedError,
  uploadResumableAndGetHandle,
  generarClaveUnica,
  upsertOwnerByConfig,
};
