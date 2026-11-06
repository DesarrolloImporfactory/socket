const cron = require('node-cron');
const espia = require('../services/espia_mercado.service');
const { ZONAS } = require('../utils/espiaMercadoCalc');

/**
 * ImporKiller (Dropkiller propio) — tareas programadas.
 *
 *  - Foto del catálogo de Dropi dos veces al día por país, de madrugada y de
 *    noche local, SIEMPRE fuera de la jornada de los clientes (trabajan de
 *    día, GMT-5/-6). Hasta el 05-11-2026 la segunda era al mediodía (12:15
 *    EC): 90 min de catálogo por la misma IP y el mismo limitador que las
 *    cotizaciones y la creación de órdenes del chat, en plena jornada; la del
 *    04-11 terminó en "Dropi está presentando interferencias" y ese día los
 *    clientes reportaban cotizaciones que no respondían. Decisión de Daniel:
 *    la experiencia de día manda; las fotos se toman de noche.
 *      EC 02:15 y 21:15 America/Guayaquil (termina ~22:45, antes del recálculo de 00:10)
 *      MX 02:52 y 21:52 America/Mexico_City (no se cruza con la de EC ni con el sync de órdenes de :45)
 *      CO 04:05 y 22:05 America/Bogota (= 04:05 EC: la de EC ya terminó; lejos de :45)
 *      Demás países de Dropi (GT, PA, CR, PE, VE, PY, AR, CL): una cadena a las
 *      00:20 EC, uno tras otro (son catálogos chicos y no comparten API con los
 *      clientes de ChatCenter; va de noche igual por prudencia con la IP).
 *    Un país sin cuenta de Dropi registrada (pantalla → «Cuentas de mapeo») o
 *    sin DROPI_BASE_URL_<pais> en el .env no arranca: queda en el log, sin fila de error.
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
  cron.schedule('15 2,21 * * *', () => correrPasada('EC'), { timezone: 'America/Guayaquil' });
  // :52 y no :45 para no arrancar encima del sync de órdenes de los clientes (cada 15 min).
  cron.schedule('52 2,21 * * *', () => correrPasada('MX'), { timezone: 'America/Mexico_City' });
  cron.schedule('5 4,22 * * *', () => correrPasada('CO'), { timezone: 'America/Bogota' });
  // Los demás países, en cadena (uno termina, empieza el otro) a las 00:20 EC:
  // la pasada nocturna de MX acaba ~00:10 EC y la de madrugada de EC empieza 02:15.
  const CADENA = espia.PAISES_REALES.filter((p) => !['EC', 'MX', 'CO'].includes(p));
  cron.schedule(
    '20 0 * * *',
    async () => {
      for (const p of CADENA) await correrPasada(p);
    },
    { timezone: 'America/Guayaquil' },
  );
  // Al cambiar el día local se mueven las ventanas de 1/7/30 días: se recalculan las métricas.
  const recalcular = (pais) => espia.recalcularMetricas(pais, log).catch((e) => log(`métricas ${pais} ✖ ${e.message}`));
  for (const p of espia.PAISES_REALES) {
    const timezone = ZONAS[p] || 'America/Guayaquil';
    cron.schedule('10 0 * * *', () => recalcular(p), { timezone });
    cron.schedule('30 7 * * *', () => mandarReporte(p), { timezone });
  }
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
  log(`programado: catálogo EC 02:15/21:15, MX 02:52/21:52, CO 04:05/22:05, cadena ${CADENA.join('→')} 00:20 EC, reporte 07:30, mantenimiento 05:00`);
} else {
  log('apagado (ESPIA_CRON=false)');
}

module.exports = { correrPasada, mandarReporte };
