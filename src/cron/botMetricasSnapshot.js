// cron/botMetricasSnapshot.js
// Recalcula el snapshot de rendimiento del bot (bot_metricas_diarias) una vez
// al día, en madrugada para no competir con el tráfico. Recalcula la ventana
// completa de 35 días —no solo ayer— porque las órdenes Dropi se sincronizan
// por horas y sus estados (entregada/cancelada) cambian días después.
const cron = require('node-cron');
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const { recalcularVentana } = require('../services/botMetricas.service');

async function withLock(lockName, fn) {
  const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
    replacements: [lockName],
    type: QueryTypes.SELECT,
  });
  if (!row || Number(row.got) !== 1) return;
  try {
    await fn();
  } finally {
    await db.query(`DO RELEASE_LOCK(?)`, {
      replacements: [lockName],
      type: QueryTypes.RAW,
    });
  }
}

async function ejecutarSnapshotBot() {
  try {
    console.log('[cron-bot-metricas] 🤖 Recalculando salud del bot...');
    const r = await recalcularVentana(35);
    console.log(
      `[cron-bot-metricas] ✅ ${r.filas} filas de ${r.cuentas} cuentas en ${r.segundos}s (ventana ${r.dias_ventana} días)`,
    );
  } catch (err) {
    console.error('[cron-bot-metricas] ❌ Error:', err.message);
  }
}

// Todos los días a las 03:20 hora Ecuador
cron.schedule(
  '20 3 * * *',
  async () => {
    await withLock('bot_metricas_snapshot_lock', ejecutarSnapshotBot);
  },
  { timezone: 'America/Guayaquil' },
);

console.log(
  '[cron-bot-metricas] ✅ Cron de salud del bot iniciado (03:20 America/Guayaquil)',
);

module.exports = { ejecutarSnapshotBot };
