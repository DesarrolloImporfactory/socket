'use strict';

/**
 * cron/syncDropiOrdersHourly.js  — v6
 *
 * NUEVO EN v6:
 *  Fase 4: Profit Sync — rellena `dropshipper_profit` para órdenes
 *  recientes sin profit. Necesario porque el listado masivo de Dropi
 *  NO devuelve este campo (solo viene en getOrderDetail por orden).
 *  Sin esto, CAPI manda value=0 a Meta.
 */

const cron = require('node-cron');
const axios = require('axios');
const { Op } = require('sequelize');
const fsp = require('fs').promises;
const path = require('path');

const { db } = require('../database/config');
const DropiIntegrations = require('../models/dropi_integrations.model');
const DropiOrdersCache = require('../models/dropi_orders_cache.model');
const dropiService = require('../services/dropi.service');
const { decryptToken } = require('../utils/cryptoToken');

/* ═══════════════════════════════════════════════════════════
   Constantes
   ═══════════════════════════════════════════════════════════ */

const PAGE_SIZE = 100;
const DELAY_BETWEEN_PAGES = 2500;
const DELAY_BETWEEN_INTEGRATIONS = 4000;
const DELAY_BETWEEN_WA_SENDS = 800;
const MAX_ORDERS_PER_INTEGRATION = 2000;
const MAX_RETRIES_429 = 4;
const META_API_VERSION = 'v22.0';

// Profit sync — Dropi solo expone profit vía getOrderDetail individual
const PROFIT_MAX_PER_RUN = 30;
const PROFIT_DELAY_MS = 2500;
const PROFIT_LOOKBACK_HOURS = 48;

const SIEMPRE_TEMPLATE = new Set(['PENDIENTE CONFIRMACION']);
const VENTANA_HORAS = 23;
const COLUMNA_ENTREGADA_DEFAULT = 'entregada';

/* ═══════════════════════════════════════════════════════════
   Logging
   ═══════════════════════════════════════════════════════════ */

const logsDir = path.join(process.cwd(), './src/logs/logs_dropi');

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {}
}

async function log(msg) {
  // logs deshabilitados
}

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

function getDateRange() {
  const now = new Date();
  const ecNow = new Date(
    now.getTime() + (now.getTimezoneOffset() + -5 * 60) * 60000,
  );
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    from: fmt(new Date(ecNow.getTime() - 24 * 60 * 60 * 1000)),
    until: fmt(ecNow),
  };
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length >= 11) return digits;
  if (digits.length === 10 && digits.startsWith('0'))
    return '593' + digits.slice(1);
  if (digits.length === 9) return '593' + digits;
  return digits;
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

function getGuiaPdfUrl(order) {
  const guiaPath = order.guia_urls3;
  if (!guiaPath) return '';
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
      ],
    });
  }
}

/* ═══════════════════════════════════════════════════════════
   PROFIT SYNC (NUEVO v6)
   Dropi NO devuelve dropshipper_profit en el listado.
   Lo trae solo en getOrderDetail bajo el campo dropshipper_amount_to_win.
   Acá rellenamos órdenes recientes con profit=null para que CAPI
   tenga value real al enviar Purchase a Meta.
   ═══════════════════════════════════════════════════════════ */

async function syncProfitForRecentOrders({
  integrationKey,
  country_code,
  cacheCtx,
}) {
  const cacheWhere = cacheCtx.id_configuracion
    ? { id_configuracion: cacheCtx.id_configuracion, id_usuario: 0 }
    : { id_configuracion: 0, id_usuario: cacheCtx.id_usuario };

  const sinceDate = new Date(Date.now() - PROFIT_LOOKBACK_HOURS * 3600 * 1000);

  const pending = await DropiOrdersCache.findAll({
    where: {
      ...cacheWhere,
      dropshipper_profit: null,
      order_created_at: { [Op.gte]: sinceDate },
    },
    attributes: ['id', 'dropi_order_id'],
    order: [['order_created_at', 'DESC']],
    limit: PROFIT_MAX_PER_RUN,
    raw: true,
  });

  if (!pending.length) return { calculated: 0, total: 0, isProveedor: false };

  let calculated = 0;
  let errors = 0;
  let isProveedor = false;

  for (let idx = 0; idx < pending.length; idx++) {
    const order = pending[idx];
    try {
      const detail = await dropiService.getOrderDetail({
        integrationKey,
        orderId: order.dropi_order_id,
        country_code,
      });

      const profit = detail?.objects?.dropshipper_amount_to_win;

      // Caso proveedor: primera orden sin profit → marca TODAS en 0 y corta.
      // Evita gastar API en cuentas donde no hay profit por diseño.
      if (idx === 0 && (profit === null || profit === undefined)) {
        await DropiOrdersCache.update(
          { dropshipper_profit: 0 },
          { where: { ...cacheWhere, dropshipper_profit: null } },
        );
        isProveedor = true;
        break;
      }

      await DropiOrdersCache.update(
        { dropshipper_profit: Number(profit || 0) },
        { where: { id: order.id } },
      );
      calculated++;

      await new Promise((r) => setTimeout(r, PROFIT_DELAY_MS));
    } catch (err) {
      const status = err?.response?.status || err?.statusCode || 500;
      if (status === 429) break;
      errors++;
      if (errors >= 5) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return { calculated, errors, total: pending.length, isProveedor };
}

/* ═══════════════════════════════════════════════════════════
   Credenciales WA
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
       AND nombre_template IS NOT NULL AND nombre_template != ''`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const map = {};
  for (const r of rows) {
    map[r.estado_dropi] = {
      nombre_template: r.nombre_template,
      language_code: r.language_code || 'es',
      mensaje_rapido: r.mensaje_rapido || null,
      usar_respuesta_rapida: !!r.usar_respuesta_rapida,
      parametros_json: r.parametros_json || null,
      body_text: r.body_text || null,
      columna_destino: r.columna_destino || null,
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
}) {
  const phoneNorm = normalizePhone(telefono);
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

async function registrarEnvio({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
  phone,
  template_name,
  wa_message_id,
}) {
  await db.query(
    `INSERT IGNORE INTO dropi_plantillas_enviadas
       (dropi_order_id, id_configuracion, estado_dropi, phone, template_name, wa_message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        dropi_order_id,
        id_configuracion,
        estado_dropi,
        phone || null,
        template_name || null,
        wa_message_id || null,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
}

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

async function procesarTemplates({ orders, id_configuracion }) {
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
        });
        if (actualizado) entregadasActualizadas++;
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

      if (await yaFueEnviado(order.id, id_configuracion, estadoConfig)) {
        omitidos++;
        continue;
      }

      const config = plantillas[estadoConfig];
      const phoneNorm = normalizePhone(order.phone);
      if (!phoneNorm) {
        omitidos++;
        continue;
      }

      const { clienteId, idClienteConfig } = await resolverClientes({
        id_configuracion,
        phoneNorm,
        phone_number_id: creds.phone_number_id,
        telefonoConfig,
      });

      const components = buildTemplateComponents(config.parametros_json, order);
      const rutaArchivo = buildRutaArchivo(order, estadoConfig);

      let tipoEnvio = 'template';
      let waMessageId = null;
      let textoEnviado = config.nombre_template;
      let jsonMensajeEnviado = null;

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

      await registrarMensajeEnChat({
        id_configuracion,
        phone_number_id: creds.phone_number_id,
        clienteId,
        idClienteConfig,
        phoneNorm,
        tipoEnvio,
        textoMensaje: textoEnviado,
        templateName: tipoEnvio === 'template' ? config.nombre_template : null,
        languageCode: config.language_code,
        waMessageId,
        rutaArchivo,
        jsonMensaje: jsonMensajeEnviado,
      });

      await registrarEnvio({
        dropi_order_id: order.id,
        id_configuracion,
        estado_dropi: estadoConfig,
        phone: order.phone,
        template_name:
          tipoEnvio === 'respuesta_rapida'
            ? `[RR] ${config.mensaje_rapido.slice(0, 80)}`
            : config.nombre_template,
        wa_message_id: waMessageId,
      });

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

/* ═══════════════════════════════════════════════════════════
   Sync de una integración
   ═══════════════════════════════════════════════════════════ */

async function syncIntegration(integration, from, until) {
  const label = `integ#${integration.id}(${integration.country_code})`;
  const id_config = integration.id_configuracion
    ? Number(integration.id_configuracion)
    : null;

  let integrationKey;
  try {
    integrationKey = decryptToken(integration.integration_key_enc);
  } catch (e) {
    return { label, synced: 0, skipped: true };
  }
  if (!integrationKey?.trim()) return { label, synced: 0, skipped: true };

  const cacheInsertFields = id_config
    ? { id_configuracion: id_config, id_usuario: 0 }
    : { id_configuracion: 0, id_usuario: Number(integration.id_usuario) };

  const cacheCtx = id_config
    ? { id_configuracion: id_config }
    : { id_usuario: Number(integration.id_usuario) };

  // Fase 1: Fetch Dropi
  let allOrders = [],
    start = 0,
    keepGoing = true,
    retries = 0,
    delay = DELAY_BETWEEN_PAGES;

  while (keepGoing) {
    try {
      const resp = await dropiService.listMyOrders({
        integrationKey,
        params: {
          result_number: PAGE_SIZE,
          start,
          filter_date_by: 'FECHA DE CAMBIO DE ESTATUS',
          from,
          until,
        },
        country_code: integration.country_code,
      });
      const objects = resp?.objects || [];
      allOrders = allOrders.concat(objects);
      keepGoing = objects.length >= PAGE_SIZE;
      start += PAGE_SIZE;
      retries = 0;
      delay = DELAY_BETWEEN_PAGES;
      if (allOrders.length >= MAX_ORDERS_PER_INTEGRATION) break;
      if (keepGoing) await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      if (status === 429) {
        if (++retries >= MAX_RETRIES_429) break;
        delay = Math.min(delay * 2, 20000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }

  // Fase 2: Upsert cache
  if (allOrders.length > 0) await upsertOrders(cacheInsertFields, allOrders);

  // Fase 3: Templates + ENTREGADA pre-pass
  let templateStats = {
    enviados: 0,
    omitidos: 0,
    errores: 0,
    entregadas_actualizadas: 0,
  };
  if (id_config && allOrders.length > 0) {
    templateStats = await procesarTemplates({
      orders: allOrders,
      id_configuracion: id_config,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Fase 4: Profit sync (NUEVO v6)
  // Rellena dropshipper_profit para órdenes recientes con null.
  // Es safe-fail — si Dropi devuelve null/429/error, el cron sigue.
  // ═══════════════════════════════════════════════════════════
  let profitStats = { calculated: 0, total: 0, isProveedor: false };
  if (allOrders.length > 0) {
    try {
      profitStats = await syncProfitForRecentOrders({
        integrationKey,
        country_code: integration.country_code,
        cacheCtx,
      });
    } catch (err) {
      // log silencioso, no rompe sync principal
    }
  }

  return {
    label,
    synced: allOrders.length,
    skipped: false,
    templates: templateStats,
    profit: profitStats,
  };
}

/* ═══════════════════════════════════════════════════════════
   Job principal — con MySQL GET_LOCK
   ═══════════════════════════════════════════════════════════ */

async function runHourlyDropiSync() {
  const [row] = await db.query(
    `SELECT GET_LOCK('dropi_sync_hourly', 1) AS got`,
    { type: db.QueryTypes.SELECT },
  );
  if (!row || Number(row.got) !== 1) return;

  const t0 = Date.now();

  try {
    const { from, until } = getDateRange();

    // Solo integraciones activas + configs no suspendidas
    const integrations = await db.query(
      `SELECT di.id, di.id_configuracion, di.id_usuario, di.country_code, di.integration_key_enc
       FROM dropi_integrations di
       LEFT JOIN configuraciones c ON c.id = di.id_configuracion
       WHERE di.is_active = 1
         AND di.deleted_at IS NULL
         AND (
           di.id_configuracion IS NULL
           OR di.id_configuracion = 0
           OR (c.id IS NOT NULL AND COALESCE(c.suspendido, 0) = 0)
         )`,
      { type: db.QueryTypes.SELECT },
    );

    const totals = {
      ordenes: 0,
      enviados: 0,
      skipped: 0,
      errores: 0,
      entregadas: 0,
      profit_calculated: 0,
    };

    for (let i = 0; i < integrations.length; i++) {
      try {
        const r = await syncIntegration(integrations[i], from, until);
        if (r.skipped) {
          totals.skipped++;
        } else {
          totals.ordenes += r.synced;
          totals.enviados += r.templates?.enviados || 0;
          totals.errores += r.templates?.errores || 0;
          totals.entregadas += r.templates?.entregadas_actualizadas || 0;
          totals.profit_calculated += r.profit?.calculated || 0;
        }
      } catch (err) {
        totals.errores++;
      }
      if (i < integrations.length - 1)
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_INTEGRATIONS));
    }
  } catch (err) {
    // error general silencioso
  } finally {
    try {
      await db.query(`DO RELEASE_LOCK('dropi_sync_hourly')`, {
        type: db.QueryTypes.RAW,
      });
    } catch (e) {}
  }
}

cron.schedule('*/5 * * * *', () => {
  runHourlyDropiSync().catch(() => {});
});

module.exports = { runHourlyDropiSync };
