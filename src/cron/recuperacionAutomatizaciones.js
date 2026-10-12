/**
 * Cron de las automatizaciones de recuperación (pedido 2026-10-12).
 *
 * Cada hora, a y 20, revisa las secuencias ACTIVAS (y ya iniciadas) y encola
 * en template_envios_programados los pasos que tocan; el cron de plantillas
 * programadas (templateProgramadoMasivo) es el que habla con Meta. Nada
 * sale si ninguna automatización está activa: así se despliega apagado y se
 * prende desde la pestaña Automatizaciones de /recuperacion.
 *
 * Horario de envío: solo entre 09:00 y 19:00 hora Ecuador. Un mensaje de
 * cobro a las 3 a. m. no recupera a nadie.
 */
const cron = require('node-cron');
const { db } = require('../database/config');
const { correr } = require('../services/recuperacion_automatizaciones.service');
const { sincronizarCasosGlobal } = require('../services/recuperacion.service');

// Cada hora, todo el día: abre/cierra casos del embudo aunque nadie tenga la
// pantalla abierta. Es lo que hace que "pagó" o "quitó la cancelación" se vea
// en Resultados y se atribuya al asesor sin esperar a que alguien entre.
cron.schedule(
  '35 * * * *',
  async () => {
    try {
      const r = await sincronizarCasosGlobal();
      if (r.abiertos_antes !== r.abiertos_despues) {
        console.log('[recup-casos]', `${r.en_riesgo} en riesgo · casos ${r.abiertos_antes} → ${r.abiertos_despues}`);
      }
    } catch (e) {
      console.error('[recup-casos] error:', e?.message);
    }
  },
  { timezone: 'America/Guayaquil' },
);

const LOCK = 'recuperacion_automatizaciones';

async function withLock(fn) {
  const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
    replacements: [LOCK],
    type: db.QueryTypes.SELECT,
  });
  if (!row || Number(row.got) !== 1) return;
  try {
    await fn();
  } finally {
    await db.query(`DO RELEASE_LOCK(?)`, { replacements: [LOCK], type: db.QueryTypes.RAW }).catch(() => {});
  }
}

cron.schedule(
  '20 9-19 * * *',
  async () => {
    await withLock(async () => {
      try {
        const r = await correr({ origen: 'cron' });
        if (r?.error) {
          console.warn('[recup-auto] no corrió:', r.error);
          return;
        }
        const activas = (r.resumen || []).filter((a) => !a.motivos?.apagada);
        if (activas.length) {
          console.log(
            '[recup-auto]',
            activas.map((a) => `${a.clave}: ${a.encolados} encolados, ${a.omitidos} omitidos`).join(' | '),
          );
        }
      } catch (e) {
        console.error('[recup-auto] error:', e?.message);
      }
    });
  },
  { timezone: 'America/Guayaquil' },
);
