/* Pruebas de la objeción de precio del bot de Expertos («me sale muy caro»):
   señal (senales.objetaPrecio), pasos (objecionPrecio.js), turno, guardia y
   escalado a Johan. Sin red ni base. Las frases son reales de la 265 (29-sep
   al 27-oct), sin nombres ni números.
   Uso: node scripts/probar_soporte_expertos_objecion.js */

'use strict';

const path = require('path');
// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { objetaPrecio, esReclamo } = require('../src/utils/soporteExpertos/senales');
const O = require('../src/utils/soporteExpertos/objecionPrecio');
const { prepararTurno, revisarTurno, anotarCotizacion, olvidarTodo } = require('../src/utils/soporteExpertos/turno');
const { areaDelCaso, decidirEscalado, notaInterna, esPase, escalarCaso, EQUIPO, YA_NO_ESTAN } = require('../src/utils/soporteExpertos/escalado');
const { buscadorDeArchivo, crearBuscador, validarFichas, RUTA_FICHAS } = require('../src/utils/soporteExpertos/fichas');
const { fleteMexico } = require('../src/utils/soporteExpertos/cotizacionMexico');
const { textoAlHorario } = require('../src/utils/soporteExpertos/horario');
const T = require('../src/utils/soporteExpertos/textos');
const ajustes = require('../src/utils/ajustesIA');

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

const EC = '593987000111';
const MX = '5215512345678';

(async () => {
  console.log('\n— La señal: objeciones reales de la 265 —');
  const objeciones = [
    'aun esta muy caro',
    'Hay algún tipo de descuento o promoción o algo',
    'Crees que me pueda dar algún descuento o ese será el precio más bajo',
    'Que descuento me van ayudar',
    'pienso que la calculadora esta dando un precio muy alto al producto',
    'uy sale demasiado caro traer ese producto... en ese caso es mejor comprarlo aca',
    'si se puede pedir rebaja ?',
    'Oye porque me sale carísimo traerlo, más del 100% de lo k cuenta la mercancia',
    'Está muy caro el envío!!',
    'Está súper Caro traer de allá, aquí me sale más barato comprar aquí en Ecuador mismo',
    'ya me envió la nueva cotizacion mas cara por el incremento de precios',
    'Pero el envío sale carisimo. Ustedes pueden ayudarme con un envío más económico?',
    'Ayúdeme revisando para aplicar a algún descuento por que no me esta saliendo tan rentable',
    'esta super caro el flete',
    'ayùdame revisando mi cotizaciòn y el costo de flete si es demasiado alto o no?',
    'Puedes hacerme un descuento en el flete',
    'es muy alto el costo de traslado, me sale más barato comprarlas en México',
    'Revisé la cotización y me preocupa el incremento de los costos',
    '$122 me parece muy caro el envío',
    'si yo pago directamente me sale menos, ya que la diferencia que debo abonar si está alta',
    'Y sí hay algún descuento especial en el transporte a ecuador lo aceptaré con gusto',
    // Las del encargo
    'me sale muy caro',
    'está caro el flete',
    'en otro lado me cobran menos',
    'otra empresa me cotizo mas barato',
    'me igualan la tarifa?',
  ];
  const fallan = objeciones.filter((m) => !objetaPrecio(m));
  prueba(`las ${objeciones.length} objeciones reales se reconocen`, !fallan.length, fallan.join(' | '));

  const noSon = [
    // Precio de un proveedor, del mercado o de otra plataforma
    'Este es mi precio mínimo absoluto. La empresa fija los precios, pero actualmente ofrecemos un descuento',
    'O sabe de algun otro proveedor que tenga mejor precio?',
    'Encontre otro proveedor en alibaba que tiene un mejor precio',
    'Sigue estando muy caro a comparación de temu',
    'Como bajo el precio el chino me sale menos',
    // Meta, campañas, su tienda, lo que dicen SUS clientes
    'viendo los costos sobre todo de meta es muy caro tambien',
    'segun los mensajes dicen que esta muy caro',
    'el precio con la competencia está ligeramente arriba',
    '💸 ¡Descuento aplicado! hemos activado un descuento del 10%',
    // Preguntas, no reclamos
    'Y es muy caro traer las muestras?',
    'Cuán costoso sería?',
    'Dos o tres cartones de chompas resulta muy caro trer en avión?',
    'Y sale caro que me Lo Envíen De Colombia a México ?',
    'cuanto cuesta el flete a mexico?',
    // Otros
    'Déjame rebajar algo',
    'Quisiera entender como es el proceso de descuento automático',
    'Si veo que el arancel específico es bastante elevado',
    'Me va a tocar sacar las mesas por q no me alcanza',
    'pero con lo que tengo ya puedo buscar en otro lado',
    'Por otro lado, moldes de lavabos para manos',
    'Hola, quiero cotizar 500 unidades',
    '',
  ];
  const sobran = noSon.filter((m) => objetaPrecio(m));
  prueba(`los ${noSon.length} que no son contra nuestro precio no se marcan`, !sobran.length, sobran.join(' | '));

  console.log('\n— Los pasos (objecionPrecio.js) —');
  prueba('1.ª objeción → explicar', O.pasoDeObjecion({ previas: 0 }) === 'explicar');
  prueba('2.ª objeción → pasar', O.pasoDeObjecion({ previas: 1 }) === 'pasar');
  prueba('con enojo → pasar de una', O.pasoDeObjecion({ previas: 0, reclamo: true }) === 'pasar');

  const e149 = O.espacioYPaso(1.49);
  prueba('1,49 CBM (escala A): completar 2 CBM cuesta 280,5 USD más', e149?.tipo === 'paso' && e149.hasta === 2 && Math.abs(e149.extra - 280.5) < 0.01, JSON.stringify(e149));
  prueba('…y el flete coincide con la calculadora de México', e149.flete === fleteMexico(1.49) && e149.fleteHasta === fleteMexico(2));
  prueba('3,5 CBM: completar 4 cuesta 50 USD más', O.espacioYPaso(3.5)?.extra === 50);
  const c06 = O.espacioYPaso(0.6);
  prueba('bajo 1 CBM sin mínimo: sugiere completar 1 (le quedan 0,4)', c06?.tipo === 'completar' && c06.libre === 0.4, JSON.stringify(c06));
  prueba('…y aclara que si no, se prorratea (sin decir que es gratis)', /Lo ideal es completar 1 CBM: te quedan 0,4 CBM/.test(O.textoEspacio(c06)) && /se cobra solo por lo que ocupa/.test(O.textoEspacio(c06)) && !/sin pagar más/.test(O.textoEspacio(c06)));
  const r06 = O.respuestaExplicar({ pais: 'mx', cotizacion: { cbm: 0.6 } });
  prueba('México con 0,6 CBM: flete proporcional (450 USD) y la sugerencia', /0,6 CBM/.test(r06) && /450 USD/.test(r06) && /Lo ideal es completar 1 CBM/.test(r06), r06);
  prueba('desde 4 CBM: nada (400 USD por CBM parejo)', O.espacioYPaso(4) === null && O.espacioYPaso(7.2) === null);
  const libre = O.espacioYPaso(0.6, { minimo: 1 });
  prueba('con mínimo de 1 CBM: le quedan 0,4 CBM pagados', libre?.tipo === 'libre' && libre.libre === 0.4);
  prueba('…y el texto lo dice', /te quedan 0,4 CBM para sumar productos sin pagar más flete/.test(O.textoEspacio(libre)));
  prueba('sin CBM válido: nada', O.espacioYPaso(null) === null && O.espacioYPaso(-1) === null);

  const rMx = O.respuestaExplicar({ pais: 'mx', cotizacion: { cbm: 1.49 } });
  prueba('México con su cotización: CBM, flete con impuestos dentro y el paso a 2 CBM', /1,49 CBM/.test(rMx) && /1\.020 USD/.test(rMx) && /incluye los impuestos/.test(rMx) && /hasta completar 2 CBM, el flete sube solo 281 USD/.test(rMx), rMx);
  const rMxSin = O.respuestaExplicar({ pais: 'mx' });
  prueba('México sin cotización: desglose sin cifras', rMxSin.startsWith(T.OBJECION.desglose_mx) && !/\d/.test(rMxSin));
  const rEc = O.respuestaExplicar({ pais: 'ec', cotizacion: { cbm: 1.49 } });
  prueba('Ecuador: flete + impuestos aparte, sin calcular nada (cotiza a mano)', rEc.startsWith(T.OBJECION.desglose_ec) && !/USD/.test(rEc));
  prueba('siempre trae las alternativas (cantidad o carga grupal)', [rMx, rMxSin, rEc].every((r) => r.endsWith(T.OBJECION.alternativas)));
  const todos = [...Object.values(T.OBJECION), rMx, rEc].join('\n');
  prueba('ningún texto ofrece descuento ni promete bajar', !/descuento|rebaja|precio especial|te (?:bajo|dejo en)/i.test(todos));
  prueba('tuteo, sin voseo', !/\b(?:tenés|querés|podés|sumás|pagás|decís|vos)\b/i.test(todos));
  prueba('el paso al líder comercial cuenta como pase (y con «en breve»)', esPase(T.OBJECION.pase_comercial) && esPase(textoAlHorario(T.OBJECION.pase_comercial, true)));
  prueba('la explicación NO cuenta como pase', !esPase(rMx) && !esPase(rEc));
  const res = O.resumenObjecion({ pais: 'mx', cotizacion: { cbm: 1.49, flete: 1019.5, total: 2340 }, veces: 2 });
  prueba('resumen para Johan: vez, país, CBM, flete, total y «NO ofreció descuento»', /2\.ª vez/.test(res) && /México/.test(res) && /1,49 CBM/.test(res) && /1\.019,50 USD/.test(res) && /2\.340,00 USD/.test(res) && /NO ofreció descuento/.test(res), res);
  prueba('resumen sin cotización: lo dice', /no tiene la cotización a la mano/.test(O.resumenObjecion({ pais: 'ec' })));

  console.log('\n— La ficha borrador —');
  const crudo = require(RUTA_FICHAS);
  const ficha = crudo.find((f) => f.id === 'objecion-de-precio');
  prueba('la ficha objecion-de-precio existe, es borrador y pasa al líder comercial', ficha && ficha.borrador === true && ficha.pasar_a === 'líder comercial');
  prueba('el archivo de fichas sigue válido', validarFichas(crudo).errores.filter((e) => /falta|repetido/.test(e)).length === 0);
  const buscador = buscadorDeArchivo();
  const enBusqueda = buscador.buscar('me sale muy caro el flete').map((r) => r.ficha.id);
  prueba('el buscador NO la usa mientras sea borrador', !enBusqueda.includes('objecion-de-precio'), enBusqueda.join(','));
  const sinBorrador = crearBuscador([{ ...ficha, borrador: false }]).buscar('me sale muy caro');
  prueba('…y sin «borrador» sí la encuentra', sinBorrador.some((r) => r.ficha.id === 'objecion-de-precio'));

  console.log('\n— El turno —');
  const turno = (mensaje, tel, opciones, extra = {}) =>
    prepararTurno({
      mensaje,
      telefono: tel,
      tipo_mensaje: 'text',
      id_configuracion: 265,
      id_cliente: extra.id_cliente || tel,
      opciones: { cargas: false, ...opciones },
      deps: { buscador, ahora: extra.ahora },
    });

  // Con el interruptor de textos apagado: nada cambia.
  olvidarTodo();
  T.OBJECION_APROBADO = false;
  let t = await turno('me salio muy caro el envio', EC, { objecion_precio: true });
  prueba('textos sin aprobar: no hay flujo aunque la cuenta lo pida', t.hechos.objecionPrecio === null && !/OBJECIÓN DE PRECIO/.test(t.bloque) && t.hechos.textoSeguro === T.MENSAJE_ASESOR);
  prueba('…y las fichas de siempre siguen ahí', t.hechos.fichas.includes('envio-caro-descuento'), t.hechos.fichas.join(','));
  T.OBJECION_APROBADO = true;
  olvidarTodo();
  t = await turno('está muy caro el flete', EC, {});
  prueba('textos aprobados pero cuenta sin objecion_precio: tampoco', t.hechos.objecionPrecio === null && !/OBJECIÓN DE PRECIO/.test(t.bloque));

  // Encendido.
  olvidarTodo();
  t = await turno('me salio muy caro el envio', EC, { objecion_precio: true });
  prueba('1.ª objeción (EC): explicar, con el bloque 💰 y «Responde exactamente»', t.hechos.objecionPrecio === 'explicar' && /💰 OBJECIÓN DE PRECIO/.test(t.bloque) && /Responde exactamente: Te explico/.test(t.bloque));
  prueba('…el texto seguro es la explicación de Ecuador', t.hechos.textoSeguro.startsWith(T.OBJECION.desglose_ec));
  prueba('…las fichas que pasan a pricing no se muestran', !t.hechos.fichas.some((id) => O.FICHAS_OBJECION.includes(id)), t.hechos.fichas.join(','));
  prueba('…y no hay paso a asesor que la guardia agregue', !t.hechos.fichasConPase.some((f) => O.FICHAS_OBJECION.includes(f.id)));
  let rev = revisarTurno(t.hechos.textoSeguro, t.hechos);
  prueba('la guardia deja pasar la explicación tal cual', !rev.cambiada && rev.texto === t.hechos.textoSeguro, JSON.stringify(rev.motivos));
  rev = revisarTurno('Entiendo, te puedo hacer un descuento en el flete.', t.hechos);
  prueba('si el modelo ofrece descuento, la guardia lo cambia por la explicación', rev.cambiada && rev.texto === t.hechos.textoSeguro && rev.motivos.some((m) => /rebaja/.test(m)), JSON.stringify(rev));
  rev = revisarTurno('Déjame ver si te bajamos el precio.', t.hechos);
  prueba('…y si insinúa que lo baja, también', rev.cambiada);

  t = await turno('igual sigue muy caro, en otro lado me cobran menos', EC, { objecion_precio: true });
  prueba('2.ª objeción en la misma conversación: pasar al líder comercial', t.hechos.objecionPrecio === 'pasar' && /insiste/.test(t.bloque) && t.hechos.textoSeguro === T.OBJECION.pase_comercial);
  prueba('…con el resumen para la nota', /2\.ª vez/.test(t.hechos.resumenObjecion) && /Ecuador/.test(t.hechos.resumenObjecion));

  // Pasados los 20 minutos se cuenta de nuevo.
  olvidarTodo();
  const t0 = Date.parse('2026-10-27T15:00:00Z');
  await turno('me sale muy caro', EC, { objecion_precio: true }, { ahora: t0 });
  t = await turno('me sale muy caro', EC, { objecion_precio: true }, { ahora: t0 + 25 * 60 * 1000 });
  prueba('otra objeción 25 min después: vuelve a explicar', t.hechos.objecionPrecio === 'explicar');

  // Con enojo: pasa directo y el texto es el del reclamo.
  olvidarTodo();
  const enojado = 'es una estafa, súper caro el flete y nadie me responde';
  t = await turno(enojado, EC, { objecion_precio: true });
  prueba('reclamo + objeción: pasa directo y responde con el texto del reclamo', esReclamo(enojado) && t.hechos.reclamo && t.hechos.objecionPrecio === 'pasar' && t.hechos.textoSeguro === T.MENSAJE_RECLAMO, JSON.stringify({ r: t.hechos.reclamo, o: t.hechos.objecionPrecio, s: t.hechos.textoSeguro }));

  // México con la cotización que armó el bot en esta conversación.
  olvidarTodo();
  t = await turno('quiero cotizar 300 lámparas a México', MX, { objecion_precio: true });
  prueba('anotar la cotización armada en la conversación', anotarCotizacion(t.hechos.clave, { cbm: 1.49, flete: 1019.5, total: 2340 }));
  t = await turno('uy me sale demasiado caro', MX, { objecion_precio: true });
  prueba('1.ª objeción (MX): explica con su CBM y el paso a 2 CBM', t.hechos.objecionPrecio === 'explicar' && /1,49 CBM/.test(t.hechos.textoSeguro) && /281 USD/.test(t.hechos.textoSeguro), t.hechos.textoSeguro);
  rev = revisarTurno(t.hechos.textoSeguro, t.hechos);
  prueba('…y la guardia acepta sus cifras', !rev.cambiada, JSON.stringify(rev.motivos));
  t = await turno('no, igual está muy caro', MX, { objecion_precio: true });
  prueba('2.ª (MX): pasa con el resumen de la cotización', t.hechos.objecionPrecio === 'pasar' && /1,49 CBM/.test(t.hechos.resumenObjecion) && /2\.340,00 USD/.test(t.hechos.resumenObjecion));
  prueba('anotar sin conversación en memoria: no hace nada', anotarCotizacion('265:nadie', { cbm: 1 }) === false && anotarCotizacion(null, { cbm: 1 }) === false);

  // Lo que no es objeción sigue igual.
  olvidarTodo();
  t = await turno('cuanto cuesta el flete a mexico?', MX, { objecion_precio: true });
  prueba('pregunta de precio sin objeción: sin flujo', t.hechos.objecionPrecio === null && !/OBJECIÓN DE PRECIO/.test(t.bloque));

  console.log('\n— A quién va (escalado.js) —');
  prueba('área objecion_precio cuando insiste', areaDelCaso({ hechos: { objecionPrecio: 'pasar' }, mensaje: 'sigue caro el flete' }) === 'objecion_precio');
  prueba('…aunque también sea reclamo', areaDelCaso({ hechos: { objecionPrecio: 'pasar', reclamo: true } }) === 'objecion_precio');
  prueba('el reembolso va primero', areaDelCaso({ hechos: { objecionPrecio: 'pasar' }, mensaje: 'quiero que me devuelvan mi dinero' }) === 'reembolso');
  prueba('la 1.ª objeción no es área (no hay pase)', areaDelCaso({ hechos: { objecionPrecio: 'explicar' }, mensaje: 'me sale caro el flete' }) === 'cotizacion');
  const d1 = decidirEscalado({ hechos: { objecionPrecio: 'pasar' }, telefono: EC });
  prueba('destino: Johan (377), líder comercial', d1.destino.id === EQUIPO.casos.id && d1.destino.id === 377 && d1.asignar);
  prueba('nunca Ángel ni David', !YA_NO_ESTAN.includes(d1.destino.id));
  const d2 = decidirEscalado({ hechos: { objecionPrecio: 'pasar' }, telefono: MX, encargado: { id: 2179, activo: true } });
  prueba('chat de Ángel: se reasigna a Johan', d2.asignar && d2.destino.id === 377);
  const nota = notaInterna(d1, 'igual sigue muy caro', { resumen: O.resumenObjecion({ pais: 'ec', veces: 2 }) });
  prueba('nota: «objeción de precio» + resumen, sin «datos que juntó»', /pasó este chat a Johan \(objeción de precio\)/.test(nota) && /💰 Objeción de precio \(2\.ª vez/.test(nota) && !/Datos que juntó/.test(nota), nota);

  // escalarCaso con base de mentira
  function base(chat) {
    const escrito = { updates: [], historial: [], notas: [] };
    return {
      escrito,
      deps: {
        consultar: async (sql, rep) => {
          if (/^\s*select/i.test(sql)) return /clientes_chat_center/.test(sql) && chat ? [chat] : [];
          escrito.updates.push({ sql, rep });
          return [];
        },
        crearHistorial: async (h) => escrito.historial.push(h),
        crearNota: async (n) => escrito.notas.push(n),
      },
    };
  }
  const hechos = { objecionPrecio: 'pasar', resumenObjecion: O.resumenObjecion({ pais: 'ec', veces: 2 }) };
  let b = base({ id: 20, id_encargado: null, suspendido: null });
  let r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 20, telefono: EC, mensaje: 'sigue caro', hechos, deps: b.deps });
  prueba('real, chat sin encargado: lo asigna a Johan y deja la nota', r.aplicado && b.escrito.updates[0]?.rep[0] === 377 && /objeción de precio/.test(b.escrito.notas[0] || ''), JSON.stringify(b.escrito));
  b = base({ id: 21, id_encargado: 378, suspendido: 0 });
  r = await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 21, telefono: EC, mensaje: 'sigue caro', hechos, deps: b.deps });
  prueba('real, chat de Belén: no se lo quita, pero la nota va igual', !b.escrito.updates.length && b.escrito.notas.length === 1 && /💰 Objeción de precio/.test(b.escrito.notas[0]), JSON.stringify(b.escrito));
  b = base({ id: 21, id_encargado: 378, suspendido: 0 });
  r = await escalarCaso({ modo: 'simulado', id_configuracion: 265, id_cliente: 21, telefono: EC, mensaje: 'sigue caro', hechos, deps: b.deps });
  prueba('simulado: no escribe nada', !b.escrito.updates.length && !b.escrito.notas.length && r.area === 'objecion_precio');

  console.log('\n— Ajustes —');
  const na = (v) => ajustes.normalizar({ soporte_expertos: v }).soporte_expertos;
  prueba('objecion_precio apagado por defecto', na(true).objecion_precio === false && na({}).objecion_precio === false);
  prueba('se enciende solo con true explícito', na({ objecion_precio: true }).objecion_precio === true && na({ objecion_precio: 'si' }).objecion_precio === false);
  prueba('los textos quedan aprobados en el archivo (Daniel, 27-oct)', require('fs').readFileSync(require.resolve('../src/utils/soporteExpertos/textos'), 'utf8').includes('const OBJECION_APROBADO = true;'));
  prueba('la nota para Johan dice que solo Daniel autoriza un descuento', /no se rebaja; ofrécele alternativas\. Un descuento solo lo autoriza Daniel\./.test(O.resumenObjecion({ pais: 'ec', veces: 2 })));

  console.log(`\n${ok} OK · ${fallos} FALLAS\n`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
