'use strict';

/**
 * Lee un precio escrito por el bot o el cliente y devuelve un número.
 *
 * Antes cada lector tomaba "el primer número con hasta 2 decimales", así que
 * los precios de México y Colombia con separador de miles se leían mal:
 * "1.283,99" → 1.28, "$1,353.99" → 1.35, "$1,499" → 1.49, y el candado de
 * precio del auto-orden rechazaba la orden ("Total bot $1.28 < costo
 * proveedor $340", cfg 1159, ~3 por día en sep-2026).
 *
 * Regla: si hay punto Y coma, el último de los dos es el decimal y el otro
 * es de miles. Si hay uno solo, es de miles cuando el grupo final tiene
 * exactamente 3 dígitos y hay más de un grupo ("1.499", "12,500"); si no,
 * es decimal ("24.99", "24,99"). "24.990" se lee como 24990 a propósito:
 * ningún precio nuestro lleva 3 decimales.
 */
function parsearPrecio(s) {
  const m = String(s || '').match(/\d[\d.,]*/);
  if (!m) return 0;
  let t = m[0].replace(/[.,]+$/, '');
  const iPunto = t.lastIndexOf('.');
  const iComa = t.lastIndexOf(',');

  if (iPunto >= 0 && iComa >= 0) {
    const decimal = iPunto > iComa ? '.' : ',';
    const miles = decimal === '.' ? ',' : '.';
    t = t.split(miles).join('');
    if (decimal === ',') t = t.replace(',', '.');
  } else if (iPunto >= 0 || iComa >= 0) {
    const sep = iPunto >= 0 ? '.' : ',';
    const partes = t.split(sep);
    const ultimo = partes[partes.length - 1];
    const esMiles =
      partes.length > 1 &&
      ultimo.length === 3 &&
      partes.slice(1).every((g) => g.length === 3);
    t = esMiles ? partes.join('') : `${partes.slice(0, -1).join('')}.${ultimo}`;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

module.exports = { parsearPrecio };
