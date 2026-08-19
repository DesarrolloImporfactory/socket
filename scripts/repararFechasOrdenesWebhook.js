'use strict';

/**
 * scripts/repararFechasOrdenesWebhook.js
 *
 * Repara los `order_created_at` de `dropi_orders_cache` que quedaron corridos
 * a hora UTC (+5h EC/CO, +6h GT/MX).
 *
 * POR QUÉ EXISTEN FILAS CORRIDAS
 * El webhook de Dropi manda el created_at de la orden en UTC con sufijo Z, y
 * normalizeDropiDate le quitaba la Z sin restar el offset. Como el webhook
 * llega antes que el cron de sync, era quien insertaba la fila — y
 * `order_created_at` no estaba en el updateOnDuplicate, así que la hora mala
 * era eterna aunque el sync trajera después la hora local correcta. Efecto:
 * toda venta posterior a las ~19:00 caía al día siguiente en los dashboards
 * (caso orden 6598607 / atribución de ads de la config 322). El bug de
 * código ya está corregido (dropiDateToLocal); esto sanea el histórico.
 *
 * CÓMO REPARA (dos fases)
 * · Fase A — fuente exacta: si el JSON de `order_data` (que el sync SÍ
 *   refresca con la hora local de la API REST) trae un created_at entre 1 y
 *   12 horas ANTES que la columna, la columna se reescribe con ese valor.
 *   No se calcula nada: se copia la verdad que ya está en la misma fila.
 * · Fase B — imposibilidad física: filas que la Fase A no pudo tocar porque
 *   su order_data también quedó en UTC (nacieron del webhook y ningún sync
 *   las refrescó). Se detectan porque la orden figura "creada" DESPUÉS de
 *   que la fila existiera en la tabla (order_created_at > created_at de la
 *   fila + 30 min), lo cual es imposible: el webhook llega segundos después
 *   de crearse la orden. Se les resta el offset del país de su integración
 *   y solo se aplica si el resultado cae a menos de 6h del created_at de la
 *   fila (el webhook nunca tarda más que eso en insertar).
 *
 * Es idempotente: la Fase A deja columna == JSON (diff 0, ya no matchea) y
 * la Fase B deja la orden "creada" antes que la fila (ya no es imposible).
 *
 * USO
 *   node scripts/repararFechasOrdenesWebhook.js                 → dry-run global
 *   node scripts/repararFechasOrdenesWebhook.js --config 322    → dry-run de una config
 *   node scripts/repararFechasOrdenesWebhook.js --aplicar       → ejecuta los UPDATE
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const cfgIdx = process.argv.indexOf('--config');
const SOLO_CONFIG = cfgIdx > -1 ? Number(process.argv[cfgIdx + 1]) : null;

// Mismos offsets que dropi_webhook_processor.service.js (sin horario de verano).
const OFFSET_PAIS_HORAS = { EC: 5, CO: 5, GT: 6, MX: 6 };

// Se recorre por rangos de PK para no dejar un UPDATE/SELECT gigante
// bloqueando la tabla que usan el chat y los dashboards en vivo.
const CHUNK_IDS = 500000;

const filtroConfig = SOLO_CONFIG
  ? ` AND id_configuracion = ${SOLO_CONFIG} AND id_usuario = 0`
  : '';

async function q(sql, replacements = {}) {
  return db.query(sql, { replacements, type: db.QueryTypes.SELECT });
}

/** Offset horario por entidad del cache (config o usuario), según el país
 *  de su integración Dropi activa. Default 5 (EC/CO). */
async function cargarOffsets() {
  const rows = await q(
    `SELECT COALESCE(id_configuracion, 0) AS idc, COALESCE(id_usuario, 0) AS idu,
            country_code
       FROM dropi_integrations
      WHERE is_active = 1 AND deleted_at IS NULL`,
  );
  const porConfig = new Map();
  const porUsuario = new Map();
  for (const r of rows) {
    const off = OFFSET_PAIS_HORAS[String(r.country_code || 'EC').toUpperCase()] ?? 5;
    if (Number(r.idc)) porConfig.set(Number(r.idc), off);
    else if (Number(r.idu)) porUsuario.set(Number(r.idu), off);
  }
  return { porConfig, porUsuario };
}

async function main() {
  console.log(
    `Modo: ${APLICAR ? 'APLICAR' : 'dry-run'}${SOLO_CONFIG ? ` (solo config ${SOLO_CONFIG})` : ''}`,
  );

  const [rango] = await q(
    `SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM dropi_orders_cache`,
  );
  if (!rango?.max_id) {
    console.log('Tabla vacía, nada que hacer.');
    return;
  }

  const { porConfig, porUsuario } = await cargarOffsets();

  let totalA = 0;
  let totalB = 0;
  const muestrasA = [];
  const muestrasB = [];
  const porEntidad = new Map();

  for (let desde = Number(rango.min_id); desde <= Number(rango.max_id); desde += CHUNK_IDS) {
    const hasta = desde + CHUNK_IDS - 1;

    /* ── Fase A: la columna está 1-12h POR DELANTE del JSON local ── */
    const candidatosA = await q(
      `SELECT id, id_configuracion, id_usuario, dropi_order_id, order_created_at,
              STR_TO_DATE(
                REPLACE(LEFT(JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.created_at')), 19), 'T', ' '),
                '%Y-%m-%d %H:%i:%s'
              ) AS fecha_json
         FROM dropi_orders_cache
        WHERE id BETWEEN :desde AND :hasta${filtroConfig}
          AND order_created_at IS NOT NULL
          AND order_data LIKE '%"created_at"%'
        HAVING fecha_json IS NOT NULL
           AND TIMESTAMPDIFF(SECOND, fecha_json, order_created_at) BETWEEN 3600 AND 43200`,
      { desde, hasta },
    );

    for (const c of candidatosA) {
      totalA++;
      const k = c.id_configuracion > 0 ? `c${c.id_configuracion}` : `u${c.id_usuario}`;
      porEntidad.set(k, (porEntidad.get(k) || 0) + 1);
      if (muestrasA.length < 5) muestrasA.push(c);
      if (APLICAR) {
        await db.query(
          `UPDATE dropi_orders_cache
              SET order_created_at = STR_TO_DATE(
                    REPLACE(LEFT(JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.created_at')), 19), 'T', ' '),
                    '%Y-%m-%d %H:%i:%s'
                  )
            WHERE id = :id`,
          { replacements: { id: c.id }, type: db.QueryTypes.UPDATE },
        );
      }
    }

    /* ── Fase B: orden "creada" después de existir la fila (imposible) ──
       Solo filas donde A no aplicó (su JSON también está en UTC). */
    const candidatosB = await q(
      `SELECT id, id_configuracion, id_usuario, dropi_order_id,
              order_created_at, created_at AS fila_creada,
              STR_TO_DATE(
                REPLACE(LEFT(JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.created_at')), 19), 'T', ' '),
                '%Y-%m-%d %H:%i:%s'
              ) AS fecha_json
         FROM dropi_orders_cache
        WHERE id BETWEEN :desde AND :hasta${filtroConfig}
          AND order_created_at IS NOT NULL
          AND created_at IS NOT NULL
          AND order_created_at > created_at + INTERVAL 30 MINUTE
        HAVING fecha_json IS NULL
            OR TIMESTAMPDIFF(SECOND, fecha_json, order_created_at) NOT BETWEEN 3600 AND 43200`,
      { desde, hasta },
    );

    for (const c of candidatosB) {
      const off =
        (c.id_configuracion > 0
          ? porConfig.get(Number(c.id_configuracion))
          : porUsuario.get(Number(c.id_usuario))) ?? 5;
      const corregida = new Date(new Date(c.order_created_at).getTime() - off * 3600e3);
      const filaCreada = new Date(c.fila_creada);
      // El webhook inserta segundos después de crearse la orden: si tras la
      // corrección la orden no queda a <6h antes de la fila, no es el patrón
      // del bug y se deja quieta (mejor una fila corrida que una inventada).
      const gapMin = (filaCreada - corregida) / 60000;
      if (gapMin < 0 || gapMin > 360) continue;

      totalB++;
      const k = c.id_configuracion > 0 ? `c${c.id_configuracion}` : `u${c.id_usuario}`;
      porEntidad.set(k, (porEntidad.get(k) || 0) + 1);
      if (muestrasB.length < 5) muestrasB.push({ ...c, offset_aplicado: off });
      if (APLICAR) {
        await db.query(
          `UPDATE dropi_orders_cache
              SET order_created_at = order_created_at - INTERVAL :off HOUR
            WHERE id = :id AND order_created_at > created_at + INTERVAL 30 MINUTE`,
          { replacements: { id: c.id, off }, type: db.QueryTypes.UPDATE },
        );
      }
    }

    console.log(
      `ids ${desde}-${hasta}: acumulado A=${totalA} B=${totalB}`,
    );
  }

  console.log('\n══════ RESUMEN ══════');
  console.log(`Fase A (copiar hora local del JSON): ${totalA} filas`);
  console.log(`Fase B (restar offset por imposibilidad): ${totalB} filas`);
  console.log(`Entidades afectadas: ${porEntidad.size}`);
  console.log('\nMuestras Fase A:', JSON.stringify(muestrasA, null, 2));
  console.log('\nMuestras Fase B:', JSON.stringify(muestrasB, null, 2));
  if (!APLICAR) console.log('\nDry-run: nada se modificó. Ejecutar con --aplicar.');
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
