'use strict';

/* Enlace de ubicación de una sede, para mandárselo al cliente.

   WhatsApp no nos deja leer la ubicación que comparte el cliente, pero sí
   mandarle la nuestra, y "¿cómo llego?" es la duda que más se repite antes de
   una cita presencial.

   Si el negocio no pegó su enlace de Maps se arma uno de búsqueda con la
   dirección: no es tan preciso como el pin, pero es infinitamente mejor que no
   mandar nada. Se calcula al leer y no se guarda, para que siga la dirección
   si la cambian. */

function enlaceUbicacionSede(sede) {
  if (!sede) return null;

  const propio = String(sede.google_maps_url || '').trim();
  if (propio) return propio;

  const partes = [sede.direccion, sede.ciudad, sede.provincia]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (!partes.length) return null;

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(partes.join(', '))}`;
}

module.exports = { enlaceUbicacionSede };
