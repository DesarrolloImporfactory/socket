const cron = require('node-cron');
const espia = require('../services/espia_mercado.service');

/**
 * Espía de mercado (Dropkiller propio) — tareas programadas.
 *
 *  - Foto del catálogo de Dropi dos veces al día por país, de madrugada y al
 *    mediodía local, fuera de las horas de más tráfico de los clientes:
 *      EC 02:15 y 12:15 America/Guayaquil
 *      MX 02:52 y 12:52 America/Mexico_City (no se cruza con la de EC ni con el sync de órdenes de :45)
 *    Cada pasada ~78 min (46.500 fichas, 40 por página, 3 s entre páginas) y
 *    entra por el limitador global de Dropi (services/dropi.service): nunca
 *    supera el tope por IP del servidor. Ante un 429 espera 5 min y repite la
 *    página (hasta 3 veces); si persiste se detiene sola una hora
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
  // :52 y no :45 para no arrancar encima del sync de órdenes de los clientes (cada 15 min).
  cron.schedule('52 2,12 * * *', () => correrPasada('MX'), { timezone: 'America/Mexico_City' });
  // Al cambiar el día local se mueven las ventanas de 1/7/30 días: se recalculan las métricas.
  const recalcular = (pais) => espia.recalcularMetricas(pais, log).catch((e) => log(`métricas ${pais} ✖ ${e.message}`));
  cron.schedule('10 0 * * *', () => recalcular('EC'), { timezone: 'America/Guayaquil' });
  cron.schedule('10 0 * * *', () => recalcular('MX'), { timezone: 'America/Mexico_City' });
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
  log('programado: catálogo EC 02:15/12:15, MX 02:52/12:52, reporte 07:30, mantenimiento 05:00');
} else {
  log('apagado (ESPIA_CRON=false)');
}

module.exports = { correrPasada, mandarReporte };
