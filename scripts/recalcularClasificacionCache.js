'use strict';

/**
 * scripts/recalcularClasificacionCache.js
 *
 * Recalcula `dropi_orders_cache.classified_status` con la función vigente
 * (classifyDropiStatus del notifier) para las filas que quedaron desfasadas.
 *
 * Por qué hace falta: la clasificación se escribe en el upsert del cron, así que
 * una fila conserva la clase con la que se guardó hasta que Dropi vuelva a
 * reportar esa orden. Si la orden ya terminó su ciclo, eso no pasa nunca y el
 * dashboard sigue contándola con la clase vieja.
 *
 * Trabaja por grupos (status, classified_status) — son decenas, no miles de
 * queries— y solo toca las filas cuya clase guardada difiere de la correcta.
 *
 * Uso:
 *   node scripts/recalcularClasificacionCache.js            (dry-run, todo el cache)
 *   node scripts/recalcularClasificacionCache.js --dias=90  (dry-run, ventana)
 *   node scripts/recalcularClasificacionCache.js --apply
 */

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
});

const { db } = require('../src/database/config');
const {
  classifyDropiStatus,
} = require('../src/services/dropi_notifier.service');

const args = process.argv.slice(2);
const arg = (k) =>
  (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const DIAS = Number(arg('dias')) || null;
const APPLY = args.includes('--apply');

(async () => {
  const grupos = await db.query(
    `SELECT status, classified_status, COUNT(*) n
       FROM dropi_orders_cache
      ${DIAS ? 'WHERE order_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)' : ''}
      GROUP BY status, classified_status`,
    {
      replacements: DIAS ? [DIAS] : [],
      type: db.QueryTypes.SELECT,
    },
  );

  let total = 0;
  const cambios = [];
  for (const g of grupos) {
    const n = Number(g.n);
    total += n;
    const correcta = classifyDropiStatus(g.status);
    if ((g.classified_status || '') !== correcta)
      cambios.push({ ...g, n, correcta });
  }
  cambios.sort((a, b) => b.n - a.n);

  const aTocar = cambios.reduce((a, c) => a + c.n, 0);
  console.log(
    `Órdenes en el cache${DIAS ? ` (${DIAS} días)` : ' (todo)'}: ${total}`,
  );
  console.log(`Filas a recalcular: ${aTocar} en ${cambios.length} grupos\n`);
  console.log('status'.padEnd(44), 'guardada'.padEnd(15), 'correcta'.padEnd(15), 'n');
  for (const c of cambios)
    console.log(
      String(c.status).slice(0, 42).padEnd(44),
      String(c.classified_status || 'NULL').padEnd(15),
      c.correcta.padEnd(15),
      c.n,
    );

  if (!APPLY) {
    console.log('\n(dry-run: no se actualizó nada; agregá --apply)');
    process.exit(0);
  }

  let actualizadas = 0;
  for (const c of cambios) {
    // `<=>` para que el NULL de classified_status también empareje.
    const [, meta] = await db.query(
      `UPDATE dropi_orders_cache
          SET classified_status = ?
        WHERE status <=> ? AND classified_status <=> ?
        ${DIAS ? 'AND order_created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)' : ''}`,
      {
        replacements: DIAS
          ? [c.correcta, c.status, c.classified_status, DIAS]
          : [c.correcta, c.status, c.classified_status],
      },
    );
    actualizadas += Number(meta?.affectedRows || 0);
  }
  console.log(`\nListo: ${actualizadas} filas recalculadas.`);
  process.exit(0);
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
