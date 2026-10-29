/* Pruebas de «ver_mis_pedidos_dropi» (pedidos de Dropi de la tienda del
   alumno, del caché de IMPORCHAT): de quién lee, qué muestra, la búsqueda, la
   bandera, la guardia y el texto seguro.

   Sin base de datos, sin red, sin Dropi y sin la API de Claude: las filas
   salen de una base de mentira que responde según la consulta.

     node scripts/probar_soporte_expertos_dropi.js
*/
'use strict';

const path = require('path');

const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const { pedidosDropi, bloquePedidosDropi, condicionBuscar, dia } = require('../src/utils/soporteExpertos/pedidosDropi');
const { crearHerramientas, sumarHechosHerramientas, hablaDePedidosDropi } = require('../src/utils/soporteExpertos/herramientas');
const { olvidarDatosProbados } = require('../src/utils/soporteExpertos/diagnosticoCuenta');
const { normalizar } = require('../src/utils/ajustesIA');
const normalizarSoporteExpertos = (v) => normalizar(JSON.stringify({ soporte_expertos: v })).soporte_expertos;
const T = require('../src/utils/soporteExpertos/textos');
const { SECCION_DROPI } = require('../src/utils/prompt_soporte_expertos.data');

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

const AHORA = new Date('2026-10-27T17:00:00Z'); // 12:00 de Ecuador
const TEL = '593987654321';
const movs = (...m) => JSON.stringify({ servientrega_movements: m.map(([nom_mov, created_at]) => ({ nom_mov, created_at })) });
const pedido = (id, cfg, extra = {}) => ({
  dropi_order_id: id,
  id_configuracion: cfg,
  status: 'EN TRÁNSITO',
  estado: 'en_transito',
  name: 'Ana María',
  surname: 'Pérez',
  city: 'QUITO',
  phone: '0991234567',
  shipping_company: 'SERVIENTREGA',
  shipping_guide: '1234567890',
  product_names: 'LIMPIADOR A VAPOR',
  agencia_retiro: null,
  creada: '2026-10-25 09:00:00',
  order_data: movs(['GENERADA', '2026-10-25T10:00:00'], ['EN TRÁNSITO', '2026-10-26T08:00:00']),
  ...extra,
});

const PEDIDOS = [
  pedido(9001, 500, {
    status: 'NOVEDAD',
    estado: 'novedad',
    shipping_company: 'GINTRACOM',
    shipping_guide: 'GTC778899',
    creada: '2026-10-20 10:00:00',
    order_data: JSON.stringify({
      novedad_servientrega: 'DESTINATARIO NO CONTESTA LLAMADAS NI WHATSAPP',
      servientrega_movements: [{ nom_mov: 'EN REPARTO', created_at: '2026-10-27T10:33:56' }, { nom_mov: 'DESTINATARIO NO CONTESTA LLAMADAS NI WHATSAPP', created_at: '2026-10-27T10:51:30' }],
    }),
  }),
  pedido(9002, 500, { creada: '2026-10-18 09:00:00', name: 'Luis', surname: 'Mora', city: 'GUAYAQUIL', phone: '+593 98 111 2233' }),
  pedido(9003, 501, { status: 'PARA RETIRO EN AGENCIA SERVIENTREGA', estado: 'retiro_agencia', agencia_retiro: 'Agencia Servientrega La Carolina', shipping_guide: '5555555555' }),
  pedido(9004, 500, { status: 'ENTREGADO', estado: 'entregada' }),
  pedido(9005, 500, { status: 'REEMPLAZADA', estado: 'otro' }),
  pedido(9006, 500, { status: 'DEVOLUCION', estado: 'devolucion', creada: '2026-10-01 09:00:00', product_names: '["Tabla de Picar", "Cuchillo"]' }),
  // de otra cuenta (otra persona): nunca debe salir
  pedido(9999, 777, { name: 'Ajeno', surname: 'Zeta', shipping_guide: '1234567890' }),
];

/** Base de mentira: responde según la tabla y guarda las consultas. */
function baseMentira({ usuarios = [{ id_usuario: 77, pais: '593', lead: '987654321' }], conexiones = [{ id: 500 }, { id: 501 }], integraciones = null, falla = null } = {}) {
  const log = [];
  const consultar = async (sql, r = {}) => {
    log.push({ sql, r });
    if (falla && sql.includes(falla)) throw new Error('se cayó la base');
    if (/FROM usuarios_chat_center/.test(sql) && /whatsapp_lead/.test(sql)) return r.cola === '987654321' ? usuarios : [];
    if (/FROM usuarios_chat_center/.test(sql)) return [];
    if (/FROM sub_usuarios_chat_center/.test(sql)) return [];
    if (/FROM configuraciones/.test(sql) && /telefono/.test(sql)) return [];
    if (/SELECT id FROM configuraciones/.test(sql)) return Number(r.uid) === 77 ? conexiones : [{ id: 777 }];
    if (/FROM dropi_integrations/.test(sql)) {
      const todas = integraciones || [{ id_configuracion: 500, country_code: 'EC', is_active: 1 }, { id_configuracion: 501, country_code: 'EC', is_active: 1 }];
      return todas.filter((f) => r.ids.includes(f.id_configuracion));
    }
    const deEllos = PEDIDOS.filter((p) => r.ids.includes(p.id_configuracion) && p.status !== 'REEMPLAZADA');
    if (/GROUP BY classified_status/.test(sql)) {
      const m = new Map();
      for (const p of deEllos) m.set(p.estado, (m.get(p.estado) || 0) + 1);
      return [...m].map(([estado, n]) => ({ estado, n, sync: '2026-10-27 11:58:00' }));
    }
    if (/NOT IN \(:fuera\)/.test(sql)) {
      return deEllos
        .filter((p) => !r.fuera.includes(p.estado))
        .sort((a, b) => (b.estado === 'novedad') - (a.estado === 'novedad') || a.creada.localeCompare(b.creada))
        .slice(0, 3);
    }
    if (/AND \(/.test(sql)) {
      return deEllos.filter(
        (p) =>
          (r.guia && p.shipping_guide === r.guia) ||
          (r.orden && p.dropi_order_id === r.orden) ||
          (r.cola && p.phone.replace(/\D/g, '').slice(-9) === r.cola) ||
          (r.nombre && new RegExp(r.nombre.replace(/%/g, '.*'), 'i').test(`${p.name} ${p.surname}`)),
      );
    }
    throw new Error(`consulta sin respuesta de mentira: ${sql.slice(0, 80)}`);
  };
  return { consultar, log };
}

(async () => {
  console.log('\n1. De quién lee');
  {
    const b = baseMentira();
    const r = await pedidosDropi(TEL, { consultar: b.consultar, ahora: AHORA });
    prueba('lee sus pedidos', r.estado === 'leido', JSON.stringify(r).slice(0, 200));
    prueba('todas las consultas son SELECT', b.log.every((q) => /^\s*SELECT/i.test(q.sql)));
    const ids = b.log.filter((q) => /dropi_orders_cache/.test(q.sql)).map((q) => q.r.ids);
    prueba('solo lee las conexiones de su cuenta', ids.length > 0 && ids.every((x) => x.every((id) => [500, 501].includes(id))), JSON.stringify(ids));
    prueba('nunca sale el pedido de otra cuenta', !r.texto.includes('9999') && !r.texto.includes('Ajeno'));
    prueba('no consulta la cuenta propia (265) como si fuera de él', b.log.filter((q) => /SELECT id FROM configuraciones/.test(q.sql)).every((q) => !q.sql.includes(':propia') || q.r.propia));
  }
  {
    const b = baseMentira();
    const r = await pedidosDropi('593900000000', { consultar: b.consultar, ahora: AHORA });
    prueba('número sin cuenta: pide el dato y no lee pedidos', r.estado === 'sin_cuenta' && !b.log.some((q) => /dropi_orders_cache/.test(q.sql)), r.estado);
  }
  {
    const b = baseMentira({ usuarios: [{ id_usuario: 77, pais: '593', lead: '987654321' }, { id_usuario: 88, pais: '593', lead: '987654321' }] });
    const r = await pedidosDropi(TEL, { consultar: b.consultar, ahora: AHORA });
    prueba('número en dos cuentas: no lee ninguna', r.estado === 'ambiguo' && !b.log.some((q) => /dropi_orders_cache/.test(q.sql)), r.estado);
  }
  {
    olvidarDatosProbados();
    const b = baseMentira();
    const r = await pedidosDropi('593900000000', { consultar: b.consultar, ahora: AHORA, dato: '0987654321', mensaje: 'mi número es 0987654321' });
    prueba('con el número que escribió en el chat: lee y lo dice', r.estado === 'leido' && r.por === 'dato', r.estado);
    const b2 = baseMentira();
    const r2 = await pedidosDropi('593900000000', { consultar: b2.consultar, ahora: AHORA, dato: '0987654321', mensaje: 'revisa mis pedidos' });
    prueba('un dato que no escribió no vale', r2.estado === 'pide_dato' && !b2.log.some((q) => /dropi_orders_cache/.test(q.sql)), r2.estado);
  }
  {
    const b = baseMentira({ integraciones: [] });
    const r = await pedidosDropi(TEL, { consultar: b.consultar, ahora: AHORA });
    prueba('sin Dropi conectado: el texto fijo', r.estado === 'sin_dropi' && r.texto === T.DROPI.sin_dropi, r.estado);
  }
  {
    const b = baseMentira({ integraciones: [{ id_configuracion: 500, country_code: 'EC', is_active: 0 }] });
    const r = await pedidosDropi(TEL, { consultar: b.consultar, ahora: AHORA });
    prueba('conexión apagada: lo avisa y lee solo esa', r.estado === 'leido' && r.texto.includes(T.DROPI.integracion_apagada) && !r.texto.includes('9003'));
  }
  {
    const b = baseMentira({ falla: 'dropi_orders_cache' });
    const r = await pedidosDropi(TEL, { consultar: b.consultar, ahora: AHORA });
    prueba('la base falla: error, no «no hay pedidos»', r.estado === 'error' && r.texto === T.DROPI.error, r.estado);
  }
  {
    const lenta = async () => new Promise((res) => setTimeout(() => res([]), 500));
    const r = await pedidosDropi(TEL, { consultar: lenta, ahora: AHORA, limite_ms: 50 });
    prueba('la base no contesta: error a tiempo', r.estado === 'error');
  }

  console.log('\n2. Qué muestra');
  {
    const b = baseMentira();
    const r = await pedidosDropi(TEL, { consultar: b.consultar, ahora: AHORA });
    const t = r.texto;
    prueba('el conteo por estado (sin las reemplazadas)', /5 pedidos/.test(t) && /1 con novedad/.test(t) && /1 entregados/.test(t), t.split('\n')[1]);
    prueba('la novedad primero, con lo que dice', t.indexOf('9001') < t.indexOf('9002') && t.includes('DESTINATARIO NO CONTESTA'));
    prueba('la fecha del último movimiento', t.includes('27-oct'));
    prueba('cuántos días lleva', /9002[^\n]*lleva 9 días/.test(t), t);
    prueba('la guía y el rastreo', t.includes('GTC778899') && /rastreo: https?:\/\//.test(t));
    prueba('la agencia de retiro', t.includes('Agencia Servientrega La Carolina'));
    prueba('del cliente final, nombre, inicial y ciudad; sin teléfono', t.includes('Ana P. (QUITO)') && !t.includes('0991234567') && !t.includes('Pérez'));
    prueba('no lista los entregados ni las devoluciones', !t.includes('#9004') && !t.includes('#9006'));
    prueba('las devoluciones sí se cuentan', /1 en devolución/.test(t));
    prueba('cuándo se actualizó', t.includes('actualizado el 27-oct a las 11:58'));
    prueba('el bloque lleva la instrucción; el texto no', bloquePedidosDropi(r).includes(T.DROPI.instruccion) && !t.includes(T.DROPI.instruccion));
    prueba('cabe en un mensaje', t.length <= 1400);
  }

  console.log('\n3. Buscar');
  {
    const c = condicionBuscar('GTC778899');
    prueba('una guía con letras busca por guía', c && c.vals.guia === 'GTC778899' && !c.vals.orden);
    const c2 = condicionBuscar('#9001');
    prueba('«#9001» busca por pedido', c2 && c2.vals.orden === 9001);
    const c3 = condicionBuscar('0991234567');
    prueba('un teléfono busca por la cola de 9', c3 && c3.vals.cola === '991234567');
    const c4 = condicionBuscar('Luis Mora');
    prueba('un nombre busca por nombre', c4 && c4.vals.nombre === '%Luis%Mora%');
    prueba('vacío o muy corto no busca', condicionBuscar('') === null && condicionBuscar('ab') === null);
    const b = baseMentira();
    const r = await pedidosDropi(TEL, { consultar: b.consultar, ahora: AHORA, buscar: '1234567890' });
    prueba('busca la guía solo en sus pedidos', r.modo === 'buscar' && r.texto.includes('9002') && !r.texto.includes('9999'), r.texto);
    const r2 = await pedidosDropi(TEL, { consultar: baseMentira().consultar, ahora: AHORA, buscar: 'Luis Mora' });
    prueba('por nombre de su cliente', r2.encontrados === 1 && r2.texto.includes('9002'));
    const r4 = await pedidosDropi(TEL, { consultar: baseMentira().consultar, ahora: AHORA, buscar: '#9006' });
    prueba('una devolución se encuentra buscándola, con sus productos', r4.encontrados === 1 && r4.texto.includes('Tabla de Picar, Cuchillo') && !r4.texto.includes('["'));
    const r3 = await pedidosDropi(TEL, { consultar: baseMentira().consultar, ahora: AHORA, buscar: '7777777777' });
    prueba('sin coincidencias lo dice', r3.encontrados === 0 && r3.texto.includes('No encontré un pedido'));
  }

  console.log('\n4. Herramienta, bandera y guardia');
  {
    const conBandera = normalizarSoporteExpertos({ herramientas: true, dropi: true });
    const sinH = normalizarSoporteExpertos({ herramientas: false, dropi: true });
    const sinB = normalizarSoporteExpertos({ herramientas: true });
    prueba('la bandera solo con herramientas', conBandera.dropi === true && sinH.dropi === false && sinB.dropi === false);
    prueba('apagada por defecto', normalizarSoporteExpertos(true).dropi === false);
    const b = baseMentira();
    const h = crearHerramientas({ telefono: TEL, mensaje: 'mis pedidos no llegan', canalVerificable: true, dropi: true, deps: { consultarImporchat: b.consultar, ahora: AHORA } });
    const herr = h.lista.find((x) => x.definicion.name === 'ver_mis_pedidos_dropi');
    prueba('aparece con la bandera', Boolean(herr));
    prueba('no aparece sin la bandera', !crearHerramientas({ telefono: TEL, canalVerificable: true }).lista.some((x) => x.definicion.name === 'ver_mis_pedidos_dropi'));
    const salida = await herr.ejecutar({});
    prueba('devuelve el bloque y lo guarda', salida.includes('#9001') && h.pedidosDropiConsultados()?.estado === 'leido');
    const h2 = crearHerramientas({ telefono: TEL, canalVerificable: false, dropi: true, deps: { consultarImporchat: b.consultar } });
    const s2 = await h2.lista.find((x) => x.definicion.name === 'ver_mis_pedidos_dropi').ejecutar({});
    prueba('canal no verificable: no lee', /No se pueden consultar los pedidos/.test(s2));
    prueba('el modelo no puede elegir la cuenta', Object.keys(herr.definicion.input_schema.properties).sort().join(',') === 'buscar,dato');
    prueba('la sección del prompt nombra la herramienta', SECCION_DROPI.includes('ver_mis_pedidos_dropi'));

    const r = h.pedidosDropiConsultados();
    const hechos = { respaldo: { firme: '', estado: '' }, textoSeguro: T.MENSAJE_ASESOR };
    sumarHechosHerramientas(hechos, [salida], null, { mensaje: 'mi pedido de dropi no llega', pedidosDropi: r });
    prueba('lo leído entra al respaldo de la guardia', hechos.respaldo.firme.includes('GTC778899'));
    prueba('si la guardia rechaza, el texto seguro es lo leído', hechos.textoSeguro === r.texto);
    const hechos2 = { respaldo: { firme: '', estado: '' }, textoSeguro: T.MENSAJE_ASESOR };
    sumarHechosHerramientas(hechos2, [salida], null, { mensaje: 'cuándo llega mi contenedor', pedidosDropi: r });
    prueba('si preguntaba otra cosa, se queda el asesor', hechos2.textoSeguro === T.MENSAJE_ASESOR);
    prueba('detecta preguntas de pedidos', hablaDePedidosDropi('la guía de mi cliente no se mueve') && hablaDePedidosDropi('mis pedidos de Dropi') && !hablaDePedidosDropi('cuándo llega mi contenedor'));
  }
  prueba('fecha corta', dia('2026-10-27T10:51:30') === '27-oct' && dia('') === '');

  console.log(fallos ? `\nFALLAN ${fallos} (pasan ${ok})` : `\nTODO BIEN: ${ok} pasan, 0 fallan`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
