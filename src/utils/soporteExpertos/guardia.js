/* Última revisión de lo que escribió el modelo, ANTES de que le llegue al
   cliente. Es código, no otro prompt: lo que el prompt prohíbe y el modelo
   escribe igual, acá se ataja.

   Son los mismos candados que usa el asistente interno de los asesores en
   Imporsuit (`Class/AsistenteFront::revisar`), que en la prueba en papel con
   365 conversaciones frenaron cerca del 2 % de las respuestas, más los que
   pide un bot que le habla directo al cliente:

     1. cifra, plazo, monto, enlace, correo o ESTADO de una carga («ya está en
        aduana») que no esté respaldado por un dato leído (las fichas de la
        base, la carga del cliente, los textos fijos);
     2. voseo — se corrige a tuteo con una tabla de formas conocidas;
     3. cargo interno («Pricing», «supervisor») — se cambia por el nombre que
        sí puede leer el cliente;
     4. presentarse como una persona;
     5. marcador sin llenar («[nombre]», «{{…}}») o respuesta larguísima;
     6. contestar con una ficha que pasa el caso a una persona (`pasar_a`) sin
        decirle al cliente que un asesor lo retoma — se le agrega el aviso;
     7. ofrecer algo que el bot no puede hacer («te cotizo», «te llamamos»,
        «¿quieres que te pidamos más fotos?», «ya verifiqué tu pago»);
     8. mandar un RECLAMO a cobranza o pedirle el comprobante, y repetirle el
        estado de la carga a quien reclama por la demora;
     9. callar ante el primer saludo — sale el saludo fijo;
    10. el aviso de «un asesor te escribe» dos veces en el mismo mensaje — se
        deja uno.
   Los puntos 7 a 10 salen de la prueba en papel de la versión 2: son lo que
   la guardia no veía y sí importó.

   Lo que no se puede corregir con certeza no se manda: sale el texto seguro
   del turno (el estado oficial de la carga, si era eso lo que preguntó, o el
   paso a asesor). Un «un asesor te escribe» de más cuesta poco; una fecha
   inventada cuesta la confianza del cliente.

   Lo que el CLIENTE escribió solo respalda sus CÓDIGOS: se le puede repetir su
   número de cotización, su marca o cuántas unidades dijo. No respalda plazos,
   montos ni cifras sueltas: que él diga «¿llega el 15?» o «¿son 850?» no
   autoriza al bot a contestar «sí, el 15» ni «sí, 850».

   Antes de revisar se quitan dos cosas que el modelo agrega y no son un dato:
   la despedida del final («¡Buen fin de semana!») y el formato de enlace de
   markdown. Así una buena respuesta no se pierde por un «hasta pronto». */

'use strict';

const { sinTildes } = require('./texto');
const { MENSAJE_ASESOR, CIERRE_ASESOR, MENSAJE_SALUDO, PREGUNTA_CANTIDAD, MENSAJE_ROBOT } = require('./textos');

const MAX_RESPUESTA = 1500;

const RE_TAG = /\[[a-z_]+\]\s*:\s*(?:true|false)/gi;
const RE_URL = /(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
const RE_CORREO = /[\w.+-]+@[\w-]+\.[\w.-]*[a-z]/gi;
const RE_MARCADOR = /\{\{|\}\}|\[[^\]\n]{1,30}\]|\{[a-zñ_ ]{2,30}\}|N\.º\s*…/iu;

/* ── Voseo → tuteo ─────────────────────────────────────────────────────── */
const VOSEO_A_TU = {
  'con vos': 'contigo', 'a vos': 'a ti', 'para vos': 'para ti', 'de vos': 'de ti', vos: 'tú', sos: 'eres',
  tenés: 'tienes', tenes: 'tienes', podés: 'puedes', podes: 'puedes', querés: 'quieres', queres: 'quieres',
  sabés: 'sabes', hacés: 'haces', necesitás: 'necesitas', pagás: 'pagas', mandás: 'mandas',
  enviás: 'envías', esperás: 'esperas', comprás: 'compras', usás: 'usas', pasás: 'pasas',
  confirmás: 'confirmas', perdés: 'pierdes', entendés: 'entiendes', debés: 'debes',
  decís: 'dices', venís: 'vienes', asumís: 'asumes', pedís: 'pides', recibís: 'recibes',
  escribís: 'escribes', elegís: 'eliges', seguís: 'sigues', preferís: 'prefieres', vivís: 'vives',
  mirá: 'mira', esperá: 'espera', revisá: 'revisa', ingresá: 'ingresa', entrá: 'entra',
  probá: 'prueba', buscá: 'busca', usá: 'usa', contá: 'cuenta', enviá: 'envía', mandá: 'manda',
  tomá: 'toma', hacé: 'haz', andá: 've', vení: 'ven', avisá: 'avisa', llamá: 'llama', dejá: 'deja',
  fijate: 'fíjate', decime: 'dime', pasame: 'pásame', mandame: 'mándame', enviame: 'envíame',
  contame: 'cuéntame', avisame: 'avísame', confirmame: 'confírmame', escribime: 'escríbeme',
  indicame: 'indícame', compartime: 'compárteme', dejame: 'déjame', esperame: 'espérame',
  pedile: 'pídele', preguntale: 'pregúntale', decile: 'dile', mandale: 'mándale', escribile: 'escríbele',
  comunicate: 'comunícate', acordate: 'acuérdate', quedate: 'quédate',
};
/* «estás», «puedes», «envíame» son tuteo y no están en la tabla. Las formas
   ambiguas («escribí», «pedí», «abrí» también son «yo» en pasado) tampoco:
   corregirlas rompería frases correctas. */
const FORMAS_VOSEO = Object.keys(VOSEO_A_TU).sort((a, b) => b.length - a.length);
const RE_VOSEO = new RegExp(`(?<!\\p{L})(${FORMAS_VOSEO.join('|')})(?!\\p{L})`, 'giu');

function corregirVoseo(texto) {
  let cambios = 0;
  const out = texto.replace(RE_VOSEO, (m) => {
    const tu = VOSEO_A_TU[m.toLowerCase()];
    if (!tu) return m;
    cambios += 1;
    return m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase() ? tu[0].toUpperCase() + tu.slice(1) : tu;
  });
  return { texto: out, cambios };
}

/* ── Cargos internos → como se le dicen al cliente ─────────────────────── */
const CARGOS = [
  { re: 'l[ií]der comercial', articulo: 'la', nombre: 'persona responsable' },
  { re: 'supervisor(?:a|es)?', articulo: 'la', nombre: 'persona responsable' },
  { re: '(?:(?:[aá]rea|equipo|departamento)\\s+de\\s+)?pricing', articulo: 'el', nombre: 'área de precios' },
  { re: 'front\\s+de\\s+ecommerce', articulo: 'el', nombre: 'equipo de ecommerce' },
  { re: 'front(?:\\s+de\\s+importaciones)?', articulo: '', nombre: 'tu asesor' },
];
const RE_CARGO_RESTANTE =
  /(?<!\p{L})(supervisor(?:a|es)?|pricing|l[ií]der comercial|front(?: de (?:ecommerce|importaciones))?)(?!\p{L})/iu;

function cambiarCargos(texto) {
  let out = texto;
  let cambios = 0;
  for (const c of CARGOS) {
    const re = new RegExp(`(?<!\\p{L})(?:(al|del|el|la|un|una|los|las)\\s+)?${c.re}(?!\\p{L})`, 'giu');
    out = out.replace(re, (m, art) => {
      cambios += 1;
      const a = String(art || '').toLowerCase();
      let nuevo;
      if (!c.articulo) nuevo = a === 'al' ? `a ${c.nombre}` : a === 'del' ? `de ${c.nombre}` : c.nombre;
      else if (a === 'al') nuevo = c.articulo === 'el' ? `al ${c.nombre}` : `a la ${c.nombre}`;
      else if (a === 'del') nuevo = c.articulo === 'el' ? `del ${c.nombre}` : `de la ${c.nombre}`;
      else nuevo = `${c.articulo} ${c.nombre}`;
      return art && m[0] !== m[0].toLowerCase() ? nuevo[0].toUpperCase() + nuevo.slice(1) : nuevo;
    });
  }
  return { texto: out, cambios };
}

/* ── Presentarse como persona ──────────────────────────────────────────── */
const RE_PERSONA =
  /(?<!\p{L})(mi nombre es|me llamo|hablas con (?!el asistente|un asistente)|est[aá]s hablando con (?!el asistente|un asistente)|(?<!no )soy\s+(?:(?:tu|su|una?|el|la)\s+)?(?:asesor|asesora|ejecutiv[oa]|agente|encargad[oa]|persona|human[oa]|especialista|representante|coordinador[a]?)(?!\p{L})|(?<!no )soy (?:parte )?del equipo)/iu;
// Con nombre propio: «Soy Carla», «Habla Carla», «te saluda Andrés». Un área
// («Te atiende Logística») no es una persona.
const RE_PERSONA_NOMBRE =
  /(?<!\p{L})(?:[Ss]oy|[Hh]abla|(?:[Tt]e|[Ll]es?)\s+(?:saluda|habla|atiende|escribe))\s+(?!IMPORFACTORY|Log[ií]stica|Cobranza|Soporte|Precios|Ecommerce|Contabilidad)[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?=[\s,.!]|$)/u;

/* ── Plazos y promesas de tiempo ───────────────────────────────────────── */
const NUMERO_EN_LETRAS =
  'un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\\p{L}+|veinte|veinti\\p{L}+|' +
  '(?:treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)(?: y \\p{L}+)?|cien|ciento(?: \\p{L}+)?|' +
  'unos|unas|pocos|pocas|par de|algunos|algunas|varios|varias|muchos|muchas|cuantos|cuantas';
const UNIDAD_DE_TIEMPO = 'minutos?|horas?|hrs?|d[ií]as?|semanas?|mes(?:es)?|años?';
const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre';
/* Van primero las expresiones completas («24 de octubre», «30 minutos»): se
   comparan ENTERAS contra el respaldo. Con las cifras sueltas no alcanza: si
   el dato leído dice «24 de octubre» y un texto fijo dice «30 minutos», un
   «llega el 30 de octubre» o un «en 24 horas» pasarían cifra por cifra. */
const RE_PLAZO = new RegExp(
  '(?<![\\p{L}\\d])(' +
    `\\d{1,2}\\s+de\\s+(?:${MESES})(?:\\s+de(?:l)?\\s+\\d{4})?|` +
    '\\d{1,2}[\\/-]\\d{1,2}(?:[\\/-]\\d{2,4})?|' +
    `\\d+(?:\\s*(?:a|o|y|-)\\s*\\d+)?\\s*(?:${UNIDAD_DE_TIEMPO})|` +
    // un día suelto: «llega el 30», «el día 7», «para el 15»
    `(?:el|al|del)\\s+(?:d[ií]a\\s+)?\\d{1,2}(?![\\d%/-])(?!\\s*(?:de\\s+(?:${MESES})|${UNIDAD_DE_TIEMPO}|unidades|cajas|marcas|cargas|productos|piezas|pcs|bultos))|` +
    'pasado mañana|mañana|hoy mismo|hoy|anteayer|antier|ayer|anoche|esta (?:tarde|noche|mañana)|' +
    '(?:esta|la pr[oó]xima|la otra|la siguiente|la primera|la segunda|la tercera|la cuarta|la [uú]ltima) semana|' +
    '(?:este|el pr[oó]ximo|el otro|el siguiente) mes|' +
    '(?:semana|mes|año|quincena) (?:que viene|entrante|pr[oó]xim[oa]|siguiente|pasad[oa]|anterior)|' +
    `pr[oó]xim[oa]s? (?:${UNIDAD_DE_TIEMPO})|` +
    'en el transcurso de(?:l| la| el)? (?:d[ií]a|semana|tarde|mañana|mes)|durante el d[ií]a|a lo largo del d[ií]a|' +
    'lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|' +
    `${MESES}|` +
    'fin(?:es)? de (?:mes|semana|año)|finales de|mediados de|principios de|inicios de|quincena|' +
    `hace (?:(?:${NUMERO_EN_LETRAS}|\\d+) )?(?:${UNIDAD_DE_TIEMPO}|poco|rato)|` +
    'en breve|en seguida|enseguida|de inmediato|inmediatamente|en un momento|en unos momentos|a primera hora|lo antes posible|' +
    'muy pronto|pronto|dentro de poco|en poco tiempo|en cualquier momento|ya casi|m[aá]s tarde|al rato|' +
    `(?:${NUMERO_EN_LETRAS})\\s+(?:${UNIDAD_DE_TIEMPO})` +
    ')(?!\\p{L})',
  'giu',
);
/* Plata y porcentajes, en cifras o en letras: la expresión entera tiene que
   estar en el respaldo. */
const MONEDA = 'd[oó]lares|usd|pesos|rmb|yuanes|yuan|soles';
const RE_DINERO = new RegExp(
  `(?:us\\$|\\$|usd)\\s*\\d[\\d.,]*|\\d[\\d.,]*\\s*(?:${MONEDA}|%|por ciento)|` +
    `(?<!\\p{L})(?:${NUMERO_EN_LETRAS}|mil|dos ?cientos|tres ?cientos|cuatro ?cientos|quinientos|seis ?cientos|sete ?cientos|ocho ?cientos|nove ?cientos|mill[oó]n(?:es)?|medio)(?:\\s+(?:y\\s+|mil\\s+)?\\p{L}+){0,2}?\\s+(?:${MONEDA}|por ciento)(?!\\p{L})`,
  'giu',
);
/* Un dominio escrito sin «http» también es un enlace («tracking.ejemplo.app/…»). */
const RE_DOMINIO =
  /(?<![\p{L}\d@.-])(?:[a-z0-9-]+\.)+(?:com|app|net|org|ec|mx|io|co|pro|me|link|ly|info|site|online|store|shop|page|dev)(?![\p{L}\d-])(?:\/[^\s<>"'«»]*)?/giu;

const plano = (t) => sinTildes(t).replace(/\s+/g, ' ');
/** Solo palabras y números, separados por un espacio (para comparar frases). */
const limpio = (t) => sinTildes(t).replace(/[^a-z0-9/%$-]+/g, ' ').trim();

/* Afirmaciones sobre DÓNDE está una carga. No llevan cifras ni plazos, así que
   los otros candados no las ven: «tu carga ya está en aduana» dicho sin dato
   es tan inventado como una fecha. Solo pasan si la misma frase está en el
   respaldo de estado (cuando se consultó la carga, SOLO su bloque; si no, las
   fichas). Se busca sobre el texto ya sin tildes.
   Costo conocido: si en el turno se consultó la carga y el cliente preguntó
   otra cosa que usa una de estas frases («¿qué significa en aduana?»), la
   respuesta de la ficha no pasa y sale el texto seguro del turno. Es el lado
   barato del error: lo otro es decirle a alguien dónde está una carga que no
   se leyó. «En la bodega de China» no está en la lista a propósito. */
const RE_ESTADO_CARGA =
  /\b(en transito|en aduana|retenid[oa]s?|detenid[oa]s?|en inspeccion|en aforo|liberad[oa]s?|asignad[oa] a(?:l| un) contenedor|en nuestra bodega|en (?:la )?bodega de (?:destino|ecuador|mexico)|recibimos tu mercaderia|(?:fue|fueron|ha sido) (?:entregad|despachad|embarcad|enviad)[oa]s?|despachad[oa]s?|embarcad[oa]s?|(?:ya )?(?:salio|salieron|zarpo|llego|llegaron|arribo|desembarco)|en camino|por llegar|(?:en|al) (?:el )?puerto|en alta mar|nacionalizad[oa]s?|list[oa]s? para (?:retirar|el retiro|la entrega|entregar))\b/g;

/* ── Lo que se quita antes de revisar ──────────────────────────────────── */
const RE_DESPEDIDA =
  /^[¡!\s]*(?:hasta (?:pronto|luego|manana|la proxima|entonces)|que tengas (?:un |una )?(?:muy |buen |buena |excelente |lindo |linda |feliz |bonito |bonita )*(?:dia|tarde|noche|fin de semana|semana|domingo|jornada)[^.!?]*|(?:muy )?buen(?:as|os|a)? (?:dia|dias|tarde|tardes|noche|noches|fin de semana|semana|jornada)|feliz (?:dia|tarde|noche|fin de semana|semana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)|saludos(?: cordiales)?|un (?:abrazo|saludo)|bendiciones|gracias por (?:escribir|escribirnos|comunicarte|contactarnos)[^.!?]*|quedo atent[oa][^.!?]*|estamos para (?:servirte|ayudarte)[^.!?]*)[.!\s]*$/;

/** Quita la despedida del final, si hay algo antes. Devuelve { texto, cambios }. */
function quitarDespedida(texto) {
  const partes = String(texto).split(/(?<=[.!?…])\s+|\n+/).filter((x) => x.trim());
  let cambios = 0;
  while (partes.length > 1 && RE_DESPEDIDA.test(sinTildes(partes[partes.length - 1]).trim())) {
    partes.pop();
    cambios += 1;
  }
  if (!cambios) return { texto, cambios: 0 };
  // Se conserva el texto tal cual hasta donde empezaba la despedida.
  const ultimo = partes[partes.length - 1];
  const hasta = texto.lastIndexOf(ultimo) + ultimo.length;
  return { texto: texto.slice(0, hasta).trimEnd(), cambios };
}

/** «[texto](https://…)» → la dirección sola (WhatsApp no entiende markdown). */
function aplanarEnlaces(texto) {
  let cambios = 0;
  const out = String(texto).replace(/\[([^\]\n]{1,80})\]\(((?:https?:\/\/|www\.)[^)\s]+)\)/g, (_, t, url) => {
    cambios += 1;
    const mismo = url.replace(/^https?:\/\//, '').replace(/\/$/, '') === t.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return mismo ? url : `${t}: ${url}`;
  });
  return { texto: out, cambios };
}

/** «2,5» y «2.50» son la misma cifra. */
function numero(n) {
  let x = String(n).replace(',', '.');
  if (x.includes('.')) x = x.replace(/0+$/, '').replace(/\.$/, '');
  x = x.replace(/^0+/, '');
  return x === '' ? '0' : x;
}
const cifras = (t) => (String(t).match(/\d+(?:[.,]\d+)?/g) || []).map(numero);

/* Dónde SÍ se puede repetir una cifra que escribió el cliente: como código
   (su cotización, su marca, su guía) o como cantidad de unidades. */
const RE_CODIGO_DEL_CLIENTE = new RegExp(
  '((?:cotizaci[oó]n(?:es)?|pedido|orden|gu[ií]a|referencia|marca|c[oó]digo|ticket|caso|producto|modelo|opci[oó]n)\\s*(?:n\\.?\\s*[ºo°]?\\.?|nro\\.?|n[uú]mero|#|:)?\\s*|#\\s*|\\b[A-Za-z]{2}-)(\\d[\\d]*)|' +
    '(\\d+)(\\s*(?:unidades|cajas|piezas|pcs|productos|bultos|proveedores|marcas)\\b)',
  'giu',
);

/* Un CÓDIGO DE PRODUCTO que el cliente escribió («me interesa el producto
   SGTE-58 … del catálogo de Ideas de Productos») no es un monto ni una fecha:
   se le puede repetir tal cual. En la prueba en papel fue el único reemplazo
   de la guardia y era un falso positivo: con tres productos el modelo repetía
   los tres códigos y el «58» contaba como cifra sin respaldo. Vale solo el
   código ENTERO y solo si está en lo que escribió el cliente; letras pegadas a
   una moneda o a una fecha («USD850», «dia15») no son un código. */
const RE_CODIGO_DE_PRODUCTO = /(?<![\p{L}\d])(?!(?:usd|us|rmb|cny|mxn|eur|dia|el|al|del)-?\d)[a-z]{2,10}-?\d{1,8}(?:-[a-z\d]+)*(?![\p{L}\d])/giu;
const RE_TELEFONO = /\+\d{1,3}(?:[\s.-]?\d){7,12}(?!\d)/g;
const RE_NUMERO_LARGO = /\+?\d[\d\s().-]{6,}\d/g;
const codigoNormal = (c) => sinTildes(c).replace(/[^a-z0-9]/g, '');

/* La lista de los pasos por los que pasa TODA carga («cotización registrada,
   recibido en China, en contenedor, en tránsito, en aduana, liberado y en
   bodega de destino») explica el proceso: no afirma nada de la carga de este
   cliente. Sin esto, «¿cómo funciona la importación?» se cambiaba por el paso
   a asesor (simulación del 17-oct). Se quita solo la frase o línea que nombra
   4 pasos distintos o más: «tu carga está en tránsito» sigue frenándose.
   «Bodega de China» y «en el barco» son las etapas que muestra la herramienta
   Seguimiento de mi carga: describirla se cambiaba por el paso a asesor
   (simulación del 18-oct, «¿hay tracking en la plataforma?»). */
const RE_PASO_DEL_PROCESO = /cotizacion registrada|recibido en china|bodega de china|en contenedor|en el barco|en transito|en aduana|liberad[oa]|bodega de destino/g;
/* «Tu mensaje llegó cortado», «el enlace sí me llegó»: ese «llegó» es de un
   mensaje, no de la carga (4 respuestas cambiadas en la simulación del 17-oct). */
const RE_LLEGO_NO_ES_CARGA =
  /\b(?:(?:mensaje|enlace|link|archivo|audio|nota de voz|correo|documento|foto|imagen|captura|comprobante|proforma|punto \d+|consulta|pregunta)(?: \S+){0,2} llego|(?:me|te|nos) llego)\b/g;
function sinListaDePasos(texto) {
  return String(texto)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((f) => new Set(plano(f).match(RE_PASO_DEL_PROCESO) || []).size < 4)
    .map((f) => plano(f).replace(RE_LLEGO_NO_ES_CARGA, ' '))
    .join(' ');
}

const RE_PARTE_DEL_CAMINO =
  /(?<![\p{L}\d])(?:(?:partes?|pasos?)\s+[1-6](?:\s*(?:,|y|o|a|-)\s*[1-6])*|[1-6]\s+(?:partes|pasos|herramientas)|3\s+datos)(?![\p{L}\d])/giu;

/* E3 (Daniel, 27-oct): lo que el cliente mandó en su hoja o su captura
   (precio por unidad, medidas de la caja, CBM, peso) se le puede repetir: la
   guardia cambiaba por «un asesor…» la respuesta que solo le ordenaba sus
   propios datos. Vale la medida o el precio ENTERO y solo si todas sus cifras
   eran un precio o una medida en su hoja o su captura (cifrasDeSuHoja). Un
   total calculado o un precio que no mandó se sigue frenando. */
const UNIDAD_MEDIDA = 'cm|mm|mts?|metros?|m3|m³|cbm|kgs?|kilos?|kilogramos?|gr|gramos?|g|lbs?|libras?|ml|lts?|litros?|l|pulgadas?|pies';
const RE_MEDIDA = new RegExp(
  `\\d+(?:[.,]\\d+)?(?:\\s*(?:x|×|\\*)\\s*\\d+(?:[.,]\\d+)?){0,2}\\s*(?:${UNIDAD_MEDIDA})(?!\\p{L})|` +
    '(?<!\\p{L})(?:cbm|peso|volumen|medidas?)\\s*(?:de la caja|por caja|de cada caja)?\\s*(?:es|son|de)?\\s*:?\\s*\\d+(?:[.,]\\d+)?(?:\\s*(?:x|×|\\*)\\s*\\d+(?:[.,]\\d+)?){0,2}',
  'giu',
);
const RE_PRECIO_ECO = new RegExp(
  `(?:us\\$|\\$|usd|¥|rmb|cny)\\s*\\d[\\d.,]*|\\d[\\d.,]*\\s*(?:${MONEDA}|cny|¥)(?!\\p{L})`,
  'giu',
);
const todasDelCliente = (t, delCliente) => {
  const c = cifras(t);
  return c.length > 0 && c.every((x) => delCliente.has(x));
};
/* Las cifras de SU HOJA O SU CAPTURA, y solo las que allí eran un precio o una
   medida: una imagen leída que no sea un comprobante de pago («Sí, son
   USD 850» confirmaría un depósito), o una línea escrita con forma de proforma
   (dos datos o más entre precio, medidas, CBM/peso y unidades por caja). El
   número de un código («SGTE-58») o una cifra suelta no respaldan un precio. */
const RE_POR_CAJA = /\d+\s*(?:unidades|piezas|pcs)\s*(?:por|x|cada)\s*caja/i;
function cifrasDeSuHoja(eco) {
  const hoja = String(eco || '')
    .split(/\n+/)
    .filter((l) => {
      if (/^\s*\[IMAGEN:\s*comprobante/i.test(l)) return false;
      if (/^\s*\[IMAGEN:/i.test(l)) return true;
      const tipos = [new RegExp(RE_PRECIO_ECO.source, 'iu'), new RegExp(RE_MEDIDA.source, 'iu'), RE_POR_CAJA].filter((re) => re.test(l));
      return tipos.length >= 2;
    })
    .join('\n');
  const trozos = [...(hoja.match(RE_PRECIO_ECO) || []), ...(hoja.match(RE_DINERO) || []), ...(hoja.match(RE_MEDIDA) || [])];
  return new Set(trozos.flatMap(cifras));
}

/* E3: consejos generales que llevan una cifra y no son un dato del cliente:
   «pide precio a 3 o 4 proveedores», «al menos 2 muestras» (en rango o con
   «al menos / unos / a»: «son 4 proveedores» es un dato y se frena), y el modelo de un
   producto de marca conocida («iPhone 16», «Galaxy S24 Ultra», «Windows 11»).
   Las cantidades son chicas (hasta 10) y de cosas que se le aconsejan, nunca
   de las suyas (sus cajas, unidades o productos siguen necesitando respaldo). */
const RE_CONSEJO_CANTIDAD =
  /(?<![\p{L}\d.,])(?:(?:[1-9]|10)\s*(?:o|a|y|-)\s*(?:[1-9]|10)|(?<=(?:^|[^\p{L}])(?:al menos|como m[ií]nimo|m[ií]nimo|unos|unas|entre|a)\s+)(?:[1-9]|10))\s+(?:proveedores|cotizaciones|opciones|muestras|f[aá]bricas|alternativas|ofertas|veces|fotos|videos|preguntas)(?!\p{L})/giu;
const MARCAS_MODELO =
  'iphone|ipad|ipod|macbook|airpods|apple watch|galaxy|redmi|xiaomi|huawei|oppo|realme|motorola|pixel|nokia|playstation|ps|xbox|nintendo|tecno|infinix|lenovo|windows|android|ios|usb|bluetooth|wifi|hdmi';
const RE_MODELO = new RegExp(
  `(?<![\\p{L}\\d])(?:${MARCAS_MODELO})(?:\\s+(?:pro|max|plus|ultra|mini|note|series|watch|lite|se))?\\s*[a-z]?\\d{1,3}(?:[.,]\\d)?(?:\\s*(?:pro|max|plus|ultra|mini|lite|se|fe))*(?![\\p{L}\\d])`,
  'giu',
);

/** Cifra, plazo, monto, enlace, correo o estado sin respaldo. Devuelve el motivo o null. */
function datoSinRespaldo(texto, firme, eco, estado = firme) {
  const firmePlano = plano(firme);
  const firmeMinus = firme.toLowerCase();
  const estadoPlano = plano(estado);
  for (const url of texto.match(RE_URL) || []) {
    if (!firmeMinus.includes(url.replace(/[.,;:)]+$/, '').toLowerCase())) {
      return 'traía un enlace que no está en la base';
    }
  }
  let sinEnlaces = texto.replace(RE_URL, ' ');
  for (const correo of sinEnlaces.match(RE_CORREO) || []) {
    if (!firmeMinus.includes(correo.toLowerCase())) return 'repetía un correo que no está en la base';
  }
  sinEnlaces = sinEnlaces.replace(RE_CORREO, ' ');
  for (const dominio of sinEnlaces.match(RE_DOMINIO) || []) {
    if (!firmeMinus.includes(dominio.replace(/[.,;:)]+$/, '').toLowerCase())) {
      return `traía la dirección «${dominio}», que no está en la base`;
    }
  }
  sinEnlaces = sinEnlaces.replace(RE_DOMINIO, ' ');
  /* Un teléfono con prefijo que está en el dato leído o que escribió el cliente
     se puede repetir aunque vaya con otros espacios: «+593 98 097 …» se partía
     en cifras sueltas («593») y la respuesta del diagnóstico de IMPORCHAT se
     cambiaba por el paso a asesor (automejora 26-oct). Se comparan los últimos
     9 dígitos; un teléfono que no está en ningún lado sigue frenado. */
  const telefonosConocidos = (`${firme} ${eco}`.match(RE_NUMERO_LARGO) || []).map((t) => t.replace(/\D/g, ''));
  sinEnlaces = sinEnlaces.replace(RE_TELEFONO, (tel) => {
    const cola = tel.replace(/\D/g, '').slice(-9);
    return telefonosConocidos.some((t) => t.length >= 9 && t.endsWith(cola)) ? ' ' : tel;
  });

  /* Una FECHA («24 de octubre») vale si está tal cual en el respaldo. Una
     duración, un «hoy» o un día suelto («el 30») necesitan además a su
     vecina: «30 minutos antes» sale del texto de las clases, pero «en 30
     minutos te paso la cotización» no, y las dos traen «30 minutos». */
  const firmeLimpio = ` ${limpio(firme)} `;
  for (const m of sinEnlaces.matchAll(RE_PLAZO)) {
    const plazo = limpio(m[0]);
    let respaldado;
    if (/^\d{1,2} de |^\d{1,2}[/-]\d/.test(plazo)) {
      respaldado = firmeLimpio.includes(` ${plazo} `);
    } else {
      const antes = limpio(sinEnlaces.slice(0, m.index)).split(' ').pop() || '';
      const despues = limpio(sinEnlaces.slice(m.index + m[0].length)).split(' ')[0] || '';
      respaldado =
        (antes && firmeLimpio.includes(` ${antes} ${plazo} `)) ||
        (despues && firmeLimpio.includes(` ${plazo} ${despues} `)) ||
        (!antes && !despues && firmeLimpio.includes(` ${plazo} `));
    }
    if (!respaldado) return `traía el plazo «${m[0]}», que no sale de un dato leído`;
  }
  const deSuHoja = cifrasDeSuHoja(eco);
  for (const monto of sinEnlaces.match(RE_DINERO) || []) {
    if (firmePlano.includes(plano(monto))) continue;
    // E3: un precio de su hoja o su captura («USD 3,50» de su proforma).
    if (!/%|por ciento/i.test(monto) && todasDelCliente(monto, deSuHoja)) continue;
    return `traía el monto «${monto.trim()}», que no sale de un dato leído`;
  }
  for (const frase of plano(sinListaDePasos(sinEnlaces)).match(RE_ESTADO_CARGA) || []) {
    if (!estadoPlano.includes(frase)) return `afirmaba «${frase}» sobre una carga sin un dato leído que lo diga`;
  }

  // Cifras: las del respaldo, más las del cliente SOLO como código o cantidad.
  const delRespaldo = new Set(cifras(firme));
  const delCliente = new Set(cifras(eco));
  const codigosDeProducto = new Set((sinTildes(eco).match(RE_CODIGO_DE_PRODUCTO) || []).map(codigoNormal));
  const sinProductos = sinEnlaces.replace(RE_CODIGO_DE_PRODUCTO, (c) => (codigosDeProducto.has(codigoNormal(c)) ? ' ' : c));
  const sinCodigos = sinProductos.replace(RE_CODIGO_DEL_CLIENTE, (todo, pre, cod, cant, unidad) => {
    const n = cod ?? cant;
    if (!delCliente.has(numero(n))) return todo;
    return cod !== undefined ? `${pre} ` : ` ${unidad}`;
  });
  // «1. …», «2) …» al inicio de una línea son el orden de los pasos, no un dato.
  // Tampoco las partes del camino del prompt («estás en la parte 2», «las
  // partes 1 y 2», «los 3 datos», «6 herramientas»): en la simulación del
  // 18-oct cambiaban por el paso a asesor la respuesta a «aún no tengo proveedor».
  const sinOrden = sinCodigos
    .replace(/^[ \t]*\d{1,2}[.)][ \t]+/gm, '')
    .replace(RE_PARTE_DEL_CAMINO, ' ')
    // E3: sus medidas y precios, y los consejos generales.
    .replace(RE_MEDIDA, (m) => (todasDelCliente(m, deSuHoja) ? ' ' : m))
    .replace(RE_PRECIO_ECO, (m) => (todasDelCliente(m, deSuHoja) ? ' ' : m))
    .replace(RE_CONSEJO_CANTIDAD, ' ')
    .replace(RE_MODELO, ' ');
  for (const c of cifras(sinOrden)) {
    if (!delRespaldo.has(c)) return `traía la cifra «${c}», que no sale de un dato leído`;
  }
  return null;
}

/* ── Ofrecer lo que el bot no puede hacer ──────────────────────────────── */
/* El bot no cotiza, no revisa pagos, no cambia claves, no llama, no agenda, no
   busca proveedores ni pide fotos: lo único que puede ofrecer es dejarlo
   anotado. Se buscan solo formas en PRIMERA persona o un ofrecimiento directo;
   «para que el área de precios te cotice» o «un asesor lo revisa» hablan de
   otros y pasan. Va sobre el texto con tildes: «revisé» (yo, pasado) no es
   «revise» (que un asesor lo revise). */
const HACER =
  'cotizar|llamar|agendar|programar|buscar|conseguir|revisar|verificar|validar|comprobar|confirmar|cambiar|restablecer|resetear|reiniciar|' +
  'generar|calcular|averiguar|reembolsar|devolver|gestionar|tramitar|solucionar|resolver|arreglar|activar|habilitar|desbloquear|rastrear|consultar|pedir|solicitar';
const RE_OFRECE = new RegExp(
  '(?<!\\p{L})(?:' +
    // «te cotizo», «te llamamos», «les agendo», «te lo reviso»
    '(?:te|le|les)\\s+(?:lo\\s+|la\\s+|los\\s+|las\\s+)?(?:cotizo|cotizamos|cotizaré|llamo|llamamos|llamaré|llamaremos|marco|agendo|agendamos|busco|buscamos|consigo|conseguimos|' +
    'reviso|verifico|valido|cambio|restablezco|reseteo|reinicio|genero|calculo|averiguo|reembolso|reembolsamos|devuelvo|devolvemos|gestiono|tramito|soluciono|resuelvo|arreglo|activo|habilito|desbloqueo|rastreo)|' +
    // «lo reviso», «la cotizo», «lo consulto con logística»
    '(?:lo|la|los|las)\\s+(?:reviso|verifico|valido|cotizo|consulto|gestiono|soluciono|resuelvo|averiguo)|' +
    // «puedo cotizarte», «voy a revisar», «déjame verificar» (no «no puedo…» ni «no te los puedo confirmar»)
    `(?<!(?:no|tampoco)(?:\\s+(?:te|le|les|lo|la|los|las|se))*\\s+)(?:puedo|podemos|voy a|vamos a|d[eé]jame|perm[ií]teme)\\s+(?:(?:te|le|lo|la|les)\\s+)?(?:${HACER})(?:te|le|les|lo|la|los|las|telo|tela|selo|sela)?|` +
    // «¿quieres que te pidamos más fotos?», «si quieres te cotizo»
    '(?:quieres|deseas|necesitas|prefieres|te gustar[ií]a) que\\s+(?:(?:te|le|lo|la|les|se)\\s+)*(?:cotic|llam|agend|program|busqu|consig|revis|verifi|valid|comprob|confirm|cambi|restablez|resete|gener|calcul|averig|reembols|devolv|devuelv|gestion|tramit|solucion|resolv|resuelv|arregl|activ|habilit|desbloque|rastre|pid|solicit|envi|mand)\\p{L}*|' +
    // «ya verifiqué tu pago», «revisé tu captura»
    '(?:revisé|verifiqué|validé|comprobé|confirmé|coticé|agendé|gestioné|solucioné|consulté|rastreé)' +
    ')(?!\\p{L})',
  'iu',
);

/** El ofrecimiento que no sale de un dato leído, o null. */
function ofreceLoQueNoPuede(texto, firme) {
  const m = texto.match(RE_OFRECE);
  if (!m) return null;
  // Si una ficha o un texto fijo lo dice con esas palabras, está respaldado.
  if (plano(firme).includes(plano(m[0]))) return null;
  return m[0].trim();
}

/* ── Un reclamo no va a cobranza ───────────────────────────────────────── */
const RE_A_COBRANZA = /(?<!\p{L})(?:cobranza|comprobante|contabilidad|n[uú]mero de cotizaci[oó]n)(?!\p{L})/iu;

/* ── El aviso de «un asesor te escribe», una sola vez ──────────────────── */
/** «Recibí tu mensaje. Un asesor lo revisa y te escribe apenas abramos. Apenas
    tengamos la fecha… apenas abramos.» → sin lo primero. Solo se quita el paso
    a asesor EXACTO, y solo si queda otro aviso. También cuando la respuesta
    es SOLO el texto de «¿persona o robot?» (MENSAJE_ROBOT, Daniel 26-oct) más
    ese paso a asesor: ya ofrece a una persona. Si trae algo más («tu pago lo
    revisa cobranza»), el paso a asesor se queda. */
function quitarAvisoRepetido(texto) {
  const conRobot = texto.includes(MENSAJE_ROBOT);
  if (((texto.match(/apenas abramos/gi) || []).length < 2 && !conRobot) || !texto.includes(MENSAJE_ASESOR)) return { texto, cambios: 0 };
  const sin = texto.replace(MENSAJE_ASESOR, ' ').replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  if (!/apenas abramos/i.test(sin) && sin !== MENSAJE_ROBOT) return { texto, cambios: 0 };
  return { texto: sin, cambios: 1 };
}

/* ── «Recibí» una sola vez ──────────────────────────────────────────────── */
/** «Recibí tu proforma. Recibí tu mensaje. Tu asesor la revisa…» → «Recibí tu
    proforma. Tu asesor la revisa…». El modelo nombra lo que llegó y después pega
    el paso a asesor entero: el cliente lee «Recibí» dos veces seguidas (anoche,
    23-oct, en 5 de 55 respuestas). Solo se quita el «Recibí tu mensaje.» que va
    DESPUÉS de otro «Recibí…» que nombra algo; lo que sigue queda igual. Una
    respuesta que repite «Recibí tu mensaje» diez veces no se arregla aquí: es
    basura y la frena el largo máximo. */
// Un «Recibí» que nombra lo que llegó: «Recibí tu proforma», no otro «Recibí tu mensaje».
const RE_RECIBI = /(?<!\p{L})recib(?:í|i|imos)(?!\p{L})(?! tu mensaje)/iu;
const RE_RECIBI_TU_MENSAJE = /(?<!\p{L})Recib(?:í|i)(?:mos)? tu mensaje\.[ \t]*(\p{L})?/gu;
function quitarRecibiRepetido(texto) {
  let cambios = 0;
  const out = texto.replace(RE_RECIBI_TU_MENSAJE, (m, letra, inicio, todo) => {
    if (!RE_RECIBI.test(todo.slice(0, inicio))) return m;
    cambios += 1;
    return letra ? letra.toUpperCase() : '';
  });
  return { texto: cambios ? out.replace(/[ \t]{2,}/g, ' ').trim() : texto, cambios };
}

/* ── Una ficha con `pasar_a` no cierra sola ────────────────────────────── */
const RE_PASA_A_ASESOR = /apenas abramos/i;
const PALABRAS_DE_MUESTRA = 6;

/** ¿La respuesta trae un tramo de esa ficha (6 palabras seguidas, o la parte
    entera si es más corta)? Así se sabe que el modelo contestó CON la ficha. */
function usaFicha(respuestaLimpia, partes) {
  for (const parte of partes || []) {
    const w = limpio(parte).split(' ').filter(Boolean);
    if (w.length < 4) continue;
    const n = Math.min(PALABRAS_DE_MUESTRA, w.length);
    for (let i = 0; i + n <= w.length; i++) {
      if (respuestaLimpia.includes(` ${w.slice(i, i + n).join(' ')} `)) return true;
    }
  }
  return false;
}

/* La ficha pide la cantidad (`pedir` nombra «cuántas unidades piensas comprar»)
   y la respuesta todavía no la pregunta. «Cuántas unidades vienen en cada caja»
   es otro dato (el del proveedor): no cuenta. */
const RE_PIDE_CANTIDAD =
  /cu[aá]ntas (?:unidades|piezas) (?:piensas|quieres|quisieras|vas a|deseas|planeas|necesitas|te interesa)|qu[eé] cantidad (?:piensas|quieres|quisieras|vas a|deseas|necesitas|te interesa)|cantidad (?:que|de unidades que) (?:piensas|quieres|vas a|deseas|necesitas)/i;
const pideCantidad = (ficha) => /cuantas unidades piensas/.test(limpio(ficha.pedir || ''));

/** Si contestó con una ficha que pasa a una persona y no avisó del paso a
    asesor, lo agrega. Si esa ficha además pide la cantidad y ni el cliente la
    dijo ni la respuesta la pregunta, la pide (riesgo anotado por Daniel el
    16-10: la ficha «cotizar-datos» sola se quedaba sin pedir las unidades).
    Devuelve { texto, cambios, ficha, cantidad }. */
function completarPase(texto, fichasConPase, { dioCantidad = false } = {}) {
  if (!fichasConPase?.length || RE_PASA_A_ASESOR.test(texto)) return { texto, cambios: 0 };
  const respuestaLimpia = ` ${limpio(texto)} `;
  const usada = fichasConPase.find((f) => usaFicha(respuestaLimpia, f.partes));
  if (!usada) return { texto, cambios: 0 };
  const cantidad = pideCantidad(usada) && !dioCantidad && !RE_PIDE_CANTIDAD.test(texto);
  const cierre = cantidad ? `${CIERRE_ASESOR}\n${PREGUNTA_CANTIDAD}` : CIERRE_ASESOR;
  return { texto: `${texto.trimEnd()}\n${cierre}`, cambios: 1, ficha: usada.id, cantidad };
}

/**
 * @param {string} respuesta  lo que escribió el modelo (ya pasado por el sanitizador del motor)
 * @param {object} hechos     lo que arma `turno.js`:
 *   - respaldo.firme   textos fijos + fichas + carga del cliente (lo que SÍ se puede afirmar)
 *   - respaldo.eco     lo que escribió el cliente en este turno (solo respalda sus códigos)
 *   - respaldo.estado  contra qué se comparan las frases de estado de una carga. Cuando
 *                      en el turno se consultó la carga, es SOLO su bloque: una ficha que
 *                      explica los pasos no autoriza a decir «la tuya está en aduana».
 *   - textoSeguro      con qué se reemplaza una respuesta que no pasa
 *   - fichasConPase    [{ id, partes, pedir }] fichas con `pasar_a` vistas en la conversación:
 *                      si la respuesta usa una, tiene que llevar el paso a asesor
 *   - dioCantidad      el cliente ya dijo cuántas unidades quiere (en este turno o antes):
 *                      al completar una ficha de cotización no se le vuelve a pedir
 *   - reclamo          el cliente reclama: no va a cobranza ni se le pide comprobante
 *   - reclamoPorDemora reclama por la demora de su carga: no se le repite el estado
 *   - saludoSinContestar  es el primer saludo de la conversación: no se calla
 * @returns {{texto:string, cambiada:boolean, corregida:boolean, motivos:string[]}}
 */
/* «…dejo anotado el pago y tu pedido de factura para cobranza» a quien solo
   mandó el comprobante (sábado 24-oct): no se le atribuye un pedido que no
   hizo. Vale solo si en lo que escribió no aparece «factura». */
const RE_PEDIDO_INVENTADO = /\b(?:tu|su) (?:pedido|solicitud) de factura\b|\bla factura que (?:pides|pediste|solicitas|solicitaste)\b/;

function revisarRespuesta(respuesta, hechos = {}) {
  const h = hechos || {};
  const original = String(respuesta ?? '');
  const tags = original.match(RE_TAG) || [];
  let visible = original.replace(RE_TAG, '').trim();
  const motivos = [];

  // Silencio a propósito ([espera]:true y nada más): no hay nada que revisar…
  if (!visible) {
    // …salvo ante el primer saludo: nadie le contestó todavía.
    if (h.saludoSinContestar) {
      return { texto: MENSAJE_SALUDO, cambiada: true, corregida: false, motivos: ['callaba ante un saludo que nadie había contestado'] };
    }
    return { texto: original, cambiada: false, corregida: false, motivos };
  }

  const firme = String(h.respaldo?.firme || '');
  const eco = String(h.respaldo?.eco || '');
  const seguro = h.textoSeguro || MENSAJE_ASESOR;

  // 1. Lo que se puede corregir con certeza.
  const pasos = [
    [aplanarEnlaces, 'enlace en markdown aplanado'],
    [quitarDespedida, 'despedida quitada'],
    [corregirVoseo, 'voseo corregido'],
    [cambiarCargos, 'cargo interno cambiado'],
    [quitarAvisoRepetido, 'aviso de «un asesor te escribe» repetido: se quitó el sobrante'],
    [quitarRecibiRepetido, '«Recibí» repetido: se dejó uno'],
  ];
  for (const [fn, motivo] of pasos) {
    const r = fn(visible);
    if (r.cambios) motivos.push(motivo);
    visible = r.texto;
  }
  const corregida = motivos.length > 0;

  // 2. Lo que no se manda.
  let falla = null;
  if (RE_MARCADOR.test(visible)) falla = 'traía un marcador sin llenar';
  else if (visible.length > MAX_RESPUESTA) falla = 'respuesta demasiado larga';
  else if (RE_CARGO_RESTANTE.test(visible)) falla = 'nombraba un cargo interno';
  else if (RE_PERSONA.test(visible) || RE_PERSONA_NOMBRE.test(visible)) falla = 'se presentaba como una persona';
  else falla = datoSinRespaldo(visible, firme, eco, h.respaldo?.estado ?? firme);

  if (!falla) {
    const ofrece = ofreceLoQueNoPuede(visible, firme);
    if (ofrece) falla = `ofrecía hacer algo que el bot no puede («${ofrece}»)`;
    else if ((h.reclamo || h.reclamoPorDemora) && RE_A_COBRANZA.test(visible)) falla = 'mandaba un reclamo a cobranza o le pedía un comprobante';
    else if (h.reclamoPorDemora && RE_ESTADO_CARGA.test(plano(visible))) falla = 'le repetía el estado de la carga a quien reclama por la demora';
    else if (RE_PEDIDO_INVENTADO.test(plano(visible)) && !/\bfactur/.test(plano(eco).toLowerCase())) falla = 'le atribuía un pedido de factura que el cliente no hizo';
  }

  if (falla) {
    motivos.push(falla);
    return { texto: seguro, cambiada: true, corregida: false, motivos };
  }

  // 3. Lo que se completa: una ficha que pasa a una persona no cierra sola.
  const pase = completarPase(visible, h.fichasConPase, { dioCantidad: Boolean(h.dioCantidad) });
  if (pase.cambios) {
    motivos.push(
      `usaba la ficha «${pase.ficha}», que pasa a una persona, sin el paso a asesor: agregado` +
        (pase.cantidad ? ' (y se le pide cuántas unidades, que no había dicho)' : ''),
    );
    visible = pase.texto;
  }

  if (corregida || pase.cambios) {
    if (visible[0] !== visible[0].toUpperCase()) visible = visible[0].toUpperCase() + visible.slice(1);
    return { texto: [visible, ...tags].join('\n'), cambiada: true, corregida: true, motivos };
  }
  return { texto: original, cambiada: false, corregida: false, motivos };
}

module.exports = {
  revisarRespuesta,
  corregirVoseo,
  cambiarCargos,
  quitarDespedida,
  aplanarEnlaces,
  datoSinRespaldo,
  completarPase,
  ofreceLoQueNoPuede,
  quitarAvisoRepetido,
  quitarRecibiRepetido,
  RE_PLAZO,
  MAX_RESPUESTA,
};
