'use strict';

/**
 * scripts/migrate_dropi_user_id.js
 *
 * Migración one-shot (idempotente, se puede correr varias veces):
 *  1. Agrega dropi_integrations.dropi_user_id (BIGINT NULL + índice) si no existe.
 *  2. Backfill: para cada integración activa sin dropi_user_id, muestrea las
 *     últimas 200 órdenes de su cache; si TODAS pertenecen al mismo
 *     order_data.user_id, esa cuenta Dropi es la dueña de la key
 *     (dropshipper) → se asigna. Proveedores (varios user_id) quedan NULL.
 *  3. Reporte de cobertura contra los shop.user_id de los webhooks recientes.
 *
 * El webhook usa esta columna para mapear eventos de órdenes NUEVAS que aún
 * no existen en dropi_orders_cache (típico: PENDIENTE CONFIRMACION).
 * En adelante el cron la mantiene solo (aprenderDropiUserId).
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const SAMPLE_SIZE = 200;

async function ensureColumn() {
  const [col] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'dropi_integrations'
       AND COLUMN_NAME = 'dropi_user_id'`,
    { type: db.QueryTypes.SELECT },
  );
  if (col) {
    console.log('✔ Columna dropi_user_id ya existe');
    return;
  }
  console.log('→ Creando columna dropi_user_id + índice...');
  await db.query(
    `ALTER TABLE dropi_integrations
       ADD COLUMN dropi_user_id BIGINT UNSIGNED NULL DEFAULT NULL
         COMMENT 'user_id de la cuenta Dropi dueña de la key (dropshipper). NULL = desconocido o proveedor',
       ADD INDEX idx_dropi_integrations_user (dropi_user_id)`,
    { type: db.QueryTypes.RAW },
  );
  console.log('✔ Columna creada');
}

async function backfill() {
  const integrations = await db.query(
    `SELECT id, id_configuracion, id_usuario
     FROM dropi_integrations
     WHERE is_active = 1 AND deleted_at IS NULL AND dropi_user_id IS NULL`,
    { type: db.QueryTypes.SELECT },
  );
  console.log(`→ Integraciones a backfillear: ${integrations.length}`);

  let asignadas = 0,
    proveedores = 0,
    sinDatos = 0,
    errores = 0;

  for (const integ of integrations) {
    try {
      const idConfig = Number(integ.id_configuracion || 0);
      const where = idConfig
        ? 'id_configuracion = ? AND id_usuario = 0'
        : 'id_configuracion = 0 AND id_usuario = ?';
      const param = idConfig || Number(integ.id_usuario || 0);

      const rows = await db.query(
        `SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.user_id')) AS uid
         FROM (
           SELECT order_data FROM dropi_orders_cache
           WHERE ${where}
           ORDER BY id DESC
           LIMIT ${SAMPLE_SIZE}
         ) t
         WHERE JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.user_id')) IS NOT NULL`,
        { replacements: [param], type: db.QueryTypes.SELECT },
      );

      const uids = rows.map((r) => Number(r.uid)).filter((v) => v > 0);
      if (!uids.length) {
        sinDatos++;
        continue;
      }
      if (new Set(uids).size !== 1) {
        proveedores++;
        console.log(
          `  · integ#${integ.id} (config ${idConfig || `u${integ.id_usuario}`}): ${new Set(uids).size} user_ids distintos → proveedor, queda NULL`,
        );
        continue;
      }

      await db.query(
        `UPDATE dropi_integrations SET dropi_user_id = ? WHERE id = ? AND dropi_user_id IS NULL`,
        { replacements: [uids[0], integ.id], type: db.QueryTypes.UPDATE },
      );
      asignadas++;
    } catch (err) {
      errores++;
      console.error(`  ✗ integ#${integ.id}: ${err.message}`);
    }
  }

  console.log(
    `✔ Backfill: ${asignadas} asignadas | ${proveedores} proveedores (NULL) | ${sinDatos} sin órdenes en cache | ${errores} errores`,
  );
}

async function reporteCobertura() {
  // ¿Cuántos shop.user_id de los webhooks recientes matchean una integración?
  const cover = await db.query(
    `SELECT
       COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(w.payload, '$.shop.user_id'))) AS dropi_users_webhook,
       COUNT(DISTINCT CASE WHEN di.id IS NOT NULL
             THEN JSON_UNQUOTE(JSON_EXTRACT(w.payload, '$.shop.user_id')) END) AS con_integracion_mapeada
     FROM dropi_webhook_events w
     LEFT JOIN dropi_integrations di
       ON di.dropi_user_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(w.payload, '$.shop.user_id')) AS UNSIGNED)
      AND di.is_active = 1 AND di.deleted_at IS NULL
     WHERE w.created_at >= NOW() - INTERVAL 2 DAY`,
    { type: db.QueryTypes.SELECT },
  );
  console.log('\n=== COBERTURA (webhooks últimos 2 días) ===');
  console.log(JSON.stringify(cover, null, 2));

  const sinMapeo = await db.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(w.payload, '$.shop.user_id')) AS dropi_user,
            COUNT(DISTINCT w.dropi_order_id) AS ordenes
     FROM dropi_webhook_events w
     LEFT JOIN dropi_integrations di
       ON di.dropi_user_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(w.payload, '$.shop.user_id')) AS UNSIGNED)
      AND di.is_active = 1 AND di.deleted_at IS NULL
     WHERE w.created_at >= NOW() - INTERVAL 2 DAY AND di.id IS NULL
     GROUP BY 1 ORDER BY ordenes DESC LIMIT 15`,
    { type: db.QueryTypes.SELECT },
  );
  console.log('\n=== dropi_users de webhooks SIN integración mapeada (top 15) ===');
  console.log(JSON.stringify(sinMapeo, null, 2));
}

(async () => {
  try {
    await ensureColumn();
    await backfill();
    await reporteCobertura();
    process.exit(0);
  } catch (err) {
    console.error('ERROR FATAL:', err.message);
    process.exit(1);
  }
})();
