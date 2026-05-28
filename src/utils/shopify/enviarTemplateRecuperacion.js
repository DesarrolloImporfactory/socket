'use strict';

const axios = require('axios');
const { db } = require('../../database/config');

const META_API_VERSION = process.env.GRAPH_VERSION;

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */

function safeJsonParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch (_) {
    return fallback;
  }
}

/* ═══════════════════════════════════════════════════════════
   Resolver variable de template desde el carrito Shopify
   ═══════════════════════════════════════════════════════════ */

function resolveVariableShopify(varName, datos) {
  const items = Array.isArray(datos.line_items) ? datos.line_items : [];
  const shipping = datos.shipping_address || {};

  switch (varName) {
    case 'nombre':
      return datos.nombre_cliente || 'Cliente';
    case 'apellido':
      return datos.apellido_cliente || '';
    case 'nombre_completo':
      return (
        `${datos.nombre_cliente || ''} ${datos.apellido_cliente || ''}`.trim() ||
        'Cliente'
      );
    case 'producto':
      return items[0]?.title || 'tu pedido';
    case 'productos':
      if (!items.length) return 'tu pedido';
      return items
        .map((p) => `${p.quantity || 1} x ${p.title || 'Producto'}`)
        .join(', ');
    case 'cantidad':
      return String(
        items.reduce((sum, p) => sum + (Number(p.quantity) || 1), 0),
      );
    case 'total':
      return String(datos.total_price || '0');
    case 'moneda':
      return datos.currency || 'USD';
    case 'recovery_url':
      return datos.recovery_url || '';
    case 'ciudad':
      return shipping.city || '';
    case 'provincia':
      return shipping.province || '';
    case 'telefono':
      return datos.phone_normalizado || '';
    default:
      return '';
  }
}

/* ═══════════════════════════════════════════════════════════
   Construir components Meta
   ═══════════════════════════════════════════════════════════ */

function buildTemplateComponents(parametrosJson, datos) {
  const config = safeJsonParse(parametrosJson, null);
  if (!config) return [];

  const components = [];

  if (Array.isArray(config.body) && config.body.length > 0) {
    components.push({
      type: 'body',
      parameters: config.body.map((varName) => ({
        type: 'text',
        text: resolveVariableShopify(varName, datos) || '',
      })),
    });
  }

  if (Array.isArray(config.buttons) && config.buttons.length > 0) {
    for (const btn of config.buttons) {
      const idx = btn.index != null ? btn.index : 0;
      const value = resolveVariableShopify(btn.variable || '', datos) || '';
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(idx),
        parameters: [{ type: 'text', text: value }],
      });
    }
  }

  return components;
}

/* ═══════════════════════════════════════════════════════════
   Interpolar body_text para guardarlo en el chat
   ═══════════════════════════════════════════════════════════ */

function interpolarBodyText(bodyText, components) {
  if (!bodyText) return null;
  let resultado = bodyText;
  const bodyComp = components.find((c) => c.type === 'body');
  if (bodyComp?.parameters) {
    bodyComp.parameters.forEach((p, i) => {
      resultado = resultado.replace(`{{${i + 1}}}`, p.text || '');
    });
  }
  return resultado;
}

/* ═══════════════════════════════════════════════════════════
   Credenciales WA
   ═══════════════════════════════════════════════════════════ */

async function getWaCredentials(id_configuracion) {
  const [row] = await db.query(
    `SELECT id_telefono AS phone_number_id, token AS waba_token, telefono
     FROM configuraciones 
     WHERE id = ? AND id_telefono IS NOT NULL AND token IS NOT NULL 
     LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/* ═══════════════════════════════════════════════════════════
   Envío Meta
   ═══════════════════════════════════════════════════════════ */

async function enviarTemplate({
  phone_number_id,
  waba_token,
  phoneNorm,
  templateName,
  languageCode,
  components,
}) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNorm,
    type: 'template',
    template: { name: templateName, language: { code: languageCode || 'es' } },
  };
  if (components && components.length > 0) {
    payload.template.components = components;
  }

  const { data } = await axios.post(
    `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${waba_token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    },
  );
  return { wamid: data?.messages?.[0]?.id || null, payload };
}

/* ═══════════════════════════════════════════════════════════
   Registrar mensaje en el chat del cliente
   ═══════════════════════════════════════════════════════════ */

async function registrarMensajeEnChat({
  id_configuracion,
  phone_number_id,
  id_cliente,
  phoneNorm,
  textoMensaje,
  templateName,
  languageCode,
  waMessageId,
  jsonMensaje,
}) {
  try {
    await db.query(
      `INSERT INTO mensajes_clientes
         (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje, rol_mensaje,
          celular_recibe, responsable, texto_mensaje,
          json_mensaje, visto, uid_whatsapp, id_wamid_mensaje,
          template_name, language_code, informacion_suficiente)
       VALUES (?, ?, ?, 'template', 1, ?, 'Shopify Recovery', ?,
               ?, 1, ?, ?, ?, ?, 1)`,
      {
        replacements: [
          id_configuracion,
          id_cliente,
          phone_number_id,
          id_cliente,
          textoMensaje || '',
          jsonMensaje ? JSON.stringify(jsonMensaje) : null,
          phoneNorm,
          waMessageId || null,
          templateName || null,
          languageCode || null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (err) {
    // No bloquear el flujo si falla solo el registro en chat
  }
}

/* ═══════════════════════════════════════════════════════════
   FUNCIÓN PRINCIPAL
   ═══════════════════════════════════════════════════════════ */

/**
 * Envía el template de recuperación al cliente que abandonó.
 *
 * @param {Object} params
 * @param {Object} params.datos - Datos del carrito:
 *   { nombre_cliente, apellido_cliente, phone_normalizado, line_items,
 *     shipping_address, total_price, currency, recovery_url, id_cliente }
 * @param {Object} params.shopifyConfig - Config Shopify del modelo Sequelize
 *
 * @returns {Object} { enviado: boolean, wamid?, error?, motivo? }
 */
async function enviarTemplateRecuperacion({ datos, shopifyConfig }) {
  // Validaciones
  if (!shopifyConfig.envio_automatico) {
    return { enviado: false, motivo: 'envio_automatico=0' };
  }
  if (!shopifyConfig.nombre_template_recuperacion) {
    return { enviado: false, motivo: 'sin template configurado' };
  }
  if (!datos.phone_normalizado) {
    return { enviado: false, motivo: 'sin teléfono' };
  }
  if (!datos.id_cliente) {
    return { enviado: false, motivo: 'sin id_cliente' };
  }

  const id_configuracion = shopifyConfig.id_configuracion;

  // Credenciales WA
  const creds = await getWaCredentials(id_configuracion);
  if (!creds?.phone_number_id || !creds?.waba_token) {
    return { enviado: false, motivo: 'sin credenciales WA' };
  }

  // Construir components
  const components = buildTemplateComponents(
    shopifyConfig.parametros_json,
    datos,
  );

  // Enviar a Meta
  let result;
  try {
    result = await enviarTemplate({
      phone_number_id: creds.phone_number_id,
      waba_token: creds.waba_token,
      phoneNorm: datos.phone_normalizado,
      templateName: shopifyConfig.nombre_template_recuperacion,
      languageCode: shopifyConfig.language_code || 'es',
      components,
    });
  } catch (err) {
    const metaError =
      err?.response?.data?.error?.message ||
      err?.response?.data?.error?.error_user_msg ||
      err.message;
    return { enviado: false, error: metaError };
  }

  // Registrar mensaje en chat (para que aparezca en chatcenter)
  const bodyInterpolado = interpolarBodyText(
    shopifyConfig.body_text,
    components,
  );
  await registrarMensajeEnChat({
    id_configuracion,
    phone_number_id: creds.phone_number_id,
    id_cliente: datos.id_cliente,
    phoneNorm: datos.phone_normalizado,
    textoMensaje: bodyInterpolado || shopifyConfig.nombre_template_recuperacion,
    templateName: shopifyConfig.nombre_template_recuperacion,
    languageCode: shopifyConfig.language_code,
    waMessageId: result.wamid,
    jsonMensaje: result.payload,
  });

  return { enviado: true, wamid: result.wamid };
}

module.exports = { enviarTemplateRecuperacion };
