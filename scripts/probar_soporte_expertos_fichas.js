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

const { crearBuscador, buscadorDeArchivo, bloqueFichas, UMBRAL_CERCANIA, MAX_FICHAS } = require('../src/utils/soporteExpertos/fichas');
const { revisarRespuesta, completarPase } = require('../src/utils/soporteExpertos/guardia');
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
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n7. Prompt: las fichas solo si responden EXACTAMENTE lo que se preguntó');
  const prompt = promptSoporteExpertos();
  prueba('nombra el bloque como «posiblemente relacionadas»', prompt.includes('📚 FICHAS DE LA BASE posiblemente relacionadas'));
  prueba('la regla C exige que responda EXACTAMENTE lo que preguntó: la misma pregunta, no el mismo tema', /La usas SOLO si responde EXACTAMENTE lo que preguntó: la misma pregunta, no el mismo tema/.test(prompt));
  prueba('…y si ninguna responde, es paso a asesor con el dato que falta', /Si NINGUNA responde exactamente, no las uses ni las menciones: es D\. El MENSAJE DE PASO A ASESOR y, si hace falta, el dato que falta/.test(prompt));
  prueba('…ante la duda, pasa', /Ante la duda entre contestar con una ficha y pasar, pasas/.test(prompt));
  prueba('dice que una ficha que pasa a una persona NUNCA va sola', /\(NO CIERRA SOLA\)/.test(prompt) && /Una ficha así NUNCA va sola/.test(prompt));
  prueba('la gestión que ya lleva con su asesor manda sobre cualquier ficha', /Sigue una gestión que ya lleva con su asesor[^\n]*Eso manda sobre cualquier ficha/.test(prompt));
  prueba('trae ejemplos de «habla del tema pero no contesta» (aviso y otra pregunta)', /Listo, ya instalé WeChat/.test(prompt) && /es el tema, no la pregunta/.test(prompt));
  prueba(`sigue cabiendo holgado y por debajo de la versión 1 (${prompt.length} caracteres)`, prompt.length < 28347);

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n8. Guardia: el código de un producto del catálogo no es un monto ni una fecha');
  {
    const TRES =
      'Hola, me interesa el producto SGTE-58 (Altavoz portátil) del catálogo de Ideas de Productos.\n' +
      'Hola, me interesa el producto HOG-112 (Lámpara de mesa) del catálogo de Ideas de Productos.\n' +
      'Hola, me interesa el producto BLZ7 (Bolso de viaje) del catálogo de Ideas de Productos.';
    const rev = (texto, eco = TRES) => revisarRespuesta(texto, { respaldo: { firme: FIJOS, eco }, textoSeguro: T.MENSAJE_ASESOR });
    let x = rev(`Hola. ${T.MENSAJE_ASESOR} Para que el área de precios te cotice SGTE-58, HOG-112 y BLZ7, dime cuántas unidades de cada uno piensas comprar.`);
    prueba('tres productos del catálogo: repetir sus tres códigos ya NO dispara la guardia (era el único reemplazo de la prueba, y falso)', !x.cambiada, x.motivos.join('; '));
    x = rev('Para cotizar el sgte 58 dime cuántas unidades piensas comprar. Un asesor te escribe apenas abramos.');
    prueba('…ni escrito en minúsculas', !rev('Para cotizar el sgte-58 dime cuántas unidades piensas comprar. Un asesor te escribe apenas abramos.').cambiada);
    prueba('…pero el código tiene que ir ENTERO: «sgte 58» suelto es una cifra', x.cambiada && /cifra «58»/.test(x.motivos.join(' ')));
    x = rev('Para cotizar el SGTE-59 dime cuántas unidades piensas comprar. Un asesor te escribe apenas abramos.');
    prueba('un código que el cliente NO escribió sigue frenado', x.cambiada && x.texto === T.MENSAJE_ASESOR && /cifra «59»/.test(x.motivos.join(' ')));
    x = rev('El SGTE-58 te sale en 58 dólares.');
    prueba('el número del código no respalda un monto («58 dólares»)', x.cambiada && /monto «58 dólares»/.test(x.motivos.join(' ')));
    x = rev('El SGTE-58 llega el 58.');
    prueba('…ni una fecha («el 58»)', x.cambiada && /plazo/.test(x.motivos.join(' ')));
    x = rev('El SGTE-58 llega en 58 días.');
    prueba('…ni un plazo («58 días»)', x.cambiada && /plazo «58 días»/.test(x.motivos.join(' ')));
    x = rev('Del SGTE-58 necesitas 58 como mínimo.');
    prueba('…ni la misma cifra suelta en otra parte de la respuesta', x.cambiada && /cifra «58»/.test(x.motivos.join(' ')));
    x = rev('Sí, son USD850.', 'te deposito USD850 y listo');
    prueba('letras pegadas a una moneda no son un código («USD850»)', x.cambiada);
    x = rev('Sí, el dia15.', 'me llega el dia15?');
    prueba('…ni pegadas a una fecha («dia15»)', x.cambiada);
    x = rev(`${T.MENSAJE_ASESOR} Dime cuántas unidades del SGTE-58 piensas comprar.`, 'Hola, me interesa el producto SGTE-58 (Altavoz portátil) del catálogo de Ideas de Productos.');
    prueba('con un solo producto también pasa', !x.cambiada);
    x = rev('Tu cotización 4521 y tu marca EC-2609112 quedan anotadas. Un asesor te escribe apenas abramos.', 'mi cotización es la 4521 y la marca EC-2609112');
    prueba('los códigos que ya se aceptaban (cotización, marca) siguen pasando', !x.cambiada, x.motivos.join('; '));
  }

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
