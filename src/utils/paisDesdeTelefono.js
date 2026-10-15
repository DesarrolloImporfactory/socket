/* País (ISO-2 en minúsculas) a partir del número internacional de la
   conexión. Mismos países que el selector de "Agregar negocio". null si el
   prefijo no se reconoce: el que llama decide (la columna cae en 'ec'). */

// Prefijos más largos primero: 593 antes que 59x, 506 antes que 50x…
const PREFIJOS = [
  ['1787', 'pr'],
  ['1939', 'pr'],
  ['593', 'ec'],
  ['502', 'gt'],
  ['506', 'cr'],
  ['507', 'pa'],
  ['57', 'co'],
  ['52', 'mx'],
  ['54', 'ar'],
  ['55', 'br'],
  ['56', 'cl'],
  ['51', 'pe'],
  ['58', 've'],
  ['1', 'us'],
];

function paisDesdeTelefono(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  if (d.length < 8) return null;
  return PREFIJOS.find(([p]) => d.startsWith(p))?.[1] || null;
}

// Valor que manda el front: 2 letras, se acepta en cualquier caja.
function normalizarPais(pais) {
  const p = String(pais || '')
    .trim()
    .toLowerCase();
  return /^[a-z]{2}$/.test(p) ? p : null;
}

module.exports = { paisDesdeTelefono, normalizarPais };
