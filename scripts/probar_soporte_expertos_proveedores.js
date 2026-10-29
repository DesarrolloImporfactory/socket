/* Pruebas de «buscar_proveedor» (proveedores de Yiwu con tarjeta y la clase de
   cómo escribirles): la búsqueda, el texto armado en código, la bandera, la
   guardia con lo que trajo la herramienta y las tarjetas que salen como foto.

   Sin base de datos, sin red y sin la API de Claude: los proveedores salen de
   una lista de mentira.

     node scripts/probar_soporte_expertos_proveedores.js
*/
'use strict';

const path = require('path');

const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const {
  buscarProveedores,
  textoProveedores,
  bloqueProveedores,
  tarjetasParaEnviar,
  raicesProducto,
  SQL_PROVEEDORES,
} = require('../src/utils/soporteExpertos/proveedoresYiwu');
const { crearHerramientas, sumarHechosHerramientas } = require('../src/utils/soporteExpertos/herramientas');
const { prepararTurno, revisarTurno, olvidarTodo } = require('../src/utils/soporteExpertos/turno');
const { buscadorDeArchivo } = require('../src/utils/soporteExpertos/fichas');
const { extraerUrlsMedia } = require('../src/utils/urlsMedia');
const T = require('../src/utils/soporteExpertos/textos');
const { SECCION_PROVEEDORES } = require('../src/utils/prompt_soporte_expertos.data');
const { baseDeMentira, HOY } = require('./soporte_expertos/base_de_mentira');
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

const S3 = 'https://imp-datas.s3.amazonaws.com/images';
const fila = (id, nombre, producto, categoria, extra = {}) => ({
  id_proveedor: id,
  nombre,
  producto,
  categoria,
  buscador: `${nombre} ${producto} ${categoria}`.toLowerCase(),
  tarjeta: `${S3}/2026-10-13-tarjeta-yiwu-${id}.jpg`,
  telefono: `1380000${String(id).padStart(4, '0')}`,
  wechat_id: '',
  wechat: '',
  whatsapp: null,
  direccion: `F1-${10000 + id}, Calle 7, Distrito 2`,
  ...extra,
});

const FILAS = [
  fila(553, 'Rosy Bunny Bags', 'Mochilas y bolsos', 'Bolsos, Carteras y Equipaje'),
  fila(552, 'Kai Xi Lun Bags – KXL', 'Carteras y bolsos', 'Bolsos, Carteras y Equipaje', { wechat_id: 'kxl_bags88' }),
  fila(549, 'Yiwu Longchang Rain Gear Co.', 'Paraguas y sombrillas', 'Moda, Textiles y Calzado', { wechat_id: 'longchang549' }),
  fila(550, 'Zhejiang Anyuan Umbrella Co.', 'Parasoles, carpas plegables, toldos publicitarios', 'Moda, Textiles y Calzado'),
  fila(540, 'Ningbo Baño Feliz', 'Organizadores de baño', 'Hogar, Cocina y Decoración'),
  fila(541, 'Mochilas Uno', 'Mochilas escolares', 'Bolsos, Carteras y Equipaje'),
  fila(542, 'Mochilas Dos', 'Mochilas de viaje', 'Bolsos, Carteras y Equipaje'),
  fila(543, 'Mochilas Tres', 'Mochilas deportivas', 'Bolsos, Carteras y Equipaje'),
  fila(544, 'Tarjeta Rota Bags', 'Mochilas', 'Bolsos, Carteras y Equipaje', { tarjeta: 'http://sitio-viejo/tarjeta.pdf' }),
  fila(546, 'Yiwu Quanneng Rope & Belt Co', 'Cuerdas, cintas y correas', 'Moda, Textiles y Calzado'),
  fila(547, 'Fei Fan Bag & Case', 'Mochilas de hombre y mujer, loncheras', 'Bolsos, Carteras y Equipaje'),
  fila(548, 'WEELY Electrical Accessories', 'Accesorios eléctricos', 'Herramientas e Industrial'),
  fila(539, 'YOURZ Tech', 'Accesorios para celular: cargadores, cables y fundas', 'Tecnología y Electrónica'),
  fila(545, 'Audio Shenzhen', 'Audífonos bluetooth y parlantes', 'Tecnología y Electrónica', { whatsapp: '+86 138 0000 0545' }),
];
const consultarFalso = (filas = FILAS) => {
  const llamadas = [];
  const f = async (sql) => {
    llamadas.push(sql);
    return filas;
  };
  f.llamadas = llamadas;
  return f;
};
/* Membresía de mentira: socio = activa; los demás, sin fila (no es alumno). */
const SOCIO_TEL = '593990000001';
const membresiasFalsas = (vigentes = [SOCIO_TEL, '593990000000'], vencidas = []) => async (tels) =>
  new Map(
    tels
      .map((x) => String(x).replace(/\D/g, '').slice(-9))
      .flatMap((c) => [
        ...vigentes.filter((v) => v.endsWith(c)).map(() => [c, { vencida: false }]),
        ...vencidas.filter((v) => v.endsWith(c)).map(() => [c, { vencida: true }]),
      ]),
  );
const SOCIO = { telefono: SOCIO_TEL, membresias: membresiasFalsas() };
const NOMBRES = FILAS.map((f) => f.nombre);
const nombraAlguno = (t) => NOMBRES.some((n) => t.includes(n));

(async () => {
  console.log('\n1. La búsqueda');
  {
    const r = await buscarProveedores('mochilas para niños', { consultar: consultarFalso(), ...SOCIO });
    prueba('«mochilas para niños» encuentra proveedores', r.estado === 'encontrado', JSON.stringify(r).slice(0, 200));
    prueba('…nunca más de 3 aunque calcen 5', r.proveedores.length === 3, String(r.proveedores?.length));
    prueba('…todos venden mochilas', r.proveedores.every((p) => /mochila/i.test(p.vende)), r.proveedores.map((p) => p.vende).join(' | '));
    prueba('…sin la de tarjeta rota (http y .pdf)', !r.proveedores.some((p) => p.id === 544));
  }
  {
    const r = await buscarProveedores('paraguas', { consultar: consultarFalso(), ...SOCIO });
    prueba('«paraguas» → el de paraguas, primero', r.estado === 'encontrado' && r.proveedores[0].id === 549);
    prueba('…contacto: WeChat primero', r.proveedores[0].contacto === 'WeChat: longchang549');
  }
  {
    const r = await buscarProveedores('mochillas', { consultar: consultarFalso(), ...SOCIO });
    prueba('con un error de tipeo («mochillas») igual encuentra', r.estado === 'encontrado' && r.proveedores.length >= 1);
  }
  {
    const r = await buscarProveedores('audifonos', { consultar: consultarFalso(), ...SOCIO });
    prueba('sin tildes («audifonos») encuentra y usa el WhatsApp', r.estado === 'encontrado' && r.proveedores[0].contacto === 'WhatsApp: +86 138 0000 0545');
  }
  {
    const r = await buscarProveedores('cosas de cocina', { consultar: consultarFalso(), ...SOCIO });
    prueba('solo la categoría («cocina») no alcanza: no nombra a cualquiera de «Hogar»', r.estado === 'sin_resultados', JSON.stringify(r).slice(0, 200));
  }
  {
    const r = await buscarProveedores('drones agrícolas', { consultar: consultarFalso(), ...SOCIO });
    prueba('un producto que no está → sin_resultados', r.estado === 'sin_resultados');
    const t = textoProveedores(r);
    prueba('…el texto manda al directorio y a la clase, sin nombrar a nadie', t.includes(T.LINKS.proveedores) && t.includes(T.LINKS.claseContactarProveedor) && !nombraAlguno(t));
  }
  {
    const q = consultarFalso();
    const r = await buscarProveedores('quiero un proveedor de china', { consultar: q, ...SOCIO });
    prueba('sin decir qué producto → sin_producto y no consulta la base', r.estado === 'sin_producto' && q.llamadas.length === 0);
    prueba('…el modelo recibe la orden de preguntar el producto', /Pregúntale qué producto/.test(bloqueProveedores(r)));
  }
  {
    const r = await buscarProveedores('mochilas', {
      ...SOCIO,
      consultar: async () => {
        throw new Error('base caída');
      },
    });
    prueba('si la base falla → error, y el texto no nombra a nadie', r.estado === 'error' && !nombraAlguno(textoProveedores(r)) && textoProveedores(r) === T.PROVEEDORES_SIN_RESULTADO);
  }
  {
    const r = await buscarProveedores('ropa de mujer', { consultar: consultarFalso(), ...SOCIO });
    prueba('«ropa de mujer» no trae «Rope & Belt» (nombre en inglés) ni mochilas «de hombre y mujer»', r.estado === 'sin_resultados', JSON.stringify(r.proveedores?.map((p) => p.nombre)));
  }
  {
    const r = await buscarProveedores('accesorios para celular', { consultar: consultarFalso(), ...SOCIO });
    prueba('«accesorios para celular» trae el de celulares y no «accesorios eléctricos»', r.estado === 'encontrado' && r.proveedores.length === 1 && r.proveedores[0].id === 539, JSON.stringify(r.proveedores?.map((p) => p.nombre)));
  }
  {
    const r = await buscarProveedores('mochilas para niños', { consultar: consultarFalso(), ...SOCIO });
    prueba('«para niños» solo afina: siguen saliendo las mochilas', r.estado === 'encontrado' && r.proveedores.every((p) => /mochila/i.test(p.vende)));
  }
  prueba('palabras de relleno fuera («busco proveedor de mochilas en yiwu» → mochil)', raicesProducto('busco proveedor de mochilas en yiwu').join(',') === 'mochil', raicesProducto('busco proveedor de mochilas en yiwu').join(','));
  prueba('la consulta solo lee: visibles, con tarjeta, no caídos y con algún contacto',
    /^\s*SELECT/i.test(SQL_PROVEEDORES) && !/\b(UPDATE|INSERT|DELETE)\b/i.test(SQL_PROVEEDORES) &&
      /ver = 1/.test(SQL_PROVEEDORES) && /origen = 'tarjeta'/.test(SQL_PROVEEDORES) && /enlace_estado/.test(SQL_PROVEEDORES) && /wechat_id/.test(SQL_PROVEEDORES));

  console.log('\n2. El texto para el cliente');
  {
    const r = await buscarProveedores('paraguas y sombrillas', { consultar: consultarFalso(), ...SOCIO });
    const t = textoProveedores(r);
    prueba('trae nombre, lo que vende, el puesto en el mercado y el contacto', t.includes('Yiwu Longchang Rain Gear Co.') && t.includes('vende Paraguas y sombrillas') && t.includes('en el mercado: F1-10549') && t.includes('WeChat: longchang549'));
    prueba('trae la clase de cómo escribirle y el directorio', t.includes(T.LINKS.claseContactarProveedor) && t.includes(T.LINKS.proveedores));
    prueba('NO trae los enlaces de las tarjetas (salen como foto)', !t.includes(S3));
    prueba('el bloque del modelo dice «Responde exactamente»', bloqueProveedores(r).startsWith('Responde exactamente esto'));
  }
  {
    const r = await buscarProveedores('parasoles', { consultar: consultarFalso(), ...SOCIO });
    const t = textoProveedores(r);
    prueba('con uno solo: «Tengo este proveedor…» y «su tarjeta»', r.proveedores.length === 1 && t.startsWith('Tengo este proveedor') && t.includes('Te mando su tarjeta'));
  }
  {
    const todos = [T.PROVEEDORES_ENCONTRADOS(1), T.PROVEEDORES_ENCONTRADOS(3), T.PROVEEDORES_TARJETAS(1), T.PROVEEDORES_TARJETAS(2), T.PROVEEDORES_PEDIR, T.PROVEEDORES_VIDEO, T.PROVEEDORES_SIN_RESULTADO, T.PROVEEDORES_SIN_MEMBRESIA, SECCION_PROVEEDORES].join('\n');
    const voseo = /\b(ten[eé]s|pod[eé]s|quer[eé]s|sab[eé]s|mand[aá]me|escrib[ií]les|ped[ií]le|busc[aá]lo|vos)\b/i;
    prueba('textos en tuteo, sin voseo', !voseo.test(todos), (todos.match(voseo) || [])[0]);
    prueba('el enlace de la clase es el del curso 30, contenido 383', T.LINKS.claseContactarProveedor === 'https://imporfactory.app/cursos/30?contenido=383');
  }

  console.log('\n2b. Solo alumnos con membresía activa');
  {
    const q = consultarFalso();
    const r = await buscarProveedores('mochilas', { consultar: q, telefono: '593991112222', membresias: membresiasFalsas() });
    prueba('sin membresía → sin_membresia y no consulta el directorio', r.estado === 'sin_membresia' && q.llamadas.length === 0);
    const t = textoProveedores(r);
    prueba('…el texto dice que es parte de la membresía y no nombra a nadie', t === T.PROVEEDORES_SIN_MEMBRESIA && /parte de la membresía/.test(t) && !nombraAlguno(t));
    prueba('…y no sale ninguna tarjeta', tarjetasParaEnviar(t, r).length === 0);
    const venc = await buscarProveedores('mochilas', { consultar: consultarFalso(), telefono: '593993334444', membresias: membresiasFalsas([], ['593993334444']) });
    prueba('membresía vencida → sin_membresia', venc.estado === 'sin_membresia');
    const caida = await buscarProveedores('mochilas', { consultar: consultarFalso(), telefono: SOCIO_TEL, membresias: async () => { throw new Error('db_2 caída'); } });
    prueba('si no se puede consultar la membresía → no da contactos', caida.estado === 'sin_membresia');
    const sinTel = await buscarProveedores('mochilas', { consultar: consultarFalso(), membresias: membresiasFalsas() });
    prueba('sin teléfono → sin_membresia', sinTel.estado === 'sin_membresia');
    const socioMx = await buscarProveedores('mochilas', { consultar: consultarFalso(), telefono: '+52 1 55 9000 0001', membresias: membresiasFalsas(['5215590000001']) });
    prueba('un socio con el número escrito distinto (+52 1 …) sí recibe', socioMx.estado === 'encontrado');
    const h = crearHerramientas({ telefono: '593991112222', proveedores: true, deps: { consultar: consultarFalso(), membresias: membresiasFalsas() } });
    const out = await h.lista.find((x) => x.definicion.name === 'buscar_proveedor').ejecutar({ producto: 'paraguas' });
    prueba('la herramienta pasa el teléfono del chat: a un no alumno le devuelve «parte de la membresía»', out.includes(T.PROVEEDORES_SIN_MEMBRESIA) && !nombraAlguno(out));
  }

  console.log('\n3. La herramienta y su bandera');
  {
    const sin = crearHerramientas({ telefono: '593990000000' });
    prueba('sin la bandera no aparece', !sin.lista.some((h) => h.definicion.name === 'buscar_proveedor'));
    const h = crearHerramientas({ telefono: '593990000000', proveedores: true, deps: { consultar: consultarFalso(), membresias: membresiasFalsas() } });
    const bp = h.lista.find((x) => x.definicion.name === 'buscar_proveedor');
    prueba('con proveedores:true aparece, con producto obligatorio', Boolean(bp) && bp.definicion.input_schema.required.includes('producto'));
    prueba('antes de usarla no hay proveedores consultados', h.proveedoresConsultados() === null);
    const out = await bp.ejecutar({ producto: 'mochilas' });
    prueba('ejecutada: devuelve el texto exacto y guarda lo encontrado', out.startsWith('Responde exactamente') && h.proveedoresConsultados()?.estado === 'encontrado');
    const se = (v) => require('../src/utils/ajustesIA').normalizar({ soporte_expertos: v }).soporte_expertos;
    prueba('la bandera de la cuenta: solo con herramientas y proveedores:true',
      se({ herramientas: true, proveedores: true }).proveedores === true &&
        se({ proveedores: true }).proveedores === false &&
        se({ herramientas: true }).proveedores === false &&
        se(true).proveedores === false);
    const raro = await bp.ejecutar({ producto: 42 });
    prueba('un producto que no es texto no rompe: pide el producto', /Pregúntale qué producto/.test(raro));
  }

  console.log('\n4. La guardia con lo que trajo la herramienta');
  {
    olvidarTodo();
    const msg = 'tienen proveedor de paraguas?';
    const h = crearHerramientas({ telefono: '593990000001', mensaje: msg, proveedores: true, deps: { consultar: consultarFalso(), membresias: membresiasFalsas() } });
    const bp = h.lista.find((x) => x.definicion.name === 'buscar_proveedor');
    const bloque = await bp.ejecutar({ producto: 'paraguas' });
    const respuesta = textoProveedores(h.proveedoresConsultados());
    const t = await prepararTurno({
      mensaje: msg, telefono: '593990000001', tipo_mensaje: 'text', id_configuracion: 265, id_cliente: '593990000001',
      opciones: { cargas: false, fichas: true, guardia: true, herramientas: true },
      deps: { consultar: baseDeMentira().consultar, hoy: HOY, buscador: buscadorDeArchivo() },
    });
    const revSin = revisarTurno(respuesta, JSON.parse(JSON.stringify(t.hechos)));
    prueba('sin sumar lo de la herramienta, la guardia frena los contactos', revSin.cambiada === true, revSin.motivos.join('; '));
    sumarHechosHerramientas(t.hechos, [bloque], null, { mensaje: msg, respuesta });
    const rev = revisarTurno(respuesta, t.hechos);
    prueba('sumándolo, la respuesta con proveedores, contactos y enlaces pasa', rev.cambiada === false, rev.motivos.join('; '));
    const inventado = `${respuesta}\nTambién te sirve Shenzhen Fake Co., WeChat 99887766, https://otro-directorio.com`;
    prueba('un contacto o enlace que no trajo la herramienta se sigue frenando', revisarTurno(inventado, t.hechos).cambiada === true);
  }

  console.log('\n5. Las tarjetas que salen como foto');
  {
    const r = await buscarProveedores('bolsos', { consultar: consultarFalso(), ...SOCIO });
    const t = textoProveedores(r);
    const tarjetas = tarjetasParaEnviar(t, r);
    prueba('una tarjeta por cada proveedor de la respuesta', tarjetas.length === r.proveedores.length && tarjetas.every((u) => u.startsWith(S3)));
    prueba('si la guardia la cambió por «un asesor…», no sale ninguna', tarjetasParaEnviar(T.MENSAJE_ASESOR, r).length === 0);
    const solo1 = `Te recomiendo ${r.proveedores[0].nombre}.`;
    prueba('solo salen las de los nombrados', tarjetasParaEnviar(solo1, r).length === 1);
    prueba('sin proveedores encontrados no sale nada', tarjetasParaEnviar(T.PROVEEDORES_SIN_RESULTADO, { estado: 'sin_resultados' }).length === 0);
    const media = extraerUrlsMedia(`${t}${tarjetas.map((u) => `\n[producto_imagen_url]: ${u}`).join('')}`);
    prueba('el extractor del paso 12 las toma como imágenes y deja el texto limpio', media.imagenes.length === tarjetas.length && !media.texto.includes(S3), JSON.stringify(media.imagenes));
  }

  console.log(`\n${ok} bien, ${fallos} fallas`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
