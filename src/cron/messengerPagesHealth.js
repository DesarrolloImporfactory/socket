/**
 * Cron de salud de conexiones de páginas de Facebook.
 *
 * Corre una vez al día y marca como 'revoked' las páginas cuyo
 * page_access_token Meta ya invalidó. Sin esto, `messenger_pages.status` se
 * queda en 'active' para siempre y los envíos salientes de Messenger fallan en
 * silencio (ver messenger_pages_health.service.js).
 */

const cron = require('node-cron');
const { db } = require('../database/config');
const {
  revisarPaginas,
  revisarInstagram,
} = require('../services/messenger_pages_health.service');

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) {
      console.log('[cron-ms-health] Lock ocupado, saltando ejecución');
      return;
    }
    try {
      await fn();
    } finally {
      await db.query(`DO RELEASE_LOCK(?)`, {
        replacements: [lockName],
        type: db.QueryTypes.RAW,
      });
    }
  } finally {
    db.connectionManager.releaseConnection(conn);
  }
}

async function ejecutarChequeo() {
  const t0 = Date.now();
  console.log('[cron-ms-health] 🔎 Revisando conexiones de páginas...');

  // Solo diagnostica: guarda token_valido / token_error y NO toca `status`.
  // Cambiar status a 'revoked' rompería el enrutamiento de mensajes entrantes
  // (ver la advertencia en messenger_pages_health.service.js).
  const { resumen, resultados } = await revisarPaginas({
    persistir: true,
    marcarRevoked: false,
  });

  const segundos = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[cron-ms-health] ✅ ${resumen.total} páginas en ${segundos}s | ` +
      `sanas=${resumen.sanas} muertas=${resumen.muertas} ` +
      `indeterminadas=${resumen.indeterminadas} | ` +
      `leen_feed=${resumen.pueden_leer_feed} manage_engagement=${resumen.con_manage_engagement}`,
  );

  for (const r of resultados.filter((x) => x.token_valido === false)) {
    console.warn(
      `[cron-ms-health] ⚠️  cfg=${r.id_configuracion} "${r.page_name}" ` +
        `(page_id=${r.page_id}) → ${r.token_error}`,
    );
  }

  // Instagram guarda su propio token de página y hasta el 10-11-2026 nadie
  // lo revisaba. Va en su try: un fallo acá no debe tapar lo de Messenger.
  try {
    const ig = await revisarInstagram({ persistir: true });
    console.log(
      `[cron-ms-health] ✅ Instagram: ${ig.resumen.total} conexiones | ` +
        `sanas=${ig.resumen.sanas} muertas=${ig.resumen.muertas} ` +
        `indeterminadas=${ig.resumen.indeterminadas}`,
    );
    for (const r of ig.resultados.filter((x) => x.token_valido === false)) {
      console.warn(
        `[cron-ms-health] ⚠️  Instagram cfg=${r.id_configuracion} ` +
          `"${r.ig_username || r.page_name}" (page_id=${r.page_id}) → ${r.token_error}`,
      );
    }
  } catch (err) {
    console.error('[cron-ms-health] ❌ Instagram:', err.message);
  }
}

// Todos los días a las 04:30 hora Ecuador: fuera del pico y después del
// sync de stock de Dropi (04:00), para no solaparse.
cron.schedule(
  '30 4 * * *',
  async () => {
    try {
      await withLock('messenger_pages_health_lock', ejecutarChequeo);
    } catch (err) {
      console.error('[cron-ms-health] ❌ Error:', err.message);
    }
  },
  { timezone: 'America/Guayaquil' },
);

console.log(
  '[cron-ms-health] ✅ Cron de salud de páginas iniciado (04:30 America/Guayaquil)',
);

module.exports = { ejecutarChequeo };
