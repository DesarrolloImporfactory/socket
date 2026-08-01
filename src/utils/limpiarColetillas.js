'use strict';

/* Quita las coletillas de relleno con las que el modelo cierra los mensajes.

   "Si necesitas más información, no dudes en decírmelo", "estoy aquí para
   ayudarte", "quedo atenta a cualquier consulta". No aportan nada, y son lo
   primero que delata que del otro lado hay una máquina: nadie que atienda un
   local escribe así tres veces seguidas.

   Se prohibieron en el prompt y el modelo las siguió escribiendo, así que se
   cortan acá. Solo se eliminan cuando son una frase completa: si aparecen
   dentro de una oración con contenido real, se dejan — perder información del
   cliente sería peor que sonar robótico. */

const PATRONES = [
  /si (?:necesitas|necesita|requieres|quieres) (?:m[aá]s |alguna |cualquier )?(?:informaci[oó]n|ayuda|algo|consulta|duda)[^.!?\n]*[.!?]?/i,
  /no dudes en (?:escribirme|decirme|dec[ií]rmelo|consultarme|contactarme|preguntar)[^.!?\n]*[.!?]?/i,
  /(?:aqu[ií]|ac[aá]) (?:estoy|estar[eé]) (?:para ayudarte|si necesitas|a la orden)[^.!?\n]*[.!?]?/i,
  /estoy (?:aqu[ií]|ac[aá]) para (?:ayudarte|lo que necesites|servirte)[^.!?\n]*[.!?]?/i,
  /(?:quedo|estar[eé]) (?:atenta|atento|pendiente)[^.!?\n]*[.!?]?/i,
  /cualquier (?:cosa|duda|consulta)(?: me)? (?:dices|avisas|escribes|comentas)[^.!?\n]*[.!?]?/i,
  /si tienes (?:alguna |cualquier )?(?:otra )?(?:duda|pregunta|consulta)[^.!?\n]*[.!?]?/i,
];

/* Emojis y espacios que quedan colgando cuando la frase se va: "¡Nos vemos! 💖
   Si necesitas algo, aquí estoy. 😊" no puede terminar en un emoji huérfano. */
const limpiarSobrantes = (texto) =>
  texto
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();

function limpiarColetillas(texto) {
  if (!texto || typeof texto !== 'string') return texto;

  let salida = texto;

  for (const patron of PATRONES) {
    salida = salida.replace(new RegExp(patron.source, 'gi'), '');
  }

  salida = limpiarSobrantes(salida);

  /* Si la limpieza dejó una línea que ya no dice nada —solo emojis o signos—
     se elimina entera: un mensaje que llega con un "😊" suelto es peor que la
     coletilla que se quitó. */
  salida = salida
    .split('\n')
    .filter((linea) => {
      const sinAdornos = linea
        .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.,!¡?¿:;-]/gu, '')
        .trim();
      return linea.trim() === '' || sinAdornos.length > 0;
    })
    .join('\n')
    .trim();

  // Si se quedó sin nada que decir, se devuelve el original: mejor robótico
  // que mudo.
  return salida.length >= 3 ? salida : texto;
}

module.exports = { limpiarColetillas, PATRONES };
