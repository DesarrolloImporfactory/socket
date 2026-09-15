/**
 * scripts/repararOrderDataWebhook.js
 *
 * Repara filas de `dropi_orders_cache` cuyo `order_data.orderdetails` quedó
 * con la forma "flaca" del webhook de Dropi (orderdetails[].price = precio
 * al cliente, SIN product.sale_price = costo proveedor, quantity "2.00").
 * Esa forma dejaba la orden en $0 de venta y costo en el detalle por
 * producto de Métricas Diarias (Dropiboard y /metricas-internas). Desde el
 * 2026-09-15 el webhook ya no pisa los orderdetails ricos y el SQL tolera
 * ambas formas; este script deja la data histórica con la forma completa.
 *
 * Dos fuentes, ambas reales (nunca se inventa un costo):
 *   1. HERMANA: otra fila del cache con el MISMO dropi_order_id (misma
 *      tienda conectada dos veces, por config y por usuario) que sí tiene
 *      los orderdetails del REST. Se copian tal cual. No pega a Dropi.
 *   2. DROPI: GET /orders/myorders/{id} con la llave de la integración
 *      dueña. Se escribe SOLO si el id coincide, el total_order coincide y
 *      el detalle trae product.sale_price. OJO: Dropi valida la IP del
 *      servidor; desde una máquina local responde 401 → correr EN EL
 *      SERVIDOR. Con --sin-dropi se omite este paso.
 *
 * Se saltan las REEMPLAZADA (ya no cuentan en ninguna métrica).
 *
 * Uso:
 *   node scripts/repararOrderDataWebhook.js                      (simulación, todas las cuentas)
 *   node scripts/repararOrderDataWebhook.js --cfg=322             (una configuración)
 *   node scripts/repararOrderDataWebhook.js --usuario=951         (una integración de usuario)
 *   node scripts/repararOrderDataWebhook.js --desde=2026-04-01    (ventana por order_created_at; default 2026-01-01)
 *   node scripts/repararOrderDataWebhook.js --apply               (escribe)
 *   node scripts/repararOrderDataWebhook.js --apply --sin-dropi   (solo paso 1, sirve en local)
 *   node scripts/repararOrderDataWebhook.js --apply --limite=500  (tope de llamadas a Dropi por corrida)
 */

require('dotenv').config();
process.env.DROPI_CRON_SIN_AGENDAR = '1';
const { db } = require('../src/database/config');
const dropiService = require('../src/services/dropi.service');
const { decryptToken } = require('../src/utils/cryptoToken');

const args = process.argv.slice(2);
const arg = (k) =>
  (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const APPLY = args.includes('--apply');
const SIN_DROPI = args.includes('--sin-dropi');
const CFG = Number(arg('cfg')) || null;
const USUARIO = Number(arg('usuario')) || null;
const DESDE = arg('desde') || '2026-01-01';
const LIMITE = Number(arg('limite')) || 400;
const DELAY_DROPI_MS = 1500;

const q = (sql, r = {}) =>
  db.query(sql, { replacements: r, type: db.QueryTypes.SELECT });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return null;
  }
};
const esRico = (od) =>
  Array.isArray(od) &&
  od.length > 0 &&
  od.some((d) => d?.product?.sale_price != null);
const nombres = (od) =>
  JSON.stringify((od || []).map((d) => d?.product?.name).filter(Boolean));

/* Misma orden = mismos productos y mismas cantidades. La forma flaca trae
   product_id y quantity ("2.00"); la rica product.id y quantity (2). Si no
   coinciden, la fuente no es esta orden y NO se escribe. */
const firmaItems = (od) =>
  (Array.isArray(od) ? od : [])
    .map(
      (d) =>
        `${d?.product_id ?? d?.product?.id ?? '?'}x${Math.round(Number(d?.quantity) || 0)}`,
    )
    .sort()
    .join(',');
const mismosItems = (flaco, rico) =>
  firmaItems(flaco) !== '' && firmaItems(flaco) === firmaItems(rico);

async function escribir(fila, orderdetails, fuente) {
  const data = parse(fila.order_data) || {};
  data.orderdetails = orderdetails;
  await db.query(
    `UPDATE dropi_orders_cache
        SET order_data = :od, product_names = :pn, updated_at = NOW()
      WHERE id = :id`,
    {
      replacements: {
        od: JSON.stringify(data),
        pn: nombres(orderdetails),
        id: fila.id,
      },
    },
  );
  return fuente;
}

(async () => {
  console.log(
    `${APPLY ? 'APLICANDO' : 'SIMULACIÓN'} · desde ${DESDE}` +
      (CFG ? ` · cfg ${CFG}` : '') +
      (USUARIO ? ` · usuario ${USUARIO}` : '') +
      (SIN_DROPI ? ' · sin Dropi' : ` · tope Dropi ${LIMITE}`),
  );

  const filtroCtx = CFG
    ? 'AND c.id_configuracion = :cfg AND c.id_usuario = 0'
    : USUARIO
      ? 'AND c.id_configuracion = 0 AND c.id_usuario = :usr'
      : '';

  // Candidatas: forma webhook (sin costo por ítem, con price), no REEMPLAZADA
  const filas = await q(
    `SELECT c.id, c.dropi_order_id, c.id_configuracion, c.id_usuario,
            c.status, c.classified_status, c.total_order, c.order_data
       FROM dropi_orders_cache c
      WHERE c.order_created_at >= :desde
        AND c.status <> 'REEMPLAZADA'
        ${filtroCtx}
        AND JSON_EXTRACT(c.order_data, '$.orderdetails[0].product.sale_price') IS NULL
        AND JSON_EXTRACT(c.order_data, '$.orderdetails[0].price') IS NOT NULL
      ORDER BY c.id_configuracion, c.id_usuario, c.dropi_order_id`,
    { desde: `${DESDE} 00:00:00`, cfg: CFG, usr: USUARIO },
  );
  console.log(`Candidatas con forma webhook: ${filas.length}`);
  if (!filas.length) process.exit(0);

  const porCuenta = new Map();
  for (const f of filas) {
    const k = `cfg ${f.id_configuracion} / usr ${f.id_usuario}`;
    porCuenta.set(k, (porCuenta.get(k) || 0) + 1);
  }
  for (const [k, n] of porCuenta) console.log(`  ${k}: ${n}`);

  // ── Paso 1: hermana rica (misma orden, otra fila) ──
  const ids = [...new Set(filas.map((f) => f.dropi_order_id))];
  const hermanas = new Map(); // dropi_order_id -> { total_order, orderdetails }
  for (let i = 0; i < ids.length; i += 500) {
    const lote = ids.slice(i, i + 500);
    const rows = await q(
      `SELECT dropi_order_id, total_order, order_data
         FROM dropi_orders_cache
        WHERE dropi_order_id IN (:ids)
          AND JSON_EXTRACT(order_data, '$.orderdetails[0].product.sale_price') IS NOT NULL`,
      { ids: lote },
    );
    for (const r of rows) {
      const od = parse(r.order_data)?.orderdetails;
      if (esRico(od) && !hermanas.has(String(r.dropi_order_id))) {
        hermanas.set(String(r.dropi_order_id), {
          total_order: Number(r.total_order),
          orderdetails: od,
        });
      }
    }
  }

  const stats = { hermana: 0, dropi: 0, sin_fuente: 0, invalidas: 0, errores: 0 };
  const pendientesDropi = [];
  for (const f of filas) {
    const h = hermanas.get(String(f.dropi_order_id));
    if (!h) {
      pendientesDropi.push(f);
      continue;
    }
    const flaco = parse(f.order_data)?.orderdetails;
    if (
      Math.abs(h.total_order - Number(f.total_order)) > 0.01 ||
      !mismosItems(flaco, h.orderdetails)
    ) {
      stats.invalidas++;
      console.log(
        `  ! orden ${f.dropi_order_id}: la copia sana no coincide (total ${f.total_order} vs ${h.total_order}; items ${firmaItems(flaco)} vs ${firmaItems(h.orderdetails)}), se deja para Dropi`,
      );
      pendientesDropi.push(f);
      continue;
    }
    stats.hermana++;
    if (APPLY) await escribir(f, h.orderdetails, 'hermana');
  }
  console.log(
    `Paso 1 (copia de la hermana): ${stats.hermana} ${APPLY ? 'reparadas' : 'reparables'} · ${pendientesDropi.length} sin copia sana`,
  );

  // ── Paso 2: Dropi REST ──
  if (SIN_DROPI || !pendientesDropi.length) {
    console.log(
      SIN_DROPI && pendientesDropi.length
        ? `Paso 2 omitido (--sin-dropi): ${pendientesDropi.length} quedan para correr en el servidor.`
        : 'Paso 2: nada pendiente.',
    );
    console.log('RESUMEN', JSON.stringify(stats));
    process.exit(0);
  }

  // Integración dueña por contexto de cache
  const integs = await q(
    `SELECT id, id_configuracion, id_usuario, country_code, integration_key_enc
       FROM dropi_integrations WHERE is_active = 1 AND deleted_at IS NULL`,
  );
  const integPorCtx = new Map();
  for (const i of integs) {
    const k = i.id_configuracion
      ? `${i.id_configuracion}/0`
      : `0/${i.id_usuario}`;
    if (!integPorCtx.has(k)) integPorCtx.set(k, i);
  }

  let llamadas = 0;
  let cortar = false;
  for (const f of pendientesDropi) {
    if (cortar || llamadas >= LIMITE) break;
    const integ = integPorCtx.get(`${f.id_configuracion}/${f.id_usuario}`);
    if (!integ) {
      stats.sin_fuente++;
      continue;
    }
    if (!APPLY) {
      stats.dropi++;
      continue; // en simulación no se pega a Dropi
    }
    let key;
    try {
      key = decryptToken(integ.integration_key_enc);
    } catch {
      stats.sin_fuente++;
      continue;
    }
    llamadas++;
    try {
      const det = await dropiService.getOrderDetail({
        integrationKey: key,
        orderId: f.dropi_order_id,
        country_code: integ.country_code,
      });
      const obj = det?.objects;
      const od = obj?.orderdetails;
      const idOk = String(obj?.id) === String(f.dropi_order_id);
      const totalOk =
        Math.abs(Number(obj?.total_order) - Number(f.total_order)) <= 0.01;
      const itemsOk = mismosItems(parse(f.order_data)?.orderdetails, od);
      if (!idOk || !totalOk || !itemsOk || !esRico(od)) {
        stats.invalidas++;
        console.log(
          `  ! orden ${f.dropi_order_id}: detalle no válido (id ${idOk}, total ${totalOk}, items ${itemsOk}, rico ${esRico(od)}), no se escribe`,
        );
      } else {
        await escribir(f, od, 'dropi');
        stats.dropi++;
      }
    } catch (e) {
      stats.errores++;
      const msg = e?.message || String(e);
      console.log(`  x orden ${f.dropi_order_id}: ${msg}`);
      if (/401|Access denied/i.test(msg)) {
        console.log(
          'Dropi rechaza la IP (401): este paso hay que correrlo en el servidor. Se corta.',
        );
        cortar = true;
      }
    }
    await sleep(DELAY_DROPI_MS);
  }
  const restantes = pendientesDropi.length - stats.dropi - stats.invalidas - stats.sin_fuente - stats.errores;
  console.log(
    `Paso 2 (Dropi): ${stats.dropi} ${APPLY ? 'reparadas' : 'por pedir a Dropi'} · ${stats.invalidas} inválidas · ${stats.sin_fuente} sin integración activa · ${stats.errores} errores · ${Math.max(0, restantes)} fuera del tope`,
  );
  console.log('RESUMEN', JSON.stringify(stats));
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
