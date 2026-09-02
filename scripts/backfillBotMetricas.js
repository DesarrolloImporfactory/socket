// scripts/backfillBotMetricas.js
// Llenado inicial (o re-llenado) del snapshot de salud del bot.
//   node scripts/backfillBotMetricas.js [dias]   (default 60, máx 120)
// Crea la tabla si no existe (sync del modelo) y recalcula la ventana.
process.env.TZ = process.env.TZ || 'America/Guayaquil';
require('dotenv').config();

const BotMetricasDiarias = require('../src/models/bot_metricas_diarias.model');
const { recalcularVentana } = require('../src/services/botMetricas.service');

(async () => {
  const dias = Math.min(Math.max(Number(process.argv[2]) || 60, 1), 120);
  console.log(`Backfill de bot_metricas_diarias: últimos ${dias} días...`);
  await BotMetricasDiarias.sync();
  const r = await recalcularVentana(dias);
  console.log(
    `✅ ${r.filas} filas de ${r.cuentas} cuentas en ${r.segundos}s (ventana ${r.dias_ventana} días)`,
  );
  process.exit(0);
})().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
