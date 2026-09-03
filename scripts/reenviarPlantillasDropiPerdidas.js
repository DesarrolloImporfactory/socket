'use strict';

/**
 * scripts/reenviarPlantillasDropiPerdidas.js
 *
 * Reprocesa desde `dropi_orders_cache` las órdenes cuyo estado actual tiene
 * plantilla/columna configurada en `dropi_plantillas_config` y que NUNCA se
 * notificaron (sin fila en `dropi_plantillas_enviadas`). Usa la MISMA función
 * del cron (`procesarTemplates`): envía la plantilla o respuesta rápida,
 * registra el mensaje en el chat, reclama en `dropi_plantillas_enviadas` y
 * mueve el contacto a la columna destino. Los estados "solo mover" (sin
 * plantilla) también se reubican.
 *
 * Por qué existe: el cron syncDropiOrdersHourly corría ciclos solapados (lock
 * roto) y las integraciones del final de la lista recibían ~1 visita al día;
 * las órdenes de la noche quedaban sin aviso y el chat parado en la columna
 * anterior (caso cfg 793, 2026-09-03). No consulta Dropi: trabaja con el
 * `order_data` ya cacheado, así que sirve desde local.
 *
 * Ventana: `updated_at` de Dropi dentro de `order_data` (fecha del último
 * cambio de estatus). Los "solo mover" se limitan a 24 h para no pisar
 * columnas que un humano ya movió.
 *
 * Uso:
 *   node scripts/reenviarPlantillasDropiPerdidas.js                 (dry-run, todas)
 *   node scripts/reenviarPlantillasDropiPerdidas.js --cfg=793       (dry-run, una)
 *   node scripts/reenviarPlantillasDropiPerdidas.js --horas=48 --apply
 */

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
});

const { db } = require('../src/database/config');
const {
  mapDropiStatusToEstadoConfig,
  getPlantillasActivas,
  procesarTemplates,
} = require('../src/services/dropi_notifier.service');

const args = process.argv.slice(2);
const arg = (k) =>
  (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const CFG = Number(arg('cfg')) || null;
const HORAS = Number(arg('horas')) || 48;
const HORAS_SOLO_MOVER = 24;
const APPLY = args.includes('--apply');

function fmtLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/* Fecha del último cambio de estatus según Dropi. El cron la guarda en hora
   local sin zona ("2026-09-03T07:18:22"); el webhook puede traerla en UTC con
   Z. Se normaliza a ms epoch tratando la local como -05:00. */
function fechaCambioMs(order) {
  const raw = order?.updated_at || order?.created_at;
  if (!raw) return null;
  const s = String(raw);
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + '-05:00').getTime();
}

async function yaEnviado(dropi_order_id, id_configuracion, estado) {
  const [row] = await db.query(
    `SELECT id FROM dropi_plantillas_enviadas
      WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?
      LIMIT 1`,
    {
      replacements: [dropi_order_id, id_configuracion, estado],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

async function candidatasDeConfig(integ, ahoraMs) {
  const cfg = Number(integ.id_configuracion);
  const plantillas = await getPlantillasActivas(cfg);
  if (!Object.keys(plantillas).length) return { cfg, orders: [], porEstado: {} };

  const desde = new Date(ahoraMs - HORAS * 3600 * 1000);
  // Filtro grueso en SQL por la fecha de Dropi (string ISO local; el orden
  // lexicográfico coincide con el cronológico). El fino va en JS.
  const rows = await db.query(
    `SELECT dropi_order_id, status, phone, shipping_guide, total_order,
            order_created_at, order_data
       FROM dropi_orders_cache
      WHERE id_configuracion = ? AND id_usuario = 0
        AND order_data IS NOT NULL
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.updated_at')),
                     JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.created_at')), '')
            >= ?
      ORDER BY dropi_order_id ASC`,
    { replacements: [cfg, fmtLocal(desde)], type: db.QueryTypes.SELECT },
  );

  const orders = [];
  const porEstado = {};
  for (const r of rows) {
    let order;
    try {
      order = JSON.parse(r.order_data);
    } catch (_) {
      continue;
    }
    if (!order || typeof order !== 'object') continue;
    // Garantiza los campos que procesarTemplates lee aunque el JSON venga
    // de una fuente distinta al listado del cron.
    order.id = Number(r.dropi_order_id);
    order.status = order.status || r.status;
    order.phone = order.phone || r.phone;
    order.shipping_guide = order.shipping_guide || r.shipping_guide;
    order.total_order = order.total_order ?? r.total_order;
    order.created_at = order.created_at || r.order_created_at;

    const estado = mapDropiStatusToEstadoConfig(order.status);
    const cfgEstado = estado ? plantillas[estado] : null;
    if (!cfgEstado) continue;

    const cambioMs = fechaCambioMs(order);
    if (!cambioMs) continue;
    const horas = (ahoraMs - cambioMs) / 3600000;
    if (horas > HORAS) continue;

    if (cfgEstado.solo_mover) {
      if (horas > HORAS_SOLO_MOVER) continue;
    } else if (await yaEnviado(order.id, cfg, estado)) {
      continue;
    }

    orders.push(order);
    const k = cfgEstado.solo_mover ? `${estado} (solo mover)` : estado;
    porEstado[k] = (porEstado[k] || 0) + 1;
  }
  return { cfg, orders, porEstado };
}

(async () => {
  const ahoraMs = Date.now();
  console.log(
    `${APPLY ? 'APLICANDO' : 'DRY-RUN'} · ventana ${HORAS}h (solo mover ${HORAS_SOLO_MOVER}h)` +
      (CFG ? ` · cfg ${CFG}` : ' · todas las configs'),
  );

  const integs = await db.query(
    `SELECT di.id, di.id_configuracion, di.country_code
       FROM dropi_integrations di
       JOIN configuraciones c ON c.id = di.id_configuracion
      WHERE di.is_active = 1 AND di.deleted_at IS NULL
        AND di.id_configuracion > 0
        AND COALESCE(c.suspendido, 0) = 0
        ${CFG ? 'AND di.id_configuracion = ?' : ''}
      ORDER BY di.id_configuracion`,
    { replacements: CFG ? [CFG] : [], type: db.QueryTypes.SELECT },
  );

  let totalOrdenes = 0;
  const totales = { enviados: 0, omitidos: 0, errores: 0, entregadas: 0 };
  const plan = [];
  for (const integ of integs) {
    const c = await candidatasDeConfig(integ, ahoraMs);
    if (!c.orders.length) continue;
    totalOrdenes += c.orders.length;
    plan.push({ integ, ...c });
    console.log(
      `cfg ${c.cfg} (${integ.country_code}): ${c.orders.length} → ` +
        Object.entries(c.porEstado)
          .map(([k, v]) => `${k}=${v}`)
          .join(', '),
    );
  }
  console.log(`\nTotal: ${totalOrdenes} órdenes en ${plan.length} configs.`);

  if (!APPLY) {
    console.log('Dry-run: nada enviado. Agrega --apply para ejecutar.');
    process.exit(0);
  }

  for (const p of plan) {
    try {
      const r = await procesarTemplates({
        orders: p.orders,
        id_configuracion: p.cfg,
        country_code: p.integ.country_code || 'EC',
      });
      totales.enviados += r.enviados || 0;
      totales.omitidos += r.omitidos || 0;
      totales.errores += r.errores || 0;
      totales.entregadas += r.entregadas_actualizadas || 0;
      console.log(
        `cfg ${p.cfg}: enviados=${r.enviados} omitidos=${r.omitidos} errores=${r.errores} entregadas=${r.entregadas_actualizadas}`,
      );
    } catch (err) {
      console.error(`cfg ${p.cfg}: ERROR ${err?.message}`);
    }
  }
  console.log('\nResumen:', JSON.stringify(totales));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
