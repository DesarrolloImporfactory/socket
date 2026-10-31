#!/usr/bin/env node
/**
 * scripts/espiaMercado.js — herramientas del Espía de mercado (Dropkiller propio).
 *
 *   node scripts/espiaMercado.js probar
 *       Pruebas del cálculo puro (utils/espiaMercadoCalc). No toca la BD.
 *
 *   node scripts/espiaMercado.js tablas
 *       Crea las tablas espia_* si no existen (CREATE TABLE IF NOT EXISTS).
 *
 *   node scripts/espiaMercado.js mock-generar --dir <carpeta> [--pais QA] [--escenario 1|2] [--paginas 3]
 *       Escribe respuestas de /products/index inventadas con la forma real de
 *       Dropi. Escenario 1 = foto inicial; escenario 2 = la misma tienda un día
 *       después (bajas de stock = ventas, subidas = reabastecimientos, una
 *       bodega que desaparece = bajada a 0, un producto nuevo).
 *
 *   node scripts/espiaMercado.js pasada --pais QA --mock <carpeta> [--max-paginas N]
 *       Corre una pasada con respuestas guardadas (en local no hay Dropi: la
 *       IP no está en la lista blanca). También sirven tus respuestas reales
 *       guardadas: cualquier .json con {objects:[...]} o un arreglo de productos.
 *
 *   node scripts/espiaMercado.js pasada --pais EC [--max-paginas N]
 *       Pasada real contra Dropi (solo en el servidor).
 *
 *   node scripts/espiaMercado.js estado --pais EC
 *   node scripts/espiaMercado.js reporte --pais EC [--enviar]
 *   node scripts/espiaMercado.js limpiar --pais QA --si
 *       Borra TODO lo del país (solo pensado para QA).
 */
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, def) => {
  const i = args.indexOf(`--${n}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

function assert(cond, msg) {
  if (!cond) throw new Error(`FALLÓ: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function probar() {
  const calc = require('../src/utils/espiaMercadoCalc');
  console.log('Pruebas de espiaMercadoCalc');
  assert(JSON.stringify(calc.ventasDelTramo(10, 7)) === '[3,false]', '10→7 = 3 ventas');
  assert(JSON.stringify(calc.ventasDelTramo(7, 50)) === '[0,true]', '7→50 = reabastecimiento');
  assert(JSON.stringify(calc.ventasDelTramo(5, 5)) === '[0,false]', '5→5 = nada');
  assert(JSON.stringify(calc.ventasDelTramo(null, 40)) === '[0,false]', 'primera vez = nada');
  const vp = calc.ventasProducto([[20, 10], [0, 50]]);
  assert(vp.ventas === 10 && vp.reabastecimientos === 1, 'dos bodegas: 10 ventas y 1 reab (no se suma)');
  assert(calc.fechaDeCarga(new Date('2026-10-27T17:15:00Z'), 'EC') === '2026-10-27', 'EC 17:15Z → 27');
  assert(calc.fechaDeCarga(new Date('2026-10-28T03:00:00Z'), 'EC') === '2026-10-27', 'EC 03:00Z → 27 (22:00 local)');
  assert(calc.fechaDeCarga(new Date('2026-10-28T05:30:00Z'), 'MX') === '2026-10-27', 'MX 05:30Z → 27 (23:30 local)');
  const simple = { id: 1, warehouse_product: [{ warehouse_id: 301, stock: 5 }, { warehouse_id: 302, stock: 7 }] };
  assert(calc.clavesDeProducto(simple).length === 2, 'SIMPLE: 2 claves');
  const variable = {
    id: 2,
    variations: [
      { id: 11, warehouse_product_variation: [{ warehouse_id: 301, stock: 3 }] },
      { id: 12, warehouse_product_variation: [{ warehouse_id: 301, stock: 4 }, { warehouse_id: 302, stock: 1 }] },
    ],
    warehouse_product: [{ warehouse_id: 301, stock: 99 }],
  };
  const cv = calc.clavesDeProducto(variable);
  assert(cv.length === 3 && cv.every((c) => c.variacion_id !== 0), 'VARIABLE: claves por variación, ignora el total');
  const previas = new Map([['301:0', 10], ['302:0', 4], ['303:0', 0]]);
  const r = calc.resumirProducto(previas, [{ warehouse_id: 301, variacion_id: 0, stock: 6 }]);
  assert(r.ventas === 8 && r.stockTotal === 6, 'bodega omitida con stock 4 cuenta como bajada a 0 (4+4=8), la que ya estaba en 0 no');
  assert(r.cambios.length === 2, 'dos cambios: la que bajó y la que desapareció');
  assert(calc.normalizarNombre('¡Cepillo a Vapor para Mascotas! (NUEVO)') === 'cepillo a vapor mascotas', 'normaliza nombre');
  assert(
    calc.sonIguales({ pais: 'EC', proveedor_id: 1, nombre: 'Cepillo a vapor mascotas' }, { pais: 'EC', proveedor_id: 2, nombre: 'CEPILLO A VAPOR PARA MASCOTAS' }),
    'mismo producto en otro proveedor',
  );
  assert(!calc.sonIguales({ pais: 'EC', proveedor_id: 1, nombre: 'x' }, { pais: 'EC', proveedor_id: 1, nombre: 'x' }), 'mismo proveedor no cuenta');
  console.log('Todo OK');
}

/* ---------- mock ---------- */
const NOMBRES = [
  'Cepillo a vapor para mascotas', 'Parches adelgazantes Slim Patch caja x30', 'Base enderezadora de postura',
  'Rollo para colorear 3 metros', 'Oferta flash Iron Seal antióxido', 'Cajas parches para pies desintoxicantes',
  'Masajeador cervical eléctrico', 'Lámpara de luna 3D', 'Organizador de maquillaje giratorio', 'Mini proyector portátil HD',
  'Reloj inteligente serie 9', 'Audífonos inalámbricos Pro', 'Corrector de postura magnético', 'Set de cuchillos de cocina',
  'Cámara de seguridad wifi 360', 'Plancha alisadora de cabello', 'Freidora de aire 5 litros', 'Licuadora portátil USB',
  'Mochila antirrobo', 'Zapatillas ortopédicas', 'Faja reductora colombiana', 'Kit de brochas 12 piezas',
  'Botella térmica 1 litro', 'Juego de sábanas 3 piezas', 'Aspiradora inalámbrica', 'Tapete yoga antideslizante',
  'Lámpara LED recargable', 'Silla gamer', 'Soporte para celular de auto', 'Termo con infusor',
  'Peluche gigante 1 metro', 'Kit de herramientas 46 piezas', 'Pistola de masaje muscular', 'Gafas de sol polarizadas',
  'Humidificador aromático', 'Cargador inalámbrico 3 en 1', 'Teclado mecánico RGB', 'Mouse ergonómico vertical',
  'Báscula inteligente', 'Depiladora láser IPL',
];
const PROVEEDORES = [
  [1001, 'IMPORSHOP'], [1002, 'Global Outlet'], [1003, 'Tendencias EC'], [1004, 'Importaverimax'], [1005, 'MegaDrop'],
  [1006, 'Droplatam'], [1007, 'Winpy'],
];
const BODEGAS = [301, 10425, 8611, 21513];
const CATS = ['Hogar', 'Belleza', 'Tecnología', 'Mascotas', 'Salud', 'Deportes'];

function mockProducto(i, escenario) {
  const nombre = NOMBRES[i % NOMBRES.length];
  const id = 148000 + i;
  const prov = PROVEEDORES[i % PROVEEDORES.length];
  const variable = i % 5 === 0;
  const semilla = (i * 7919) % 97;
  // escenario 2: cambios respecto al 1
  const baja = escenario === 2 ? (i % 3 === 0 ? 3 + (i % 9) : i % 3 === 1 ? 1 : 0) : 0;
  const sube = escenario === 2 && i % 10 === 4 ? 60 : 0;
  const stockBase = 50 + semilla;
  const wp = (w, k) => ({
    id: id * 10 + k,
    warehouse_id: w,
    product_id: id,
    stock: Math.max(0, stockBase - k * 11 - baja + sube),
  });
  const bodegas = BODEGAS.slice(0, 1 + (i % 3));
  // escenario 2: en los múltiplos de 7 desaparece la última bodega (Dropi omite las que quedan en 0)
  const bodegasHoy = escenario === 2 && i % 7 === 6 && bodegas.length > 1 ? bodegas.slice(0, -1) : bodegas;
  const p = {
    id,
    name: nombre + (i >= NOMBRES.length ? ` ${Math.floor(i / NOMBRES.length) + 1}` : ''),
    type: variable ? 'VARIABLE' : 'SIMPLE',
    sale_price: String(8 + (i % 30)),
    suggested_price: String(19.9 + (i % 30) * 1.5),
    privated_product: false,
    sku: `SKU-${id}`,
    external_id: i % 4 === 0 ? `EXT-${nombre.length}-${i % 6}` : null,
    user: { id: prov[0], name: prov[1] },
    categories: [{ id: 1 + (i % CATS.length), name: CATS[i % CATS.length] }],
    gallery: [{ url: null, main: true, urlS3: `products/${id}/main.jpg` }],
    variations: [],
    warehouse_product: [],
  };
  if (variable) {
    p.variations = [1, 2].map((v) => ({
      id: id * 100 + v,
      name: v === 1 ? 'Talla M' : 'Talla L',
      warehouse_product_variation: bodegasHoy.map((w, k) => ({ ...wp(w, k + v), variation_id: id * 100 + v })),
    }));
    p.warehouse_product = bodegasHoy.map((w, k) => ({ ...wp(w, k), stock: 999 })); // total sin usar
  } else {
    p.warehouse_product = bodegasHoy.map((w, k) => wp(w, k));
  }
  return p;
}

function mockGenerar() {
  const dir = opt('dir');
  if (!dir || dir === true) throw new Error('Falta --dir <carpeta>');
  const pais = String(opt('pais', 'QA')).toUpperCase();
  const escenario = Number(opt('escenario', 1));
  const paginas = Number(opt('paginas', 3));
  const base = path.join(dir, pais);
  fs.mkdirSync(base, { recursive: true });
  for (const f of fs.readdirSync(base)) if (f.endsWith('.json')) fs.unlinkSync(path.join(base, f));
  let total = 0;
  for (let pg = 0; pg < paginas; pg++) {
    const objects = [];
    for (let k = 0; k < 40; k++) {
      const i = pg * 40 + k;
      // escenario 2: el último producto de la última página es nuevo (no existía)
      if (escenario === 1 && pg === paginas - 1 && k === 39) continue;
      objects.push(mockProducto(i, escenario));
    }
    total += objects.length;
    fs.writeFileSync(path.join(base, `page_${String(pg + 1).padStart(3, '0')}.json`), JSON.stringify({ isSuccess: true, status: 200, objects }, null, 1));
  }
  console.log(`Escenario ${escenario}: ${paginas} páginas, ${total} productos en ${base}`);
}

/* ---------- BD ---------- */
async function conBD(fn) {
  const { db } = require('../src/database/config');
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

async function tablas() {
  await conBD(async () => {
    const modelos = require('../src/models/espia_mercado.model');
    for (const m of Object.values(modelos)) {
      await m.sync();
      console.log(`  tabla ${m.getTableName()} lista`);
    }
  });
}

async function pasada() {
  const pais = String(opt('pais', 'EC')).toUpperCase();
  const mock = opt('mock', process.env.ESPIA_MOCK_DIR);
  const maxPaginas = Number(opt('max-paginas', 0));
  await conBD(async () => {
    const espia = require('../src/services/espia_mercado.service');
    const r = await espia.pasada(pais, {
      fuente: mock ? 'mock' : 'dropi',
      mockDir: mock === true ? process.env.ESPIA_MOCK_DIR : mock,
      maxPaginas,
    });
    console.log(JSON.stringify(r, null, 2));
  });
}

async function estado() {
  const pais = String(opt('pais', 'EC')).toUpperCase();
  await conBD(async () => {
    const espia = require('../src/services/espia_mercado.service');
    console.log(JSON.stringify(await espia.estado(pais), null, 2));
    const top = await espia.listarProductos({ pais, atajo: 'todos', orden: 'v7', limit: 10 });
    console.log(`\nTop 10 por ventas 7d (${top.total} productos):`);
    for (const p of top.items) {
      console.log(`  ${p.dropi_product_id} · ${p.nombre} · ${p.proveedor_nombre} · 1d ${p.ventas_1d} · 7d ${p.ventas_7d} · 30d ${p.ventas_30d} · total ${p.ventas_total} · stock ${p.stock_actual} · reab ${p.reabastecimientos} · iguales ${p.n_iguales}`);
    }
  });
}

async function reporte() {
  const pais = String(opt('pais', 'EC')).toUpperCase();
  await conBD(async () => {
    const espia = require('../src/services/espia_mercado.service');
    if (opt('enviar')) console.log(JSON.stringify(await espia.enviarReporteWhatsapp(pais), null, 2));
    else console.log((await espia.reporte(pais)).texto);
  });
}

async function limpiar() {
  const pais = String(opt('pais', '')).toUpperCase();
  if (!pais) throw new Error('Falta --pais');
  if (!opt('si')) throw new Error(`Esto borra TODO lo del país ${pais}. Confirma con --si`);
  await conBD(async (db) => {
    for (const t of ['espia_ventas_dia', 'espia_stock_foto', 'espia_stock_actual', 'espia_producto', 'espia_pasada']) {
      const [, meta] = await db.query(`DELETE FROM ${t} WHERE pais = ?`, { replacements: [pais], type: db.QueryTypes.DELETE }).then((r) => [r, r]).catch((e) => { throw e; });
      console.log(`  ${t}: borrado (${meta?.affectedRows ?? '?'} filas)`);
    }
  });
}

(async () => {
  try {
    switch (cmd) {
      case 'probar': probar(); break;
      case 'tablas': await tablas(); break;
      case 'mock-generar': mockGenerar(); break;
      case 'pasada': await pasada(); break;
      case 'estado': await estado(); break;
      case 'reporte': await reporte(); break;
      case 'limpiar': await limpiar(); break;
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
        process.exit(cmd ? 1 : 0);
    }
    process.exit(0);
  } catch (e) {
    console.error('✖', e.message);
    process.exit(1);
  }
})();
