/**
 * scripts/reconciliarColumnasDropi.js
 *
 * Repara contactos que se quedaron en la columna equivocada del kanban
 * cuando el notifier de Dropi perdió el evento de cambio de estado.
 *
 * Por qué se pierden: el cron (syncDropiOrdersHourly) solo trae órdenes con
 * cambio de estatus en las últimas 24h. Si ese día la corrida falla para la
 * integración (429 de Dropi, reinicio, etc.), la ventana pasa y el evento no
 * se reintenta nunca — el camino "solo mover" ni siquiera deja reclamo en
 * dropi_plantillas_enviadas. Caso real: cfg 277, orden 6141381 CANCELADA el
 * 2026-08-24; el chat (593985850962) se quedó en guia_creada.
 *
 * Qué hace: para cada teléfono toma su ÚLTIMA orden del cache (id de Dropi
 * más alto), resuelve la columna destino según dropi_plantillas_config y, si
 * el contacto está en otra columna DEL FLUJO DROPI, lo mueve. Contactos en
 * columnas humanas (asesor, remarketing, contacto_inicial…) NO se tocan:
 * ahí lo puso una persona o el bot, no el notifier.
 *
 * Uso:
 *   node scripts/reconciliarColumnasDropi.js --cfg=277          (dry-run)
 *   node scripts/reconciliarColumnasDropi.js --cfg=277 --apply  (aplica)
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const {
  mapDropiStatusToEstadoConfig,
} = require('../src/services/dropi_notifier.service');

const args = process.argv.slice(2);
const CFG = Number((args.find((a) => a.startsWith('--cfg=')) || '').split('=')[1]);
const APPLY = args.includes('--apply');

if (!CFG) {
  console.error('Uso: node scripts/reconciliarColumnasDropi.js --cfg=<id> [--apply]');
  process.exit(1);
}

(async () => {
  // 1. Config estado → columna destino (solo activos con destino)
  const cfgRows = await db.query(
    `SELECT estado_dropi, columna_destino
       FROM dropi_plantillas_config
      WHERE id_configuracion = :cfg AND proveedor = 'dropi' AND activo = 1
        AND columna_destino IS NOT NULL AND columna_destino != ''`,
    { replacements: { cfg: CFG }, type: db.QueryTypes.SELECT },
  );
  const destinoPorEstado = Object.fromEntries(
    cfgRows.map((r) => [r.estado_dropi, r.columna_destino]),
  );
  if (!Object.keys(destinoPorEstado).length) {
    console.log(`cfg ${CFG}: sin estados con columna_destino activa. Nada que hacer.`);
    process.exit(0);
  }

  // 2. Columnas activas del kanban (los destinos deben existir)
  const cols = await db.query(
    `SELECT estado_db, es_dropi_principal, es_principal
       FROM kanban_columnas WHERE id_configuracion = :cfg AND activo = 1`,
    { replacements: { cfg: CFG }, type: db.QueryTypes.SELECT },
  );
  const colsActivas = new Set(cols.map((c) => c.estado_db));

  /* Solo se mueve a quien está en una columna que EL NOTIFIER administra:
     los destinos configurados + la columna dropi principal. Una columna
     humana implica intervención manual y no se pisa. */
  const columnasFlujo = new Set(Object.values(destinoPorEstado));
  cols
    .filter((c) => c.es_dropi_principal === 1 || c.es_principal === 1)
    .forEach((c) => columnasFlujo.add(c.estado_db));

  // 3. Última orden por teléfono (últimos 9 dígitos)
  const ultimas = await db.query(
    `SELECT oc.dropi_order_id, oc.status,
            RIGHT(REGEXP_REPLACE(COALESCE(oc.phone,''), '[^0-9]', ''), 9) AS p9
       FROM dropi_orders_cache oc
       JOIN (
         SELECT RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', ''), 9) AS p9,
                MAX(dropi_order_id) AS mx
           FROM dropi_orders_cache
          WHERE id_configuracion = :cfg
          GROUP BY p9
       ) t ON t.mx = oc.dropi_order_id
      WHERE oc.id_configuracion = :cfg
        AND CHAR_LENGTH(RIGHT(REGEXP_REPLACE(COALESCE(oc.phone,''), '[^0-9]', ''), 9)) = 9`,
    { replacements: { cfg: CFG }, type: db.QueryTypes.SELECT },
  );

  console.log(`cfg ${CFG}: ${ultimas.length} teléfonos con órdenes en cache.`);

  const movimientos = [];
  const saltados = { sin_destino: 0, ya_bien: 0, sin_cliente: 0, columna_humana: 0 };

  for (const o of ultimas) {
    const estadoConfig = mapDropiStatusToEstadoConfig(o.status);
    const destino = estadoConfig ? destinoPorEstado[estadoConfig] : null;
    if (!destino || !colsActivas.has(destino)) {
      saltados.sin_destino++;
      continue;
    }

    const clientes = await db.query(
      `SELECT id, nombre_cliente, celular_cliente, estado_contacto
         FROM clientes_chat_center
        WHERE id_configuracion = :cfg AND deleted_at IS NULL
          AND celular_cliente LIKE :like`,
      {
        replacements: { cfg: CFG, like: `%${o.p9}` },
        type: db.QueryTypes.SELECT,
      },
    );
    if (!clientes.length) {
      saltados.sin_cliente++;
      continue;
    }

    for (const c of clientes) {
      if (c.estado_contacto === destino) {
        saltados.ya_bien++;
        continue;
      }
      if (c.estado_contacto && !columnasFlujo.has(c.estado_contacto)) {
        saltados.columna_humana++;
        continue;
      }
      movimientos.push({
        id_cliente: c.id,
        nombre: c.nombre_cliente,
        celular: c.celular_cliente,
        orden: o.dropi_order_id,
        estado_dropi: o.status,
        de: c.estado_contacto || '(vacío)',
        a: destino,
      });
    }
  }

  console.log(`\nSaltados: ${JSON.stringify(saltados)}`);
  console.log(`\n${movimientos.length} contacto(s) por mover:`);
  console.table(movimientos);

  if (!APPLY) {
    console.log('\nDRY-RUN: nada se movió. Repite con --apply para aplicar.');
    process.exit(0);
  }

  let movidos = 0;
  for (const m of movimientos) {
    const [, meta] = await db.query(
      `UPDATE clientes_chat_center SET estado_contacto = :a
        WHERE id = :id AND id_configuracion = :cfg`,
      {
        replacements: { a: m.a, id: m.id_cliente, cfg: CFG },
        type: db.QueryTypes.UPDATE,
      },
    );
    movidos += meta?.affectedRows ?? meta ?? 0;
  }
  console.log(`\n✅ ${movidos} contacto(s) movidos.`);
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
