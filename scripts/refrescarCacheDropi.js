'use strict';

/**
 * scripts/refrescarCacheDropi.js
 *
 * Trae de Dropi las órdenes con CAMBIO DE ESTATUS en una ventana de fechas
 * más ancha que las 24 h del cron y las vuelca en `dropi_orders_cache`
 * (upsert). NO envía plantillas ni mueve columnas: solo refresca el cache.
 *
 * Para qué: el cron syncDropiOrdersHourly mira solo el último día. Si dejó
 * de visitar integraciones durante varios días (lock roto entre el 03 y el
 * 07 de septiembre de 2026), los cambios de estado de esos días ya no entran
 * en su ventana y nadie los vuelve a pedir. Este script los recupera al
 * cache; después, `scripts/reenviarPlantillasDropiPerdidas.js --horas=N
 * --apply` manda lo que falte (dedupe por dropi_plantillas_enviadas, "solo
 * mover" acotado a 24 h para no pisar columnas movidas a mano).
 *
 * OJO: Dropi valida la IP del servidor. Desde una máquina local responde
 * 401 "Access denied" para todas las llaves: hay que correrlo EN EL SERVIDOR.
 *
 * Uso (en el servidor):
 *   node scripts/refrescarCacheDropi.js --desde=2026-09-03
 *   node scripts/refrescarCacheDropi.js --desde=2026-09-03 --hasta=2026-09-07
 *   node scripts/refrescarCacheDropi.js --desde=2026-09-03 --cfg=277
 *   node scripts/refrescarCacheDropi.js --desde=2026-09-03 --solo-desatendidas
 *
 * --solo-desatendidas: únicamente integraciones sin visita del cron desde
 * `--desde` (requiere la columna last_sync_at; sin ella se recorren todas).
 */

process.env.DROPI_CRON_SIN_AGENDAR = '1';

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
});

const { db } = require('../src/database/config');
const { decryptToken } = require('../src/utils/cryptoToken');
const { upsertOrders } = require('../src/services/dropi_notifier.service');
const {
  fetchOrdenesIntegracion,
  listarIntegraciones,
  aprenderDropiUserId,
  DELAY_BETWEEN_INTEGRATIONS,
} = require('../src/cron/syncDropiOrdersHourly');

const args = process.argv.slice(2);
const arg = (k) =>
  (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];

const DESDE = arg('desde');
const HASTA = arg('hasta') || hoyLocal();
const CFG = Number(arg('cfg')) || null;
const SOLO_DESATENDIDAS = args.includes('--solo-desatendidas');
const PAUSA_MS = DELAY_BETWEEN_INTEGRATIONS;
// Ventana ancha = más páginas por integración; se sube el tope del cron.
const MAX_ORDENES = 5000;

function hoyLocal() {
  const now = new Date();
  const ec = new Date(
    now.getTime() + (now.getTimezoneOffset() + -5 * 60) * 60000,
  );
  const pad = (n) => String(n).padStart(2, '0');
  return `${ec.getFullYear()}-${pad(ec.getMonth() + 1)}-${pad(ec.getDate())}`;
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE || '')) {
  console.error('Falta --desde=YYYY-MM-DD');
  process.exit(1);
}

(async () => {
  console.log(
    `Refrescando cache Dropi: cambios de estatus ${DESDE} → ${HASTA}` +
      (CFG ? ` · cfg ${CFG}` : '') +
      (SOLO_DESATENDIDAS ? ' · solo desatendidas' : ''),
  );

  let integraciones = await listarIntegraciones();
  if (CFG) {
    integraciones = integraciones.filter(
      (i) => Number(i.id_configuracion) === CFG,
    );
  }
  if (SOLO_DESATENDIDAS) {
    try {
      const rows = await db.query(
        `SELECT id FROM dropi_integrations
          WHERE last_sync_at IS NULL OR last_sync_at < ?`,
        { replacements: [`${DESDE} 00:00:00`], type: db.QueryTypes.SELECT },
      );
      const ids = new Set(rows.map((r) => Number(r.id)));
      integraciones = integraciones.filter((i) => ids.has(Number(i.id)));
    } catch (_) {
      console.warn(
        'last_sync_at no existe todavía: se recorren todas las integraciones',
      );
    }
  }
  console.log(`${integraciones.length} integraciones a recorrer\n`);

  const tot = { ok: 0, ordenes: 0, sin_llave: 0, rate_limited: 0, errores: 0 };

  for (let i = 0; i < integraciones.length; i++) {
    const integ = integraciones[i];
    const cfg = Number(integ.id_configuracion) || null;
    const etiqueta = `integ#${integ.id} cfg ${cfg ?? `u${integ.id_usuario}`} (${integ.country_code})`;

    let key;
    try {
      key = decryptToken(integ.integration_key_enc);
    } catch (_) {
      key = null;
    }
    if (!key?.trim()) {
      tot.sin_llave++;
      continue;
    }

    const { orders, rateLimited, error } = await fetchOrdenesIntegracion({
      integrationKey: key,
      country_code: integ.country_code,
      from: DESDE,
      until: HASTA,
      maxOrders: MAX_ORDENES,
    });

    if (error) {
      tot.errores++;
      console.log(`${etiqueta}: ERROR ${error}`);
    } else if (rateLimited) {
      tot.rate_limited++;
      console.log(`${etiqueta}: 429 persistente (parcial: ${orders.length})`);
    }

    if (orders.length) {
      const cacheInsertFields = cfg
        ? { id_configuracion: cfg, id_usuario: 0 }
        : { id_configuracion: 0, id_usuario: Number(integ.id_usuario) };
      try {
        await upsertOrders(cacheInsertFields, orders);
        await aprenderDropiUserId(integ, orders);
        tot.ok++;
        tot.ordenes += orders.length;
        console.log(`${etiqueta}: ${orders.length} órdenes al cache`);
      } catch (e) {
        tot.errores++;
        console.log(`${etiqueta}: ERROR upsert ${e?.message}`);
      }
    }

    if (i < integraciones.length - 1)
      await new Promise((r) => setTimeout(r, PAUSA_MS));
  }

  console.log('\nResumen:', JSON.stringify(tot));
  console.log(
    'Siguiente paso: node scripts/reenviarPlantillasDropiPerdidas.js --horas=<horas desde --desde> --apply',
  );
  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
