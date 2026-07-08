'use strict';

/**
 * services/dropi_notifier.service.js
 *
 * Lógica COMPARTIDA de notificaciones de estados Dropi.
 * Extraída de cron/syncDropiOrdersHourly.js (v7) SIN cambios de
 * comportamiento, para que el webhook de Dropi (tiempo real) y el cron
 * (red de seguridad) envíen los mismos templates sin duplicar código.
 *
 * Consumidores:
 *  - cron/syncDropiOrdersHourly.js        → upsertOrders + procesarTemplates
 *  - services/dropi_webhook_processor.service.js → ídem, por evento webhook
 *
 * Anti-duplicados cron↔webhook: reclamarEnvio() es atómico gracias al
 * UNIQUE uk_order_config_estado (dropi_order_id, id_configuracion,
 * estado_dropi) en dropi_plantillas_enviadas. Aunque ambos flujos procesen
 * la misma orden en paralelo, solo uno gana el derecho a enviar.
 */

const axios = require('axios');

const { db } = require('../database/config');
const DropiOrdersCache = require('../models/dropi_orders_cache.model');
// Normalización de teléfonos con libphonenumber (multipaís).
// toWhatsapp(phone, country_code) → internacional en dígitos, sin "+".
const { toWhatsapp } = require('../utils/phoneFactor');

/* ═══════════════════════════════════════════════════════════
   Constantes
   ═══════════════════════════════════════════════════════════ */

const DELAY_BETWEEN_WA_SENDS = 800;
const META_API_VERSION = process.env.GRAPH_VERSION;

const SIEMPRE_TEMPLATE = new Set(['PENDIENTE CONFIRMACION']);
const VENTANA_HORAS = 23;
const COLUMNA_ENTREGADA_DEFAULT = 'entregada';

/* ═══════════════════════════════════════════════════════════
   Mapeo: raw status Dropi → estado en dropi_plantillas_config
   ═══════════════════════════════════════════════════════════ */

function mapDropiStatusToEstadoConfig(rawStatus) {
  const s = String(rawStatus || '')
    .trim()
    .toUpperCase();

  if (s === 'PENDIENTE CONFIRMACION') return 'PENDIENTE CONFIRMACION';
  if (s === 'PENDIENTE') return 'PENDIENTE';
  if (s === 'GUIA_GENERADA') return 'GUIA GENERADA';

  if (
    s === 'CANCELADO' ||
    s.includes('CANCELADA') ||
    s === 'ANULADA' ||
    s === 'RECHAZADO' ||
    s === 'GUIA_ANULADA'
  )
    return 'CANCELADO';

  if (
    s.includes('RETIRO EN AGENCIA') ||
    s.includes('ENVÍO LISTO EN OFICINA') ||
    s === 'ENVIO LISTO EN OFICINA'
  )
    return 'RETIRO EN AGENCIA';

  if (
    s === 'ENTREGADO' ||
    s.includes('ENTREGADA') ||
    s === 'REPORTADO ENTREGADO' ||
    s.includes('REPORTADO ENTREGADO') ||
    s === 'ENTREGA DIGITALIZADA' ||
    s === 'CERTIFICACION DE PRUEBA DE ENTREGA'
  )
    return 'ENTREGADA';

  if (
    s.includes('DEVOLUCION') ||
    s.includes('DEVOLUCIÓN') ||
    s === 'DEVUELTO' ||
    s === 'CERTIFICACION DEVOLUCION AL REMITENTE' ||
    s === 'DESAPLICADO'
  )
    return 'DEVOLUCION';

  if (
    s.includes('NOVEDAD') ||
    s.includes('SOLUCION') ||
    s.includes('SOLUCIÓN') ||
    s === 'CON NOVEDAD' ||
    s === 'DESTINATARIO FALLECIDO' ||
    s.includes('DESTINATARIO RE-PROGRAMA') ||
    s.includes('DESTINATARIO SOLICITA') ||
    s.includes('DESTINATARIO INDICA') ||
    s.includes('FUERA DE COBERTURA') ||
    s.includes('OBSTRUCCIÓN EN LA VÍA') ||
    s.includes('PROBLEMAS DE ORDEN') ||
    s.includes('VISITA A DESTINATARIO') ||
    s.includes('ACCIDENTE EN CARRETERA') ||
    s.includes('EN ESPERA DE FIRMA') ||
    s.includes('INCONFORME')
  )
    return 'NOVEDAD';

  if (
    s === 'EN REPARTO' ||
    s === 'ZONA DE ENTREGA' ||
    s === 'EN DISTRIBUCION A CLIENTE' ||
    s === 'EN DISTRIBUCIÓN A CLIENTE' ||
    s.includes('EN DISTRIBUCION A') ||
    s.includes('EN DISTRIBUCIÓN A') ||
    s === 'EN CAMINO' ||
    s.includes('SALIDA A REPARTO') ||
    s.includes('REPARTIDOR ASIGNADO')
  )
    return 'EN TRANSITO';

  return null;
}

/* ═══════════════════════════════════════════════════════════
   classifyDropiStatus (para cache)
   ═══════════════════════════════════════════════════════════ */

function classifyDropiStatus(status) {
  const s = String(status || '')
    .trim()
    .toUpperCase();

  if (
    s === 'ENTREGADO' ||
    s.includes('ENTREGADA') ||
    s === 'REPORTADO ENTREGADO' ||
    s.includes('REPORTADO ENTREGADO') ||
    s === 'ENTREGA DIGITALIZADA' ||
    s === 'CERTIFICACION DE PRUEBA DE ENTREGA'
  )
    return 'entregada';

  if (
    s.includes('DEVOLUCION') ||
    s.includes('DEVOLUCIÓN') ||
    s === 'DEVUELTO' ||
    s === 'CERTIFICACION DEVOLUCION AL REMITENTE' ||
    s === 'DESAPLICADO'
  )
    return 'devolucion';

  if (
    s === 'CANCELADO' ||
    s.includes('CANCELADA') ||
    s === 'ANULADA' ||
    s === 'RECHAZADO' ||
    s === 'GUIA_ANULADA'
  )
    return 'cancelada';

  if (s === 'PENDIENTE' || s === 'PENDIENTE CONFIRMACION') return 'pendiente';

  if (
    s.includes('RETIRO EN AGENCIA') ||
    s.includes('ENVÍO LISTO EN OFICINA') ||
    s === 'ENVIO LISTO EN OFICINA'
  )
    return 'retiro_agencia';

  if (
    s.includes('NOVEDAD') ||
    s.includes('SOLUCION') ||
    s.includes('SOLUCIÓN') ||
    s === 'CON NOVEDAD' ||
    s === 'DESTINATARIO FALLECIDO' ||
    s.includes('DESTINATARIO RE-PROGRAMA') ||
    s.includes('DESTINATARIO SOLICITA') ||
    s.includes('DESTINATARIO INDICA') ||
    s.includes('FUERA DE COBERTURA') ||
    s.includes('OBSTRUCCIÓN EN LA VÍA') ||
    s.includes('PROBLEMAS DE ORDEN') ||
    s.includes('VISITA A DESTINATARIO') ||
    s.includes('ACCIDENTE EN CARRETERA') ||
    s.includes('EN ESPERA DE FIRMA') ||
    s.includes('INCONFORME')
  )
    return 'novedad';

  if (
    s.includes('INDEMNIZ') ||
    s.includes('SINIESTRO') ||
    s.includes('INCAUTADO') ||
    s.includes('HURTAD') ||
    s.includes('AVERÍA')
  )
    return 'indemnizada';

  if (s === 'GUIA_GENERADA') return 'guia_generada';

  if (
    s === 'EN REPARTO' ||
    s === 'ZONA DE ENTREGA' ||
    s === 'EN DISTRIBUCION A CLIENTE' ||
    s === 'EN DISTRIBUCIÓN A CLIENTE' ||
    s.includes('EN DISTRIBUCION A') ||
    s.includes('EN DISTRIBUCIÓN A') ||
    s === 'EN CAMINO' ||
    s.includes('SALIDA A REPARTO') ||
    s.includes('REPARTIDOR ASIGNADO')
  )
    return 'en_reparto';

  if (
    s.includes('TRÁNSITO') ||
    s.includes('TRANSITO') ||
    s.includes('EN RUTA') ||
    s.includes('BODEGA') ||
    s.includes('EMBARCANDO') ||
    s.includes('RECOLECT') ||
    s.includes('RECOGIDO') ||
    s.includes('ASIGNADO') ||
    s.includes('PICKING') ||
    s.includes('PACKING') ||
    s.includes('GENERADO') ||
    s.includes('GENERADA') ||
    s.includes('PREPARADO') ||
    s.includes('INVENTARIO') ||
    s.includes('INGRES') ||
    s.includes('RECIBIDO') ||
    s === 'POR RECOLECTAR' ||
    s === 'PROCESAMIENTO'
  )
    return 'en_transito';

  return 'otro';
}

/* ═══════════════════════════════════════════════════════════
   Helpers generales
   ═══════════════════════════════════════════════════════════ */

/**
 * Internacional para WhatsApp (sin "+"), según el país de la integración.
 * Delega en libphonenumber (toWhatsapp). Si no se pasa countryCode, asume EC,
 * idéntico al comportamiento histórico (962803007 → 593962803007).
 */
function normalizePhone(phone, countryCode = 'EC') {
  return toWhatsapp(phone, countryCode) || null;
}

function safeJsonParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch (_) {
    return fallback;
  }
}

/* ═══════════════════════════════════════════════════════════
   Tracking URL / Guía PDF
   ═══════════════════════════════════════════════════════════ */

function getTrackingUrl(shippingCompany, guide) {
  if (!guide) return '';
  const comp = String(shippingCompany || '').toUpperCase();
  const g = String(guide).trim();
  if (
    comp.includes('LAAR') ||
    g.startsWith('LC') ||
    g.startsWith('IMP') ||
    g.startsWith('MKP')
  )
    return `https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=${encodeURIComponent(g)}`;
  if (comp.includes('GINTRACOM') || g.startsWith('D0') || g.startsWith('I0'))
    return `https://ec.gintracom.site/web/site/tracking?guia=${encodeURIComponent(g)}`;
  if (comp.includes('VELOCES') || g.startsWith('V'))
    return `https://tracking.veloces.app/tracking-client/${encodeURIComponent(g)}`;
  if (comp.includes('URBANO') || g.startsWith('WYB'))
    return `https://app.urbano.com.ec/plugin/etracking/etracking/?guia=${encodeURIComponent(g)}`;
  if (comp.includes('SERVIENTREGA'))
    return `https://www.servientrega.com.ec/Tracking/?guia=${encodeURIComponent(g)}&tipo=GUIA`;
  return '';
}

/**
 * Fallback para el flujo WEBHOOK: el payload del webhook de Dropi NUNCA
 * trae guia_urls3, pero sí sticker + country + shipping_company, y el path
 * S3 real siempre es `<pais>/guias/<transportadora>/<sticker>` (verificado
 * contra 5000 órdenes reales de 7 días: servientrega, gintracom,
 * laarcourier, veloces, urbano, quality-post y tiui, en EC y MX; 0 fallos).
 *
 * Se reconstruye SOLO si los 3 campos pasan validación estricta; ante
 * cualquier cosa rara se devuelve '' (misma degradación que hoy cuando la
 * orden aún no tiene guía: la variable va vacía).
 */
function reconstructGuiaPdfPath(order) {
  const sticker = String(order?.sticker || '').trim();
  const country = String(order?.country || '').trim();
  const company = String(order?.shipping_company || '').trim();
  if (!sticker || !country || !company) return '';

  // El sticker es un nombre de archivo PDF plano (sin rutas embebidas)
  if (!/\.pdf$/i.test(sticker) || /[/\\]/.test(sticker)) return '';

  // minúsculas + sin tildes (MÉXICO → mexico), igual que el path S3 real
  const norm = (s) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

  const paisSeg = norm(country);
  const compSeg = norm(company);

  // Segmentos de path válidos observados: solo letras para el país
  // (ecuador, mexico) y letras/números/guiones para la transportadora
  // (servientrega, quality-post). Cualquier otro formato → no reconstruir.
  if (!/^[a-z]+$/.test(paisSeg)) return '';
  if (!/^[a-z0-9-]+$/.test(compSeg)) return '';

  return `${paisSeg}/guias/${compSeg}/${sticker}`;
}

function getGuiaPdfUrl(order) {
  const guiaPath = order.guia_urls3;
  // Sin guia_urls3 (payload de webhook): intentar reconstrucción segura
  if (!guiaPath) return reconstructGuiaPdfPath(order);
  const CF_PREFIX = 'https://d39ru7awumhhs2.cloudfront.net/';
  if (guiaPath.startsWith(CF_PREFIX)) return guiaPath.replace(CF_PREFIX, '');
  return guiaPath;
}

/* ═══════════════════════════════════════════════════════════
   Resolver variable de template desde la orden Dropi
   ═══════════════════════════════════════════════════════════ */

function resolveVariable(varName, order) {
  const details = Array.isArray(order.orderdetails) ? order.orderdetails : [];

  switch (varName) {
    case 'nombre':
      return `${order.name || ''} ${order.surname || ''}`.trim() || 'Cliente';
    case 'contenido':
      if (!details.length) return 'Tu pedido';
      return details
        .map((d) => `${d?.quantity || 1} x ${d?.product?.name || 'Producto'}`)
        .join(', ');
    case 'direccion':
      return order.dir || 'Dirección no disponible';
    case 'costo':
      return String(order.total_order || '0');
    case 'ciudad':
      return order.city || '';
    case 'provincia':
      return order.state || '';
    case 'numero_guia':
      return order.shipping_guide || '';
    case 'transportadora':
      return order.shipping_company || '';
    case 'tracking':
      return getTrackingUrl(order.shipping_company, order.shipping_guide);
    case 'guia_pdf':
      return getGuiaPdfUrl(order);
    case 'order_id':
      return String(order.id || '');
    case 'telefono':
      return order.phone || '';
    default:
      return '';
  }
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

function buildRutaArchivo(order, estadoConfig) {
  const details = Array.isArray(order.orderdetails) ? order.orderdetails : [];
  return {
    nombre: `${order.name || ''} ${order.surname || ''}`.trim(),
    direccion: order.dir || '',
    email: '',
    celular: order.phone || '',
    order_id: String(order.id || ''),
    contenido: details
      .map((d) => ` ${d?.quantity || 1} x ${d?.product?.name || 'Producto'} `)
      .join(','),
    costo: String(order.total_order || '0'),
    ciudad: order.city || '',
    tracking: getTrackingUrl(order.shipping_company, order.shipping_guide),
    transportadora: order.shipping_company || '',
    numero_guia: order.shipping_guide || '',
    estado_notificacion: estadoConfig,
    source: 'wa',
  };
}

function buildTemplateComponents(parametrosJson, order) {
  const config = safeJsonParse(parametrosJson, null);
  if (!config) return [];
  const components = [];
  if (Array.isArray(config.body) && config.body.length > 0) {
    components.push({
      type: 'body',
      parameters: config.body.map((varName) => ({
        type: 'text',
        text: resolveVariable(varName, order) || '',
      })),
    });
  }
  if (Array.isArray(config.buttons) && config.buttons.length > 0) {
    for (const btn of config.buttons) {
      const idx = btn.index != null ? btn.index : 0;
      const value = resolveVariable(btn.variable || '', order) || '';
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
   Upsert órdenes al cache
   ═══════════════════════════════════════════════════════════ */

async function upsertOrders(cacheInsertFields, orders) {
  if (!orders.length) return;
  const bulk = orders.map((o) => {
    const details = Array.isArray(o.orderdetails) ? o.orderdetails : [];
    const productNames = details.map((d) => d?.product?.name).filter(Boolean);
    return {
      dropi_order_id: o.id,
      ...cacheInsertFields,
      status: o.status || null,
      classified_status: classifyDropiStatus(o.status),
      total_order: Number(o.total_order || 0),
      name: o.name || null,
      surname: o.surname || null,
      phone: o.phone || null,
      city: o.city || null,
      shipping_company: o.shipping_company || null,
      shipping_guide: o.shipping_guide || null,
      product_names: JSON.stringify(productNames),
      order_created_at: o.created_at || null,
      order_data: JSON.stringify(o),
      synced_at: new Date(),
      // shop: origen de la orden (IMPORSUIT/SHOPIFY/null). Antes no se
      // persistían y quedaban NULL aunque el JSON sí los traía.
      shop_id: o.shop_id ?? o.shop?.id ?? null,
      shop_type: o.shop?.type ?? null,
      shop_name: o.shop?.name ?? null,
    };
  });
  for (let i = 0; i < bulk.length; i += 200) {
    await DropiOrdersCache.bulkCreate(bulk.slice(i, i + 200), {
      updateOnDuplicate: [
        'status',
        'classified_status',
        'total_order',
        'name',
        'surname',
        'phone',
        'city',
        'shipping_company',
        'shipping_guide',
        'product_names',
        'order_data',
        'synced_at',
        'shop_id',
        'shop_type',
        'shop_name',
      ],
    });
  }
}

/* ═══════════════════════════════════════════════════════════
   Credenciales WA / plantillas / kanban
   ═══════════════════════════════════════════════════════════ */

async function getWaCredentials(id_configuracion) {
  const [row] = await db.query(
    `SELECT id_telefono AS phone_number_id, token AS waba_token, telefono
     FROM configuraciones WHERE id = ? AND id_telefono IS NOT NULL AND token IS NOT NULL LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

async function getPlantillasActivas(id_configuracion) {
  const rows = await db.query(
    `SELECT estado_dropi, nombre_template, language_code,
            mensaje_rapido, usar_respuesta_rapida, parametros_json, body_text,
            columna_destino
     FROM dropi_plantillas_config
     WHERE id_configuracion = ? AND activo = 1
       AND (
         (nombre_template IS NOT NULL AND nombre_template != '')
         OR (columna_destino IS NOT NULL AND columna_destino != '')
       )`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const map = {};
  for (const r of rows) {
    const nombreTemplate = r.nombre_template || null;
    map[r.estado_dropi] = {
      nombre_template: nombreTemplate,
      language_code: r.language_code || 'es',
      mensaje_rapido: r.mensaje_rapido || null,
      usar_respuesta_rapida: !!r.usar_respuesta_rapida,
      parametros_json: r.parametros_json || null,
      body_text: r.body_text || null,
      columna_destino: r.columna_destino || null,
      // Estado configurado para SOLO reubicar al cliente en el kanban cuando
      // Dropi notifica, sin enviar ningún mensaje (plantilla ni resp. rápida).
      solo_mover: !nombreTemplate && !!r.columna_destino,
    };
  }
  return map;
}

async function getColumnaPrincipalDropi(id_configuracion) {
  const [dropiCol] = await db.query(
    `SELECT id, estado_db, 'dropi' AS tipo FROM kanban_columnas
     WHERE id_configuracion = ? AND es_dropi_principal = 1 LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (dropiCol) return dropiCol;

  const [principalCol] = await db.query(
    `SELECT id, estado_db, 'principal' AS tipo FROM kanban_columnas
     WHERE id_configuracion = ? AND es_principal = 1 LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (principalCol) return principalCol;
  return null;
}

async function actualizarEstadoContactoEntregado({
  id_configuracion,
  telefono,
  columnaDestino,
  country_code = 'EC',
}) {
  const phoneNorm = normalizePhone(telefono, country_code);
  if (!phoneNorm || !columnaDestino || !id_configuracion) return false;
  try {
    const [, meta] = await db.query(
      `UPDATE clientes_chat_center
         SET estado_contacto = ?
       WHERE id_configuracion = ?
         AND deleted_at IS NULL
         AND (estado_contacto IS NULL OR estado_contacto != ?)
         AND (REPLACE(celular_cliente, ' ', '') = ?
              OR telefono_limpio = ?
              OR celular_cliente LIKE ?)`,
      {
        replacements: [
          columnaDestino,
          id_configuracion,
          columnaDestino,
          phoneNorm,
          phoneNorm,
          `%${phoneNorm.slice(-9)}`,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    const affected = meta?.affectedRows ?? meta ?? 0;
    return affected > 0;
  } catch (err) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════
   Dedupe de envíos (dropi_plantillas_enviadas)
   ═══════════════════════════════════════════════════════════ */

async function yaFueEnviado(dropi_order_id, id_configuracion, estado_dropi) {
  const [row] = await db.query(
    `SELECT id FROM dropi_plantillas_enviadas
     WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ? LIMIT 1`,
    {
      replacements: [dropi_order_id, id_configuracion, estado_dropi],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/* Dedupe cross-system para PENDIENTE CONFIRMACION
   Verifica si ya se envió por phone en últimas 24h
   (ya sea desde Shopify webhook o desde Dropi cron previo) */
async function yaSeEnvioPendienteConfPorPhone(
  id_configuracion,
  phone,
  country_code = 'EC',
) {
  if (!phone) return false;
  const phoneNorm = normalizePhone(phone, country_code);
  if (!phoneNorm) return false;
  const phone9 = phoneNorm.slice(-9);

  const [row] = await db.query(
    `SELECT id, source FROM dropi_plantillas_enviadas
     WHERE id_configuracion = ?
       AND estado_dropi = 'PENDIENTE CONFIRMACION'
       AND (phone = ? OR phone LIKE ?)
       AND sent_at > NOW() - INTERVAL 24 HOUR
     LIMIT 1`,
    {
      replacements: [id_configuracion, phoneNorm, `%${phone9}`],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/* Reclama el envío ANTES de mandar el mensaje. Atómico gracias al UNIQUE
   uk_order_config_estado (dropi_order_id, id_configuracion, estado_dropi).
   Devuelve true si ESTA corrida ganó el derecho a enviar; false si ya estaba
   reclamado/enviado por otra corrida (→ no reenviar).
   Cierra el hueco de duplicados: aunque fallen las escrituras DB POST-envío,
   el registro anti-duplicado ya existe, así que nunca se reenvía. */
async function reclamarEnvio({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
  phone,
  template_name,
}) {
  const [res] = await db.query(
    `INSERT IGNORE INTO dropi_plantillas_enviadas
       (dropi_order_id, id_configuracion, estado_dropi, phone, template_name)
     VALUES (?, ?, ?, ?, ?)`,
    {
      replacements: [
        dropi_order_id,
        id_configuracion,
        estado_dropi,
        phone || null,
        template_name || null,
      ],
    },
  );
  // mysql2 ResultSetHeader: affectedRows=1 → insertó (reclamó);
  // 0 → ya existía (INSERT IGNORE lo ignoró) → NO reenviar.
  return Number(res?.affectedRows || 0) === 1;
}

/* Libera el reclamo SOLO si el envío a Meta falló, para reintentar luego. */
async function liberarEnvio({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
}) {
  await db.query(
    `DELETE FROM dropi_plantillas_enviadas
     WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?`,
    {
      replacements: [dropi_order_id, id_configuracion, estado_dropi],
      type: db.QueryTypes.DELETE,
    },
  );
}

/* Completa wa_message_id/template_name del reclamo tras un envío exitoso.
   Best-effort: si falla, no pasa nada (el mensaje ya salió y está marcado). */
async function completarEnvio({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
  template_name,
  wa_message_id,
}) {
  await db.query(
    `UPDATE dropi_plantillas_enviadas
     SET wa_message_id = ?, template_name = ?
     WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?`,
    {
      replacements: [
        wa_message_id || null,
        template_name || null,
        dropi_order_id,
        id_configuracion,
        estado_dropi,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
}

/* ═══════════════════════════════════════════════════════════
   Clientes / mensajes del chat center
   ═══════════════════════════════════════════════════════════ */

async function resolverClientes({
  id_configuracion,
  phoneNorm,
  phone_number_id,
  telefonoConfig,
}) {
  const [clienteRow] = await db.query(
    `SELECT id FROM clientes_chat_center
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

  let clienteId = clienteRow?.id || null;

  if (!clienteId) {
    const [insertResult] = await db.query(
      `INSERT INTO clientes_chat_center
         (id_configuracion, uid_cliente, nombre_cliente, apellido_cliente,
          celular_cliente, telefono_limpio, source)
       VALUES (?, ?, '', '', ?, ?, 'wa')`,
      {
        replacements: [id_configuracion, phone_number_id, phoneNorm, phoneNorm],
        type: db.QueryTypes.INSERT,
      },
    );
    clienteId = insertResult;
  }

  let idClienteConfig = null;
  if (telefonoConfig) {
    const telCfgLimpio = String(telefonoConfig).replace(/\D/g, '');
    if (telCfgLimpio) {
      const [cfgRow] = await db.query(
        `SELECT id FROM clientes_chat_center
         WHERE id_configuracion = ?
           AND (REPLACE(celular_cliente, ' ', '') = ? OR telefono_limpio = ?)
         LIMIT 1`,
        {
          replacements: [id_configuracion, telCfgLimpio, telCfgLimpio],
          type: db.QueryTypes.SELECT,
        },
      );
      idClienteConfig = cfgRow?.id || null;
    }
  }

  return { clienteId, idClienteConfig };
}

async function registrarMensajeEnChat({
  id_configuracion,
  phone_number_id,
  clienteId,
  idClienteConfig,
  phoneNorm,
  tipoEnvio,
  textoMensaje,
  templateName,
  languageCode,
  waMessageId,
  rutaArchivo,
  jsonMensaje,
}) {
  try {
    await db.query(
      `INSERT INTO mensajes_clientes
         (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje, rol_mensaje,
          celular_recibe, responsable, texto_mensaje, ruta_archivo,
          json_mensaje, visto, uid_whatsapp, id_wamid_mensaje,
          template_name, language_code, informacion_suficiente)
       VALUES (?, ?, ?, ?, 1, ?, 'Dropi Status', ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
      {
        replacements: [
          id_configuracion,
          idClienteConfig || clienteId,
          phone_number_id,
          tipoEnvio === 'template' ? 'template' : 'text',
          clienteId,
          textoMensaje || '',
          rutaArchivo ? JSON.stringify(rutaArchivo) : null,
          jsonMensaje ? JSON.stringify(jsonMensaje) : null,
          phoneNorm,
          waMessageId || null,
          tipoEnvio === 'template' ? templateName || null : null,
          tipoEnvio === 'template' ? languageCode || null : null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (err) {}
}

async function verificarVentana24h(id_configuracion, phoneNorm) {
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

/* ═══════════════════════════════════════════════════════════
   Envío a Meta (WhatsApp Cloud API)
   ═══════════════════════════════════════════════════════════ */

function isWindowClosedError(err) {
  const c = err?.response?.data?.error?.code;
  const sc = err?.response?.data?.error?.error_subcode;
  return c === 131047 || sc === 131047 || c === 131026;
}

function isMetaRateLimit(err) {
  const s = err?.response?.status;
  const c = err?.response?.data?.error?.code;
  return s === 429 || c === 130429 || c === 80008;
}

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
  if (components && components.length > 0)
    payload.template.components = components;
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

async function enviarRespuestaRapida({
  phone_number_id,
  waba_token,
  phoneNorm,
  mensaje,
}) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNorm,
    type: 'text',
    text: { body: mensaje },
  };
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
   Procesar templates para un lote de órdenes
   ═══════════════════════════════════════════════════════════ */

async function procesarTemplates({
  orders,
  id_configuracion,
  country_code = 'EC',
}) {
  if (!orders.length)
    return { enviados: 0, omitidos: 0, errores: 0, entregadas_actualizadas: 0 };

  const plantillas = await getPlantillasActivas(id_configuracion);
  const creds = await getWaCredentials(id_configuracion);
  const credsValidas = !!(creds?.phone_number_id && creds?.waba_token);
  const telefonoConfig = creds?.telefono || null;

  const colDropiPrincipal = credsValidas
    ? await getColumnaPrincipalDropi(id_configuracion)
    : null;

  let enviados = 0,
    omitidos = 0,
    errores = 0,
    entregadasActualizadas = 0;

  for (const order of orders) {
    try {
      const estadoConfig = mapDropiStatusToEstadoConfig(order.status);

      if (estadoConfig === 'ENTREGADA' && order.phone) {
        const columnaEntregada =
          plantillas[estadoConfig]?.columna_destino ||
          COLUMNA_ENTREGADA_DEFAULT;
        const actualizado = await actualizarEstadoContactoEntregado({
          id_configuracion,
          telefono: order.phone,
          columnaDestino: columnaEntregada,
          country_code,
        });
        if (actualizado) entregadasActualizadas++;
      }

      // ── SOLO MOVER DE COLUMNA (sin plantilla) ──
      // Estados que el cliente configuró únicamente para reubicar el contacto
      // en el kanban cuando Dropi notifica, SIN enviar ningún mensaje. No pasa
      // por el path de envío (ni WA creds, ni reclamo, ni template).
      const cfgEstado = estadoConfig ? plantillas[estadoConfig] : null;
      if (cfgEstado?.solo_mover) {
        // ENTREGADA ya se reubicó en el bloque de arriba; el resto se mueve aquí.
        if (estadoConfig !== 'ENTREGADA' && order.phone) {
          await actualizarEstadoContactoEntregado({
            id_configuracion,
            telefono: order.phone,
            columnaDestino: cfgEstado.columna_destino,
            country_code,
          });
        }
        omitidos++;
        continue;
      }

      if (!credsValidas) {
        omitidos++;
        continue;
      }
      if (!estadoConfig) {
        omitidos++;
        continue;
      }
      if (!plantillas[estadoConfig]) {
        omitidos++;
        continue;
      }
      if (!order.phone) {
        omitidos++;
        continue;
      }

      // Skip barato si ya se envió (evita armar payloads). La barrera REAL
      // contra duplicados es el reclamo atómico de más abajo.
      if (await yaFueEnviado(order.id, id_configuracion, estadoConfig)) {
        omitidos++;
        continue;
      }

      // Cross-system dedupe: si Shopify (u otra corrida) ya mandó, no duplicamos
      if (estadoConfig === 'PENDIENTE CONFIRMACION') {
        const yaShopify = await yaSeEnvioPendienteConfPorPhone(
          id_configuracion,
          order.phone,
          country_code,
        );
        if (yaShopify) {
          omitidos++;
          continue;
        }
      }

      const config = plantillas[estadoConfig];
      const phoneNorm = normalizePhone(order.phone, country_code);
      if (!phoneNorm) {
        omitidos++;
        continue;
      }

      // ── RECLAMO ANTES DE ENVIAR (atómico vía UNIQUE uk_order_config_estado).
      // Si otra corrida ya reclamó/envió → affectedRows=0 → no reenviamos.
      // Clave del fix: aunque fallen las escrituras DB POST-envío, el registro
      // anti-duplicado ya quedó y la orden nunca se reenvía.
      const reclamado = await reclamarEnvio({
        dropi_order_id: order.id,
        id_configuracion,
        estado_dropi: estadoConfig,
        phone: order.phone,
        template_name: config.nombre_template,
      });
      if (!reclamado) {
        omitidos++;
        continue;
      }

      let clienteId = null;
      let idClienteConfig = null;
      let tipoEnvio = 'template';
      let waMessageId = null;
      let textoEnviado = config.nombre_template;
      let jsonMensajeEnviado = null;
      const components = buildTemplateComponents(config.parametros_json, order);

      // ── BLOQUE DE ENVÍO. Si algo aquí falla, el mensaje NO salió:
      // liberamos el reclamo para reintentar en la próxima corrida.
      try {
        const resolved = await resolverClientes({
          id_configuracion,
          phoneNorm,
          phone_number_id: creds.phone_number_id,
          telefonoConfig,
        });
        clienteId = resolved.clienteId;
        idClienteConfig = resolved.idClienteConfig;

        const forzarTemplate = SIEMPRE_TEMPLATE.has(estadoConfig);

        if (
          !forzarTemplate &&
          config.usar_respuesta_rapida &&
          config.mensaje_rapido
        ) {
          const ventanaAbierta = await verificarVentana24h(
            id_configuracion,
            phoneNorm,
          );
          if (ventanaAbierta) {
            try {
              const result = await enviarRespuestaRapida({
                phone_number_id: creds.phone_number_id,
                waba_token: creds.waba_token,
                phoneNorm,
                mensaje: config.mensaje_rapido,
              });
              waMessageId = result.wamid;
              jsonMensajeEnviado = result.payload;
              tipoEnvio = 'respuesta_rapida';
              textoEnviado = config.mensaje_rapido;
            } catch (rrErr) {
              if (isWindowClosedError(rrErr)) {
                tipoEnvio = 'template';
              } else {
                throw rrErr;
              }
            }
          }
        }

        if (tipoEnvio === 'template') {
          const result = await enviarTemplate({
            phone_number_id: creds.phone_number_id,
            waba_token: creds.waba_token,
            phoneNorm,
            templateName: config.nombre_template,
            languageCode: config.language_code,
            components,
          });
          waMessageId = result.wamid;
          jsonMensajeEnviado = result.payload;
          const bodyInterpolado = interpolarBodyText(
            config.body_text,
            components,
          );
          textoEnviado = bodyInterpolado || config.nombre_template;
        }
      } catch (sendErr) {
        // El envío falló → liberar el reclamo para que reintente.
        await liberarEnvio({
          dropi_order_id: order.id,
          id_configuracion,
          estado_dropi: estadoConfig,
        });
        throw sendErr;
      }

      // ✅ A partir de aquí el mensaje YA SALIÓ. El reclamo se queda.
      // Todo lo siguiente es best-effort: si falla, NO se reenvía.
      const rutaArchivo = buildRutaArchivo(order, estadoConfig);

      let columnaDestino = null;
      if (estadoConfig === 'PENDIENTE CONFIRMACION') {
        columnaDestino = colDropiPrincipal?.estado_db || null;
      } else if (estadoConfig === 'ENTREGADA') {
        columnaDestino = config.columna_destino || COLUMNA_ENTREGADA_DEFAULT;
      } else if (config.columna_destino) {
        columnaDestino = config.columna_destino;
      }

      if (columnaDestino && clienteId) {
        try {
          await db.query(
            `UPDATE clientes_chat_center
             SET estado_contacto = ?
             WHERE id = ? AND id_configuracion = ?`,
            {
              replacements: [columnaDestino, clienteId, id_configuracion],
              type: db.QueryTypes.UPDATE,
            },
          );
        } catch (err) {}
      }

      try {
        await registrarMensajeEnChat({
          id_configuracion,
          phone_number_id: creds.phone_number_id,
          clienteId,
          idClienteConfig,
          phoneNorm,
          tipoEnvio,
          textoMensaje: textoEnviado,
          templateName:
            tipoEnvio === 'template' ? config.nombre_template : null,
          languageCode: config.language_code,
          waMessageId,
          rutaArchivo,
          jsonMensaje: jsonMensajeEnviado,
        });
      } catch (err) {}

      // Completa wa_message_id/template_name del reclamo (best-effort).
      try {
        await completarEnvio({
          dropi_order_id: order.id,
          id_configuracion,
          estado_dropi: estadoConfig,
          template_name:
            tipoEnvio === 'respuesta_rapida'
              ? `[RR] ${config.mensaje_rapido.slice(0, 80)}`
              : config.nombre_template,
          wa_message_id: waMessageId,
        });
      } catch (err) {}

      enviados++;
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_WA_SENDS));
    } catch (err) {
      errores++;
      if (isMetaRateLimit(err)) await new Promise((r) => setTimeout(r, 30000));
    }
  }

  return {
    enviados,
    omitidos,
    errores,
    entregadas_actualizadas: entregadasActualizadas,
  };
}

module.exports = {
  // clasificación / mapeo
  mapDropiStatusToEstadoConfig,
  classifyDropiStatus,
  // helpers
  normalizePhone,
  safeJsonParse,
  getTrackingUrl,
  getGuiaPdfUrl,
  reconstructGuiaPdfPath,
  resolveVariable,
  buildTemplateComponents,
  // persistencia / envío
  upsertOrders,
  getPlantillasActivas,
  procesarTemplates,
};
