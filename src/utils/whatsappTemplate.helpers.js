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

    const ffmpegCmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -maxrate 1M -bufsize 2M -movflags +faststart -y "${outputPath}"`;

    await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });

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
 * (Lo usa el endpoint inmediato o el cron al ejecutar programados)
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
 * OJO: para programado NO se envía aún; esto sirve para extraer/normalizar.
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
 * Devuelve:
 * {
 *   header_format,
 *   header_media_url,
 *   header_media_name,
 *   file_info
 * }
 */
async function prepareHeaderAssetForScheduling({
  req,
  preferVideoConversion = true,
}) {
  let header_format = req.body?.header_format ?? null;

  let fileUrl = null;
  let processedBuffer = null;
  let processedMimetype = null;
  let processedFilename = null;
  let fmt = null;

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

    const folder =
      fmt === 'IMAGE'
        ? 'whatsapp/templates/header/images'
        : fmt === 'VIDEO'
          ? 'whatsapp/templates/header/videos'
          : 'whatsapp/templates/header/documents';

    const upHist = await uploadToUploader({
      buffer: processedBuffer,
      originalname: processedFilename,
      mimetype: processedMimetype,
      folder,
    });

    fileUrl = upHist?.fileUrl || null;

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
      },
    };
  }

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

    // Opcional: guardar copia en S3 de una vez (recomendado)
    try {
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

      const folder =
        fmtDefault === 'IMAGE'
          ? 'whatsapp/templates/header/images'
          : fmtDefault === 'VIDEO'
            ? 'whatsapp/templates/header/videos'
            : 'whatsapp/templates/header/documents';

      const upHist = await uploadToUploader({
        buffer: downloadedBuffer,
        originalname: defaultFilename,
        mimetype: defaultMime,
        folder,
      });

      fileUrl = upHist?.fileUrl || decodedDefaultUrl || null;

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
        },
      };
    } catch (e) {
      throw e;
    }
  }

  return {
    header_format: null,
    header_media_url: null,
    header_media_name: null,
    file_info: null,
  };
}

module.exports = {
  getConfigFromDB,
  onlyDigits,
  bytesMB,
  inferHeaderFormatFromMime,
  metaLimitsByFormat,
  validateMetaMediaOrThrow,
  uploadToUploader,
  uploadMediaToMeta,
  convertVideoForWhatsApp,
  injectHeaderMediaId,
  parseMaybeJSON,
  parseArrayField,
  buildTemplatePayloadBase,
  extractGraphBodyFromRequest,
  prepareHeaderAssetForScheduling,
};
