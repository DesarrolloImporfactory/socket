/* Señales del MENSAJE DEL CLIENTE que la guardia necesita y que no dependen
   del modelo. Sin red y sin IA: expresiones escritas a mano, pensadas para
   fallar hacia «no lo vi» (una señal que se escapa deja el turno como estaba;
   una señal falsa cambia la respuesta).

   Salen de la prueba en papel de la versión 2 (365 conversaciones): lo que la
   guardia no veía y sí importó.
     · esSoloSaludo        el bot calló ante un saludo que nunca contestó;
     · esReclamo           mandó un reclamo a cobranza y le pidió el comprobante;
     · reclamaPorDemora    le repitió el estado de la carga a quien reclamaba
                           por la demora (prompt, punto H.7). */

'use strict';

const { sinTildes } = require('./texto');

/** minúsculas, sin tildes, sin signos ni emojis, un solo espacio. */
const llano = (t) =>
  sinTildes(t)
    .replace(/[^a-z0-9ñ\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* Solo saluda, toca un botón o manda el mensaje de entrada de la plataforma:
   todavía no dijo qué necesita. Todo el mensaje tiene que ser de esta lista. */
const PARTE_DE_SALUDO =
  'hola+|ola|alo|hey|holi|buen(?:as|os)?(?: (?:dias?|tardes?|noches?))?|muy buen(?:as|os) (?:dias?|tardes?|noches?)|saludos(?: cordiales)?|' +
  'que tal|como (?:estas?|estan|esta|les va|te va|va todo)|espero que (?:estes?|esten) (?:muy )?bien|' +
  'una (?:consulta|pregunta|consultita)|tengo una (?:consulta|pregunta|duda)|necesito ayuda|ayuda|me (?:pueden|puedes|podrian) ayudar|' +
  'disculpen?|disculpa|estimad[oa]s?|amig[oa]s?|senor(?:es|a|ita)?|por favor|porfa|y|' +
  'comunicarme ahora|continuar conversacion|soy parte del club de importadores|necesito comunicarme con mi asesor';
const RE_SOLO_SALUDO = new RegExp(`^(?:(?:${PARTE_DE_SALUDO})(?: |$))+$`);

function esSoloSaludo(texto) {
  const t = llano(texto);
  return Boolean(t) && t.length <= 160 && RE_SOLO_SALUDO.test(t);
}

/* Reclama o está molesto. Solo marcas fuertes: «todavía no llega» o «¿ya me
   contestan?» no alcanzan. */
const RE_RECLAMO = new RegExp(
  '\\b(?:' +
    'estaf\\w+|fraude|me robaron|ladrones|denunci\\w+|abogad\\w+|defensoria|' +
    'reclam\\w+|queja|quejarme|exijo|exigimos|inaceptable|irresponsab\\w+|incumpl\\w+|' +
    'una burla|se burlan|pesim\\w+|mal servicio|falta de respeto|' +
    'me siento enganad\\w+|me enganaron|mentiros\\w+|me mintieron|' +
    'devuelvan(?:me)? (?:mi|el) (?:dinero|plata)|quiero (?:de vuelta )?mi (?:dinero|plata)|reembols\\w+|darme de baja|' +
    'nadie (?:me |nos )?(?:responde|contesta|atiende|ayuda|da respuesta|dice nada|da razon)|' +
    'no me (?:responden|contestan|atienden)|' +
    'llevo (?:\\w+ ){1,3}(?:dias|semanas|meses|horas) (?:esperando|escribiendo|sin)|' +
    'hart[oa] de|cansad[oa] de esperar|con quien (?:me quejo|reclamo)|' +
    // pagó y no recibió: es un reclamo, no una consulta de pago
    '(?:pague|deposite|transferi|cancele)\\b.{0,80}\\b(?:no (?:me |nos )?(?:ha|han)\\b|nada\\b|nunca\\b)' +
    ')',
);

function esReclamo(texto) {
  return RE_RECLAMO.test(llano(texto));
}

/* Reclama por la DEMORA de su carga. A este cliente no se le repite el estado:
   va a logística. No es lo mismo que preguntar, aunque sea con apuro. */
const RE_DEMORA =
  /\b(?:ya deberia (?:haber )?(?:llegado|salido|estar)|llevo (?:\w+ ){1,3}(?:dias|semanas|meses) esperando|una burla|demasiado tiempo|(?:mucha|tanta|demasiada) demora|se (?:han |estan )?demora\w* (?:mucho|demasiado)|cuanto mas (?:tengo|hay|debo|voy)|sigue sin llegar)\b/;

function reclamaPorDemora(texto) {
  return RE_DEMORA.test(llano(texto));
}

module.exports = { esSoloSaludo, esReclamo, reclamaPorDemora };
