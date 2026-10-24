/* Pruebas de las correcciones que salieron de la prueba del bot de soporte de
   Expertos con 365 conversaciones reales:

     1. el detector de preguntas de carga (soporteExpertos/intencion.js): de 31
        mensajes sobre la carga solo disparó la consulta en 14;
     2. qué cuenta como carga en curso (soporteExpertos/cargaCliente.js): 21 de
        las 44 «cargas» leídas eran cotizaciones que no viajan.

   Corren con `node` a secas: sin base de datos, sin red, sin OpenAI y sin
   node_modules. Todas las frases son INVENTADAS con las formas de preguntar que
   describe el informe; ninguna es el mensaje de un cliente.

     node scripts/probar_soporte_expertos_carga.js
*/
'use strict';

const path = require('path');

// `ajustesIA` y `cargaCliente` importan la base solo para la consulta real; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { hablaDeCarga, pideDatosDeOtro } = require('../src/utils/soporteExpertos/intencion');
const { cargasDelTelefono, bloqueCarga, textoParaCliente, codigosEnMensaje, esHistorica, enFlujo } = require('../src/utils/soporteExpertos/cargaCliente');
const { buscadorDeArchivo } = require('../src/utils/soporteExpertos/fichas');
const { prepararTurno, revisarTurno, olvidarTodo, pideEstado } = require('../src/utils/soporteExpertos/turno');
const T = require('../src/utils/soporteExpertos/textos');
const { baseDeMentira, DATOS, TEL, HOY } = require('./soporte_expertos/base_de_mentira');
// Estas pruebas describen el bot de noche: la hora queda fija un sábado a las 21:00 de Ecuador.
require('../src/utils/soporteExpertos/horario').fijarHoraParaPruebas(Date.parse('2026-10-24T21:00:00-05:00'));

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
const turno = (mensaje, tel, extra = {}) =>
  prepararTurno({
    mensaje, telefono: tel, tipo_mensaje: extra.tipo || 'text', id_configuracion: 265, id_cliente: extra.id_cliente || tel,
    deps: { consultar: (extra.base || baseDeMentira(extra.datos)).consultar, hoy: HOY, buscador: real, ahora: extra.ahora },
  });

(async () => {
  /* ───────────────────────────────────────────────────────────────────── */
  console.log('1. El detector SÍ ve la pregunta por la carga');
  const SI = {
    '«mi pedido», «mi paquete»': [
      'y mi pedido?',
      'buenas, información de mi pedido por favor',
      'necesito saber de mi pedido',
      'mis pedidos ya salieron?',
      'en qué contenedor viene mi paquete que viene de China?',
      'ya pagué todo y mi pedido no llega',
      'cómo hago para saber de mi pedido',
    ],
    '«mi mercadería», «mis cajas», «mi contenedor»': [
      'qué pasó con mi mercadería',
      'mi mercaderia porfa',
      'y mi mercancía?',
      'la mercadería mía no aparece',
      'mis cajas ya están en Guayaquil?',
      'mis 3 cajas llegaron completas a la bodega?',
      'ya recibieron mis bultos en China?',
      'mi contenedor ya zarpó?',
      'en que va mi contenedor',
    ],
    '«ya llegó», «cuándo llega», sin decir de qué': [
      'ya llegó?',
      'buenas tardes, ya llegó?',
      'ya llegaron?',
      'ya llegó a Ecuador?',
      'quería saber si ya llegó',
      'cuándo llega?',
      'y cuándo me llega más o menos',
      'todavía no llega',
      'aún no me llega',
      'no me ha llegado',
    ],
    '«dónde va», «en qué va»': [
      'dónde va?',
      'por dónde viene',
      'por donde anda ya',
      'en qué va?',
      'en qué va lo mío',
      'dónde están mis artículos',
    ],
    '«novedades de», «estado de»': [
      'novedades de mi pedido?',
      'alguna novedad de la carga',
      'novedades del contenedor por favor',
      'hay novedades de lo mío?',
      'estado de mi pedido',
      'cuál es el estado de mi importación',
      'me ayudan con el estado de la carga',
      'estado del contenedor',
      'estado de mi envío',
    ],
    '«tracking», «rastreo»': [
      'tienen el tracking?',
      'tracking por favor',
      'cómo hago el rastreo',
      'quiero rastrear',
      'número de rastreo?',
    ],
    'número de cotización o marca de envío': [
      'cotización 4521',
      'mi cotización es la 4521',
      'en qué va la cotización N.º 4521',
      'cotizacion #4521',
      'pagué la cotización 4521, cuándo llega?',
      'EC-2609112',
      'mx 2609113 ya salió?',
      'mi marca es ec2609112',
    ],
    'fechas, aduana y salida (lo que el informe vio escaparse)': [
      'necesito las fechas de llegada de mis marcas',
      'me dan la fecha de llegada',
      'fecha estimada de arribo?',
      'desde hace quince días me dicen que está en la aduana, qué pasó?',
      'sigue en aduana?',
      'tanto se demora retirar de la aduana?',
      'ya salió de la aduana?',
      'solo falta la fecha de la salida de la embarcación',
      'ya zarpó el buque?',
      'cuándo sale el barco',
      'cuál es el paso que sigue para que la carga llegue a Ecuador?',
      'para que llegue el contenedor cuánto falta',
      'ya salió de China?',
      'todavía sigue en China?',
      'tengo una carga en camino, cuándo llega?',
      'cuándo llega un pedido que hice en agosto?',
      'ya puedo retirar mis productos?',
      'ya llegaron mis cosas?',
    ],
    'con errores de tipeo y sin tildes': [
      'ya yego?',
      'lla llego',
      'ya llegoo',
      'cuand llega',
      'cuando yega mi merca',
      'dnd va',
      'en q va',
      'x donde va mi carga',
      'mi mercansia ya esta en ecuador?',
      'mi contendor cuando llega',
      'en que va mi container',
      'me pasan el traking',
      'cotisacion 4521 ya llegó?',
      'ya pasó por aduna?',
    ],
  };
  let positivos = 0;
  for (const [grupo, frases] of Object.entries(SI)) {
    for (const q of frases) {
      positivos++;
      prueba(`${grupo} · «${q}»`, hablaDeCarga(q));
    }
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n2. …y sigue SIN disparar cuando no piden el estado de su carga');
  const NO = {
    saludos: ['hola', 'Buenas noches', 'buenos días, una consulta', 'gracias', 'ok perfecto', 'hola?', '', '???', '👍', 'y ahora?', 'cómo van las cosas'],
    'cómo importar': [
      'cómo puedo importar desde China?',
      'qué necesito para importar',
      'quiero hacer mi primera importación, por dónde empiezo?',
      'cómo hago mi importación',
      'quiero hacer mi pedido',
      'cómo hago un pedido',
      'quiero realizar un pedido con ustedes',
      'quiero confirmar mi pedido',
      'para mi próxima importación qué me recomiendan',
      'quiero cotizar mi carga',
      'cómo funciona la carga grupal?',
      'qué es el CBM',
      'qué es una marca de envío?',
      'cuáles son los requisitos para importar',
      'se pueden traer vapes y cigarrillos electrónicos?',
      'me envían fotos cuando llega a China?',
    ],
    'preguntas en general («una importación», «un contenedor»)': [
      'cuánto demora una importación desde China?',
      'cuánto tarda en llegar un contenedor a Guayaquil?',
      'cuándo llega normalmente un pedido de China?',
      'en cuánto tiempo llega una carga marítima',
      'qué impuestos paga una importación?',
      'cuánto cobra la aduana?',
      'cuáles son los impuestos de aduana',
      'me llegó un cobro de aduana por mi muestra',
    ],
    pagos: [
      'a qué cuenta deposito?',
      'buenas, a qué cuenta deposito el valor de mi cotización?',
      'ya hice la transferencia, les envío el comprobante',
      'ahí está el pago de la cotización 4521',
      '[IMAGEN: comprobante_pago] Banco Pichincha, transferencia por 150,00 USD, referencia 889912\nCliente: ahí está el pago de la cotización 4521',
      'me pueden facturar mi pedido?',
      'quiero pagar mi pedido con tarjeta',
      'cuánto cuesta la membresía?',
      'ya les llegó el comprobante?',
      'ya llegó mi pago?',
      'el pago ya llegó?',
    ],
    'clases y accesos': [
      'Hola, hoy tenemos clase?',
      'dónde está el link de la clase?',
      'cuándo es la próxima clase en vivo?',
      'ya salió la grabación de la clase?',
      'ya llegó el link?',
      'no me llega el correo de acceso',
      'todavía no me llega el correo con mi usuario',
      'ya llegó el profe?',
      'cuando llega el certificado',
      'no puedo entrar a la plataforma, me dice usuario incorrecto',
    ],
    cotización: [
      'quiero cotizar 500 unidades',
      'la cotización de 500 unidades',
      'en qué va mi cotización',
      'todavía no me llega la cotización',
      'hola quiero cotizar unos audífonos inalámbricos, cuánto me sale traer 500?',
      'cuánto cuesta traer 3 cajas de zapatos?',
      'quería saber qué necesito para que me coticen un producto que encontré en alibaba',
    ],
    ecommerce: [
      'mi pedido de dropi no llega al cliente, la guía no se mueve hace días',
      'el rastreo de la guía de servientrega no avanza',
      'mi pedido de shopify dónde está',
      'el cliente no retira el pedido de la agencia',
      'ya confirmé el pedido y sigue igual',
      'cuándo llega más stock?',
    ],
  };
  let negativos = 0;
  for (const [grupo, frases] of Object.entries(NO)) {
    for (const q of frases) {
      negativos++;
      prueba(`${grupo} · «${q.replace(/\n/g, ' ⏎ ')}»`, !hablaDeCarga(q));
    }
  }
  prueba(`la batería tiene al menos 40 casos nuevos del detector (${positivos} que sí, ${negativos} que no)`, positivos >= 40 && negativos >= 40);

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n3. Lo que el detector nuevo ve también pasa por «datos de otra persona»');
  const W = '593987654321';
  for (const q of ['ya llegó lo de mi hermano?', 'me pasas el tracking de mi socio', 'en qué va lo de mi esposa', 'cuándo llega? pregunto por un amigo']) {
    prueba(`🔒 pide datos de otro: «${q}»`, hablaDeCarga(q) && pideDatosDeOtro(q, W).pide);
  }
  for (const q of ['ya llegó?', 'y mi pedido?', 'tienen el tracking?', 'cotización 4521']) {
    prueba(`no es pedir datos de otro: «${q}»`, !pideDatosDeOtro(q, W).pide);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n4. En el turno: ahora sí se consulta la carga');
  for (const q of ['buenas tardes, ya llegó?', 'y mi pedido?', 'tienen el tracking?', 'me dan la fecha de llegada', 'en q va']) {
    olvidarTodo();
    const t = await turno(q, TEL.transito_con_fecha);
    prueba(`«${q}»: van el bloque 📦 y el estado oficial como texto seguro`, /📦 CARGA DE ESTE CLIENTE/.test(t.bloque) && t.hechos.carga?.estado === 'encontradas' && t.hechos.textoSeguro.startsWith('Hola, el contenedor EC-PRUEBA-OCT-A'));
  }
  olvidarTodo();
  let t = await turno('cuándo llega?', TEL.sin_carga);
  prueba('pregunta suelta de alguien sin carga: «no encuentro una carga» y nada inventado', t.hechos.carga?.estado === 'sin_carga' && t.hechos.textoSeguro === T.MENSAJE_SIN_CARGA);
  for (const q of ['quiero hacer mi pedido', 'cuánto demora una importación desde China?', 'ya llegó mi pago?', 'ya llegó el link?', 'buenos días']) {
    olvidarTodo();
    const base = baseDeMentira();
    t = await turno(q, TEL.transito_con_fecha, { base });
    prueba(`«${q}»: NO se consulta la carga`, t.hechos.carga === null && !/📦/.test(t.bloque) && base.consultas.length === 0);
  }
  {
    olvidarTodo();
    const base = baseDeMentira();
    t = await turno('ya llegó lo de mi socio? su número es 0901234501', TEL.sin_carga, { base });
    prueba('🔒 pregunta suelta por la carga de otro: no se consulta nada y sale «solo tu número»', base.consultas.length === 0 && t.hechos.carga === null && t.hechos.textoSeguro === T.MENSAJE_SOLO_TU_NUMERO);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n5. Qué cuenta como carga en curso (base de mentira propia; «hoy» = 12 de octubre de 2026)');
  /* Teléfonos, cotizaciones y contenedores inventados (bloque 090 123 46xx). */
  const Q = {
    generada_hoy: '593901234601', // solo una cotización generada hoy
    generada_marzo: '593901234602', // solo una cotización generada en marzo
    bodega_sin_recibir: '593901234603', // «bodega» sin coordinar, ninguna marca recibida
    aprobada_sin_recibir: '593901234604', // aprobada, el proveedor todavía no entrega
    mezcla: '593901234605', // una en tránsito + tres que no viajan
    bodega_recibida: '593901234606', // aceptada y recibida en China
    generada_recibida: '593901234607', // llegó algo a China pero nadie aceptó la cotización
    generada_en_contenedor: '593901234608', // figura «generado» pero ya va en un contenedor
    contactada_recibida: '593901234609', // «contactado» también es aceptada
    estado_raro: '593901234610', // un estado que el código no conoce
    bodega_marzo: '593901234611', // «bodega» de marzo que nunca recibió nada
    aprobada_y_borrador: '593901234612', // una recibida en China + una generada hoy
  };
  const nacional = (tel) => `0${tel.slice(3)}`;
  let usuario = 800;
  const cot = (id, estado, tel, extra = {}) => ({
    id_cotizacion: id, estado, subestado: null, fecha_creacion: '2026-09-22', pais_destino: 'ec',
    telefono: nacional(tel), id_users: extra.id_users || ++usuario, cliente: `Cliente ${id}`,
    email_cliente: `cliente${tel.slice(-3)}@ejemplo.test`, email_asesor: 'asesor@ejemplo.test', ...extra,
  });
  const marca = (id, codigo, recibida = null, cajas = null) => ({
    id_cotizacion: id, codigo, subestado: recibida ? 'recibida' : 'pendiente', cajas, fecha_recibida: recibida,
  });
  const cont = (id, idCont, nombre, estado, extra = {}) => ({
    id_cotizacion: id, id_contenedor: idCont, nombre, destino: 'ec', estado, fecha_asignada: '2026-10-01',
    fecha_cierre: null, fecha_estimada: null, fecha_puerto: null, fecha_bodega_destino: null,
    nota_cliente: null, nota_cliente_fecha: null, desde: '2026-09-28', ...extra,
  });
  const DATOS_FLUJO = {
    usuarios: [],
    entregas: [],
    cotizaciones: [
      cot(9101, 'generado', Q.generada_hoy, { fecha_creacion: HOY }),
      cot(9102, 'generado', Q.generada_marzo, { fecha_creacion: '2026-03-14' }),
      cot(9103, 'bodega', Q.bodega_sin_recibir),
      cot(9104, 'aprobado', Q.aprobada_sin_recibir),
      cot(9110, 'transito', Q.mezcla, { id_users: 850, fecha_creacion: '2026-08-20' }),
      cot(9111, 'generado', Q.mezcla, { id_users: 850, fecha_creacion: HOY }),
      cot(9112, 'bodega', Q.mezcla, { id_users: 850, fecha_creacion: '2026-09-30' }),
      cot(9113, 'generado', Q.mezcla, { id_users: 850, fecha_creacion: '2026-03-14' }),
      cot(9120, 'bodega', Q.bodega_recibida),
      cot(9121, 'generado', Q.generada_recibida),
      cot(9122, 'generado', Q.generada_en_contenedor),
      cot(9123, 'contactado', Q.contactada_recibida),
      cot(9124, 'pendiente', Q.estado_raro),
      cot(9125, 'bodega', Q.bodega_marzo, { fecha_creacion: '2026-03-14' }),
      cot(9130, 'aprobado', Q.aprobada_y_borrador, { id_users: 860 }),
      cot(9131, 'generado', Q.aprobada_y_borrador, { id_users: 860, fecha_creacion: HOY }),
    ],
    marcas: [
      marca(9101, 'EC-9101001'), marca(9102, 'EC-9102001'), marca(9103, 'EC-9103001'), marca(9104, 'EC-9104001'),
      marca(9110, 'EC-9110001', '2026-09-01', 12), marca(9111, 'EC-9111001'), marca(9112, 'EC-9112001'), marca(9113, 'EC-9113001'),
      marca(9120, 'EC-9120001', '2026-10-05', 6),
      marca(9121, 'EC-9121001', '2026-10-05', 2),
      marca(9122, 'EC-9122001', '2026-09-10', 4),
      marca(9123, 'EC-9123001', '2026-10-06', 3),
      marca(9124, 'EC-9124001', '2026-10-06', 3),
      marca(9125, 'EC-9125001'),
      marca(9130, 'EC-9130001', '2026-10-08', 9), marca(9131, 'EC-9131001'),
    ],
    contenedores: [
      cont(9110, 610, 'EC-PRUEBA-FLUJO-A', 'entransito', { fecha_estimada: '2026-10-30' }),
      cont(9122, 622, 'EC-PRUEBA-FLUJO-B', 'entransito'),
    ],
  };
  const cargas = (tel, datos = DATOS_FLUJO) => cargasDelTelefono(tel, { consultar: baseDeMentira(datos).consultar, hoy: HOY });
  const NO_VIAJA = /cotizaci[oó]n N\.º \d+ est[aá] registrada|Todav[ií]a no tenemos registrada la llegada|Paso 1 de 7/;

  let r = await cargas(Q.generada_hoy);
  prueba('solo una cotización generada hoy: NO es una carga («sin_carga»)', r.estado === 'sin_carga' && r.cargas.length === 0 && /todavía no están en el flujo/.test(r.motivo));
  prueba('…pero sigue siendo SUYA: su número y su marca no se tratan como ajenos', r.propias.cotizaciones.includes(9101) && r.propias.marcas.includes('EC-9101001'));
  let b = bloqueCarga(r, { codigos: codigosEnMensaje('en qué va mi cotización 9101, marca EC-9101001'), mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('…el bloque dice que no hay carga, no nombra la cotización y no avisa de «código ajeno»', /NO hay ninguna carga registrada con este número/.test(b) && !NO_VIAJA.test(b) && !/NO figura/.test(b) && !/9101/.test(b));
  r = await cargas(Q.generada_marzo);
  prueba('solo una cotización generada en marzo: no se lista («solo_historicas»)', r.estado === 'solo_historicas' && r.cargas.length === 0);
  r = await cargas(Q.bodega_sin_recibir);
  prueba('«bodega» sin coordinar y sin ninguna marca recibida: no es una carga', r.estado === 'sin_carga' && r.cargas.length === 0);
  r = await cargas(Q.bodega_marzo);
  prueba('«bodega» de marzo que nunca recibió nada: ahora también vence («solo_historicas»)', r.estado === 'solo_historicas' && r.cargas.length === 0);
  r = await cargas(Q.aprobada_sin_recibir);
  prueba('aprobada pero el proveedor todavía no entrega en China: no se informa', r.estado === 'sin_carga' && r.cargas.length === 0 && r.propias.cotizaciones.includes(9104));
  r = await cargas(Q.generada_recibida);
  prueba('llegó algo a China pero nadie aceptó la cotización: no se informa (lo ve una persona)', r.estado === 'sin_carga' && r.cargas.length === 0);
  r = await cargas(Q.estado_raro);
  prueba('un estado que el código no conoce no cuenta como aceptada', r.estado === 'sin_carga' && r.cargas.length === 0);

  r = await cargas(Q.bodega_recibida);
  prueba('aceptada («bodega») y recibida en China: SÍ es una carga, paso 2', r.estado === 'encontradas' && r.cargas.length === 1 && r.cargas[0].paso === 2 && r.cargas[0].informable && /ya recibimos tu mercadería en nuestra bodega de China/.test(r.cargas[0].texto_cliente));
  r = await cargas(Q.contactada_recibida);
  prueba('«contactado» con una marca recibida: también es aceptada, paso 2', r.estado === 'encontradas' && r.cargas[0].id_cotizacion === 9123 && r.cargas[0].paso === 2);
  r = await cargas(Q.generada_en_contenedor);
  prueba('ya va en un contenedor: se informa aunque la cotización figure «generado»', r.estado === 'encontradas' && r.cargas[0].paso === 4 && r.cargas[0].contenedor === 'EC-PRUEBA-FLUJO-B');

  r = await cargas(Q.mezcla);
  prueba('una en tránsito y tres que no viajan: se cuenta UNA sola carga', r.estado === 'encontradas' && r.cargas.length === 1 && r.cargas[0].id_cotizacion === 9110 && r.hay_mas === 0);
  prueba('…las cuatro siguen siendo suyas (ninguna se señala como ajena)', [9110, 9111, 9112, 9113].every((id) => r.propias.cotizaciones.includes(id)));
  let texto = textoParaCliente(r, T.MENSAJE_ASESOR);
  prueba('…el texto para el cliente es el de la que viaja, sin lista ni «tu cotización está registrada»', texto.startsWith('Hola, el contenedor EC-PRUEBA-FLUJO-A, donde viaja tu carga EC-9110001, ya está en tránsito hacia Ecuador.') && /30 de octubre/.test(texto) && !/tienes \d+ cargas( registradas|;)/.test(texto) && !NO_VIAJA.test(texto) && !/911[123]/.test(texto));
  b = bloqueCarga(r, { mensajeAsesor: T.MENSAJE_ASESOR });
  prueba('…y el bloque del modelo dice «1 carga en curso», sin las otras tres', /Tiene 1 carga en curso con este número\./.test(b) && !/911[123]/.test(b) && !NO_VIAJA.test(b));
  r = await cargas(Q.aprobada_y_borrador);
  prueba('una recibida en China y otra generada hoy: solo la recibida', r.estado === 'encontradas' && r.cargas.length === 1 && r.cargas[0].id_cotizacion === 9130 && r.cargas[0].paso === 2);

  {
    let enPaso1 = 0;
    let revisadas = 0;
    for (const [datos, telefonos] of [[DATOS, TEL], [DATOS_FLUJO, Q]]) {
      for (const tel of Object.values(telefonos)) {
        const x = await cargas(tel, datos);
        revisadas += x.cargas.length;
        enPaso1 += x.cargas.filter((c) => c.paso < 2).length;
      }
    }
    prueba(`barrido de los ${Object.keys(TEL).length + Object.keys(Q).length} teléfonos de prueba: ninguna carga listada está en el paso 1 (${revisadas} revisadas)`, revisadas >= 15 && enPaso1 === 0);
  }

  console.log('\n6. Las dos reglas, a solas');
  const E = (paso, extra = {}) => ({ paso, entregada: false, contenedor: null, ...extra });
  prueba('enFlujo: en contenedor (pasos 3 a 7) siempre, sea cual sea el estado de la cotización', [3, 4, 5, 6, 7].every((p) => enFlujo({ estado: 'generado' }, E(p)) && enFlujo({ estado: 'carga' }, E(p))));
  prueba('enFlujo: paso 2 solo si alguien la aceptó', ['aprobado', 'contactado', 'bodega', 'carga', 'proximo', 'transito', ' Bodega '].every((s) => enFlujo({ estado: s }, E(2))) && ['generado', 'pendiente', '', null, undefined].every((s) => !enFlujo({ estado: s }, E(2))));
  prueba('enFlujo: el paso 1 nunca, ni aprobada', ['generado', 'aprobado', 'contactado', 'bodega', 'carga'].every((s) => !enFlujo({ estado: s }, E(1))));
  prueba('esHistorica: paso 1 con más de 60 días vence en cualquier estado; con menos, no', ['generado', 'aprobado', 'bodega'].every((s) => esHistorica({ estado: s, fecha_creacion: '2026-03-14' }, E(1), HOY) && !esHistorica({ estado: s, fecha_creacion: '2026-09-22' }, E(1), HOY)));
  prueba('esHistorica: paso 1 sin fecha de creación se trata como historia', esHistorica({ estado: 'bodega', fecha_creacion: null }, E(1), HOY));
  prueba('esHistorica: una recibida en China hace poco no es historia', !esHistorica({ estado: 'bodega', fecha_creacion: '2026-09-22' }, E(2), HOY));

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n7. En el turno: sin nada en el flujo responde «sin carga» y pasa a logística');
  for (const [quien, tel] of [['cotización generada hoy', Q.generada_hoy], ['«bodega» sin recibir', Q.bodega_sin_recibir], ['aprobada sin recibir', Q.aprobada_sin_recibir], ['generada en marzo', Q.generada_marzo]]) {
    olvidarTodo();
    t = await turno('ya llegó mi mercadería?', tel, { datos: DATOS_FLUJO });
    prueba(`${quien}: el texto seguro es «no encuentro una carga en curso… lo dejo anotado para el área de logística»`, ['sin_carga', 'solo_historicas'].includes(t.hechos.carga?.estado) && t.hechos.textoSeguro === T.MENSAJE_SIN_CARGA && /área de logística/.test(t.hechos.textoSeguro) && /No digas ni supongas ningún estado/.test(t.bloque) && !NO_VIAJA.test(t.bloque));
  }
  olvidarTodo();
  t = await turno('ya llegó mi mercadería?', Q.mezcla, { datos: DATOS_FLUJO });
  prueba('con una carga que sí viaja: el texto seguro es su estado, sin las cotizaciones que no viajan', t.hechos.textoSeguro.startsWith('Hola, el contenedor EC-PRUEBA-FLUJO-A') && !/911[123]/.test(t.bloque) && !NO_VIAJA.test(t.bloque));
  olvidarTodo();
  t = await turno('en qué va mi cotización 9111?', Q.mezcla, { datos: DATOS_FLUJO });
  prueba('pregunta por SU cotización que no viaja: no se le da estado de esa ni se la trata como ajena', /📦/.test(t.bloque) && !/NO figura/.test(t.bloque) && !NO_VIAJA.test(t.bloque));
  olvidarTodo();
  t = await turno('en qué va la cotización 9101?', Q.mezcla, { datos: DATOS_FLUJO });
  prueba('🔒 la cotización que no viaja de OTRO cliente sigue señalándose como ajena', /El cliente escribió cotización 9101\. Ese código NO figura/.test(t.bloque));

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n9. El estado de la carga no se repite (23-oct: la lista de 3 cargas salió dos veces)');
  {
    olvidarTodo();
    const tel = TEL.transito_con_fecha;
    const t0 = Date.parse('2026-10-23T19:10:00-05:00');
    let a = await turno('cuándo llega mi carga?', tel, { ahora: t0 });
    prueba('primera vez: va el bloque entero y no está marcada como dicha', /📦 CARGA DE ESTE CLIENTE/.test(a.bloque) && a.hechos.cargaYaDicha === false);
    const r1 = revisarTurno(a.hechos.textoSeguro, a.hechos, { ahora: t0 });
    prueba('el estado sale tal cual la primera vez', r1.texto === a.hechos.textoSeguro);
    a = await turno('lo que ya está en bodega lo dejamos para el contenedor del 15 de noviembre', tel, { ahora: t0 + 10 * 60e3 });
    prueba('10 min después, sin pedir el estado: no va el bloque entero, va el aviso de no repetir', a.hechos.cargaYaDicha === true && !/📦 CARGA DE ESTE CLIENTE/.test(a.bloque) && /YA se lo diste/.test(a.bloque));
    prueba('…y el texto seguro es el paso a asesor', a.hechos.textoSeguro === T.MENSAJE_ASESOR);
    const r2 = revisarTurno(`Hola, ${a.hechos.huellasCarga[0]} y lo demás.`, a.hechos, { ahora: t0 + 10 * 60e3 });
    prueba('si el modelo igual repite el estado, sale el paso a asesor', r2.texto === T.MENSAJE_ASESOR && r2.cambiada, r2.texto);
    a = await turno('y cuándo llega entonces?', tel, { ahora: t0 + 12 * 60e3 });
    prueba('si vuelve a pedir el estado («cuándo llega»), se le da de nuevo', a.hechos.cargaYaDicha === false && /📦 CARGA DE ESTE CLIENTE/.test(a.bloque));
    olvidarTodo();
    a = await turno('cuándo llega mi carga?', tel, { ahora: t0 });
    revisarTurno(a.hechos.textoSeguro, a.hechos, { ahora: t0 });
    a = await turno('para el 30 de octubre', tel, { ahora: t0 + 25 * 60e3 });
    prueba('pasados 20 minutos ya no cuenta como dicho', a.hechos.cargaYaDicha === false);
    olvidarTodo();
    // Revisión independiente del 24-oct: todas estas vuelven a pedir el estado.
    const piden = ['y mi carga?', 'qué día llega?', 'cuánto falta para que llegue?', 'llegó ya?', 'ya llegó mi carga', 'me das el estado?', 'info de mi carga porfa', 'tracking?', 'en qué fecha llega?', 'cuándo llegará?', 'y la marca IMP-2231?'];
    prueba('las maneras de volver a pedir el estado cuentan como pedirlo', piden.every(pideEstado), piden.filter((x) => !pideEstado(x)).join(' | '));
    const noPiden = ['lo que ya está en bodega lo dejamos para el contenedor del 15 de noviembre', 'hasta cuándo reciben en la bodega de China?', 'para el contenedor del 30 cuándo es el cierre?'];
    prueba('contar algo de la carga o preguntar por la recepción no es pedir el estado', !noPiden.some(pideEstado), noPiden.filter(pideEstado).join(' | '));
    a = await turno('cuándo llega mi carga?', tel, { ahora: t0 });
    revisarTurno(a.hechos.textoSeguro, a.hechos, { ahora: t0 });
    a = await turno('qué día llega?', tel, { ahora: t0 + 5 * 60e3 });
    prueba('«qué día llega?» a los 5 min: se le da el estado otra vez', a.hechos.cargaYaDicha === false && /📦 CARGA DE ESTE CLIENTE/.test(a.bloque));
    olvidarTodo();
  }

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
