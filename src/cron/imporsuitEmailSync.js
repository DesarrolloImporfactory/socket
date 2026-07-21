/**
 * Cron de reconciliación del email de imporsuit hacia clientes_chat_center.
 *
 * Por qué un cron y no solo un hook: los clientes se crean desde ~22 puntos en
 * Node Y desde ~10 puntos del PHP de imporsuit que escriben SQL directo a la BD
 * chat_center (nunca pasan por Node). Un hook no puede cubrir esos, ni capta el
 * "viceversa" (tienda nueva o email cambiado en imporsuit). El cron sí, porque
 * reconcilia por estado final. Ver imporsuitEmailSync.service.js.
 *
 * Dos pasadas:
 *  - INCREMENTAL (cada 15 min): solo clientes con id > cursor. Barata; capta los
 *    nuevos vengan de donde vengan (Node o PHP).
 *  - COMPLETA (diaria): revisa todo. Capta el viceversa: clientes viejos que
 *    antes no matcheaban y ahora sí (tienda nueva / email cambiado en imporsuit).
 *
 * El cursor vive en memoria y se siembra con MAX(id) al arrancar, así el proceso
 * no re-escanea todo en cada reinicio: la pasada completa diaria es la red de
 * seguridad.
 */
const cron = require('node-cron');
const { db } = require('../database/config');
const { backfill, maxIdCliente } = require('../services/imporsuitEmailSync.service');

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) return; // otro proceso lo está corriendo
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

// Cursor de la pasada incremental. Se siembra en el primer tick tras el arranque.
let cursorId = null;
let isRunning = false;

// Cuántos ids hacia atrás revisar al arrancar, para cubrir el hueco que deja un
// reinicio de PM2 (la app corre en fork = 1 instancia, y puede reiniciarse).
// ~20k ids ≈ menos de 1 h de clientes al ritmo actual; cuesta pocos segundos.
const LOOKBACK_IDS = 20000;

/* ── INCREMENTAL: cada 15 minutos ── */
cron.schedule(
  '*/15 * * * *',
  async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await withLock('imporsuit_email_sync_lock', async () => {
        // Primer tick tras un arranque/reinicio de PM2: NO saltarse el trabajo.
        // Se siembra el cursor con un lookback para cubrir el hueco del reinicio
        // (si se sembrara en MAX(id), con reinicios frecuentes la incremental
        // nunca procesaría nada). El lookback es barato: ~5k filas ≈ 2s.
        if (cursorId === null) {
          const max = await maxIdCliente();
          cursorId = Math.max(0, max - LOOKBACK_IDS);
          console.log(
            `[imporsuitEmailSync] arranque: cursor sembrado en ${cursorId} (max=${max}, lookback=${LOOKBACK_IDS})`,
          );
        }

        const tope = await maxIdCliente();
        if (tope <= cursorId) return; // no hay clientes nuevos

        const r = await backfill({ desdeId: cursorId });
        cursorId = tope; // avanzar al tope capturado ANTES de procesar (no se salta nada)

        if (r.actualizados > 0) {
          console.log('[imporsuitEmailSync] incremental:', r);
        }
      });
    } catch (e) {
      console.error('[imporsuitEmailSync] incremental error:', e?.message || e);
    } finally {
      isRunning = false;
    }
  },
  { timezone: 'America/Guayaquil' },
);

/* ── COMPLETA: diaria 03:20 (capta el viceversa) ── */
cron.schedule(
  '20 3 * * *',
  async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await withLock('imporsuit_email_sync_full_lock', async () => {
        console.log('[imporsuitEmailSync] iniciando pasada COMPLETA…');
        const r = await backfill({ desdeId: 0 });
        console.log('[imporsuitEmailSync] completa:', r);
        // Tras la completa, el cursor queda al día.
        cursorId = await maxIdCliente();
      });
    } catch (e) {
      console.error('[imporsuitEmailSync] completa error:', e?.message || e);
    } finally {
      isRunning = false;
    }
  },
  { timezone: 'America/Guayaquil' },
);

console.log('[imporsuitEmailSync] cron registrado (incremental */15min, completa 03:20)');
