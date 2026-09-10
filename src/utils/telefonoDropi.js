'use strict';

/**
 * Teléfono en el formato LOCAL que acepta Dropi para crear la orden, por
 * país de la integración. Dropi rechaza la orden entera con "El teléfono del
 * cliente no es válido o está incompleto" (103 auto-órdenes en 30 días,
 * ago-sep 2026) cuando el bot copia mal el número: le falta o le sobra un
 * dígito ("093351055", "09999931412"), viene con el indicativo pegado
 * ("593984842441" → hay que dejarlo "0984842441") o es un fijo.
 *
 * Devuelve { valido, telefono, motivo }. `telefono` viene ya normalizado
 * (con el 0 inicial en EC, sin el 57/52 en CO/MX) listo para el payload.
 */
function normalizarPorPais(raw, country_code) {
  let d = String(raw || '').replace(/\D/g, '');
  const cc = String(country_code || 'EC').toUpperCase();
  if (d.startsWith('00')) d = d.slice(2);

  if (cc === 'EC') {
    if (d.startsWith('593') && d.length === 12) d = `0${d.slice(3)}`;
    if (d.length === 9 && d.startsWith('9')) d = `0${d}`;
    return { telefono: d, valido: /^09\d{8}$/.test(d) };
  }
  if (cc === 'CO') {
    if (d.startsWith('57') && d.length === 12) d = d.slice(2);
    return { telefono: d, valido: /^3\d{9}$/.test(d) };
  }
  if (cc === 'MX') {
    if (d.startsWith('521') && d.length === 13) d = d.slice(3);
    else if (d.startsWith('52') && d.length === 12) d = d.slice(2);
    return { telefono: d, valido: /^\d{10}$/.test(d) };
  }
  if (cc === 'PE') {
    if (d.startsWith('51') && d.length === 11) d = d.slice(2);
    return { telefono: d, valido: /^9\d{8}$/.test(d) };
  }
  if (cc === 'GT') {
    if (d.startsWith('502') && d.length === 11) d = d.slice(3);
    return { telefono: d, valido: /^\d{8}$/.test(d) };
  }
  // País sin regla propia: solo largo razonable.
  return { telefono: d, valido: d.length >= 8 && d.length <= 11 };
}

/**
 * Elige el teléfono de la orden: el que puso el bot si es válido; si no, el
 * número de WhatsApp desde el que escribe el cliente (siempre es real y es
 * el mismo respaldo que ya se usa cuando el resumen no trae la línea
 * Teléfono). Si ninguno sirve, { telefono: null }.
 */
function elegirTelefonoOrden({ telBot, telWhatsApp, country_code }) {
  const bot = normalizarPorPais(telBot, country_code);
  if (bot.valido) return { telefono: bot.telefono, fuente: 'bot' };
  const wa = normalizarPorPais(telWhatsApp, country_code);
  if (wa.valido) {
    return {
      telefono: wa.telefono,
      fuente: 'whatsapp',
      motivo: `el teléfono del resumen ("${String(telBot || '').slice(0, 20)}") no es un número válido de ${String(country_code || 'EC').toUpperCase()}`,
    };
  }
  return {
    telefono: null,
    fuente: null,
    motivo: `ni el teléfono del resumen ("${String(telBot || '').slice(0, 20)}") ni el de WhatsApp ("${String(telWhatsApp || '').slice(0, 20)}") son válidos para ${String(country_code || 'EC').toUpperCase()}`,
  };
}

module.exports = { normalizarPorPais, elegirTelefonoOrden };
