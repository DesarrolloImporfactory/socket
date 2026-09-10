'use strict';

/**
 * utils/textoSeguro.js
 *
 * Recortes de texto que NO parten un emoji.
 *
 * `String.prototype.slice` cuenta unidades UTF-16: un emoji ocupa dos, y si el
 * corte cae justo en medio queda un "surrogate" suelto. JSON.stringify lo
 * serializa igual (\ud83c sin su pareja) y OpenAI rechaza el body entero con
 * 400 "Invalid body: failed to parse JSON value" — sin decir por qué.
 *
 * Caso real (cfg 1125, 2026-09-10): los copys del embudo van llenos de
 * emojis; el recorte a 300 caracteres del transcript de la ficha caía en
 * medio de uno SOLO cuando la ciudad era "Quito" (con "Cuenca" o "Loja" el
 * corte se corría 1-2 posiciones y pasaba). La ficha volvía null, la IA
 * "olvidaba" el nombre y la ciudad que el cliente ya había dado y los volvía
 * a pedir. Con el recap de kanban_ia (mismo recorte) el turno entero muere.
 */

const RE_SURROGATE_SUELTO =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Quita surrogates sin pareja (inválidos en cualquier JSON/UTF-8). */
function sinSurrogatesSueltos(texto) {
  return String(texto == null ? '' : texto).replace(RE_SURROGATE_SUELTO, '');
}

/**
 * Como `texto.slice(0, n)` pero contando caracteres reales (code points), así
 * el corte nunca parte un emoji. `n` negativo recorta desde el final, como
 * `slice(-n)`.
 */
function recortar(texto, n) {
  const s = String(texto == null ? '' : texto);
  if (!Number.isFinite(n)) return s;
  const puntos = Array.from(s);
  if (Math.abs(n) >= puntos.length) return s;
  return n >= 0 ? puntos.slice(0, n).join('') : puntos.slice(n).join('');
}

module.exports = { recortar, sinSurrogatesSueltos };
