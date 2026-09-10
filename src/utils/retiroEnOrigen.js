'use strict';

/**
 * ¿El "PARA RETIRO EN AGENCIA" que reporta Dropi es la agencia de ORIGEN?
 *
 * ── El problema ────────────────────────────────────────────────────────────
 * Cuando el proveedor deja el paquete en una agencia de Servientrega para
 * despacharlo, la transportadora registra "Ingresando en Agencia X" — el
 * MISMO movimiento que usa cuando el paquete llega a la agencia de destino
 * para que el cliente lo retire. Dropi no distingue una cosa de la otra y en
 * los dos casos manda el estado "PARA RETIRO EN AGENCIA SERVIENTREGA".
 * Resultado: la plantilla de retiro salía apenas el proveedor despachaba, y
 * apuntaba a la agencia del proveedor (cfg 841: orden 6923831 para Cotacachi
 * avisada como "retira en GUAYAQUIL - MALL DEL FORTIN", donde despacha su
 * proveedor todas las tardes).
 *
 * Medido del 15-08 al 10-09-2026 sobre 3.413 avisos de retiro con historial
 * completo: 238 (7%) eran despachos de origen y 217 de esos sí le llegaron al
 * cliente. En la cuenta 841 fue 1 de cada 2.
 *
 * ── Cómo se distingue SIN depender de nadie externo ────────────────────────
 * Un retiro real en destino siempre va precedido de tránsito (recolección,
 * centro logístico, en ruta a concesión, en distribución…). Un despacho de
 * origen no tiene nada antes: la orden estaba en GUIA GENERADA y de golpe
 * está "para retiro". Tres fuentes, se usa la primera que sea concluyente:
 *
 *  A. Nuestro propio historial de eventos (dropi_webhook_events): último
 *     estado distinto de retiro. Si es PENDIENTE / GUIA_GENERADA → origen.
 *     Sobre la muestra: bloquea 232 de 238 y 0 retiros reales.
 *  B. Los movimientos de Servientrega que la propia orden de Dropi trae
 *     (servientrega_movements): si antes del último "INGRESANDO EN AGENCIA"
 *     no hay ningún movimiento de tránsito → origen. Cubre las órdenes que
 *     no reciben webhooks (solo cron).
 *  C. Tiempo: menos de 6 h desde que se creó la orden → origen (0 falsos
 *     positivos en la muestra; ningún paquete llega a destino tan rápido).
 *
 * Comparar la ciudad de la agencia con la ciudad de la orden NO sirve como
 * regla: 104 retiros reales de la muestra están en una agencia de un cantón
 * vecino (Marcelino Maridueña para Gral. Antonio Elizalde, Los Bancos para
 * San Miguel de los Bancos…) y se habrían silenciado; y 82 despachos de
 * origen eran en la misma ciudad del cliente. Además requiere el nombre de
 * la agencia, que solo sale del tracking de Servientrega.
 *
 * Ninguna fuente hace llamadas externas. Si ninguna es concluyente, se deja
 * pasar (comportamiento anterior): mejor un aviso de más que uno de menos.
 */

const { db } = require('../database/config');

const RE_INGRESO_AGENCIA = /INGRESANDO EN AGENCIA/i;
// Solo existen una vez que la transportadora ya recogió el paquete.
const RE_TRANSITO =
  /RECOLEC|CENTRO LOGISTICO|EN RUTA|DISTRIBUCI|OPERATIVO|CONCESION|NOVEDAD|ENTREGAD/i;

// Estados de Dropi previos a cualquier movimiento de la transportadora.
const ESTADOS_SIN_TRANSITO = new Set([
  'PENDIENTE',
  'PENDIENTE CONFIRMACION',
  'INGRESO A CONFIRMACION',
  'GUIA_GENERADA',
  'GUIA GENERADA',
  'GUIA_ANULADA',
]);

const HORAS_MINIMAS_HASTA_DESTINO = 6;

/* ── A. historial propio ─────────────────────────────────────────────────── */

async function clasificarPorEventos(dropi_order_id) {
  if (!dropi_order_id) return null;
  try {
    const rows = await db.query(
      `SELECT status
         FROM dropi_webhook_events
        WHERE dropi_order_id = ?
          AND status NOT LIKE 'PARA RETIRO%'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      { replacements: [dropi_order_id], type: db.QueryTypes.SELECT },
    );
    if (!rows.length) return null; // orden sin webhooks (solo cron)
    const prev = String(rows[0].status || '')
      .trim()
      .toUpperCase();
    return {
      enOrigen: ESTADOS_SIN_TRANSITO.has(prev),
      fuente: 'eventos',
      detalle: `estado previo "${prev}"`,
    };
  } catch (_) {
    return null;
  }
}

/* ── B. movimientos de Servientrega en la orden Dropi ────────────────────── */

function ordenarMovimientos(movimientos) {
  return (Array.isArray(movimientos) ? movimientos : [])
    .filter((m) => m && m.nom_mov)
    .slice()
    .sort(
      (a, b) =>
        String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
        Number(a.id || 0) - Number(b.id || 0),
    )
    .map((m) => String(m.nom_mov).trim().toUpperCase());
}

/**
 * Exportada para poder probarla sin BD.
 * @returns {{enOrigen:boolean, fuente:'movimientos', detalle:string}|null}
 */
function clasificarPorMovimientos(movimientos) {
  const movs = ordenarMovimientos(movimientos);
  if (!movs.length) return null;
  let ultimoIngreso = -1;
  movs.forEach((m, i) => {
    if (RE_INGRESO_AGENCIA.test(m)) ultimoIngreso = i;
  });
  if (ultimoIngreso < 0) return null;
  const transitoAntes = movs
    .slice(0, ultimoIngreso)
    .some((m) => RE_TRANSITO.test(m));
  return {
    enOrigen: !transitoAntes,
    fuente: 'movimientos',
    detalle: transitoAntes
      ? 'hubo tránsito antes del ingreso a agencia'
      : `ingreso a agencia sin tránsito previo (${movs.slice(0, ultimoIngreso + 1).join(' > ')})`,
  };
}

/* ── C. tiempo desde la creación ─────────────────────────────────────────── */

// Dropi manda created_at en hora local del país, sin zona. Ninguno de los
// cuatro países usa horario de verano.
const OFFSET_PAIS = { EC: '-05:00', CO: '-05:00', GT: '-06:00', MX: '-06:00' };

function clasificarPorTiempo(order, country_code) {
  const raw = order?.created_at || order?.order_created_at;
  if (!raw) return null;
  let s = String(raw).trim().replace(' ', 'T');
  // Se fija la zona explícitamente para no depender del TZ del servidor.
  // Si viene con Z / offset se respeta.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    s = s.replace(/\.\d+$/, '') + (OFFSET_PAIS[country_code] || '-05:00');
  }
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return null;
  const horas = (Date.now() - t.getTime()) / 36e5;
  if (horas < 0) return null;
  if (horas < HORAS_MINIMAS_HASTA_DESTINO) {
    return {
      enOrigen: true,
      fuente: 'tiempo',
      detalle: `${horas.toFixed(1)} h desde la creación de la orden`,
    };
  }
  return null; // más de 6 h no prueba nada
}

/* ── Resolver ────────────────────────────────────────────────────────────── */

/**
 * @param {object} p
 * @param {object} p.order  orden Dropi (id, servientrega_movements, created_at)
 * @returns {Promise<{enOrigen:boolean, fuente:string|null, detalle:string}>}
 */
async function esRetiroEnOrigen({ order, country_code } = {}) {
  const dropiOrderId = Number(order?.id || 0) || null;

  const porEventos = await clasificarPorEventos(dropiOrderId);
  if (porEventos) return porEventos;

  const porMovs = clasificarPorMovimientos(order?.servientrega_movements);
  if (porMovs) return porMovs;

  const porTiempo = clasificarPorTiempo(order, country_code);
  if (porTiempo) return porTiempo;

  return { enOrigen: false, fuente: null, detalle: 'sin datos concluyentes' };
}

module.exports = {
  esRetiroEnOrigen,
  clasificarPorMovimientos,
  clasificarPorEventos,
  clasificarPorTiempo,
  ESTADOS_SIN_TRANSITO,
};
