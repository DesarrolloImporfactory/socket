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

/* Lo que NO es reclamo aunque traiga una palabra fuerte. En la simulación del
   16-oct un chiste de fútbol («qué estafa de árbitro jaja») y un cliente que
   solo daba su marca salieron marcados ⚠️ RECLAMO, y el aviso cambia la
   respuesta entera. Se descarta cuando:
   · habla de fútbol o de un espectáculo, o se ríe, y nada del mensaje toca el
     servicio (su carga, un pago, una respuesta que espera, la empresa…);
   · el mensaje es su marca, un número de cotización o un código y poco más. */
const RE_TEMA_AJENO = new RegExp(
  '\\b(?:partid[oa]s?|gol(?:es|azo)?|arbitro|la tri|seleccion|mundial|eliminatorias|liga|campeonato|copa|futbol|estadio|hincha\\w*|penal(?:es)?|' +
    'serie|pelicula|novela|concierto|chiste|meme)\\b|' +
    '\\b(?:ecuador|mexico|argentina|brasil|colombia|peru|chile|barcelona|emelec|liga de quito|america|chivas|cruz azul|pumas|tigres|monterrey|real madrid)\\b.{0,30}\\b(?:gano|ganamos|perdio|perdimos|empato|jugo|juega|jugaron|vs)\\b',
);
const RE_RISA = /\b(?:ja|je|ji)(?:ja|je|ji)+\w*|\bjsjs\w*|\bxd+\b|\blol\b/;
const RE_RISA_EMOJI = /[\u{1F602}\u{1F923}\u{1F606}\u{1F639}]/u;
const RE_ANCLA_SERVICIO = new RegExp(
  '\\b(?:carga|pedido|mercaderia|mercancia|contenedor|cotizacion(?:es)?|pago|pague|deposit\\w+|transfer\\w+|dinero|plata|reembols\\w+|' +
    'asesor\\w*|ustedes|respuesta|responden|contestan|atienden|curso|clase|plataforma|servicio|empresa|imporfactory|imporsuit|expertos|' +
    'proveedor|envio|guia|marca|bodega|aduana|dropi|tienda|cobr\\w+|saldo|cuota|factura|comprobante)\\b',
);
function temaAjeno(texto, t) {
  const ajeno = RE_TEMA_AJENO.test(t) || RE_RISA.test(t) || RE_RISA_EMOJI.test(String(texto || ''));
  return ajeno && !RE_ANCLA_SERVICIO.test(t);
}

/* Su marca (EC-2609112, MX-PEPE), un número de cotización o un código, con
   hasta tres palabras de relleno («mi marca es MX-PEPE»). */
const RE_CODIGO = /\b[A-Za-z]{2,4}-[A-Za-z0-9]{2,12}\b|\b[A-Za-z]{1,4} ?\d{3,12}\b|\b\d{3,9}\b/g;
const RE_RELLENO = /\b(?:mi|la|el|es|esta|este|esa|ese|marca|codigo|cotizacion|numero|n|no|de|envio|contenedor|carga|ok|si|claro|listo|gracias|aqui|ahi|hola|buenas|buenos|dias|tardes|noches|te|les|paso|mando|dejo|seria|serian|y|con|por|favor|porfa)\b/g;
function soloCodigo(texto) {
  const crudo = String(texto || '');
  if (!RE_CODIGO.test(crudo)) return false;
  RE_CODIGO.lastIndex = 0;
  const resto = llano(crudo.replace(RE_CODIGO, ' ')).replace(RE_RELLENO, ' ').trim();
  return resto.split(/\s+/).filter(Boolean).length <= 3;
}

function esReclamo(texto) {
  const t = llano(texto);
  return RE_RECLAMO.test(t) && !temaAjeno(texto, t) && !soloCodigo(texto);
}

/* Reclama por la DEMORA de su carga. A este cliente no se le repite el estado:
   va a logística. No es lo mismo que preguntar, aunque sea con apuro. */
const RE_DEMORA =
  /\b(?:ya deberia (?:haber )?(?:llegado|salido|estar)|llevo (?:\w+ ){1,3}(?:dias|semanas|meses) esperando|una burla|demasiado tiempo|(?:mucha|tanta|demasiada) demora|se (?:han |estan )?demora\w* (?:mucho|demasiado)|cuanto mas (?:tengo|hay|debo|voy)|sigue sin llegar)\b/;

function reclamaPorDemora(texto) {
  const t = llano(texto);
  return RE_DEMORA.test(t) && !temaAjeno(texto, t) && !soloCodigo(texto);
}

/* Ya dijo CUÁNTAS UNIDADES quiere comprar («quiero traer 500», «300 unidades»,
   «unas 50 piezas»). Lo usa la guardia cuando completa una ficha de cotización
   que el modelo mandó sin el paso a asesor: si la cantidad ya está dicha no se
   vuelve a pedir (la ficha `cotizar-datos` ya no la trae para no pedirla dos
   veces). Generoso a propósito: una señal falsa solo deja de pedir la cantidad;
   una que se escapa la pide de nuevo. «2,5 dólares» o «50 por caja» no cuentan. */
const RE_CANTIDAD = new RegExp(
  '\\b(?:' +
    '\\d{1,6}(?:[.,]\\d{3})*\\s*(?:unidades|unidad|unids?|unds?|uds?|u|piezas|pzas?|pcs|pares|docenas?|cajas|cartones|juegos|kits|sets|pallets?)\\b|' +
    '(?:traer|traerme|comprar|importar|pedir|cotizar|cotizarme|coticen|quiero|quisiera|necesito|unas?|unos|aproximadamente|aprox|minimo|maximo|entre|primero|iniciar con|empezar con)\\s+(?:unas?\\s+|unos\\s+|de\\s+|solo\\s+|al menos\\s+)?\\d{1,6}(?:[.,]\\d{3})*\\b|' +
    '(?:mil|dos mil|tres mil|cinco mil|cien|ciento|doscient[ao]s|trescient[ao]s|quinient[ao]s|diez|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\\s+(?:unidades|piezas|pares|cajas|docenas)' +
    ')\\b',
);

function dioCantidad(texto) {
  return RE_CANTIDAD.test(llano(texto));
}

/* Lo escribió el BOT DE VENTAS de la tienda de un alumno, no una persona.
   Muchos alumnos atienden su tienda con un bot en el mismo WhatsApp con el que
   nos escriben: cuando nuestro bot les contesta, el suyo responde «¿Qué producto
   te interesa?», «¿A qué ciudad te enviamos?» o «Tu pedido está empacado», y
   los dos bots se quedan hablando entre ellos (60 días hasta el 24-oct: 283
   mensajes así en la 265). A eso no se le contesta.

   Solo frases de vendedor dirigidas a un comprador, que un alumno no le dice a
   su escuela. Y si el mensaje habla DEL bot («mira lo que le dice mi bot a mis
   clientes»), es una persona mostrando un caso: se contesta. */
const RE_BOT_DE_TIENDA = new RegExp(
  [
    '\\bque producto te interesa\\b',
    '\\bsoy [a-zñ]+ (?:[a-zñ]+ )?de .{2,40}? un gusto saludarte\\b',
    '\\b(?:en|a) que ciudad (?:(?:te|lo|la|se|quieres que|prefieres que|deseas que) )*(?:enviamos|enviemos|te lo enviamos|recibes|lo recibes)\\b',
    '\\b(?:tu )?pedido (?:ya )?(?:esta )?(?:empacado|listo para salir|listo para despacho)\\b',
    '\\benvio gratis\\b.*\\b(?:solo por hoy|se cae hoy|vence hoy|pagas al recibir|pago contra entrega)\\b',
    '\\bguarda nuestro numero\\b',
    '\\bquieres que (?:lo|te) pase (?:a|con) un asesor\\b',
    '\\b1 por \\d+\\b.*\\b2 por \\d+\\b',
    // Sábado 24-oct, después de publicar: dos bots que se escaparon.
    '\\bquieres que te avisemos por este mismo numero\\b',
    '\\bnecesitamos tu confirmacion del\\b',
    '\\b(?:a )?domicilio o retiro en (?:agencia|oficina)\\b',
  ].join('|'),
);
/* Respuesta automática del negocio del alumno (fuera de su horario) y el «ya te
   paso con un asesor» de su bot: 10 en los 14 días al 24-oct. Son frases que
   una persona también CITA para quejarse o para preguntar cómo ponerlas («me
   dijeron que un asesor le escribirá pronto y nada», «cómo pongo en mi
   WhatsApp nuestro horario de atención es…»), así que valen solo si abren el
   mensaje (en los primeros 40 caracteres) y no hay nada de una persona
   contando su caso (RE_PERSONA_CUENTA). */
const RE_AUTORESPUESTA = new RegExp(
  '^.{0,40}?(?:' +
    [
      '\\bgracias por (?:tu|su) mensaje\\b.{0,80}\\b(?:en este momento|lo antes posible|tan pronto|horario)\\b',
      '\\ben este momento no (?:podemos (?:responder|atenderte|contestar)|estamos disponibles|nos encontramos)\\b',
      '\\bnuestro horario de (?:atencion|servicio) es\\b',
      '\\bun asesor (?:te|le) (?:contactara|escribira|atendera) (?:en breve|pronto|a la brevedad|lo antes posible)\\b',
      '\\bte paso con (?!el\\b|ella\\b|usted\\b|ellos\\b)[a-zñ]+ ahora mismo\\b',
      '\\bpaso tu caso (?:a|con) un asesor\\b',
    ].join('|') +
    ')',
);
const RE_PERSONA_CUENTA =
  /\b(?:me (?:dijeron|dicen|dijo|ponen|pusieron|sale|salio|responden|contestan|escriben)|mi (?:whatsapp|negocio|tienda|numero|pagina|bot|soci[oa])|es mi|mensaje (?:de ausencia|de bienvenida|automatico)|como (?:pongo|hago|configuro|activo|cambio|puedo|se pone)|quiero poner|nadie|ya van|(?:hace|van|llevo) (?:\w+ )?(?:dias|semanas)|\d+ (?:dias|semanas)|porque|cansad[oa]|todavia|aun no|sigo esperando)\b/;
const RE_HABLA_DEL_BOT =
  /\b(?:mi|el|la|tu|su|este|ese) (?:bot|ia|asistente|robot|chatbot|agente)\b|\b(?:le|les) (?:envia|manda|dice|responde|contesta|pregunta|escribe|sale)\b|\bmis? clientes?\b|\bme sale\b|\bmira (?:este|esto|como|lo que)\b|\bejemplo\b|\bpor que (?:dice|pregunta|responde|contesta|manda)\b/;

/* Una persona que PEGA lo que escribió su bot: una copia de chat con fecha
   («[2/10, 17:04] Importaciones Yacelga: …»), el panel («Enviado por Mensaje
   fijo / sin IA»), un guion entre comillas («Saludo + Validación del problema:
   "¡Hola!…»). Salieron así 3 de los 230 de la medición del 24-oct. */
const RE_PEGADO =
  /^\s*\[\d{1,2}\/\d{1,2}(?:\/\d{2,4})?,? \d{1,2}:\d{2}|enviado por|mensaje fijo|\bsin ia\b|validaci[oó]n del problema|^[^\n]{0,60}:\s*\n?\s*["“«]/im;

function esMensajeDeBot(texto) {
  const crudo = String(texto || '');
  const t = llano(crudo);
  if (!t || RE_HABLA_DEL_BOT.test(t) || RE_PEGADO.test(crudo)) return false;
  return RE_BOT_DE_TIENDA.test(t) || (RE_AUTORESPUESTA.test(t) && !RE_PERSONA_CUENTA.test(t));
}

/* NO PIDE NADA: agradece, confirma o avisa que él hará algo («ok», «listo
   amigo gracias», «ya le reviso», «el lunes te los paso»). El prompt ya decía
   que eso se calla (caso E), pero el modelo igual contestaba «Recibido. Lo sumo
   a tu caso para el asesor.»: 7 de las 73 respuestas reales del 23 y 24-oct, y
   dos veces seguidas en el mismo chat. Ahora el motor calla sin llamar al modelo.

   Todo el mensaje tiene que ser de esta lista Y traer al menos una palabra de
   acuse: «buenas tardes amigo» o «estimado» solos no entran (llaman a alguien,
   eso se contesta), ni «por favor» solo (pide que se haga algo), ni «sí» o
   «claro» (contestan una pregunta). Con un «?» no entra. */
const PARTE_DE_ACUSE =
  'ok+|okey|okay|oki|okis|vale|listo|listos|perfecto|excelente|genial|super|chevere|de acuerdo|entendido|entiendo|comprendo|esta bien|bueno|buenisimo|dale|ya|' +
  'graci\\w*|muy amables?|de nada|igualmente|idem|amen|bendiciones|dios (?:te|le|les) bendiga|' +
  'quedo (?:atent[oa]|al pendiente|pendiente|en espera|a la espera|a las ordenes)|(?:estamos|seguimos) en contacto|' +
  '(?:te|le|les) (?:aviso|confirmo|escribo)|' +
  'ya (?:lo|la|le) (?:reviso|veo|hago|intento|pido|envio|mando|paso)|ya trato de hacerlo|voy a (?:revisar|intentar|probar)(?:lo|la)?|lo reviso|lo intento|' +
  '(?:te|le|les) (?:los|las|lo|la) (?:paso|envio|mando|hago llegar)';
const PARTE_DE_RELLENO =
  'el lunes|manana|mas tarde|luego|en un rato|en la tarde|en la noche|' +
  '(?:apenas|cuando|re cuanto) (?:me (?:los|las|lo|la) (?:den|de|pasen|envien|manden)|pueda|tenga)(?: la \\w+)?|' +
  'muchas|mil|ing|inge|amig[oa]|estimad[oa]|senor\\w*|don|dona|lic|y|e|a|tu|usted|saludos|' +
  'buen[ao]?s? (?:dias?|tardes?|noches?)';
const RE_SOLO_ACUSE = new RegExp(`^(?:(?:${PARTE_DE_ACUSE}|${PARTE_DE_RELLENO})(?: |$))+$`);
const RE_UN_ACUSE = new RegExp(`(?:^| )(?:${PARTE_DE_ACUSE})(?: |$)`);
const RE_SOLO_EMOJI = /^(?:[\s‍️]|\p{Extended_Pictographic}|\p{Emoji_Modifier})+$/u; // sin dígitos: «1» o un número no son emoji
// Solo los emojis de acuse: 😡, 👎, 🤔 o ‼️ solos son una queja o una duda (revisión del 24-oct).
const RE_EMOJI_DE_ACUSE = /^(?:[\s‍️]|\p{Emoji_Modifier}|[👍👌🙏❤♥💙💚😊🙂☺😀😃😄😁🥰😍🤗🙌✅✔💪👏🫡🤝💯⭐🌟✨🎉🥳😎👋])+$/u;
// «ok y», «bueno y», «listo a»: el mensaje se cortó, falta lo que pide.
const RE_TERMINA_CORTADO = / (?:y|e|o|a|pero|que|de|con|para|en|por|del|al)$/;

function noPideNada(texto) {
  const crudo = String(texto || '').trim();
  if (!crudo || crudo.includes('?')) return false;
  if (RE_SOLO_EMOJI.test(crudo)) return RE_EMOJI_DE_ACUSE.test(crudo); // 👍 🙏 ❤️ solos
  const t = llano(crudo);
  if (RE_TERMINA_CORTADO.test(t)) return false;
  return t.length <= 120 && RE_SOLO_ACUSE.test(t) && RE_UN_ACUSE.test(t);
}

module.exports = { esSoloSaludo, esReclamo, reclamaPorDemora, dioCantidad, esMensajeDeBot, noPideNada };
