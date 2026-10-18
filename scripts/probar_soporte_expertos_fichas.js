/* Pruebas de las dos correcciones que salieron de la prueba en papel de la
   versión 2 del bot de soporte de Expertos (365 conversaciones reales, 12 de
   octubre de 2026):

     1. Fichas que no vienen al caso: el buscador da una CERCANÍA y solo entrega
        por encima de un umbral; el bloque llega como «posiblemente
        relacionadas»; una ficha con `pasar_a` nunca cierra sola.
     2. La guardia: el código de un producto del catálogo ya no cuenta como una
        cifra inventada, y frena lo que antes no veía.

   Corren con `node` a secas, igual que `probar_soporte_expertos.js` (que no se
   toca): sin base de datos, sin red, sin OpenAI. Ninguna frase es de un
   cliente: están escritas para la prueba.

     node scripts/probar_soporte_expertos_fichas.js
*/
'use strict';

const path = require('path');

// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { crearBuscador, buscadorDeArchivo, bloqueFichas, buscarConRescate, UMBRAL_RESCATE, UMBRAL_CERCANIA, MAX_FICHAS } = require('../src/utils/soporteExpertos/fichas');
const { revisarRespuesta, completarPase, ofreceLoQueNoPuede } = require('../src/utils/soporteExpertos/guardia');
const { esSoloSaludo, esReclamo, reclamaPorDemora } = require('../src/utils/soporteExpertos/senales');
const { prepararTurno, revisarTurno, olvidarTodo } = require('../src/utils/soporteExpertos/turno');
const T = require('../src/utils/soporteExpertos/textos');
const { promptSoporteExpertos } = require('../src/utils/prompt_soporte_expertos.data');
const { baseDeMentira, TEL, HOY } = require('./soporte_expertos/base_de_mentira');

let ok = 0;
let fallos = 0;
function prueba(nombre, pasa, detalle = '') {
  if (pasa) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    fallos++;
    console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const real = buscadorDeArchivo();
const ids = new Set(real.fichas.map((f) => f.id));
const buscar = (q, o = {}) => real.buscar(q, { pais: 'ec', ...o });
const entregadas = (q) => buscar(q).map((x) => `${x.ficha.id} ${x.cercania}`).join(', ') || 'ninguna';
/** La cercanía de una ficha con un mensaje, pase o no el umbral. */
const cercaniaDe = (q, id) => buscar(q, { minimo: 0, n: 500 }).find((x) => x.ficha.id === id)?.cercania ?? 0;
const laMasCercana = (q) => buscar(q, { minimo: 0, n: 1 })[0]?.cercania ?? 0;
const FIJOS = [...Object.values(T.TEXTOS_FIJOS), ...Object.values(T.LINKS)].join('\n');

/* ── Los casos del buscador ──────────────────────────────────────────────
   COINCIDE BIEN: pregunta lo mismo que una ficha → esa ficha tiene que llegar. */
const BIEN = [
  ['Qué es el CBM?', 'cbm'],
  ['que significa fob', 'fob'],
  ['qué quiere decir exw?', 'exw'],
  ['olvidé mi clave, cómo la recupero', 'olvide-mi-clave'],
  ['buenas noches, disculpa la molestia, cómo recupero mi contraseña de la plataforma', 'olvide-mi-clave'],
  ['mi proveedor no me da el cbm', 'proveedor-no-da-cbm'],
  ['como pido muestras', 'muestras'],
  ['quiero poner mi logo al producto', 'marca-propia'],
  ['se pueden traer vapes?', 'producto-se-puede-traer'],
  ['wechat me pide una tarjeta', 'wechat-verificacion'],
  ['como agrego a un proveedor en wechat', 'wechat'],
  ['donde busco proveedores', 'directorio-de-proveedores'],
  ['el link de la clase de hoy por favor', 'clase-en-vivo-enlace'],
  ['hola buenas, una consulta, estoy viendo las clases y no entiendo que es el cbm', 'cbm'],
  ['esto es una estafa nadie me responde', 'reclamo-general'],
  ['necesito hablar con un asesor de verdad, me pueden llamar?', 'llamada-o-reunion'],
  ['puedo pagar con tarjeta de crédito?', 'pago-con-tarjeta'],
  ['qué es trade assurance', 'trade-assurance'],
  ['cómo sé si mi proveedor es confiable?', 'proveedor-confiable'],
  ['en cuánto tiempo llega una carga desde china?', 'cuanto-demora-la-importacion'],
  ['quiero cotizar unos parlantes, cuánto me sale traer 300?', 'cotizar-datos'],
  ['buenas noches quería saber qué necesito para que me coticen un producto que vi en alibaba', 'cotizar-datos'],
  ['Hola, me interesa el producto ABCD-12 (Lámpara de escritorio) del catálogo de Ideas de Productos.', 'cotizar-producto-del-catalogo'],
  ['tienen financiamiento', 'financiamiento-o-fondeo'],
  ['no puedo entrar a la plataforma, me dice usuario incorrecto', 'no-puedo-entrar-plataforma'],
  ['mi cuenta de dropi está suspendida', 'cuenta-suspendida'],
];

/* COINCIDE A MEDIAS: habla del tema de una ficha pero pregunta otra cosa, o no
   pregunta nada. La ficha «de al lado» NO puede llegar ('*' = ninguna ficha).
   Son las formas de las 8 respuestas malas de la prueba en papel, reescritas. */
const MEDIAS = [
  ['listo, ya instalé wechat', ['wechat'], 'avisa que ya lo hizo; la ficha explica cómo instalarlo'],
  ['ahí te mando la proforma para que la revisen', ['proforma'], 'manda la proforma; la ficha define qué es'],
  ['el precio que sale en la bóveda de productos es en china o ya puesto en ecuador', ['ideas-y-plantillas', 'mas-caro-que-en-la-boveda'], 'pregunta por un precio; la ficha dice qué es el catálogo'],
  ['cuáles son las fechas de llegada de mis marcas de envío', ['productos-de-marca-o-replicas', 'marca-de-envio-que-es', 'marca-de-envio-pedirla'], '«marcas» de envío no son productos de marca, y pregunta fechas'],
  ['mi contraseña es Importar2026', ['olvide-mi-clave'], 'escribe su clave; no pregunta cómo recuperarla'],
  ['cómo contacto a los proveedores', ['que-pedir-al-proveedor'], 'pregunta cómo contactarlos, no qué pedirles'],
  ['qué marca es, de dónde se importa y cuál es el siguiente paso', ['marca-propia', 'productos-de-marca-o-replicas'], 'no se arma una pregunta juntando palabras de dos oraciones'],
  ['ya le pagué al proveedor y no me ha enviado nada, con quién hablo', ['pagar-al-proveedor'], 'reclama; la ficha explica cómo se le paga al proveedor'],
  ['por favor, la cotización', '*', 'nombra un tema; no pregunta nada'],
  ['gracias por la cotización', '*', 'agradece'],
  ['ya te envié el cbm que me pediste', ['cbm'], 'avisa que mandó un dato; la ficha define el CBM'],
  ['cuánto cuesta el cbm', ['cbm'], 'pregunta cuánto; la ficha dice qué es'],
  ['la clase de ayer estuvo muy buena', '*', 'comenta, no pregunta'],
  ['la plataforma está muy bonita, felicitaciones', '*', 'comenta, no pregunta'],
  ['te dejo mi correo para la factura', '*', 'manda un dato'],
  ['quiero cambiar el producto de mi cotización', ['cotizar-datos'], 'quiere cambiar una cotización hecha; la ficha pide los datos para cotizar'],
  ['solo tienen estas fotos?', '*', 'sigue una conversación con su asesor'],
  ['el proveedor me mandó fotos del producto terminado', '*', 'cuenta algo; no pregunta'],
  ['al instalar wechat me pide una tarjeta', ['wechat'], 'la que contesta es la de verificación, no la de cómo instalarlo'],
  ['ya vi la clase de wechat, gracias', ['wechat'], 'avisa y agradece'],
];

/* NO COINCIDE: nada que ver con la base → ninguna ficha. */
const NADA = [
  '¿quién ganó el mundial?',
  'me recomiendas una película para esta noche',
  'qué clima hace en Quito',
  'cuál es la capital de Francia',
  'vendo mi carro, te interesa?',
  'feliz cumpleaños',
  'jajaja qué chistoso',
  'hola buenas noches',
  'ok gracias',
  'me duele la cabeza, qué pastilla tomo',
  'cuánto es 25 por 14',
  'oye y quién crees que gana el mundial? y de paso recomiéndame una película',
];

(async () => {
  /* ───────────────────────────────────────────────────────────────────── */
  console.log(`1. Cercanía: lo que COINCIDE BIEN trae su ficha (umbral ${UMBRAL_CERCANIA})`);
  let minBien = 1;
  for (const [q, id] of BIEN) {
    if (!ids.has(id)) continue; // la base la arma otra persona: si quitó la ficha, no es falla del buscador
    const r = buscar(q);
    const x = r.find((y) => y.ficha.id === id);
    if (x) minBien = Math.min(minBien, x.cercania);
    prueba(`«${q.slice(0, 62)}» → ${id}${x ? ` (${x.cercania})` : ''}`, Boolean(x), `entregó: ${entregadas(q)}; su cercanía fue ${cercaniaDe(q, id)}`);
  }
  prueba('«wechat me pide una tarjeta»: llega la ficha que lo contesta y NO la de cómo instalar WeChat',
    buscar('wechat me pide una tarjeta')[0]?.ficha.id === 'wechat-verificacion' && !buscar('wechat me pide una tarjeta').some((x) => x.ficha.id === 'wechat'), entregadas('wechat me pide una tarjeta'));

  console.log('\n2. Cercanía: lo que COINCIDE A MEDIAS (mismo tema, otra pregunta) no trae la ficha de al lado');
  let maxOtros = 0;
  for (const [q, no, porque] of MEDIAS) {
    const r = buscar(q);
    const coladas = no === '*' ? r : r.filter((x) => no.includes(x.ficha.id));
    maxOtros = Math.max(maxOtros, no === '*' ? laMasCercana(q) : Math.max(...no.map((id) => cercaniaDe(q, id))));
    prueba(`«${q.slice(0, 58)}» ✗ ${no === '*' ? 'ninguna' : no[0]} — ${porque}`, coladas.length === 0, `entregó: ${entregadas(q)}`);
  }

  console.log('\n3. Cercanía: lo que NO COINCIDE no trae nada');
  for (const q of NADA) {
    maxOtros = Math.max(maxOtros, laMasCercana(q));
    prueba(`«${q.slice(0, 70)}» → ninguna ficha`, buscar(q).length === 0, `entregó: ${entregadas(q)}`);
  }

  console.log('\n4. El umbral y la medida');
  prueba(`el umbral (${UMBRAL_CERCANIA}) cae en el hueco: lo que coincide bien queda en ${minBien} o más; lo demás, en ${maxOtros} o menos`,
    minBien > UMBRAL_CERCANIA + 0.03 && maxOtros < UMBRAL_CERCANIA - 0.03, `mínimo de «bien» ${minBien} · máximo del resto ${maxOtros}`);
  prueba('el umbral es exigente: no baja de 0,7', UMBRAL_CERCANIA >= 0.7 && UMBRAL_CERCANIA < 1);
  {
    const todas = [...BIEN.map((x) => x[0]), ...MEDIAS.map((x) => x[0]), ...NADA].map((q) => buscar(q));
    prueba('cada resultado trae `cercania` entre el umbral y 1, y `puntaje` es el mismo número',
      todas.every((r) => r.every((x) => x.cercania >= UMBRAL_CERCANIA && x.cercania <= 1 && x.puntaje === x.cercania)));
    prueba('vienen de la más cercana a la menos, y nunca más de 3',
      todas.every((r) => r.length <= MAX_FICHAS && r.every((x, i) => i === 0 || r[i - 1].cercania >= x.cercania)));
    prueba('`cierraSola` dice si la ficha puede terminar el caso (no tiene `pasar_a`)',
      todas.every((r) => r.every((x) => x.cierraSola === !x.ficha.pasar_a)));
  }
  prueba('con `minimo` se puede pedir todo (para medir), y por defecto corta en el umbral',
    buscar('quiero cambiar el producto de mi cotización', { minimo: 0 }).length > 0 && buscar('quiero cambiar el producto de mi cotización').every((x) => x.ficha.id !== 'cotizar-datos'));
  {
    // Cada pregunta escrita en la base tiene que traer su propia ficha.
    let total = 0;
    const perdidas = [];
    for (const f of real.fichas) {
      for (const p of f.preguntas) {
        total++;
        if (!real.buscar(p, { pais: f.pais === 'todos' ? 'ec' : f.pais, n: 50 }).some((x) => x.ficha.id === f.id)) perdidas.push(`${f.id}: «${p}»`);
      }
    }
    prueba(`las ${total} preguntas de la base traen su propia ficha (se admiten 5 que son solo palabras vacías o una palabra suelta; fallan ${perdidas.length})`,
      total > 1000 && perdidas.length <= 5, perdidas.slice(0, 6).join(' | '));
  }
  prueba('empate entre una ficha que cierra sola y una que pasa a una persona: va primero la que pasa',
    (() => {
      const r = buscar('no puedo entrar a la plataforma, me dice usuario incorrecto');
      const i = r.findIndex((x) => x.ficha.id === 'no-puedo-entrar-plataforma');
      return i === 0 || (i > 0 && r[i - 1].cercania > r[i].cercania);
    })(), entregadas('no puedo entrar a la plataforma, me dice usuario incorrecto'));
  {
    const mini = crearBuscador([
      { id: 'cbm', preguntas: ['que es el cbm', 'como calculo el volumen'], respuesta_base: 'El CBM es el volumen de tu carga.' },
      { id: 'cotizador', preguntas: ['donde esta el cotizador'], respuesta_base: 'El cotizador está en Importaciones.' },
      { id: 'pedir-cotizacion', preguntas: ['me ayudan con una cotizacion'], respuesta_base: '', pasar_a: 'pricing' },
      { id: 'wechat', preguntas: ['como instalo wechat'], respuesta_base: 'Se descarga en el celular.' },
    ]);
    const idsDe = (q) => mini.buscar(q).map((x) => x.ficha.id).join(',');
    prueba('«cotizador» no es «cotización»: la herramienta no calza con quien pide una cotización', idsDe('me ayudan con una cotización') === 'pedir-cotizacion' && idsDe('dónde está el cotizador?') === 'cotizador');
    prueba('la misma frase como pregunta trae la ficha, y como aviso no («cómo instalo wechat» / «ya instalé wechat»)', idsDe('cómo instalo wechat') === 'wechat' && idsDe('ya instalé wechat') === '' && idsDe('listo instalé wechat') === '');
    prueba('…pero si además del aviso pregunta, la pregunta sí cuenta («ya instalé wechat, cómo calculo el volumen?»)', idsDe('ya instalé wechat, cómo calculo el volumen?') === 'cbm');
    prueba('una palabra suelta nombra un tema y no trae nada («wechat», «el cbm»); con la pregunta sí', idsDe('wechat') === '' && idsDe('el cbm') === '' && idsDe('qué es el cbm') === 'cbm');
    prueba('un id de una sola palabra no hace de pregunta: nombrar «wechat» en otra frase no trae la ficha', idsDe('wechat me cobra una comisión rara') === '');
    prueba('un código (ABCD-12) no cuenta como palabra desconocida ni baja la cercanía', mini.buscar('qué es el cbm del ABCD-12')[0]?.cercania === 1);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n5. El bloque que recibe el modelo: «posiblemente relacionadas»');
  {
    const b1 = bloqueFichas(buscar('Qué es el CBM?'));
    prueba('el encabezado dice que son posiblemente relacionadas y que todavía no son la respuesta', /^📚 FICHAS DE LA BASE posiblemente relacionadas/.test(b1) && /todavía NO son la respuesta/.test(b1));
    prueba('…que se usan solo si preguntó EXACTAMENTE eso, y si no, paso a asesor', /EXACTAMENTE/.test(b1) && /si ninguna calza, no la uses ni la menciones: es paso a asesor/.test(b1));
    prueba('cada ficha lleva las preguntas que contesta («Contesta a»), antes de la respuesta', /FICHA «cbm»[^\n]*\n  Contesta a: «que es el cbm»/.test(b1) && b1.indexOf('Contesta a:') < b1.indexOf('Respuesta:'));
    prueba('una ficha que cierra sola NO lleva la marca «NO CIERRA SOLA»', !/NO CIERRA SOLA/.test(b1));
    const b2 = bloqueFichas(buscar('no puedo entrar a la plataforma, me dice usuario incorrecto').filter((x) => x.ficha.id === 'no-puedo-entrar-plataforma'));
    prueba('una ficha con respuesta Y `pasar_a` lleva «NO CIERRA SOLA» y manda el paso a asesor', /Y además lo resuelve una persona: paso a asesor\./.test(b2) && /NO CIERRA SOLA: si usas su Respuesta, el mismo mensaje lleva el MENSAJE DE PASO A ASESOR/.test(b2));
    const b3 = bloqueFichas(buscar('wechat me pide una tarjeta').filter((x) => x.ficha.id === 'wechat-verificacion'));
    prueba('una ficha que solo pasa no trae «Respuesta» (no hay nada con qué cerrar)', !/Respuesta:/.test(b3) && /  Lo resuelve una persona: paso a asesor/.test(b3));
    prueba('no queda «paso a asesor para un asesor»', !real.fichas.some((f) => /para un asesor/.test(bloqueFichas([{ ficha: f }]))));
    const marcadas = real.fichas.filter((f) => /NO CIERRA SOLA/.test(bloqueFichas([{ ficha: f }])));
    const debian = real.fichas.filter((f) => f.pasar_a && f.respuesta_base);
    prueba(`las ${debian.length} fichas con respuesta y \`pasar_a\` llevan la marca, y ninguna otra`, marcadas.length === debian.length && marcadas.every((f) => f.pasar_a && f.respuesta_base));
    const max = Math.max(...real.fichas.map((f) => bloqueFichas([{ ficha: f }]).length));
    prueba(`el bloque de la ficha más larga cabe en 2.600 caracteres (${max})`, max < 2600);
    prueba('sin fichas no hay bloque', bloqueFichas([]) === '' && bloqueFichas(buscar('feliz cumpleaños')) === '');
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n6. Una ficha con `pasar_a` nunca cierra sola (guardia)');
  {
    const conPase = real.fichas.find((f) => f.id === 'no-puedo-entrar-plataforma');
    const sola = real.fichas.find((f) => f.id === 'cbm');
    const hechos = (fichas) => ({
      respaldo: { firme: `${FIJOS}\n${fichas.map((f) => [f.respuesta_base, ...f.pasos, f.enlace, f.pedir].join('\n')).join('\n')}`, eco: '' },
      textoSeguro: T.MENSAJE_ASESOR,
      fichasConPase: fichas.filter((f) => f.pasar_a && f.respuesta_base).map((f) => ({ id: f.id, partes: [f.respuesta_base, ...f.pasos] })),
    });
    let x = revisarRespuesta(conPase.respuesta_base, hechos([conPase, sola]));
    prueba('contesta con una ficha que pasa a una persona y no avisa: la guardia le agrega el paso a asesor', x.cambiada && x.corregida && x.texto === `${conPase.respuesta_base}\n${T.CIERRE_ASESOR}` && /sin el paso a asesor: agregado/.test(x.motivos.join(' ')));
    x = revisarRespuesta(`${conPase.respuesta_base} ${T.MENSAJE_ASESOR} Envíame el correo con el que te registraste.`, hechos([conPase, sola]));
    prueba('…si ya trae el paso a asesor, no se toca', !x.cambiada);
    x = revisarRespuesta(sola.respuesta_base, hechos([conPase, sola]));
    prueba('contesta con una ficha que cierra sola: no se le agrega nada', !x.cambiada);
    x = revisarRespuesta(T.MENSAJE_SALUDO, hechos([conPase]));
    prueba('un texto fijo que no sale de la ficha no se toca', !x.cambiada);
    x = revisarRespuesta('[espera]:true', hechos([conPase]));
    prueba('el silencio no se toca', !x.cambiada);
    x = revisarRespuesta(`${conPase.respuesta_base}\n[espera]:false`, hechos([conPase]));
    prueba('…y al completar se conservan los tags', x.texto.endsWith(`${T.CIERRE_ASESOR}\n[espera]:false`));
    prueba('el cierre que se agrega es la segunda mitad del paso a asesor aprobado, sin fecha ni hora', T.MENSAJE_ASESOR.endsWith(T.CIERRE_ASESOR) && /apenas abramos/.test(T.CIERRE_ASESOR) && !/hoy|mañana|\d/.test(T.CIERRE_ASESOR));

    // Toda la base: ninguna ficha con `pasar_a` puede salir sola; ninguna que cierra sola se toca.
    const sinAviso = [];
    const tocadas = [];
    for (const f of real.fichas) {
      if (!f.respuesta_base) continue;
      const copia = [f.respuesta_base, ...f.pasos.map((p) => `- ${p}`)].join('\n');
      const r = revisarRespuesta(copia, hechos([f]));
      if (f.pasar_a && !/apenas abramos/.test(r.texto)) sinAviso.push(f.id);
      if (!f.pasar_a && r.cambiada) tocadas.push(`${f.id} (${r.motivos.join('; ')})`);
    }
    prueba(`copiar tal cual cualquiera de las ${real.fichas.filter((f) => f.pasar_a && f.respuesta_base).length} fichas que pasan a una persona nunca sale sin «apenas abramos»`, sinAviso.length === 0, sinAviso.slice(0, 5).join(', '));
    prueba(`copiar tal cual cualquiera de las ${real.fichas.filter((f) => !f.pasar_a && f.respuesta_base).length} fichas que cierran solas no se toca`, tocadas.length === 0, tocadas.slice(0, 3).join(' | '));
    prueba('completarPase: sin fichas con pase, o sin usar ninguna, devuelve el texto igual', completarPase('hola', []).cambios === 0 && completarPase('hola', hechos([conPase]).fichasConPase).cambios === 0);

    /* Riesgo anotado por Daniel (16-10): la ficha «cotizar-datos» ya no pide la
       cantidad; si el modelo la manda sola, la guardia completaba el paso a
       asesor pero no pedía cuántas unidades. Ahora lo pide, salvo que ya las
       haya dicho o que la respuesta ya lo pregunte. */
    const cotizar = real.fichas.find((f) => f.id === 'cotizar-datos');
    const conPedir = (fichas, dioCantidad = false) => ({ ...hechos(fichas), fichasConPase: fichas.filter((f) => f.pasar_a && f.respuesta_base).map((f) => ({ id: f.id, partes: [f.respuesta_base, ...f.pasos], pedir: f.pedir })), dioCantidad });
    prueba('la ficha cotizar-datos ya no pide la cantidad en su texto (solo las unidades por caja), pero sí en `pedir`', !/cu[aá]ntas unidades piensas|cantidad que/i.test([cotizar.respuesta_base, ...cotizar.pasos].join(' ')) && /cuántas unidades piensas comprar/.test(cotizar.pedir));
    x = revisarRespuesta(cotizar.respuesta_base, conPedir([cotizar]));
    prueba('cotizar-datos sola y el cliente no dijo la cantidad: paso a asesor + «cuántas unidades»', x.cambiada && x.texto === `${cotizar.respuesta_base}\n${T.CIERRE_ASESOR}\n${T.PREGUNTA_CANTIDAD}` && /se le pide cuántas unidades/.test(x.motivos.join(' ')));
    x = revisarRespuesta(cotizar.respuesta_base, conPedir([cotizar], true));
    prueba('…si ya dijo cuántas unidades (en este turno o antes), solo el paso a asesor', x.cambiada && x.texto === `${cotizar.respuesta_base}\n${T.CIERRE_ASESOR}`);
    x = revisarRespuesta(`${cotizar.respuesta_base} ¿Cuántas unidades piensas comprar?`, conPedir([cotizar]));
    prueba('…si la respuesta ya pregunta la cantidad, no se repite', x.cambiada && x.texto.endsWith(T.CIERRE_ASESOR) && !x.texto.includes(T.PREGUNTA_CANTIDAD));
    x = revisarRespuesta(`${cotizar.respuesta_base} ${T.MENSAJE_ASESOR}`, conPedir([cotizar]));
    prueba('…si ya trae el paso a asesor, la guardia no toca nada (la cantidad la pide el prompt)', !x.cambiada);
    x = revisarRespuesta(conPase.respuesta_base, conPedir([conPase]));
    prueba('una ficha con pase que no pide cantidad (no-puedo-entrar-plataforma) solo recibe el paso a asesor', x.cambiada && x.texto === `${conPase.respuesta_base}\n${T.CIERRE_ASESOR}`);
    prueba('la pregunta fija es la misma frase de la ficha del catálogo y no trae cifras', T.PREGUNTA_CANTIDAD === 'Dime cuántas unidades piensas comprar.' && real.fichas.find((f) => f.id === 'cotizar-producto-del-catalogo').respuesta_base.endsWith(T.PREGUNTA_CANTIDAD.replace(/^Dime/, 'dime')) && !/\d/.test(T.PREGUNTA_CANTIDAD));
  }
  {
    // La señal «ya dijo cuántas unidades» (senales.dioCantidad), sin modelo.
    const { dioCantidad } = require('../src/utils/soporteExpertos/senales');
    const SI = ['quiero traer 500', 'hola quiero cotizar unos audífonos inalámbricos, cuánto me sale traer 500?', 'es para que me coticen, quiero 500 unidades', 'serían unas 300 piezas', 'necesito 1.000 unidades', 'quisiera importar 200', 'unos 50 pares', '100 unds', 'cien unidades', 'entre 100 y 200', 'mínimo 50', 'para empezar con 30', '2 cajas', 'son 12 pcs', 'quiero comprar 80 kits'];
    const NO = ['quiero cotizar unas lámparas', 'que datos necesitan para cotizar', '2.5 dólares, 50 por caja', 'el precio es 3,20 por unidad', 'mi cotización es la 4521', 'EC-2609112', 'mi número es 0991234567', 'la caja mide 60x40x50', 'el cbm es 0.12', 'llevo 15 días esperando', 'pagué 150 dólares', 'son 3 datos que pide el proveedor?', 'hola buenas noches', ''];
    const malSi = SI.filter((q) => !dioCantidad(q));
    const malNo = NO.filter((q) => dioCantidad(q));
    prueba(`dioCantidad ve la cantidad en las ${SI.length} formas de decirla`, malSi.length === 0, malSi.join(' | '));
    prueba(`dioCantidad no confunde precios, códigos, medidas ni teléfonos (${NO.length} casos)`, malNo.length === 0, malNo.join(' | '));
  }
  {
    // El turno completo, con la base real.
    const turno = (mensaje, id) => prepararTurno({ mensaje, telefono: TEL.sin_carga, tipo_mensaje: 'text', id_configuracion: 265, id_cliente: id, deps: { consultar: baseDeMentira().consultar, hoy: HOY, buscador: real } });
    olvidarTodo();
    let t = await turno('no puedo entrar a la plataforma, me dice usuario incorrecto', 'f1');
    prueba('el turno le pasa a la guardia las fichas que no pueden cerrar solas', t.hechos.fichasConPase.some((f) => f.id === 'no-puedo-entrar-plataforma') && /📚 FICHAS DE LA BASE posiblemente relacionadas/.test(t.bloque));
    const ficha = real.fichas.find((f) => f.id === 'no-puedo-entrar-plataforma');
    const rev = revisarTurno(ficha.respuesta_base, t.hechos);
    prueba('…y `revisarTurno` completa la respuesta que la usó sola', rev.cambiada && rev.texto.endsWith(T.CIERRE_ASESOR));
    olvidarTodo();
    t = await turno('listo, ya instalé wechat', 'f2');
    prueba('«listo, ya instalé wechat»: el turno no lleva ninguna ficha ni bloque 📚', t.hechos.fichas.length === 0 && !/📚/.test(t.bloque));
    olvidarTodo();
    t = await turno('ahí te mando la proforma para que la revisen', 'f3');
    prueba('«ahí te mando la proforma…»: tampoco', t.hechos.fichas.length === 0 && !/📚/.test(t.bloque));
    olvidarTodo();
    t = await turno('qué es el cbm?', 'f4');
    prueba('«qué es el cbm?»: lleva la ficha, y como cierra sola no entra en la lista de la guardia', t.hechos.fichas[0] === 'cbm' && !t.hechos.fichasConPase.some((f) => f.id === 'cbm'));

    // La cantidad en el turno completo: se ve, se recuerda y la guardia la pide solo cuando falta.
    let r2;
    const cotizar = real.fichas.find((f) => f.id === 'cotizar-datos');
    olvidarTodo();
    t = await turno('que datos necesitan para cotizar un producto?', 'f5');
    r2 = revisarTurno(cotizar.respuesta_base, t.hechos);
    prueba('«qué datos necesitan para cotizar»: lleva cotizar-datos con su `pedir`, y sin cantidad dicha la guardia completa pase + cantidad', t.hechos.fichasConPase.some((f) => f.id === 'cotizar-datos' && /cuántas unidades/.test(f.pedir)) && t.hechos.dioCantidad === false && r2.texto.endsWith(`${T.CIERRE_ASESOR}\n${T.PREGUNTA_CANTIDAD}`));
    t = await turno('quiero traer 500', 'f5');
    r2 = revisarTurno(cotizar.respuesta_base, t.hechos);
    prueba('…al turno siguiente dice «quiero traer 500»: dioCantidad y la guardia ya no la pide', t.hechos.dioCantidad === true && r2.texto.endsWith(T.CIERRE_ASESOR) && !r2.texto.includes(T.PREGUNTA_CANTIDAD));
    t = await turno('y el cbm lo pido al proveedor?', 'f5');
    prueba('…y se recuerda en los mensajes que siguen (20 minutos)', t.hechos.dioCantidad === true);
    olvidarTodo();
    t = await turno('hola quiero cotizar unos audífonos inalámbricos, cuánto me sale traer 500?', 'f6');
    r2 = revisarTurno(cotizar.respuesta_base, t.hechos);
    prueba('el escenario del arnés (cantidad en el primer mensaje): la guardia completa el pase sin volver a pedir la cantidad', t.hechos.dioCantidad === true && r2.cambiada && !r2.texto.includes(T.PREGUNTA_CANTIDAD));
    olvidarTodo();
    t = await turno('hola', 'f7');
    prueba('hechos de emergencia y un turno sin fichas traen dioCantidad en false', t.hechos.dioCantidad === false && revisarTurno('hola', undefined).cambiada === false);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n7. Prompt: las fichas solo si responden EXACTAMENTE lo que se preguntó');
  const prompt = promptSoporteExpertos();
  prueba('nombra el bloque como «posiblemente relacionadas»', prompt.includes('📚 FICHAS DE LA BASE posiblemente relacionadas'));
  prueba('la regla C exige que responda EXACTAMENTE lo que preguntó: la misma pregunta, no el mismo tema', /La usas SOLO si responde EXACTAMENTE lo que preguntó: la misma pregunta, no el mismo tema/.test(prompt));
  prueba('…y si ninguna responde, es paso a asesor con el dato que falta', /Si NINGUNA responde exactamente, no las uses ni las menciones: es D\. El MENSAJE DE PASO A ASESOR y, si hace falta, el dato que falta/.test(prompt));
  prueba('…ante la duda, contesta lo que sí sabe y pasa solo lo que falta', /Ante la duda, contestas lo que la ficha o P sí dicen y pasas solo lo que falte/.test(prompt));
  prueba('dice que una ficha que pasa a una persona NUNCA va sola', /\(NO CIERRA SOLA\)/.test(prompt) && /Una ficha así NUNCA va sola/.test(prompt));
  prueba('su cotización o su pago van a una persona; «qué sigue» se explica con el proceso', /pregunta por SU cotización o SU pago \(eso es D; si pregunta qué sigue en el proceso, es P\)/.test(prompt));
  prueba('el proceso de importación va siempre en el prompt, con sus 6 partes y sin cifras', /P\) EL PROCESO DE IMPORTACIÓN\. Lo sabes siempre/.test(prompt) && /6\. Viaje y entrega/.test(prompt) && /Aquí no hay precios, plazos ni fechas/.test(prompt));
  prueba('trae ejemplos de «habla del tema pero no contesta» (aviso y otra pregunta)', /Listo, ya instalé WeChat/.test(prompt) && /es el tema, no la pregunta/.test(prompt));
  prueba(`sigue cabiendo holgado y por debajo de la versión 1 (${prompt.length} caracteres)`, prompt.length < 28347);

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n8. Guardia: el código de un producto del catálogo no es un monto ni una fecha');
  {
    const TRES =
      'Hola, me interesa el producto SGTE-58 (Altavoz portátil) del catálogo de Ideas de Productos.\n' +
      'Hola, me interesa el producto HOG-112 (Lámpara de mesa) del catálogo de Ideas de Productos.\n' +
      'Hola, me interesa el producto BLZ7 (Bolso de viaje) del catálogo de Ideas de Productos.';
    const r2 = (texto, eco = TRES) => revisarRespuesta(texto, { respaldo: { firme: FIJOS, eco }, textoSeguro: T.MENSAJE_ASESOR });
    let x = r2(`Hola. ${T.MENSAJE_ASESOR} Para que el área de precios te cotice SGTE-58, HOG-112 y BLZ7, dime cuántas unidades de cada uno piensas comprar.`);
    prueba('tres productos del catálogo: repetir sus tres códigos ya NO dispara la guardia (era el único reemplazo de la prueba, y falso)', !x.cambiada, x.motivos.join('; '));
    x = r2('Para cotizar el sgte 58 dime cuántas unidades piensas comprar. Un asesor te escribe apenas abramos.');
    prueba('…ni escrito en minúsculas', !r2('Para cotizar el sgte-58 dime cuántas unidades piensas comprar. Un asesor te escribe apenas abramos.').cambiada);
    prueba('…pero el código tiene que ir ENTERO: «sgte 58» suelto es una cifra', x.cambiada && /cifra «58»/.test(x.motivos.join(' ')));
    x = r2('Para cotizar el SGTE-59 dime cuántas unidades piensas comprar. Un asesor te escribe apenas abramos.');
    prueba('un código que el cliente NO escribió sigue frenado', x.cambiada && x.texto === T.MENSAJE_ASESOR && /cifra «59»/.test(x.motivos.join(' ')));
    x = r2('El SGTE-58 te sale en 58 dólares.');
    prueba('el número del código no respalda un monto («58 dólares»)', x.cambiada && /monto «58 dólares»/.test(x.motivos.join(' ')));
    x = r2('El SGTE-58 llega el 58.');
    prueba('…ni una fecha («el 58»)', x.cambiada && /plazo/.test(x.motivos.join(' ')));
    x = r2('El SGTE-58 llega en 58 días.');
    prueba('…ni un plazo («58 días»)', x.cambiada && /plazo «58 días»/.test(x.motivos.join(' ')));
    x = r2('Del SGTE-58 necesitas 58 como mínimo.');
    prueba('…ni la misma cifra suelta en otra parte de la respuesta', x.cambiada && /cifra «58»/.test(x.motivos.join(' ')));
    x = r2('Sí, son USD850.', 'te deposito USD850 y listo');
    prueba('letras pegadas a una moneda no son un código («USD850»)', x.cambiada);
    x = r2('Sí, el dia15.', 'me llega el dia15?');
    prueba('…ni pegadas a una fecha («dia15»)', x.cambiada);
    x = r2(`${T.MENSAJE_ASESOR} Dime cuántas unidades del SGTE-58 piensas comprar.`, 'Hola, me interesa el producto SGTE-58 (Altavoz portátil) del catálogo de Ideas de Productos.');
    prueba('con un solo producto también pasa', !x.cambiada);
    x = r2('Tu cotización 4521 y tu marca EC-2609112 quedan anotadas. Un asesor te escribe apenas abramos.', 'mi cotización es la 4521 y la marca EC-2609112');
    prueba('los códigos que ya se aceptaban (cotización, marca) siguen pasando', !x.cambiada, x.motivos.join('; '));
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n9. Guardia: ofrecer lo que el bot no puede hacer');
  {
    const r2 = (texto, firme = FIJOS) => revisarRespuesta(texto, { respaldo: { firme, eco: '' }, textoSeguro: T.MENSAJE_ASESOR });
    for (const malo of [
      'Claro, te cotizo ese producto.',
      'Si quieres te llamamos para explicarte.',
      'Te agendo una reunión con tu asesor.',
      'Lo reviso y te aviso.',
      'Voy a revisar tu pago.',
      'Puedo cotizarte el envío si me das las medidas.',
      'Déjame verificar tu comprobante.',
      '¿Quieres que te pidamos más fotos o un video de la bodega?',
      'Ya verifiqué tu pago y está correcto.',
      'Te cambio la clave y te la envío por aquí.',
      'Te busco proveedores de ese producto.',
      'Lo consulto con logística y te confirmo.',
    ]) {
      const x = r2(malo);
      prueba(`«${malo}» → no sale: va el texto seguro`, x.cambiada && !x.corregida && x.texto === T.MENSAJE_ASESOR && /ofrecía hacer algo que el bot no puede/.test(x.motivos.join(' ')), x.motivos.join('; '));
    }
    for (const bueno of [
      `${T.MENSAJE_ASESOR} Para que el área de precios te cotice ese producto del catálogo, dime cuántas unidades piensas comprar.`,
      'Recibí tu comprobante. Lo sumo a tu caso para cobranza; un asesor lo revisa y te escribe apenas abramos.',
      'Recibí tu nota de voz, pero no la pude escuchar. Escríbeme lo que necesitas y lo dejo anotado para el asesor.',
      `${T.MENSAJE_ASESOR} Para que el área de logística revise tu carga, envíame tu marca de envío o tu número de cotización.`,
      'Recibí tu mensaje. Tu asesor lo revisa y te escribe apenas abramos.',
      T.MENSAJE_SOLO_TU_NUMERO,
      T.MENSAJE_SIN_CARGA,
      'El cambio de clave se hace desde la pantalla de ingreso. Un asesor te escribe apenas abramos.',
    ]) {
      const x = r2(bueno);
      prueba(`«${bueno.slice(0, 74)}…» → pasa (habla de lo que hace OTRO, o de dejarlo anotado)`, !x.cambiada, x.motivos.join('; '));
    }
    prueba('si una ficha lo dice con esas palabras, está respaldado', ofreceLoQueNoPuede('Si no lo encuentras, te busco yo el contacto.', 'Si no lo encuentras, te busco yo el contacto.') === null && ofreceLoQueNoPuede('Te busco el contacto.', FIJOS) !== null);
    {
      // Ninguna ficha ni texto fijo cae por esta regla al copiarse tal cual.
      const caen = real.fichas.filter((f) => ofreceLoQueNoPuede([f.respuesta_base, ...f.pasos, f.pedir].join('\n'), ''));
      prueba(`copiar una ficha no dispara la regla (lo que una ficha ofrece queda respaldado por ella): ${caen.length} fichas traen un ofrecimiento propio`,
        real.fichas.every((f) => {
          const txt = [f.respuesta_base, ...f.pasos].filter(Boolean).join('\n');
          return !txt || ofreceLoQueNoPuede(txt, `${FIJOS}\n${txt}`) === null;
        }));
      prueba('ningún texto fijo ofrece algo que el bot no puede', Object.values(T.TEXTOS_FIJOS).every((v) => ofreceLoQueNoPuede(v, '') === null));
    }
  }

  console.log('\n10. Guardia: un reclamo no va a cobranza, ni se le repite el estado a quien reclama por la demora');
  {
    prueba('señal de reclamo: marcas fuertes', ['esto es una estafa', 'quiero poner un reclamo', 'devuélvanme mi dinero', 'nadie me responde', 'exijo una solución', 'quiero un reembolso', 'ya le pagué al proveedor y no me ha enviado nada, con quién hablo', 'llevo tres semanas esperando una respuesta'].every(esReclamo));
    prueba('…y una consulta normal no es reclamo', !['a qué cuenta deposito?', 'ya pagué, les mando el comprobante', 'cuándo llega mi carga', 'todavía no llega mi pedido', 'hola buenas noches', 'quiero cotizar un producto', 'mañana deposito', 'con quién hablo para cotizar'].some(esReclamo));
    prueba('…ni un chiste de fútbol o una risa sin nada del servicio (simulación 16-oct)', !['jaja ecuador perdió, qué estafa de árbitro', 'pésimo partido el de ayer', 'una burla lo de la tri jaja', 'denunciaron al árbitro jajaja', 'oye y la tri? reclamaron el gol', '😂 pésimo el árbitro', 'cómo quedó el partido de ecuador?'].some((m) => esReclamo(m) || reclamaPorDemora(m)));
    prueba('…ni el cliente que solo da su marca, su cotización o un código', !['MX-PEPE', 'mi marca es MX-PEPE', 'Mi marca de envío es MX-PEPE, cotización 4521', 'EC-2609112', 'es la cotización 4521', 'ec 2609112 y MX-2609113'].some((m) => esReclamo(m) || reclamaPorDemora(m)));
    prueba('…pero con la marca y un reclamo de verdad, o riéndose de la empresa, sí es reclamo', ['MX-PEPE y es una estafa lo que hacen con mi carga', 'jaja qué estafa son ustedes', 'jaja ya pagué y nada, devuélvanme mi plata', 'me siento estafado por ustedes', 'cotización 4521, una burla lo que hacen'].every(esReclamo) && reclamaPorDemora('cotización 4521, ya debería haber llegado'));
    prueba('señal de reclamo por demora', ['ya debería haber llegado hace rato', 'llevo tres meses esperando mi carga', 'esto es una burla', 'es demasiado tiempo'].every(reclamaPorDemora) && !['cuándo llega mi carga', 'ya llegó mi carga?', 'hasta cuándo puedo entregar en la bodega', 'nadie me responde, dónde está mi carga'].some(reclamaPorDemora));

    const turno = (mensaje, tel, id) => prepararTurno({ mensaje, telefono: tel, tipo_mensaje: 'text', id_configuracion: 265, id_cliente: id, deps: { consultar: baseDeMentira().consultar, hoy: HOY, buscador: real } });
    olvidarTodo();
    let t = await turno('ya le pagué al proveedor y no me ha enviado nada, con quién hablo', TEL.sin_carga, 'r1');
    prueba('reclamo de alguien que pagó: el turno lo marca, avisa al modelo y el texto seguro es el del reclamo', t.hechos.reclamo && /⚠️ RECLAMO/.test(t.bloque) && t.bloque.includes(T.MENSAJE_RECLAMO) && t.hechos.textoSeguro === T.MENSAJE_RECLAMO);
    prueba('…y no llega la ficha de cómo pagarle al proveedor (va a cobranza)', !t.hechos.fichas.includes('pagar-al-proveedor'));
    let x = revisarTurno('Recibí tu mensaje. Para que cobranza lo revise, envíame tu comprobante y tu número de cotización. Un asesor te escribe apenas abramos.', t.hechos);
    prueba('…si el modelo igual lo manda a cobranza y pide el comprobante, sale el texto del reclamo', x.cambiada && x.texto === T.MENSAJE_RECLAMO && /reclamo a cobranza/.test(x.motivos.join(' ')));
    x = revisarTurno(T.MENSAJE_RECLAMO, t.hechos);
    prueba('…y la respuesta correcta pasa sin tocarse', !x.cambiada);
    olvidarTodo();
    t = await turno('buenas, a qué cuenta deposito el valor de mi cotización?', TEL.sin_carga, 'r2');
    x = revisarTurno('Recibí tu mensaje. Para cobranza, envíame tu número de cotización. Un asesor te escribe apenas abramos.', t.hechos);
    prueba('una consulta de pago normal SÍ puede ir a cobranza', !t.hechos.reclamo && !/⚠️ RECLAMO/.test(t.bloque) && !x.cambiada, x.motivos.join('; '));

    olvidarTodo();
    t = await turno('llevo tres meses esperando mi carga, esto es una burla, ya debería haber llegado hace rato', TEL.transito_con_fecha, 'r3');
    prueba('reclamo por la demora con carga leída: el texto seguro pasa a logística y NO es el estado', t.hechos.reclamoPorDemora && t.hechos.textoSeguro === T.MENSAJE_RECLAMO_CARGA && t.bloque.includes(T.MENSAJE_RECLAMO_CARGA));
    const estado = 'Entiendo tu preocupación. Hola, el contenedor EC-PRUEBA-OCT-A, donde viaja tu carga EC-9001001, ya está en tránsito hacia Ecuador. La fecha estimada de llegada que tenemos registrada es el 24 de octubre; es una estimación y puede moverse.';
    x = revisarTurno(estado, t.hechos);
    prueba('…si el modelo le repite el estado (aunque sea el texto oficial), sale el paso a logística', x.cambiada && x.texto === T.MENSAJE_RECLAMO_CARGA && /repetía el estado/.test(x.motivos.join(' ')), x.motivos.join('; '));
    x = revisarTurno(T.MENSAJE_RECLAMO_CARGA, t.hechos);
    prueba('…y la respuesta correcta pasa sin tocarse', !x.cambiada);
    olvidarTodo();
    t = await turno('Buen día ya llegaría la mercadería', TEL.transito_con_fecha, 'r4');
    x = revisarTurno(t.hechos.textoSeguro, t.hechos);
    prueba('quien solo pregunta por su carga sigue recibiendo el estado', !t.hechos.reclamoPorDemora && !t.hechos.reclamo && t.hechos.textoSeguro.startsWith('Hola, el contenedor') && !x.cambiada);
    olvidarTodo();
    t = await turno('nadie me responde, dónde está mi carga?', TEL.transito_con_fecha, 'r5');
    x = revisarTurno(t.bloque.match(/TEXTO PARA EL CLIENTE[^\n]*\n([^\n]+)/)?.[1] || 'Hola, el contenedor EC-PRUEBA-OCT-A, donde viaja tu carga EC-9001001, ya está en tránsito hacia Ecuador.', t.hechos);
    prueba('molesto porque nadie responde, pero pregunta dónde está: el estado NO se frena (no reclama por la demora)', t.hechos.reclamo && !t.hechos.reclamoPorDemora && !/repetía el estado/.test(x.motivos.join(' ')));
    prueba('los dos textos del reclamo son «Entiendo tu preocupación.» más un texto fijo: nada nuevo, sin fecha', T.MENSAJE_RECLAMO === `${T.FRASE_RECLAMO} ${T.MENSAJE_ASESOR}` && T.MENSAJE_RECLAMO_CARGA === `${T.FRASE_RECLAMO} ${T.MENSAJE_CARGA_A_LOGISTICA}`);
  }

  console.log('\n11. Guardia: no callar ante el primer saludo');
  {
    prueba('solo saluda: saludo, botón o mensaje de entrada de la plataforma', ['hola', 'Hola, ¿cómo estás?', 'buenas noches', 'Buenos días!!', 'hola buenas tardes una consulta', 'Comunicarme ahora', 'Hola soy parte del CLUB DE IMPORTADORES', 'Hola soy parte del CLUB DE IMPORTADORES y necesito comunicarme con mi asesor', 'necesito ayuda por favor'].every(esSoloSaludo));
    prueba('…y no lo es si dice qué necesita, agradece o confirma', !['hola, qué es el cbm', 'hola ya llegó mi carga?', 'ok gracias', 'gracias', 'listo', '', '??', 'hola necesito ayuda con mi cotización'].some(esSoloSaludo));
    const turno = (mensaje, id, tipo = 'text') => prepararTurno({ mensaje, telefono: TEL.sin_carga, tipo_mensaje: tipo, id_configuracion: 265, id_cliente: id, deps: { consultar: baseDeMentira().consultar, hoy: HOY, buscador: real } });
    olvidarTodo();
    let t = await turno('Hola, ¿cómo estás?', 's1');
    let x = revisarTurno('[espera]:true', t.hechos);
    prueba('primer saludo y el modelo calla: sale el saludo fijo', t.hechos.saludoSinContestar && x.cambiada && x.texto === T.MENSAJE_SALUDO && /callaba ante un saludo/.test(x.motivos.join(' ')));
    x = revisarTurno(T.MENSAJE_SALUDO, t.hechos);
    prueba('…si el modelo saludó bien, no se toca', !x.cambiada);
    t = await turno('hola?', 's1');
    x = revisarTurno('[espera]:true', t.hechos);
    prueba('vuelve a saludar a los pocos minutos: ya no es el primero y el silencio se respeta', !t.hechos.saludoSinContestar && !x.cambiada);
    olvidarTodo();
    t = await turno('ok gracias', 's2');
    x = revisarTurno('[espera]:true', t.hechos);
    prueba('un «ok gracias» sigue sin respuesta', !t.hechos.saludoSinContestar && !x.cambiada);
    olvidarTodo();
    t = await turno('', 's3', 'sticker');
    x = revisarTurno('[espera]:true', t.hechos);
    prueba('un sticker solo sigue sin respuesta', !t.hechos.saludoSinContestar && !x.cambiada);
    prueba('sin hechos del turno (emergencia) el silencio no se cambia', !revisarTurno('[espera]:true', null).cambiada);
  }

  console.log('\n12. Guardia: el aviso de «un asesor te escribe», una sola vez');
  {
    const r2 = (texto) => revisarRespuesta(texto, { respaldo: { firme: FIJOS, eco: '' }, textoSeguro: T.MENSAJE_ASESOR });
    let x = r2(`${T.MENSAJE_ROBOT} ${T.MENSAJE_ASESOR}`);
    prueba('texto del asistente automático + paso a asesor pegado: queda solo el primero', x.cambiada && x.corregida && x.texto === T.MENSAJE_ROBOT, x.texto);
    x = r2(`${T.MENSAJE_ASESOR} ${T.MENSAJE_CARGA_A_LOGISTICA}`);
    prueba('paso a asesor + paso a logística: queda uno', x.corregida && (x.texto.match(/apenas abramos/g) || []).length === 1);
    prueba('un solo aviso no se toca', !r2(T.MENSAJE_ASESOR).cambiada && !r2(T.MENSAJE_ROBOT).cambiada && !r2(T.MENSAJE_RECLAMO).cambiada && !r2(T.MENSAJE_SIN_CARGA).cambiada);
  }

  console.log('\n13. Prompt y textos: lo que es de redacción');
  {
    const p2 = promptSoporteExpertos();
    prueba('lista lo que no puede ofrecer (cotizar, revisar un pago, cambiar una clave, llamar, pedir fotos), afirmando o preguntando', /No ofreces hacer lo que no puedes hacer: cotizar, revisar o verificar un pago o una cuenta, cambiar o enviar una clave, llamar/.test(p2) && /ni preguntando \(«¿quieres que te pidamos más fotos\?»\)/.test(p2));
    prueba('un reclamo manda sobre un pago: no va a cobranza ni se pide el comprobante', /Un reclamo manda sobre todo lo demás, también sobre un pago: NO va a cobranza y NO se le pide el comprobante/.test(p2));
    prueba('«Entiendo tu preocupación.» solo ante un reclamo', /SOLO si el cliente reclama o está molesto, la primera frase es: «Entiendo tu preocupación\.»/.test(p2) && /En una consulta normal[^\n]*esa frase NO va/.test(p2));
    prueba('el saludo se calla solo si ya lo contestó el bot', /Callas con \[espera\]:true SOLO si ese saludo ya se lo contestaste TÚ/.test(p2) && /nadie que saluda se queda sin respuesta/.test(p2));
    prueba('el paso a asesor va una sola vez por mensaje', /Va UNA sola vez por mensaje/.test(p2));
    prueba('nombra el aviso ⚠️ que arma el código', p2.includes('🔒, ⚠️ o ℹ️'));
    prueba('trae los textos del reclamo tal cual', p2.includes(T.MENSAJE_RECLAMO) && p2.includes(T.MENSAJE_RECLAMO_CARGA));
    const sinRegla2 = p2.replace(/NUNCA voseo \([^)]*\)/, '');
    prueba('sin voseo ni «usted» en lo nuevo, y sin promesas de fecha en los textos', !/(?<!\p{L})(vos|ten[eé]s|pod[eé]s|quer[eé]s|decime|pasame|mandame|enviame|contame|avisame)(?!\p{L})/iu.test(sinRegla2) && [T.MENSAJE_RECLAMO, T.MENSAJE_RECLAMO_CARGA, T.CIERRE_ASESOR].every((v) => !/\b(hoy|mañana|lunes|martes|miércoles|jueves|viernes|pronto|en breve|usted)\b/i.test(v)));
    prueba(`el prompt sigue por debajo de la versión 1 (${p2.length} de 28.347)`, p2.length < 28347);
  }

  console.log('\n14. Rescate de importación: una ficha de carga, cotización o proveedor aunque el mensaje sea largo');
  {
    const r = (q) => buscarConRescate(real, q, { pais: 'ec' });
    const largo = 'quisiera ver la posibilidad de usar el servicio para la importación unos generadores electricos desde china';
    const x = r(largo);
    prueba(`un mensaje largo de importación encuentra ficha (${x.map((y) => y.ficha.id).join(', ') || 'ninguna'})`, x.length === 1 && x[0].rescate === true && ['carga', 'cotización', 'proveedor'].includes(x[0].ficha.tema));
    prueba('si el buscador normal ya encontró, el rescate no cambia nada', JSON.stringify(r('como cotizo un producto').map((y) => y.ficha.id)) === JSON.stringify(buscar('como cotizo un producto').map((y) => y.ficha.id)));
    prueba('un saludo o una cita no se rescatan', !r('Johan como te va buenas tardes').length && !r('Confirmado, nos reunimos a las 3pm').length);
    prueba('el rescate trae una sola ficha y nunca de otro tema', r(largo).length <= 1 && UMBRAL_RESCATE < UMBRAL_CERCANIA);
  }

  console.log('\n15. Herramientas de imporfactory.app: la prueba en vivo de Daniel (18-oct-2026)');
  {
    const r = (q) => buscarConRescate(real, q, { pais: 'ec' }).map((y) => y.ficha);
    const avion = r('Y SI VIENE EN AVION.?');
    prueba(`«Y SI VIENE EN AVION.?» trae la ficha de avión y ya no pasa a precios (${avion.map((f) => f.id).join(', ')})`, avion[0]?.id === 'avion-o-courier' && !avion[0].pasar_a && avion[0].pasos.some((x) => x.includes(T.LINKS.ideasProductos)));
    const prov = r('AUN NO TENGO PROVEEDOR.');
    prueba(`«AUN NO TENGO PROVEEDOR.» trae el directorio con su enlace (${prov.map((f) => f.id).join(', ')})`, prov[0]?.id === 'directorio-de-proveedores' && prov[0].pasos.some((x) => x.includes(T.LINKS.proveedores)));
    prueba('«qué herramientas tiene la plataforma» trae las 6 con su enlace', r('que herramientas tiene la plataforma')[0]?.id === 'herramientas-de-la-plataforma' && ['ideasProductos', 'proveedores', 'calculadora', 'seguimientoCarga', 'infoaduana', 'imporia'].every((k) => r('que herramientas tiene la plataforma')[0].pasos.some((x) => x.includes(T.LINKS[k]))));
    prueba('la calculadora ya contesta sola, con su enlace', r('donde esta la calculadora')[0]?.id === 'calculadora-de-costos' && !!r('donde esta la calculadora')[0].respuesta_base && r('donde esta la calculadora')[0].enlace === T.LINKS.calculadora);
    prueba('ninguna ficha apunta a una lección de la plataforma vieja', require('../src/utils/soporteExpertos/fichas_bot.json').every((f) => !/new\.imporsuitpro\.com\/curso\?/.test(`${f.enlace} ${f.respuesta_base} ${(f.pasos || []).join(' ')}`)));
    const p3 = promptSoporteExpertos();
    prueba('el prompt trae las herramientas con sus enlaces', ['ideasProductos', 'proveedores', 'calculadora', 'seguimientoCarga', 'infoaduana', 'imporia', 'checklist'].every((k) => p3.includes(T.LINKS[k])));
    prueba('«aún no tengo proveedor» tras el paso a asesor NO es «Recibido»', /«aún no tengo proveedor»[^\n]*NO es «Recibido»/.test(p3));
    prueba('la meta es resolver en la primera respuesta', /lo resuelva con tu PRIMERA respuesta/.test(p3));
  }

  console.log('\n16. Juicio a ciegas de 90 conversaciones (18-oct-2026): la guardia ya no tapa respuestas buenas');
  {
    const { datoSinRespaldo } = require('../src/utils/soporteExpertos/guardia');
    const firme = Object.values(T.LINKS).join(' ');
    const pasa = (t, eco = '') => datoSinRespaldo(t, firme, eco, '') === null;
    prueba('«estás en la parte 2… le pides 3 datos» no es una cifra inventada', pasa('Aún no tienes proveedor, así que estás en la parte 2. A cada uno le pides 3 datos.'));
    prueba('«las partes 1 y 2 del camino» tampoco', pasa('Como recién empiezas, vas en las partes 1 y 2 del camino.'));
    prueba('repetir «3 proveedores» que dijo el cliente pasa; «4 proveedores» no', pasa('Si con 3 proveedores va junto, lo confirma una persona.', 'tengo 3 proveedores distintos') && !pasa('Son 4 proveedores.', 'tengo 3 proveedores'));
    prueba('describir las etapas de Seguimiento de mi carga no afirma nada de SU carga', pasa('Ves en qué parte va tu pedido: en la bodega de China, en el barco, en aduana o ya en la bodega de destino.'));
    prueba('«tu carga ya está en aduana» sin dato sigue frenándose', !pasa('Tu carga ya está en aduana.'));
    prueba('«no te los puedo confirmar» no es un ofrecimiento; «puedo confirmarte» sí', ofreceLoQueNoPuede('Los días de tránsito no te los puedo confirmar por aquí.', '') === null && !!ofreceLoQueNoPuede('Puedo confirmarte la fecha.', ''));
    const r = (q) => buscarConRescate(real, q, { pais: 'ec' }).map((y) => y.ficha.id);
    prueba('«compro en alibaba o en yiwugo» trae el directorio', r('compro en alibaba o en yiwugo')[0] === 'directorio-de-proveedores');
    prueba('«esos precios ya incluyen todo?» trae que la herramienta es una referencia', r('esos precios ya incluyen todo?')[0] === 'precio-de-las-herramientas');
    prueba('«vi en ideas de productos… me interesa» trae cómo cotizarlo', r('vi en ideas de productos unas freidoras de aire, me interesa')[0] === 'me-interesa-producto-de-ideas');
  }

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
