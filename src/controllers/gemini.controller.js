const axios = require('axios');

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const Configuraciones = require('../models/configuraciones.model');

const { encryptToken, decryptToken } = require('../utils/cryptoToken');

/**
 * Descarga una imagen remota y la convierte a inlineData para Gemini
 */
async function downloadToInlineData(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  const mimeType = resp.headers?.['content-type'] || 'image/jpeg';
  const base64 = Buffer.from(resp.data).toString('base64');
  return { mimeType, data: base64 };
}

/**
 * Extrae el base64 de la imagen desde la respuesta de Gemini
 * candidates[0].content.parts[*].inlineData.data
 */
function pickImageBase64(geminiResp) {
  const parts = geminiResp?.data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inlineData?.data);
  return imgPart?.inlineData?.data || null;
}

exports.obtener_api_key = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion },
    attributes: ['id', 'api_key_gemini'],
  });

  if (!cfg) return next(new AppError('Configuración no encontrada', 404));

  const hasKey = Boolean(
    cfg.api_key_gemini && String(cfg.api_key_gemini).trim(),
  );
  return res.json({ isSuccess: true, api_key: hasKey });
});

exports.guardar_api_key = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion || 0);
  const api_key = String(req.body?.api_key || '').trim();

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!api_key) return next(new AppError('api_key es requerida', 400));

  // misma validación que tu modal
  if (!api_key.startsWith('AIza')) {
    return next(new AppError('La clave debe empezar con AIza...', 400));
  }

  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion },
    attributes: ['id'],
  });

  if (!cfg) return next(new AppError('Configuración no encontrada', 404));

  // cifrar con tu misma librería AES-256-GCM
  const enc = encryptToken(api_key);

  await Configuraciones.update(
    { api_key_gemini: enc },
    { where: { id: id_configuracion } },
  );

  return res.json({
    isSuccess: true,
    message: 'API Key guardada correctamente',
  });
});

function mapGeminiQuotaMessage(rawMsg = '') {
  const msg = String(rawMsg);

  // Casos típicos de cuota / billing
  const isQuota =
    msg.includes('exceeded your current quota') ||
    msg.includes('Quota exceeded') ||
    msg.includes('rate limits') ||
    msg.includes('generate_content_free_tier');

  if (isQuota) {
    return {
      statusCode: 402, // Payment Required (útil para el front)
      message:
        'Tu API Key de Gemini no tiene cuota disponible o no tiene facturación activada. ' +
        'Activa Billing (Paid tier) en Google AI Studio para poder generar imágenes.',
    };
  }

  // fallback genérico
  return {
    statusCode: 500,
    message:
      'Ocurrió un error al generar la imagen con Gemini. Intenta nuevamente.',
  };
}

exports.generar_multipart = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion || 0);
  const template_url = String(req.body?.template_url || '').trim();
  const description = String(req.body?.description || '').trim();
  const aspect_ratio = String(req.body?.aspect_ratio || '1:1').trim();

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!template_url)
    return next(new AppError('template_url es requerido', 400));

  //  multer pone los archivos en req.files
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length)
    return next(
      new AppError('Debes subir al menos una imagen (user_images)', 400),
    );

  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion },
    attributes: ['id', 'api_key_gemini'],
  });

  if (!cfg) return next(new AppError('Configuración no encontrada', 404));
  if (!cfg.api_key_gemini)
    return next(new AppError('No hay API Key de Gemini guardada', 400));

  let apiKey;
  try {
    apiKey = decryptToken(cfg.api_key_gemini);
  } catch (e) {
    return next(
      new AppError('API Key de Gemini inválida o no se pudo descifrar', 400),
    );
  }

  // 1) template referencia
  const templateInline = await downloadToInlineData(template_url);

  // 2) archivos del usuario a inline_data
  const userParts = files.map((f) => ({
    inline_data: {
      mime_type: f.mimetype || 'image/jpeg',
      data: f.buffer.toString('base64'),
    },
  }));

  // Prompt
  const prompt = [
    'Eres un diseñador experto en creatividades para anuncios.',
    'Replica el estilo del TEMPLATE (layout, tipografías, colores y jerarquía visual).',
    'Usa las imágenes del producto como referencia para insertar el producto en el diseño.',
    'Genera UNA sola imagen publicitaria final, lista para publicar.',
    'Evita texto ilegible. Si agregas texto, que sea corto y muy claro.',
    description ? `Detalles del producto/marca: ${description}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const model =
    process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: templateInline.mimeType,
              data: templateInline.data,
            },
          },
          ...userParts,
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: aspect_ratio },
    },
  };

  let geminiResp;
  try {
    geminiResp = await axios.post(url, payload, {
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });
  } catch (err) {
    const rawMsg =
      err?.response?.data?.error?.message || err?.message || 'Gemini error';

    const mapped = mapGeminiQuotaMessage(rawMsg);

    return next(new AppError(mapped.message, mapped.statusCode));
  }

  const image_base64 = pickImageBase64(geminiResp);
  if (!image_base64)
    return next(new AppError('Gemini no devolvió imagen en la respuesta', 500));

  return res.json({
    isSuccess: true,
    image_base64,
    prompt,
    model,
  });
});
