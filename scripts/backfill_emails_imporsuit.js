/**
 * Backfill: rellena email_cliente en clientes_chat_center (chat_center) con el
 * email del dueño de imporsuit cuando el celular coincide (dígitos exactos) con
 * el whatsapp de una plataforma. Solo rellena vacíos. Idempotente / re-ejecutable.
 *
 * Uso:
 *   node scripts/backfill_emails_imporsuit.js          # aplica cambios
 *   node scripts/backfill_emails_imporsuit.js --dry     # simula, no escribe
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { backfill } = require('../src/services/imporsuitEmailSync.service');

(async () => {
  const dryRun = process.argv.includes('--dry');
  console.log(`[backfill_emails_imporsuit] iniciando (dryRun=${dryRun})…`);

  try {
    const t0 = Date.now();
    const r = await backfill({ dryRun });
    console.log('[backfill_emails_imporsuit] resultado:', {
      ...r,
      segundos: Math.round((Date.now() - t0) / 100) / 10,
    });
    process.exit(0);
  } catch (e) {
    console.error('[backfill_emails_imporsuit] ERROR:', e?.message || e);
    process.exit(1);
  }
})();
