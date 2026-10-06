/* Arnés del bot de soporte IMPORSHOP PROVEEDOR (prompt_soporte_imporshop).

   Corre los escenarios del brief de Evelyn + casos reales de la cfg 261 por el
   MISMO camino que producción (contexto de columna, Responses API, sanitizador,
   extracción de media, limpieza de tags/coletillas/markdown), con el prompt
   armado desde el módulo y sin tocar ninguna columna. Gasta la api key de la
   cfg 10 (pruebas), no la del cliente.

   Uso: node scripts/arnes_soporte_imporshop.js [escenario] [modelo]  */
require('dotenv').config();
const { db } = require('../src/database/config');
const {
  ejecutarConResponsesAPI,
  limpiarTagsAcciones,
} = require('../src/services/kanban_ia.service');
const { construirContextoColumna } = require('../src/utils/contextoColumna');
const { sanitizarRespuestaAgente } = require('../src/utils/openia/sanitizador_agente');
const { extraerUrlsMedia } = require('../src/utils/urlsMedia');
const { limpiarColetillas } = require('../src/utils/limpiarColetillas');
const { limpiarMarkdown } = require('../src/utils/formatoWhatsapp');
const { leerApiKeyOpenAI } = require('../src/utils/openia/apiKeyOpenAI');
const {
  promptSoporteImporshop,
  promptSoporteImporshopEspera,
  MENSAJE_RECIBIDO,
} = require('../src/utils/prompt_soporte_imporshop.data');
const { separarMediaFija } = require('../src/utils/mediaFijaPrompt');

const SOLO = process.argv[2] && process.argv[2] !== 'todos' ? process.argv[2] : null;
const MODELO = process.argv[3] || 'gpt-4o';

// URLs ficticias: aquí solo importa que el bot ponga la etiqueta correcta.
const MEDIA = {
  video_material: 'https://media.test/imporshop_material.mp4',
  video_estado_guia: 'https://media.test/imporshop_estado_guia.mp4',
  video_retener: 'https://media.test/imporshop_retener_guia.mp4',
  video_novedades: 'https://media.test/imporshop_novedades.mp4',
  video_garantia: 'https://media.test/imporshop_garantia.mp4',
  imagen_horarios: 'https://media.test/horarios_corte_imporshop.png',
};
const V = {
  material: /imporshop_material\.mp4/,
  guia: /imporshop_estado_guia\.mp4/,
  retener: /imporshop_retener_guia\.mp4/,
  novedades: /imporshop_novedades\.mp4/,
  garantia: /imporshop_garantia\.mp4/,
  horarios: /horarios_corte_imporshop\.png/,
};
const SALUDO = /¡?hola!?\s*¿?c[oó]mo est[aá]s/i;
const ASESOR = '[asesor]:true';
const RESUELTO = '[resuelto]:true';
const AUDIO_ILEGIBLE = '[El cliente envió un audio que no se pudo transcribir]';
const ESPERA = '[espera]:true';
// Lo que kanban_ia inyecta cuando el último mensaje al cliente fue de una persona.
const ctxAsesor = (texto) =>
  '🧑‍💼 LO ÚLTIMO QUE SE LE ESCRIBIÓ AL CLIENTE lo envió una persona de tu equipo (no fuiste tú y NO está en tu memoria):\n' +
  `"${texto}"\n` +
  'El cliente está respondiendo a ESO: interpreta su mensaje en ese contexto (si dice "¿cómo?", "¿hay un video?", "¿y eso dónde?", "ok", habla de lo que le indicó tu compañero) y no contradigas lo que ya se le dijo.';
const INVENTA = /caja protegida|empacad[oa] en|incluye (sus|los) accesorios|accesorios b[aá]sicos|viene con/i;

/* Cada turno queda como { crudo, texto, medias, tags }. `texto` es lo que lee
   el cliente; `medias` lo que sale como adjunto. */
const ESCENARIOS = [
  {
    nombre: 'saludo_y_luego_fotos',
    mensajes: ['hola', 'necesito fotos del ID 186860'],
    checks: ([t1, t2]) => [
      !SALUDO.test(t1.texto) && 'turno 1 sin saludo',
      t1.medias.length && 'turno 1 mandó media a un saludo',
      SALUDO.test(t2.texto) && 'turno 2 volvió a saludar',
      !V.material.test(t2.medias.join()) && 'turno 2 sin video MATERIAL',
      !/catalogo-imporshop-comunidad/.test(t2.texto) && 'turno 2 sin link del catálogo',
    ],
  },
  {
    nombre: 'corte_sabado',
    mensajes: ['a qué hora es el corte el sábado'],
    checks: ([t]) => [
      !V.horarios.test(t.medias.join()) && 'sin imagen de horarios',
      !/8:00/.test(t.texto) && 'no dio el corte de sábado (8:00)',
      t.tags.length && `puso tag ${t.tags}`,
    ],
  },
  {
    nombre: 'guia_no_sale',
    mensajes: ['guía 189852073 no sale desde el 25', 'sigue pendiente'],
    checks: ([t1, t2]) => [
      !V.guia.test(t1.medias.join()) && 'sin video ESTADO DE GUÍA',
      !/track\?guia=189852073/.test(t1.texto) && 'link de rastreo sin el número de guía',
      t1.tags.length && `turno 1 puso tag ${t1.tags}`,
      !t2.tags.includes(ASESOR) && 'turno 2 no pasó a asesor',
      /n[uú]mero de gu[ií]a\s*\?|p[aá]same|env[ií]a(me|nos) (el|los) n[uú]mero/i.test(t2.texto) &&
        'volvió a pedir la guía que ya dio',
    ],
  },
  {
    nombre: 'varias_guias',
    mensajes: ['buenas, estas guías no tienen movimiento V4003166071 y V4003166072'],
    checks: ([t]) => [
      !/track\?guia=V4003166071/.test(t.texto) && 'falta link de la 1ª guía',
      !/track\?guia=V4003166072/.test(t.texto) && 'falta link de la 2ª guía',
    ],
  },
  {
    nombre: 'retener',
    mensajes: ['quiero retener una guía', 'no entiendo'],
    checks: ([t1, t2]) => [
      !V.retener.test(t1.medias.join()) && 'sin video RETENER',
      !/imporchina\.com\/r\/retener/.test(t1.texto) && 'sin link de retener',
      !/48 horas/.test(t1.texto) && 'sin aviso de 48 horas',
      !t2.tags.includes(ASESOR) && '"no entiendo" no pasó a asesor',
    ],
  },
  {
    nombre: 'incompleto',
    mensajes: ['llegó incompleto el pedido de mi cliente'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'garantía no pasó a asesor en el mismo mensaje',
      !/n[uú]mero de gu[ií]a/i.test(t.texto) && 'no pidió número de guía',
      /\bs[ií] aplica|no aplica/i.test(t.texto) && 'opinó si la garantía aplica',
    ],
  },
  {
    nombre: 'stock_sin_id',
    mensajes: ['tienen stock de camisa compresión', 'es el 145233'],
    checks: ([t1, t2]) => [
      t1.tags.length && `turno 1 puso tag ${t1.tags} (debía pedir ID)`,
      !/\bID\b/i.test(t1.texto) && 'no pidió el ID',
      /\d+\s*(unidades|disponibles)/i.test(t1.texto + t2.texto) && 'dio números de stock',
      !t2.tags.includes(ASESOR) && 'con el ID no pasó a asesor',
    ],
  },
  {
    nombre: 'stock_con_id',
    mensajes: ['hola, hay stock del 62043 freidora con canasta?'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'trajo el ID y no pasó directo a asesor',
      /ayúdame por favor con:\s*\n?\s*1\. El ID/i.test(t.texto) && 'volvió a pedir el ID',
    ],
  },
  {
    nombre: 'audio_ilegible',
    mensajes: [AUDIO_ILEGIBLE],
    checks: ([t]) => [!t.tags.includes(ASESOR) && 'audio ilegible no pasó a asesor'],
  },
  {
    nombre: 'gracias_cierra',
    mensajes: ['me pasas el material del ID 186860', 'gracias'],
    checks: ([t1, t2]) => [
      !V.material.test(t1.medias.join()) && 'sin video MATERIAL',
      !t2.tags.includes(RESUELTO) && '"gracias" no marcó resuelto',
    ],
  },
  {
    nombre: 'novedad',
    mensajes: ['mi pedido está en novedad, el cliente no contesta'],
    checks: ([t]) => [
      !V.novedades.test(t.medias.join()) && 'sin video NOVEDADES',
      t.tags.includes(ASESOR) && 'novedad pasó a asesor de entrada',
    ],
  },
  {
    nombre: 'alumno_imporfactory',
    mensajes: ['soy alumno de imporfactory y no puedo vincular mi whatsapp a imporchat'],
    checks: ([t]) => [
      !/wa\.link\/821bny/.test(t.texto) && 'sin el link de alumnos',
      t.tags.includes(ASESOR) && 'alumno pasó a asesor (debía redirigir)',
    ],
  },
  {
    nombre: 'descuento_mayor',
    mensajes: ['si te llevo 50 del 62043 me los dejas en $4,50?'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'mayorista no pasó a asesor',
      /\$\s?\d/.test(t.texto) && 'mencionó un precio',
    ],
  },
  {
    nombre: 'molesto',
    mensajes: ['Su equipo de soporte no esta haciendo bien las cosas, ayer solo me escribieron 1 mensaje y nadie me responde'],
    checks: ([t]) => [!t.tags.includes(ASESOR) && 'cliente molesto no pasó a asesor'],
  },
  {
    nombre: 'pagos',
    mensajes: ['Banco Pichincha cuenta de ahorros a nombre de Luis Llerena #2204516087, para que me devuelvan lo del wallet'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'pagos no pasó a asesor',
      /comprobante/i.test(t.texto) && 'pidió comprobante',
    ],
  },
  {
    nombre: 'nuevo_mexico',
    mensajes: ['hola soy de méxico, quiero empezar a vender sus productos, cómo hago?'],
    checks: ([t]) => [
      !/dropi\.mx\/imporfactory/.test(t.texto) && 'sin link de Dropi México',
      /dropi\.ec/.test(t.texto) && 'mandó el link de Ecuador a un mexicano',
      /si tienes alguna duda, un asesor te acompa/i.test(t.texto) === false &&
        'se perdió "Si tienes alguna duda, un asesor te acompaña"',
    ],
  },
  {
    nombre: 'dos_temas',
    mensajes: ['buenas tardes, necesito videos de la secadora de ropa y saber a qué hora es el corte de servientrega'],
    checks: ([t]) => [
      !V.material.test(t.medias.join()) && 'sin video MATERIAL',
      !V.horarios.test(t.medias.join()) && 'sin imagen de horarios',
    ],
  },
  /* ── Manual de corrección de Evelyn (2026-10-05) ── */
  {
    nombre: 'm1_accesorios_no_inventa',
    mensajes: ['¿Qué accesorios trae el proyector?'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'pregunta fuera del prompt no pasó a asesor',
      t.medias.length && 'mandó media junto al paso a asesor',
      INVENTA.test(t.texto) && 'inventó información del producto',
    ],
  },
  {
    nombre: 'm2_guia_sin_numero',
    mensajes: ['Mi guía no se mueve'],
    checks: ([t]) => [
      !V.guia.test(t.medias.join()) && 'sin video ESTADO DE GUÍA',
      !/imporchina\.com\/r\/track/.test(t.texto) && 'sin link de rastreo',
      /track\?guia=/.test(t.texto) && 'armó un link con guía que el cliente no dio',
      t.tags.length && `puso tag ${t.tags}`,
    ],
  },
  {
    nombre: 'm2b_informacion_de_guia',
    mensajes: ['buenas, necesito información de mi guía, no despachan'],
    checks: ([t]) => [
      !V.guia.test(t.medias.join()) && 'sin video ESTADO DE GUÍA',
      !/imporchina\.com\/r\/track/.test(t.texto) && 'sin link de rastreo',
    ],
  },
  {
    nombre: 'm3_guia_con_numero',
    mensajes: ['Guía 189881459 no se mueve'],
    checks: ([t]) => [
      !V.guia.test(t.medias.join()) && 'sin video ESTADO DE GUÍA',
      !/imporchina\.com\/r\/track/.test(t.texto) && 'sin link de rastreo',
    ],
  },
  {
    nombre: 'm4_cancelar_guia',
    mensajes: ['Necesito cancelar la guía D002086260'],
    checks: ([t]) => [
      !V.retener.test(t.medias.join()) && 'sin video RETENER',
      !/imporchina\.com\/r\/retener/.test(t.texto) && 'sin link de retener',
      /lamento mucho el inconveniente|como lleg[oó]/i.test(t.texto) && 'respondió con la plantilla de garantía',
      /maps\.app\.goo/.test(t.texto) && 'respondió con la ubicación',
    ],
  },
  {
    nombre: 'm4b_guia_y_luego_cancelar',
    // Caso real cfg 261: venía de una garantía y mandó la guía suelta.
    mensajes: ['D002086260\nME AYUDA CANCELANDO ESA GUIA'],
    checks: ([t]) => [
      !V.retener.test(t.medias.join()) && 'sin video RETENER',
      /lamento mucho el inconveniente/i.test(t.texto) && 'respondió con la plantilla de garantía',
    ],
  },
  {
    nombre: 'm5_fotos_y_accesorios',
    mensajes: ['Fotos reales y qué accesorios trae del ID 186860'],
    checks: ([t]) => [
      !V.material.test(t.medias.join()) && 'sin video MATERIAL',
      !/catalogo-imporshop-comunidad/.test(t.texto) && 'sin link del catálogo',
      INVENTA.test(t.texto) && 'inventó información del producto',
    ],
  },
  {
    nombre: 'm6_stock_y_luego_fotos',
    mensajes: ['tienen stock de la licuadora pro winner?', '¿me pasas fotos?'],
    checks: ([t1, t2]) => [
      !/\bID\b/i.test(t1.texto) && 'no pidió el ID',
      !V.material.test(t2.medias.join()) && 'pidió fotos y no recibió MATERIAL',
      !/catalogo-imporshop-comunidad/.test(t2.texto) && 'sin link del catálogo',
    ],
  },
  {
    nombre: 'm8_tres_mensajes_juntos',
    // Como llega tras la espera de 20 s: los tres pedazos en un solo turno.
    mensajes: ['hola\nnecesito\nmaterial'],
    checks: ([t]) => [
      !SALUDO.test(t.texto) && 'sin saludo',
      !V.material.test(t.medias.join()) && 'sin video MATERIAL',
    ],
  },
  {
    nombre: 'm10_como_subo_garantia',
    mensajes: ['¿Cómo subo una garantía?'],
    checks: ([t]) => [
      !V.garantia.test(t.medias.join()) && 'sin video de GARANTÍA',
      V.novedades.test(t.medias.join()) && 'mandó el video de NOVEDADES',
      /las novedades se gestionan/i.test(t.texto) && 'respondió con el texto de novedades',
    ],
  },
  {
    nombre: 'video_garantia_tras_asesor',
    // Caso real cfg 261: la asesora dijo "sube la garantía a Dropi".
    contextos: [ctxAsesor('hola buenas tardes, debes subir la garantia a dropi')],
    mensajes: ['Hay algún video q me enseñe como?'],
    checks: ([t]) => [
      !V.garantia.test(t.medias.join()) && 'sin video de GARANTÍA',
      V.novedades.test(t.medias.join()) && 'mandó el video de NOVEDADES',
    ],
  },
  {
    nombre: 'no_repite_plantilla',
    // Caso real cfg 261: tres rastreos seguidos.
    mensajes: ['buenas, la guía D002055195 no tiene movimiento', 'D002058148', 'D002055229'],
    checks: ([t1, t2, t3]) => [
      !V.guia.test(t1.medias.join()) && 'turno 1 sin video ESTADO DE GUÍA',
      (t2.medias.length || t3.medias.length) && 'repitió el video',
      !t2.tags.includes(ASESOR) && 'la segunda guía no pasó a asesor',
      /para agilizar el proceso/i.test(t2.texto + t3.texto) && 'repitió la plantilla de rastreo',
    ],
  },
  {
    nombre: 'video_solo_con_plantilla',
    // Caso real cfg 261: "No sirve" → video del catálogo + mensaje de asesor.
    mensajes: ['necesito imágenes reales de la malla térmica, parte delantera y posterior', 'No sirve'],
    checks: ([t1, t2]) => [
      !V.material.test(t1.medias.join()) && 'turno 1 sin video MATERIAL',
      !t2.tags.includes(ASESOR) && '"No sirve" no pasó a asesor',
      t2.medias.length && 'mandó el video junto al mensaje de asesor',
    ],
  },
  {
    nombre: 'no_defiende_al_asesor',
    // Caso real cfg 261: inventó por qué no se podía retener.
    contextos: [ctxAsesor('te comento que la guía ya se encuentra empacada y lista para despacho desde el viernes, por lo que ya no nos es posible retenerla en este momento.')],
    mensajes: ['Pero cómo'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'no pasó a asesor',
      /sistema de la bodega|no permite|en proceso de env[ií]o/i.test(t.texto) && 'explicó/defendió lo que dijo el asesor',
    ],
  },
  {
    nombre: 'privatizar_con_id',
    // Caso real cfg 261: dio el ID 140088 y se lo pidieron.
    mensajes: ['buenos días su ayuda por favor privatizando más unidades del Ahorrador De Energia Electrica ID 140088'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'privatizar no pasó a asesor',
      /cu[eé]ntanos el ID/i.test(t.texto) && 'pidió el ID que el cliente ya dio',
    ],
  },
  {
    nombre: 'cuantas_unidades',
    mensajes: ['me gustaria saber mas sobre este producto 167378', 'quiero saber cuantas unidades vienen, vi anuncios de paquetes de 6'],
    checks: ([t1, t2]) => [
      !V.material.test(t1.medias.join()) && 'turno 1 sin video MATERIAL',
      !t2.tags.includes(ASESOR) && 'pregunta puntual del producto no pasó a asesor',
      /\b(1|una|6|seis) unidad/i.test(t2.texto) && 'respondió cuántas unidades vienen',
    ],
  },

  /* ── Modo espera (columna Asesor) ── */
  {
    nombre: 'espera_dato_plantilla_silencio',
    espera: true,
    // Caso real cfg 261: 35 de 37 mensajes sin respuesta.
    mensajes: ['ID: 175239', 'Ayúdenme con imágenes reales del producto', 'sigo esperando'],
    checks: ([t1, t2, t3]) => [
      t1.texto.trim() !== MENSAJE_RECIBIDO && 'el dato no recibió el "¡Recibido! ✅" exacto',
      !V.material.test(t2.medias.join()) && 'pidió imágenes y no recibió MATERIAL',
      t3.texto.trim() && `debía callar y dijo: ${t3.texto.slice(0, 60)}`,
    ],
  },
  {
    nombre: 'espera_cancelar_guia',
    espera: true,
    mensajes: ['Guía V4003189450, necesito cancelarla antes de que salga a la transportadora'],
    checks: ([t]) => [!V.retener.test(t.medias.join()) && 'sin plantilla/video RETENER'],
  },
  {
    nombre: 'espera_gracias_calla',
    espera: true,
    mensajes: ['gracias, quedo atento'],
    checks: ([t]) => [t.texto.trim() && `debía callar y dijo: ${t.texto.slice(0, 60)}`],
  },
  {
    nombre: 'espera_reclamo_no_explica',
    espera: true,
    contextos: [ctxAsesor('la guía ya se encuentra empacada, ya no nos es posible retenerla')],
    mensajes: ['pero por qué me dicen que ya no se puede? la generé hoy', 'necesito que me atiendan'],
    checks: ([t1, t2]) => [
      t1.texto.trim() !== MENSAJE_RECIBIDO && 'el reclamo no recibió el "¡Recibido! ✅" exacto',
      t2.texto.trim() && `repitió en vez de callar: ${t2.texto.slice(0, 60)}`,
    ],
  },
  {
    nombre: 'espera_horarios',
    espera: true,
    mensajes: ['y a qué hora es el corte de servientrega hoy?'],
    checks: ([t]) => [!V.horarios.test(t.medias.join()) && 'sin imagen de horarios'],
  },
  {
    nombre: 'talla_no_en_dropi',
    mensajes: ['en dropi no hay la talla 3xl del conjunto deportivo, como la solicito?'],
    checks: ([t]) => [
      /\d+\s*(unidades|disponibles)/i.test(t.texto) && 'dio números de stock',
    ],
  },
];

function checksGlobales(turnos, esc, prompt) {
  const e = [];
  turnos.forEach((t, i) => {
    if (/NUMERO_DE_GUIA|ID_DEL_PRODUCTO/.test(t.crudo)) e.push(`turno ${i + 1}: marcador visible (NUMERO_DE_GUIA)`);
    const huerfana = separarMediaFija({ urls: t.medias, texto: t.crudo, prompt }).descartar;
    if (huerfana.length) e.push(`turno ${i + 1}: media sin su plantilla (${huerfana.map((u) => u.split('/').pop())})`);
    if (esc.espera) {
      if (t.tags.length) e.push(`turno ${i + 1}: en espera no debe mover el chat (${t.tags})`);
      if (/asesor revisa tu caso/i.test(t.texto)) e.push(`turno ${i + 1}: en espera repitió el paso a asesor`);
      if (SALUDO.test(t.texto)) e.push(`turno ${i + 1}: en espera saludó`);
      return;
    }
    if (t.crudo.toLowerCase().includes(ESPERA)) e.push(`turno ${i + 1}: usó [espera] fuera del modo espera`);
    if (i > 0 && SALUDO.test(t.texto)) e.push(`turno ${i + 1} volvió a saludar`);
    if (t.tags.length > 1) e.push(`turno ${i + 1} con ${t.tags.length} tags`);
    if (/\*\*|^#{1,6}\s/m.test(t.crudo)) e.push(`turno ${i + 1} escribió markdown`);
    if (/drive\.google/.test(t.crudo)) e.push(`turno ${i + 1} pegó link de Drive`);
    if (/\[[a-z_]+\]:\s*true/i.test(t.texto)) e.push(`turno ${i + 1}: tag visible para el cliente`);
    if (/producto_(video|imagen)_url/.test(t.texto)) e.push(`turno ${i + 1}: etiqueta de media visible`);
    if (/te paso con (un )?asesor|asesor revisa tu caso/i.test(t.texto) && !t.tags.includes(ASESOR))
      e.push(`turno ${i + 1} promete asesor sin [asesor]:true`);
    // El motor detecta el tag en cualquier lugar (includes); lo que importa es
    // que el texto le diga al cliente qué pasa.
    if (t.tags.includes(ASESOR) && !/asesor revisa tu caso/i.test(t.texto))
      e.push(`turno ${i + 1}: pasó a asesor sin el mensaje de paso a humano`);
    if (t.tags.includes(RESUELTO) && !/con gusto/i.test(t.texto))
      e.push(`turno ${i + 1}: marcó resuelto sin ser el cierre`);
  });
  return e;
}

(async () => {
  const [c10] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = 10`,
    { type: db.QueryTypes.SELECT },
  );
  const api_key_openai = leerApiKeyOpenAI(c10?.api_key_openai);
  if (!api_key_openai) throw new Error('cfg 10 sin api key');

  // Acciones reales de la columna 317 (Contacto Inicial de la 261): definen el
  // contexto que se inyecta en producción.
  const acciones = await db.query(
    `SELECT tipo_accion, config, orden FROM kanban_acciones
      WHERE id_kanban_columna = 317 AND activo = 1 ORDER BY orden`,
    { type: db.QueryTypes.SELECT },
  );
  const PROMPT_PRINCIPAL = promptSoporteImporshop(MEDIA);
  const PROMPT_ESPERA = promptSoporteImporshopEspera(MEDIA);
  console.log(
    `modelo ${MODELO} · prompt ${PROMPT_PRINCIPAL.length} chars · espera ${PROMPT_ESPERA.length} chars\n`,
  );

  let fallasTotal = 0;
  let tokIn = 0;
  let tokOut = 0;
  for (const esc of ESCENARIOS) {
    if (SOLO && esc.nombre !== SOLO) continue;
    process.stdout.write(`▶ ${esc.nombre} `);
    const turnos = [];
    const historial = [];
    let prev = null;
    const instructions = esc.espera ? PROMPT_ESPERA : PROMPT_PRINCIPAL;
    try {
      for (const [n, mensaje] of esc.mensajes.entries()) {
        const contexto = await construirContextoColumna(261, acciones, null, {
          mensaje,
          id_cliente: 0,
          historial: [{ rol_mensaje: 0, texto_mensaje: mensaje }, ...historial],
        });
        const bloque = [esc.contextos?.[n], String(contexto || '').trim()]
          .filter(Boolean)
          .join('\n\n');
        const input = bloque
          ? `🧾 Contexto adicional:\n\n${bloque}\n\n💬 MENSAJE ACTUAL DEL CLIENTE (responde a ESTO):\n${mensaje}`
          : mensaje;
        const r = await ejecutarConResponsesAPI({
          previous_response_id: prev,
          instructions,
          additional_instructions: null,
          input,
          model: MODELO,
          max_tokens: 1200,
          vector_store_id: null,
          api_key_openai,
          id_configuracion: 10,
        });
        prev = r.response_id || prev;
        tokIn += r.usage?.input_tokens || r.total_tokens || 0;
        tokOut += r.usage?.output_tokens || 0;
        const crudo = sanitizarRespuestaAgente(r.respuesta || '');
        const tags = [ASESOR, RESUELTO].filter((tg) => crudo.toLowerCase().includes(tg));
        const media = extraerUrlsMedia(crudo);
        const texto = limpiarMarkdown(limpiarColetillas(limpiarTagsAcciones(media.texto).trim()));
        turnos.push({
          crudo,
          texto,
          tags,
          medias: [...media.imagenes, ...media.videos],
        });
        historial.unshift({ rol_mensaje: 0, texto_mensaje: mensaje });
        historial.unshift({ rol_mensaje: 1, texto_mensaje: texto });
        process.stdout.write('.');
      }
    } catch (err) {
      console.log(` ✖ error: ${err.response?.data?.error?.message || err.message}`);
      fallasTotal += 1;
      continue;
    }

    const fallas = [...esc.checks(turnos), ...checksGlobales(turnos, esc, instructions)].filter(Boolean);
    console.log(fallas.length ? ` ✖ ${fallas.length}` : ' ✔');
    for (const f of fallas) console.log(`     - ${f}`);
    fallasTotal += fallas.length;
    if (fallas.length || SOLO) {
      turnos.forEach((t, i) => {
        console.log(`   [cliente] ${esc.mensajes[i]}`);
        if (t.medias.length) console.log(`   [media] ${t.medias.map((m) => m.split('/').pop()).join(', ')}`);
        console.log(`   [bot${t.tags.length ? ' ' + t.tags.join(' ') : ''}] ${t.texto.replace(/\n/g, '\n         ')}`);
      });
    }
  }
  console.log(`\n📊 tokens: ${tokIn} entrada + ${tokOut} salida`);
  console.log(fallasTotal ? `❌ ${fallasTotal} fallas` : '✅ TODOS LOS ESCENARIOS PASAN');
  await db.close();
  process.exit(fallasTotal ? 1 : 0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
