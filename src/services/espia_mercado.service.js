'use strict';

/**
 * espia_mercado.service.js — ImporKiller (Dropkiller propio, 30-oct-2026).
 *
 * Tres piezas:
 *  1. Recolector: recorre el catálogo público de Dropi de un país (EC, MX, CO)
 *     con el token de integración de una cuenta de Dropi registrada por el
 *     super admin en la pantalla (tabla espia_cuenta; si hay varias por país
 *     se turnan). Toma la foto del stock por (producto, bodega, variación) y
 *     suma ventas por baja de stock (utils/espiaMercadoCalc). Corre en el
 *     servidor: la IP está en la lista blanca de Dropi, en local da 401. Para
 *     probar en local se usan respuestas guardadas (ESPIA_MOCK_DIR o `fuente: 'mock'`).
 *  2. Anuncios y tiendas: lo que la extensión de Chrome «Espía de tiendas» ve
 *     en la Biblioteca de anuncios de Meta llega por POST /espia/anuncios; de
 *     cada dominio nuevo se consulta /products.json (Shopify) en segundo plano.
 *  3. Consultas de la pantalla /imporkiller y el reporte diario.
 *
 * Dropi limita por IP del servidor: todas las salidas pasan por
 * services/dropi.service (limitador global). Ante un 429 el recolector se
 * detiene y deja un freno PROPIO en memoria (no toca el de los syncs).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { QueryTypes } = require('sequelize');
const { db } = require('../database/config');
const AppError = require('../utils/appError');
const { encryptToken, decryptToken, last4 } = require('../utils/cryptoToken');
const dropiService = require('./dropi.service');
const calc = require('../utils/espiaMercadoCalc');
const {
  EspiaPasada,
  EspiaTienda,
  EspiaSeguimiento,
  EspiaCuenta,
} = require('../models/espia_mercado.model');

const TAM_PAGINA = 40; // lo que de verdad devuelve Dropi (pageSize > 100 → vacío)
const PAUSA_PAGINA_MS = Number(process.env.ESPIA_PAUSA_PAGINA_MS) || 3000;
const FRENO_MS = Number(process.env.ESPIA_FRENO_MS) || 60 * 60 * 1000;
// Ante un 429 Dropi pide «vuelve a intentarlo en unos minutos»: se espera 5 min
// y se repite la misma página hasta 3 veces seguidas antes de frenar la pasada
// una hora. Así una ráfaga ajena (el sync de órdenes de los clientes corre cada
// 15 min) no tumba la pasada entera, como pasó con MX el 31-10 en la página 19.
const PAUSA_429_MS = 5 * 60 * 1000;
const MAX_REINTENTOS_429 = 3;
// Un corte de Dropi (5xx, sin respuesta, timeout: code DROPI_UNAVAILABLE) no
// tumba la pasada: se espera 1 min y se repite la página hasta 3 veces. Entre
// el 31-10 y el 04-11 tres pasadas de EC murieron por «interferencias» de un
// solo minuto a mitad del catálogo.
const PAUSA_CORTE_MS = 60 * 1000;
const MAX_REINTENTOS_CORTE = 3;
const PURGA_DIAS = 120;
const DIAS_PARA_INACTIVO = 60; // como Dropkiller: un anuncio no visto en 60 días deja de estar activo
// QA = país de pruebas: solo para pasadas con respuestas guardadas (mock); se
// limpia con `node scripts/espiaMercado.js limpiar --pais QA --si`.
// Todos los países de Dropi en Latinoamérica (06-11-2026). Un país solo toma fotos
// cuando tiene DROPI_BASE_URL_<pais> en el .env y una cuenta en «Cuentas de mapeo».
const PAISES_REALES = ['EC', 'MX', 'CO', 'PE', 'CL', 'AR', 'PA', 'CR', 'GT', 'PY', 'VE'];
const PAISES = [...PAISES_REALES, 'QA'];
const NOMBRE_PAIS = {
  EC: 'Ecuador', MX: 'México', CO: 'Colombia', PE: 'Perú', CL: 'Chile', AR: 'Argentina',
  PA: 'Panamá', CR: 'Costa Rica', GT: 'Guatemala', PY: 'Paraguay', VE: 'Venezuela', QA: 'Pruebas (QA)',
};
// Dónde vive la app de Dropi de cada país (enlaces a la ficha del producto).
const DOMINIO_DROPI = {
  EC: 'app.dropi.ec', MX: 'app.dropi.mx', CO: 'app.dropi.co', PE: 'app.dropi.pe', CL: 'app.dropi.cl',
  AR: 'app.dropi.ar', PA: 'app.dropi.pa', CR: 'app.dropi.cr', GT: 'app.dropi.gt', PY: 'app.dropi.com.py', VE: 'app.dropi.com.ve',
};

// Respaldo mientras un país no tiene cuentas registradas en espia_cuenta: la
// integración Dropi activa de una configuración NUESTRA de ChatCenter (Global
// Outlet: EC 610, MX 822). Desde el 04-11 la regla es registrar las cuentas
// desde la pantalla; esto solo evita que EC/MX se queden sin fotos en el
// cambio. CO no tiene respaldo: necesita una cuenta registrada.
const CUENTA_POR_PAIS = {
  EC: Number(process.env.DROPI_ESPIA_CONFIGURACION_EC) || 610,
  MX: Number(process.env.DROPI_ESPIA_CONFIGURACION_MX) || 822,
};

const FRONTEND_URL = (
  process.env.FRONTEND_URL || 'https://chatcenter.imporfactory.app'
).replace(/\/$/, '');

const frenoHasta = {}; // pais → ms epoch
const corriendo = {}; // pais → true mientras hay una pasada en este proceso

const q = (sql, replacements = {}, type = QueryTypes.SELECT, transaction) =>
  db.query(sql, { replacements, type, transaction });

const validarPais = (pais) => {
  const p = String(pais || 'EC').toUpperCase();
  if (!PAISES.includes(p)) throw new AppError(`País no soportado: ${p}. Usa ${PAISES_REALES.join(', ')}.`, 400);
  return p;
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const ahoraSql = () => new Date();

class FrenoError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'FrenoError';
  }
}

/* =========================================================================
   1. RECOLECTOR
   ========================================================================= */

/* ---------- Cuentas de Dropi con las que se lee el catálogo ---------- */

const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fila de espia_cuenta para la pantalla: nunca el token, solo sus 4 últimos. */
function cuentaPublica(c) {
  if (!c) return null;
  const o = typeof c.get === 'function' ? c.get({ plain: true }) : { ...c };
  delete o.token_enc;
  return o;
}

/**
 * Cuenta con la que el recolector lee el catálogo de un país. Prioridad:
 *  1. cuentas registradas y activas en espia_cuenta, turnándose: va primero
 *     la que lleva más tiempo sin usarse, y las que fallaron en su último
 *     intento se dejan para el final;
 *  2. respaldo: la integración Dropi activa de CUENTA_POR_PAIS (solo EC/MX).
 * Devuelve { origen: 'registrada'|'configuracion', id, correo, etiqueta,
 * token_enc, descripcion } sin descifrar nada.
 */
// Mientras no se corra el CREATE TABLE de espia_cuenta (misma BD en dev y
// prod), el recolector sigue con el respaldo en vez de caerse.
const sinTabla = (err) => (err?.original?.code || err?.parent?.code || err?.code) === 'ER_NO_SUCH_TABLE';

async function cuentaDe(pais) {
  let registrada = null;
  try {
    registrada = await EspiaCuenta.findOne({
      where: { pais, activa: 1 },
      order: [
        [db.literal('(ultimo_error_en IS NOT NULL AND (ultimo_ok IS NULL OR ultimo_error_en > ultimo_ok))'), 'ASC'],
        [db.literal('ultimo_uso IS NULL'), 'DESC'],
        ['ultimo_uso', 'ASC'],
        ['id', 'ASC'],
      ],
      raw: true,
    });
  } catch (err) {
    if (!sinTabla(err)) throw err;
    console.warn('[espia-mercado] falta la tabla espia_cuenta (espia_mercado_migration.sql): uso el respaldo por configuración');
  }
  if (registrada) {
    return {
      origen: 'registrada',
      id: registrada.id,
      correo: registrada.correo,
      etiqueta: registrada.etiqueta,
      token_enc: registrada.token_enc,
      token_last4: registrada.token_last4,
      descripcion: registrada.correo,
    };
  }
  const idc = CUENTA_POR_PAIS[pais];
  if (!idc) {
    throw new AppError(`${NOMBRE_PAIS[pais] || pais} no tiene ninguna cuenta de Dropi registrada: agrégala en «Cuentas de mapeo»`, 400);
  }
  const [row] = await q(
    `SELECT di.id, di.country_code, di.integration_key_enc, di.store_name,
            di.id_configuracion, c.nombre_configuracion
       FROM dropi_integrations di
       JOIN configuraciones c ON c.id = di.id_configuracion
      WHERE di.id_configuracion = :idc AND di.country_code = :pais
        AND di.is_active = 1 AND di.deleted_at IS NULL
      ORDER BY di.id DESC
      LIMIT 1`,
    { idc, pais },
  );
  if (!row) {
    throw new AppError(
      `${NOMBRE_PAIS[pais] || pais} no tiene cuentas registradas y la configuración ${idc} no tiene una integración Dropi activa: agrega una cuenta en «Cuentas de mapeo»`,
      400,
    );
  }
  return {
    origen: 'configuracion',
    id: row.id,
    correo: null,
    etiqueta: `${row.store_name} · ${row.nombre_configuracion}`,
    token_enc: row.integration_key_enc,
    token_last4: null,
    id_configuracion: row.id_configuracion,
    store_name: row.store_name,
    nombre_configuracion: row.nombre_configuracion,
    descripcion: `cfg ${row.id_configuracion}`,
  };
}

async function obtenerLlave(pais, cuenta) {
  const c = cuenta || (await cuentaDe(pais));
  const key = decryptToken(c.token_enc);
  if (!key) {
    throw new AppError(
      c.origen === 'registrada'
        ? `El token de la cuenta ${c.correo} no se pudo descifrar (¿cambió DROPI_TOKEN_ENC_KEY?)`
        : `La llave de la integración #${c.id} no se pudo descifrar`,
      500,
    );
  }
  if (c.origen === 'registrada') {
    await EspiaCuenta.update({ ultimo_uso: ahoraSql() }, { where: { id: c.id } }).catch(() => {});
  }
  return { key, cuenta: c };
}

/** Anota en espia_cuenta cómo le fue a la cuenta en la última lectura. */
async function anotarCuenta(cuenta, { ok, error, pasada = false } = {}) {
  if (!cuenta || cuenta.origen !== 'registrada') return;
  const ahora = ahoraSql();
  const cambios = ok
    ? { ultimo_ok: ahora, ultimo_error: null, ultimo_error_en: null }
    : { ultimo_error: String(error || 'Error').slice(0, 500), ultimo_error_en: ahora };
  if (pasada && ok) cambios.pasadas = db.literal('pasadas + 1');
  await EspiaCuenta.update(cambios, { where: { id: cuenta.id } }).catch(() => {});
}

const esCorte = (err) => err?.code === 'DROPI_UNAVAILABLE';
const esRateLimit = (err) => err?.code === 'DROPI_RATE_LIMIT' || err?.statusCode === 429;

/**
 * Lee una página del catálogo con un token dado. Es lo que usan el recolector
 * y «Probar» de las cuentas (una sola página chica).
 */
function leerPagina(pais, key, { startData = 0, pageSize = TAM_PAGINA, conConteo = false } = {}) {
  return dropiService.listProductsIndex({
    integrationKey: key,
    country_code: pais,
    payload: {
      pageSize,
      startData,
      no_count: !conConteo,
      order_by: 'id',
      order_type: 'asc',
      keywords: '',
    },
  });
}

/**
 * Páginas del catálogo real con la cuenta `cuenta` (o la que toque por turno).
 * Ante un 429 espera PAUSA_429_MS y repite la misma página (avisa por
 * onRateLimit); tras MAX_REINTENTOS_429 seguidos lanza FrenoError. Ante un
 * corte de Dropi (5xx / sin respuesta) espera PAUSA_CORTE_MS y repite hasta
 * MAX_REINTENTOS_CORTE veces. Cualquier otro error (401 token malo, 403 IP)
 * sale de inmediato y queda anotado en la cuenta.
 */
async function* paginasDropi(pais, { maxPaginas = 0, onRateLimit, onCorte, onTotal, cuenta } = {}) {
  const { key, cuenta: usada } = await obtenerLlave(pais, cuenta);
  let startData = 0;
  let n = 0;
  let total = null; // productos del catálogo según Dropi (conteo de la primera página), si lo da
  let reintentos429 = 0;
  let reintentosCorte = 0;
  for (;;) {
    if (maxPaginas && n >= maxPaginas) return;
    // Fin del catálogo sin pedir una página de más. CO termina justo en un múltiplo
    // de 40 (25.960 = 649 × 40) y al pedir la 650 Dropi no devolvía vacío: respondía
    // 404 o se colgaba hasta el timeout, y la pasada quedaba como «error» con el
    // catálogo completo ya leído (05 y 06-11-2026).
    if (total != null && startData >= total) return;
    let data;
    try {
      // El conteo solo en el primer intento de la primera página: si Dropi falla
      // con él (es una consulta más pesada), se repite sin conteo.
      data = await leerPagina(pais, key, { startData, conConteo: n === 0 && !reintentos429 && !reintentosCorte });
    } catch (err) {
      if (esRateLimit(err)) {
        reintentos429 += 1;
        if (typeof onRateLimit === 'function') onRateLimit(reintentos429, n + 1, err.message);
        if (reintentos429 > MAX_REINTENTOS_429) throw new FrenoError(err.message);
        await dormir(PAUSA_429_MS);
        continue; // misma página, mismo startData
      }
      if (esCorte(err) && reintentosCorte < MAX_REINTENTOS_CORTE) {
        reintentosCorte += 1;
        if (typeof onCorte === 'function') onCorte(reintentosCorte, n + 1, err.message);
        await dormir(PAUSA_CORTE_MS);
        continue;
      }
      // 404 al pedir la página siguiente a una completa: Dropi dice «no hay más».
      if (n > 0 && Number(err?.statusCode) === 404) return;
      await anotarCuenta(usada, { ok: false, error: err.message });
      throw err;
    }
    reintentos429 = 0;
    reintentosCorte = 0;
    const objetos = Array.isArray(data?.objects) ? data.objects : [];
    if (!objetos.length) return;
    if (n === 0 && total == null) {
      total = totalDe(data);
      if (total != null && typeof onTotal === 'function') onTotal(total);
    }
    n += 1;
    yield objetos;
    if (objetos.length < TAM_PAGINA) return; // página corta = la última
    startData += TAM_PAGINA;
    await dormir(PAUSA_PAGINA_MS);
  }
}

/** Total de productos que Dropi declara en una página con conteo (o null si no lo trae). */
function totalDe(data) {
  const c = data?.count ?? data?.total ?? data?.totalCount ?? data?.total_count ?? data?.pagination?.total;
  const n = Number(c);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cuentas registradas (sin token) con un resumen por país, para la pantalla. */
async function listarCuentas(paisCrudo) {
  const where = paisCrudo ? { pais: validarPais(paisCrudo) } : {};
  let filas = [];
  try {
    filas = await EspiaCuenta.findAll({ where, order: [['pais', 'ASC'], ['activa', 'DESC'], ['id', 'ASC']], raw: true });
  } catch (err) {
    if (!sinTabla(err)) throw err;
    throw new AppError('Falta crear la tabla espia_cuenta (espia_mercado_migration.sql, sección 04-11-2026)', 500);
  }
  const cuentas = filas.map(cuentaPublica);
  const resumen = {};
  for (const p of PAISES_REALES) {
    const del = cuentas.filter((c) => c.pais === p);
    resumen[p] = {
      total: del.length,
      activas: del.filter((c) => Number(c.activa) === 1).length,
      con_error: del.filter((c) => Number(c.activa) === 1 && c.ultimo_error_en && (!c.ultimo_ok || new Date(c.ultimo_error_en) > new Date(c.ultimo_ok))).length,
      respaldo: CUENTA_POR_PAIS[p] || null,
    };
  }
  return { cuentas, resumen };
}

function limpiarToken(token) {
  const t = String(token || '').trim().replace(/^bearer\s+/i, '').replace(/^dropi-integration-key:\s*/i, '').trim();
  if (t.length < 20) throw new AppError('El token de integración se ve incompleto: cópialo entero desde Dropi', 400);
  if (/\s/.test(t)) throw new AppError('El token no debe llevar espacios ni saltos de línea', 400);
  return t;
}

/**
 * Registra (o reemplaza el token de) una cuenta de Dropi para un país. El
 * token se cifra con la misma llave que dropi_integrations y no vuelve nunca
 * al front. Si ya existe (pais + correo) se actualiza el token y se reactiva.
 */
async function guardarCuenta(body = {}, sessionUser) {
  const pais = validarPais(body.pais);
  if (pais === 'QA') throw new AppError('QA solo usa respuestas guardadas; no lleva cuentas', 400);
  const correo = String(body.correo || '').trim().toLowerCase();
  if (!RE_CORREO.test(correo)) throw new AppError('Escribe el correo con el que esa cuenta entra a Dropi', 400);
  const token = limpiarToken(body.token);
  const etiqueta = String(body.etiqueta || '').trim().slice(0, 120) || null;
  const ahora = ahoraSql();
  const datos = {
    token_enc: encryptToken(token),
    token_last4: last4(token),
    etiqueta,
    activa: 1,
    ultimo_error: null,
    ultimo_error_en: null,
    actualizado_en: ahora,
  };
  let fila = await EspiaCuenta.findOne({ where: { pais, correo } });
  let creada = false;
  if (fila) {
    await fila.update(datos);
  } else {
    fila = await EspiaCuenta.create({ pais, correo, ...datos, creado_por: sessionUser?.id_sub_usuario || null, creado_en: ahora });
    creada = true;
  }
  return { creada, cuenta: cuentaPublica(fila) };
}

async function actualizarCuenta(id, body = {}) {
  const fila = await EspiaCuenta.findByPk(Number(id));
  if (!fila) throw new AppError('Esa cuenta ya no existe', 404);
  const cambios = { actualizado_en: ahoraSql() };
  if (body.activa !== undefined) cambios.activa = body.activa ? 1 : 0;
  if (body.etiqueta !== undefined) cambios.etiqueta = String(body.etiqueta || '').trim().slice(0, 120) || null;
  if (body.token) {
    const token = limpiarToken(body.token);
    cambios.token_enc = encryptToken(token);
    cambios.token_last4 = last4(token);
    cambios.ultimo_error = null;
    cambios.ultimo_error_en = null;
  }
  await fila.update(cambios);
  return cuentaPublica(fila);
}

async function eliminarCuenta(id) {
  const n = await EspiaCuenta.destroy({ where: { id: Number(id) } });
  if (!n) throw new AppError('Esa cuenta ya no existe', 404);
  return { eliminada: true };
}

/**
 * Prueba un token contra Dropi leyendo UNA página chica del catálogo del país.
 * Acepta { id } (cuenta guardada) o { pais, token } (antes de guardar). Solo
 * funciona desde el servidor (la IP está en la lista blanca de Dropi).
 */
async function probarCuenta(body = {}) {
  let pais;
  let key;
  let fila = null;
  if (body.id) {
    fila = await EspiaCuenta.findByPk(Number(body.id), { raw: true });
    if (!fila) throw new AppError('Esa cuenta ya no existe', 404);
    pais = fila.pais;
    key = decryptToken(fila.token_enc);
    if (!key) throw new AppError(`El token de ${fila.correo} no se pudo descifrar (¿cambió DROPI_TOKEN_ENC_KEY?)`, 500);
  } else {
    pais = validarPais(body.pais);
    if (pais === 'QA') throw new AppError('QA no tiene catálogo real', 400);
    key = limpiarToken(body.token);
  }
  const t0 = Date.now();
  try {
    const data = await leerPagina(pais, key, { startData: 0, pageSize: 5 });
    const objetos = Array.isArray(data?.objects) ? data.objects : [];
    if (fila) await anotarCuenta({ origen: 'registrada', id: fila.id }, { ok: true });
    return {
      ok: true,
      pais,
      productos: objetos.length,
      ms: Date.now() - t0,
      ejemplo: objetos[0]
        ? {
            id: objetos[0].id,
            nombre: String(objetos[0].name || '').slice(0, 80),
            // Para afinar de dónde sale el nombre de la tienda del proveedor.
            proveedor: nombreProveedorDe(objetos[0]) || null,
            campos_proveedor: camposProveedor(objetos[0]),
          }
        : null,
    };
  } catch (err) {
    const motivo =
      err?.statusCode === 401 || err?.statusCode === 403
        ? `Dropi rechazó el token (${err.statusCode}): revisa que sea el de ${NOMBRE_PAIS[pais]} y que la integración siga activa en Dropi`
        : err.message;
    if (fila) await anotarCuenta({ origen: 'registrada', id: fila.id }, { ok: false, error: motivo });
    return { ok: false, pais, ms: Date.now() - t0, error: motivo, codigo: err?.code || null, status: err?.statusCode || null };
  }
}

/**
 * Páginas desde respuestas guardadas: archivos *.json en `dir` (ordenados por
 * nombre natural), cada uno con la respuesta de /products/index ({objects:[]})
 * o directamente un arreglo de productos. Si hay subcarpeta con el país
 * (dir/EC/*.json) se usa esa.
 */
async function* paginasMock(dir, pais, { maxPaginas = 0 } = {}) {
  let base = dir;
  const porPais = path.join(dir, pais);
  if (fs.existsSync(porPais) && fs.statSync(porPais).isDirectory()) base = porPais;
  if (!fs.existsSync(base)) throw new AppError(`No existe la carpeta de respuestas guardadas: ${base}`, 400);
  const archivos = fs
    .readdirSync(base)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!archivos.length) throw new AppError(`No hay archivos .json en ${base}`, 400);
  let n = 0;
  for (const f of archivos) {
    if (maxPaginas && n >= maxPaginas) return;
    const crudo = JSON.parse(fs.readFileSync(path.join(base, f), 'utf8'));
    const objetos = Array.isArray(crudo)
      ? crudo
      : Array.isArray(crudo?.objects)
        ? crudo.objects
        : Array.isArray(crudo?.data?.objects)
          ? crudo.data.objects
          : Array.isArray(crudo?.data)
            ? crudo.data
            : [];
    if (!objetos.length) continue;
    n += 1;
    yield objetos;
  }
}

const CLOUDFRONT = 'https://d39ru7awumhhs2.cloudfront.net';
function imagenDe(p) {
  const g = Array.isArray(p?.gallery) ? p.gallery : [];
  const main = g.find((x) => x?.main) || g[0];
  if (!main) return null;
  if (main.url) return String(main.url).slice(0, 600);
  if (main.urlS3) return `${CLOUDFRONT}/${String(main.urlS3).replace(/^\//, '')}`.slice(0, 600);
  return null;
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Nombre del proveedor tal como lo muestra Dropi: el de la tienda, no el de
 * la persona. `user.name` es el nombre de pila del dueño de la cuenta (el
 * producto 129102 de EC decía «Juan» cuando Dropi muestra «Quality Gifts»);
 * se prefiere cualquier campo de tienda que venga en el objeto y `name` solo
 * queda de respaldo. `camposProveedor` lista lo que trae el objeto para que
 * «Probar» en Cuentas de mapeo lo enseñe y se pueda afinar.
 */
const CAMPOS_TIENDA = ['store', 'store_name', 'shop', 'shop_name', 'business_name', 'company', 'company_name', 'nombre_tienda', 'trade_name', 'brand', 'display_name', 'nickname'];
const texto = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return texto(v.name ?? v.nombre ?? '');
  const s = String(v).trim();
  return s && s !== 'null' && s !== 'undefined' ? s : '';
};
function nombreProveedorDe(p) {
  const u = p?.user && typeof p.user === 'object' ? p.user : {};
  for (const origen of [p?.supplier, p?.shop, p?.store]) {
    const s = texto(origen);
    if (s) return s;
  }
  for (const k of CAMPOS_TIENDA) {
    const s = texto(u[k]);
    if (s) return s;
  }
  const persona = [texto(u.name), texto(u.surname ?? u.last_name)].filter(Boolean).join(' ');
  return persona || '';
}
function camposProveedor(p) {
  const u = p?.user && typeof p.user === 'object' ? p.user : null;
  if (!u) return [];
  return Object.keys(u).filter((k) => !/token|password|cellphone|phone|email|document|identification|address|dir\b|wallet/i.test(k));
}

function fichaDe(p) {
  const proveedor = nombreProveedorDe(p);
  return {
    dropi_product_id: Number(p.id),
    nombre: String(p.name || '').slice(0, 300),
    nombre_norm: calc.normalizarNombre(p.name),
    tipo: String(p.type || '').slice(0, 12) || null,
    sku: p.sku ? String(p.sku).slice(0, 120) : null,
    proveedor_id: p.user?.id != null ? Number(p.user.id) : null,
    proveedor_nombre: proveedor ? proveedor.slice(0, 200) : null,
    precio: num(p.sale_price),
    sugerido: num(p.suggested_price),
    categoria: p.categories?.[0]?.name ? String(p.categories[0].name).slice(0, 200) : null,
    imagen_url: imagenDe(p),
    external_id: p.external_id ? String(p.external_id).slice(0, 100) : null,
    privado: p.privated_product ? 1 : 0,
  };
}

/** Map productoId → Map('w:v' → {stock, fecha_hora}) con el último stock guardado. */
async function previasDe(pais, ids) {
  const salida = new Map();
  if (!ids.length) return salida;
  const rows = await q(
    `SELECT dropi_product_id, warehouse_id, variacion_id, stock, fecha_hora
       FROM espia_stock_actual
      WHERE pais = :pais AND dropi_product_id IN (:ids)`,
    { pais, ids },
  );
  for (const r of rows) {
    const pid = Number(r.dropi_product_id);
    if (!salida.has(pid)) salida.set(pid, new Map());
    salida.get(pid).set(`${r.warehouse_id}:${r.variacion_id}`, {
      stock: Number(r.stock),
      fecha_hora: r.fecha_hora,
    });
  }
  return salida;
}

/**
 * Map productoId → Map('YYYY-MM-DD' → unidades creíbles) de los últimos días.
 * Es la referencia con la que calc.ventasCreibles separa una venta de un ajuste
 * de stock: cada producto se compara con lo que él mismo venía vendiendo.
 */
async function historialDe(pais, ids) {
  const salida = new Map();
  if (!ids.length) return salida;
  const rows = await q(
    `SELECT dropi_product_id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, unidades
       FROM espia_ventas_dia
      WHERE pais = :pais AND dropi_product_id IN (:ids) AND unidades > 0
        AND fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY)`,
    { pais, ids, d: calc.AJUSTE.DIAS_REFERENCIA + 3 },
  );
  for (const r of rows) {
    const pid = Number(r.dropi_product_id);
    if (!salida.has(pid)) salida.set(pid, new Map());
    salida.get(pid).set(r.fecha, Number(r.unidades));
  }
  return salida;
}

/** Mejor día creíble del producto en los DIAS_REFERENCIA anteriores a `fecha` (sin contarla). */
function mayorDiaAntes(hist, fecha, pais) {
  if (!hist || !hist.size) return 0;
  const desde = calc.fechaLocal(new Date(new Date(`${fecha}T12:00:00Z`).getTime() - calc.AJUSTE.DIAS_REFERENCIA * 86400000), pais);
  let mayor = 0;
  for (const [f, u] of hist) if (f < fecha && f >= desde && u > mayor) mayor = u;
  return mayor;
}

async function procesarPagina(pais, productos, instante, stats) {
  const ids = productos.map((p) => Number(p.id)).filter(Number.isFinite);
  const previas = await previasDe(pais, ids);
  const historial = await historialDe(pais, ids);
  const t = await db.transaction();
  try {
    for (const p of productos) {
      const pid = Number(p.id);
      if (!Number.isFinite(pid)) continue;
      const ficha = fichaDe(p);
      const prevMap = previas.get(pid) || new Map();
      const prevStocks = new Map([...prevMap.entries()].map(([k, v]) => [k, v.stock]));
      const nuevas = calc.clavesDeProducto(p);
      // Las ventas se cargan a la fecha local de la foto anterior más reciente.
      let fotoAnterior = null;
      for (const v of prevMap.values()) {
        if (!fotoAnterior || new Date(v.fecha_hora) > new Date(fotoAnterior)) fotoAnterior = v.fecha_hora;
      }
      const fecha = calc.fechaDeCarga(fotoAnterior || instante, pais);
      // Solo cuenta como venta lo que cuadra con lo que el producto venía vendiendo;
      // el resto (ajustes de inventario, traslados, variaciones apagadas) va a `ajuste`.
      const r = calc.resumirProducto(prevStocks, nuevas, mayorDiaAntes(historial.get(pid), fecha, pais));
      stats.ajustes = (stats.ajustes || 0) + r.ajuste;

      // Ficha (acumulados: se suman, no se pisan).
      await q(
        `INSERT INTO espia_producto
           (pais, dropi_product_id, nombre, nombre_norm, tipo, sku, proveedor_id, proveedor_nombre,
            precio, sugerido, categoria, imagen_url, external_id, privado,
            primera_vez, ultima_vez, stock_actual, ventas_total, reabastecimientos)
         VALUES (:pais, :id, :nombre, :nombre_norm, :tipo, :sku, :proveedor_id, :proveedor_nombre,
                 :precio, :sugerido, :categoria, :imagen_url, :external_id, :privado,
                 :ahora, :ahora, :stock, :ventas, :reab)
         ON DUPLICATE KEY UPDATE
           nombre = VALUES(nombre), nombre_norm = VALUES(nombre_norm), tipo = VALUES(tipo),
           sku = VALUES(sku), proveedor_id = VALUES(proveedor_id), proveedor_nombre = VALUES(proveedor_nombre),
           precio = VALUES(precio), sugerido = VALUES(sugerido), categoria = VALUES(categoria),
           imagen_url = COALESCE(VALUES(imagen_url), imagen_url), external_id = VALUES(external_id),
           privado = VALUES(privado), ultima_vez = VALUES(ultima_vez), stock_actual = VALUES(stock_actual),
           ventas_total = ventas_total + VALUES(ventas_total),
           reabastecimientos = reabastecimientos + VALUES(reabastecimientos)`,
        {
          pais,
          id: pid,
          ...ficha,
          ahora: instante,
          stock: r.stockTotal,
          ventas: r.ventas,
          reab: r.reabastecimientos,
        },
        QueryTypes.INSERT,
        t,
      );
      stats.productos += 1;

      // Fotos: solo lo que cambió.
      if (r.cambios.length) {
        const filas = r.cambios.map((c) => [pais, pid, c.warehouse_id, c.variacion_id, instante, c.stock]);
        await db.query(
          `INSERT INTO espia_stock_actual (pais, dropi_product_id, warehouse_id, variacion_id, fecha_hora, stock)
           VALUES ${filas.map(() => '(?,?,?,?,?,?)').join(',')}
           ON DUPLICATE KEY UPDATE stock = VALUES(stock), fecha_hora = VALUES(fecha_hora)`,
          { replacements: filas.flat(), type: QueryTypes.INSERT, transaction: t },
        );
        await db.query(
          `INSERT IGNORE INTO espia_stock_foto (pais, dropi_product_id, warehouse_id, variacion_id, fecha_hora, stock)
           VALUES ${filas.map(() => '(?,?,?,?,?,?)').join(',')}`,
          { replacements: filas.flat(), type: QueryTypes.INSERT, transaction: t },
        );
        stats.fotos_escritas += r.cambios.length;
      }

      // Ventas del día (la fecha se resolvió arriba).
      if (r.ventas > 0 || r.reabastecimientos > 0) {
        await q(
          `INSERT INTO espia_ventas_dia (pais, dropi_product_id, fecha, unidades, reabastecido)
           VALUES (:pais, :id, :fecha, :unidades, :reab)
           ON DUPLICATE KEY UPDATE unidades = unidades + VALUES(unidades),
                                   reabastecido = GREATEST(reabastecido, VALUES(reabastecido))`,
          { pais, id: pid, fecha, unidades: r.ventas, reab: r.reabastecimientos ? 1 : 0 },
          QueryTypes.INSERT,
          t,
        );
        stats.ventas_sumadas += r.ventas;
      }
    }
    await t.commit();
  } catch (e) {
    await t.rollback();
    throw e;
  }
}

/**
 * Una pasada completa del catálogo de un país.
 * opts: { fuente: 'dropi'|'mock', mockDir, maxPaginas, log }
 */
async function pasada(paisCrudo, opts = {}) {
  const pais = validarPais(paisCrudo);
  const log = opts.log || ((...a) => console.log('[espia-mercado]', ...a));
  const fuente = opts.fuente || (process.env.ESPIA_MOCK_DIR ? 'mock' : 'dropi');
  const mockDir = opts.mockDir || process.env.ESPIA_MOCK_DIR;

  if (pais === 'QA' && fuente !== 'mock') throw new AppError('QA solo acepta fuente mock', 400);
  if (fuente === 'dropi' && frenoHasta[pais] && Date.now() < frenoHasta[pais]) {
    const hasta = new Date(frenoHasta[pais]).toISOString();
    throw new AppError(`Recolector de ${pais} frenado por un 429 de Dropi hasta ${hasta}`, 429);
  }
  if (corriendo[pais]) throw new AppError(`Ya hay una pasada de ${pais} corriendo en este proceso`, 409);

  const lockName = `espia_pasada_${pais}`;
  const [lock] = await q(`SELECT GET_LOCK(:n, 1) AS got`, { n: lockName });
  if (!lock || Number(lock.got) !== 1) {
    throw new AppError(`Ya hay una pasada de ${pais} corriendo en otro proceso`, 409);
  }
  corriendo[pais] = true;
  const inicio = ahoraSql();
  // Una pasada que sigue «corriendo» horas después es de un proceso que se reinició
  // (deploy) a mitad: se cierra como error para que la pantalla no la muestre en curso.
  await q(
    `UPDATE espia_pasada SET estado = 'error', fin = NOW(), error = 'El servidor se reinició durante la pasada'
      WHERE pais = :pais AND estado = 'corriendo' AND inicio < DATE_SUB(NOW(), INTERVAL 4 HOUR)`,
    { pais },
    QueryTypes.UPDATE,
  ).catch(() => {});
  // La cuenta se resuelve antes de abrir la bitácora: si el país no tiene
  // ninguna, la pasada no queda como error, simplemente no arranca.
  let cuenta = null;
  if (fuente !== 'mock') {
    try {
      cuenta = await cuentaDe(pais);
    } catch (e) {
      corriendo[pais] = false;
      await q(`DO RELEASE_LOCK(:n)`, { n: lockName }, QueryTypes.RAW).catch(() => {});
      throw e;
    }
  }
  // `cuenta` es columna nueva (04-11): si todavía no corrió el ALTER de espia_pasada, se registra sin ella.
  const registro = await EspiaPasada.create({ pais, fuente, inicio, estado: 'corriendo', cuenta: cuenta?.descripcion || null }).catch((e) => {
    if ((e?.original?.code || e?.parent?.code || e?.code) !== 'ER_BAD_FIELD_ERROR') throw e;
    console.warn('[espia-mercado] falta la columna espia_pasada.cuenta (espia_mercado_migration.sql)');
    return EspiaPasada.create({ pais, fuente, inicio, estado: 'corriendo' }, { fields: ['pais', 'fuente', 'inicio', 'estado'] });
  });
  const stats = { paginas: 0, productos: 0, fotos_escritas: 0, ventas_sumadas: 0, errores_429: 0 };
  log(`▶ pasada ${pais} (${fuente}) #${registro.id}${cuenta ? ` · cuenta ${cuenta.descripcion}` : ''}`);

  try {
    const paginas =
      fuente === 'mock'
        ? paginasMock(mockDir, pais, { maxPaginas: opts.maxPaginas })
        : paginasDropi(pais, {
            maxPaginas: opts.maxPaginas,
            cuenta,
            onRateLimit: (intento, pagina, msg) => {
              stats.errores_429 += 1;
              log(`⏳ ${pais} 429 en pág ${pagina} (intento ${intento}/${MAX_REINTENTOS_429}): espero ${PAUSA_429_MS / 60000} min · ${msg}`);
            },
            onCorte: (intento, pagina, msg) => {
              log(`⏳ ${pais} corte de Dropi en pág ${pagina} (intento ${intento}/${MAX_REINTENTOS_CORTE}): espero ${PAUSA_CORTE_MS / 1000} s · ${msg}`);
            },
            onTotal: (total) => log(`… ${pais}: Dropi declara ${total} productos (${Math.ceil(total / TAM_PAGINA)} págs)`),
          });

    for await (const productos of paginas) {
      const instante = ahoraSql();
      await procesarPagina(pais, productos, instante, stats);
      stats.paginas += 1;
      if (stats.paginas % 25 === 0) {
        log(`… ${pais} pág ${stats.paginas} · ${stats.productos} productos · ${stats.ventas_sumadas} ventas`);
        await registro.update({ ...stats });
      }
    }

    await q(
      `DELETE FROM espia_stock_foto WHERE pais = :pais AND fecha_hora < DATE_SUB(NOW(), INTERVAL :d DAY)`,
      { pais, d: PURGA_DIAS },
      QueryTypes.DELETE,
    );
    if (!opts.maxPaginas) await recalcularMetricas(pais, log); // una prueba corta no cambia las métricas
    await registro.update({ ...stats, fin: ahoraSql(), estado: 'ok' });
    await anotarCuenta(cuenta, { ok: true, pasada: !opts.maxPaginas });
    log(`✔ pasada ${pais} #${registro.id}: ${stats.paginas} págs · ${stats.productos} productos · ${stats.fotos_escritas} fotos · ${stats.ventas_sumadas} ventas · ${stats.ajustes || 0} unidades de ajustes de stock sin contar`);
    return { id: registro.id, ...stats, estado: 'ok' };
  } catch (err) {
    if (err instanceof FrenoError) {
      frenoHasta[pais] = Date.now() + FRENO_MS;
      await registro.update({
        ...stats,
        fin: ahoraSql(),
        estado: 'frenada',
        freno_hasta: new Date(frenoHasta[pais]),
        error: String(err.message).slice(0, 500),
      });
      log(`⛔ pasada ${pais} frenada por 429 (hasta ${new Date(frenoHasta[pais]).toISOString()})`);
      return { id: registro.id, ...stats, estado: 'frenada' };
    }
    await registro.update({ ...stats, fin: ahoraSql(), estado: 'error', error: String(err.message).slice(0, 500) });
    await anotarCuenta(cuenta, { ok: false, error: err.message });
    log(`✖ pasada ${pais} error: ${err.message}`);
    throw err;
  } finally {
    corriendo[pais] = false;
    await q(`DO RELEASE_LOCK(:n)`, { n: lockName }, QueryTypes.RAW).catch(() => {});
  }
}

/* =========================================================================
   2. CONSULTAS DE PRODUCTOS
   ========================================================================= */

function fechasDe(pais) {
  const hoy = calc.fechaLocal(new Date(), pais); // YYYY-MM-DD
  const menos = (dias) => {
    const d = new Date(`${hoy}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - dias);
    return d.toISOString().slice(0, 10);
  };
  return { hoy, d1: menos(1), d7: menos(7), d14: menos(14), d30: menos(30), d60: menos(60) };
}

/** Los últimos N días locales del país terminando hoy, como 'YYYY-MM-DD'. */
function ultimosDias(pais, n) {
  const { hoy } = fechasDe(pais);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(`${hoy}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Las métricas (ventas 1/7/30 d, 7 previos, serie7, iguales) viven en columnas
// de espia_producto y las recalcula recalcularMetricas() al cerrar cada pasada y
// a las 00:10 de cada país; así la pantalla lee una sola tabla indexada.
const CAMPOS_PRODUCTO = `
  p.pais, p.dropi_product_id, p.nombre, p.tipo, p.sku, p.proveedor_id, p.proveedor_nombre,
  p.precio, p.sugerido, p.categoria, p.imagen_url, p.external_id, p.privado,
  p.primera_vez, p.ultima_vez, p.stock_actual, p.ventas_total, p.reabastecimientos,
  p.ventas_1d, p.ventas_7d, p.ventas_7d_prev, p.ventas_30d, p.n_iguales, p.serie7, p.metricas_en,
  p.n_anuncios, p.radar_en`;

const serieDe = (s) => (s ? String(s).split(',').map((x) => Number(x) || 0) : [0, 0, 0, 0, 0, 0, 0]);

/**
 * Recalcula en espia_producto las métricas derivadas de espia_ventas_dia para un
 * país: dos UPDATE ... JOIN sobre tablas materializadas (segundos, no por fila).
 */
async function recalcularMetricas(paisCrudo, log = () => {}) {
  const pais = validarPais(paisCrudo);
  const f = fechasDe(pais);
  const dias = ultimosDias(pais, 7);
  const t0 = Date.now();
  const serie = dias.map((_, k) => `SUM(CASE WHEN fecha = :s${k} THEN unidades ELSE 0 END)`).join(", ',', ");
  const repl = { pais, d1: f.d1, d7: f.d7, d14: f.d14, d30: f.d30 };
  dias.forEach((d, k) => { repl[`s${k}`] = d; });
  await q(
    `UPDATE espia_producto p
       LEFT JOIN (
         SELECT dropi_product_id,
                SUM(CASE WHEN fecha >= :d1 THEN unidades ELSE 0 END) AS v1,
                SUM(CASE WHEN fecha >= :d7 THEN unidades ELSE 0 END) AS v7,
                SUM(CASE WHEN fecha >= :d14 AND fecha < :d7 THEN unidades ELSE 0 END) AS v7prev,
                SUM(CASE WHEN fecha >= :d30 THEN unidades ELSE 0 END) AS v30,
                CONCAT(${serie}) AS serie7
           FROM espia_ventas_dia
          WHERE pais = :pais AND fecha >= :d30
          GROUP BY dropi_product_id) v ON v.dropi_product_id = p.dropi_product_id
       SET p.ventas_1d = COALESCE(v.v1, 0), p.ventas_7d = COALESCE(v.v7, 0),
           p.ventas_7d_prev = COALESCE(v.v7prev, 0), p.ventas_30d = COALESCE(v.v30, 0),
           p.serie7 = COALESCE(v.serie7, '0,0,0,0,0,0,0'), p.metricas_en = NOW()
     WHERE p.pais = :pais`,
    repl,
    QueryTypes.BULKUPDATE,
  );
  await q(
    `UPDATE espia_producto p
       LEFT JOIN (SELECT nombre_norm, COUNT(*) AS n FROM espia_producto
                   WHERE pais = :pais AND nombre_norm <> '' GROUP BY nombre_norm) g
              ON g.nombre_norm = p.nombre_norm
       LEFT JOIN (SELECT nombre_norm, proveedor_id, COUNT(*) AS n FROM espia_producto
                   WHERE pais = :pais AND nombre_norm <> '' GROUP BY nombre_norm, proveedor_id) gp
              ON gp.nombre_norm = p.nombre_norm AND gp.proveedor_id <=> p.proveedor_id
       SET p.n_iguales = GREATEST(0, COALESCE(g.n, 0) - COALESCE(gp.n, 0))
     WHERE p.pais = :pais`,
    { pais },
    QueryTypes.BULKUPDATE,
  );
  // Anuncios activos vinculados por el radar (los que Meta dejó de mostrar 60 días salen del conteo).
  await q(
    `UPDATE espia_producto p
       LEFT JOIN (SELECT ap.dropi_product_id, COUNT(*) AS n
                    FROM espia_anuncio_producto ap
                    JOIN espia_anuncio a ON a.ad_archive_id = ap.ad_archive_id AND a.activo = 1
                   WHERE ap.pais = :pais GROUP BY ap.dropi_product_id) x
              ON x.dropi_product_id = p.dropi_product_id
       SET p.n_anuncios = COALESCE(x.n, 0)
     WHERE p.pais = :pais`,
    { pais },
    QueryTypes.BULKUPDATE,
  );
  log(`métricas ${pais} recalculadas en ${Date.now() - t0} ms`);
}

const ORDENES = {
  v7: 'p.ventas_7d DESC, p.ventas_30d DESC',
  v30: 'p.ventas_30d DESC, p.ventas_7d DESC',
  total: 'p.ventas_total DESC',
  subida: '(p.ventas_7d - p.ventas_7d_prev) DESC, p.ventas_7d DESC',
  stock: 'p.stock_actual DESC',
  nuevos: 'p.primera_vez DESC',
  precio: 'p.precio ASC',
  precio_desc: 'p.precio DESC',
  // Facturación estimada = unidades × precio del proveedor; ganancia = sugerido − precio.
  fact7: '(p.ventas_7d * p.precio) DESC, p.ventas_7d DESC',
  fact30: '(p.ventas_30d * p.precio) DESC, p.ventas_30d DESC',
  ganancia: '(p.sugerido - p.precio) DESC',
  anuncios: 'p.n_anuncios DESC, p.ventas_7d DESC',
};

async function listarProductos(params = {}) {
  const pais = validarPais(params.pais);
  const atajo = String(params.atajo || 'top_7d');
  const base = calc.ATAJOS[atajo] || {};
  const f = { ...base };
  for (const k of ['min_v7', 'max_v7', 'min_v30', 'max_v30', 'min_stock', 'max_stock', 'creado_dias', 'max_reab', 'min_total', 'max_total', 'min_precio', 'max_precio', 'min_fact7', 'max_fact7', 'min_fact30', 'max_fact30', 'min_ganancia']) {
    if (params[k] !== undefined && params[k] !== '' && params[k] !== null) f[k] = Number(params[k]);
  }
  const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
  const page = Math.max(1, Number(params.page) || 1);
  const orden = ORDENES[params.orden] || ORDENES[f.orden] || ORDENES.v7;
  const repl = { pais, limit, offset: (page - 1) * limit };
  const where = ['p.pais = :pais'];
  const texto = String(params.q || '').trim();
  if (/^\d+$/.test(texto)) {
    // Un número es un id de producto de Dropi (o un SKU numérico).
    where.push('(p.dropi_product_id = :qid OR p.sku = :qtexto)');
    repl.qid = Number(texto);
    repl.qtexto = texto;
  } else if (texto.length >= 2) {
    where.push('(p.nombre LIKE :q OR p.proveedor_nombre LIKE :q OR p.sku LIKE :q)');
    repl.q = `%${texto}%`;
  }
  // categoria admite una o varias separadas por coma (los checkboxes del panel de filtros).
  const cats = String(params.categoria || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (cats.length) { where.push('p.categoria IN (:categorias)'); repl.categorias = cats; }
  if (params.proveedor_id) { where.push('p.proveedor_id = :proveedor_id'); repl.proveedor_id = Number(params.proveedor_id); }
  if (params.proveedor) { where.push('p.proveedor_nombre LIKE :proveedor'); repl.proveedor = `%${String(params.proveedor).trim()}%`; }
  const rangos = {
    min_stock: 'p.stock_actual >=', max_stock: 'p.stock_actual <=', max_reab: 'p.reabastecimientos <=',
    min_total: 'p.ventas_total >=', max_total: 'p.ventas_total <=',
    min_v7: 'p.ventas_7d >=', max_v7: 'p.ventas_7d <=', min_v30: 'p.ventas_30d >=', max_v30: 'p.ventas_30d <=',
    min_precio: 'p.precio >=', max_precio: 'p.precio <=',
    min_fact7: '(p.ventas_7d * p.precio) >=', max_fact7: '(p.ventas_7d * p.precio) <=',
    min_fact30: '(p.ventas_30d * p.precio) >=', max_fact30: '(p.ventas_30d * p.precio) <=',
    min_ganancia: '(p.sugerido - p.precio) >=',
  };
  for (const [k, expr] of Object.entries(rangos)) {
    if (f[k] != null) { where.push(`${expr} :${k}`); repl[k] = f[k]; }
  }
  if (f.creado_dias != null) {
    where.push('p.primera_vez >= DATE_SUB(NOW(), INTERVAL :creado_dias DAY)');
    repl.creado_dias = f.creado_dias;
  }
  // Radar: con anuncios vinculados / todavía sin buscar en Meta.
  if (params.con_anuncios === '1' || params.con_anuncios === 1 || params.con_anuncios === true) where.push('p.n_anuncios > 0');
  if (params.sin_radar === '1' || params.sin_radar === 1 || params.sin_radar === true) where.push('p.radar_en IS NULL');
  const cuerpo = `FROM espia_producto p WHERE ${where.join(' AND ')}`;
  const [items, [cnt]] = await Promise.all([
    q(`SELECT ${CAMPOS_PRODUCTO} ${cuerpo} ORDER BY ${orden} LIMIT :limit OFFSET :offset`, repl),
    q(`SELECT COUNT(*) AS total ${cuerpo}`, repl),
  ]);
  for (const it of items) it.serie7 = serieDe(it.serie7);
  return { total: Number(cnt?.total || 0), page, limit, atajo, filtros: f, items };
}

/**
 * Métricas de hasta 200 productos por id, para la capa que la extensión pinta
 * sobre el catálogo de Dropi (debajo de cada producto, como Dropkiller).
 * Devuelve solo los ids que conocemos; los demás no están en el catálogo
 * público que recorre el recolector (privados, sin stock o recién creados).
 */
async function metricasLote(paisCrudo, idsCrudos = []) {
  const pais = validarPais(paisCrudo);
  const ids = [...new Set((Array.isArray(idsCrudos) ? idsCrudos : []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  const f = fechasDe(pais);
  const [dias] = await q(`SELECT COUNT(DISTINCT fecha) AS n FROM espia_ventas_dia WHERE pais = :pais`, { pais });
  if (!ids.length) return { pais, dias_medidos: Number(dias?.n || 0), items: [] };

  const filas = await q(
    `SELECT p.dropi_product_id, p.nombre, p.proveedor_nombre, p.imagen_url, p.precio, p.sugerido,
            p.stock_actual, p.ventas_total, p.reabastecimientos, p.primera_vez, p.ultima_vez,
            p.ventas_1d, p.ventas_7d, p.ventas_7d_prev, p.ventas_30d, p.n_iguales
       FROM espia_producto p
      WHERE p.pais = :pais AND p.dropi_product_id IN (:ids)`,
    { pais, ids },
  );
  const serie = await q(
    `SELECT dropi_product_id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, unidades FROM espia_ventas_dia
      WHERE pais = :pais AND dropi_product_id IN (:ids) AND fecha >= :d14`,
    { pais, ids, d14: f.d14 },
  );
  const porId = new Map();
  for (const s of serie) {
    const k = String(s.dropi_product_id);
    if (!porId.has(k)) porId.set(k, {});
    porId.get(k)[String(s.fecha)] = Number(s.unidades || 0);
  }
  const dias14 = ultimosDias(pais, 14);
  const items = filas.map((r) => {
    const m = porId.get(String(r.dropi_product_id)) || {};
    return {
      ...r,
      ventas_1d: Number(r.ventas_1d), ventas_7d: Number(r.ventas_7d),
      ventas_7d_prev: Number(r.ventas_7d_prev), ventas_30d: Number(r.ventas_30d),
      n_iguales: Number(r.n_iguales),
      serie_14d: dias14.map((d) => m[d] || 0),
      url_imporchat: `${FRONTEND_URL}/imporkiller?pais=${pais}&tab=productos&producto=${r.dropi_product_id}`,
    };
  });
  return { pais, dias_medidos: Number(dias?.n || 0), items };
}

async function detalleProducto(paisCrudo, idCrudo, opts = {}) {
  const pais = validarPais(paisCrudo);
  const id = Number(idCrudo);
  if (!Number.isFinite(id)) throw new AppError('Producto inválido', 400);
  // Ventana del historial (selector de período de la ficha): 7, 14, 30, 60 o 90 días.
  const dias = [7, 14, 30, 60, 90].includes(Number(opts.dias)) ? Number(opts.dias) : 30;
  // Ficha e historial en paralelo (una sola ida y vuelta a la BD).
  const [[producto], historial] = await Promise.all([
    q(`SELECT ${CAMPOS_PRODUCTO}, p.nombre_norm FROM espia_producto p WHERE p.pais = :pais AND p.dropi_product_id = :id`, { pais, id }),
    q(
      `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, unidades, reabastecido FROM espia_ventas_dia
        WHERE pais = :pais AND dropi_product_id = :id AND fecha >= DATE_SUB(CURDATE(), INTERVAL :dias DAY) ORDER BY fecha`,
      { pais, id, dias },
    ),
  ]);
  if (!producto) throw new AppError('Ese producto todavía no está en el espía', 404);
  producto.serie7 = serieDe(producto.serie7);
  const fila = producto;
  const pIguales = fila?.nombre_norm
    ? q(
        `SELECT p.dropi_product_id, p.nombre, p.proveedor_id, p.proveedor_nombre, p.precio, p.sugerido, p.imagen_url,
                p.stock_actual, p.ventas_total, p.ventas_30d, p.ventas_7d
           FROM espia_producto p
          WHERE p.pais = :pais AND p.dropi_product_id <> :id
            AND (p.nombre_norm = :norm OR (:ext IS NOT NULL AND p.external_id = :ext))
            AND (p.proveedor_id IS NULL OR p.proveedor_id <> :prov)
          ORDER BY p.ventas_30d DESC LIMIT 30`,
        { pais, id, norm: fila.nombre_norm, ext: fila.external_id || null, prov: fila.proveedor_id ?? -1 },
      )
    : Promise.resolve([]);
  // Anuncios: primero los vinculados por el radar (exactos), y si quedan huecos,
  // los que mencionan las palabras del nombre (aproximados).
  // Con título, texto y última vez visto: la ficha pinta la misma tarjeta que la pestaña Anuncios.
  const CAMPOS_AD = `a.ad_archive_id, a.pagina_nombre, a.dominio, a.url_destino, a.tipo, a.media_url, a.imagen_url, a.inicio,
                     a.titulo, a.texto, a.ultima_vez_visto,
                     a.tienda_plataforma, a.n_duplicados, DATEDIFF(CURDATE(), a.inicio) AS dias_activo`;
  const pVinculados = q(
    `SELECT ${CAMPOS_AD}, 'radar' AS origen
       FROM espia_anuncio_producto ap
       JOIN espia_anuncio a ON a.ad_archive_id = ap.ad_archive_id
      WHERE ap.pais = :pais AND ap.dropi_product_id = :id AND a.activo = 1
      ORDER BY a.ultima_vez_visto DESC LIMIT 30`,
    { pais, id },
  );
  const palabras = String(fila?.nombre_norm || '').split(' ').filter((w) => w.length >= 4).slice(0, 2);
  const pAnuncios = palabras.length
    ? q(
        `SELECT ${CAMPOS_AD}, 'nombre' AS origen
           FROM espia_anuncio a
          WHERE a.activo = 1 AND (a.pais = :pais OR a.pais = 'ALL')
            AND ${palabras.map((_, i) => `(a.producto LIKE :w${i} OR a.titulo LIKE :w${i} OR a.texto LIKE :w${i})`).join(' AND ')}
          ORDER BY a.ultima_vez_visto DESC LIMIT 12`,
        Object.fromEntries([['pais', pais], ...palabras.map((w, i) => [`w${i}`, `%${w}%`])]),
      )
    : Promise.resolve([]);
  const [iguales, vinculados, porNombre] = await Promise.all([pIguales, pVinculados, pAnuncios]);
  const vistos = new Set(vinculados.map((a) => a.ad_archive_id));
  const anuncios = [...vinculados, ...porNombre.filter((a) => !vistos.has(a.ad_archive_id))];
  producto.radar = { buscado_en: producto.radar_en || null, vinculados: vinculados.length, termino: terminoBusqueda(producto.nombre) };
  const suma_iguales = {
    proveedores: iguales.length + 1,
    ventas_30d: Number(producto.ventas_30d) + iguales.reduce((n, i) => n + Number(i.ventas_30d), 0),
    ventas_total: Number(producto.ventas_total) + iguales.reduce((n, i) => n + Number(i.ventas_total), 0),
  };
  for (const a of anuncios) a.url_meta = `https://www.facebook.com/ads/library/?id=${a.ad_archive_id}`;
  return { producto, historial, iguales, suma_iguales, anuncios };
}

async function categorias(paisCrudo) {
  const pais = validarPais(paisCrudo);
  const rows = await q(
    `SELECT categoria, COUNT(*) n FROM espia_producto WHERE pais = :pais AND categoria IS NOT NULL AND categoria <> ''
      GROUP BY categoria ORDER BY n DESC LIMIT 200`,
    { pais },
  );
  // Nombre y cuántos productos tiene cada una (para los checkboxes del panel de filtros).
  return rows.map((r) => ({ categoria: r.categoria, n: Number(r.n || 0) }));
}

/* =========================================================================
   3. ANUNCIOS Y TIENDAS (lo que manda la extensión)
   ========================================================================= */

function dominioDe(url) {
  try {
    const u = new URL(String(url));
    return u.hostname.replace(/^www\./, '').toLowerCase().slice(0, 190);
  } catch {
    return null;
  }
}

function limpiarDominio(d) {
  const s = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s.slice(0, 190) : null;
}

const fechaSql = (s) => {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

async function recibirAnuncios(body = {}, sessionUser = {}) {
  const pais = ['EC', 'MX', 'ALL', 'CO', 'GT'].includes(String(body.pais || '').toUpperCase())
    ? String(body.pais).toUpperCase()
    : 'ALL';
  const lista = Array.isArray(body.anuncios) ? body.anuncios.slice(0, 200) : [];
  if (!lista.length) throw new AppError('No llegaron anuncios', 400);
  const ahora = ahoraSql();
  const hoy = calc.fechaLocal(ahora, pais === 'MX' ? 'MX' : 'EC');
  const idSub = Number(sessionUser.id_sub_usuario) || null;

  const limpios = [];
  for (const a of lista) {
    const id = String(a?.ad_archive_id || '').replace(/\D/g, '');
    if (!id) continue;
    const dominio = limpiarDominio(a.dominio) || dominioDe(a.url_destino);
    limpios.push({
      ad_archive_id: id.slice(0, 40),
      pais,
      pagina_id: a.pagina_id ? String(a.pagina_id).slice(0, 40) : null,
      pagina_nombre: a.pagina_nombre ? String(a.pagina_nombre).slice(0, 200) : null,
      dominio,
      url_destino: a.url_destino ? String(a.url_destino).slice(0, 1000) : null,
      producto: a.producto ? String(a.producto).slice(0, 200) : null,
      titulo: a.titulo ? String(a.titulo).slice(0, 300) : null,
      texto: a.texto ? String(a.texto).slice(0, 5000) : null,
      tipo: a.tipo === 'video' ? 'video' : a.tipo === 'imagen' ? 'imagen' : null,
      media_url: a.media_url ? String(a.media_url).slice(0, 1000) : null,
      imagen_url: a.imagen_url ? String(a.imagen_url).slice(0, 1000) : null,
      plataformas: Array.isArray(a.plataformas) ? a.plataformas.join(',').slice(0, 100) : null,
      tienda_plataforma: ['shopify', 'whatsapp', 'dropi', 'web'].includes(String(a.tienda_plataforma || '').toLowerCase())
        ? String(a.tienda_plataforma).toLowerCase()
        : null,
      inicio: fechaSql(a.inicio),
      n_duplicados: Math.max(1, Number(a.n_duplicados) || 1),
    });
  }
  if (!limpios.length) throw new AppError('Ningún anuncio traía ad_archive_id', 400);

  const ids = limpios.map((a) => a.ad_archive_id);
  const conocidos = new Set(
    (await q(`SELECT ad_archive_id FROM espia_anuncio WHERE ad_archive_id IN (:ids)`, { ids })).map((r) => String(r.ad_archive_id)),
  );
  const nuevos_ids = ids.filter((id) => !conocidos.has(id));

  const cols = [
    'ad_archive_id', 'pais', 'pagina_id', 'pagina_nombre', 'dominio', 'url_destino', 'producto', 'titulo', 'texto',
    'tipo', 'media_url', 'imagen_url', 'plataformas', 'tienda_plataforma', 'inicio', 'primera_vez_visto', 'ultima_vez_visto', 'activo',
    'n_duplicados', 'veces_visto', 'visto_por',
  ];
  const filas = limpios.map((a) => [
    a.ad_archive_id, a.pais, a.pagina_id, a.pagina_nombre, a.dominio, a.url_destino, a.producto, a.titulo, a.texto,
    a.tipo, a.media_url, a.imagen_url, a.plataformas, a.tienda_plataforma, a.inicio, ahora, ahora, 1, a.n_duplicados, 1, idSub,
  ]);
  await db.query(
    `INSERT INTO espia_anuncio (${cols.join(',')})
     VALUES ${filas.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}
     ON DUPLICATE KEY UPDATE
       pais = IF(VALUES(pais) = 'ALL', pais, VALUES(pais)),
       pagina_id = COALESCE(VALUES(pagina_id), pagina_id),
       pagina_nombre = COALESCE(VALUES(pagina_nombre), pagina_nombre),
       dominio = COALESCE(VALUES(dominio), dominio),
       url_destino = COALESCE(VALUES(url_destino), url_destino),
       producto = COALESCE(VALUES(producto), producto),
       titulo = COALESCE(VALUES(titulo), titulo),
       texto = COALESCE(VALUES(texto), texto),
       tipo = COALESCE(VALUES(tipo), tipo),
       media_url = COALESCE(VALUES(media_url), media_url),
       imagen_url = IF(imagen_url IS NOT NULL AND imagen_url <> '' AND imagen_url NOT LIKE '%fbcdn.net/%',
                       imagen_url, COALESCE(VALUES(imagen_url), imagen_url)),
       plataformas = COALESCE(VALUES(plataformas), plataformas),
       tienda_plataforma = COALESCE(VALUES(tienda_plataforma), tienda_plataforma),
       inicio = COALESCE(inicio, VALUES(inicio)),
       ultima_vez_visto = VALUES(ultima_vez_visto),
       activo = 1,
       n_duplicados = GREATEST(n_duplicados, VALUES(n_duplicados)),
       veces_visto = veces_visto + 1,
       visto_por = VALUES(visto_por)`,
    { replacements: filas.flat(), type: QueryTypes.INSERT },
  );

  // Tiendas: por dominio, hoy.
  const porDominio = new Map();
  for (const a of limpios) {
    if (!a.dominio) continue;
    const e = porDominio.get(a.dominio) || { nuevos: 0 };
    if (nuevos_ids.includes(a.ad_archive_id)) e.nuevos += 1;
    porDominio.set(a.dominio, e);
  }
  const buscado = limpiarDominio(body.dominio_buscado);
  if (buscado && !porDominio.has(buscado)) porDominio.set(buscado, { nuevos: 0 });
  for (const [dominio, e] of porDominio.entries()) {
    await actualizarTienda(dominio, pais, e.nuevos, hoy, ahora);
  }
  perfilarPendientes(3).catch(() => {});
  // Las imágenes de Meta vencen a los 4–5 días: se guarda una copia propia en segundo
  // plano (no frena la respuesta). Una imagen ya copiada no se vuelve a pisar (ver el
  // IF de imagen_url arriba).
  try {
    require('../utils/espiaMiniaturas').encolar(ids);
  } catch (e) {
    console.warn('[espia-mercado] no se pudieron encolar las miniaturas:', e.message);
  }

  // Lote del radar: estos anuncios salieron al buscar un producto de Dropi por nombre.
  let radar = null;
  if (body.producto_radar && pais !== 'ALL') {
    radar = await vincularProducto(pais, body.producto_radar, ids, 'radar');
  }

  return {
    recibidos: limpios.length,
    nuevos: nuevos_ids.length,
    nuevos_ids,
    conocidos_ids: ids.filter((id) => conocidos.has(id)),
    tiendas: [...porDominio.keys()],
    radar,
  };
}

/* =========================================================================
   2b. RADAR: la extensión busca en Meta los productos que más venden
   ========================================================================= */

// Quita lo que estorba en la Biblioteca (medidas, cantidades, relleno) y deja
// las 3 primeras palabras con peso. keyword_unordered exige que aparezcan todas:
// con más palabras Meta devuelve 0, con menos devuelve ruido.
const RELLENO = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'con', 'para', 'por', 'y', 'o', 'en', 'un', 'una', 'unos', 'unas', 'al', 'a', 'x',
  'pack', 'kit', 'set', 'combo', 'nuevo', 'nueva', 'nuevos', 'original', 'originales', 'oferta', 'promo', 'promocion', 'envio', 'gratis',
  'producto', 'productos', 'unidad', 'unidades', 'pcs', 'pza', 'pzas', 'piezas', 'pieza', 'par', 'pares', 'talla', 'color', 'colores',
  'mas', 'super', 'premium', 'calidad', 'alta', 'importado', 'importada', 'tipo', 'estilo', 'modelo', 'version', 'edicion',
  'ml', 'gr', 'g', 'kg', 'cm', 'mm', 'm', 'lt', 'l', 'oz', 'w', 'v', 'mah', 'gb', 'tb', 'pulgadas', 'pulg',
]);
// Fichas de servicio que Dropi lista como productos: nunca se buscan.
const RE_SERVICIO = /^\s*(caja|cajas)\s+(de\s+)?env[ií]os?\s*$|producto\s+privado|producto\s+gratis|env[ií]o\s+prioritario|diferencia\s+de\s+precio|^\s*flete|^\s*recargo|^\s*garant[ií]a\s*$/i;
function terminoBusqueda(nombre) {
  if (RE_SERVICIO.test(String(nombre || ''))) return '';
  const base = String(nombre || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/ñ/g, 'ñ') // la ñ se conserva: «navideno» no encuentra nada en Meta, «navideño» sí
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .split(' ')
    // Fuera números sueltos y medidas («500», «49mm»); se quedan los códigos de modelo («t900», «d20»), que son lo más buscable.
    .filter((w) => w && !RELLENO.has(w) && !/^\d+[a-z]*$/.test(w) && w.length >= 3);
  // Sin repetidas, en el orden del nombre (lo primero suele ser lo que define el producto).
  const palabras = [...new Set(base)].slice(0, 3);
  // Una sola palabra solo si es un nombre propio largo (ASTAXANTHIN, SHILAJIT); «privado»,
  // «prioritario» o «entrenamiento» solas traen cualquier anuncio que use esa palabra.
  if (palabras.length === 1 && (palabras[0].length < 7 || GENERICAS_SOLAS.has(palabras[0]))) return '';
  return palabras.join(' ');
}
// Fichas de servicio de Dropi y nombres sin producto: no se buscan en Meta (el 31-10 «PRODUCTO
// PRIVADO», «ENVIO PRIORITARIO», «PRODUCTO GRATIS» y «Caja Envíos» trajeron 200+ vínculos falsos).
const GENERICAS_SOLAS = new Set([
  'privado', 'privados', 'prioritario', 'entrenamiento', 'importado', 'importados', 'servicio', 'servicios', 'garantia',
  'diferencia', 'recarga', 'muestra', 'muestras', 'repuesto', 'repuestos', 'accesorio', 'accesorios', 'regalo', 'regalos',
  'sorpresa', 'variado', 'variados', 'surtido', 'surtidos', 'especial', 'exclusivo', 'generico', 'generica', 'articulo', 'articulos',
]);
const esBuscable = (nombre) => Boolean(terminoBusqueda(nombre));

/**
 * Cola de productos para que la extensión los busque en la Biblioteca de Meta:
 * primero los que el usuario sigue, luego los que más venden (7 d, 30 d). Se
 * saltan los barridos hace menos de `dias` días. Pensado para miles de
 * productos: una sola consulta por índice (pais, ventas_7d) con LIMIT.
 */
async function radarCola(params = {}, sessionUser = {}) {
  const pais = validarPais(params.pais);
  const limit = Math.min(1000, Math.max(1, Number(params.limit) || 300));
  const dias = Math.min(90, Math.max(1, Number(params.dias) || 7));
  const idSub = Number(sessionUser.id_sub_usuario) || 0;
  const campos = `p.dropi_product_id, p.nombre, p.imagen_url, p.precio, p.ventas_7d, p.ventas_30d, p.n_anuncios, p.radar_en`;
  const pendiente = `(p.radar_en IS NULL OR p.radar_en < DATE_SUB(NOW(), INTERVAL :dias DAY))`;
  const [seguidos, top, [tot], [pend]] = await Promise.all([
    idSub
      ? q(
          `SELECT ${campos} FROM espia_seguimiento s
             JOIN espia_producto p ON p.pais = :pais AND p.dropi_product_id = CAST(SUBSTRING_INDEX(s.ref, ':', -1) AS UNSIGNED)
            WHERE s.id_sub_usuario = :idSub AND s.tipo = 'producto' AND s.ref LIKE :pref AND ${pendiente}
            ORDER BY p.ventas_7d DESC LIMIT 200`,
          { pais, idSub, pref: `${pais}:%`, dias },
        )
      : Promise.resolve([]),
    // Se piden de más porque las fichas no buscables (servicios, nombres genéricos) se filtran aquí.
    q(
      `SELECT ${campos} FROM espia_producto p
        WHERE p.pais = :pais AND p.nombre IS NOT NULL AND p.nombre <> '' AND ${pendiente}
        ORDER BY p.ventas_7d DESC, p.ventas_30d DESC, p.ventas_total DESC LIMIT :limitAmplio`,
      { pais, dias, limitAmplio: Math.round(limit * 1.4) + 50 },
    ),
    q(`SELECT COUNT(*) AS n FROM espia_producto p WHERE p.pais = :pais`, { pais }),
    q(`SELECT COUNT(*) AS n FROM espia_producto p WHERE p.pais = :pais AND ${pendiente}`, { pais, dias }),
  ]);
  const vistos = new Set();
  const items = [];
  let noBuscables = 0;
  for (const p of [...seguidos, ...top]) {
    const id = String(p.dropi_product_id);
    if (vistos.has(id)) continue;
    vistos.add(id);
    const termino = terminoBusqueda(p.nombre);
    if (!termino) { noBuscables++; continue; }
    items.push({ ...p, dropi_product_id: Number(p.dropi_product_id), termino, seguido: vistos.size <= seguidos.length });
    if (items.length >= limit) break;
  }
  return { pais, dias, total_productos: Number(tot?.n || 0), pendientes: Number(pend?.n || 0), no_buscables: noBuscables, items };
}

/**
 * Deshace los vínculos de productos que no debieron buscarse (nombres de servicio o genéricos):
 * borra sus filas en espia_anuncio_producto, pone n_anuncios en 0 y radar_en en NULL. Los
 * anuncios se quedan: siguen valiendo en la pestaña Anuncios y Tiendas.
 */
async function limpiarVinculosNoBuscables(paisCrudo) {
  const pais = validarPais(paisCrudo);
  const filas = await q(`SELECT dropi_product_id, nombre FROM espia_producto WHERE pais = :pais AND radar_en IS NOT NULL`, { pais });
  const malos = filas.filter((f) => !esBuscable(f.nombre));
  if (!malos.length) return { pais, revisados: filas.length, limpiados: [], vinculos_borrados: 0 };
  const ids = malos.map((m) => Number(m.dropi_product_id));
  // BULKDELETE devuelve el número de filas afectadas directo (ver nota sequelize-raw-update-delete-affected-rows).
  const borrados = Number(
    await db.query(`DELETE FROM espia_anuncio_producto WHERE pais = :pais AND dropi_product_id IN (:ids)`, {
      replacements: { pais, ids },
      type: QueryTypes.BULKDELETE,
    }),
  ) || 0;
  await db.query(`UPDATE espia_producto SET n_anuncios = 0, radar_en = NULL WHERE pais = :pais AND dropi_product_id IN (:ids)`, {
    replacements: { pais, ids },
    type: QueryTypes.UPDATE,
  });
  return { pais, revisados: filas.length, limpiados: malos.map((m) => ({ id: Number(m.dropi_product_id), nombre: m.nombre })), vinculos_borrados: borrados };
}

// Vincula anuncios ya guardados con un producto y refresca su conteo + radar_en.
async function vincularProducto(pais, idCrudo, adIds = [], origen = 'radar') {
  const id = Number(idCrudo);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('Producto inválido', 400);
  const ids = [...new Set((Array.isArray(adIds) ? adIds : []).map((x) => String(x || '').replace(/\D/g, '')).filter(Boolean))].slice(0, 500);
  const ahora = ahoraSql();
  if (ids.length) {
    // Solo anuncios que existen (los manda el mismo lote justo antes); INSERT IGNORE = idempotente.
    await db.query(
      `INSERT IGNORE INTO espia_anuncio_producto (pais, dropi_product_id, ad_archive_id, origen, creado_en)
       SELECT :pais, :id, a.ad_archive_id, :origen, :ahora FROM espia_anuncio a WHERE a.ad_archive_id IN (:ids)`,
      { replacements: { pais, id, origen: origen === 'manual' ? 'manual' : 'radar', ahora, ids }, type: QueryTypes.INSERT },
    );
  }
  await db.query(
    `UPDATE espia_producto p
        SET p.radar_en = :ahora,
            p.n_anuncios = (SELECT COUNT(*) FROM espia_anuncio_producto ap
                              JOIN espia_anuncio a ON a.ad_archive_id = ap.ad_archive_id AND a.activo = 1
                             WHERE ap.pais = p.pais AND ap.dropi_product_id = p.dropi_product_id)
      WHERE p.pais = :pais AND p.dropi_product_id = :id`,
    { replacements: { pais, id, ahora }, type: QueryTypes.UPDATE },
  );
  const [fila] = await q(`SELECT n_anuncios, radar_en FROM espia_producto WHERE pais = :pais AND dropi_product_id = :id`, { pais, id });
  return { dropi_product_id: id, vinculados: ids.length, n_anuncios: Number(fila?.n_anuncios || 0), radar_en: fila?.radar_en || ahora };
}

/** La extensión terminó de buscar un producto (haya o no anuncios): marca radar_en y vincula lo que vio. */
async function radarMarcar(body = {}) {
  const pais = validarPais(body.pais);
  return vincularProducto(pais, body.dropi_product_id, body.ad_ids, body.origen);
}

async function actualizarTienda(dominio, pais, nuevosHoy, hoy, ahora) {
  const [c] = await q(
    `SELECT COUNT(*) AS n, SUM(ultima_vez_visto >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS hoy
       FROM espia_anuncio WHERE dominio = :dominio AND activo = 1`,
    { dominio },
  );
  const activos = Number(c?.n || 0);
  // Plataforma de la tienda = la más repetida entre sus anuncios (la deduce la extensión).
  const [pl] = await q(
    `SELECT tienda_plataforma AS p, COUNT(*) n FROM espia_anuncio
      WHERE dominio = :dominio AND activo = 1 AND tienda_plataforma IS NOT NULL
      GROUP BY tienda_plataforma ORDER BY n DESC LIMIT 1`,
    { dominio },
  );
  const plataforma = pl?.p || null;
  await q(
    `INSERT INTO espia_tienda (dominio, pais_principal, anuncios_activos, plataforma, es_shopify, primera_vez, ultima_vez)
     VALUES (:dominio, :pais, :activos, :plataforma, :esShopify, :ahora, :ahora)
     ON DUPLICATE KEY UPDATE anuncios_activos = VALUES(anuncios_activos), ultima_vez = VALUES(ultima_vez),
       plataforma = COALESCE(VALUES(plataforma), plataforma),
       es_shopify = COALESCE(es_shopify, VALUES(es_shopify)),
       pais_principal = IF(:pais = 'ALL', pais_principal, :pais)`,
    { dominio, pais: pais === 'ALL' ? null : pais, activos, plataforma, esShopify: plataforma === 'shopify' ? 1 : null, ahora },
    QueryTypes.INSERT,
  );
  await q(
    `INSERT INTO espia_tienda_dia (dominio, fecha, anuncios_activos, anuncios_nuevos)
     VALUES (:dominio, :fecha, :activos, :nuevos)
     ON DUPLICATE KEY UPDATE anuncios_activos = GREATEST(anuncios_activos, VALUES(anuncios_activos)),
                             anuncios_nuevos = anuncios_nuevos + VALUES(anuncios_nuevos)`,
    { dominio, fecha: hoy, activos, nuevos: Number(nuevosHoy) || 0 },
    QueryTypes.INSERT,
  );
  return activos;
}

async function registrarVistaTienda(body = {}, sessionUser = {}) {
  const dominio = limpiarDominio(body.dominio);
  if (!dominio) throw new AppError('Dominio inválido', 400);
  const pais = ['EC', 'MX'].includes(String(body.pais || '').toUpperCase()) ? String(body.pais).toUpperCase() : 'ALL';
  const ahora = ahoraSql();
  const hoy = calc.fechaLocal(ahora, pais === 'MX' ? 'MX' : 'EC');
  await actualizarTienda(dominio, pais, 0, hoy, ahora);
  if (Number(body.anuncios_activos_vistos) > 0) {
    await q(
      `UPDATE espia_tienda SET anuncios_activos = GREATEST(anuncios_activos, :n) WHERE dominio = :dominio`,
      { n: Number(body.anuncios_activos_vistos), dominio },
      QueryTypes.UPDATE,
    );
  }
  perfilarTienda(dominio).catch(() => {});
  const tienda = await EspiaTienda.findByPk(dominio, { raw: true });
  const seguida = await estaSeguida(sessionUser.id_sub_usuario, 'tienda', dominio);
  return { tienda, seguida };
}

/** Perfil Shopify de un dominio: /products.json y /meta.json (públicos). */
async function perfilarTienda(dominio) {
  const http = axios.create({ timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ImporchatEspia/1.0)' }, maxRedirects: 3 });
  const ahora = ahoraSql();
  let es_shopify = 0;
  let productos = null;
  let moneda = null;
  let nombre = null;
  try {
    const { data } = await http.get(`https://${dominio}/products.json?limit=250`);
    if (data && Array.isArray(data.products)) {
      es_shopify = 1;
      productos = data.products.length;
      if (productos === 250) {
        try {
          const r2 = await http.get(`https://${dominio}/products.json?limit=250&page=2`);
          if (Array.isArray(r2.data?.products)) productos += r2.data.products.length;
        } catch { /* se queda en 250 */ }
      }
      const conPrecio = data.products.find((p) => p.variants?.[0]?.price);
      if (conPrecio && !moneda) moneda = null; // la moneda sale de meta.json
    }
  } catch { /* no es Shopify o no responde */ }
  if (es_shopify) {
    try {
      const { data: meta } = await http.get(`https://${dominio}/meta.json`);
      if (meta?.currency) moneda = String(meta.currency).slice(0, 10);
      if (meta?.name) nombre = String(meta.name).slice(0, 200);
    } catch { /* sin meta */ }
  }
  const [top] = await q(
    `SELECT producto, COUNT(*) n FROM espia_anuncio WHERE dominio = :dominio AND activo = 1 AND producto IS NOT NULL
      GROUP BY producto ORDER BY n DESC LIMIT 1`,
    { dominio },
  );
  await q(
    `UPDATE espia_tienda SET es_shopify = :es_shopify, productos = :productos, moneda = COALESCE(:moneda, moneda),
            nombre = COALESCE(:nombre, nombre), producto_top = COALESCE(:top, producto_top), ultima_revision = :ahora
      WHERE dominio = :dominio`,
    { es_shopify, productos, moneda, nombre, top: top?.producto || null, ahora, dominio },
    QueryTypes.UPDATE,
  );
  return { dominio, es_shopify, productos, moneda, nombre };
}

/** Perfila hasta N tiendas sin revisar (o revisadas hace > 7 días), con 2 s entre cada una. */
async function perfilarPendientes(max = 200) {
  const rows = await q(
    `SELECT dominio FROM espia_tienda
      WHERE ultima_revision IS NULL OR ultima_revision < DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY anuncios_activos DESC LIMIT :max`,
    { max: Number(max) || 1 },
  );
  let n = 0;
  for (const r of rows) {
    try {
      await perfilarTienda(r.dominio);
      n += 1;
    } catch { /* sigue con la próxima */ }
    await dormir(2000);
  }
  return n;
}

/** Anuncios no vistos en 60 días dejan de estar activos (regla de Dropkiller). */
async function marcarInactivos() {
  const r = await q(
    `UPDATE espia_anuncio SET activo = 0 WHERE activo = 1 AND ultima_vez_visto < DATE_SUB(NOW(), INTERVAL :d DAY)`,
    { d: DIAS_PARA_INACTIVO },
    QueryTypes.UPDATE,
  );
  return r;
}

const CAMPOS_ANUNCIO = `a.ad_archive_id, a.pais, a.pagina_id, a.pagina_nombre, a.dominio, a.url_destino, a.producto,
  a.titulo, a.texto, a.tipo, a.media_url, a.imagen_url, a.plataformas, a.tienda_plataforma, a.inicio, a.primera_vez_visto, a.ultima_vez_visto,
  a.activo, a.n_duplicados, a.veces_visto, DATEDIFF(CURDATE(), a.inicio) AS dias_activo`;

async function listarAnuncios(params = {}) {
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 24));
  const page = Math.max(1, Number(params.page) || 1);
  const where = ['a.activo = 1'];
  const repl = { limit, offset: (page - 1) * limit };
  const pais = String(params.pais || '').toUpperCase();
  if (pais && pais !== 'ALL') { where.push(`(a.pais = :pais OR a.pais = 'ALL')`); repl.pais = pais; }
  if (params.q && String(params.q).trim().length >= 2) {
    where.push('(a.texto LIKE :q OR a.titulo LIKE :q OR a.producto LIKE :q OR a.pagina_nombre LIKE :q OR a.dominio LIKE :q)');
    repl.q = `%${String(params.q).trim()}%`;
  }
  if (params.dominio) { where.push('a.dominio = :dominio'); repl.dominio = limpiarDominio(params.dominio) || String(params.dominio); }
  if (params.tipo === 'video' || params.tipo === 'imagen') { where.push('a.tipo = :tipo'); repl.tipo = params.tipo; }
  if (['shopify', 'whatsapp', 'dropi', 'web'].includes(String(params.plataforma || ''))) { where.push('a.tienda_plataforma = :plataforma'); repl.plataforma = params.plataforma; }
  if (params.min_dias !== undefined && params.min_dias !== '') { where.push('DATEDIFF(CURDATE(), a.inicio) >= :min_dias'); repl.min_dias = Number(params.min_dias); }
  if (params.max_dias !== undefined && params.max_dias !== '') { where.push('DATEDIFF(CURDATE(), a.inicio) <= :max_dias'); repl.max_dias = Number(params.max_dias); }
  if (params.visto_dias !== undefined && params.visto_dias !== '') {
    where.push('a.ultima_vez_visto >= DATE_SUB(NOW(), INTERVAL :visto_dias DAY)');
    repl.visto_dias = Number(params.visto_dias);
  }
  if (params.pagina_id) { where.push('a.pagina_id = :pagina_id'); repl.pagina_id = String(params.pagina_id); }
  const orden =
    params.orden === 'recientes' ? 'a.inicio DESC, a.ultima_vez_visto DESC'
    : params.orden === 'duplicados' ? 'a.n_duplicados DESC, dias_activo DESC'
    : params.orden === 'vistos' ? 'a.ultima_vez_visto DESC'
    : 'dias_activo DESC, a.n_duplicados DESC';
  const w = `WHERE ${where.join(' AND ')}`;
  const items = await q(`SELECT ${CAMPOS_ANUNCIO} FROM espia_anuncio a ${w} ORDER BY ${orden} LIMIT :limit OFFSET :offset`, repl);
  const [cnt] = await q(`SELECT COUNT(*) AS total FROM espia_anuncio a ${w}`, repl);
  for (const a of items) a.url_meta = `https://www.facebook.com/ads/library/?id=${a.ad_archive_id}`;
  return { total: Number(cnt?.total || 0), page, limit, items };
}

/**
 * Creativo de un anuncio para descargarlo desde la pantalla (video, o imagen si
 * no hay video). Devuelve la URL de origen; quien la sirve es el controlador.
 * La URL llega de la extensión, así que solo se aceptan https de Meta (fbcdn) o
 * del almacén propio: el servidor nunca va a buscar una dirección cualquiera.
 */
const HOST_CREATIVO = /(^|\.)fbcdn\.net$|^imp-datas\.s3\.amazonaws\.com$|(^|\.)imporfactory\.app$/i;
async function creativoDe(idCrudo) {
  const id = String(idCrudo || '').trim().slice(0, 40);
  if (!/^[\w-]+$/.test(id)) throw new AppError('Anuncio inválido', 400);
  const [a] = await q(`SELECT ad_archive_id, tipo, media_url, imagen_url FROM espia_anuncio WHERE ad_archive_id = :id`, { id });
  if (!a) throw new AppError('Ese anuncio ya no está en ImporKiller', 404);
  const candidatas = a.tipo === 'video' ? [a.media_url, a.imagen_url] : [a.imagen_url, a.media_url];
  const urls = candidatas.filter((u) => {
    try {
      const p = new URL(String(u || ''));
      return p.protocol === 'https:' && HOST_CREATIVO.test(p.hostname);
    } catch {
      return false;
    }
  });
  if (!urls.length) throw new AppError('Este anuncio no tiene un archivo para descargar', 404);
  return { id: a.ad_archive_id, tipo: a.tipo, urls };
}

async function estaSeguida(idSub, tipo, ref) {
  if (!idSub) return false;
  const r = await EspiaSeguimiento.findOne({ where: { id_sub_usuario: idSub, tipo, ref }, raw: true });
  return Boolean(r);
}

async function tendenciaDe(dominios, dias = 30) {
  if (!dominios.length) return {};
  const rows = await q(
    `SELECT dominio, fecha, anuncios_activos AS n, anuncios_nuevos AS nuevos FROM espia_tienda_dia
      WHERE dominio IN (:dominios) AND fecha >= DATE_SUB(CURDATE(), INTERVAL :dias DAY) ORDER BY fecha`,
    { dominios, dias },
  );
  const salida = {};
  for (const r of rows) (salida[r.dominio] ||= []).push({ fecha: r.fecha, n: Number(r.n), nuevos: Number(r.nuevos) });
  return salida;
}

/* Destinos de anuncios que no son la tienda de nadie (apps, acortadores, el
   aviso de transparencia de Meta, marketplaces). Medido el 10-11-2026: Google
   Play salía primero en «Tiendas» con 108 anuncios. No se muestran ni se cuentan. */
const NO_SON_TIENDAS = [
  'play.google.com', 'itunes.apple.com', 'apps.apple.com', 'drive.google.com', 'docs.google.com', 'forms.gle',
  'transparency.meta.com', 'facebook.com', 'm.facebook.com', 'instagram.com', 'youtube.com', 'youtu.be', 'tiktok.com',
  't.me', 'bit.ly', 'linktr.ee', 'amazon.com', 'mercadolibre.com.ec', 'mercadolibre.com.mx', 'mercadolibre.com.co',
];

async function listarTiendas(params = {}, sessionUser = {}) {
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 30));
  const page = Math.max(1, Number(params.page) || 1);
  const idSub = Number(sessionUser.id_sub_usuario) || 0;
  const where = ['t.dominio NOT IN (:noTiendas)'];
  const repl = { limit, offset: (page - 1) * limit, idSub, noTiendas: NO_SON_TIENDAS };
  const pais = String(params.pais || '').toUpperCase();
  if (pais && pais !== 'ALL') { where.push('(t.pais_principal = :pais OR t.pais_principal IS NULL)'); repl.pais = pais; }
  if (params.q && String(params.q).trim().length >= 2) { where.push('(t.dominio LIKE :q OR t.nombre LIKE :q)'); repl.q = `%${String(params.q).trim()}%`; }
  if (params.es_shopify === '1' || params.es_shopify === 1 || params.es_shopify === true) where.push('t.es_shopify = 1');
  if (['shopify', 'whatsapp', 'dropi', 'web'].includes(String(params.plataforma || ''))) { where.push('t.plataforma = :plataforma'); repl.plataforma = params.plataforma; }
  if (params.min_activos) { where.push('t.anuncios_activos >= :min_activos'); repl.min_activos = Number(params.min_activos); }
  if (params.solo_seguidas === '1' || params.solo_seguidas === 1 || params.solo_seguidas === true) where.push('s.ref IS NOT NULL');
  const orden =
    params.orden === 'nuevos' ? 't.primera_vez DESC'
    : params.orden === 'productos' ? 't.productos DESC'
    : params.orden === 'recientes' ? 't.ultima_vez DESC'
    : 't.anuncios_activos DESC, t.ultima_vez DESC';
  const sql = `FROM espia_tienda t
               LEFT JOIN espia_seguimiento s ON s.tipo = 'tienda' AND s.ref = t.dominio AND s.id_sub_usuario = :idSub
               WHERE ${where.join(' AND ')}`;
  const items = await q(
    `SELECT t.*, (s.ref IS NOT NULL) AS seguida,
            (SELECT COALESCE(anuncios_nuevos,0) FROM espia_tienda_dia d WHERE d.dominio = t.dominio AND d.fecha = CURDATE()) AS anuncios_nuevos_hoy
       ${sql} ORDER BY ${orden} LIMIT :limit OFFSET :offset`,
    repl,
  );
  const [cnt] = await q(`SELECT COUNT(*) AS total ${sql}`, repl);
  const tend = await tendenciaDe(items.map((t) => t.dominio));
  for (const t of items) {
    t.seguida = Boolean(Number(t.seguida));
    t.anuncios_nuevos_hoy = Number(t.anuncios_nuevos_hoy || 0);
    t.tendencia = tend[t.dominio] || [];
    t.tipo_tienda = t.productos == null ? null : t.productos <= 30 ? 'marca' : 'dropshipping';
  }
  return { total: Number(cnt?.total || 0), page, limit, items };
}

async function detalleTienda(dominioCrudo, sessionUser = {}) {
  const dominio = limpiarDominio(dominioCrudo);
  if (!dominio) throw new AppError('Dominio inválido', 400);
  const tienda = await EspiaTienda.findByPk(dominio, { raw: true });
  if (!tienda) throw new AppError('Esa tienda todavía no está en el espía', 404);
  tienda.seguida = await estaSeguida(sessionUser.id_sub_usuario, 'tienda', dominio);
  tienda.tipo_tienda = tienda.productos == null ? null : tienda.productos <= 30 ? 'marca' : 'dropshipping';
  const anuncios = await q(
    `SELECT ${CAMPOS_ANUNCIO} FROM espia_anuncio a WHERE a.dominio = :dominio AND a.activo = 1
      ORDER BY a.producto, dias_activo DESC LIMIT 500`,
    { dominio },
  );
  const grupos = new Map();
  for (const a of anuncios) {
    a.url_meta = `https://www.facebook.com/ads/library/?id=${a.ad_archive_id}`;
    const k = a.producto || 'Sin enlace';
    if (!grupos.has(k)) grupos.set(k, { producto: k, url_destino: a.url_destino, n_anuncios: 0, anuncios: [] });
    const g = grupos.get(k);
    g.n_anuncios += 1;
    g.anuncios.push(a);
  }
  const productos = [...grupos.values()].sort((x, y) => y.n_anuncios - x.n_anuncios);
  const tendencia = (await tendenciaDe([dominio]))[dominio] || [];
  return { tienda, tendencia, productos, total_anuncios: anuncios.length };
}

async function seguir(body = {}, sessionUser = {}) {
  const idSub = Number(sessionUser.id_sub_usuario);
  if (!idSub) throw new AppError('No autenticado', 401);
  const tipo = body.tipo === 'producto' ? 'producto' : body.tipo === 'tienda' ? 'tienda' : null;
  if (!tipo) throw new AppError('tipo debe ser tienda o producto', 400);
  let ref;
  if (tipo === 'tienda') {
    ref = limpiarDominio(body.ref);
    if (!ref) throw new AppError('Dominio inválido', 400);
  } else {
    const pais = validarPais(body.pais);
    const id = Number(body.ref);
    if (!Number.isFinite(id)) throw new AppError('Producto inválido', 400);
    ref = `${pais}:${id}`;
  }
  const existente = await EspiaSeguimiento.findOne({ where: { id_sub_usuario: idSub, tipo, ref } });
  if (existente) {
    await existente.destroy();
    return { seguida: false, tipo, ref };
  }
  await EspiaSeguimiento.create({ id_sub_usuario: idSub, tipo, ref, creado_en: ahoraSql() });
  return { seguida: true, tipo, ref };
}

/* =========================================================================
   4. ESTADO Y REPORTE
   ========================================================================= */

async function estado(paisCrudo) {
  const pais = validarPais(paisCrudo);
  const ultima = await EspiaPasada.findOne({ where: { pais }, order: [['inicio', 'DESC']], raw: true });
  const ultimaCompleta = await EspiaPasada.findOne({ where: { pais, estado: 'ok' }, order: [['inicio', 'DESC']], raw: true });
  const [prod] = await q(`SELECT COUNT(*) AS n, MAX(ultima_vez) AS ultima FROM espia_producto WHERE pais = :pais`, { pais });
  const [anu] = await q(
    `SELECT COUNT(*) AS n, MAX(ultima_vez_visto) AS ultima FROM espia_anuncio WHERE activo = 1 AND (pais = :pais OR pais = 'ALL')`,
    { pais },
  );
  const [tie] = await q(
    `SELECT COUNT(*) AS n FROM espia_tienda WHERE (pais_principal = :pais OR pais_principal IS NULL) AND dominio NOT IN (:noTiendas)`,
    { pais, noTiendas: NO_SON_TIENDAS },
  );
  const [vd] = await q(`SELECT COUNT(DISTINCT fecha) AS dias FROM espia_ventas_dia WHERE pais = :pais`, { pais });
  // Ventas estimadas del último día cerrado (ayer) y lo que va de hoy: el KPI
  // del cliente siempre tiene un número en vez de «se calcula con la próxima
  // actualización», que no le decía nada.
  const [vh] = await q(`SELECT SUM(unidades) AS hoy FROM espia_ventas_dia WHERE pais = :pais AND fecha = CURDATE()`, { pais });
  const [va] = await q(
    `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, SUM(unidades) AS unidades
       FROM espia_ventas_dia WHERE pais = :pais AND fecha < CURDATE()
      GROUP BY fecha ORDER BY fecha DESC LIMIT 1`,
    { pais },
  );
  const [rad] = await q(
    `SELECT SUM(radar_en IS NOT NULL) AS barridos, SUM(n_anuncios > 0) AS con_anuncios, MAX(radar_en) AS ultimo
       FROM espia_producto WHERE pais = :pais`,
    { pais },
  );
  // Cuentas de Dropi del país: cuántas hay registradas y cuál usaría la próxima pasada.
  let cuenta;
  let cuentas = { total: 0, activas: 0, con_error: 0, respaldo: CUENTA_POR_PAIS[pais] || null };
  if (pais === 'QA') {
    cuenta = { origen: 'mock', descripcion: 'Mock', etiqueta: 'Pruebas' };
  } else {
    try {
      const { resumen } = await listarCuentas(pais);
      cuentas = resumen[pais] || cuentas;
    } catch (e) {
      cuentas = { ...cuentas, error: e.message };
    }
    try {
      const c = await cuentaDe(pais);
      cuenta = {
        origen: c.origen,
        id: c.id,
        correo: c.correo,
        etiqueta: c.etiqueta,
        token_last4: c.token_last4,
        descripcion: c.descripcion,
        id_configuracion: c.id_configuracion || null,
        store_name: c.store_name || null,
        nombre_configuracion: c.nombre_configuracion || null,
      };
    } catch (e) {
      cuenta = { origen: null, error: e.message };
    }
  }
  return {
    pais,
    cuenta,
    cuentas,
    fuente: process.env.ESPIA_MOCK_DIR ? 'mock' : 'dropi',
    ultima_pasada: ultima || null,
    ultima_completa: ultimaCompleta ? { id: ultimaCompleta.id, fin: ultimaCompleta.fin, productos: ultimaCompleta.productos, paginas: ultimaCompleta.paginas, minutos: ultimaCompleta.fin ? Math.round((new Date(ultimaCompleta.fin) - new Date(ultimaCompleta.inicio)) / 60000) : null } : null,
    corriendo: Boolean(corriendo[pais]),
    freno_hasta: frenoHasta[pais] && Date.now() < frenoHasta[pais] ? new Date(frenoHasta[pais]) : null,
    productos_total: Number(prod?.n || 0),
    productos_ultima_vez: prod?.ultima || null,
    dias_con_ventas: Number(vd?.dias || 0),
    ventas_hoy: vh?.hoy != null ? Number(vh.hoy) : 0,
    ventas_ultimo_dia: va ? { fecha: va.fecha, unidades: Number(va.unidades || 0) } : null,
    cron_activo: String(process.env.CRONS_ENABLED ?? 'true').toLowerCase() !== 'false',
    extension: { anuncios_total: Number(anu?.n || 0), tiendas_total: Number(tie?.n || 0), ultimo_envio: anu?.ultima || null },
    radar: { barridos: Number(rad?.barridos || 0), con_anuncios: Number(rad?.con_anuncios || 0), ultimo: rad?.ultimo || null },
  };
}

const fmt = (n) => Number(n || 0).toLocaleString('es-EC');
const corto = (s, n = 38) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

async function reporte(paisCrudo) {
  const pais = validarPais(paisCrudo);
  const nombrePais = NOMBRE_PAIS[pais] || pais;
  const enlace = (atajo) => `${FRONTEND_URL}/imporkiller?pais=${pais}&tab=productos&atajo=${atajo}`;
  const [subieron, sinEscalar, nuevos] = await Promise.all([
    listarProductos({ pais, atajo: 'todos', orden: 'subida', min_v7: 1, limit: 10 }),
    listarProductos({ pais, atajo: 'sin_escalar', orden: 'v7', limit: 10 }),
    listarProductos({ pais, atajo: 'nuevos_traccion', orden: 'v7', limit: 10 }),
  ]);
  const seguidas = await q(
    `SELECT t.dominio, t.nombre, t.anuncios_activos,
            (SELECT COALESCE(anuncios_nuevos,0) FROM espia_tienda_dia d WHERE d.dominio = t.dominio AND d.fecha >= DATE_SUB(CURDATE(), INTERVAL 1 DAY) ORDER BY fecha DESC LIMIT 1) AS nuevos
       FROM espia_tienda t
      WHERE t.dominio IN (SELECT ref FROM espia_seguimiento WHERE tipo = 'tienda')
      ORDER BY nuevos DESC, t.anuncios_activos DESC LIMIT 10`,
  );
  const est = await estado(pais);
  const dias = Number(est.dias_con_ventas || 0);
  // Con menos de dos semanas medidas la ventana «7 anteriores» está vacía y el
  // «vs 0» engaña: hasta entonces el bloque es simplemente «los más vendidos».
  const comparaSemanas = dias >= 14;
  const producto = (p) => ({
    dropi_product_id: p.dropi_product_id,
    nombre: p.nombre,
    imagen_url: p.imagen_url || null,
    proveedor: p.proveedor_nombre || null,
    categoria: p.categoria || null,
    precio: p.precio != null ? Number(p.precio) : null,
    stock: Number(p.stock_actual || 0),
    ventas_7d: Number(p.ventas_7d || 0),
    ventas_7d_prev: Number(p.ventas_7d_prev || 0),
    ventas_30d: Number(p.ventas_30d || 0),
    ventas_total: Number(p.ventas_total || 0),
    reabastecimientos: Number(p.reabastecimientos || 0),
    n_anuncios: Number(p.n_anuncios || 0),
  });
  // Lo mismo que el texto de WhatsApp, pero estructurado para que la pantalla
  // lo pinte como lista (la ficha de cada producto se abre desde ahí).
  const secciones = [
    {
      clave: 'subieron',
      titulo: comparaSemanas ? 'Los que más subieron esta semana' : 'Los más vendidos esta semana',
      descripcion: comparaSemanas ? 'Ventas de los últimos 7 días frente a los 7 anteriores.' : `Ventas estimadas de los últimos 7 días (llevamos ${dias} ${dias === 1 ? 'día medido' : 'días medidos'}; la comparación semanal aparece a los 14).`,
      filtros: { atajo: 'todos', orden: 'subida' },
      items: subieron.items.map(producto),
    },
    {
      clave: 'sin_escalar',
      titulo: 'Sin escalar',
      descripcion: 'Venden entre 10 y 120 a la semana, entre 120 y 500 al mes y tienen stock (≥ 80): hay espacio para pautar más.',
      filtros: { atajo: 'sin_escalar', orden: 'v7' },
      items: sinEscalar.items.map(producto),
      necesita_dias: 30,
    },
    {
      clave: 'nuevos',
      titulo: 'Nuevos con tracción',
      descripcion: 'Creados hace 90 días o menos, con 100 a 2.000 ventas estimadas en total.',
      filtros: { atajo: 'nuevos_traccion', orden: 'v7' },
      items: nuevos.items.map(producto),
      necesita_dias: 14,
    },
  ];
  const tiendas = seguidas.map((t) => ({ dominio: t.dominio, nombre: t.nombre || null, anuncios_activos: Number(t.anuncios_activos || 0), nuevos: Number(t.nuevos || 0) }));

  const lineas = [];
  lineas.push(`📡 *ImporKiller · ${nombrePais}* · ${calc.fechaLocal(new Date(), pais)}`);
  if (!est.ultima_pasada) {
    lineas.push('Todavía no hay una pasada del catálogo. Cuando corra el recolector, este reporte trae los productos.');
  } else {
    lineas.push(`Catálogo: ${fmt(est.productos_total)} productos · ${dias} días medidos`);
  }
  const bloque = (titulo, lista, atajo, extra) => {
    lineas.push('');
    lineas.push(`*${titulo}*`);
    if (!lista.items.length) {
      lineas.push('— sin productos que cumplan hoy —');
    } else {
      lista.items.forEach((p, i) => lineas.push(`${i + 1}. ${corto(p.nombre)} · ${extra(p)}`));
    }
    lineas.push(`👉 ${enlace(atajo)}`);
  };
  bloque(
    comparaSemanas ? '🔥 Los que más subieron (7 días vs 7 anteriores)' : '🔥 Los más vendidos (últimos 7 días)',
    subieron,
    'todos&orden=subida',
    (p) => (comparaSemanas ? `${fmt(p.ventas_7d)} vs ${fmt(p.ventas_7d_prev)} · stock ${fmt(p.stock_actual)}` : `${fmt(p.ventas_7d)} en 7 d · stock ${fmt(p.stock_actual)}`),
  );
  bloque('🚀 Sin escalar (7d 10–120, 30d 120–500, stock ≥ 80)', sinEscalar, 'sin_escalar', (p) => `7d ${fmt(p.ventas_7d)} · 30d ${fmt(p.ventas_30d)} · ${corto(p.proveedor_nombre, 18)}`);
  bloque('🌱 Nuevos con tracción (≤ 90 días, 100–2.000 totales)', nuevos, 'nuevos_traccion', (p) => `total ${fmt(p.ventas_total)} · 7d ${fmt(p.ventas_7d)} · reab ${p.reabastecimientos}`);
  if (seguidas.length) {
    lineas.push('');
    lineas.push('*👀 Tiendas que sigues*');
    for (const t of seguidas) {
      lineas.push(`• ${t.dominio} · ${fmt(t.anuncios_activos)} activos · ${fmt(t.nuevos)} nuevos`);
    }
    lineas.push(`👉 ${FRONTEND_URL}/imporkiller?pais=${pais}&tab=tiendas&solo_seguidas=1`);
  }
  lineas.push('');
  lineas.push('_Ventas estimadas por baja de stock en Dropi; un traslado o ajuste puede verse como venta._');
  return {
    pais,
    nombre_pais: nombrePais,
    fecha: calc.fechaLocal(new Date(), pais),
    catalogo: Number(est.productos_total || 0),
    dias_medidos: dias,
    compara_semanas: comparaSemanas,
    actualizado_en: est.productos_ultima_vez || null,
    secciones,
    tiendas,
    texto: lineas.join('\n'),
    generado_en: new Date(),
  };
}

/** Manda el reporte por WhatsApp si está configurado el destino. */
async function enviarReporteWhatsapp(paisCrudo) {
  const pais = validarPais(paisCrudo);
  const idConf = Number(process.env.ESPIA_REPORTE_ID_CONFIGURACION);
  const telefono = String(process.env.ESPIA_REPORTE_TELEFONO || '').replace(/\D/g, '');
  if (!idConf || !telefono) {
    return { enviado: false, motivo: 'Faltan ESPIA_REPORTE_ID_CONFIGURACION / ESPIA_REPORTE_TELEFONO' };
  }
  const [conf] = await q(`SELECT id, token, id_telefono FROM configuraciones WHERE id = :id`, { id: idConf });
  if (!conf?.token || !conf?.id_telefono) return { enviado: false, motivo: `La configuración ${idConf} no tiene token o id_telefono` };
  const { texto } = await reporte(pais);
  const { sendWhatsappMessage } = require('./whatsapp.service');
  await sendWhatsappMessage({
    telefono,
    mensaje: texto,
    business_phone_id: conf.id_telefono,
    accessToken: conf.token,
    id_configuracion: idConf,
    responsable: 'ImporKiller',
  });
  return { enviado: true, pais, telefono: `…${telefono.slice(-4)}` };
}

/* ───────────────────────── Latido del radar ─────────────────────────
 * La extensión que barre la Biblioteca de Meta (el Chrome de la Mac mini del
 * radar) avisa aquí su estado: cuando cambia (corriendo → pausado…) y, si no
 * cambia, cada 10 min. Con eso la portada de ImporKiller (solo super admin)
 * dice si el radar está en pausa porque Meta pidió una verificación (hay que
 * ir a la Mac, resolverla y pulsar Reanudar) o si dejó de dar señales (Mac
 * apagada, Chrome cerrado, pestaña perdida). `cambio` = 1 marca los cambios de
 * estado reales, para contar cuántas veces pidió verificación sin contar los
 * latidos repetidos. La tabla se crea sola (misma BD en dev y prod).
 */
const LATIDO_ESTADOS = ['corriendo', 'esperando', 'descanso', 'pausado', 'detenido'];
const LATIDO_SIN_SENAL_MIN = 25; // la extensión late cada 10 min; 25 sin nada = algo se cayó
let tablaLatidoLista = false;
async function asegurarTablaLatido() {
  if (tablaLatidoLista) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS espia_radar_latido (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      estado ENUM('corriendo','esperando','descanso','pausado','detenido') NOT NULL,
      cambio TINYINT(1) NOT NULL DEFAULT 1,
      motivo VARCHAR(255) NULL,
      pais CHAR(3) NULL,
      hecho INT NULL,
      total INT NULL,
      anuncios INT NULL,
      auto TINYINT(1) NOT NULL DEFAULT 0,
      version VARCHAR(12) NULL,
      equipo VARCHAR(120) NULL,
      id_sub_usuario INT NULL,
      INDEX idx_creado (creado_en),
      INDEX idx_estado_cambio (estado, cambio, creado_en)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  tablaLatidoLista = true;
}

async function radarLatido(body = {}, user) {
  const estado = LATIDO_ESTADOS.includes(body.estado) ? body.estado : null;
  if (!estado) throw new AppError(`estado inválido: ${body.estado}`, 400);
  await asegurarTablaLatido();
  const pais = String(body.pais || '').toUpperCase().slice(0, 3) || null;
  await q(
    `INSERT INTO espia_radar_latido (estado, cambio, motivo, pais, hecho, total, anuncios, auto, version, equipo, id_sub_usuario)
     VALUES (:estado, :cambio, :motivo, :pais, :hecho, :total, :anuncios, :auto, :version, :equipo, :sub)`,
    {
      estado,
      cambio: body.cambio ? 1 : 0,
      motivo: body.motivo ? String(body.motivo).slice(0, 255) : null,
      pais,
      hecho: Number.isFinite(Number(body.hecho)) ? Number(body.hecho) : null,
      total: Number.isFinite(Number(body.total)) ? Number(body.total) : null,
      anuncios: Number.isFinite(Number(body.anuncios)) ? Number(body.anuncios) : null,
      auto: body.auto ? 1 : 0,
      version: body.version ? String(body.version).slice(0, 12) : null,
      equipo: body.equipo ? String(body.equipo).slice(0, 120) : null,
      sub: user?.id_sub_usuario || null,
    },
    QueryTypes.INSERT,
  );
  // Se guardan 90 días: alcanza para ver qué tan seguido Meta pide verificación.
  if (Math.random() < 0.02) {
    await q(`DELETE FROM espia_radar_latido WHERE creado_en < DATE_SUB(NOW(), INTERVAL 90 DAY)`, {}, QueryTypes.DELETE).catch(() => {});
  }
  return { ok: true };
}

/* Lo que la portada muestra al super admin: último latido, alerta (si hay) y
 * cuántas veces pidió verificación en 30 días. */
async function radarEquipo() {
  let ultimo = null;
  let pausas = 0;
  let ultimaPausa = null;
  try {
    [ultimo] = await q(`SELECT * FROM espia_radar_latido ORDER BY id DESC LIMIT 1`);
    const [p] = await q(
      `SELECT COUNT(*) AS n, MAX(creado_en) AS ultima FROM espia_radar_latido
        WHERE estado = 'pausado' AND cambio = 1 AND creado_en > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    );
    pausas = Number(p?.n || 0);
    ultimaPausa = p?.ultima || null;
  } catch (err) {
    if (!sinTabla(err)) throw err;
  }
  if (!ultimo) return { ultimo: null, alerta: null, pausas_30d: 0, ultima_pausa: null };
  const minutos = (Date.now() - new Date(ultimo.creado_en).getTime()) / 60000;
  let alerta = null;
  if (ultimo.estado === 'pausado') {
    alerta = { tipo: 'pausado', texto: ultimo.motivo || 'El radar está en pausa y no sigue solo.' };
  } else if (ultimo.estado !== 'detenido' && minutos > LATIDO_SIN_SENAL_MIN) {
    alerta = { tipo: 'sin_senal', texto: `El radar no da señales desde hace ${Math.round(minutos)} min (lo último fue «${ultimo.estado}»${ultimo.pais ? ` en ${ultimo.pais}` : ''}). Revisa que el equipo esté encendido, con Chrome y la pestaña de la Biblioteca abiertas.` };
  }
  return { ultimo, alerta, pausas_30d: pausas, ultima_pausa: ultimaPausa };
}

/**
 * Vuelve a contar las ventas de un país desde las fotos de stock guardadas
 * (espia_stock_foto), con la regla de calc.ventasCreibles. Sirve para limpiar lo
 * que se sumó antes de que existiera la regla (ajustes de inventario contados
 * como ventas) y se puede repetir: siempre parte de las fotos, no de lo ya contado.
 *
 * Reproduce lo que hace procesarPagina foto por foto: mismas claves, misma fecha
 * de carga (la local de la foto anterior del producto) y el mismo historial de
 * referencia. Con la regla apagada da exactamente lo que hay hoy en la tabla.
 *
 * opts.aplicar = false → solo devuelve el resumen (no escribe nada).
 * opts.aplicar = true  → guarda una copia de lo actual en espia_ventas_dia_respaldo
 *   (solo la primera vez por país, para conservar el original), reemplaza
 *   espia_ventas_dia desde la primera foto, corrige ventas_total y recalcula métricas.
 */
async function recontarVentas(paisCrudo, opts = {}) {
  const pais = validarPais(paisCrudo);
  const log = opts.log || (() => {});
  const fotos = await q(
    `SELECT dropi_product_id AS p, warehouse_id AS w, variacion_id AS v, UNIX_TIMESTAMP(fecha_hora) AS t, stock AS s
       FROM espia_stock_foto WHERE pais = :pais
      ORDER BY dropi_product_id, fecha_hora, warehouse_id, variacion_id`,
    { pais },
  );
  if (!fotos.length) return { pais, fotos: 0, aplicado: false, antes: 0, despues: 0, ajuste: 0, dias: [], top: [] };

  const filas = []; // { p, fecha, unidades, reab }
  const totales = new Map(); // producto → unidades creíbles del período
  let ajuste = 0;
  let primera = null;
  let i = 0;
  while (i < fotos.length) {
    const p = Number(fotos[i].p);
    const stock = new Map(); // 'w:v' → stock
    const dias = new Map(); // fecha → { unidades, reab }
    let tAnterior = null;
    while (i < fotos.length && Number(fotos[i].p) === p) {
      const t = Number(fotos[i].t);
      const bajadas = [];
      let subida = 0;
      let reab = 0;
      while (i < fotos.length && Number(fotos[i].p) === p && Number(fotos[i].t) === t) {
        const k = `${fotos[i].w}:${fotos[i].v}`;
        const s = Number(fotos[i].s);
        if (stock.has(k)) {
          const prev = stock.get(k);
          if (s < prev) bajadas.push({ d: prev - s, prev });
          else if (s > prev) { subida += s - prev; reab += 1; }
        }
        stock.set(k, s);
        i += 1;
      }
      if (tAnterior !== null && (bajadas.length || reab)) {
        const fecha = calc.fechaDeCarga(new Date(tAnterior * 1000), pais);
        if (!primera || fecha < primera) primera = fecha;
        const hist = new Map([...dias.entries()].map(([f, d]) => [f, d.unidades]));
        const r = calc.ventasCreibles(bajadas, subida, mayorDiaAntes(hist, fecha, pais));
        ajuste += r.ajuste;
        if (r.ventas > 0 || reab > 0) {
          const d = dias.get(fecha) || { unidades: 0, reab: 0 };
          d.unidades += r.ventas;
          if (reab) d.reab = 1;
          dias.set(fecha, d);
        }
      }
      tAnterior = t;
    }
    let total = 0;
    for (const [fecha, d] of dias) {
      filas.push({ p, fecha, unidades: d.unidades, reab: d.reab });
      total += d.unidades;
    }
    if (total > 0) totales.set(p, total);
  }

  const desde = primera || calc.fechaLocal(new Date(), pais);
  const antesPorDia = await q(
    `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, SUM(unidades) AS u FROM espia_ventas_dia
      WHERE pais = :pais AND fecha >= :desde GROUP BY fecha ORDER BY fecha`,
    { pais, desde },
  );
  const despuesPorDia = new Map();
  for (const f of filas) despuesPorDia.set(f.fecha, (despuesPorDia.get(f.fecha) || 0) + f.unidades);
  const fechas = [...new Set([...antesPorDia.map((x) => x.fecha), ...despuesPorDia.keys()])].sort();
  const antesMap = new Map(antesPorDia.map((x) => [x.fecha, Number(x.u)]));
  const dias = fechas.map((f) => ({ fecha: f, antes: antesMap.get(f) || 0, despues: despuesPorDia.get(f) || 0 }));
  const topIds = [...totales.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const nombres = topIds.length
    ? await q(`SELECT dropi_product_id AS p, nombre, ventas_total FROM espia_producto WHERE pais = :pais AND dropi_product_id IN (:ids)`, { pais, ids: topIds.map((x) => x[0]) })
    : [];
  const porId = new Map(nombres.map((n) => [Number(n.p), n]));
  const resumen = {
    pais,
    fotos: fotos.length,
    desde,
    antes: dias.reduce((a, d) => a + d.antes, 0),
    despues: dias.reduce((a, d) => a + d.despues, 0),
    ajuste,
    mayor_dia: filas.reduce((m, f) => Math.max(m, f.unidades), 0),
    dias,
    top: topIds.map(([p, u]) => ({ dropi_product_id: p, nombre: porId.get(p)?.nombre || '', antes: Number(porId.get(p)?.ventas_total || 0), despues: u })),
    aplicado: false,
  };
  if (!opts.aplicar) return resumen;

  // Copia de lo actual, una sola vez por país (repetir el recuento no pisa el original).
  await db.query(`CREATE TABLE IF NOT EXISTS espia_ventas_dia_respaldo LIKE espia_ventas_dia`);
  const [ya] = await q(`SELECT COUNT(*) AS n FROM espia_ventas_dia_respaldo WHERE pais = :pais`, { pais });
  if (!Number(ya?.n)) {
    await q(`INSERT INTO espia_ventas_dia_respaldo SELECT * FROM espia_ventas_dia WHERE pais = :pais`, { pais }, QueryTypes.INSERT);
    log(`respaldo de ${pais} guardado en espia_ventas_dia_respaldo`);
  }
  const t = await db.transaction();
  try {
    await q(`DELETE FROM espia_ventas_dia WHERE pais = :pais AND fecha >= :desde`, { pais, desde }, QueryTypes.DELETE, t);
    for (let k = 0; k < filas.length; k += 1000) {
      const lote = filas.slice(k, k + 1000);
      await db.query(
        `INSERT INTO espia_ventas_dia (pais, dropi_product_id, fecha, unidades, reabastecido)
         VALUES ${lote.map(() => '(?,?,?,?,?)').join(',')}`,
        { replacements: lote.flatMap((f) => [pais, f.p, f.fecha, f.unidades, f.reab]), type: QueryTypes.INSERT, transaction: t },
      );
    }
    // ventas_total = todo lo que queda en la tabla (lo recontado más lo anterior a la primera foto, si lo hay).
    await q(
      `UPDATE espia_producto p
         LEFT JOIN (SELECT dropi_product_id, SUM(unidades) AS u FROM espia_ventas_dia WHERE pais = :pais GROUP BY dropi_product_id) v
                ON v.dropi_product_id = p.dropi_product_id
          SET p.ventas_total = COALESCE(v.u, 0)
        WHERE p.pais = :pais`,
      { pais },
      QueryTypes.BULKUPDATE,
      t,
    );
    await t.commit();
  } catch (e) {
    await t.rollback();
    throw e;
  }
  await recalcularMetricas(pais, log);
  resumen.aplicado = true;
  return resumen;
}

module.exports = {
  recontarVentas,
  PAISES,
  PAISES_REALES,
  NOMBRE_PAIS,
  DOMINIO_DROPI,
  CUENTA_POR_PAIS,
  cuentaDe,
  listarCuentas,
  guardarCuenta,
  actualizarCuenta,
  eliminarCuenta,
  probarCuenta,
  pasada,
  listarProductos,
  metricasLote,
  recalcularMetricas,
  detalleProducto,
  categorias,
  recibirAnuncios,
  radarCola,
  radarMarcar,
  radarLatido,
  radarEquipo,
  terminoBusqueda,
  esBuscable,
  limpiarVinculosNoBuscables,
  registrarVistaTienda,
  perfilarTienda,
  perfilarPendientes,
  marcarInactivos,
  listarAnuncios,
  creativoDe,
  listarTiendas,
  detalleTienda,
  seguir,
  estado,
  reporte,
  enviarReporteWhatsapp,
  _interno: { fichaDe, nombreProveedorDe, camposProveedor, paginasDropi, paginasMock, limpiarDominio, dominioDe },
};
