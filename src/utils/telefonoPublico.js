'use strict';

/* Teléfono que teclea alguien en un formulario público (encuesta, agenda).

   Llega en dos campos —código de país y número— y de todas las formas en que
   la gente lo escribe: con el 0 de marcación nacional ("0987…"), con el
   código repetido dentro del número ("593 987…"), con espacios y guiones.
   Sale como E.164 sin el "+", que es como lo guarda clientes_chat_center y
   como lo pide Meta para mandar una plantilla. Devuelve null si no da para
   un número real. */
function normalizarTelefonoPublico(codigoPais, telefono) {
  const cc = String(codigoPais || '').replace(/\D/g, '');
  let local = String(telefono || '').replace(/\D/g, '');

  if (!cc || !local) return null;

  // "0987654321" → "987654321": el 0 es de marcación nacional, no del número.
  local = local.replace(/^0+/, '');

  // El cliente ya escribió el código de país dentro del campo del número.
  // El margen de 5 dígitos evita recortar números que casualmente empiezan
  // con los mismos dígitos que su código de país.
  if (local.startsWith(cc) && local.length > cc.length + 5) {
    local = local.slice(cc.length);
  }

  const completo = cc + local;

  // Rango de la E.164 (con algo de holgura hacia abajo).
  if (completo.length < 8 || completo.length > 15) return null;

  return completo;
}

module.exports = { normalizarTelefonoPublico };
