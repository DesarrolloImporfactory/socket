/**
 * scripts/consolidarIntegracionDropi.js
 *
 * Deja UNA sola integración Dropi por tienda: la de configuración. Cuando
 * una cuenta tiene además la integración "a nivel usuario" de la misma
 * tienda Dropi (mismo dropi_user_id), las dos mantienen cachés separadas
 * que se desincronizan, y las métricas manuales (gasto en ads, mensajes)
 * quedan repartidas: metricas-internas y el Dropiboard suelto toman la
 * primera del listado (la más nueva) y conexion-dashboard la de la config,
 * así que el cliente ve números distintos según por dónde entre.
 *
 * Caso origen (2026-09-15): cfg 322 / usuario 951 ("ChullaTiendaEc"): 127
 * días de gasto manual registrados bajo la integración de usuario y solo 2
 * bajo la de configuración.
 *
 * Qué hace (con --apply; sin él solo muestra el plan):
 *   1. Verifica que ambas integraciones estén activas y apunten al MISMO
 *      dropi_user_id (si no, aborta: no son la misma tienda).
 *   2. Mueve las métricas manuales de (0, usuario) a (cfg, 0). Si un día
 *      existe en las dos, manda la de usuario (es la que el cliente
 *      alimenta) y se borra la duplicada.
 *   3. Desactiva la integración de usuario (is_active=0, deleted_at=NOW()),
 *      igual que el botón "eliminar" del front. Sus filas de caché quedan
 *      huérfanas: ningún endpoint las lee y no estorban.
 *
 * Uso:
 *   node scripts/consolidarIntegracionDropi.js --cfg=322 --usuario=951
 *   node scripts/consolidarIntegracionDropi.js --cfg=322 --usuario=951 --apply
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const args = process.argv.slice(2);
const arg = (k) =>
  (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const APPLY = args.includes('--apply');
const CFG = Number(arg('cfg'));
const USUARIO = Number(arg('usuario'));

const q = (sql, r = {}) =>
  db.query(sql, { replacements: r, type: db.QueryTypes.SELECT });

(async () => {
  if (!CFG || !USUARIO) {
    console.error('Uso: --cfg=<id_configuracion> --usuario=<id_usuario> [--apply]');
    process.exit(1);
  }
  console.log(
    `${APPLY ? 'APLICANDO' : 'SIMULACIÓN'} · cfg ${CFG} · usuario ${USUARIO}`,
  );

  const [cfgRow] = await q(
    `SELECT id, id_usuario FROM configuraciones WHERE id = :cfg`,
    { cfg: CFG },
  );
  if (!cfgRow) throw new Error(`La configuración ${CFG} no existe`);
  if (Number(cfgRow.id_usuario) !== USUARIO) {
    throw new Error(
      `La configuración ${CFG} pertenece al usuario ${cfgRow.id_usuario}, no al ${USUARIO}`,
    );
  }

  const [integCfg] = await q(
    `SELECT id, store_name, dropi_user_id, country_code
       FROM dropi_integrations
      WHERE id_configuracion = :cfg AND is_active = 1 AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    { cfg: CFG },
  );
  const [integUsr] = await q(
    `SELECT id, store_name, dropi_user_id, country_code
       FROM dropi_integrations
      WHERE id_usuario = :usr AND (id_configuracion IS NULL OR id_configuracion = 0)
        AND is_active = 1 AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    { usr: USUARIO },
  );
  console.log('Integración de configuración:', integCfg || 'NO HAY');
  console.log('Integración de usuario:      ', integUsr || 'NO HAY');
  if (!integCfg || !integUsr) {
    console.log('Nada que consolidar.');
    process.exit(0);
  }
  if (
    !integCfg.dropi_user_id ||
    String(integCfg.dropi_user_id) !== String(integUsr.dropi_user_id)
  ) {
    throw new Error(
      `dropi_user_id distinto (${integCfg.dropi_user_id} vs ${integUsr.dropi_user_id}): NO es la misma tienda, no se toca.`,
    );
  }

  // ── Métricas manuales ──
  const deUsuario = await q(
    `SELECT id, DATE_FORMAT(fecha,'%Y-%m-%d') f, gasto_diario, num_mensajes, gastos_adicionales
       FROM dropi_daily_metrics WHERE id_configuracion = 0 AND id_usuario = :usr`,
    { usr: USUARIO },
  );
  const deConfig = await q(
    `SELECT id, DATE_FORMAT(fecha,'%Y-%m-%d') f, gasto_diario, num_mensajes, gastos_adicionales
       FROM dropi_daily_metrics WHERE id_configuracion = :cfg AND id_usuario = 0`,
    { cfg: CFG },
  );
  const porFechaCfg = new Map(deConfig.map((r) => [r.f, r]));
  const conflictos = deUsuario.filter((r) => porFechaCfg.has(r.f));
  const mover = deUsuario.filter((r) => !porFechaCfg.has(r.f));
  console.log(
    `Métricas manuales: ${deUsuario.length} bajo usuario, ${deConfig.length} bajo config → mover ${mover.length}, resolver ${conflictos.length} conflicto(s) (gana usuario):`,
  );
  for (const c of conflictos) {
    const k = porFechaCfg.get(c.f);
    console.log(
      `  ${c.f}: config gasto ${k.gasto_diario}/msgs ${k.num_mensajes} → usuario gasto ${c.gasto_diario}/msgs ${c.num_mensajes}`,
    );
  }

  if (!APPLY) {
    console.log(
      `\nSimulación terminada. Con --apply: se mueven/resuelven las métricas y se desactiva la integración #${integUsr.id}.`,
    );
    process.exit(0);
  }

  const t = await db.transaction();
  try {
    for (const c of conflictos) {
      const k = porFechaCfg.get(c.f);
      await db.query(
        `UPDATE dropi_daily_metrics
            SET gasto_diario = :g, num_mensajes = :m, gastos_adicionales = :a, updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: {
            g: c.gasto_diario,
            m: c.num_mensajes,
            a: c.gastos_adicionales,
            id: k.id,
          },
          transaction: t,
        },
      );
      await db.query(`DELETE FROM dropi_daily_metrics WHERE id = :id`, {
        replacements: { id: c.id },
        transaction: t,
      });
    }
    if (mover.length) {
      await db.query(
        `UPDATE dropi_daily_metrics
            SET id_configuracion = :cfg, id_usuario = 0, updated_at = NOW()
          WHERE id IN (:ids)`,
        { replacements: { cfg: CFG, ids: mover.map((r) => r.id) }, transaction: t },
      );
    }
    await db.query(
      `UPDATE dropi_integrations
          SET is_active = 0, deleted_at = NOW(), updated_at = NOW()
        WHERE id = :id`,
      { replacements: { id: integUsr.id }, transaction: t },
    );
    await t.commit();
  } catch (e) {
    await t.rollback();
    throw e;
  }

  const [chk] = await q(
    `SELECT COUNT(*) n, ROUND(SUM(gasto_diario),2) gasto FROM dropi_daily_metrics
      WHERE id_configuracion = :cfg AND id_usuario = 0`,
    { cfg: CFG },
  );
  console.log(
    `\nListo. Métricas manuales bajo la config ${CFG}: ${chk.n} días, gasto total ${chk.gasto}. Integración #${integUsr.id} desactivada.`,
  );
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
