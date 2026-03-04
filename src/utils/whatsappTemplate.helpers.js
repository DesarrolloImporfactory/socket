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

function validateMetaMediaOrThrow({ file, format }) {
  if (!file?.buffer?.length) {
    const err = new Error('Archivo vacío o inválido.');
    err.statusCode = 400;
    err.code = 'EMPTY_FILE';
    throw err;
  }

  const f = String(format || '').toUpperCase();
  const { max, allowed } = metaLimitsByFormat(f);

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
  const mediaUrl = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/media`;

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
 * Convierte video a MP4 (H.264/AAC) compatible con WhatsApp.
 */
async function convertVideoForWhatsApp(fileBuffer, originalName) {
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

    // Meta exige pista de audio AAC siempre. Si el video no tiene audio
    // se mezcla con una pista de silencio (anullsrc) para garantizar audioCodec=aac.
    const encodeCmd = [
      `ffmpeg -i "${inputPath}"`,
      `-f lavfi -i anullsrc=r=44100:cl=mono`,
      `-c:v libx264 -preset ultrafast -crf 28`,
      `-filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]"`,
      `-map 0:v -map "[aout]"`,
      `-c:a aac -b:a 96k -ar 44100 -ac 1`,
      `-movflags +faststart -y "${outputPath}"`,
    ].join(' ');
    await execAsync(encodeCmd, { maxBuffer: 50 * 1024 * 1024 });

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

    validateMetaMediaOrThrow({ file: req.file, format: fmt });

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
    });

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

      videoApiResult = await uploadVideoToVideoAPI({
        buffer: downloadedBuffer,
        originalname: defaultFilename,
        mimetype: defaultMime,
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
      header_media_name: defaultFilename,
      file_info: {
        name: defaultFilename,
        mime: defaultMime,
        size: downloadedBuffer.length,
        header_format: fmtDefault,
        converted: false,
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
};
