// Prueba de cotización contra la API de integraciones de Dropi MÉXICO.
// Se corre EN EL SERVIDOR DE PRODUCCIÓN (Dropi solo acepta esa IP).
//
// Qué hace (todo de SOLO LECTURA, nunca crea órdenes):
//   1. Muestra qué commit está corriendo en esta carpeta.
//   2. Lee el detalle del producto por integraciones y muestra cómo viene
//      la bodega (warehouse) en México: id, ciudad, zip_code…
//   3. Resuelve estado y ciudad de destino en el catálogo de Dropi.
//   4. Cotiza transportadoras con VARIAS formas del payload y muestra, por
//      cada una, qué respondió cada paquetería (precio o error).
//   5. Guarda todo en /tmp/dropi_mx_prueba.json.
//
// Uso (desde la carpeta de la app, donde está package.json):
//   node scripts/probarDropiMX.js
//   node scripts/probarDropiMX.js --cfg 1024 --producto 72786 --cp 56600 \
//        --ciudad "Chalco De Díaz Covarrubias" --estado "Ciudad de México"
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const { execSync } = require('child_process');
const { db } = require(ROOT + '/src/database/config');
const { decryptToken } = require(ROOT + '/src/utils/cryptoToken');
const dropiService = require(ROOT + '/src/services/dropi.service');
const { matchEnLista } = require(ROOT + '/src/services/dropiAutoOrder.service');

const arg = (k, def) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const CFG = Number(arg('cfg', 1024));
const PRODUCTO = Number(arg('producto', 72786));
const CP = String(arg('cp', '56600'));
const CIUDAD = arg('ciudad', 'Chalco De Díaz Covarrubias');
const ESTADO = arg('estado', 'Ciudad de México');
const PRECIO = Number(arg('precio', 450));
const SALIDA = '/tmp/dropi_mx_prueba.json';

const q = (sql, r = []) => db.query(sql, { replacements: r, type: db.QueryTypes.SELECT });
const limpiar = (v, d = 0) => {
  if (!v || typeof v !== 'object' || d > 6) return v;
  const r = Array.isArray(v) ? [] : {};
  for (const k in v) {
    if (/created_at|updated_at|deleted_at|description|gallery|image|categories|precios|attributes|dropi_app_description/.test(k)) continue;
    if (k === 'zip_codes') { r[k] = `[${(v[k] || []).length} cps]`; continue; }
    r[k] = limpiar(v[k], d + 1);
  }
  return r;
};
const normW = (w) => (Array.isArray(w) ? w[0] || null : w || null);
const buildDepartment = (d) => ({
  id: d.id || d.department_id,
  country_id: d.country_id || 1,
  name: d.name || d.department || d.nombre,
  created_at: d.created_at || null,
  updated_at: d.updated_at || null,
  deleted_at: d.deleted_at || null,
  department_code: d.department_code || null,
});
const resumenCarriers = (resp) =>
  (resp?.objects || resp?.data?.objects || []).map((c) => {
    const o = c.objects || {};
    const precio = Number(o.precioEnvio);
    const msg = o.message || o.msg || o.error || c.message || c.error || '';
    return `${c.distributionCompany?.name || '?'}: ${precio > 0 ? '$' + Math.round(precio) : String(msg || JSON.stringify(c).slice(0, 120)).slice(0, 110)}`;
  });

(async () => {
  const informe = { fecha: new Date().toISOString(), cfg: CFG, producto: PRODUCTO, cp: CP, ciudad: CIUDAD, estado: ESTADO };
  const log = (t, ...rest) => { console.log(t, ...rest); };

  // 1) commit corriendo en esta carpeta
  try {
    informe.commit = execSync('git log -1 --format="%h %ci %s"', { cwd: ROOT }).toString().trim();
  } catch (_) { informe.commit = '(sin git)'; }
  log('1) Commit en esta carpeta:', informe.commit);

  // llave de la cuenta
  const [integ] = await q(
    `SELECT integration_key_enc, country_code FROM dropi_integrations
      WHERE id_configuracion = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [CFG],
  );
  if (!integ) throw new Error(`La cfg ${CFG} no tiene integración Dropi activa`);
  const key = decryptToken(integ.integration_key_enc);
  const cc = integ.country_code;
  log('   cuenta', CFG, 'país', cc, '| llave largo', key.length);
  if (String(cc).toUpperCase() !== 'MX') log('   ⚠️  esta cuenta NO es de México');

  // 2) detalle del producto
  const det = await dropiService.getProductDetail({ integrationKey: key, productId: PRODUCTO, country_code: cc });
  const prod = det?.objects || det?.data?.objects || det?.data || det;
  informe.producto_keys = Object.keys(prod || {});
  const wp0 = prod?.warehouse_product?.[0];
  let w = normW(wp0?.warehouse);
  if (!w?.id && Array.isArray(prod?.variations)) {
    for (const v of prod.variations) for (const wpv of v?.warehouse_product_variation || []) { const wv = normW(wpv?.warehouse); if (wv?.id) { w = wv; break; } }
  }
  informe.warehouse_product_0 = limpiar(wp0);
  informe.bodega_normalizada = limpiar(w);
  log('2) Producto', prod?.id, prod?.name, '| type', prod?.type, '| proveedor user_id', prod?.user_id);
  log('   warehouse_product[0]:', JSON.stringify(limpiar(wp0), null, 1));
  if (!w?.id) log('   ⚠️  el producto NO trae bodega en su detalle');
  const zipBodega = w?.zip_code || w?.city?.zip_code || '';
  log('   bodega id', w?.id, '| zip propio', w?.zip_code, '| zip de su ciudad', w?.city?.zip_code, '| ciudad', w?.city?.name, '| city_id', w?.city_id || w?.city?.id);

  // 3) estado y ciudad de destino
  const statesResp = await dropiService.listStates({ integrationKey: key, country_id: 1, country_code: cc });
  const states = statesResp?.objects || statesResp?.data?.objects || statesResp?.data || [];
  const state = matchEnLista(states, ESTADO, (x) => x.name || x.department || x.nombre);
  if (!state) throw new Error(`No encontré el estado "${ESTADO}" (${states.length} estados)`);
  const citiesResp = await dropiService.listCities({ integrationKey: key, payload: { department_id: Number(state.id), rate_type: 'CON RECAUDO' }, country_code: cc });
  const cities = citiesResp?.objects?.cities || citiesResp?.data?.objects?.cities || citiesResp?.cities || citiesResp?.data?.cities || [];
  const city = matchEnLista(cities, CIUDAD, (x) => x.name || x.city || x.nombre);
  if (!city) throw new Error(`No encontré la ciudad "${CIUDAD}" en ${state.name} (${cities.length} ciudades)`);
  informe.estado = limpiar(state);
  informe.ciudad_destino_catalogo = limpiar(city);
  log('3) Estado', state.id, state.name, '| ciudad', city.id, city.name, '| cod_dane', city.cod_dane, '| zip_code catálogo', city.zip_code, '| zip_codes', (city.zip_codes || []).length);

  const ciudad_destino = { ...city, department: city.department || buildDepartment(state) };

  // ciudad remitente = ciudad de la bodega (si viene) o el destino
  let ciudad_remitente = ciudad_destino;
  if (w?.city?.id) {
    const deptRemit = states.find((d) => Number(d.id || d.department_id) === Number(w.city.department_id));
    ciudad_remitente = { ...w.city, department: w.city.department || (deptRemit ? buildDepartment(deptRemit) : undefined) };
  }

  const bodegaMinima = w?.id && zipBodega ? {
    id: Number(w.id), name: w.name || '', city_id: Number(w.city_id || w.city?.id) || null,
    zip_code: String(zipBodega), address: w.address || w.name || '', phone: w.phone || '', colonia: w.colonia || '', city: w.city || null,
  } : null;

  const base = {
    EnvioConCobro: true,
    ciudad_destino,
    ciudad_remitente,
    products: [{ id: PRODUCTO, quantity: 1, type: 'SIMPLE' }],
    amount: PRECIO,
    peso: 1, largo: 1, ancho: 1, alto: 1,
    zip_code: CP, colonia: null, dir: 'Calle de prueba 123',
    destination_name: 'Prueba ChatCenter', destination_phone: '5512345678',
    insurance: false, ValorDeclarado: PRECIO,
  };

  // 4) variantes
  const variantes = [
    ['A. lo que manda hoy el servidor (bodega mínima con zip)', { ...base, ...(bodegaMinima ? { warehouse: bodegaMinima } : {}) }],
    ['B. bodega solo {id}', { ...base, warehouse: { id: Number(w?.id || wp0?.warehouse_id || 0) } }],
    ['C. bodega tal cual viene en el detalle del producto', { ...base, warehouse: w || undefined }],
    ['D. sin bodega', { ...base }],
    ['E. bodega mínima + products completos del detalle', { ...base, ...(bodegaMinima ? { warehouse: bodegaMinima } : {}), products: [{ ...prod, quantity: 1, price: PRECIO }] }],
    ['F. bodega mínima, remitente = destino', { ...base, ciudad_remitente: ciudad_destino, ...(bodegaMinima ? { warehouse: bodegaMinima } : {}) }],
  ];
  informe.variantes = [];
  log('4) Cotizaciones:');
  for (const [nombre, payload] of variantes) {
    let resp, error;
    try {
      resp = await dropiService.cotizaEnvioTransportadora({ integrationKey: key, payload, country_code: cc });
    } catch (e) {
      error = `${e.statusCode || e.status || ''} ${String(e.message).slice(0, 300)}`;
    }
    const carriers = resp ? resumenCarriers(resp) : [];
    informe.variantes.push({ nombre, payload: limpiar(payload), error, isSuccess: resp?.isSuccess, message: resp?.message, carriers, respuesta_cruda: resp ? JSON.stringify(resp).slice(0, 4000) : null });
    log(`\n   ${nombre}`);
    if (error) log('     ERROR:', error);
    else if (!carriers.length) log('     (sin transportadoras) isSuccess=', resp?.isSuccess, 'message=', resp?.message);
    else for (const c of carriers) log('     -', c);
  }

  fs.writeFileSync(SALIDA, JSON.stringify(informe, null, 2));
  log('\n5) Informe completo guardado en', SALIDA);
  await db.close();
  process.exit(0);
})().catch(async (e) => {
  console.error('ERROR:', e.statusCode || '', e.message);
  try { await db.close(); } catch (_) {}
  process.exit(1);
});
