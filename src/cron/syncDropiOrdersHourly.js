'use strict';

/**
 * cron/syncDropiOrdersHourly.js  — v9
 *
 * NUEVO EN v9 (2026-09-07):
 *  El candado de MySQL del v8 no aguantaba: la sesión que sostiene GET_LOCK
 *  queda ociosa mientras se procesa cada integración y el `wait_timeout` de
 *  producción es de 120 s. El keepalive "cada 10 integraciones" llegaba
 *  tarde (la primera integración del loop, IMPORSHOP PROVEEDOR, trae hasta
 *  2000 órdenes), MySQL mataba la sesión, el lock se soltaba y cada tick de
 *  15 min volvía a arrancar un ciclo desde la primera integración. Medido
 *  entre el 04 y el 07 de septiembre: el cron solo notificó órdenes de 1-2
 *  configuraciones por día (las primeras del loop); el resto de las ~380
 *  integraciones no recibió ni una visita desde el deploy del 03.
 *
 *  Tres cambios:
 *   1. Candado EN MEMORIA (`cicloEnCurso`): un solo proceso por servidor, así
 *      que esto es lo que realmente impide solapar ciclos. El GET_LOCK queda
 *      solo como defensa contra otro proceso apuntando a la misma BD.
 *   2. Keepalive del lock por TIEMPO (cada 30 s), no por cantidad de
 *      integraciones. Si igual se pierde, se avisa una vez en el log.
 *   3. Orden JUSTO: las integraciones se recorren de la menos recientemente
 *      sincronizada a la más reciente (`dropi_integrations.last_sync_at`).
 *      Si un ciclo muere a la mitad (reinicio, deploy, error), el siguiente
 *      arranca por las que quedaron sin atender en vez de repetir siempre
 *      las mismas primeras. La columna es opcional: sin la migración
 *      (dropi_integrations_last_sync_migration.sql) se recorre por id como
 *      antes y se avisa en el log.
 *
 *  Recuperación de eventos perdidos (ventana de 24 h ya pasada):
 *  scripts/refrescarCacheDropi.js --desde=YYYY-MM-DD (en el servidor) y
 *  después scripts/reenviarPlantillasDropiPerdidas.js --horas=N --apply.
 *
 * NUEVO EN v8:
 *  La lógica de clasificación de estados, upsert al cache y envío de
 *  templates se extrajo a services/dropi_notifier.service.js para
 *  compartirla con el webhook de Dropi (tiempo real). Este cron queda como
 *  RED DE SEGURIDAD: cubre las órdenes que el webhook no notifica (Dropi
 *  solo envía webhooks de órdenes creadas vía API con shop IMPORSUIT) y
 *  corrige cualquier evento perdido. Comportamiento de envío idéntico a v7.
 *
 *  Además: aprende dropi_user_id por integración (cuenta Dropi dueña de la
 *  key). Si todas las órdenes del lote pertenecen al mismo user_id, ese es
 *  el dueño (dropshipper). Los proveedores ven órdenes de muchos users y
 *  quedan NULL. El webhook usa esta columna para mapear eventos de órdenes
 *  nuevas que aún no están en el cache.
 *
 * NUEVO EN v7:
 *  Teléfonos multipaís vía libphonenumber (ver dropi_notifier.service).
 *
 * NUEVO EN v6:
 *  Fase 4: Profit Sync — rellena `dropshipper_profit` para órdenes
 *  recientes sin profit. Necesario porque el listado masivo de Dropi
 *  NO devuelve este campo (solo viene en getOrderDetail por orden).
 *  Sin esto, CAPI manda value=0 a Meta.
 */

const cron = require('node-cron');
const { Op } = require('sequelize');

const { db } = require('../database/config');
const DropiOrdersCache = require('../models/dropi_orders_cache.model');
const dropiService = require('../services/dropi.service');
const { decryptToken } = require('../utils/cryptoToken');
const {
  upsertOrders,
  procesarTemplates,
} = require('../services/dropi_notifier.service');

/* ═══════════════════════════════════════════════════════════
   Constantes
   ═══════════════════════════════════════════════════════════ */

const PAGE_SIZE = 100;
const DELAY_BETWEEN_PAGES = 2500;
const DELAY_BETWEEN_INTEGRATIONS = 4000;
const MAX_ORDERS_PER_INTEGRATION = 2000;
const MAX_RETRIES_429 = 4;

// Profit sync — Dropi solo expone profit vía getOrderDetail individual
const PROFIT_MAX_PER_RUN = 30;
const PROFIT_DELAY_MS = 2500;
const PROFIT_LOOKBACK_HOURS = 48;

// Keepalive de la sesión que sostiene GET_LOCK. El wait_timeout de MySQL en
// producción es de 120 s: con 30 s hay margen aunque una query se demore.
const LOCK_KEEPALIVE_MS = 30 * 1000;

/* ═══════════════════════════════════════════════════════════
   Helpers
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

/* ═══════════════════════════════════════════════════════════
   dropi_user_id — aprender la cuenta Dropi dueña de la integración
   ═══════════════════════════════════════════════════════════ */

async function aprenderDropiUserId(integration, allOrders) {
  if (integration.dropi_user_id || !allOrders.length) return;
  const userIds = new Set(
    allOrders.map((o) => o?.user_id).filter((v) => Number(v) > 0),
  );
  // Un único user_id en todo el lote → la key pertenece a ese dropshipper.
  // Varios user_ids → cuenta proveedor: se deja NULL (el cron la cubre).
  if (userIds.size !== 1) return;
  const uid = Number([...userIds][0]);
  try {
    await db.query(
      `UPDATE dropi_integrations SET dropi_user_id = ? WHERE id = ? AND dropi_user_id IS NULL`,
      { replacements: [uid, integration.id], type: db.QueryTypes.UPDATE },
    );
  } catch (err) {
    // best-effort: si falla, se reintenta en la próxima corrida
  }
}

/* ═══════════════════════════════════════════════════════════
   PROFIT SYNC (v6)
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
   Fetch de órdenes de una integración (paginado, con backoff 429)
   ═══════════════════════════════════════════════════════════ */

/**
 * Trae de Dropi las órdenes con cambio de estatus entre `from` y `until`.
 * Devuelve { orders, rateLimited, error }:
 *  - rateLimited: Dropi respondió 429 MAX_RETRIES_429 veces seguidas; lo que
 *    haya en `orders` es parcial.
 *  - error: mensaje del primer error NO 429 (401 llave revocada, timeout…);
 *    en ese caso el fetch se corta y `orders` queda como estaba.
 * Compartido con scripts/refrescarCacheDropi.js para no duplicar la
 * paginación.
 */
async function fetchOrdenesIntegracion({
  integrationKey,
  country_code,
  from,
  until,
  maxOrders = MAX_ORDERS_PER_INTEGRATION,
}) {
  let orders = [],
    start = 0,
    keepGoing = true,
    retries = 0,
    delay = DELAY_BETWEEN_PAGES,
    rateLimited = false,
    error = null;

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
        country_code,
      });
      const objects = resp?.objects || [];
      orders = orders.concat(objects);
      keepGoing = objects.length >= PAGE_SIZE;
      start += PAGE_SIZE;
      retries = 0;
      delay = DELAY_BETWEEN_PAGES;
      if (orders.length >= maxOrders) break;
      if (keepGoing) await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      if (status === 429) {
        if (++retries >= MAX_RETRIES_429) {
          rateLimited = true;
          break;
        }
        delay = Math.min(delay * 2, 20000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      error = `${status} ${err?.dropiRawMessage || err?.message || ''}`.trim();
      break;
    }
  }

  return { orders, rateLimited, error };
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
  const {
    orders: allOrders,
    rateLimited,
    error: fetchError,
  } = await fetchOrdenesIntegracion({
    integrationKey,
    country_code: integration.country_code,
    from,
    until,
  });

  // Fase 2: Upsert cache + aprender dropi_user_id (para el webhook)
  if (allOrders.length > 0) {
    await upsertOrders(cacheInsertFields, allOrders);
    await aprenderDropiUserId(integration, allOrders);
  }

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
      country_code: integration.country_code,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Fase 4: Profit sync (v6)
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
    rateLimited,
    fetchError,
    templates: templateStats,
    profit: profitStats,
  };
}

/* ═══════════════════════════════════════════════════════════
   Orden justo: last_sync_at (columna opcional)
   ═══════════════════════════════════════════════════════════ */

// null = todavía no se comprobó; true/false una vez por proceso.
let _colLastSync = null;
async function tieneColumnaLastSync() {
  if (_colLastSync !== null) return _colLastSync;
  try {
    await db.query(`SELECT last_sync_at FROM dropi_integrations LIMIT 1`, {
      type: db.QueryTypes.SELECT,
    });
    _colLastSync = true;
  } catch (_) {
    _colLastSync = false;
    console.warn(
      '[Cron Dropi] dropi_integrations.last_sync_at no existe: falta correr ' +
        'dropi_integrations_last_sync_migration.sql. El ciclo recorre por id; ' +
        'si un ciclo se corta, las mismas integraciones quedan sin visitar.',
    );
  }
  return _colLastSync;
}

/**
 * Integraciones a recorrer en este ciclo. Solo activas y con config no
 * suspendida (igual que el webhook). Con la columna, primero las que nunca
 * se sincronizaron y después de la más vieja a la más reciente: un ciclo
 * cortado a la mitad no deja a nadie esperando para siempre.
 */
async function listarIntegraciones() {
  const conLastSync = await tieneColumnaLastSync();
  return db.query(
    `SELECT di.id, di.id_configuracion, di.id_usuario, di.country_code,
            di.integration_key_enc, di.dropi_user_id
     FROM dropi_integrations di
     LEFT JOIN configuraciones c ON c.id = di.id_configuracion
     WHERE di.is_active = 1
       AND di.deleted_at IS NULL
       AND (
         di.id_configuracion IS NULL
         OR di.id_configuracion = 0
         OR (c.id IS NOT NULL AND COALESCE(c.suspendido, 0) = 0)
       )
     ORDER BY ${
       conLastSync
         ? 'di.last_sync_at IS NULL DESC, di.last_sync_at ASC, di.id ASC'
         : 'di.id ASC'
     }`,
    { type: db.QueryTypes.SELECT },
  );
}

/* Marca la visita. Best-effort: si falla, la integración vuelve a quedar
   primera en la cola del próximo ciclo, que es el lado seguro. */
async function marcarVisita(integrationId) {
  if (!(await tieneColumnaLastSync())) return;
  try {
    await db.query(
      `UPDATE dropi_integrations SET last_sync_at = NOW() WHERE id = ?`,
      { replacements: [integrationId], type: db.QueryTypes.UPDATE },
    );
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════
   Job principal — candado en memoria + MySQL GET_LOCK
   ═══════════════════════════════════════════════════════════ */

// Candado en memoria. Hay un solo proceso por servidor, así que esto es lo
// que de verdad impide que dos ticks corran a la vez. El GET_LOCK de abajo
// solo cubre el caso de OTRO proceso contra la misma BD (un dev local con
// CRONS_ENABLED sin apagar, un deploy que arranca antes de que el anterior
// termine).
let cicloEnCurso = false;
let cicloInicioMs = 0;

// Si un ciclo se colgara (un await que nunca resuelve), el candado en memoria
// dejaría al cron muerto para siempre sin una sola línea de log. Pasado este
// tope se asume colgado y se deja arrancar el siguiente. Un ciclo sano con
// ~390 integraciones tarda bastante menos.
const CICLO_MAX_MS = 3 * 60 * 60 * 1000;

// integ.id → último error de fetch avisado en el log (ver el loop).
const fetchErrorsAvisados = new Map();

/**
 * Sostiene GET_LOCK en una sesión fija (transacción) y la mantiene viva con
 * un SELECT 1 cada LOCK_KEEPALIVE_MS. Devuelve null si otro proceso lo tiene.
 *
 * Historia: en v8 el keepalive iba "cada 10 integraciones". La primera
 * integración del loop trae hasta 2000 órdenes y tarda varios minutos; con
 * wait_timeout=120 s MySQL cerraba la sesión antes del primer keepalive, el
 * lock se soltaba y el siguiente tick arrancaba otro ciclo encima.
 */
async function tomarLockMysql() {
  const t = await db.transaction();
  let got = false;
  try {
    const [row] = await db.query(
      `SELECT GET_LOCK('dropi_sync_hourly', 1) AS got`,
      { type: db.QueryTypes.SELECT, transaction: t },
    );
    got = !!row && Number(row.got) === 1;
  } catch (_) {
    got = false;
  }
  if (!got) {
    try {
      await t.rollback();
    } catch (_) {}
    return null;
  }

  let perdido = false;
  const timer = setInterval(() => {
    db.query(`SELECT 1`, { type: db.QueryTypes.SELECT, transaction: t }).catch(
      (e) => {
        if (perdido) return;
        perdido = true;
        // El ciclo sigue: lo protege el candado en memoria. Solo se avisa.
        console.warn(
          `[Cron Dropi] la sesión del lock murió a mitad del ciclo (${e?.message}); el ciclo sigue con el candado en memoria`,
        );
      },
    );
  }, LOCK_KEEPALIVE_MS);
  timer.unref?.();

  return {
    async soltar() {
      clearInterval(timer);
      try {
        await db.query(`DO RELEASE_LOCK('dropi_sync_hourly')`, {
          type: db.QueryTypes.RAW,
          transaction: t,
        });
      } catch (_) {}
      // Si la sesión ya murió, el commit revienta con "connection is in
      // closed state"; el lock murió con ella, no hay nada que salvar.
      try {
        await t.commit();
      } catch (_) {
        try {
          await t.rollback();
        } catch (__) {}
      }
    },
  };
}

async function runHourlyDropiSync() {
  if (cicloEnCurso) {
    const min = ((Date.now() - cicloInicioMs) / 60000).toFixed(0);
    if (Date.now() - cicloInicioMs < CICLO_MAX_MS) {
      console.log(
        `[Cron Dropi] tick omitido: el ciclo anterior sigue en curso (${min} min)`,
      );
      return;
    }
    console.error(
      `[Cron Dropi] el ciclo anterior lleva ${min} min sin terminar: se asume colgado y se arranca otro`,
    );
  }
  cicloEnCurso = true;
  cicloInicioMs = Date.now();

  let lock = null;
  const inicio = Date.now();
  let resumen = null;
  try {
    lock = await tomarLockMysql();
    if (!lock) {
      console.log('[Cron Dropi] tick omitido: lock tomado por otro proceso');
      return;
    }

    const { from, until } = getDateRange();
    const integrations = await listarIntegraciones();

    const totals = {
      integraciones: integrations.length,
      ordenes: 0,
      enviados: 0,
      skipped: 0,
      errores: 0,
      rate_limited: 0,
      fetch_errors: 0,
      entregadas: 0,
      profit_calculated: 0,
    };

    for (let i = 0; i < integrations.length; i++) {
      const integ = integrations[i];
      let visitada = true;
      try {
        const r = await syncIntegration(integ, from, until);
        if (r.skipped) {
          totals.skipped++;
        } else {
          totals.ordenes += r.synced;
          totals.enviados += r.templates?.enviados || 0;
          totals.errores += r.templates?.errores || 0;
          totals.entregadas += r.templates?.entregadas_actualizadas || 0;
          totals.profit_calculated += r.profit?.calculated || 0;
        }
        if (r.rateLimited) {
          totals.rate_limited++;
          // Dropi no dejó traer nada: que vuelva a ser de las primeras.
          if (!r.synced) visitada = false;
        }
        if (r.fetchError) {
          totals.fetch_errors++;
          // Llave revocada (401), timeout… Se deja rastro por integración
          // porque antes esto moría en silencio y "el cron no notifica".
          // Una vez por integración y por error distinto: hay ~40 llaves
          // muertas y repetirlas cada ciclo tapaba el resto del log.
          if (fetchErrorsAvisados.get(integ.id) !== r.fetchError) {
            fetchErrorsAvisados.set(integ.id, r.fetchError);
            console.warn(
              `[Cron Dropi] ${r.label} cfg ${integ.id_configuracion ?? '-'}: fetch falló (${r.fetchError})`,
            );
          }
        } else {
          fetchErrorsAvisados.delete(integ.id);
        }
      } catch (err) {
        totals.errores++;
        console.error(
          `[Cron Dropi] integ#${integ.id} cfg ${integ.id_configuracion ?? '-'}: error del ciclo:`,
          err?.message,
        );
      }
      if (visitada) await marcarVisita(integ.id);

      if (i < integrations.length - 1)
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_INTEGRATIONS));
    }
    resumen = totals;
  } catch (err) {
    console.error('[Cron Dropi] error general del ciclo:', err?.message);
  } finally {
    if (lock) {
      // Una línea por ciclo: sin esto era imposible saber cuánto tarda la
      // vuelta completa ni si Dropi está limitando (429).
      const min = ((Date.now() - inicio) / 60000).toFixed(1);
      console.log(
        `[Cron Dropi] ciclo terminado en ${min} min ${
          resumen ? JSON.stringify(resumen) : '(sin resumen)'
        }`,
      );
      await lock.soltar();
    }
    cicloEnCurso = false;
  }
}

// Los scripts de scripts/ que reusan las funciones de este módulo corren en
// el servidor con NODE_ENV=production: sin este freno, el require agendaría
// el cron dentro del script y correría un ciclo completo en paralelo.
const CRONS_ENABLED =
  process.env.NODE_ENV === 'production' &&
  process.env.DROPI_CRON_SIN_AGENDAR !== '1';

// v8: */15 (antes */5). El webhook de Dropi ya notifica en tiempo real las
// órdenes IMPORSUIT; este cron queda como red de seguridad para el resto
// (Shopify/bots/creadas en Dropi) y para eventos de webhook perdidos.
// Con 305 integraciones un ciclo completo toma ~20 min de todas formas, así
// que el impacto en frescura es mínimo y se reduce ~66% la presión de 429.
if (CRONS_ENABLED) {
  cron.schedule('*/15 * * * *', () => {
    runHourlyDropiSync().catch(() => {});
  });
  // console.log('[Cron Dropi] Activo (*/15 min)');
} else {
  console.log('[Cron Dropi] Deshabilitado — entorno no productivo');
}

module.exports = {
  runHourlyDropiSync,
  // Reusados por scripts/refrescarCacheDropi.js
  fetchOrdenesIntegracion,
  listarIntegraciones,
  aprenderDropiUserId,
  DELAY_BETWEEN_INTEGRATIONS,
};
