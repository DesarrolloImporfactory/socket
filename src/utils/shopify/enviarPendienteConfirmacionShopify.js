'use strict';

const axios = require('axios');
const { db } = require('../../database/config');

const META_API_VERSION = 'v22.0';

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */

function safeJsonParse(str, fallback) {
  try {
    if (str == null) return fallback;
    if (typeof str === 'object') return str;
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

/* Resolver variable Dropi desde el order de Shopify */
function resolveVariableShopify(varName, ctx) {
  const { order, shipping, billing, customer, lineItems, phone_normalizado } =
    ctx;

  switch (varName) {
    case 'nombre':
      return (
        customer.first_name ||
        shipping.first_name ||
        billing.first_name ||
        'Cliente'
      );
    case 'apellido':
      return (
        customer.last_name || shipping.last_name || billing.last_name || ''
      );
    case 'contenido':
      if (!lineItems.length) return 'Tu pedido';
      return lineItems
        .map((p) => `${p.quantity || 1} x ${p.title || 'Producto'}`)
        .join(', ');
    case 'direccion': {
      const a1 = shipping.address1 || billing.address1 || '';
      const a2 = shipping.address2 || billing.address2 || '';
      return [a1, a2].filter(Boolean).join(', ') || 'Dirección no disponible';
    }
    case 'costo':
      return String(order.total_price || '0');
    case 'ciudad':
      return shipping.city || billing.city || '';
    case 'provincia':
      return shipping.province || billing.province || '';
    case 'telefono':
      return phone_normalizado || '';
    case 'order_id':
      return String(order.id || '');
    case 'numero_guia':
    case 'transportadora':
    case 'tracking':
    case 'guia_pdf':
      return '';
    default:
      return '';
  }
}

function buildTemplateComponents(parametrosJson, ctx) {
  const config = safeJsonParse(parametrosJson, null);
  if (!config) return [];
  const components = [];
  if (Array.isArray(config.body) && config.body.length > 0) {
    components.push({
      type: 'body',
      parameters: config.body.map((varName) => ({
        type: 'text',
        text: resolveVariableShopify(varName, ctx) || '',
      })),
    });
  }
  if (Array.isArray(config.buttons) && config.buttons.length > 0) {
    for (const btn of config.buttons) {
      const idx = btn.index != null ? btn.index : 0;
      const value = resolveVariableShopify(btn.variable || '', ctx) || '';
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
   Verificaciones cruzadas (dedupe)
   ═══════════════════════════════════════════════════════════ */

async function existeEnDropiCache({
  id_configuracion,
  phone_normalizado,
  total,
}) {
  if (!phone_normalizado) return false;
  const phone9 = phone_normalizado.slice(-9);
  if (!phone9) return false;

  const [row] = await db.query(
    `SELECT 1 FROM dropi_orders_cache
     WHERE id_configuracion = ?
       AND phone LIKE ?
       AND ABS(total_order - ?) < 0.5
       AND order_created_at > NOW() - INTERVAL 2 HOUR
     LIMIT 1`,
    {
      replacements: [id_configuracion, `%${phone9}%`, Number(total) || 0],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

async function yaSeEnvioPendienteConfirmacion({
  id_configuracion,
  phone_normalizado,
}) {
  if (!phone_normalizado) return false;
  const phone9 = phone_normalizado.slice(-9);

  const [row] = await db.query(
    `SELECT id, source FROM dropi_plantillas_enviadas
     WHERE id_configuracion = ?
       AND estado_dropi = 'PENDIENTE CONFIRMACION'
       AND (phone = ? OR phone LIKE ?)
       AND sent_at > NOW() - INTERVAL 24 HOUR
     LIMIT 1`,
    {
      replacements: [id_configuracion, phone_normalizado, `%${phone9}`],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/* ═══════════════════════════════════════════════════════════
   Cliente: buscar o crear
   ═══════════════════════════════════════════════════════════ */

async function resolverCliente({
  id_configuracion,
  phone_normalizado,
  nombre,
  apellido,
  phone_number_id,
}) {
  const phone9 = phone_normalizado.slice(-9);

  const [clienteRow] = await db.query(
    `SELECT id FROM clientes_chat_center
     WHERE id_configuracion = ? AND deleted_at IS NULL
       AND (REPLACE(celular_cliente, ' ', '') = ? 
            OR telefono_limpio = ? 
            OR celular_cliente LIKE ?)
     ORDER BY id DESC LIMIT 1`,
    {
      replacements: [
        id_configuracion,
        phone_normalizado,
        phone_normalizado,
        `%${phone9}`,
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  if (clienteRow?.id) return clienteRow.id;

  const [insertResult] = await db.query(
    `INSERT INTO clientes_chat_center
       (id_configuracion, uid_cliente, nombre_cliente, apellido_cliente,
        celular_cliente, telefono_limpio, source)
     VALUES (?, ?, ?, ?, ?, ?, 'wa')`,
    {
      replacements: [
        id_configuracion,
        phone_number_id,
        nombre || '',
        apellido || '',
        phone_normalizado,
        phone_normalizado,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  return insertResult;
}

/* ═══════════════════════════════════════════════════════════
   Lecturas BD
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

async function getPlantillaPendienteConfirmacion(id_configuracion) {
  const [row] = await db.query(
    `SELECT nombre_template, language_code, parametros_json, body_text, columna_destino
     FROM dropi_plantillas_config
     WHERE id_configuracion = ?
       AND estado_dropi = 'PENDIENTE CONFIRMACION'
       AND activo = 1
       AND nombre_template IS NOT NULL
       AND nombre_template != ''
     ORDER BY id DESC
     LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

async function getColumnaPrincipalDropi(id_configuracion) {
  const [dropiCol] = await db.query(
    `SELECT estado_db FROM kanban_columnas
     WHERE id_configuracion = ? AND es_dropi_principal = 1 LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (dropiCol?.estado_db) return dropiCol.estado_db;

  const [principalCol] = await db.query(
    `SELECT estado_db FROM kanban_columnas
     WHERE id_configuracion = ? AND es_principal = 1 LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return principalCol?.estado_db || null;
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
   Registros post-envío (solo si Meta respondió OK)
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
       VALUES (?, ?, ?, 'template', 1, ?, 'Shopify Confirmación', ?,
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
  } catch (_) {}
}

async function registrarDedupe({
  id_configuracion,
  shopify_order_id,
  phone_normalizado,
  template_name,
  wamid,
}) {
  try {
    await db.query(
      `INSERT IGNORE INTO dropi_plantillas_enviadas
         (dropi_order_id, id_configuracion, estado_dropi, phone,
          template_name, wa_message_id, source, shopify_order_id)
       VALUES (?, ?, 'PENDIENTE CONFIRMACION', ?, ?, ?, 'shopify_webhook', ?)`,
      {
        replacements: [
          shopify_order_id,
          id_configuracion,
          phone_normalizado,
          template_name,
          wamid,
          shopify_order_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (_) {}
}

async function actualizarColumnaKanban({
  id_configuracion,
  id_cliente,
  columnaDestino,
}) {
  if (!columnaDestino || !id_cliente) return;
  try {
    await db.query(
      `UPDATE clientes_chat_center
         SET estado_contacto = ?
       WHERE id = ? AND id_configuracion = ?`,
      {
        replacements: [columnaDestino, id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════
   FUNCIÓN PRINCIPAL
   
   Recibe el `order` completo del webhook + datos básicos.
   Se encarga de TODO internamente: extraer datos, crear cliente,
   verificaciones, envío, registros.
   
   Retorna:
   { procesado: false, motivo }            → no se intentó
   { procesado: true, enviado: true, wamid }  → éxito
   { procesado: true, enviado: false, error } → falló Meta (cron Dropi reintentará)
   ═══════════════════════════════════════════════════════════ */

async function procesarPedidoShopify({
  id_configuracion,
  phone_normalizado,
  order,
}) {
  if (!id_configuracion || !phone_normalizado || !order) {
    return { procesado: false, motivo: 'datos_incompletos' };
  }

  // 1️⃣ ¿Ya está en Dropi?
  const enDropi = await existeEnDropiCache({
    id_configuracion,
    phone_normalizado,
    total: order.total_price,
  });
  if (enDropi) return { procesado: false, motivo: 'ya_en_dropi' };

  // 2️⃣ ¿Ya se mandó?
  const yaEnviado = await yaSeEnvioPendienteConfirmacion({
    id_configuracion,
    phone_normalizado,
  });
  if (yaEnviado) return { procesado: false, motivo: 'ya_enviado_dedupe' };

  // 3️⃣ Plantilla + creds
  const plantilla = await getPlantillaPendienteConfirmacion(id_configuracion);
  if (!plantilla) return { procesado: false, motivo: 'sin_plantilla' };

  const creds = await getWaCredentials(id_configuracion);
  if (!creds?.phone_number_id || !creds?.waba_token) {
    return { procesado: false, motivo: 'sin_creds_wa' };
  }

  // 4️⃣ Buscar/crear cliente
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || {};
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  const nombre =
    customer.first_name || shipping.first_name || billing.first_name || '';
  const apellido =
    customer.last_name || shipping.last_name || billing.last_name || '';

  const id_cliente = await resolverCliente({
    id_configuracion,
    phone_normalizado,
    nombre,
    apellido,
    phone_number_id: creds.phone_number_id,
  });

  // 5️⃣ Construir y enviar
  const ctx = {
    order,
    shipping,
    billing,
    customer,
    lineItems,
    phone_normalizado,
  };
  const components = buildTemplateComponents(plantilla.parametros_json, ctx);

  let result;
  try {
    result = await enviarTemplate({
      phone_number_id: creds.phone_number_id,
      waba_token: creds.waba_token,
      phoneNorm: phone_normalizado,
      templateName: plantilla.nombre_template,
      languageCode: plantilla.language_code || 'es',
      components,
    });
  } catch (err) {
    const metaError =
      err?.response?.data?.error?.message ||
      err?.response?.data?.error?.error_user_msg ||
      err.message;
    // ❌ NO registramos nada → cron Dropi reintentará cuando sincronice
    return { procesado: true, enviado: false, error: metaError };
  }

  // 6️⃣ ÉXITO → registrar todo
  const bodyInterpolado = interpolarBodyText(plantilla.body_text, components);

  await registrarMensajeEnChat({
    id_configuracion,
    phone_number_id: creds.phone_number_id,
    id_cliente,
    phoneNorm: phone_normalizado,
    textoMensaje: bodyInterpolado || plantilla.nombre_template,
    templateName: plantilla.nombre_template,
    languageCode: plantilla.language_code,
    waMessageId: result.wamid,
    jsonMensaje: result.payload,
  });

  await registrarDedupe({
    id_configuracion,
    shopify_order_id: order.id,
    phone_normalizado,
    template_name: plantilla.nombre_template,
    wamid: result.wamid,
  });

  // Columna kanban (igual que cron Dropi: usa colDropiPrincipal)
  const colDropiPrincipal = await getColumnaPrincipalDropi(id_configuracion);
  await actualizarColumnaKanban({
    id_configuracion,
    id_cliente,
    columnaDestino: colDropiPrincipal,
  });

  return { procesado: true, enviado: true, wamid: result.wamid };
}

module.exports = { procesarPedidoShopify };
