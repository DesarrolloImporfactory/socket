const axios = require('axios');
const FormDataLib = require('form-data');
const { Op } = require('sequelize');
const { db } = require('../database/config');

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const Configuraciones = require('../models/configuraciones.model');
const Usuarios = require('../models/usuarios_chat_center.model');
const Planes = require('../models/planes_chat_center.model');
const GeneracionesIA = require('../models/generaciones_ia.model');
const GeneracionesAngulosIA = require('../models/generaciones_angulos_ia.model');
const EtapasLanding = require('../models/etapas_landing.model');
const TemplatesIA = require('../models/templates_ia.model');

const { decryptToken } = require('../utils/cryptoToken');

// ─── constantes ─────────────────────────────────────────────────────────────
const IL_TRIAL_IMAGES = 10;

// ─── Modelos de imagen Gemini (fallback chain) ──────────────────────────────
const GEMINI_IMAGE_MODELS = [
  process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-preview-image-generation',
  'gemini-3-pro-image-preview',
];

// ─── helpers ────────────────────────────────────────────────────────────────

async function downloadToInlineData(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer' });
  const mimeType = resp.headers?.['content-type'] || 'image/jpeg';
  const base64 = Buffer.from(resp.data).toString('base64');
  return { mimeType, data: base64 };
}

function pickImageBase64(geminiResp) {
  const parts = geminiResp?.data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inlineData?.data);
  return imgPart?.inlineData?.data || null;
}

function mapGeminiQuotaMessage(rawMsg = '') {
  const msg = String(rawMsg);
  console.error(`[Gemini] RAW ERROR: ${msg}`);

  const isQuota =
    msg.includes('exceeded your current quota') ||
    msg.includes('Quota exceeded') ||
    msg.includes('rate limits') ||
    msg.includes('generate_content_free_tier');

  if (isQuota) {
    return {
      statusCode: 402,
      retryable: false,
      message:
        'La API Key de Gemini no tiene cuota disponible o no tiene facturación activada. ' +
        'Activa Billing (Paid tier) en Google AI Studio.',
    };
  }

  const isOverloaded =
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('try again later') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Internal error') ||
    msg.includes('internal');

  if (isOverloaded) {
    return {
      statusCode: 503,
      retryable: true,
      message:
        'El motor de generación se encuentra con alta demanda. Inténtalo de nuevo en unos minutos.',
    };
  }

  return {
    statusCode: 500,
    retryable: false,
    message: 'Error al generar la imagen con Gemini. Intenta nuevamente.',
  };
}

async function callGeminiWithRetry(payload, apiKey, next) {
  const MAX_RETRIES = 2;
  const RETRY_DELAY = 3000;
  let lastError = null;

  for (const model of GEMINI_IMAGE_MODELS) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await axios.post(geminiUrl, payload, {
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 120000,
        });

        const image_base64 = pickImageBase64(resp);
        if (image_base64) {
          if (model !== GEMINI_IMAGE_MODELS[0]) {
            console.log(`[Gemini] Generado con modelo fallback: ${model}`);
          }
          return { image_base64, model };
        }

        lastError = {
          message: 'Gemini no devolvió imagen',
          statusCode: 500,
          retryable: false,
        };
        break;
      } catch (err) {
        const rawMsg =
          err?.response?.data?.error?.message || err?.message || '';
        const mapped = mapGeminiQuotaMessage(rawMsg);
        lastError = mapped;

        if (mapped.statusCode === 402) {
          return next(new AppError(mapped.message, mapped.statusCode));
        }

        if (mapped.retryable && attempt < MAX_RETRIES) {
          console.warn(
            `[Gemini] Retry ${attempt + 1}/${MAX_RETRIES} modelo=${model} — ${rawMsg.slice(0, 100)}`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY * (attempt + 1)));
          continue;
        }

        console.warn(
          `[Gemini] Modelo ${model} falló tras ${attempt + 1} intentos, probando siguiente...`,
        );
        break;
      }
    }
  }

  const finalMsg = lastError?.retryable
    ? 'El motor de generación se encuentra con alta demanda. Inténtalo de nuevo en unos minutos.'
    : lastError?.message || 'Error al generar la imagen.';
  const finalCode = lastError?.retryable ? 503 : lastError?.statusCode || 500;

  return next(new AppError(finalMsg, finalCode));
}

async function uploadImageToS3(base64Data, userId, suffix = '') {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `ia-gen-${userId}-${Date.now()}${suffix}.png`;
    const form = new FormDataLib();
    form.append('file', buffer, {
      filename: `generaciones-ia/${fileName}`,
      contentType: 'image/png',
    });
    const resp = await axios.post(
      'https://uploader.imporfactory.app/api/files/upload',
      form,
      {
        headers: form.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      },
    );
    if (
      resp.status >= 200 &&
      resp.status < 300 &&
      resp.data?.success &&
      resp.data?.data?.url
    ) {
      return resp.data.data.url;
    }
    console.error('[Gemini] S3 upload failed:', resp.status, resp.data);
    return null;
  } catch (err) {
    console.error('[Gemini] S3 upload error:', err.message);
    return null;
  }
}

async function uploadTemplateToS3(fileBuffer, originalName) {
  try {
    const ext = originalName.split('.').pop() || 'png';
    const fileName = `templates-ia/template-${Date.now()}.${ext}`;
    const form = new FormDataLib();
    form.append('file', fileBuffer, {
      filename: fileName,
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    });
    const resp = await axios.post(
      'https://uploader.imporfactory.app/api/files/upload',
      form,
      {
        headers: form.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      },
    );
    if (
      resp.status >= 200 &&
      resp.status < 300 &&
      resp.data?.success &&
      resp.data?.data?.url
    ) {
      return resp.data.data.url;
    }
    return null;
  } catch (err) {
    console.error('[Templates] S3 upload error:', err.message);
    return null;
  }
}

async function getMonthlyCount(id_usuario) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return GeneracionesIA.count({
    where: { id_usuario, created_at: { [Op.gte]: startOfMonth } },
  });
}

async function getMonthlyAngulosCount(id_usuario) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return GeneracionesAngulosIA.count({
    where: { id_usuario, created_at: { [Op.gte]: startOfMonth } },
  });
}

/**
 * validateUserQuota
 */
async function validateUserQuota(id_usuario, next) {
  const usuario = await Usuarios.findOne({
    where: { id_usuario },
    attributes: [
      'id_usuario',
      'id_plan',
      'estado',
      'il_imagenes_usadas',
      'il_trial_used',
      'promo_imagenes_restantes',
      'promo_angulos_restantes',
    ],
    include: [
      {
        model: Planes,
        as: 'plan',
        attributes: [
          'id_plan',
          'nombre_plan',
          'max_imagenes_ia',
          'trial_type',
          'trial_value',
        ],
      },
    ],
  });
  if (!usuario) {
    next(new AppError('Usuario no encontrado', 404));
    return null;
  }
  if (!usuario.plan) {
    next(new AppError('No tienes un plan asignado.', 403));
    return null;
  }

  const estado = (usuario.estado || '').toLowerCase();

  if (estado === 'trial_usage') {
    const limite = Number(usuario.plan?.trial_value) || IL_TRIAL_IMAGES;
    const usadas = Number(usuario.il_imagenes_usadas || 0);
    if (usadas >= limite) {
      next(
        new AppError(
          `Tu prueba gratuita de ${limite} imágenes ha terminado. Suscríbete para seguir generando.`,
          402,
        ),
      );
      return null;
    }
    return {
      usuario,
      maxImagenes: limite,
      usedThisMonth: usadas,
      isTrialUsage: true,
      isPromoUsage: false,
    };
  }

  if (estado === 'promo_usage') {
    const imgRestantes = Number(usuario.promo_imagenes_restantes || 0);
    if (imgRestantes <= 0) {
      next(
        new AppError(
          'Tus imágenes promocionales se agotaron. Suscríbete para continuar.',
          402,
        ),
      );
      return null;
    }
    return {
      usuario,
      maxImagenes: imgRestantes,
      usedThisMonth: 0,
      isTrialUsage: false,
      isPromoUsage: true,
    };
  }

  const maxImagenes = usuario.plan.max_imagenes_ia || 0;
  const promoImgRestantes = Number(usuario.promo_imagenes_restantes || 0);

  if (maxImagenes <= 0) {
    if (promoImgRestantes > 0)
      return {
        usuario,
        maxImagenes: promoImgRestantes,
        usedThisMonth: 0,
        isTrialUsage: false,
        isPromoUsage: true,
      };
    next(
      new AppError('Tu plan no incluye generación de imágenes con IA.', 403),
    );
    return null;
  }

  const usedThisMonth = await getMonthlyCount(id_usuario);
  if (usedThisMonth >= maxImagenes && promoImgRestantes > 0) {
    return {
      usuario,
      maxImagenes: promoImgRestantes,
      usedThisMonth: 0,
      isTrialUsage: false,
      isPromoUsage: true,
    };
  }

  return {
    usuario,
    maxImagenes,
    usedThisMonth,
    isTrialUsage: false,
    isPromoUsage: false,
  };
}

async function getGeminiApiKey(next) {
  const cfg = await Configuraciones.findOne({
    where: {
      api_key_gemini: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
    },
    attributes: ['id', 'api_key_gemini'],
    order: [['id', 'ASC']],
  });
  if (!cfg || !cfg.api_key_gemini) {
    next(
      new AppError('No hay API Key de Gemini configurada en el sistema', 500),
    );
    return null;
  }
  try {
    return decryptToken(cfg.api_key_gemini);
  } catch {
    next(new AppError('API Key de Gemini inválida', 500));
    return null;
  }
}

async function autoSetPortadaIfNeeded(id_producto, image_url) {
  if (!id_producto || !image_url) return;
  try {
    const ProductosIA = require('../models/productos_ia.model');
    const prod = await ProductosIA.findByPk(id_producto, {
      attributes: ['id', 'imagen_portada'],
    });
    if (prod && !prod.imagen_portada)
      await prod.update({ imagen_portada: image_url });
  } catch (e) {
    console.error('[Gemini] Auto-portada error:', e.message);
  }
}

const MOCK_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
function isMockMode() {
  return process.env.GEMINI_MOCK === 'true';
}

function buildQuotaError(quota) {
  if (quota.isTrialUsage)
    return new AppError(
      `Tu prueba gratuita de ${quota.maxImagenes} imágenes ha terminado. Suscríbete para continuar.`,
      402,
    );
  if (quota.isPromoUsage)
    return new AppError(
      'Tus imágenes promocionales se agotaron. Suscríbete para continuar.',
      402,
    );
  return new AppError(
    `Límite de ${quota.maxImagenes} imágenes alcanzado.`,
    429,
  );
}

async function incrementUsageCounter(quota, id_usuario) {
  if (quota.isTrialUsage)
    await Usuarios.increment('il_imagenes_usadas', {
      by: 1,
      where: { id_usuario },
    });
  if (quota.isPromoUsage)
    await Usuarios.decrement('promo_imagenes_restantes', {
      by: 1,
      where: { id_usuario },
    });
}

function buildUsageResponse(quota) {
  if (quota.isPromoUsage) {
    const remaining = Math.max(quota.maxImagenes - 1, 0);
    return {
      used: 0,
      limit: quota.maxImagenes,
      remaining,
      is_trial: false,
      is_promo: true,
    };
  }
  const newUsed = quota.usedThisMonth + 1;
  return {
    used: newUsed,
    limit: quota.maxImagenes,
    remaining: Math.max(quota.maxImagenes - newUsed, 0),
    is_trial: quota.isTrialUsage,
    is_promo: false,
  };
}

// ─── helpers de prompt reutilizables ────────────────────────────────────────

const SIMBOLOS_MONEDA = {
  USD: '$',
  COP: '$',
  MXN: '$',
  PEN: 'S/',
  ARS: '$',
  BRL: 'R$',
};

const IDIOMAS_MAP = {
  es: 'español latinoamericano',
  en: 'English',
  pt: 'Português brasileiro',
  fr: 'Français',
  zh: '中文 (Chino simplificado)',
};

/**
 * Construye las secciones dinámicas del prompt según la etapa.
 *
 * - Precio / moneda  → SOLO para etapa "hero"
 * - Idioma           → TODAS las etapas
 */
function buildDynamicPromptSections({
  etapaSlug,
  description,
  marca,
  angulo_venta,
  pricing,
  moneda,
  idioma,
}) {
  const slug = (etapaSlug || '').toLowerCase();
  const isPricingEtapa = slug === 'hero' || slug === 'oferta';
  const sym = SIMBOLOS_MONEDA[moneda] || '$';
  const sections = [];

  // ── Descripción (todas las etapas) ──
  if (description) {
    sections.push(
      `\nDetalles del producto/marca proporcionados por el usuario: ${description}`,
    );
  }

  // ── Marca (todas las etapas) ──
  if (marca) {
    sections.push(
      `\nMARCA/NEGOCIO: "${marca}" — Usa este nombre de marca exacto donde corresponda en la imagen.`,
    );
  }

  // ── Ángulo de venta (todas las etapas) ──
  if (angulo_venta) {
    sections.push(
      `\nÁNGULO DE VENTA SELECCIONADO POR EL USUARIO: ${angulo_venta}` +
        `\nUSA este ángulo como base para los textos, títulos y enfoque persuasivo de la imagen.`,
    );
  }

  // ── Precio y moneda → SOLO etapas hero y oferta ──
  if (isPricingEtapa && pricing) {
    let pricingLines = [];

    if (pricing.precio_unitario) {
      pricingLines.push(
        `• 1 unidad = ${sym}${pricing.precio_unitario} ${moneda}`,
      );
    }
    if (Array.isArray(pricing.combos) && pricing.combos.length > 0) {
      pricing.combos.forEach((c) => {
        pricingLines.push(
          `• ${c.cantidad} unidades = ${sym}${c.precio} ${moneda}`,
        );
      });
    }

    if (pricingLines.length > 0) {
      sections.push(
        `\n--- PRECIOS OFICIALES DEL PRODUCTO (DATOS EXACTOS DEL VENDEDOR) ---` +
          `\n${pricingLines.join('\n')}` +
          `\n` +
          `\n⚠️ REGLAS ESTRICTAS DE PRECIOS — LEE CON ATENCIÓN:` +
          `\n1. Estos son los PRECIOS FINALES DE VENTA. Muéstralos TAL CUAL en la imagen.` +
          `\n2. PROHIBIDO inventar "precios originales", "precios tachados", "precios antes" o descuentos ficticios.` +
          `\n3. PROHIBIDO calcular porcentajes de descuento a menos que el usuario los haya proporcionado explícitamente.` +
          `\n4. Si hay combo (ej: 2 unidades = ${sym}100), muestra ese precio como el PRECIO REAL del combo, NO como un descuento sobre otro precio.` +
          `\n5. NO cambies los números. Si dice ${sym}${pricing.precio_unitario || '—'}, escribe "${sym}${pricing.precio_unitario || '—'}" exacto.` +
          `\n6. NO redondees, NO inventes centavos, NO modifiques ningún valor.`,
      );
    } else {
      console.warn(
        `[Prompt] isPricingEtapa=true pero pricing vacío: ${JSON.stringify(pricing)}`,
      );
    }

    // Moneda — siempre incluir en etapas de precio para reforzar
    sections.push(
      `\nMONEDA: ${moneda} (símbolo: ${sym}).` +
        `\nTodos los precios en la imagen DEBEN usar el símbolo "${sym}" seguido del valor numérico y "${moneda}".` +
        (moneda !== 'USD'
          ? ` NUNCA uses dólares americanos (USD/$). La moneda correcta es ${moneda} con símbolo ${sym}.`
          : ''),
    );
  }

  // ── Etapas SIN precios → bloqueo explícito ──
  if (!isPricingEtapa) {
    sections.push(
      `\n⚠️ ESTA SECCIÓN NO ES DE PRECIOS. NO incluyas precios, valores monetarios ni ofertas en esta imagen. ` +
        `Enfócate únicamente en el diseño visual y el mensaje de esta etapa.`,
    );
  }

  // ── Idioma → TODAS las etapas (reforzado) ──
  if (idioma !== 'es') {
    const idiomaName = IDIOMAS_MAP[idioma] || idioma;
    sections.push(
      `\n--- IDIOMA OBLIGATORIO ---` +
        `\nTODOS los textos visibles en la imagen DEBEN estar en ${idiomaName}.` +
        `\nESTO INCLUYE: títulos, subtítulos, botones, etiquetas, llamados a la acción, y CUALQUIER texto.` +
        `\nNO uses español bajo ninguna circunstancia. El idioma ${idiomaName} es OBLIGATORIO para todo el contenido textual.`,
    );
  } else {
    sections.push(
      `\nIDIOMA: Todos los textos de la imagen deben estar en español latinoamericano.`,
    );
  }

  return sections;
}

// ═══════════════════════════════════════════════════════════════════════════
// CATÁLOGOS PÚBLICOS
// ═══════════════════════════════════════════════════════════════════════════

exports.get_etapas = catchAsync(async (req, res) => {
  const etapas = await EtapasLanding.findAll({
    where: { activo: 1 },
    attributes: [
      'id',
      'nombre',
      'slug',
      'descripcion',
      'es_obligatoria',
      'orden',
    ],
    order: [['orden', 'ASC']],
  });
  return res.json({ isSuccess: true, data: etapas });
});

exports.get_templates = catchAsync(async (req, res) => {
  const templates = await TemplatesIA.findAll({
    where: { activo: 1 },
    attributes: [
      'id',
      'nombre',
      'src_url',
      'descripcion',
      'categoria',
      'id_etapa',
      'orden',
    ],
    order: [['orden', 'ASC']],
    include: [
      {
        model: EtapasLanding,
        as: 'etapa',
        attributes: ['id', 'nombre', 'slug'],
        required: false,
      },
    ],
  });
  return res.json({ isSuccess: true, data: templates });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: CRUD TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════

exports.admin_list_templates = catchAsync(async (req, res) => {
  const templates = await TemplatesIA.findAll({
    order: [
      ['id_etapa', 'ASC'],
      ['orden', 'ASC'],
    ],
    include: [
      {
        model: EtapasLanding,
        as: 'etapa',
        attributes: ['id', 'nombre', 'slug'],
        required: false,
      },
    ],
  });
  const etapas = await EtapasLanding.findAll({
    where: { activo: 1 },
    attributes: [
      'id',
      'nombre',
      'slug',
      'descripcion',
      'es_obligatoria',
      'orden',
    ],
    order: [['orden', 'ASC']],
  });
  return res.json({ isSuccess: true, data: { templates, etapas } });
});

exports.admin_create_template = catchAsync(async (req, res, next) => {
  const { nombre, id_etapa, descripcion, orden } = req.body;
  if (!nombre) return next(new AppError('El nombre es requerido', 400));
  let src_url = '';
  if (req.file) {
    src_url = await uploadTemplateToS3(req.file.buffer, req.file.originalname);
    if (!src_url) return next(new AppError('Error al subir la imagen', 500));
  } else if (req.body.src_url) {
    src_url = req.body.src_url;
  } else {
    return next(
      new AppError('Debes subir una imagen o proporcionar una URL', 400),
    );
  }
  const template = await TemplatesIA.create({
    nombre,
    src_url,
    descripcion: descripcion || null,
    id_etapa: id_etapa ? Number(id_etapa) : null,
    orden: orden ? Number(orden) : 0,
    activo: 1,
  });
  return res.status(201).json({ isSuccess: true, data: template });
});

exports.admin_update_template = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const template = await TemplatesIA.findByPk(id);
  if (!template) return next(new AppError('Template no encontrado', 404));
  const updates = {};
  if (req.body.nombre !== undefined) updates.nombre = req.body.nombre;
  if (req.body.descripcion !== undefined)
    updates.descripcion = req.body.descripcion;
  if (req.body.id_etapa !== undefined)
    updates.id_etapa = req.body.id_etapa ? Number(req.body.id_etapa) : null;
  if (req.body.orden !== undefined) updates.orden = Number(req.body.orden);
  if (req.body.activo !== undefined) updates.activo = Number(req.body.activo);
  if (req.file) {
    const newUrl = await uploadTemplateToS3(
      req.file.buffer,
      req.file.originalname,
    );
    if (newUrl) updates.src_url = newUrl;
  } else if (req.body.src_url) {
    updates.src_url = req.body.src_url;
  }
  await template.update(updates);
  const updated = await TemplatesIA.findByPk(id, {
    include: [
      {
        model: EtapasLanding,
        as: 'etapa',
        attributes: ['id', 'nombre', 'slug'],
        required: false,
      },
    ],
  });
  return res.json({ isSuccess: true, data: updated });
});

exports.admin_delete_template = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const template = await TemplatesIA.findByPk(id);
  if (!template) return next(new AppError('Template no encontrado', 404));
  await template.destroy();
  return res.json({ isSuccess: true, message: 'Template eliminado' });
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERACIÓN POR ETAPA
// ═══════════════════════════════════════════════════════════════════════════

exports.generar_etapa = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const template_url = String(req.body?.template_url || '').trim();
  const template_id = Number(req.body?.template_id || 0);
  const etapa_id = Number(req.body?.etapa_id || 0);
  const description = String(req.body?.description || '').trim();
  const aspect_ratio = String(req.body?.aspect_ratio || '16:9').trim();
  const angulo_venta = String(req.body?.angulo_venta || '').trim();
  const marca = String(req.body?.marca || '').trim();
  const moneda = String(req.body?.moneda || 'USD').trim();
  const idioma = String(req.body?.idioma || 'es').trim();
  const id_producto = req.body?.id_producto
    ? Number(req.body.id_producto)
    : null;

  let pricing = null;
  try {
    if (req.body?.pricing) pricing = JSON.parse(req.body.pricing);
  } catch {}

  if (!template_url)
    return next(new AppError('template_url es requerido', 400));
  if (!etapa_id) return next(new AppError('etapa_id es requerido', 400));

  const files = Array.isArray(req.files) ? req.files : [];
  let userImageUrls = [];
  try {
    if (req.body?.user_image_urls)
      userImageUrls = JSON.parse(req.body.user_image_urls);
    if (!Array.isArray(userImageUrls)) userImageUrls = [];
  } catch {
    userImageUrls = [];
  }
  if (!files.length && !userImageUrls.length)
    return next(new AppError('Debes subir al menos una imagen', 400));

  const etapa = await EtapasLanding.findOne({
    where: { id: etapa_id, activo: 1 },
    attributes: ['id', 'nombre', 'slug', 'prompt'],
  });
  if (!etapa) return next(new AppError('Etapa no encontrada o inactiva', 404));

  const quota = await validateUserQuota(id_usuario, next);
  if (!quota) return;
  if (quota.usedThisMonth >= quota.maxImagenes)
    return next(buildQuotaError(quota));

  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 1500));
    await incrementUsageCounter(quota, id_usuario);
    await GeneracionesIA.create({
      id_usuario,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
      id_producto,
      template_id: template_id || null,
      id_etapa: etapa_id,
      aspect_ratio,
      description: description || null,
      prompt: 'MOCK',
      model: 'mock',
      image_url: null,
    });
    return res.json({
      isSuccess: true,
      etapa: { id: etapa.id, nombre: etapa.nombre, slug: etapa.slug },
      image_base64: MOCK_IMAGE_BASE64,
      image_url: null,
      model: 'mock',
      usage: buildUsageResponse(quota),
    });
  }

  const apiKey = await getGeminiApiKey(next);
  if (!apiKey) return;

  const templateInline = await downloadToInlineData(template_url);
  const userParts = files.map((f) => ({
    inline_data: {
      mime_type: f.mimetype || 'image/jpeg',
      data: f.buffer.toString('base64'),
    },
  }));
  for (const imgUrl of userImageUrls) {
    try {
      const inlineData = await downloadToInlineData(imgUrl);
      userParts.push({ inline_data: inlineData });
    } catch (e) {
      console.error('[Gemini] Error descargando imagen remota:', e.message);
    }
  }

  // ── Construir prompt con secciones dinámicas ──
  const dynamicSections = buildDynamicPromptSections({
    etapaSlug: etapa.slug,
    description,
    marca,
    angulo_venta,
    pricing,
    moneda,
    idioma,
  });

  const prompt = [
    etapa.prompt,
    ...dynamicSections,
    '\n--- INSTRUCCIONES OBLIGATORIAS DE ESTILO ---',
    'La imagen TEMPLATE adjunta es tu referencia PRINCIPAL de diseño.',
    'DEBES replicar EXACTAMENTE: la paleta de colores, tipografía, estilo de fondos, bordes, iconografía y jerarquía visual del TEMPLATE.',
    'NO inventes colores nuevos. Usa los mismos tonos, degradados y contrastes del TEMPLATE.',
    'Integra las fotos del producto del usuario dentro del diseño manteniendo la coherencia visual del TEMPLATE.',
    'Genera UNA sola imagen final, profesional, lista para publicar.',
  ]
    .filter(Boolean)
    .join('\n');

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

  const result = await callGeminiWithRetry(payload, apiKey, next);
  if (!result || !result.image_base64) return;

  const image_base64 = result.image_base64;
  const model = result.model;
  const image_url = await uploadImageToS3(
    image_base64,
    id_usuario,
    `-${etapa.slug}`,
  );

  await GeneracionesIA.create({
    id_usuario,
    id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    id_producto,
    template_id: template_id || null,
    id_etapa: etapa_id,
    aspect_ratio,
    description: description || null,
    prompt,
    model,
    image_url,
  });
  await autoSetPortadaIfNeeded(id_producto, image_url);
  await incrementUsageCounter(quota, id_usuario);

  return res.json({
    isSuccess: true,
    etapa: { id: etapa.id, nombre: etapa.nombre, slug: etapa.slug },
    image_base64,
    image_url,
    model,
    usage: buildUsageResponse(quota),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERACIÓN SIMPLE (legacy)
// ═══════════════════════════════════════════════════════════════════════════

exports.generar_multipart = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const template_url = String(req.body?.template_url || '').trim();
  const template_id = Number(req.body?.template_id || 0);
  const description = String(req.body?.description || '').trim();
  const aspect_ratio = String(req.body?.aspect_ratio || '1:1').trim();

  if (!template_url)
    return next(new AppError('template_url es requerido', 400));
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length)
    return next(new AppError('Debes subir al menos una imagen', 400));

  const quota = await validateUserQuota(id_usuario, next);
  if (!quota) return;
  if (quota.usedThisMonth >= quota.maxImagenes)
    return next(buildQuotaError(quota));

  const apiKey = await getGeminiApiKey(next);
  if (!apiKey) return;

  const templateInline = await downloadToInlineData(template_url);
  const userParts = files.map((f) => ({
    inline_data: {
      mime_type: f.mimetype || 'image/jpeg',
      data: f.buffer.toString('base64'),
    },
  }));

  const prompt = [
    'Eres un diseñador experto en creatividades para anuncios.',
    'Replica el estilo del TEMPLATE (layout, tipografías, colores y jerarquía visual).',
    'Usa las imágenes del producto como referencia para insertar el producto en el diseño.',
    'Genera UNA sola imagen publicitaria final, lista para publicar.',
    description ? `Detalles del producto/marca: ${description}` : '',
  ]
    .filter(Boolean)
    .join('\n');

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

  const result = await callGeminiWithRetry(payload, apiKey, next);
  if (!result || !result.image_base64) return;

  const image_base64 = result.image_base64;
  const model = result.model;
  const image_url = await uploadImageToS3(image_base64, id_usuario);

  await GeneracionesIA.create({
    id_usuario,
    id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    template_id: template_id || null,
    aspect_ratio,
    description: description || null,
    prompt,
    model,
    image_url,
  });
  await incrementUsageCounter(quota, id_usuario);

  return res.json({
    isSuccess: true,
    image_base64,
    image_url,
    prompt,
    model,
    usage: buildUsageResponse(quota),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSULTAS
// ═══════════════════════════════════════════════════════════════════════════

exports.get_usage = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const usuario = await Usuarios.findOne({
    where: { id_usuario },
    attributes: [
      'id_usuario',
      'id_plan',
      'estado',
      'il_imagenes_usadas',
      'promo_imagenes_restantes',
      'promo_angulos_restantes',
    ],
    include: [
      {
        model: Planes,
        as: 'plan',
        attributes: [
          'id_plan',
          'nombre_plan',
          'max_imagenes_ia',
          'max_angulos_ia',
          'trial_type',
          'trial_value',
        ],
      },
    ],
  });
  if (!usuario) return next(new AppError('Usuario no encontrado', 404));

  const estado = (usuario.estado || '').toLowerCase();
  const isTrialUsage = estado === 'trial_usage';
  const isPromoUsage = estado === 'promo_usage';

  if (isPromoUsage) {
    const imgRestantes = Number(usuario.promo_imagenes_restantes || 0);
    const angRestantes = Number(usuario.promo_angulos_restantes || 0);
    const [[canje]] = await db.query(
      `SELECT imagenes_otorgadas, angulos_otorgados FROM canjes_codigo_promocional WHERE id_usuario = ? ORDER BY fecha_canje DESC LIMIT 1`,
      { replacements: [id_usuario] },
    );
    const imgTotal = Number(canje?.imagenes_otorgadas || imgRestantes);
    const angTotal = Number(canje?.angulos_otorgados || angRestantes);
    return res.json({
      isSuccess: true,
      usage: {
        used: imgTotal - imgRestantes,
        limit: imgTotal,
        remaining: imgRestantes,
        plan: 'Código Promocional',
        is_trial: false,
        is_promo: true,
        angles_used: angTotal - angRestantes,
        angles_limit: angTotal,
        angles_remaining: angRestantes,
      },
    });
  }

  const maxImagenes = isTrialUsage
    ? Number(usuario.plan?.trial_value) || IL_TRIAL_IMAGES
    : usuario.plan?.max_imagenes_ia || 0;
  const usedImagenes = isTrialUsage
    ? Number(usuario.il_imagenes_usadas || 0)
    : await getMonthlyCount(id_usuario);
  const maxAngulos = usuario.plan?.max_angulos_ia ?? null;
  const usedAngulos =
    maxAngulos !== null ? await getMonthlyAngulosCount(id_usuario) : 0;
  const promoImgBonus = Number(usuario.promo_imagenes_restantes || 0);
  const promoAngBonus = Number(usuario.promo_angulos_restantes || 0);

  return res.json({
    isSuccess: true,
    usage: {
      used: usedImagenes,
      limit: maxImagenes,
      remaining: Math.max(maxImagenes - usedImagenes, 0),
      plan: usuario.plan?.nombre_plan || 'Sin plan',
      is_trial: isTrialUsage,
      is_promo: false,
      angles_used: usedAngulos,
      angles_limit: maxAngulos,
      angles_remaining:
        maxAngulos !== null ? Math.max(maxAngulos - usedAngulos, 0) : 0,
      promo_imagenes_restantes: promoImgBonus > 0 ? promoImgBonus : undefined,
      promo_angulos_restantes: promoAngBonus > 0 ? promoAngBonus : undefined,
    },
  });
});

exports.get_historial = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;
  const { count, rows } = await GeneracionesIA.findAndCountAll({
    where: { id_usuario },
    order: [['created_at', 'DESC']],
    limit,
    offset,
    attributes: [
      'id',
      'template_id',
      'id_etapa',
      'aspect_ratio',
      'description',
      'model',
      'image_url',
      'created_at',
    ],
    include: [
      {
        model: EtapasLanding,
        as: 'etapa',
        attributes: ['id', 'nombre', 'slug'],
        required: false,
      },
    ],
  });
  return res.json({
    isSuccess: true,
    data: rows,
    pagination: { total: count, page, limit, pages: Math.ceil(count / limit) },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERAR ÁNGULOS DE VENTA (IA texto)
// ═══════════════════════════════════════════════════════════════════════════

exports.generar_angulos = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));
  const description = String(req.body?.description || '').trim();
  const pricing = req.body?.pricing || null;
  if (!description)
    return next(new AppError('La descripción del producto es requerida', 400));

  const usuarioConPlan = await Usuarios.findOne({
    where: { id_usuario },
    attributes: ['id_usuario', 'id_plan', 'estado', 'promo_angulos_restantes'],
    include: [{ model: Planes, as: 'plan', attributes: ['max_angulos_ia'] }],
  });
  const estadoAng = (usuarioConPlan?.estado || '').toLowerCase();

  if (estadoAng === 'promo_usage') {
    const angRestantes = Number(usuarioConPlan.promo_angulos_restantes || 0);
    if (angRestantes <= 0)
      return next(
        new AppError(
          'Tus ángulos promocionales se agotaron. Suscríbete para continuar.',
          402,
        ),
      );
    const angulosResult = await _generateAngulos(description, pricing, next);
    if (!angulosResult) return;
    await Usuarios.decrement('promo_angulos_restantes', {
      by: 1,
      where: { id_usuario },
    });
    await GeneracionesAngulosIA.create({ id_usuario });
    return res.json({
      isSuccess: true,
      data: angulosResult,
      angles_usage: {
        used: 0,
        limit: angRestantes,
        remaining: angRestantes - 1,
        is_promo: true,
      },
    });
  }

  const maxAngulos = usuarioConPlan?.plan?.max_angulos_ia ?? null;
  const promoAngRestantes = Number(
    usuarioConPlan?.promo_angulos_restantes || 0,
  );

  if (maxAngulos === null || maxAngulos <= 0) {
    if (promoAngRestantes > 0) {
      const angulosResult = await _generateAngulos(description, pricing, next);
      if (!angulosResult) return;
      await Usuarios.decrement('promo_angulos_restantes', {
        by: 1,
        where: { id_usuario },
      });
      await GeneracionesAngulosIA.create({ id_usuario });
      return res.json({
        isSuccess: true,
        data: angulosResult,
        angles_usage: {
          used: 0,
          limit: promoAngRestantes,
          remaining: promoAngRestantes - 1,
          is_promo: true,
        },
      });
    }
    return next(
      new AppError('Tu plan no incluye generación de ángulos IA.', 403),
    );
  }

  const usedAngulos = await getMonthlyAngulosCount(id_usuario);

  if (usedAngulos >= maxAngulos && promoAngRestantes > 0) {
    const angulosResult = await _generateAngulos(description, pricing, next);
    if (!angulosResult) return;
    await Usuarios.decrement('promo_angulos_restantes', {
      by: 1,
      where: { id_usuario },
    });
    await GeneracionesAngulosIA.create({ id_usuario });
    return res.json({
      isSuccess: true,
      data: angulosResult,
      angles_usage: {
        used: 0,
        limit: promoAngRestantes,
        remaining: promoAngRestantes - 1,
        is_promo: true,
      },
    });
  }

  if (usedAngulos >= maxAngulos)
    return next(
      new AppError(
        `Límite de ${maxAngulos} generaciones de ángulos alcanzado.`,
        429,
      ),
    );

  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 800));
    await GeneracionesAngulosIA.create({ id_usuario });
    return res.json({
      isSuccess: true,
      data: [
        {
          titulo: 'Mock — Urgencia extrema',
          descripcion: 'Ángulo de prueba para desarrollo local',
          tono: 'Urgencia',
          ejemplo_headline: '¡Solo quedan 3 unidades! No lo dejes pasar',
        },
        {
          titulo: 'Mock — Exclusividad total',
          descripcion: 'Segundo ángulo de prueba',
          tono: 'Exclusividad',
          ejemplo_headline: 'El producto que solo conocen los que saben',
        },
        {
          titulo: 'Mock — Ahorro inteligente',
          descripcion: 'Tercer ángulo de prueba',
          tono: 'Ahorro',
          ejemplo_headline: 'Paga menos, obtén más. Así de simple',
        },
      ],
      angles_usage: {
        used: usedAngulos + 1,
        limit: maxAngulos,
        remaining: Math.max(maxAngulos - usedAngulos - 1, 0),
      },
    });
  }

  const angulosResult = await _generateAngulos(description, pricing, next);
  if (!angulosResult) return;
  await GeneracionesAngulosIA.create({ id_usuario });
  const newUsedAngulos = usedAngulos + 1;
  return res.json({
    isSuccess: true,
    data: angulosResult,
    angles_usage: {
      used: newUsedAngulos,
      limit: maxAngulos,
      remaining: Math.max(maxAngulos - newUsedAngulos, 0),
    },
  });
});

async function _generateAngulos(description, pricing, next) {
  const apiKey = await getGeminiApiKey(next);
  if (!apiKey) return null;

  let pricingContext = '';
  if (pricing) {
    if (pricing.precio_unitario)
      pricingContext += `\nPrecio unitario: $${pricing.precio_unitario}`;
    if (Array.isArray(pricing.combos) && pricing.combos.length > 0) {
      pricingContext += '\nCombos/ofertas disponibles:';
      pricing.combos.forEach((c) => {
        pricingContext += `\n  - ${c.cantidad}x por $${c.precio}`;
      });
    }
  }

  const prompt = `Eres un experto en copywriting, neuroventas y marketing digital especializado en e-commerce para Latinoamérica.

PRODUCTO/MARCA: ${description}
${pricingContext}

Tu tarea: Genera EXACTAMENTE 3 ángulos de venta DIFERENTES y CREATIVOS para este producto.
Cada ángulo debe atacar una emoción/necesidad diferente del comprador.

Reglas:
- Cada ángulo debe ser único y diferenciado de los otros
- Deben ser aplicables a una landing page de producto
- Incluye cómo se usaría el precio/oferta en el ángulo si aplica
- Escribe en español latinoamericano
- Sé específico, no genérico

Responde ÚNICAMENTE con un JSON válido (sin markdown, sin backticks) con este formato exacto:
[
  { "titulo": "Título corto y llamativo (máx 8 palabras)", "descripcion": "Explicación del enfoque de venta y qué emociones ataca (máx 40 palabras)", "tono": "El tono emocional principal en 2-3 palabras", "ejemplo_headline": "Un headline de ejemplo para la landing (máx 12 palabras)" },
  { "titulo": "...", "descripcion": "...", "tono": "...", "ejemplo_headline": "..." },
  { "titulo": "...", "descripcion": "...", "tono": "...", "ejemplo_headline": "..." }
]`;

  const textModel = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${textModel}:generateContent`;

  let geminiResp;
  try {
    geminiResp = await axios.post(
      geminiUrl,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.9,
        },
      },
      {
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
    );
  } catch (err) {
    console.log('[Angulos] Gemini error:', err?.response?.data || err.message);
    const rawMsg = err?.response?.data?.error?.message || err?.message || '';
    const mapped = mapGeminiQuotaMessage(rawMsg);
    next(new AppError(mapped.message, mapped.statusCode));
    return null;
  }

  const parts = geminiResp?.data?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p) => p?.text);
  if (!textPart?.text) {
    next(new AppError('Gemini no devolvió ángulos de venta', 500));
    return null;
  }

  let angulos;
  try {
    const cleaned = textPart.text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    angulos = JSON.parse(cleaned);
  } catch {
    next(new AppError('Error al procesar los ángulos de venta', 500));
    return null;
  }
  if (!Array.isArray(angulos) || angulos.length < 1) {
    next(new AppError('Gemini no generó ángulos válidos', 500));
    return null;
  }
  return angulos.slice(0, 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// REGENERAR ETAPA
// ═══════════════════════════════════════════════════════════════════════════

exports.regenerar_etapa = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const template_url = String(req.body?.template_url || '').trim();
  const template_id = Number(req.body?.template_id || 0);
  const etapa_id = Number(req.body?.etapa_id || 0);
  const description = String(req.body?.description || '').trim();
  const aspect_ratio = String(req.body?.aspect_ratio || '16:9').trim();
  const angulo_venta = String(req.body?.angulo_venta || '').trim();
  const prompt_extra = String(req.body?.prompt_extra || '').trim();
  const marca = String(req.body?.marca || '').trim();
  const moneda = String(req.body?.moneda || 'USD').trim();
  const idioma = String(req.body?.idioma || 'es').trim();
  const id_producto = req.body?.id_producto
    ? Number(req.body.id_producto)
    : null;

  let pricing = null;
  try {
    if (req.body?.pricing) pricing = JSON.parse(req.body.pricing);
  } catch {}

  if (!template_url)
    return next(new AppError('template_url es requerido', 400));
  if (!etapa_id) return next(new AppError('etapa_id es requerido', 400));
  if (!prompt_extra)
    return next(new AppError('prompt_extra es requerido para regenerar', 400));

  const files = Array.isArray(req.files) ? req.files : [];
  let userImageUrls = [];
  try {
    if (req.body?.user_image_urls)
      userImageUrls = JSON.parse(req.body.user_image_urls);
    if (!Array.isArray(userImageUrls)) userImageUrls = [];
  } catch {
    userImageUrls = [];
  }
  if (!files.length && !userImageUrls.length)
    return next(new AppError('Debes subir al menos una imagen', 400));

  const etapa = await EtapasLanding.findOne({
    where: { id: etapa_id, activo: 1 },
    attributes: ['id', 'nombre', 'slug', 'prompt'],
  });
  if (!etapa) return next(new AppError('Etapa no encontrada o inactiva', 404));

  const quota = await validateUserQuota(id_usuario, next);
  if (!quota) return;
  if (quota.usedThisMonth >= quota.maxImagenes)
    return next(buildQuotaError(quota));

  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 1500));
    await incrementUsageCounter(quota, id_usuario);
    await GeneracionesIA.create({
      id_usuario,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
      id_producto,
      template_id: template_id || null,
      id_etapa: etapa_id,
      aspect_ratio,
      description: description || null,
      prompt: 'MOCK',
      model: 'mock',
      image_url: null,
    });
    return res.json({
      isSuccess: true,
      etapa: { id: etapa.id, nombre: etapa.nombre, slug: etapa.slug },
      image_base64: MOCK_IMAGE_BASE64,
      image_url: null,
      model: 'mock',
      usage: buildUsageResponse(quota),
    });
  }

  const apiKey = await getGeminiApiKey(next);
  if (!apiKey) return;

  const templateInline = await downloadToInlineData(template_url);
  const userParts = files.map((f) => ({
    inline_data: {
      mime_type: f.mimetype || 'image/jpeg',
      data: f.buffer.toString('base64'),
    },
  }));
  for (const imgUrl of userImageUrls) {
    try {
      const inlineData = await downloadToInlineData(imgUrl);
      userParts.push({ inline_data: inlineData });
    } catch (e) {
      console.error('[Gemini] Error descargando imagen remota:', e.message);
    }
  }

  // ── Construir prompt con secciones dinámicas ──
  const dynamicSections = buildDynamicPromptSections({
    etapaSlug: etapa.slug,
    description,
    marca,
    angulo_venta,
    pricing,
    moneda,
    idioma,
  });

  const prompt = [
    etapa.prompt,
    ...dynamicSections,
    '\n--- CORRECCIONES DEL USUARIO ---',
    `El usuario ha pedido los siguientes cambios específicos: ${prompt_extra}`,
    '\n--- INSTRUCCIONES OBLIGATORIAS DE ESTILO ---',
    'La imagen TEMPLATE adjunta es tu referencia PRINCIPAL de diseño.',
    'DEBES replicar EXACTAMENTE: la paleta de colores, tipografía, estilo de fondos, bordes, iconografía y jerarquía visual del TEMPLATE.',
    'NO inventes colores nuevos. Usa los mismos tonos, degradados y contrastes del TEMPLATE.',
    'Integra las fotos del producto del usuario dentro del diseño manteniendo la coherencia visual del TEMPLATE.',
    'Genera UNA sola imagen final, profesional, lista para publicar.',
  ]
    .filter(Boolean)
    .join('\n');

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

  const result = await callGeminiWithRetry(payload, apiKey, next);
  if (!result || !result.image_base64) return;

  const image_base64 = result.image_base64;
  const model = result.model;
  const image_url = await uploadImageToS3(
    image_base64,
    id_usuario,
    `-${etapa.slug}-edit`,
  );

  await GeneracionesIA.create({
    id_usuario,
    id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    id_producto,
    template_id: template_id || null,
    id_etapa: etapa_id,
    aspect_ratio,
    description: description || null,
    prompt,
    model,
    image_url,
  });
  await autoSetPortadaIfNeeded(id_producto, image_url);
  await incrementUsageCounter(quota, id_usuario);

  return res.json({
    isSuccess: true,
    etapa: { id: etapa.id, nombre: etapa.nombre, slug: etapa.slug },
    image_base64,
    image_url,
    model,
    usage: buildUsageResponse(quota),
  });
});

// ─── LEGACY ──────────────────────────────────────────────────────────────────

exports.obtener_api_key = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion },
    attributes: ['id', 'api_key_gemini'],
  });
  if (!cfg) return next(new AppError('Configuración no encontrada', 404));
  return res.json({
    isSuccess: true,
    api_key: Boolean(cfg.api_key_gemini && String(cfg.api_key_gemini).trim()),
  });
});

exports.guardar_api_key = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion || 0);
  const api_key = String(req.body?.api_key || '').trim();
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!api_key) return next(new AppError('api_key es requerida', 400));
  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion },
    attributes: ['id'],
  });
  if (!cfg) return next(new AppError('Configuración no encontrada', 404));
  const { encryptToken } = require('../utils/cryptoToken');
  await Configuraciones.update(
    { api_key_gemini: encryptToken(api_key) },
    { where: { id: id_configuracion } },
  );
  return res.json({
    isSuccess: true,
    message: 'API Key guardada correctamente',
  });
});
