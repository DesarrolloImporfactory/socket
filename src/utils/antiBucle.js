'use strict';

/**
 * Guardia anti-bucle del bot.
 *
 * Caso 366 (2026-09-11): ante "¿cómo puedo saber que funciona?" el bot mandó
 * "¿A qué ciudad te lo enviamos?" OCHO veces seguidas, idéntico, hasta que una
 * persona escribió "mil disculpas por las respuestas de la IA". Nada lo
 * frenaba: turnos_sin_avance escala a asesor recién a los 15 turnos.
 *
 * La regla es mínima a propósito: una respuesta que es IGUAL (normalizada) a
 * las DOS últimas del bot a ese contacto no se envía. La primera repetición se
 * tolera —el cliente puede haber contestado fuera de tema una vez—; la tercera
 * idéntica nunca es una buena respuesta.
 */

function normalizarParaBucle(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    // Emojis y signos fuera: "¿A qué ciudad te lo enviamos? 📦" y
    // "¿A qué ciudad te lo enviamos?" son la misma respuesta.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Respuestas cortísimas ("ok", "sí") pueden repetirse legítimamente. */
const MINIMO_LETRAS = 8;

/**
 * @param {string} nueva     respuesta que está por salir
 * @param {string[]} previas últimas respuestas del bot a ese contacto, la más
 *                           reciente primero
 * @param {{ repeticiones?: number }} [opts] cuántas previas idénticas hacen falta
 *   para frenar (default 2 → se frena la TERCERA idéntica)
 */
function esRespuestaEnBucle(nueva, previas, { repeticiones = 2 } = {}) {
  const n = normalizarParaBucle(nueva);
  if (n.length < MINIMO_LETRAS) return false;
  const lista = (Array.isArray(previas) ? previas : []).slice(0, repeticiones);
  if (lista.length < repeticiones) return false;
  return lista.every((p) => normalizarParaBucle(p) === n);
}

module.exports = { normalizarParaBucle, esRespuestaEnBucle };
