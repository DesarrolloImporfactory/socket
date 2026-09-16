/**
 * Cron de salud de los números de WhatsApp (configuraciones.wa_status).
 *
 * Cada 6 horas pregunta a Meta el estado real del número de cada conexión
 * activa y lo guarda en wa_status. Con eso /conexiones deja de decir
 * "Conectado" a números que Meta ya tiene DISCONNECTED, PENDING o sin acceso
 * (caso cfg 1071 del 2026-09-16: 6 días muerto sin que nadie lo viera).
 *
 * Freno por límites de Graph (ver revisarTodas en
 * services/whatsapp_numero_health.service.js): una llamada por conexión con
 * pausa de 1,5 s, y la pasada se corta si Meta devuelve rate limit o los
 * headers de uso pasan del 75 %. Lo que no alcance a revisar queda para la
 * siguiente pasada (se ordena por wa_status_at más viejo primero).
 */

const cron = require('node-cron');
const { db } = require('../database/config');
const { revisarTodas } = require('../services/whatsapp_numero_health.service');

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) {
      console.log('[cron-wa-health] Lock ocupado, saltando ejecución');
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
  console.log('[cron-wa-health] 🔎 Revisando números de WhatsApp en Meta...');

  const r = await revisarTodas({
    pausaMs: 1500,
    umbralUso: 75,
    omitirRevisadasMin: 60,
  });

  const segundos = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[cron-wa-health] ✅ ${r.revisadas}/${r.pendientes} conexiones en ${segundos}s | ` +
      `definitivas=${r.definitivas} cambios=${r.cambios.length} usoMax=${r.usoMax}% | ` +
      Object.entries(r.porEstado)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );
  if (r.detenido) {
    console.warn(`[cron-wa-health] ⏸️  Pasada detenida por ${r.detenido}`);
  }
  for (const c of r.cambios) {
    console.warn(
      `[cron-wa-health] ⚠️  cfg=${c.id} "${c.nombre || ''}" ${c.de || 'NULL'} → ${c.a}` +
        (c.detalle ? ` · ${c.detalle}` : ''),
    );
  }
}

// Cada 6 horas a los :20 (hora Ecuador): 00:20, 06:20, 12:20 y 18:20. Fuera
// del pico de la madrugada que usan los syncs de Dropi (04:00/04:30).
cron.schedule(
  '20 */6 * * *',
  async () => {
    try {
      await withLock('whatsapp_numeros_health_lock', ejecutarChequeo);
    } catch (err) {
      console.error('[cron-wa-health] ❌ Error:', err.message);
    }
  },
  { timezone: 'America/Guayaquil' },
);

console.log(
  '[cron-wa-health] ✅ Cron de salud de números iniciado (cada 6 h, :20 America/Guayaquil)',
);

module.exports = { ejecutarChequeo };
