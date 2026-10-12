/* ¿El teléfono guardado en una cotización es el MISMO desde el que escribe el
   cliente por WhatsApp?

   El resto de IMPORCHAT compara por los últimos 9 dígitos (utils/ajustesIA,
   utils/membresiaImporsuit) y para etiquetas y tarjetas alcanza. Acá se va a
   entregar el estado de una carga, así que hace falta algo más: los últimos 9
   dígitos de un móvil de Ecuador (098 765 4321 → 987654321) también son la
   cola de un número de México de 10 dígitos (598 765 4321), y el número
   nacional de Ecuador es idéntico a un móvil de Perú. Con la cola sola, el
   segundo vería la carga del primero.

   Regla. El número de WhatsApp siempre llega completo, con código de país; se
   parte en código + número nacional y se compara así:
     · si en la base está con su código de país → mismo código y mismo número;
     · si está sin código («0987654321», «55 1234 5678») → mismo número
       nacional, y el país del que escribe tiene que ser el de destino de la
       cotización. Sin destino conocido, no vale.
   Un país que no está en la lista no recibe nada.

   Lo que esto NO resuelve: un cliente de otro país guardado sin código en una
   cotización hacia Ecuador o México. La base no dice de qué país es ese
   número; si coincide con el de un ecuatoriano o un mexicano, se toma por
   suyo. Se arregla guardando los teléfonos con su código de país.

   La cola de 9 se sigue usando, pero solo para traer candidatos de la base. */

'use strict';

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

/* Códigos de país que puede traer un alumno de la línea, con el largo del
   número nacional. México y Argentina llegan a veces con un 1 / 9 de más
   después del código (521…, 549…): es el mismo número. */
const PAISES = [
  { cc: '593', largos: [9], pais: 'ec' },
  { cc: '52', largos: [10], extra: '1', pais: 'mx' },
  { cc: '57', largos: [10], pais: 'co' },
  { cc: '51', largos: [9], pais: 'pe' },
  { cc: '54', largos: [10], extra: '9', pais: 'ar' },
  { cc: '56', largos: [9], pais: 'cl' },
  { cc: '58', largos: [10], pais: 've' },
  { cc: '591', largos: [8], pais: 'bo' },
  { cc: '595', largos: [9], pais: 'py' },
  { cc: '598', largos: [8, 9], pais: 'uy' },
  { cc: '502', largos: [8], pais: 'gt' },
  { cc: '503', largos: [8], pais: 'sv' },
  { cc: '504', largos: [8], pais: 'hn' },
  { cc: '505', largos: [8], pais: 'ni' },
  { cc: '506', largos: [8], pais: 'cr' },
  { cc: '507', largos: [8], pais: 'pa' },
  { cc: '1', largos: [10], pais: 'us' },
  { cc: '34', largos: [9], pais: 'es' },
];

/** Parte un número completo en { cc, nacional, pais }, o null si no calza con
    ningún país de la lista. Tolera el 0 de larga distancia después del código
    («+593 098 047 2544») y el 1 / 9 de México y Argentina. */
function partir(numero) {
  const d = soloDigitos(numero).replace(/^00/, '');
  for (const p of PAISES) {
    if (!d.startsWith(p.cc)) continue;
    let resto = d.slice(p.cc.length);
    if (p.extra && resto.startsWith(p.extra) && p.largos.includes(resto.length - 1)) {
      resto = resto.slice(1);
    }
    if (resto.startsWith('0') && p.largos.includes(resto.length - 1)) resto = resto.slice(1);
    if (p.largos.includes(resto.length)) return { cc: p.cc, nacional: resto, pais: p.pais };
  }
  return null;
}

/** Cola de 9 dígitos para traer candidatos; null si el número no sirve
    (corto, o 000000000 / 111111111, que calzarían con cualquiera). */
function colaCandidatos(numero) {
  const c = soloDigitos(numero).slice(-9);
  return c.length === 9 && new Set(c).size >= 4 ? c : null;
}

/** País del que escribe, por el código de su WhatsApp: 'ec', 'mx', … o null. */
function paisDelTelefono(numero) {
  return partir(numero)?.pais || null;
}

function paisDeDestino(destino) {
  const d = String(destino || '').trim().toLowerCase();
  if (d === 'ec' || d.startsWith('ecu')) return 'ec';
  if (d === 'mx' || d.startsWith('mex') || d.startsWith('méx')) return 'mx';
  return null;
}

/**
 * Cómo coincide el número de WhatsApp con uno guardado:
 *   'exacto'    el guardado trae su código de país y es el mismo número;
 *   'nacional'  el guardado no trae código («0987654321», «55 1234 5678») y su
 *               número nacional es el del que escribe. Falta saber de qué país
 *               es el guardado: lo decide quien llama.
 *   null        no es el mismo.
 */
function comoCoincide(whatsapp, guardado) {
  const w = partir(whatsapp);
  if (!w) return null; // país fuera de la lista: no se entrega nada
  const g = soloDigitos(guardado).replace(/^00/, '');
  if (g.length < 9 || new Set(g.slice(-9)).size < 4) return null;

  const gPartido = partir(g);
  if (gPartido && gPartido.cc === w.cc && gPartido.nacional === w.nacional) return 'exacto';

  const nacional = g.replace(/^0+/, '');
  return nacional.length >= 9 && nacional === w.nacional ? 'nacional' : null;
}

/**
 * @param {string} whatsapp  número del que escribe (completo, con código de país)
 * @param {string} guardado  como esté en la base: «+593 98 047 2544», «0980472544»…
 * @param {string} [destino] país de destino de la cotización (`ec` | `mx`). Un
 *        número guardado SIN código de país solo vale si el que escribe es de
 *        ese país: el mismo 987654321 es un móvil de Ecuador y otro de Perú.
 *        Sin destino conocido, un número sin código no vale.
 */
function mismoTelefono(whatsapp, guardado, destino = null) {
  const c = comoCoincide(whatsapp, guardado);
  if (c === 'exacto') return true;
  if (c !== 'nacional') return false;
  const pais = paisDeDestino(destino);
  return Boolean(pais) && partir(whatsapp).pais === pais;
}

module.exports = {
  soloDigitos,
  partir,
  colaCandidatos,
  paisDelTelefono,
  paisDeDestino,
  comoCoincide,
  mismoTelefono,
  PAISES,
};
