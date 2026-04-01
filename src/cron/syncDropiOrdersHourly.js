'use strict';

/**
 * cron/syncDropiOrdersHourly.js
 *
 * Cada hora (minuto :05):
 *  1. Para cada integración Dropi activa → consulta órdenes con
 *     filter_date_by = "FECHA DE CAMBIO DE ESTATUS" (ayer → hoy)
 *     y hace upsert al cache.
 *  2. Por cada orden sincronizada verifica si su estado tiene una plantilla
 *     WhatsApp activa configurada en dropi_plantillas_config.
 *  3. Si aún no se envió ese (orden + config + estado) → envía el template
 *     y registra en dropi_plantillas_enviadas (tabla de dedup).
 *
 * Dedup:
 *   UNIQUE KEY (dropi_order_id, id_configuracion, estado_dropi)
 *   → Mismo pedido + mismo estado  = solo se notifica UNA VEZ ✅
 *   → Mismo pedido cambia de estado = nuevo combo → se notifica de nuevo ✅
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

/* ─── Constantes ────────────────────────────────────────────── */
const PAGE_SIZE = 100;
const DELAY_BETWEEN_PAGES = 2500; // ms entre páginas de la misma integración
const DELAY_BETWEEN_INTEGRATIONS = 4000; // ms entre integraciones (evitar ban Dropi)
const DELAY_BETWEEN_WA_SENDS = 800; // ms entre envíos a Meta API
const MAX_ORDERS_PER_INTEGRATION = 2000; // techo de seguridad por ejecución
const MAX_RETRIES_429 = 4;
const META_API_VERSION = 'v19.0';

/* ─── Logging helpers ───────────────────────────────────────── */
const logsDir = path.join(process.cwd(), './src/logs/logs_dropi');

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {}
}

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    await ensureDir(logsDir);
    await fsp.appendFile(path.join(logsDir, 'debug_log_dropi.txt'), line);
  } catch (_) {}
}

/* ─── Lock global para no solapar ejecuciones ───────────────── */
if (!global._hourlyDropiSyncRunning) global._hourlyDropiSyncRunning = false;

/* ─── Mapeo classified_status → estado_dropi ───────────────────
   Debe coincidir con los estados que el usuario configura en
   DropisPlantillas.jsx / dropi_plantillas_config.
   ──────────────────────────────────────────────────────────── */
const CLASSIFIED_TO_ESTADO = {
  entregada: 'ENTREGADA',
  devolucion: 'DEVOLUCION',
  cancelada: 'CANCELADO',
  pendiente: 'PENDIENTE CONFIRMACION',
  retiro_agencia: 'RETIRO EN AGENCIA',
  novedad: 'NOVEDAD',
  en_transito: 'EN TRANSITO',
  // 'indemnizada' y 'otro' → sin plantilla configurable
};

/* ─── Helpers de fecha (UTC-5 Ecuador) ─────────────────────── */
function getDateRange() {
  const now = new Date();
  const ecNow = new Date(
    now.getTime() + (now.getTimezoneOffset() + -5 * 60) * 60000,
  );
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    from: fmt(new Date(ecNow.getTime() - 24 * 60 * 60 * 1000)), // ayer
    until: fmt(ecNow), // hoy
  };
}

/* ─── Clasificar status (idéntico al controller) ─────────────── */
function classifyDropiStatus(status) {
  const s = String(status || '')
    .trim()
    .toUpperCase();
  if (
    s === 'ENTREGADO' ||
    s.includes('ENTREGADA') ||
    s === 'REPORTADO ENTREGADO' ||
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
    s === 'CON NOVEDAD' ||
    s === 'DESTINATARIO FALLECIDO' ||
    s.includes('DESTINATARIO RE-PROGRAMA') ||
    s.includes('DESTINATARIO SOLICITA') ||
    s.includes('FUERA DE COBERTURA') ||
    s.includes('OBSTRUCCIÓN EN LA VÍA') ||
    s.includes('PROBLEMAS DE ORDEN') ||
    s.includes('VISITA A DESTINATARIO') ||
    s.includes('ACCIDENTE EN CARRETERA') ||
    s.includes('EN ESPERA DE FIRMA')
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
  if (
    s === 'GUIA_GENERADA' ||
    s.includes('TRÁNSITO') ||
    s.includes('TRANSITO') ||
    s.includes('EN RUTA') ||
    s.includes('EN CAMINO') ||
    s.includes('EN REPARTO') ||
    s.includes('BODEGA') ||
    s.includes('EMBARCANDO') ||
    s.includes('RECOLECT') ||
    s.includes('RECOGIDO') ||
    s.includes('ASIGNADO') ||
    s.includes('PICKING') ||
    s.includes('PACKING') ||
    s.includes('GENERADO') ||
    s.includes('GENERADA') ||
    s.includes('ZONA DE ENTREGA') ||
    s.includes('PREPARADO') ||
    s.includes('INVENTARIO') ||
    s.includes('INGRES') ||
    s.includes('RECIBIDO') ||
    s === 'POR RECOLECTAR' ||
    s === 'PROCESAMIENTO' ||
    s.includes('EN DISTRIBUCION')
  )
    return 'en_transito';
  return 'otro';
}

/* ─── Upsert al cache ───────────────────────────────────────── */
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

/* ─── Credenciales WA de una configuración ─────────────────────
   AJUSTA los nombres de columna si difieren en tu tabla.
   ──────────────────────────────────────────────────────────── */
async function getWaCredentials(id_configuracion) {
  const [row] = await db.query(
    `SELECT phone_number_id, waba_token
     FROM configuraciones
     WHERE id = ? AND phone_number_id IS NOT NULL
     LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/* ─── Normalizar teléfono → E.164 sin '+' ───────────────────── */
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length >= 11) return digits; // ya tiene código de país
  if (digits.length === 10 && digits.startsWith('0'))
    return '593' + digits.slice(1); // EC 0XXX
  if (digits.length === 9) return '593' + digits; // EC sin 0
  return digits;
}

/* ─── Enviar template vía Meta Graph API ────────────────────── */
async function sendWhatsappTemplate({
  phone_number_id,
  waba_token,
  phone,
  templateName,
  languageCode,
}) {
  const to = normalizePhone(phone);
  if (!to) throw new Error(`Teléfono inválido: ${phone}`);

  const { data } = await axios.post(
    `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'es' },
        // Si tus templates tienen variables body {{1}}, {{2}}, agrégalas aquí:
        // components: [{ type: 'body', parameters: [{ type: 'text', text: 'valor' }] }]
      },
    },
    {
      headers: {
        Authorization: `Bearer ${waba_token}`,
        'Content-Type': 'application/json',
      },
      timeout: 12000,
    },
  );

  return data?.messages?.[0]?.id || null; // ID de mensaje devuelto por Meta
}

/* ─── Verificar dedup ───────────────────────────────────────── */
async function yaFueEnviado(dropi_order_id, id_configuracion, estado_dropi) {
  const [row] = await db.query(
    `SELECT id FROM dropi_plantillas_enviadas
     WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?
     LIMIT 1`,
    {
      replacements: [dropi_order_id, id_configuracion, estado_dropi],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/* ─── Registrar envío ───────────────────────────────────────── */
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

/* ─── Cargar plantillas activas de una config ───────────────── */
async function getPlantillasActivas(id_configuracion) {
  const rows = await db.query(
    `SELECT estado_dropi, nombre_template, language_code
     FROM dropi_plantillas_config
     WHERE id_configuracion = ?
       AND activo = 1
       AND nombre_template IS NOT NULL
       AND nombre_template != ''`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  // Mapa { 'ENTREGADA': { nombre_template, language_code }, ... }
  const map = {};
  for (const r of rows)
    map[r.estado_dropi] = {
      nombre_template: r.nombre_template,
      language_code: r.language_code || 'es',
    };
  return map;
}

/* ─── Procesar templates para un lote de órdenes ───────────────
   Recibe las órdenes TAL COMO vienen de la API Dropi (con .id, .phone, .status)
   ──────────────────────────────────────────────────────────── */
async function procesarTemplates({ orders, id_configuracion }) {
  if (!orders.length) return { enviados: 0, omitidos: 0, errores: 0 };

  // Plantillas activas para esta config
  const plantillas = await getPlantillasActivas(id_configuracion);
  if (!Object.keys(plantillas).length)
    return { enviados: 0, omitidos: 0, errores: 0 };

  // Credenciales WA
  const creds = await getWaCredentials(id_configuracion);
  if (!creds?.phone_number_id || !creds?.waba_token) {
    await log(
      `[hourly-dropi] ⚠️ Config #${id_configuracion} sin credenciales WA`,
    );
    return { enviados: 0, omitidos: 0, errores: 0 };
  }

  let enviados = 0;
  let omitidos = 0;
  let errores = 0;

  for (const order of orders) {
    try {
      // Clasificar y mapear al estado configurable
      const classified = classifyDropiStatus(order.status);
      const estadoDropi = CLASSIFIED_TO_ESTADO[classified];

      if (!estadoDropi || !plantillas[estadoDropi]) {
        omitidos++;
        continue;
      }
      if (!order.phone) {
        omitidos++;
        continue;
      }

      // Dedup: ¿ya se envió este estado para esta orden?
      if (await yaFueEnviado(order.id, id_configuracion, estadoDropi)) {
        omitidos++;
        continue;
      }

      const { nombre_template, language_code } = plantillas[estadoDropi];

      // Enviar a Meta
      const waMessageId = await sendWhatsappTemplate({
        phone_number_id: creds.phone_number_id,
        waba_token: creds.waba_token,
        phone: order.phone,
        templateName: nombre_template,
        languageCode: language_code,
      });

      // Registrar para no reenviar
      await registrarEnvio({
        dropi_order_id: order.id,
        id_configuracion,
        estado_dropi: estadoDropi,
        phone: order.phone,
        template_name: nombre_template,
        wa_message_id: waMessageId,
      });

      await log(
        `[hourly-dropi] ✉ orden #${order.id} → ${estadoDropi} → ${nombre_template} → ${order.phone}`,
      );
      enviados++;

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_WA_SENDS));
    } catch (err) {
      errores++;
      const metaCode = err?.response?.data?.error?.code;
      await log(
        `[hourly-dropi] ❌ Error template orden #${order?.id}: ${err?.message} (Meta code: ${metaCode})`,
      );

      // Rate limit de Meta → pausa larga
      if (err?.response?.status === 429 || metaCode === 130429) {
        await log('[hourly-dropi] ⚠️ Rate limit Meta — pausando 30s');
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  }

  return { enviados, omitidos, errores };
}

/* ─── Sync completo de una integración ─────────────────────── */
async function syncIntegration(integration, from, until) {
  const label = `integ#${integration.id}(${integration.country_code})`;
  const id_config = integration.id_configuracion
    ? Number(integration.id_configuracion)
    : null;

  let integrationKey;
  try {
    integrationKey = decryptToken(integration.integration_key_enc);
  } catch (e) {
    await log(
      `[hourly-dropi] ${label} — ❌ error descifrando key: ${e.message}`,
    );
    return { label, synced: 0, skipped: true };
  }
  if (!integrationKey?.trim()) {
    await log(`[hourly-dropi] ${label} — ⚠️ key vacía`);
    return { label, synced: 0, skipped: true };
  }

  const cacheInsertFields = id_config
    ? { id_configuracion: id_config, id_usuario: 0 }
    : { id_configuracion: 0, id_usuario: Number(integration.id_usuario) };

  /* ── Fase 1: Fetch Dropi ── */
  let allOrders = [];
  let start = 0;
  let keepGoing = true;
  let retries = 0;
  let delay = DELAY_BETWEEN_PAGES;

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

      if (allOrders.length >= MAX_ORDERS_PER_INTEGRATION) {
        await log(
          `[hourly-dropi] ${label} — ⚠️ techo ${MAX_ORDERS_PER_INTEGRATION} alcanzado`,
        );
        break;
      }
      if (keepGoing) await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      if (status === 429) {
        if (++retries >= MAX_RETRIES_429) {
          keepGoing = false;
          break;
        }
        delay = Math.min(delay * 2, 20000);
        await log(
          `[hourly-dropi] ${label} — ⚠️ 429 retry ${retries}/${MAX_RETRIES_429}, wait ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      await log(
        `[hourly-dropi] ${label} — ❌ error start=${start}: ${err?.message}`,
      );
      break;
    }
  }

  /* ── Fase 2: Upsert cache ── */
  if (allOrders.length > 0) {
    await upsertOrders(cacheInsertFields, allOrders);
  }
  await log(
    `[hourly-dropi] ${label} — ✅ ${allOrders.length} órdenes sincronizadas`,
  );

  /* ── Fase 3: Templates WhatsApp (solo integraciones con id_configuracion) ── */
  let templateStats = { enviados: 0, omitidos: 0, errores: 0 };
  if (id_config && allOrders.length > 0) {
    templateStats = await procesarTemplates({
      orders: allOrders,
      id_configuracion: id_config,
    });
    await log(
      `[hourly-dropi] ${label} — templates: ${JSON.stringify(templateStats)}`,
    );
  }

  return {
    label,
    synced: allOrders.length,
    skipped: false,
    templates: templateStats,
  };
}

/* ─── Job principal ─────────────────────────────────────────── */
async function runHourlyDropiSync() {
  if (global._hourlyDropiSyncRunning) {
    await log('[hourly-dropi] ⚠️ Ya hay una ejecución en curso, saltando');
    return;
  }
  global._hourlyDropiSyncRunning = true;
  const t0 = Date.now();
  await log(`[hourly-dropi] ▶ Iniciando sync`);

  try {
    const { from, until } = getDateRange();
    await log(`[hourly-dropi] Rango ${from} → ${until}`);

    const integrations = await DropiIntegrations.findAll({
      where: { is_active: 1, deleted_at: null },
      attributes: [
        'id',
        'id_configuracion',
        'id_usuario',
        'country_code',
        'integration_key_enc',
      ],
      raw: true,
    });
    await log(`[hourly-dropi] ${integrations.length} integraciones activas`);

    const totals = { ordenes: 0, enviados: 0, skipped: 0, errores: 0 };

    for (let i = 0; i < integrations.length; i++) {
      try {
        const r = await syncIntegration(integrations[i], from, until);
        r.skipped
          ? totals.skipped++
          : ((totals.ordenes += r.synced),
            (totals.enviados += r.templates?.enviados || 0));
      } catch (err) {
        totals.errores++;
        await log(
          `[hourly-dropi] ❌ Error integ#${integrations[i].id}: ${err?.message}`,
        );
      }
      if (i < integrations.length - 1)
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_INTEGRATIONS));
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    await log(
      `[hourly-dropi] ✅ ${elapsed}s | órdenes: ${totals.ordenes} | ` +
        `templates: ${totals.enviados} | saltadas: ${totals.skipped} | errores: ${totals.errores}`,
    );
  } catch (err) {
    await log(`[hourly-dropi] ❌ Error general: ${err?.message}`);
  } finally {
    global._hourlyDropiSyncRunning = false;
  }
}

/* ─── Registrar cron ────────────────────────────────────────── */
cron.schedule('5 * * * *', () => {
  runHourlyDropiSync().catch((err) =>
    log(`[hourly-dropi] Unhandled: ${err?.message}`).catch(() => {}),
  );
});

log('[hourly-dropi] Cron registrado — cada hora en el minuto :05').catch(
  () => {},
);

module.exports = { runHourlyDropiSync };
