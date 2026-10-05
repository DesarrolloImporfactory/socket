/**
 * Cron: reconciliación de la telefonía por saldo contra Zadarma, cada 10 min.
 *
 * Repara lo que deja un reinicio del servidor a mitad de una llamada (los
 * avisos de Zadarma llegan una sola vez): cierra y COBRA las llamadas que
 * quedaron abiertas, trae las grabaciones que no se descargaron y termina
 * los análisis de IA a medias. Ver services/telefonia_reconciliar.service.js.
 *
 * Candado en memoria (no GET_LOCK: con el pool de conexiones el candado de
 * MySQL se pierde, ver el cron de Dropi). Si otro servidor corre lo mismo
 * contra la misma base no pasa nada: el cierre de cada llamada es atómico.
 */
const cron = require('node-cron');
const zadarma = require('../services/zadarma.service');
const { reconciliar } = require('../services/telefonia_reconciliar.service');

let corriendo = false;

async function tick() {
  if (corriendo) return;
  corriendo = true;
  try {
    await zadarma.cargarCredenciales();
    if (!zadarma.configurado()) return;
    const r = await reconciliar();
    if (r.cerradas || r.no_marco || r.sin_cierre || r.grabaciones || r.analisis) {
      console.log(
        `[telefonia-reconciliar] cerradas ${r.cerradas} (cobrado $${(r.cobrado_centavos / 100).toFixed(2)}), ` +
          `no marcadas ${r.no_marco}, sin cierre ${r.sin_cierre}, grabaciones ${r.grabaciones}, análisis ${r.analisis}`,
      );
    }
  } catch (e) {
    console.error('[telefonia-reconciliar] falló:', e.message);
  } finally {
    corriendo = false;
  }
}

cron.schedule('*/10 * * * *', tick, { timezone: 'America/Guayaquil' });

module.exports = { tick };
