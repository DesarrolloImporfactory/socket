/**
 * metaAdsReglasCron.js
 * Cada 30 minutos evalúa las reglas automáticas del Lanzador de campañas
 * (motor propio de Imporchat: pausa anuncios/campañas sin resultados y
 * escala las ganadoras). Misma cadencia que las reglas nativas de Meta,
 * pero con métricas leídas en vivo y bitácora auditable.
 *
 * GET_LOCK global: si hay varias instancias (o un dev local apuntando a la
 * misma BD), solo una corre el ciclo.
 */

const cron = require('node-cron');
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const { evaluarTodas } = require('../services/metaAdsReglas.service');

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

cron.schedule('*/30 * * * *', async () => {
  await withLock('meta_ads_reglas_cron', async () => {
    try {
      const n = await evaluarTodas();
      if (n > 0) {
        console.log(`[cron-reglas-ads] ✅ Reglas evaluadas para ${n} configuraciones`);
      }
    } catch (err) {
      console.error('[cron-reglas-ads] ❌ Error:', err.message);
    }
  });
});

console.log('🎯 Cron de reglas automáticas de Meta Ads registrado (cada 30 min)');
