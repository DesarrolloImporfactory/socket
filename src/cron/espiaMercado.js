const cron = require('node-cron');
const espia = require('../services/espia_mercado.service');

/**
 * Espía de mercado (Dropkiller propio) — tareas programadas.
 *
 *  - Foto del catálogo de Dropi dos veces al día por país, de madrugada y al
 *    mediodía local, fuera de las horas de más tráfico de los clientes:
 *      EC 02:15 y 12:15 America/Guayaquil
 *      MX 02:45 y 12:45 America/Mexico_City (no se cruza con la de EC)
 *    Cada pasada ~78 min (46.500 fichas, 40 por página, 3 s entre páginas) y
 *    entra por el limitador global de Dropi (services/dropi.service): nunca
 *    supera el tope por IP del servidor. Ante un 429 se detiene sola una hora
 *    sin tocar el freno de los syncs de los clientes.
 *  - Reporte diario por WhatsApp a las 07:30 de cada país (si está configurado
 *    ESPIA_REPORTE_ID_CONFIGURACION + ESPIA_REPORTE_TELEFONO).
 *  - Mantenimiento de anuncios/tiendas a las 05:00 EC: anuncios no vistos en
 *    60 días pasan a inactivos y se perfilan hasta 200 tiendas (Shopify).
 *
 * Se apaga con ESPIA_CRON=false (además del CRONS_ENABLED general).
 */
const activo = String(process.env.ESPIA_CRON ?? 'true').toLowerCase() !== 'false';

const log = (...a) => console.log('[cron-espia]', ...a);

async function correrPasada(pais) {
  try {
    const r = await espia.pasada(pais, { log });
    log(`${pais}: ${r.estado} · ${r.paginas} págs · ${r.productos} productos · ${r.ventas_sumadas} ventas`);
  } catch (e) {
    log(`${pais}: ✖ ${e.message}`);
  }
}

async function mandarReporte(pais) {
  try {
    const r = await espia.enviarReporteWhatsapp(pais);
    log(`reporte ${pais}: ${r.enviado ? `enviado a ${r.telefono}` : `no enviado (${r.motivo})`}`);
  } catch (e) {
    log(`reporte ${pais}: ✖ ${e.message}`);
  }
}

if (activo) {
  cron.schedule('15 2,12 * * *', () => correrPasada('EC'), { timezone: 'America/Guayaquil' });
  cron.schedule('45 2,12 * * *', () => correrPasada('MX'), { timezone: 'America/Mexico_City' });
  cron.schedule('30 7 * * *', () => mandarReporte('EC'), { timezone: 'America/Guayaquil' });
  cron.schedule('30 7 * * *', () => mandarReporte('MX'), { timezone: 'America/Mexico_City' });
  cron.schedule(
    '0 5 * * *',
    async () => {
      try {
        await espia.marcarInactivos();
        const n = await espia.perfilarPendientes(200);
        log(`mantenimiento: ${n} tiendas perfiladas`);
      } catch (e) {
        log(`mantenimiento ✖ ${e.message}`);
      }
    },
    { timezone: 'America/Guayaquil' },
  );
  log('programado: catálogo EC 02:15/12:15, MX 02:45/12:45, reporte 07:30, mantenimiento 05:00');
} else {
  log('apagado (ESPIA_CRON=false)');
}

module.exports = { correrPasada, mandarReporte };
