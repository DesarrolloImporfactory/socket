const cron = require('node-cron');
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const {
  calcularSnapshot,
  guardarSnapshot,
} = require('../services/metricas.service');

async function withLock(lockName, fn) {
  const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
    replacements: [lockName],
    type: QueryTypes.SELECT,
  });
  if (!row || Number(row.got) !== 1) {
    return;
  }
  try {
    await fn();
  } finally {
    await db.query(`DO RELEASE_LOCK(?)`, {
      replacements: [lockName],
      type: QueryTypes.RAW,
    });
  }
}

async function ejecutarSnapshotDiario() {
  try {
    console.log('[cron-metricas] 📊 Iniciando snapshot diario...');
    const snap = await calcularSnapshot(null, false);
    await guardarSnapshot(snap);
    console.log(
      `[cron-metricas] ✅ ${snap.fecha_snapshot} | MRR=$${Number(snap.mrr).toFixed(2)} | Activos=${snap.clientes_activos} | Cortesias=${snap.clientes_cortesia} | Trial=${snap.clientes_trial} | Nuevos=${snap.nuevos_dia} | Cancel=${snap.cancelados_dia}`,
    );
  } catch (err) {
    console.error('[cron-metricas] ❌ Error:', err.message);
  }
}

// Corre todos los días a las 23:55 hora Ecuador
cron.schedule(
  '55 23 * * *',
  async () => {
    await withLock('metricas_snapshot_lock', ejecutarSnapshotDiario);
  },
  { timezone: 'America/Guayaquil' },
);

console.log(
  '[cron-metricas] ✅ Cron de snapshot de métricas iniciado (23:55 America/Guayaquil)',
);

module.exports = { ejecutarSnapshotDiario };
