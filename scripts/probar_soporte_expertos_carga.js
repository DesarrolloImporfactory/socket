/* Pruebas de las correcciones que salieron de la prueba del bot de soporte de
   Expertos con 365 conversaciones reales:

     1. el detector de preguntas de carga (soporteExpertos/intencion.js): de 31
        mensajes sobre la carga solo disparó la consulta en 14.

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
const { buscadorDeArchivo } = require('../src/utils/soporteExpertos/fichas');
const { prepararTurno, olvidarTodo } = require('../src/utils/soporteExpertos/turno');
const T = require('../src/utils/soporteExpertos/textos');
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

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
