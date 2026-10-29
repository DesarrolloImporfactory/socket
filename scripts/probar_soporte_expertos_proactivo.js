/* Pruebas del bot proactivo (tramo 5, soporteExpertos/proactivo.js): T1-T8,
   el «por qué» de cada pase en la nota interna, la hora prometida y el aviso
   de pases sin respuesta. Sin red ni base.
   Uso: node scripts/probar_soporte_expertos_proactivo.js */

'use strict';

const path = require('path');
const fs = require('fs');
// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const P = require('../src/utils/soporteExpertos/proactivo');
const E = require('../src/utils/soporteExpertos/escalado');
const H = require('../src/utils/soporteExpertos/horario');
const A = require('../src/utils/soporteExpertos/avisoPases');
const T = require('../src/utils/soporteExpertos/textos');
const { decidirSeguimiento } = require('../src/utils/soporteExpertos/seguimiento');
const { normalizar } = require('../src/utils/ajustesIA');

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

// Hora de Ecuador → ms. El 27-oct-2026 es martes.
const ec = (dia, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 9, dia, h + 5, m);
};
const HORARIO = { dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '17:00', utc: -5 };
let nId = 1;
const cli = (t, tx, tm = 'text') => ({ id: nId++, rol: 0, resp: null, t, tx, tm });
const bot = (t, tx) => ({ id: nId++, rol: 1, resp: 'IA_Soporte', t, tx, tm: 'text' });
const persona = (t, tx, resp = 'Johan') => ({ id: nId++, rol: 1, resp, t, tx, tm: 'text' });
const nota = (t, tx) => ({ id: nId++, rol: 3, resp: 'IA_Escalado Expertos', t, tx, tm: 'notificacion' });
const QUIEN_JOHAN = async () => ({ decision: { area: 'otro', asignar: true, destino: E.EQUIPO.casos }, nombre: 'Johan', areaPersona: 'otro' });
const quien = (area, nombre, areaPersona = area) => async () => ({ decision: { area, asignar: true }, nombre, areaPersona });
const ACUSE = T.MENSAJE_ASESOR;

(async () => {
  console.log('\n1. Textos aprobados y banderas');
  prueba('PROACTIVO_APROBADO y SEGUIMIENTO_APROBADO en true (Daniel, 27-oct)', T.PROACTIVO_APROBADO === true && T.SEGUIMIENTO_APROBADO === true);
  prueba(
    'T1 tal como lo aprobó Daniel',
    T.PROACTIVO.pide_garantia === 'Para que {nombre} lo resuelva sin volver a preguntarte, mándame: el número de orden de Dropi, una foto o video del producto y qué falla.',
  );
  prueba('T6 tal como lo aprobó Daniel', T.PROACTIVO.pase === 'Lo pasé a {nombre}, {de_area}. Te escribe por este chat {cuando}.');
  prueba('T8 tal como lo aprobó Daniel', T.PROACTIVO.sigue_con.startsWith('Tu caso sigue con {nombre} desde {desde}. Ya le avisé que volviste a escribir.'));
  const todos = Object.values(T.PROACTIVO).join(' ');
  prueba('ningún texto tiene voseo', !/\b(?:tenés|podés|querés|mandás|escribís|sabés|contame|decime|mandame|avisame)\b/i.test(todos));
  prueba('no están en los textos fijos de la guardia', Object.values(T.PROACTIVO).every((v) => !Object.values(T.TEXTOS_FIJOS).includes(v)));
  const n = (v) => normalizar({ soporte_expertos: v }).soporte_expertos;
  prueba('sin pedido explícito, apagado', n(true).proactivo === false && n({ escalar: 'real' }).proactivo === false);
  prueba('solo con escalar «real»: con «simulado» no se nombra a nadie', n({ escalar: 'simulado', proactivo: true }).proactivo === false);
  prueba('escalar «real» + proactivo: true → encendido', n({ escalar: 'real', proactivo: true }).proactivo === true);

  console.log('\n2. Hora que se promete (T6/T7)');
  prueba('martes 10:00 → «hoy hasta las 17:00»', H.cuandoTeEscribe(ec(27, '10:00'), HORARIO) === 'hoy hasta las 17:00');
  prueba('martes 16:45 (menos de 30 min) → «mañana desde las 8:00»', H.cuandoTeEscribe(ec(27, '16:45'), HORARIO) === 'mañana desde las 8:00');
  prueba('viernes 16:45 → «el lunes desde las 8:00»', H.cuandoTeEscribe(ec(30, '16:45'), HORARIO) === 'el lunes desde las 8:00');
  prueba('martes 20:00 → «mañana desde las 8:00»', H.cuandoTeEscribe(ec(27, '20:00'), HORARIO) === 'mañana desde las 8:00');
  prueba('lunes 06:00 → «hoy desde las 8:00»', H.cuandoTeEscribe(ec(26, '06:00'), HORARIO) === 'hoy desde las 8:00');
  prueba('ecommerce sábado 10:00 → «hoy hasta las 12:00»', H.cuandoTeEscribe(ec(31, '10:00'), H.HORARIO_ECOMMERCE) === 'hoy hasta las 12:00');

  console.log('\n3. Frases del pase');
  prueba('«Si necesitas algo más, un asesor te escribe» no es un pase real', !P.esPaseReal('Te dejo el enlace. Si necesitas algo más, un asesor te escribe en breve.'));
  prueba('«Un asesor lo revisa y te escribe» sí', P.esPaseReal(ACUSE));
  prueba(
    'cambiarPase deja lo útil y cambia solo la oración del pase',
    P.cambiarPase('Tu cuota es de 180,08 USD hasta el 25-nov. Un asesor lo revisa y te escribe en breve.', 'X.') === 'Tu cuota es de 180,08 USD hasta el 25-nov. X.',
  );
  prueba('un enlace con puntos no se parte', P.quitarPase('Entra a https://imporfactory.app/cursos/30 y mira la clase. Un asesor te escribe en breve.') === 'Entra a https://imporfactory.app/cursos/30 y mira la clase.');
  prueba('T6 y T7 cuentan como pase (el escalado y el seguimiento los ven)', E.esPase('Lo pasé a Viviana, de logística. Te escribe por este chat hoy hasta las 17:00.') && E.esPase('Esto lo atiende Johan directamente. Ya tiene tu caso con lo que me contaste y te escribe hoy hasta las 17:00.'));
  prueba('T1 a T5 y T8 NO son pase', ['pide_garantia', 'pide_comprobante', 'pide_guia', 'datos_factura', 'cuentas_cotizacion', 'sigue_con'].every((k) => !E.esPase(T.PROACTIVO[k])));

  console.log('\n4. P3: al pasar, quién y para cuándo');
  {
    const ahora = ec(27, '10:00');
    const r = await P.decidirProactivo({ texto: ACUSE, mensaje: 'mi carga no llega, necesito saber dónde está', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: quien('logistica', 'Viviana') });
    prueba('logística → «Lo pasé a Viviana, de logística. Te escribe por este chat hoy hasta las 17:00.»', r && r.texto === 'Recibí tu mensaje. Lo pasé a Viviana, de logística. Te escribe por este chat hoy hasta las 17:00.', r && r.texto);
    prueba('se escala como siempre y la nota va aunque el chat siga con su encargado', r.escalar === 'normal' && r.notaSiempre === true);
    const r2 = await P.decidirProactivo({ texto: ACUSE, mensaje: 'quiero que me devuelvan mi dinero', hechos: {}, mensajes: [], ahora: ec(27, '20:00'), horario: HORARIO, quien: quien('reembolso', 'Johan', 'reembolso') });
    prueba('reembolso → T7 «Esto lo atiende Johan directamente… mañana desde las 8:00»', r2.texto === 'Recibí tu mensaje. Esto lo atiende Johan directamente. Ya tiene tu caso con lo que me contaste y te escribe mañana desde las 8:00.', r2.texto);
    const r3 = await P.decidirProactivo({ texto: ACUSE, mensaje: 'tengo una duda', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: quien('otro', 'Carla', null) });
    prueba('persona fuera del equipo → T6 sin área', r3.texto.endsWith('Lo pasé a Carla. Te escribe por este chat hoy hasta las 17:00.'), r3.texto);
    const r4 = await P.decidirProactivo({ texto: ACUSE, mensaje: 'tengo una duda', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: async () => null });
    prueba('sin saber quién lo tiene → la respuesta sale como estaba', r4 === null);
    const r5 = await P.decidirProactivo({ texto: ACUSE, mensaje: 'tengo una duda', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: async () => { throw new Error('base caída'); } });
    prueba('si falla la lectura de quién lo tiene → sale como estaba', r5 === null);
    const r6 = await P.decidirProactivo({ texto: 'Tu carga está en el contenedor MSKU1234567.', mensaje: 'dónde está mi carga', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('una respuesta que no es pase ni acuse no se toca', r6 === null);
  }

  console.log('\n5. P2: no pasar lo que ya se resolvió');
  {
    const ahora = ec(27, '10:00');
    const larga = 'Tus cuotas: te queda una de 180,08 USD que vence el 25-nov. Puedes pagarla en las cuentas de tu cotización y mandar el comprobante por aquí.';
    const texto = `${larga} Un asesor lo revisa y te escribe en breve.`;
    const r = await P.decidirProactivo({ texto, mensaje: '¿cuánto me falta pagar?', hechos: {}, resolvio: true, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('188597: cuotas con la herramienta → se quita el pase y no se escala', r.accion === 'P2' && r.texto === larga && r.escalar === 'no', JSON.stringify(r));
    const conReclamo = await P.decidirProactivo({ texto, mensaje: '¿cuánto me falta pagar?', hechos: { reclamo: true }, resolvio: true, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('con reclamo sí se pasa', conReclamo.accion === 'P3');
    const conPersona = await P.decidirProactivo({ texto, mensaje: 'quiero hablar con una persona', hechos: {}, resolvio: true, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('si pide una persona sí se pasa', conPersona.accion === 'P3');
    const conMotivo = await P.decidirProactivo({ texto, mensaje: 'ya pagué', motivo: 'pago', hechos: { adjuntos: [{ tipo: 'imagen', clase: 'comprobante_pago' }] }, resolvio: true, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('si la IA usó pasar_a_humano sí se pasa', conMotivo.accion === 'P3');
    const fichaConPase = await P.decidirProactivo({ texto, mensaje: 'x', hechos: { fichas: ['f1'], fichasConPase: ['f1'] }, resolvio: true, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('ficha que pasa a una persona → se pasa', fichaConPase.accion === 'P3');
    const corta = await P.decidirProactivo({ texto: `Listo. ${T.CIERRE_ASESOR}`, mensaje: 'x', hechos: {}, resolvio: true, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('si lo que queda es muy corto → se pasa', corta.accion === 'P3');
    const fijo = await P.decidirProactivo({ texto: T.MENSAJE_SIN_CARGA, mensaje: 'mi carga', hechos: {}, resolvio: true, mensajes: [], ahora, horario: HORARIO, quien: quien('logistica', 'Viviana') });
    prueba('texto fijo de una herramienta que no encontró nada → se pasa', fijo && fijo.accion === 'P3', fijo && fijo.accion);
    const cond = await P.decidirProactivo({ texto: 'Te dejo el enlace de la clase. Si necesitas algo más, un asesor te escribe en breve.', mensaje: 'x', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('pase condicional → no se escala y el texto no cambia', cond.accion === 'P2' && cond.escalar === 'no' && cond.texto.startsWith('Te dejo'));
  }

  console.log('\n6. T4 y T5: confirmar en vez de pasar');
  {
    const ahora = ec(27, '10:00');
    const pedido = [persona(ec(27, '09:00'), 'Por favor envíame tus datos para la factura.')];
    const datos = 'Nombre: Ana Pérez\nCédula: 1712345678\nCiudad: Quito\nCorreo: ana@correo.com';
    const r = await P.decidirProactivo({ texto: ACUSE, mensaje: datos, hechos: {}, mensajes: pedido, ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba(
      '240423: datos de factura → T4 con nombre, últimos 4 y ciudad',
      r.accion === 'T4' && r.texto === 'Recibí tus datos para la factura: Ana Pérez, cédula/RUC terminado en 5678, Quito. Quedan en tu caso para emitirla después de nacionalizar; no hace falta que los mandes otra vez.',
      r.texto,
    );
    prueba('T4 se pasa en silencio al área de factura con los datos en la nota', r.escalar === 'forzar' && r.hechosExtra.areaForzada === 'factura' && r.resumen.includes('Cédula: 1712345678'));
    const sinFactura = await P.decidirProactivo({ texto: ACUSE, mensaje: datos, hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('los mismos datos sin que nadie hable de factura (puede ser una entrega) → no es T4', sinFactura.accion !== 'T4');
    prueba('sin cédula de 10 o 13 dígitos → no es T4', !P.datosFactura({ mensaje: 'Nombre: Ana\nCédula: 123\nCiudad: Quito\nfactura', mensajes: [], ahora }));
    const cot = [persona(ec(27, '08:00'), 'Te comparto la cotización #4521 con el detalle.', 'Belén')];
    const r5 = await P.decidirProactivo({ texto: ACUSE, mensaje: '¿El pago es a las cuentas de la cotización?', hechos: {}, mensajes: cot, ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('188597: «¿a las cuentas de la cotización?» → T5 con el número', r5.accion === 'T5' && r5.texto === 'Sí, a las cuentas que están en tu cotización #4521. Cuando pagues, mándame el comprobante por aquí y lo registro.' && r5.escalar === 'no', r5.texto);
    const sinNum = await P.decidirProactivo({ texto: ACUSE, mensaje: '¿El pago es a las cuentas de la cotización?', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('sin número de cotización en 3 días → no inventa: sigue al pase', sinNum.accion === 'P3');
  }

  console.log('\n7. P1: pedir el dato que falta (una vez)');
  {
    const ahora = ec(27, '10:00');
    const r = await P.decidirProactivo({ texto: ACUSE, mensaje: 'Necesito la garantía de este pedido de Dropi 3456789\n[IMAGEN: producto] una licuadora', hechos: { adjuntos: [{ tipo: 'imagen', clase: 'producto' }] }, mensajes: [], ahora, horario: HORARIO, quien: quien('ecommerce', 'Juan Felipe') });
    prueba('238774: garantía con orden y foto pero sin la falla → T1', r.accion === 'P1' && r.texto.endsWith(T.PROACTIVO.pide_garantia.replace('{nombre}', 'Juan Felipe')) && r.escalar === 'no', r.texto);
    const completo = P.datoQueFalta({ mensaje: 'garantía del pedido 3456789, llegó roto [IMAGEN: producto]', hechos: { esEcommerce: true, adjuntos: [{ tipo: 'imagen' }] }, mensajes: [], ahora });
    prueba('con orden, foto y la falla → no se pide nada', completo === null);
    const yaPedido = [cli(ec(27, '09:00'), 'garantía del pedido de dropi'), bot(ec(27, '09:01'), T.PROACTIVO.pide_garantia.replace('{nombre}', 'Beto'))];
    const r2 = await P.decidirProactivo({ texto: ACUSE, mensaje: 'garantía del pedido de dropi', hechos: {}, mensajes: yaPedido, ahora, horario: HORARIO, quien: quien('ecommerce', 'Beto') });
    prueba('si ya se le pidió en 24 h → no se pide otra vez: se pasa con lo que haya', r2.accion === 'P3', r2.accion);
    prueba('«ya pagué» sin comprobante → T2', P.datoQueFalta({ mensaje: 'ya pagué la cuota', hechos: {}, mensajes: [], ahora }) === 'pide_comprobante');
    prueba('«ya pagué» con la foto → nada', P.datoQueFalta({ mensaje: 'ya pagué la cuota', hechos: { adjuntos: [{ tipo: 'imagen', clase: 'comprobante_pago' }] }, mensajes: [], ahora }) === null);
    prueba('«no le ha llegado el pedido a mi cliente» sin guía → T3', P.datoQueFalta({ mensaje: 'no le ha llegado el pedido a mi cliente', hechos: {}, mensajes: [], ahora }) === 'pide_guia');
    prueba('con el número de guía → nada', P.datoQueFalta({ mensaje: 'no le ha llegado el pedido 8812345 a mi cliente', hechos: {}, mensajes: [], ahora }) === null);
    prueba('«no llega mi carga» es importación, no T3', P.datoQueFalta({ mensaje: 'no me llega la carga de china', hechos: {}, mensajes: [], ahora }) === null);
    const r3 = await P.decidirProactivo({ texto: ACUSE, mensaje: 'no le ha llegado el pedido a mi cliente', hechos: {}, mensajes: [], ahora, horario: HORARIO, quien: quien('ecommerce', 'Beto') });
    prueba('T3 con el nombre: «…y lo reviso con Beto.»', r3.texto.endsWith('Mándame el número de guía o de orden y la ciudad de entrega, y lo reviso con Beto.'), r3.texto);
  }

  console.log('\n8. P4: el cliente vuelve a escribir y nadie le contestó');
  {
    const ahora = ec(27, '11:30');
    const msgs = [
      cli(ec(27, '10:14'), 'necesito saber de mi pago'),
      bot(ec(27, '10:15'), 'Recibí tu mensaje. Lo pasé a Johan, de pagos. Te escribe por este chat hoy hasta las 17:00.'),
      nota(ec(27, '10:15'), '🤖 El bot pasó este chat a Johan'),
      cli(ec(27, '11:29'), '??'),
    ];
    const r = await P.decidirProactivo({ texto: T.MENSAJE_RECIBIDO, mensaje: '??', hechos: {}, mensajes: msgs, ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('no se vuelve a pasar', r.accion === 'P4' && r.escalar === 'no');
    prueba('T8: «Tu caso sigue con Johan desde las 10:15…»', r.texto === 'Tu caso sigue con Johan desde las 10:15. Ya le avisé que volviste a escribir. Si hay algo nuevo, cuéntame y lo sumo.', r.texto);
    prueba('nota 🔔 para la persona: «2.ª vez… desde las 10:15»', r.nota === '🔔 El cliente volvió a escribir (2.ª vez) y nadie le responde desde las 10:15.', r.nota);
    const conT8 = [...msgs, bot(ec(27, '11:30'), r.texto), cli(ec(27, '12:10'), 'hola?')];
    const r2 = await P.decidirProactivo({ texto: T.MENSAJE_RECIBIDO, mensaje: 'hola?', hechos: {}, mensajes: conT8, ahora: ec(27, '12:11'), horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('3.ª vez: T8 no se repite (silencio) y la nota dice 3.ª', r2.texto === '' && r2.nota.includes('(3.ª vez)'), JSON.stringify(r2));
    const conRespuesta = [...msgs.slice(0, 3), persona(ec(27, '10:40'), 'Hola, ya reviso tu pago.'), cli(ec(27, '11:29'), '??')];
    const r3 = await P.decidirProactivo({ texto: T.MENSAJE_RECIBIDO, mensaje: '??', hechos: {}, mensajes: conRespuesta, ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('si una persona ya le contestó → no es P4 (pase nuevo)', r3.accion === 'P3');
    const viejo = [cli(ec(25, '10:00'), 'x'), bot(ec(25, '10:01'), ACUSE)];
    const r4 = await P.decidirProactivo({ texto: ACUSE, mensaje: 'x', hechos: {}, mensajes: viejo, ahora, horario: HORARIO, quien: QUIEN_JOHAN });
    prueba('pase de hace más de 24 h → se pasa otra vez', r4.accion === 'P3');
    prueba('«ayer a las 16:30» cuando el pase fue ayer', P.formatoDesde(ec(26, '16:30'), ec(27, '09:00')) === 'ayer a las 16:30');
    const conNueva = await P.decidirProactivo({
      texto: `Tu cuota de noviembre es de 180,08 USD y vence el 25-nov, la puedes pagar en las mismas cuentas de siempre. ${T.CIERRE_ASESOR}`,
      mensaje: '¿y la de noviembre?',
      hechos: {},
      mensajes: msgs,
      ahora,
      horario: HORARIO,
      quien: QUIEN_JOHAN,
    });
    prueba('si contestó algo útil, eso sale y después T8', conNueva.texto.startsWith('Tu cuota de noviembre') && conNueva.texto.includes('Tu caso sigue con Johan'), conNueva.texto);
  }

  console.log('\n9. El «por qué» de cada pase en la nota interna (Daniel, 27-oct)');
  {
    const pq = (area, extra = {}) => E.porQueEscala({ area, ...extra });
    prueba('reembolso', pq('reembolso') === 'pide reembolso, baja o pausa del servicio');
    prueba('comprobante', pq('pago', { hechos: { adjuntos: [{ clase: 'comprobante_pago' }] } }) === 'mandó un comprobante de pago para verificar');
    prueba('pide persona', pq('otro', { mensaje: 'quiero hablar con una persona' }) === 'pidió hablar con una persona');
    prueba('reclamo por demora', pq('reclamo', { hechos: { reclamo: true, reclamoPorDemora: true } }) === 'reclama por la demora');
    prueba('herramienta', pq('cotizacion', { motivo: 'cotizacion' }) === 'la IA lo pasó con su herramienta para cotizar');
    prueba('cotización con datos', pq('cotizacion', { resumen: '2 CBM, Guayaquil' }) === 'ya juntó los datos para la cotización');
    prueba('ficha', pq('otro', { hechos: { fichasConPase: ['eco-garantia'] } }).includes('«eco-garantia»'));
    prueba('factura', pq('factura', { hechos: { areaForzada: 'factura' } }) === 'mandó sus datos para la factura');
    prueba('nada de lo anterior', pq('otro') === 'el bot no encontró la respuesta en sus herramientas ni en las fichas');
    const d = E.decidirEscalado({ mensaje: 'ya pagué', hechos: {}, encargado: null });
    const n = E.notaInterna(d, 'ya pagué', { porQue: 'mandó un comprobante de pago para verificar' });
    prueba('la nota lo dice: «Por qué lo pasó: …»', n.includes('Por qué lo pasó: mandó un comprobante de pago para verificar.'), n);
    const df = E.decidirEscalado({ mensaje: 'Nombre: Ana', hechos: { areaForzada: 'factura' }, encargado: null });
    prueba('área forzada factura → Johan, y la nota marca 🧾 los datos', df.area === 'factura' && df.destino.id === 377 && E.notaInterna(df, '', { resumen: 'Nombre: Ana' }).includes('🧾 Datos para la factura: Nombre: Ana'));

    // escalarCaso con el chat ya en manos de su encargado activo: sin proactivo
    // no deja nota (como antes); con notaSiempre sí, y con el porqué.
    const notas = [];
    const deps = {
      consultar: async (sql) => (/FROM clientes_chat_center/.test(sql) ? [{ id: 9, id_encargado: 377, estado_contacto: 'contacto_inicial', suspendido: 0, nombre_encargado: 'Johan Pérez' }] : []),
      crearHistorial: async () => {},
      crearNota: async (t) => notas.push(t),
    };
    await E.escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 9, mensaje: 'quiero hablar con una persona', hechos: {}, deps });
    prueba('sin proactivo, chat con su encargado → sin nota (como antes)', notas.length === 0);
    await E.escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 9, mensaje: 'quiero hablar con una persona', hechos: {}, notaSiempre: true, deps });
    prueba('con proactivo → nota con el porqué', notas.length === 1 && notas[0].includes('Por qué lo pasó: pidió hablar con una persona'), notas[0]);
    const q = await E.quienAtiende({ id_configuracion: 265, id_cliente: 9, mensaje: 'ya pagué', hechos: {}, deps });
    prueba('quienAtiende: el chat sigue con Johan → nombre y área de Johan', q.nombre === 'Johan' && q.areaPersona === 'otro' && q.decision.asignar === false);
  }

  console.log('\n10. Seguimiento (T9) con los pases nuevos');
  {
    const msgs = [cli(ec(27, '09:00'), 'necesito saber de mi pago'), bot(ec(27, '09:01'), 'Recibí tu mensaje. Lo pasé a Johan, de pagos. Te escribe por este chat hoy hasta las 17:00.')];
    const d = decidirSeguimiento({ mensajes: msgs, ahora: ec(27, '12:30'), horario: HORARIO });
    prueba('3 h 29 min de oficina sin respuesta tras T6 → seguimiento con texto', d.caso === 'espera_asesor' && d.accion === 'texto', JSON.stringify(d));
  }

  console.log('\n11. Aviso de Jeff a la persona (2 h sin respuesta)');
  {
    const msgs = [cli(ec(27, '09:00'), 'necesito saber de mi pago'), bot(ec(27, '09:01'), 'Recibí tu mensaje. Lo pasé a Johan, de pagos. Te escribe por este chat hoy hasta las 17:00.')];
    const a = A.decidirAviso({ mensajes: msgs, ahora: ec(27, '11:05'), horario: HORARIO });
    prueba('2 h 4 min de oficina → avisar', a && a.avisar === true && a.esperaMin >= 120, JSON.stringify(a));
    prueba('1 h 59 min → todavía no', !A.decidirAviso({ mensajes: msgs, ahora: ec(27, '11:00'), horario: HORARIO }).avisar);
    prueba('fuera de oficina no se avisa', !A.decidirAviso({ mensajes: msgs, ahora: ec(27, '18:30'), horario: HORARIO }).avisar);
    const ya = A.decidirAviso({ mensajes: msgs, ahora: ec(27, '11:05'), horario: HORARIO, yaAvisados: new Set([`${msgs[1].id}`]) });
    prueba('un aviso por pase', !ya.avisar);
    const conPersona = [...msgs, persona(ec(27, '10:00'), 'Hola, ya lo reviso.')];
    prueba('si una persona ya contestó → no se avisa', !A.decidirAviso({ mensajes: conPersona, ahora: ec(27, '11:05'), horario: HORARIO }).avisar);
    const txt = A.textoAviso({ nombre: 'Johan', cliente: 'Ana', esperaMin: 125, idChat: 9, extracto: 'necesito saber de mi pago' });
    prueba('el aviso dice quién espera, cuánto y el chat', txt.includes('Johan') && txt.includes('2 h') && txt.includes('chat 9'), txt);
    prueba('el aviso no lleva el teléfono del cliente', !/\d{9,}/.test(txt));
  }

  console.log('\n12. Cableado en kanban_ia');
  {
    const k = fs.readFileSync(path.join(__dirname, '../src/services/kanban_ia.service.js'), 'utf8');
    const iPro = k.indexOf('Bot proactivo (tramo 5');
    const iE4 = k.indexOf('Acuse una sola vez (E4');
    const iEsc = k.indexOf('Soporte Expertos: a quién va el caso');
    prueba('el bloque va antes del acuse E4 y del envío', iPro > 0 && iPro < iE4 && iE4 < iEsc);
    prueba('solo con la bandera, el texto aprobado y fuera del panel de pruebas', /soporte_expertos\?\.proactivo && !params\.es_prueba/.test(k) && /PROACTIVO_APROBADO === true/.test(k));
    prueba('el escalado respeta la decisión (no / forzar)', k.includes("proactivo?.escalar === 'forzar' || (esPase(soloTexto) && proactivo?.escalar !== 'no')"));
    prueba('un error deja la respuesta como estaba', k.includes('la respuesta sale como estaba'));
  }

  console.log('\n13. Shipping mark (FAQ de Daniel, 27-oct: c1, c1b, c2 y c3 aprobados)');
  {
    const PIDE = 'Hola, mi proveedor me pide el shipping mark';
    const det = (estado, aprobada, marcas, id = 5501) => ({ estado: 'sin_carga', propias: { detalle: [{ id_cotizacion: id, estado, aprobada, marcas }] } });
    const base = { texto: 'La marca de envío la ves en la plataforma.', mensaje: PIDE, mensajes: [], ahora: ec(27, '10:00'), horario: HORARIO };
    prueba('c1-c3 y «varias» prendidos (Daniel, 27-oct)', T.SHIPPING_MARK_APROBADO === true && T.SHIPPING_MARK_VARIAS_APROBADO === true);
    prueba(
      'c1b tal como lo aprobó Daniel',
      T.SHIPPING_MARK.varias === 'Lo que te pide tu proveedor es el shipping mark: la marca de envío de tu carga. Tienes estas: {lista}. Cada proveedor rotula sus cajas con la suya; en la plataforma ves cuál le toca a cada uno.',
    );
    prueba(
      'c1, c2 y c3 tal como los aprobó Daniel',
      T.SHIPPING_MARK.marca === 'Lo que te pide tu proveedor es el shipping mark: la marca de envío de tu carga. La tuya es {marca} (cotización N.º {n}). Pásasela para que rotule cada caja con esa marca.' &&
        T.SHIPPING_MARK.sin_aprobar === 'Lo que te pide tu proveedor es el shipping mark: la marca de envío. Sale cuando tu cotización está aprobada, y la N.º {n} todavía no lo está.' &&
        T.SHIPPING_MARK.sin_marca === 'Lo que te pide tu proveedor es el shipping mark: la marca de envío. No la veo registrada todavía.',
    );
    const varias = { carga: { estado: 'sin_carga', propias: { detalle: [{ id_cotizacion: 1, estado: 'aprobado', aprobada: true, marcas: ['EC-1001', 'EC-1002'] }] } } };
    T.SHIPPING_MARK_VARIAS_APROBADO = false;
    prueba('«varias» con su bandera en false → sale lo de siempre', (await P.decidirProactivo({ ...base, hechos: varias })) === null);
    T.SHIPPING_MARK_VARIAS_APROBADO = true;
    prueba(
      'pide datos de otra persona → no se le da ninguna marca',
      (await P.decidirProactivo({ ...base, hechos: { pideDatosDeOtro: true, carga: det('aprobado', true, ['EC-5501001']) } })) === null,
    );
    T.SHIPPING_MARK_APROBADO = false;
    prueba('con la bandera en false → sale lo de siempre', (await P.decidirProactivo({ ...base, hechos: { carga: det('aprobado', true, ['EC-5501001']) } })) === null);
    const txt = Object.values(T.SHIPPING_MARK).join(' ');
    prueba('los textos del shipping mark sin voseo', !/\b(?:tenés|podés|querés|mandás|pasásela|contame|decime|mandame|avisame)\b/i.test(txt));
    T.SHIPPING_MARK_APROBADO = true;
    T.SHIPPING_MARK_VARIAS_APROBADO = true;
    try {
      let r = await P.decidirProactivo({ ...base, hechos: { carga: det('aprobado', true, ['EC-5501001']) } });
      prueba(
        'aprobada con marca → se la da, sin pasar',
        r && r.accion === 'SM' && r.escalar === 'no' && r.texto === 'Lo que te pide tu proveedor es el shipping mark: la marca de envío de tu carga. La tuya es EC-5501001 (cotización N.º 5501). Pásasela para que rotule cada caja con esa marca.',
        JSON.stringify(r),
      );
      r = await P.decidirProactivo({ ...base, hechos: { carga: { estado: 'sin_carga', propias: { detalle: [{ id_cotizacion: 1, estado: 'aprobado', aprobada: true, marcas: ['EC-1001', 'EC-1002'] }] } } } });
      prueba('dos marcas → c1b las lista, sin pasar', r && r.escalar === 'no' && r.texto.includes('EC-1001 (cotización N.º 1) y EC-1002 (cotización N.º 1)'), r && r.texto);
      let pedido = null;
      const quienBelen = async (extra) => {
        pedido = extra;
        return { decision: { area: 'cotizacion', asignar: true }, nombre: 'Belén', areaPersona: 'cotizacion' };
      };
      r = await P.decidirProactivo({ ...base, hechos: { carga: det('generado', false, []) }, quien: quienBelen });
      prueba(
        'sin aprobar → explica y pasa a cotizaciones con hora',
        r && r.escalar === 'forzar' && r.texto === 'Lo que te pide tu proveedor es el shipping mark: la marca de envío. Sale cuando tu cotización está aprobada, y la N.º 5501 todavía no lo está. Lo pasé a Belén, de cotizaciones. Te escribe por este chat hoy hasta las 17:00.',
        r && r.texto,
      );
      prueba('…le pide a «quién» el área de cotización', pedido && pedido.areaForzada === 'cotizacion' && pedido.shippingMark === 'sin_aprobar' && pedido.cotizacionShippingMark === 5501);
      prueba('…y la nota dice por qué', E.porQueEscala({ area: 'cotizacion', hechos: r.hechosExtra }).includes('shipping mark') && E.porQueEscala({ area: 'cotizacion', hechos: r.hechosExtra }).includes('#5501'));
      r = await P.decidirProactivo({ ...base, hechos: { carga: { estado: 'sin_carga', propias: { detalle: [] } } }, quien: quienBelen });
      prueba('sin marca → «No la veo registrada todavía» y pasa', r && r.escalar === 'forzar' && r.texto.startsWith('Lo que te pide tu proveedor es el shipping mark: la marca de envío. No la veo registrada todavía. Lo pasé a Belén'), r && r.texto);
      r = await P.decidirProactivo({ ...base, ahora: ec(27, '20:00'), hechos: { carga: det('generado', false, []) }, quien: quienBelen });
      prueba('sin aprobar a las 20:00 → «mañana desde las 8:00», como el pase de P3', r && r.texto.endsWith('Te escribe por este chat mañana desde las 8:00.'), r && r.texto);
      r = await P.decidirProactivo({ ...base, hechos: { carga: det('generado', false, []) }, quien: async () => null });
      prueba('sin aprobar y sin saber a quién → sale lo de siempre', r === null);
      r = await P.decidirProactivo({ ...base, mensaje: 'que es el shipping mark', hechos: { carga: det('aprobado', true, ['EC-5501001']) } });
      prueba('«qué es el shipping mark» → no lo toca (ficha)', r === null);
      r = await P.decidirProactivo({ ...base, hechos: { carga: null } });
      prueba('sin lectura de su carga → no lo toca', r === null);
    } finally {
      T.SHIPPING_MARK_APROBADO = true;
      T.SHIPPING_MARK_VARIAS_APROBADO = true;
    }
    const k = fs.readFileSync(path.join(__dirname, '../src/services/kanban_ia.service.js'), 'utf8');
    prueba('kanban: «quién» recibe el área que ya sabe el proactivo', k.includes('hechos: extra ? { ...hechosT, ...extra } : hechosT'));
    const { pideShippingMark } = require('../src/utils/soporteExpertos/intencion');
    prueba(
      'detecta «webmarker», «shipping marker» y «la marca para las cajas»',
      ['Cuál es mi webmarker?', 'el chino me pide el shipping marker', 'necesito la marca para las cajas', 'el proveedor me pide la marca de envío'].every(pideShippingMark),
    );
  }

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})();
