// cron/consumoIaDiario.js
// Pone al día el resumen diario del consumo de IA (consumo_ia_diario) de las
// cuentas que ya abrieron el panel: resume el día que acaba de cerrar para que
// la próxima entrada no tenga que leerlo de mensajes_clientes, y borra lo que
// pasó la retención. En madrugada, una cuenta a la vez. El porqué del resumen
// está en services/consumo_ia_diario.service.js.
const cron = require('node-cron');
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const { ponerAlDia } = require('../services/consumo_ia_diario.service');

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

async function ejecutarConsumoIaDiario() {
  try {
    const t = Date.now();
    const r = await ponerAlDia();
    console.log(
      `[cron-consumo-ia] ✅ ${r.cuentas} cuentas al día, ${r.leidos} mensajes resumidos, ${r.fallas || 0} fallas en ${Math.round((Date.now() - t) / 1000)}s`,
    );
  } catch (err) {
    console.error('[cron-consumo-ia] ❌ Error:', err.message);
  }
}

// Todos los días a las 03:40 hora Ecuador
cron.schedule(
  '40 3 * * *',
  async () => {
    await withLock('consumo_ia_diario_lock', ejecutarConsumoIaDiario);
  },
  { timezone: 'America/Guayaquil' },
);

console.log(
  '[cron-consumo-ia] ✅ Cron del resumen diario de consumo de IA iniciado (03:40 America/Guayaquil)',
);

module.exports = { ejecutarConsumoIaDiario };
