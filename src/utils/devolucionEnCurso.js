'use strict';

/**
 * ¿El "EN DISTRIBUCIÓN A CLIENTE" que reporta Dropi es la vuelta al proveedor?
 *
 * ── El problema ────────────────────────────────────────────────────────────
 * Servientrega registra "EN DISTRIBUCIÓN A CLIENTE" tanto cuando el paquete
 * sale a entregarse al comprador como cuando, ya devuelto, sale a entregarse
 * al REMITENTE (para la transportadora el "cliente" es quien paga la guía).
 * Dropi no cambia el estado a DEVOLUCION hasta que el paquete llega a origen,
 * así que el notifier leía ese movimiento como última milla y mandaba la
 * plantilla EN TRANSITO ("tu pedido llegó a tu ciudad y está por llegar") a
 * un comprador cuyo paquete iba de regreso. Caso 2026-11-09: cfg 1173, orden
 * 7611062 (retiro en agencia en Lago Agrio, nunca retirado: "Novedad en CS"
 * → "DEVUELTO DE" → centro logístico → "EN DISTRIBUCIÓN A CLIENTE").
 *
 * Medido sobre 30 días: 1.334 avisos EN TRANSITO (121 cuentas, 23% de todos
 * los del mes) salieron sobre órdenes que ya traían la novedad de devolución;
 * de los enviados con más de 7 días, 892 terminaron en DEVOLUCION y 1 fue
 * entregado.
 *
 * ── Cómo se distingue sin llamar a nadie ───────────────────────────────────
 * Lo que separa la ida de la vuelta es lo que pasó ANTES de la distribución.
 * Sobre 13.884 órdenes cerradas con al menos una distribución (60 días):
 *
 *  A. Movimientos previos de la orden (servientrega_movements) con DEVUELTO,
 *     NOVEDAD EN CS, NO RECLAMO o DEVOLUCION AL REMITENTE → 3.018 devueltas
 *     por ~11 entregadas. "DEVOLUCION DE DISTRIBUCION" NO cuenta: es el
 *     reintento normal del día siguiente (39 entregadas vs 10 devueltas), y
 *     "CERRADO" tampoco (136 entregadas vs 54).
 *  B. El campo novedad_servientrega de Dropi en DEVUELTO DE o NO RECLAMO EN
 *     OFICINA → 2.638 devueltas por 11 entregadas. Es la señal que trae el
 *     webhook en el mismo evento; los movimientos vienen del listado del
 *     cron (y del cache que el webhook usa de base).
 *  C. Pedido de retiro en agencia que ya tuvo "INGRESANDO EN AGENCIA": un
 *     retiro no se distribuye al cliente → 132 devueltas por 1 entregada.
 *
 * Una segunda distribución NO es señal (653 entregadas vs 604 devueltas: es
 * el segundo intento), y el notifier ya manda cada estado una sola vez.
 *
 * Cuando la guardia bloquea no se avisa, no se mueve el chat y no queda
 * reclamo: el chat se queda en novedad/retiro y pasa a devolución cuando Dropi
 * confirme el DEVOLUCION, como siempre.
 */

const RE_RETORNO = /DEVUELT|NOVEDAD EN CS|NO RECLAMO|DEVOLUCION AL REMITENTE/;
const RE_REINTENTO_LEGITIMO = /DEVOLUCION DE DISTRIBUCION/;
const RE_DISTRIBUCION_CLIENTE = /DISTRIBUCION A CLIENTE/;
const RE_INGRESO_AGENCIA = /INGRESANDO EN AGENCIA/;
const RE_DIR_RETIRO = /RETIRO EN AGENCIA|RETIRO EN OFICINA/;

const NOVEDADES_DEVOLUCION = new Set(['DEVUELTO DE', 'NO RECLAMO EN OFICINA']);

function normalizar(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function esServientrega(order) {
  const nombre = normalizar(
    order?.shipping_company || order?.distribution_company?.name || '',
  );
  return nombre.includes('SERVIENTREGA');
}

/** Movimientos ordenados por fecha, normalizados. */
function movimientosOrdenados(movs) {
  if (!Array.isArray(movs) || movs.length === 0) return [];
  return [...movs]
    .filter((m) => m && m.nom_mov)
    .sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime() || 0;
      const tb = new Date(b.created_at || 0).getTime() || 0;
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    })
    .map((m) => normalizar(m.nom_mov));
}

/** Movimientos anteriores a la ÚLTIMA distribución a cliente (o todos si no hay). */
function movimientosPrevios(nombres) {
  let ultima = -1;
  nombres.forEach((n, i) => {
    if (RE_DISTRIBUCION_CLIENTE.test(n)) ultima = i;
  });
  return ultima >= 0 ? nombres.slice(0, ultima) : nombres;
}

/* A. Movimientos de retorno antes de la distribución. */
function clasificarPorMovimientos(movs) {
  const previos = movimientosPrevios(movimientosOrdenados(movs));
  const hit = previos.find(
    (n) => RE_RETORNO.test(n) && !RE_REINTENTO_LEGITIMO.test(n),
  );
  if (!hit) return null;
  return { enCurso: true, fuente: 'movimientos', detalle: hit };
}

/* B. Novedad de Dropi. */
function clasificarPorNovedad(novedad) {
  const n = normalizar(novedad);
  if (!n || !NOVEDADES_DEVOLUCION.has(n)) return null;
  return { enCurso: true, fuente: 'novedad', detalle: n };
}

/* C. Retiro en agencia que ya ingresó a la agencia. */
function clasificarPorRetiro(order) {
  if (!RE_DIR_RETIRO.test(normalizar(order?.dir))) return null;
  const previos = movimientosPrevios(
    movimientosOrdenados(order?.servientrega_movements),
  );
  if (!previos.some((n) => RE_INGRESO_AGENCIA.test(n))) return null;
  return {
    enCurso: true,
    fuente: 'retiro_agencia',
    detalle: 'pedido de retiro ya ingresado en agencia',
  };
}

/**
 * @param {object} p
 * @param {object} p.order  orden Dropi (status, dir, shipping_company,
 *                          novedad_servientrega, servientrega_movements)
 * @returns {{enCurso:boolean, fuente:string|null, detalle:string}}
 */
function esDevolucionEnCurso({ order } = {}) {
  if (!order || !esServientrega(order)) {
    return { enCurso: false, fuente: null, detalle: 'no es Servientrega' };
  }
  return (
    clasificarPorMovimientos(order.servientrega_movements) ||
    clasificarPorNovedad(order.novedad_servientrega) ||
    clasificarPorRetiro(order) || {
      enCurso: false,
      fuente: null,
      detalle: 'sin señal de devolución',
    }
  );
}

module.exports = {
  esDevolucionEnCurso,
  clasificarPorMovimientos,
  clasificarPorNovedad,
  clasificarPorRetiro,
  NOVEDADES_DEVOLUCION,
};
