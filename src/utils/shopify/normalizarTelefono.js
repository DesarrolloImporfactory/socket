/**
 * Normaliza un teléfono al formato que usa WhatsApp (sin +, sin espacios, sin guiones).
 * Si viene sin código de país, antepone el prefijo de la configuración (ej: 593 EC).
 * Si empieza con 0 (formato local típico EC), le quita el 0.
 */
const normalizarTelefono = (raw, prefijoPais = '593') => {
  if (!raw) return null;

  // Quitar todo lo que no sea dígito
  let limpio = String(raw).replace(/\D/g, '');
  if (!limpio) return null;

  // Si ya viene con el prefijo del país (ej: 5939...)
  if (limpio.startsWith(prefijoPais)) return limpio;

  // Si empieza con 0 (formato local), quitar el 0
  if (limpio.startsWith('0')) limpio = limpio.substring(1);

  // Anteponer prefijo país
  return `${prefijoPais}${limpio}`;
};

module.exports = { normalizarTelefono };