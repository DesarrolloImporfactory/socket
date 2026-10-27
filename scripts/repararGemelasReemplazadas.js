/**
 * scripts/repararGemelasReemplazadas.js
 *
 * Marca como REEMPLAZADA las órdenes del cache que quedaron congeladas en
 * PENDIENTE CONFIRMACION aunque Dropi ya las reemplazó.
 *
 * Por qué pasa: Dropi no edita una orden en sitio. Al confirmarla con un
 * cambio (transportadora, datos) crea una orden NUEVA con el mismo
 * order_created_at y marca la vieja como REEMPLAZADA, pero el listado
 * /orders/myorders por "fecha de cambio de estatus" ya no devuelve la vieja
 * y el webhook tampoco la manda. El cache la dejaba en PENDIENTE
 * CONFIRMACION para siempre: /pedidos y el panel del chat mostraban
 * pendientes que no existían y el aviso de duplicado las emparejaba con su
 * gemela real. Caso: cfg 277, 1.460 de 1.499 pendientes eran fantasmas
 * (27-10-2026); 1.484 en 19 cuentas en 90 días.
 *
 * Desde el fix, upsertOrders (cron + webhook) y upsertOrdersToCache (listado)
 * marcan la gemela al momento. Este script repara el acumulado.
 *
 * Criterio de gemela (el mismo de marcarGemelasReemplazadas en el notifier):
 * misma cuenta, mismo order_created_at exacto, la vieja tiene dropi_order_id
 * menor y sigue en PENDIENTE CONFIRMACION o PENDIENTE (Dropi también deja
 * editar una orden ya confirmada), y coinciden por teléfono (últimos 9
 * dígitos) o, si la edición cambió justo el teléfono, por nombre + apellido
 * + total (casos 7580140→7585293 y 7632250→7658726 de la 277, 27-10-2026).
 *
 * Uso:
 *   node scripts/repararGemelasReemplazadas.js                 (dry-run, todas)
 *   node scripts/repararGemelasReemplazadas.js --cfg=277       (dry-run, una)
 *   node scripts/repararGemelasReemplazadas.js --cfg=277 --apply
 *   node scripts/repararGemelasReemplazadas.js --apply         (todas)
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const {
  classifyDropiStatus,
} = require('../src/services/dropi_notifier.service');

const args = process.argv.slice(2);
const CFG = Number(
  (args.find((a) => a.startsWith('--cfg=')) || '').split('=')[1] || 0,
);
const APPLY = args.includes('--apply');

const GEMELA = `
  JOIN dropi_orders_cache nueva
    ON nueva.id_configuracion = vieja.id_configuracion
   AND nueva.id_usuario = vieja.id_usuario
   AND nueva.order_created_at = vieja.order_created_at
   AND nueva.dropi_order_id > vieja.dropi_order_id
   AND (
     (nueva.phone IS NOT NULL AND nueva.phone <> ''
      AND RIGHT(nueva.phone, 9) = RIGHT(vieja.phone, 9))
     OR (nueva.name IS NOT NULL AND nueva.name <> ''
      AND nueva.name = vieja.name
      AND IFNULL(nueva.surname, '') = IFNULL(vieja.surname, '')
      AND nueva.total_order = vieja.total_order)
   )
 WHERE UPPER(vieja.status) IN ('PENDIENTE CONFIRMACION', 'PENDIENTE')
   ${CFG ? 'AND vieja.id_configuracion = :cfg' : ''}`;
const JOIN = `
  FROM dropi_orders_cache vieja
  ${GEMELA}`;

(async () => {
  const repl = CFG ? { cfg: CFG } : {};

  const resumen = await db.query(
    `SELECT vieja.id_configuracion, vieja.id_usuario,
            SUM(UPPER(vieja.status) = 'PENDIENTE') ya_confirmadas,
            SUM(RIGHT(nueva.phone, 9) <> RIGHT(vieja.phone, 9)) tel_cambiado,
            COUNT(DISTINCT vieja.dropi_order_id) fantasmas,
            MIN(vieja.order_created_at) desde, MAX(vieja.order_created_at) hasta
       ${JOIN}
      GROUP BY vieja.id_configuracion, vieja.id_usuario
      ORDER BY fantasmas DESC`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );
  const total = resumen.reduce((s, r) => s + Number(r.fantasmas), 0);
  console.log(
    `\n${APPLY ? 'APLICANDO' : 'DRY-RUN'} — ${total} gemela(s) en ${resumen.length} cuenta(s)`,
  );
  console.table(resumen);

  const ejemplos = await db.query(
    `SELECT vieja.id_configuracion cfg, vieja.dropi_order_id vieja_id,
            nueva.dropi_order_id nueva_id, nueva.status nueva_status,
            vieja.order_created_at creada, RIGHT(vieja.phone, 9) tel
       ${JOIN}
      ORDER BY vieja.order_created_at DESC
      LIMIT 10`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );
  console.log('\nEjemplos (10 más recientes):');
  console.table(ejemplos);

  if (!APPLY) {
    console.log('\nSin cambios. Agrega --apply para marcar REEMPLAZADA.');
    await db.close();
    return;
  }

  const [, meta] = await db.query(
    `UPDATE dropi_orders_cache vieja
       ${GEMELA.replace(' WHERE ', " SET vieja.status = 'REEMPLAZADA', vieja.classified_status = :cl, vieja.updated_at = NOW() WHERE ")}`,
    {
      replacements: { ...repl, cl: classifyDropiStatus('REEMPLAZADA') },
      type: db.QueryTypes.UPDATE,
    },
  );
  console.log(`\nFilas marcadas REEMPLAZADA: ${meta?.affectedRows ?? meta}`);
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
