/* Pruebas de la cotización de México en BORRADOR del bot de Expertos
   (soporteExpertos/cotizacionMexico.js + armar_cotizacion_mexico en herramientas.js
   + la nota del borrador en escalado.js). Sin red ni base: todo son dobles.
   Uso: node scripts/probar_soporte_expertos_cotizacion_mx.js */

'use strict';

const path = require('path');
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

const C = require('../src/utils/soporteExpertos/cotizacionMexico');
const { crearHerramientas } = require('../src/utils/soporteExpertos/herramientas');
const { escalarCaso, esPase } = require('../src/utils/soporteExpertos/escalado');
const T = require('../src/utils/soporteExpertos/textos');
const ajustes = require('../src/utils/ajustesIA');
const { SECCION_COTIZACION_MX } = require('../src/utils/prompt_soporte_expertos.data');

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

const MX = '5215512345678';
const EC = '593987000111';
const cerca = (a, b) => Math.abs(a - b) < 0.011;

// Lámparas: 1.000 u, 50 por caja, caja 50×40×30 cm → 20 cajas × 0,06 = 1,2 CBM.
const LAMPARA = {
  nombre: 'Lámpara LED',
  cantidad: 1000,
  precio_unitario: 2.1,
  moneda: 'USD',
  envio_yiwu: 30,
  unidades_por_caja: 50,
  medidas_caja_cm: { largo: 50, ancho: 40, alto: 30 },
};

(async () => {
  console.log('1. Escala de Pricing (27-oct): 1=750 · 2=1.300 · 3=1.500 · 4=1.600, +400 por CBM sobre 4');
  const f = C.fleteMexico;
  prueba('los cuatro puntos de la escala', f(1) === 750 && f(2) === 1300 && f(3) === 1500 && f(4) === 1600);
  prueba('bajo 1 CBM es proporcional a 750 (0,5 → 375; 0,026 → 19,5)', f(0.5) === 375 && cerca(f(0.026), 19.5));
  prueba('entre puntos se interpola (1,5 → 1.025; 1,96 → 1.278; 3,5 → 1.550)', f(1.5) === 1025 && f(1.96) === 1278 && f(3.5) === 1550);
  prueba('sobre 4 CBM sin salto: 4,03 → 1.612 (cot 1421); 9,66 → 3.864 (cot 1387)', f(4.03) === 1612 && f(9.66) === 3864);
  prueba('0, negativo o basura → 0', f(0) === 0 && f(-2) === 0 && f('x') === 0);
  let sube = true;
  for (let c = 0.01; c < 12; c += 0.01) if (f(c + 0.01) < f(c)) sube = false;
  prueba('nunca baja al subir el volumen', sube);

  console.log('\n2. La cuenta de una cotización completa');
  let r = C.armarCotizacionMexico({ pais: 'mx', productos: [LAMPARA] });
  prueba('sale bien', r.ok, JSON.stringify(r));
  prueba('CBM de las medidas: 20 cajas × 0,06 = 1,2', r.cbm === 1.2 && /20 cajas × 0,06 m³/.test(r.productos[0].como_cbm), r.productos?.[0]?.como_cbm);
  prueba('flete 1,2 CBM = 860', r.flete === 860);
  prueba('total = 2.100 mercadería + 30 envío a Yiwu + 860 flete = 2.990', r.total === 2990 && r.mercaderia === 2100 && r.envios_yiwu === 30);
  prueba('costo por unidad 2,99', r.productos[0].por_unidad === 2.99);

  r = C.armarCotizacionMexico({
    pais: 'México',
    productos: [
      { ...LAMPARA },
      { nombre: 'Organizador', cantidad: 200, precio_unitario: 1.5, moneda: 'USD', envio_incluido: true, cbm_total: 0.8 },
    ],
  });
  prueba('dos productos: 1,2 + 0,8 = 2 CBM → flete 1.300', r.ok && r.cbm === 2 && r.flete === 1300);
  prueba('el flete se reparte por CBM (60 % / 40 %) y suma el total', r.productos[0].flete === 780 && r.productos[1].flete === 520);
  prueba('envío incluido cuenta 0', r.productos[1].envio_yiwu_usd === 0 && r.productos[1].envio_incluido);

  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, cantidad: 1010 }] });
  prueba('1.010 u en cajas de 50 → 21 cajas y aviso de caja incompleta', r.ok && r.cbm === 1.26 && r.avisos.some((a) => /21 cajas/.test(a)));

  console.log('\n3. Lo que falta: el bot lo pide, no inventa');
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ nombre: 'Lámpara', cantidad: 500 }] });
  const faltan = (r.faltan || []).join(' | ');
  prueba('sin precio, sin envío y sin volumen → los tres en la lista', !r.ok && /precio EXW/.test(faltan) && /Yiwu/.test(faltan) && /CBM o medidas/.test(faltan), faltan);
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, unidades_por_caja: undefined }] });
  prueba('medidas sin unidades por caja → pide unidades por caja', !r.ok && /unidades por caja/.test(r.faltan.join()));
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, medidas_caja_cm: { largo: 0.5, ancho: 0.4, alto: 0.3 } }] });
  prueba('medidas en metros (0,5 × 0,4 × 0,3) → no las usa, las vuelve a pedir en cm', !r.ok && /no cuadran/.test(r.faltan.join()));
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, medidas_caja_cm: undefined, cbm_por_caja: 6 }] });
  prueba('CBM de caja imposible (6 m³) → lo vuelve a pedir', !r.ok && /no cuadra con una caja/.test(r.faltan.join()));
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [] });
  prueba('sin productos → pide qué producto es', !r.ok && /qué producto/.test(r.faltan.join()));
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, moneda: 'EUR' }] });
  prueba('moneda que no es USD ni RMB → pregunta la moneda', !r.ok && /dólares o en yuanes/.test(r.faltan.join()));

  console.log('\n4. Solo México');
  prueba('Ecuador → no es México (sigue a mano)', C.armarCotizacionMexico({ pais: 'ec', productos: [LAMPARA] }).noEsMexico === true);
  prueba('sin país → no es México', C.armarCotizacionMexico({ productos: [LAMPARA] }).noEsMexico === true);

  console.log('\n5. Yuanes y avisos para el asesor');
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, precio_unitario: 13.6, moneda: 'RMB', envio_yiwu: 68 }] }, { tasaYuan: 6.8 });
  prueba('13,6 RMB / 6,8 = 2 USD; envío 68 RMB = 10 USD', r.ok && r.productos[0].precio_usd === 2 && r.productos[0].envio_yiwu_usd === 10 && r.productos[0].precio_original === '13.6 RMB');
  prueba('aviso de la tasa usada', r.avisos.some((a) => /6,8 RMB por USD/.test(a)));
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, moneda: 'RMB' }] }, { tasaYuan: null });
  prueba('yuanes sin tasa → no calcula (sinTasa)', !r.ok && r.sinTasa === true);
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ ...LAMPARA, medidas_caja_cm: undefined, cbm_total: 18 }] });
  prueba('más de 15 CBM → aviso de carga grande', r.ok && r.avisos.some((a) => /Carga grande/.test(a)));
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [{ nombre: 'Relojes', cantidad: 100, precio_unitario: 40, moneda: 'USD', envio_incluido: true, cbm_total: 0.1 }] });
  prueba('mercadería cara por m³ → aviso de impuestos dentro del flete', r.ok && r.avisos.some((a) => /alto valor/.test(a)));
  prueba('menos de 1 CBM → aviso: sin mínimo (se prorratea) y lo ideal es completar 1 CBM', r.avisos.some((a) => /sin mínimo/.test(a) && /complete 1 CBM: le quedan/.test(a)), JSON.stringify(r.avisos));
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [LAMPARA] }, { paisTelefono: 'ec' });
  prueba('WhatsApp de Ecuador cotizando a México → aviso (caso 1788)', r.avisos.some((a) => /WhatsApp del cliente es de EC/.test(a)));

  console.log('\n6. La nota del borrador y el texto para el cliente');
  r = C.armarCotizacionMexico({ pais: 'mx', productos: [LAMPARA] });
  const nota = C.notaBorrador(r);
  prueba('dice que es BORRADOR y que el cliente no lo ve', /BORRADOR/.test(nota) && /todavía NO lo ve/.test(nota));
  prueba('trae el detalle y el texto listo para enviar', /Lámpara LED: 1000 u × 2,10 USD/.test(nota) && /Texto para el cliente:/.test(nota) && /Total puesto en México: 2\.990,00 USD/.test(nota), nota);
  const tc = C.textoParaCliente(r);
  prueba('texto al cliente: costo por unidad, CBM, flete y total', /1000 u → 2,99 USD c\/u/.test(tc) && /1,2 CBM → flete 860,00 USD/.test(tc));
  prueba('texto al cliente en tuteo, sin voseo', !/\b(tenés|podés|querés|mirá|fijate)\b/i.test(nota + tc));

  console.log('\n7. La herramienta en el bot');
  let hs = crearHerramientas({ telefono: MX, canalVerificable: true });
  prueba('sin la bandera: no se ofrece', !hs.lista.some((x) => x.definicion.name === 'armar_cotizacion_mexico'));
  hs = crearHerramientas({ telefono: MX, canalVerificable: true, cotizacionMx: true });
  const herr = () => hs.lista.find((x) => x.definicion.name === 'armar_cotizacion_mexico');
  prueba('con la bandera: se ofrece', Boolean(herr()));
  const claves = [];
  (function recorrer(o) { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'properties') claves.push(...Object.keys(v)); recorrer(v); } })(herr().definicion.input_schema);
  prueba('el esquema no tiene ningún dato de identidad', claves.length > 5 && !claves.some((k) => /telefono|correo|cliente|cedula|usuario/.test(k)), claves.join());
  let salida = await herr().ejecutar({ pais: 'mx', productos: [{ nombre: 'Lámpara', cantidad: 500 }] });
  prueba('faltan datos → se los pide, no pasa el caso', /Todavía faltan/.test(salida) && hs.paseConsultado() === null && hs.borradorCotizacion() === null, salida);
  salida = await herr().ejecutar({ pais: 'mx', productos: [LAMPARA] });
  prueba('completo → responde el texto de «ya tengo todo»', salida === `Responde exactamente: ${T.MENSAJE_COTIZACION_LISTA}`, salida);
  prueba('…ese texto cuenta como pase (va al área de precios)', esPase(T.MENSAJE_COTIZACION_LISTA) && hs.paseConsultado() === 'cotizacion');
  prueba('…el modelo NO ve ningún precio (no puede filtrarlo al cliente)', !/\d/.test(salida.replace(T.MENSAJE_COTIZACION_LISTA, '')) && !/2990|2\.990|860/.test(salida));
  prueba('…queda el borrador para la nota y un resumen corto', /BORRADOR/.test(hs.borradorCotizacion()) && /México · 1 producto\(s\) · 1,2 CBM · borrador de 2\.990,00 USD/.test(hs.resumenPase()), hs.resumenPase());
  hs = crearHerramientas({ telefono: MX, canalVerificable: true, cotizacionMx: true });
  salida = await herr().ejecutar({ pais: 'ec', productos: [LAMPARA] });
  prueba('Ecuador → le dice que use pasar_a_humano, sin borrador', /solo para México/.test(salida) && !hs.borradorCotizacion());

  const sqls = [];
  hs = crearHerramientas({
    telefono: MX, canalVerificable: true, cotizacionMx: true,
    deps: { consultar: async (sql) => { sqls.push(sql); return [{ valor: '6.8' }]; } },
  });
  await herr().ejecutar({ pais: 'mx', productos: [{ ...LAMPARA, precio_unitario: 13.6, moneda: 'RMB', envio_yiwu: 68 }] });
  prueba('en yuanes lee la tasa de Imporsuit (solo un SELECT)', sqls.length === 1 && /^SELECT valor FROM cotizadorpro_parametros/.test(sqls[0]) && /13.6 RMB/.test(hs.borradorCotizacion()));
  hs = crearHerramientas({ telefono: MX, canalVerificable: true, cotizacionMx: true, deps: { consultar: async () => { sqls.push('x'); return []; } } });
  const antes = sqls.length;
  await herr().ejecutar({ pais: 'mx', productos: [LAMPARA] });
  prueba('en dólares no consulta nada', sqls.length === antes);
  hs = crearHerramientas({ telefono: MX, canalVerificable: true, cotizacionMx: true, deps: { consultar: async () => { throw new Error('base caída'); } } });
  salida = await herr().ejecutar({ pais: 'mx', productos: [{ ...LAMPARA, moneda: 'RMB' }] });
  prueba('sin tasa (base caída) → pasa al área de precios sin borrador', salida === `Responde exactamente: ${T.MENSAJE_COTIZACION_LISTA}` && !hs.borradorCotizacion() && /yuanes/.test(hs.resumenPase()));
  hs = crearHerramientas({ telefono: EC, canalVerificable: true, cotizacionMx: true });
  await herr().ejecutar({ pais: 'mx', productos: [LAMPARA] });
  prueba('WhatsApp de Ecuador → el borrador avisa que confirme el destino', /WhatsApp del cliente es de EC/.test(hs.borradorCotizacion() || ''));

  console.log('\n8. La nota en el chat (escalado)');
  const notas = [];
  const deps = {
    consultar: async (sql) => (/^\s*select/i.test(sql) ? [{ id: 12, id_encargado: 378, suspendido: 0 }] : []),
    crearHistorial: async () => {},
    crearNota: async (t) => notas.push(t),
    emitir: () => {},
  };
  const borrador = C.notaBorrador(C.armarCotizacionMexico({ pais: 'mx', productos: [LAMPARA] }));
  await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 12, telefono: MX, motivo: 'cotizacion', mensaje: 'caja 50x40x30', resumen: 'México · 1 producto(s)', borrador, deps });
  prueba('real: la nota de siempre + la del borrador completo', notas.length === 2 && /Datos que juntó el bot/.test(notas[0]) && notas[1] === borrador, JSON.stringify(notas).slice(0, 300));
  notas.length = 0;
  await escalarCaso({ modo: 'simulado', id_configuracion: 265, id_cliente: 12, telefono: MX, motivo: 'cotizacion', resumen: 'x', borrador, deps });
  prueba('simulado: no escribe ninguna nota', notas.length === 0);
  await escalarCaso({ modo: 'real', id_configuracion: 265, id_cliente: 12, telefono: MX, motivo: 'cotizacion', mensaje: 'hola', resumen: 'Ecuador; lámparas', deps });
  prueba('sin borrador (Ecuador): una sola nota, como antes', notas.length === 1);

  console.log('\n9. Ajustes y prompt');
  const n = (v) => ajustes.normalizar({ soporte_expertos: v }).soporte_expertos.cotizacion_mx;
  prueba('sin la clave: apagado', n({ herramientas: true }) === false);
  prueba('cotizacion_mx sin herramientas: apagado', n({ cotizacion_mx: true }) === false);
  prueba('herramientas + cotizacion_mx: encendido', n({ herramientas: true, cotizacion_mx: true }) === true);
  prueba('true (todo) la deja apagada', ajustes.normalizar({ soporte_expertos: true }).soporte_expertos.cotizacion_mx === false);
  prueba('la sección del prompt prohíbe dar precios y deja Ecuador como antes', /Nunca le digas un precio/.test(SECCION_COTIZACION_MX) && /Para Ecuador/.test(SECCION_COTIZACION_MX));

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
