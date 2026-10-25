/* Mezcla de `ia_ajustes.soporte_expertos` al reinstalar el bot de Expertos.

   El instalador pisa solo las banderas que maneja (cargas, fichas, guardia,
   herramientas) y conserva lo demás que la cuenta ya tenga —hoy
   `diagnostico`, que se enciende aparte—. Sin esto, reinstalar el prompt
   apagaba en silencio la revisión de la cuenta IMPORCHAT.

   Función pura en su propio archivo: el instalador corre al cargarlo y no se
   puede probar con `require`. */

'use strict';

function mezclarSoporteExpertos(previo, { cargas, fichas, herramientas }) {
  const antes =
    previo?.soporte_expertos && typeof previo.soporte_expertos === 'object' && !Array.isArray(previo.soporte_expertos)
      ? previo.soporte_expertos
      : {};
  return { ...antes, cargas, fichas, guardia: true, herramientas };
}

module.exports = { mezclarSoporteExpertos };
