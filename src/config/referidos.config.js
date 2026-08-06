'use strict';

/**
 * config/referidos.config.js
 *
 * Fuente única de verdad de las reglas económicas del programa de referidos.
 *
 * POR QUÉ EXISTE
 * Los porcentajes y el ciclo de arranque se leen desde tres lugares distintos
 * (el webhook que devenga, el controller que arma el resumen y el front que se
 * lo explica al usuario). Duplicar el 25% en tres archivos es la forma más
 * rápida de terminar pagando un porcentaje distinto al que se le prometió al
 * cliente. Aquí vive el número; los demás preguntan.
 *
 * QUÉ NO VIVE AQUÍ
 * Los montos ya devengados. Una comisión guarda SU porcentaje en la fila
 * (`referidos_comisiones.porcentaje`), así que cambiar estos valores afecta
 * solo a lo que se devengue de aquí en adelante — nunca reescribe el pasado.
 * Esa es justamente la razón de guardarlo por fila.
 */

const num = (envKey, fallback) => {
  const v = Number(process.env[envKey]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// ─────────────────────────────────────────────────────────────
// Escalera de comisiones
// ─────────────────────────────────────────────────────────────
/**
 * Primer ciclo de facturación que genera comisión.
 *
 * Es 3 porque los dos primeros no dejan margen: el mes 1 se vende a $5 con
 * cupón promocional (PROMO_FIRST_MONTH_PRICE en planes.config.js) y el mes 2
 * apenas recupera ese subsidio. Pagar 25% antes del mes 3 significaría pagarle
 * al referidor con dinero que todavía no se ganó.
 */
const CICLO_INICIO = num('REFERIDOS_CICLO_INICIO', 3);

/** Ciclos 3 → 12. */
const PORCENTAJE_INICIAL = num('REFERIDOS_PORCENTAJE_INICIAL', 25);

/** Último ciclo que cobra PORCENTAJE_INICIAL. */
const CICLO_FIN_TRAMO_ALTO = num('REFERIDOS_CICLO_FIN_TRAMO_ALTO', 12);

/** Ciclo 13 en adelante: residual vitalicio mientras el referido siga pagando. */
const PORCENTAJE_RESIDUAL = num('REFERIDOS_PORCENTAJE_RESIDUAL', 10);

/**
 * Porcentaje que le toca a un ciclo. Devuelve 0 cuando el ciclo todavía no
 * califica, y ese 0 es la señal de "no devengar nada".
 */
const porcentajeParaCiclo = (ciclo) => {
  const n = Number(ciclo) || 0;
  if (n < CICLO_INICIO) return 0;
  if (n <= CICLO_FIN_TRAMO_ALTO) return PORCENTAJE_INICIAL;
  return PORCENTAJE_RESIDUAL;
};

// ─────────────────────────────────────────────────────────────
// Liquidación
// ─────────────────────────────────────────────────────────────
/**
 * Días que una comisión pasa en 'pendiente' antes de poder cobrarse.
 *
 * Es la ventana en la que todavía puede llegar un reembolso o un contracargo.
 * Sin ella se paga comisión sobre plata que después hay que devolver, y
 * recuperarla de un referidor ya pagado no ocurre nunca.
 */
const DIAS_RETENCION = num('REFERIDOS_DIAS_RETENCION', 30);

/** Mínimo acumulado para pedir transferencia. Debajo de esto solo hay crédito. */
const UMBRAL_TRANSFERENCIA_CENT = Math.round(
  num('REFERIDOS_UMBRAL_TRANSFERENCIA_USD', 30) * 100,
);

/** Métodos de cobro que el referidor puede elegir. */
const PAGO_PREFS = new Set(['credito', 'transferencia']);

// ─────────────────────────────────────────────────────────────
// Códigos
// ─────────────────────────────────────────────────────────────
/**
 * Alfabeto sin 0/O/1/I/L: el código se dicta por teléfono y se copia a mano
 * desde capturas de pantalla más veces de las que uno quisiera.
 */
const CODIGO_ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODIGO_LONGITUD = num('REFERIDOS_CODIGO_LONGITUD', 8);

/**
 * Base pública del enlace que se comparte.
 *
 * VIENE VACÍA A PROPÓSITO. El backend NO sabe desde qué dominio se está usando
 * el sistema —localhost en desarrollo, el dominio real en producción— y tener
 * una URL quemada aquí garantiza repartir enlaces rotos en cuanto uno de los
 * dos cambie. Quien arma el enlace es el front, con su propio
 * `window.location.origin`, que siempre es el correcto.
 *
 * Esta variable solo hace falta para usos donde no hay navegador que pregunte:
 * correos, WhatsApp automatizado, un PDF. Mientras nada de eso exista, se queda
 * vacía y `enlace` viaja en null.
 */
const BASE_URL_REGISTRO = String(process.env.REFERIDOS_BASE_URL || '').replace(
  /\/+$/,
  '',
);

const construirEnlace = (codigo) => {
  if (!codigo || !BASE_URL_REGISTRO) return null;
  return `${BASE_URL_REGISTRO}/register?ref=${encodeURIComponent(codigo)}`;
};

module.exports = {
  CICLO_INICIO,
  PORCENTAJE_INICIAL,
  CICLO_FIN_TRAMO_ALTO,
  PORCENTAJE_RESIDUAL,
  porcentajeParaCiclo,

  DIAS_RETENCION,
  UMBRAL_TRANSFERENCIA_CENT,
  PAGO_PREFS,

  CODIGO_ALFABETO,
  CODIGO_LONGITUD,
  BASE_URL_REGISTRO,
  construirEnlace,
};
