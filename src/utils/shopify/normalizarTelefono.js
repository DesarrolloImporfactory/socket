const { parsePhoneNumberFromString } = require('libphonenumber-js');

/* Número válido → dígitos con código de país (formato WhatsApp); si no, null. */
const validar = (texto, opciones) => {
  try {
    const parsed = parsePhoneNumberFromString(texto, opciones);
    return parsed && parsed.isValid()
      ? `${parsed.countryCallingCode}${parsed.nationalNumber}`
      : null;
  } catch (_) {
    return null;
  }
};

/**
 * Normaliza un teléfono al formato que usa WhatsApp (sin +, sin espacios, sin guiones).
 *
 * El prefijo de la configuración (ej: 593 EC) es solo el país por defecto: un
 * cliente puede escribir el número de otro país en el formulario de la tienda.
 * Por eso, antes de anteponer el prefijo, se respeta:
 *   1. El número escrito como internacional (+57... / 0057...).
 *   2. El número que ya empieza con el prefijo de la tienda (ej: 5939...).
 *   3. El número local válido del país de la tienda (0991234567 → 593991234567).
 *   4. El número válido en el país de la dirección del pedido (paisIso, ej: 'CO').
 *   5. El número que ya trae otro código de país válido (573244722306 en una
 *      tienda de México no es un móvil mexicano: es Colombia).
 * Si nada de eso aplica se mantiene el comportamiento de siempre: quitar el 0
 * inicial y anteponer el prefijo.
 */
const normalizarTelefono = (raw, prefijoPais = '593', paisIso = null) => {
  if (!raw) return null;

  const texto = String(raw).trim();

  // Quitar todo lo que no sea dígito
  let limpio = texto.replace(/\D/g, '');
  if (!limpio) return null;

  // 1. Escrito como internacional: el cliente ya dijo de qué país es
  if (texto.startsWith('+')) return limpio;
  if (limpio.startsWith('00')) return limpio.substring(2);

  // 2. Si ya viene con el prefijo del país (ej: 5939...)
  if (limpio.startsWith(prefijoPais)) return limpio;

  // 3. Número local válido del país de la tienda
  const local = validar(limpio, { defaultCallingCode: prefijoPais });
  if (local) return local;

  // 4. Número válido en el país de la dirección del pedido
  if (paisIso) {
    const delPedido = validar(limpio, String(paisIso).toUpperCase());
    if (delPedido) return delPedido;
  }

  // 5. Ya trae el código de otro país
  const internacional = validar(`+${limpio}`);
  if (internacional) return internacional;

  // Si empieza con 0 (formato local), quitar el 0
  if (limpio.startsWith('0')) limpio = limpio.substring(1);

  // Anteponer prefijo país
  return `${prefijoPais}${limpio}`;
};

module.exports = { normalizarTelefono };