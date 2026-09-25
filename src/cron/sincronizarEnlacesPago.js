const cron = require('node-cron');
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const { sincronizarPendientes } = require('../services/pagos_stripe.service');

/**
 * Cada 10 minutos consulta en Stripe los enlaces de pago pendientes (con la
 * llave de cada cuenta) y marca los que ya se pagaron o anularon. Es el
 * respaldo de la consulta que se hace al abrir el chat: así el asesor se
 * entera del pago aunque no tenga la conversación abierta (PAGO_RECIBIDO por
 * socket lo emite el servicio).
 *
 * No exige webhook al cliente. Filas con más de 90 días pendientes o
 * consultadas hace menos de 9 min se saltan (ver sincronizarPendientes).
 */

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

cron.schedule('*/5 * * * *', async () => {
  await withLock('cron_enlaces_pago', async () => {
    try {
      const r = await sincronizarPendientes({ minutos: 4, limite: 300 });
      if (r.revisados) {
        console.log(
          `[enlaces_pago] revisados=${r.revisados} pagados=${r.pagados}`,
        );
      }
    } catch (e) {
      console.error('[enlaces_pago] cron falló:', e?.message);
    }
  });
});
