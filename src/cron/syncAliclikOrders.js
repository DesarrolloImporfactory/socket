'use strict';

/**
 * cron/syncAliclikOrders.js
 *
 * RED DE SEGURIDAD del webhook de Aliclik. Recorre los pedidos recientes de
 * cada integración activa, refresca el cache local y dispara las plantillas
 * que correspondan.
 *
 * Por qué existe además del webhook:
 *  · Aliclik no documenta política de reintentos. Si respondemos 500 o el
 *    proceso está reiniciándose, ese evento se pierde y no vuelve.
 *  · La cola del webhook vive en memoria: un reinicio con eventos pendientes
 *    los descarta.
 *  · Los pedidos creados directamente en el panel de Aliclik (sin pasar por
 *    nosotros) no están en el cache, y el webhook llega sin teléfono. La
 *    primera pasada del cron es la que los inserta.
 *
 * No hay riesgo de mensajes duplicados entre ambos caminos: reclamarEnvio()
 * es atómico gracias al UNIQUE de aliclik_plantillas_enviadas.
 */

const cron = require('node-cron');

const { db } = require('../database/config');
const aliclikService = require('../services/aliclik.service');
const { decryptToken } = require('../utils/cryptoToken');
const {
  normalizarOrden,
  upsertOrders,
  procesarTemplates,
} = require('../services/aliclik_notifier.service');

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // tope duro: 2000 pedidos por integración y corrida
const DELAY_BETWEEN_PAGES = 1200;
const DELAY_BETWEEN_INTEGRATIONS = 3000;
const LOOKBACK_DAYS = Number(process.env.ALICLIK_SYNC_LOOKBACK_DAYS) || 3;
// Con menos días que estos por delante, se avisa que el token está por vencer.
const AVISO_EXPIRACION_DIAS = 7;

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */

/** Rango de fechas en hora de Lima (UTC-5), que es la zona de Aliclik. */
function getDateRange() {
  const now = new Date();
  const limaNow = new Date(
    now.getTime() + (now.getTimezoneOffset() + -5 * 60) * 60000,
  );
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    startDate: fmt(
      new Date(limaNow.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    ),
    endDate: fmt(limaNow),
  };
}

function diasRestantes(exp) {
  if (!exp) return null;
  return Math.floor((new Date(exp).getTime() - Date.now()) / 86400000);
}

/**
 * El token de Aliclik es un JWT que caduca (30 días en los que emiten hoy).
 * Cuando vence, la API responde 401 y la cuenta deja de recibir estados sin
 * que nadie se dé cuenta. Este aviso en log es el mínimo viable hasta que
 * exista notificación en la UI.
 */
function avisarSiTokenPorVencer(integracion) {
  const dias = diasRestantes(integracion.token_exp_at);
  if (dias === null) return;
  if (dias <= 0) {
    console.error(
      `[Cron Aliclik] cfg ${integracion.id_configuracion} ("${integracion.store_name}"): el token EXPIRÓ hace ${Math.abs(dias)} día(s). La integración no recibe estados hasta que se renueve.`,
    );
  } else if (dias <= AVISO_EXPIRACION_DIAS) {
    console.warn(
      `[Cron Aliclik] cfg ${integracion.id_configuracion} ("${integracion.store_name}"): el token vence en ${dias} día(s).`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════
   Sincronizar UNA integración
   ═══════════════════════════════════════════════════════════ */

async function syncIntegracion(integracion, startDate, endDate) {
  avisarSiTokenPorVencer(integracion);

  let token;
  try {
    token = decryptToken(integracion.token_enc);
  } catch (err) {
    console.error(
      `[Cron Aliclik] cfg ${integracion.id_configuracion}: no se pudo descifrar el token`,
    );
    return { skipped: true };
  }
  if (!token?.trim()) return { skipped: true };

  const todas = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await aliclikService.listOrders({
      token,
      params: { page, limit: PAGE_SIZE, startDate, endDate },
    });

    const filas = Array.isArray(data?.data) ? data.data : [];
    todas.push(...filas.map(normalizarOrden));

    const totalPages = Number(data?.pagination?.totalPages || 0);
    if (!filas.length || page >= totalPages) break;

    if (page === MAX_PAGES && totalPages > MAX_PAGES) {
      // Sin este log, un tope alcanzado se leería como "sincronizado todo".
      console.warn(
        `[Cron Aliclik] cfg ${integracion.id_configuracion}: se alcanzó el tope de ${MAX_PAGES} páginas (${totalPages} disponibles). Quedaron pedidos sin revisar en esta corrida.`,
      );
    }

    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PAGES));
  }

  if (!todas.length) return { synced: 0, templates: null };

  await upsertOrders(integracion.id_configuracion, todas);

  const templates = await procesarTemplates({
    ordenes: todas,
    id_configuracion: integracion.id_configuracion,
  });

  return { synced: todas.length, templates };
}

/* ═══════════════════════════════════════════════════════════
   Corrida completa
   ═══════════════════════════════════════════════════════════ */

async function runAliclikSync() {
  // Lock de MySQL: evita que dos instancias del backend corran el mismo ciclo.
  const [lock] = await db.query(`SELECT GET_LOCK('aliclik_sync', 0) AS ok`, {
    type: db.QueryTypes.SELECT,
  });
  if (!lock?.ok) return;

  try {
    const { startDate, endDate } = getDateRange();

    const integraciones = await db.query(
      `SELECT ai.id, ai.id_configuracion, ai.store_name, ai.token_enc,
              ai.token_exp_at
         FROM aliclik_integrations ai
         JOIN configuraciones c ON c.id = ai.id_configuracion
        WHERE ai.is_active = 1
          AND ai.deleted_at IS NULL
          AND COALESCE(c.suspendido, 0) = 0`,
      { type: db.QueryTypes.SELECT },
    );

    for (let i = 0; i < integraciones.length; i++) {
      try {
        await syncIntegracion(integraciones[i], startDate, endDate);
      } catch (err) {
        console.error(
          `[Cron Aliclik] cfg ${integraciones[i].id_configuracion}: ${err?.message || err}`,
        );
      }
      if (i < integraciones.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_INTEGRATIONS));
      }
    }
  } catch (err) {
    console.error(`[Cron Aliclik] error general: ${err?.message || err}`);
  } finally {
    try {
      await db.query(`DO RELEASE_LOCK('aliclik_sync')`, {
        type: db.QueryTypes.RAW,
      });
    } catch (_) {}
  }
}

const CRONS_ENABLED = process.env.NODE_ENV === 'production';

if (CRONS_ENABLED) {
  // Cada 15 min, igual que el de Dropi: el webhook cubre el tiempo real y esto
  // es solo la red de seguridad.
  cron.schedule('*/15 * * * *', () => {
    runAliclikSync().catch(() => {});
  });
} else {
  console.log('[Cron Aliclik] Deshabilitado — entorno no productivo');
}

module.exports = { runAliclikSync, syncIntegracion };
