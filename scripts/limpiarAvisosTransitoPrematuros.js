'use strict';

/**
 * scripts/limpiarAvisosTransitoPrematuros.js
 *
 * Borra los reclamos de "EN TRANSITO" que se escribieron mientras el mapeo roto
 * estuvo desplegado (commit af72cca, 2026-09-11 10:00), para que el aviso vuelva
 * a salir cuando el pedido llegue de verdad a la última milla.
 *
 * Qué pasó: durante esa ventana, `mapDropiStatusToEstadoConfig` mandaba la
 * plantilla "EN TRANSITO" con el PRIMER movimiento logístico (recolección,
 * bodega, centro logístico), que ocurre el mismo día en que se genera la guía.
 * Como el dedupe es por (orden, config, estado), esa fila bloquea para siempre
 * el aviso bueno — el de "tu pedido está por llegar".
 *
 * Qué borra: solo las filas 'EN TRANSITO' de la ventana cuya orden TODAVÍA no
 * llegó al momento del aviso (hoy sigue en pendiente / guía generada / tránsito
 * interno). Si la orden ya está en reparto, entregada, devuelta o cancelada, la
 * fila se deja: reenviar ahí sería un mensaje tardío o duplicado.
 *
 * Uso:
 *   node scripts/limpiarAvisosTransitoPrematuros.js                (dry-run, todas)
 *   node scripts/limpiarAvisosTransitoPrematuros.js --cfg=793      (dry-run, una)
 *   node scripts/limpiarAvisosTransitoPrematuros.js --apply
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
const CFG = Number(arg('cfg')) || null;
const DESDE = arg('desde') || '2026-09-11 10:00:00';
const APPLY = args.includes('--apply');

// El aviso de última milla todavía está por llegar en estas clases.
const AUN_NO_LLEGO = new Set(['pendiente', 'guia_generada', 'en_transito']);

(async () => {
  const filas = await db.query(
    `SELECT e.id, e.dropi_order_id, e.id_configuracion, e.phone, e.sent_at,
            c.status AS status_actual
       FROM dropi_plantillas_enviadas e
       LEFT JOIN dropi_orders_cache c
              ON c.dropi_order_id = e.dropi_order_id
             AND c.id_configuracion = e.id_configuracion
      WHERE e.estado_dropi = 'EN TRANSITO'
        AND e.sent_at >= ?
        ${CFG ? 'AND e.id_configuracion = ?' : ''}
      ORDER BY e.id_configuracion, e.id`,
    {
      replacements: CFG ? [DESDE, CFG] : [DESDE],
      type: db.QueryTypes.SELECT,
    },
  );

  const aBorrar = [];
  const seQuedan = [];
  for (const f of filas) {
    // Sin fila en el cache no se puede saber dónde va la orden: no se toca.
    if (!f.status_actual) {
      seQuedan.push({ ...f, motivo: 'sin estado en el cache' });
      continue;
    }
    const clase = classifyDropiStatus(f.status_actual);
    if (AUN_NO_LLEGO.has(clase)) aBorrar.push({ ...f, clase });
    else seQuedan.push({ ...f, motivo: `ya está en "${f.status_actual}"` });
  }

  const porConfig = {};
  for (const f of aBorrar)
    porConfig[f.id_configuracion] = (porConfig[f.id_configuracion] || 0) + 1;

  console.log(`Reclamos 'EN TRANSITO' desde ${DESDE}: ${filas.length}`);
  console.log(`  · se liberan (el aviso aún no llegó): ${aBorrar.length}`);
  console.log(`  · se dejan como están:                ${seQuedan.length}`);
  console.log('\nPor configuración:');
  for (const [cfg, n] of Object.entries(porConfig).sort((a, b) => b[1] - a[1]))
    console.log(`  cfg ${cfg}: ${n}`);

  if (!APPLY) {
    console.log('\n(dry-run: no se borró nada; agregá --apply)');
    process.exit(0);
  }

  let borradas = 0;
  for (const lote of trozos(aBorrar.map((f) => f.id), 200)) {
    const [, meta] = await db.query(
      `DELETE FROM dropi_plantillas_enviadas WHERE id IN (${lote.map(() => '?').join(',')})`,
      { replacements: lote },
    );
    borradas += Number(meta?.affectedRows || meta || 0);
  }
  console.log(`\nListo: ${borradas} reclamos liberados.`);
  process.exit(0);
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});

function trozos(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
