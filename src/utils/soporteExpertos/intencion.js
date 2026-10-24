/* De qué habla el mensaje, sin inteligencia artificial: lo justo para decidir
   si en este turno se consulta la carga del cliente y si está pidiendo datos
   que no son suyos.

   Equivocarse hacia el «sí» sale barato (una consulta de lectura y un bloque
   más de contexto); equivocarse hacia el «no» deja al bot sin el dato. Por eso
   `hablaDeCarga` es generoso, salvo con lo que es claramente otra cosa:
   ecommerce («mi pedido de Dropi»), una pregunta en general («cuánto demora
   una importación»), alguien que quiere HACER un pedido, los pagos y las
   clases.

   En la prueba con 365 conversaciones reales solo vio 14 de 31 preguntas de
   carga. Lo que se le escapaba y ahora mira:
     · «mi pedido», «mi paquete» como carga propia;
     · «las fechas de llegada», «para que la carga llegue»;
     · «está en la aduana», «retirar de la aduana», sin nombrar la carga;
     · «tracking», «rastreo» y el número de cotización;
     · la pregunta suelta: «¿ya llegó?», «¿cuándo llega?», «¿en qué va?»;
     · los tipeos de siempre: «yego», «cuand», «dnd», «contendor», «q». */

'use strict';

const { sinTildes } = require('./texto');
const { soloDigitos, mismoTelefono, colaCandidatos } = require('./telefono');
const { codigosEnMensaje } = require('./cargaCliente');

/* ── Limpieza ─────────────────────────────────────────────────────────────
   Sin tildes, sin signos y con los tipeos más repetidos ya corregidos, para
   escribir cada patrón una sola vez. El fin de frase queda como « | »: así un
   patrón de varias palabras no junta dos frases distintas. */
const TIPEOS = [
  [/\b(?:q|k|qe|ke)\b/g, 'que'],
  [/\bx\b/g, 'por'],
  [/\b(?:cuand|cuado|cuanod|cuamdo|kuando|cdo)\b/g, 'cuando'],
  [/\ba donde\b/g, 'donde'],
  [/\b(?:dnd|dond|onde|adonde|aonde)\b/g, 'donde'],
  [/\b(lleg|yeg)([oa])\2+\b/g, '$1$2'], // «llegoo»
  [/\by(eg(?:o|a|an|aron|aria|arian|ara|ue|uen|ar|ado|ada))\b/g, 'll$1'], // «yego»
  [/\b(?:lla|ia) (?=lleg)/g, 'ya '],
  [/\bmerca(?:deri|dria|daria|eria|dera)(s?)\b/g, 'mercaderia$1'],
  [/\bmerc(?:ansia|anzia|encia)(s?)\b/g, 'mercancia$1'],
  [/\b(?:contendor|contenedro|conteneor|contenerdor|contenedo|container|conteiner)(?:es|s)\b/g, 'contenedores'],
  [/\b(?:contendor|contenedro|conteneor|contenerdor|contenedo|container|conteiner)\b/g, 'contenedor'],
  [/\bcoti[sz]a[sc]i?on(es)?\b/g, 'cotizacion$1'],
  [/\b(?:in|im)porta[sc]i?on(es)?\b/g, 'importacion$1'],
  [/\b(?:traking|trakin|trackin|trakking)\b/g, 'tracking'],
  [/\bpedio(s?)\b/g, 'pedido$1'],
  [/\b(?:aduna|adauna|aduanas)\b/g, 'aduana'],
];
function limpiar(texto) {
  let t = sinTildes(texto)
    .replace(/[.?!;:\n\r]+/g, ' | ')
    .replace(/[^a-z0-9|\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [de, a] of TIPEOS) t = t.replace(de, a);
  return t;
}

/* ── Vocabulario (todo ya limpio) ─────────────────────────────────────────── */

// Estos dos los usa también `pideDatosDeOtro`: no se tocan.
const COSA =
  /\b(carga|cargas|mercaderia|mercancia|contenedor|contenedores|importacion|importaciones|embarque|bultos?|cajas|marca de envio|tracking|rastreo)\b/;
const PEDIDO = /\b(pedido|pedidos|compra|productos?|paquete|paquetes|envio)\b/;

const CALIF =
  '(?:(?:ultim[ao]s?|otr[ao]s?|primer[ao]?s?|segund[ao]s?|tercer[ao]?s?|nuev[ao]s?|proxim[ao]s?|siguientes?|dos|tres|cuatro|cinco|seis|\\d{1,3}) )?';
const N_IMPORT =
  '(?:cargas?|mercaderias?|mercancias?|merca|contenedor(?:es)?|importacion(?:es)?|embarques?|bultos?|cajas?|cartones|pallets?)';
const N_GENERICA = '(?:pedidos?|paquetes?|encargos?)';
const MIO = '(?:mis?|nuestr[oa]s?)';

/* «mi carga», «mis 3 cajas», «la mercadería mía»: una carga de importación
   nombrada como propia. */
const PROPIA = new RegExp(`\\b${MIO} ${CALIF}${N_IMPORT}\\b|\\b${N_IMPORT} (?:mi[oa]s?|nuestr[oa]s?)\\b`);
/* «mi pedido», «mi paquete»: también es su carga, salvo que hable de ecommerce,
   de un pago o de un pedido que todavía quiere hacer. */
const PROPIA_GENERICA = new RegExp(`\\b${MIO} ${CALIF}${N_GENERICA}\\b`);

/* «tracking» y «rastreo» no van aquí: son de la lista SOLA, que se mira después
   de descartar el ecommerce («el rastreo de la guía»). */
const COSA_AMPLIA = new RegExp(`\\b(?:${N_IMPORT}|buque|barco|naviera|embarcacion|marcas? de envio)\\b`);
const PEDIDO_AMPLIO = /\b(?:pedidos?|compras?|productos?|paquetes?|envios?|encargos?|articulos?|mis cosas|lo mio|lo nuestro)\b/;

/* «una importación», «un contenedor»: se habla en general, no de la suya
   («cuánto demora una importación»). No cuenta «tengo una carga…» ni «un
   pedido que hice». */
const INDEFINIDA = new RegExp(
  '(?<!\\b(?:tengo|tenemos|tenia|hice|hicimos|pedi|pedimos|compre|compramos|realice|traje|trajimos|mande|envie|importe|importamos|espero|esperamos|esperando) )' +
    `\\b(?:un|una|unos|unas|cada|cualquier|algun|alguna) ${CALIF}(?:${N_IMPORT}|${N_GENERICA}|compras?|productos?|envios?|articulos?)\\b` +
    '(?! (?:que|mi[oa]|nuestr[oa]) )',
  'g',
);

const MOVER =
  '(?:lleg\\w*|arrib\\w*|zarp\\w*|sal(?:e|en|io|ieron|dra|dran|dria|drian|ga|gan|ir)|vien\\w*|vendr\\w*|vino|embarc\\w*|despach\\w*)';

/* Pregunta por el estado, el lugar o la fecha de algo que viaja. Sola no
   alcanza: hace falta además la cosa («contenedor», «mi pedido»…). */
const ESTADO = new RegExp(
  `\\b(?:${[
    // ¿dónde está?, ¿por dónde va?
    'donde (?:esta|estan|estara|estaran|estaria|anda|andan|va|van|viene|vienen|quedo|quedaron|se encuentran?|se quedo|se quedaron)',
    'por donde (?:va|van|anda|andan|viene|vienen|esta|estan)',
    // ¿cómo va?, ¿en qué va?
    'como (?:va|van|vamos|sigue|siguen|avanza)',
    'en que (?:va|van|vamos|anda|andan|quedo|quedamos|quedaron|estado|estatus|status|paso|parte|etapa|fase|proceso|situacion|punto|contenedor|barco|buque|fecha)',
    'que (?:paso|pasa|ha pasado|a pasado|se sabe|sabes|saben) (?:con|de|del|sobre)',
    'novedad(?:es)?',
    'noticias? (?:de|del|sobre)',
    'no se nada',
    'sin (?:noticias|novedad|novedades|respuesta)',
    'estado (?:de|del|actual)',
    'estatus',
    'status',
    // ¿ya llegó?, ¿cuándo llega?
    `ya (?:me |nos |les? |se )?(?:${MOVER}|esta|estan|estaria|estarian|estara|paso|pasaron)`,
    `ya (?:habra|habran|debe|deben|deberia|deberian|tendria|tendrian|tiene que|tienen que|va a|van a|esta por|estan por|casi|mismo) (?:de )?(?:haber |estar )?(?:${MOVER}|aqui|aca)`,
    `cuando (?:es que |crees que |creen que |mas o menos )?(?:me |nos |les? |se |ya |la |lo |las |los |va a |van a |iria a |estaria |estaran? |podria |puedo |podre |podemos |puede )*(?:${MOVER}|entreg\\w*|retir\\w*|recog\\w*|liber\\w*|esta|estan|estaria|estara|estaran)`,
    'para cuando',
    `que (?:dia|fecha|semana|mes) (?:me |nos |se )?(?:${MOVER}|estaria|estara|entreg\\w*)`,
    'fechas? (?:estimadas? |aproximadas? |tentativas? |exactas? |probables? )?de (?:la |el |su |mi )?(?:llegada|entrega|arribo|salida|zarpe|embarque|despacho|retiro)',
    'fecha (?:estimada|aproximada|tentativa|probable)',
    // todavía no llega
    `(?:todavia|aun|hasta ahora|hasta hoy) no (?:me |nos |se )?(?:${MOVER}|hay)`,
    'no (?:me |nos |les? )?(?:llega|llegan|llego|llegaron|sale|salio|ha llegado|han llegado|a llegado|ha salido|han salido)',
    'para que (?:\\w+ ){0,3}?lleg\\w*',
    'sin llegar',
    'siguen? (?:en|sin|parad|deten|reten)',
    'cuanto (?:tiempo )?(?:mas )?falta',
    'falta (?:mucho|poco)',
    'demorad[oa]s?',
    'atrasad[oa]s?',
    'retras\\w*',
    // seguimiento
    'seguimiento',
    'rastre\\w*',
    'tracking',
    'trackear',
    // aduana, tránsito, retiro
    'aduana',
    'desaduan\\w*',
    'nacionaliz\\w*',
    'en transito',
    'en camino',
    'en altamar',
    'en (?:el )?puerto',
    'liberad[oa]s?',
    'liberacion',
    'liberaron',
    'retirar\\w*',
    'retiro',
    'retire',
    'recoger',
    'ya puedo',
  ].join('|')})\\b`,
);

/* Frases que solo se dicen de una carga en camino: alcanzan sin nombrarla. */
const SOLA = new RegExp(
  `\\b(?:${[
    // «las fechas de llegada», «la fecha del zarpe»
    'fechas? (?:estimadas? |aproximadas? |tentativas? |exactas? |probables? )?de(?:l| la| el| su)? (?:llegada|arribo|zarpe)',
    // «me dicen que está en la aduana», «retirar de la aduana»
    '(?:esta|estan|estaba|sigue|siguen|continua|quedo|quedaron|lleva|llevan|parad[oa]s?|retenid[oa]s?|detenid[oa]s?|trabad[oa]s?|estancad[oa]s?|atascad[oa]s?|retirar|retiro|sacar|liberar|liberen|liberaron|libero) (?:\\w+ ){0,2}?(?:de|en|por) (?:la |las )?aduana',
    // «ya salió de la aduana», «ya pasó por aduana» (pegado: «me llegó un cobro de aduana» no es esto)
    '(?:salio|salieron|paso|pasaron|llego|llegaron|entro|ingreso) (?:ya |hoy |ayer |recien )?(?:de|en|por|a) (?:la |las )?aduana',
    // «tracking», «rastreo»
    'tracking',
    'rastre(?:o|ar|arlo|arla|en|amos)',
    'trackear',
    // «ya salió de China», «todavía sigue en China»
    '(?:ya|aun|todavia) (?:no )?(?:me |nos |se )?(?:sal\\w*|vien\\w*|zarp\\w*|sigue|siguen|esta|estan|part\\w*|despach\\w*|embarc\\w*) (?:\\w+ )?(?:de|desde|en) china',
  ].join('|')})\\b`,
);

/* La pregunta suelta, sin decir de qué: «¿ya llegó?», «¿cuándo llega?», «¿en
   qué va?». Si enseguida nombra otra cosa («ya llegó el link»), no cuenta. */
const SIN_SUJETO =
  '(?! (?:el|la|los|las|mi|mis|un|una|unos|unas|su|sus|tu|tus|es[eao]s?|est[eao]s?|nuestr[oa]s?|algun[ao]?s?|otr[oa]s?|mas(?! o menos)) )';
/* «cuándo llega» pregunta; «me envían fotos cuando llega a China» no. Vale al
   empezar la frase o detrás de un saludo o de un «quería saber». */
const ANTES_DE_CUANDO =
  '(?<=^|\\| |\\b(?:y|pero|entonces|oye|hola|buenas|dias|tardes|noches|consulta|pregunta|favor|porfa|saber|sabes|saben|decir|dime|digame|diganme|dicen|dices|indican|indicar|informan|informar|menos|amig[oa]|estimad[oa]s?) )';
const SUELTA = new RegExp(
  `(?:\\b(?:${[
    'ya (?:me |nos )?(?:llego|llegaron|llegaria|llegarian|llega|llegan|arribo|arribaron|zarpo|zarparon)',
    '(?:todavia|aun) no (?:me |nos )?(?:llega|llegan|llego|llegaron|zarpa|sale)',
    'no (?:me |nos )?(?:ha|han) llegado',
    '(?:por )?donde (?:va|van|viene|vienen|anda|andan)',
    'en que (?:va|van|anda|andan|quedo)',
  ].join('|')})` +
    `|${ANTES_DE_CUANDO}cuando (?:me |nos )?(?:llega|llegan|llegaria|llegarian|llegara|llegaran|arriba|arribaria|zarpa|zarparia))\\b${SIN_SUJETO}`,
);

/* Lo que NO es una carga de importación. */
const ECOMMERCE =
  /\b(dropi|shopify|tienda|guia|guias|transportadora|servientrega|laar|gintracom|cliente final|contra entrega|contraentrega|campana|anuncio|landing|novedad de entrega|wallet|agencia|aliclik|fulfillment)\b/;
const PAGO =
  /\b(?:pago|pagos|pague|pagar|pagare|pagado|pagada|pagando|abono|abone|abonar|transferencia|transferi|transferir|deposito|deposite|depositar|comprobante|factura|facturar|facturen|facturacion|cuenta bancaria|numero de cuenta|que cuenta|saldo|cuota|anticipo|tarjeta|banco|reembolso)\b/;
/* Quiere HACER una importación o un pedido; no pregunta por uno en curso. */
const PLANEA = new RegExp(
  '\\b(?:hacer|hago|hare|haria|realizar|realizo|empezar|empiezo|iniciar|inicio|comenzar|comienzo|armar|cotizar|cotizo|cotizarme|coticen|confirmar|confirmo|aceptar|acepto|aprobar|apruebo) ' +
    `(?:con ustedes |ya |ahora |hoy |pronto )?(?:mis?|un|una|unos|unas|el|la|otr[oa]|nuestr[oa]) ${CALIF}(?:importacion|importaciones|pedido|pedidos|compra|compras|carga|cargas|contenedor|paquete|mercaderia)\\b` +
    '|\\bmis? (?:primer[ao]?|proxim[ao]|siguiente|futur[ao]) (?:importacion|carga|pedido|compra|contenedor)\\b' +
    '|\\bpor donde (?:empiezo|empezar|comienzo|inicio)\\b' +
    '|\\bcomo (?:empiezo|empezar|comienzo|inicio|importo|importar)\\b',
);
/* Con una pregunta suelta («¿ya llegó?») cualquiera de estos temas manda. */
const OTRO_TEMA =
  /\b(?:pago|pagos|pague|transferencia|transferi|deposito|deposite|comprobante|factura|dinero|plata|reembolso|clases?|cursos?|link|enlace|zoom|grabacion(?:es)?|accesos?|usuario|contrasena|clave|correo|email|mail|certificado|plataforma|modulo|leccion|videos?|profe|profesor[a]?|mentor(?:a|ia)?|taller|webinar|reunion|cotizacion|proforma|catalogo|membresia|suscripcion)\b/;
const MARCA = /\b(?:ec|mx)[- ]?\d{5,9}\b/;

/* Número de cotización escrito en el mensaje, con la misma regla estricta que
   usa el bloque de carga («cotización de 500 unidades» no es un número). */
const traeCotizacion = (texto) =>
  codigosEnMensaje(sinTildes(texto).replace(/coti[sz]a[sc]i?on/g, 'cotizacion')).cotizaciones.length > 0;

/** ¿El cliente pregunta por el estado de SU carga de importación? */
function hablaDeCarga(texto) {
  const t = limpiar(texto);
  if (!/[a-z0-9]/.test(t)) return false;

  // 1. Un código suyo: la marca de envío o el número de cotización.
  if (MARCA.test(t)) return true;
  const estado = ESTADO.test(t);
  const soloPago = PAGO.test(t) && !estado;
  if (!soloPago && traeCotizacion(texto)) return true;

  // 2. Su carga, nombrada como suya.
  const planea = PLANEA.test(t) && !estado;
  if (PROPIA.test(t) && !planea) return true;
  const ecommerce = ECOMMERCE.test(t);
  if (PROPIA_GENERICA.test(t) && !ecommerce && !planea && !soloPago) return true;

  // 3. Una pregunta en general («cuánto demora una importación») no es la suya.
  const u = t.replace(INDEFINIDA, ' ');
  const cosa = COSA_AMPLIA.test(u);
  const pedido = PEDIDO_AMPLIO.test(u);
  if (u !== t && !cosa && !pedido) return false;

  // 4. Pregunta por el estado de algo que viaja.
  if (estado && cosa) return true;
  if (estado && pedido && !ecommerce) return true;
  if (ecommerce) return false;

  // 5. Frases que solo se dicen de una carga en camino.
  if (SOLA.test(t)) return true;

  // 6. La pregunta suelta, si no habla de un pago, una clase o un acceso.
  return SUELTA.test(t) && !OTRO_TEMA.test(t);
}

const TERCERO =
  /\b(?:de|del|a nombre de|para|por)\s+(?:mi|un|una|el|la|mis)?\s*(soci[oa]|amig[oa]|espos[oa]|marido|mujer|herman[oa]|prim[oa]|cunad[oa]|jef[ea]|companer[oa]|clientes?|papa|mama|padre|madre|hij[oa]|novi[oa]|pareja|familiar|conocid[oa]|vecin[oa]|ti[oa]|suegr[oa]|otra persona|otro cliente|otro numero|otro usuario|otro alumno|otra cuenta|otro telefono|un tercero|terceros)\b/;
const HABLA_DE_NUMERO = /\b(numero|telefono|celular|cel|whatsapp|wsp)\b/;
// Diez dígitos seguidos también son una cuenta bancaria, una cédula o una referencia.
const NO_ES_TELEFONO = /\b(cuenta|banco|transferencia|transferi|deposito|deposite|comprobante|referencia|cedula|ruc|factura)\b/;
const SOY_DEL_EQUIPO = /\bsoy (asesor|asesora|del equipo|de logistica|de soporte|administrador|admin|el dueno|daniel|supervisor)/;

/**
 * ¿Pide datos de una carga que no es la del número que escribe?
 * @returns {{pide:boolean, motivo:string|null}}
 */
function pideDatosDeOtro(texto, telefonoRemitente) {
  const t = sinTildes(texto);
  // Todo lo que dispara la consulta de la carga pasa también por esta revisión.
  const deCarga = COSA.test(t) || PEDIDO.test(t) || /cotizacion|estado|llega|donde/.test(t) || hablaDeCarga(texto);
  if (!deCarga) return { pide: false, motivo: null };

  if (TERCERO.test(t)) return { pide: true, motivo: 'la carga de otra persona' };
  if (SOY_DEL_EQUIPO.test(t)) return { pide: true, motivo: 'dice ser del equipo' };

  // Un teléfono escrito en el mensaje que no es el del remitente.
  const escritos = (String(texto).match(/\+?\d[\d\s().-]{7,16}\d/g) || [])
    .map(soloDigitos)
    .filter((d) => d.length >= 9 && d.length <= 13 && colaCandidatos(d));
  const ajeno = escritos.find(
    (d) => !mismoTelefono(telefonoRemitente, d) && soloDigitos(telefonoRemitente).slice(-9) !== d.slice(-9),
  );
  const loSenala = HABLA_DE_NUMERO.test(t) || /\b(del|al|con el|para el)\s+\+?\d/.test(t);
  if (ajeno && loSenala && !NO_ES_TELEFONO.test(t)) {
    return { pide: true, motivo: 'otro número de teléfono' };
  }
  return { pide: false, motivo: null };
}

/* ¿El cliente habla de SU IMPORCHAT o de su bot? Misma regla estricta que se
   midió el 24-oct sobre 60 días de la 265 (951 mensajes de 273 personas).
   Solo decide si el diagnóstico puede reemplazar al «un asesor te escribe»
   cuando la guardia rechaza la respuesta (herramientas.js); no dispara nada. */
const DE_IMPORCHAT =
  /imporchat|chat ?center|mi bot|el bot|del bot|api ?key|open ?ai|chat ?gpt|prompt|desconect|no me responde el|no responde el bot|no contesta el bot|probar como cliente|columna|kanban/;
function hablaDeImporchat(texto) {
  return DE_IMPORCHAT.test(limpiar(texto));
}

module.exports = { hablaDeCarga, hablaDeImporchat, pideDatosDeOtro };
