'use strict';

/**
 * espia_mercado.service.js — Espía de mercado (Dropkiller propio, 30-oct-2026).
 *
 * Tres piezas:
 *  1. Recolector: recorre el catálogo público de Dropi de un país con la llave
 *     de una integración NUESTRA (Global Outlet: EC 473, MX 891), toma la foto
 *     del stock por (producto, bodega, variación) y suma ventas por baja de
 *     stock (utils/espiaMercadoCalc). Corre en el servidor: la IP está en la
 *     lista blanca de Dropi, en local da 401. Para probar en local se usan
 *     respuestas guardadas (ESPIA_MOCK_DIR o `fuente: 'mock'`).
 *  2. Anuncios y tiendas: lo que la extensión de Chrome «Espía de tiendas» ve
 *     en la Biblioteca de anuncios de Meta llega por POST /espia/anuncios; de
 *     cada dominio nuevo se consulta /products.json (Shopify) en segundo plano.
 *  3. Consultas de la pantalla /espia-mercado y el reporte diario.
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
const { decryptToken } = require('../utils/cryptoToken');
const dropiService = require('./dropi.service');
const calc = require('../utils/espiaMercadoCalc');
const {
  EspiaPasada,
  EspiaTienda,
  EspiaSeguimiento,
} = require('../models/espia_mercado.model');

const TAM_PAGINA = 40; // lo que de verdad devuelve Dropi (pageSize > 100 → vacío)
const PAUSA_PAGINA_MS = Number(process.env.ESPIA_PAUSA_PAGINA_MS) || 3000;
const FRENO_MS = Number(process.env.ESPIA_FRENO_MS) || 60 * 60 * 1000;
const PURGA_DIAS = 120;
const DIAS_PARA_INACTIVO = 60; // como Dropkiller: un anuncio no visto en 60 días deja de estar activo
// QA = país de pruebas: solo para pasadas con respuestas guardadas (mock); se
// limpia con `node scripts/espiaMercado.js limpiar --pais QA --si`.
const PAISES = ['EC', 'MX', 'QA'];

// Cuenta propia por país (configuraciones.id). Son cuentas NUESTRAS (Global
// Outlet, la de pruebas en EC), nunca la de un cliente: si Dropi frena la
// cuenta, no tumba a nadie. Se usa la integración Dropi activa de esa
// configuración en ese país; no hace falta ninguna variable de entorno
// (DROPI_ESPIA_CONFIGURACION_EC/_MX solo si algún día se quiere cambiar).
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
  if (!PAISES.includes(p)) throw new AppError(`País no soportado: ${p}. Usa EC o MX.`, 400);
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

/** Cuenta Dropi que usa el recolector para un país (sin la llave). */
async function cuentaDe(pais) {
  const idc = CUENTA_POR_PAIS[pais];
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
    throw new AppError(`La configuración ${idc} no tiene una integración Dropi activa de ${pais}`, 500);
  }
  return row;
}

async function obtenerLlave(pais) {
  const row = await cuentaDe(pais);
  const key = decryptToken(row.integration_key_enc);
  if (!key) throw new AppError(`La llave de la integración #${row.id} no se pudo descifrar`, 500);
  return { key, store_name: row.store_name, id: row.id };
}

/** Páginas del catálogo real. Lanza FrenoError ante un 429. */
async function* paginasDropi(pais, { maxPaginas = 0 } = {}) {
  const { key } = await obtenerLlave(pais);
  let startData = 0;
  let n = 0;
  for (;;) {
    if (maxPaginas && n >= maxPaginas) return;
    let data;
    try {
      data = await dropiService.listProductsIndex({
        integrationKey: key,
        country_code: pais,
        payload: {
          pageSize: TAM_PAGINA,
          startData,
          no_count: true,
          order_by: 'id',
          order_type: 'asc',
          keywords: '',
        },
      });
    } catch (err) {
      if (err?.code === 'DROPI_RATE_LIMIT' || err?.statusCode === 429) {
        throw new FrenoError(err.message);
      }
      throw err;
    }
    const objetos = Array.isArray(data?.objects) ? data.objects : [];
    if (!objetos.length) return;
    n += 1;
    yield objetos;
    startData += TAM_PAGINA;
    await dormir(PAUSA_PAGINA_MS);
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

function fichaDe(p) {
  return {
    dropi_product_id: Number(p.id),
    nombre: String(p.name || '').slice(0, 300),
    nombre_norm: calc.normalizarNombre(p.name),
    tipo: String(p.type || '').slice(0, 12) || null,
    sku: p.sku ? String(p.sku).slice(0, 120) : null,
    proveedor_id: p.user?.id != null ? Number(p.user.id) : null,
    proveedor_nombre: p.user?.name ? String(p.user.name).slice(0, 200) : null,
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

async function procesarPagina(pais, productos, instante, stats) {
  const ids = productos.map((p) => Number(p.id)).filter(Number.isFinite);
  const previas = await previasDe(pais, ids);
  const t = await db.transaction();
  try {
    for (const p of productos) {
      const pid = Number(p.id);
      if (!Number.isFinite(pid)) continue;
      const ficha = fichaDe(p);
      const prevMap = previas.get(pid) || new Map();
      const prevStocks = new Map([...prevMap.entries()].map(([k, v]) => [k, v.stock]));
      const nuevas = calc.clavesDeProducto(p);
      const r = calc.resumirProducto(prevStocks, nuevas);

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

      // Ventas del día: a la fecha local de la foto anterior más reciente.
      if (r.ventas > 0 || r.reabastecimientos > 0) {
        let fotoAnterior = null;
        for (const v of prevMap.values()) {
          if (!fotoAnterior || new Date(v.fecha_hora) > new Date(fotoAnterior)) fotoAnterior = v.fecha_hora;
        }
        const fecha = calc.fechaDeCarga(fotoAnterior || instante, pais);
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
  const registro = await EspiaPasada.create({ pais, fuente, inicio, estado: 'corriendo' });
  const stats = { paginas: 0, productos: 0, fotos_escritas: 0, ventas_sumadas: 0, errores_429: 0 };
  log(`▶ pasada ${pais} (${fuente}) #${registro.id}`);

  try {
    const paginas =
      fuente === 'mock'
        ? paginasMock(mockDir, pais, { maxPaginas: opts.maxPaginas })
        : paginasDropi(pais, { maxPaginas: opts.maxPaginas });

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
    await registro.update({ ...stats, fin: ahoraSql(), estado: 'ok' });
    log(`✔ pasada ${pais} #${registro.id}: ${stats.paginas} págs · ${stats.productos} productos · ${stats.fotos_escritas} fotos · ${stats.ventas_sumadas} ventas`);
    return { id: registro.id, ...stats, estado: 'ok' };
  } catch (err) {
    if (err instanceof FrenoError) {
      frenoHasta[pais] = Date.now() + FRENO_MS;
      stats.errores_429 += 1;
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

/** Subconsulta con ventas 1/7/30 y 7 previos por producto. */
function subVentas(pais) {
  const f = fechasDe(pais);
  return {
    sql: `(SELECT dropi_product_id,
                  SUM(CASE WHEN fecha >= :f_d1 THEN unidades ELSE 0 END) AS v1,
                  SUM(CASE WHEN fecha >= :f_d7 THEN unidades ELSE 0 END) AS v7,
                  SUM(CASE WHEN fecha >= :f_d14 AND fecha < :f_d7 THEN unidades ELSE 0 END) AS v7prev,
                  SUM(CASE WHEN fecha >= :f_d30 THEN unidades ELSE 0 END) AS v30
             FROM espia_ventas_dia
            WHERE pais = :pais AND fecha >= :f_d30
            GROUP BY dropi_product_id)`,
    repl: { pais, f_d1: f.d1, f_d7: f.d7, f_d14: f.d14, f_d30: f.d30 },
  };
}

const CAMPOS_PRODUCTO = `
  p.pais, p.dropi_product_id, p.nombre, p.tipo, p.sku, p.proveedor_id, p.proveedor_nombre,
  p.precio, p.sugerido, p.categoria, p.imagen_url, p.external_id, p.privado,
  p.primera_vez, p.ultima_vez, p.stock_actual, p.ventas_total, p.reabastecimientos,
  COALESCE(v.v1,0) AS ventas_1d, COALESCE(v.v7,0) AS ventas_7d, COALESCE(v.v7prev,0) AS ventas_7d_prev,
  COALESCE(v.v30,0) AS ventas_30d,
  (SELECT COUNT(*) FROM espia_producto i
     WHERE i.pais = p.pais AND i.nombre_norm = p.nombre_norm AND i.nombre_norm <> '' AND i.proveedor_id <> p.proveedor_id) AS n_iguales`;

const ORDENES = {
  v7: 'ventas_7d DESC, ventas_30d DESC',
  v30: 'ventas_30d DESC, ventas_7d DESC',
  total: 'p.ventas_total DESC',
  subida: '(COALESCE(v.v7,0) - COALESCE(v.v7prev,0)) DESC, ventas_7d DESC',
  stock: 'p.stock_actual DESC',
  nuevos: 'p.primera_vez DESC',
  precio: 'p.precio ASC',
};

async function listarProductos(params = {}) {
  const pais = validarPais(params.pais);
  const atajo = String(params.atajo || 'sin_escalar');
  const base = calc.ATAJOS[atajo] || {};
  const f = { ...base };
  for (const k of ['min_v7', 'max_v7', 'min_v30', 'max_v30', 'min_stock', 'max_stock', 'creado_dias', 'max_reab', 'min_total', 'max_total']) {
    if (params[k] !== undefined && params[k] !== '' && params[k] !== null) f[k] = Number(params[k]);
  }
  const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
  const page = Math.max(1, Number(params.page) || 1);
  const orden = ORDENES[params.orden] || ORDENES[f.orden] || ORDENES.v7;
  const sv = subVentas(pais);
  const repl = { ...sv.repl, limit, offset: (page - 1) * limit };
  const where = ['p.pais = :pais'];
  const having = [];
  if (params.q && String(params.q).trim().length >= 2) {
    where.push('(p.nombre LIKE :q OR p.proveedor_nombre LIKE :q OR p.sku LIKE :q)');
    repl.q = `%${String(params.q).trim()}%`;
  }
  if (params.categoria) {
    where.push('p.categoria = :categoria');
    repl.categoria = String(params.categoria);
  }
  if (params.proveedor_id) {
    where.push('p.proveedor_id = :proveedor_id');
    repl.proveedor_id = Number(params.proveedor_id);
  }
  if (f.min_stock != null) { where.push('p.stock_actual >= :min_stock'); repl.min_stock = f.min_stock; }
  if (f.max_stock != null) { where.push('p.stock_actual <= :max_stock'); repl.max_stock = f.max_stock; }
  if (f.max_reab != null) { where.push('p.reabastecimientos <= :max_reab'); repl.max_reab = f.max_reab; }
  if (f.min_total != null) { where.push('p.ventas_total >= :min_total'); repl.min_total = f.min_total; }
  if (f.max_total != null) { where.push('p.ventas_total <= :max_total'); repl.max_total = f.max_total; }
  if (f.creado_dias != null) {
    where.push('p.primera_vez >= DATE_SUB(NOW(), INTERVAL :creado_dias DAY)');
    repl.creado_dias = f.creado_dias;
  }
  if (f.min_v7 != null) { having.push('ventas_7d >= :min_v7'); repl.min_v7 = f.min_v7; }
  if (f.max_v7 != null) { having.push('ventas_7d <= :max_v7'); repl.max_v7 = f.max_v7; }
  if (f.min_v30 != null) { having.push('ventas_30d >= :min_v30'); repl.min_v30 = f.min_v30; }
  if (f.max_v30 != null) { having.push('ventas_30d <= :max_v30'); repl.max_v30 = f.max_v30; }

  const cuerpo = `FROM espia_producto p LEFT JOIN ${sv.sql} v ON v.dropi_product_id = p.dropi_product_id
                  WHERE ${where.join(' AND ')}`;
  const havingSql = having.length ? `HAVING ${having.join(' AND ')}` : '';

  const items = await q(
    `SELECT ${CAMPOS_PRODUCTO} ${cuerpo} ${havingSql} ORDER BY ${orden} LIMIT :limit OFFSET :offset`,
    repl,
  );
  const [cnt] = await q(
    `SELECT COUNT(*) AS total FROM (
       SELECT p.dropi_product_id, COALESCE(v.v7,0) AS ventas_7d, COALESCE(v.v30,0) AS ventas_30d
       ${cuerpo} ${havingSql}) x`,
    repl,
  );
  return { total: Number(cnt?.total || 0), page, limit, atajo, filtros: f, items };
}

async function detalleProducto(paisCrudo, idCrudo) {
  const pais = validarPais(paisCrudo);
  const id = Number(idCrudo);
  if (!Number.isFinite(id)) throw new AppError('Producto inválido', 400);
  const sv = subVentas(pais);
  const [producto] = await q(
    `SELECT ${CAMPOS_PRODUCTO} FROM espia_producto p LEFT JOIN ${sv.sql} v ON v.dropi_product_id = p.dropi_product_id
      WHERE p.pais = :pais AND p.dropi_product_id = :id`,
    { ...sv.repl, id },
  );
  if (!producto) throw new AppError('Ese producto todavía no está en el espía', 404);
  const f = fechasDe(pais);
  const historial = await q(
    `SELECT fecha, unidades, reabastecido FROM espia_ventas_dia
      WHERE pais = :pais AND dropi_product_id = :id AND fecha >= :d30 ORDER BY fecha`,
    { pais, id, d30: f.d30 },
  );
  const [fila] = await q(`SELECT nombre_norm, external_id, proveedor_id FROM espia_producto WHERE pais = :pais AND dropi_product_id = :id`, { pais, id });
  const iguales = fila?.nombre_norm
    ? await q(
        `SELECT p.dropi_product_id, p.nombre, p.proveedor_id, p.proveedor_nombre, p.precio, p.sugerido, p.imagen_url,
                p.stock_actual, p.ventas_total, COALESCE(v.v30,0) AS ventas_30d, COALESCE(v.v7,0) AS ventas_7d
           FROM espia_producto p LEFT JOIN ${sv.sql} v ON v.dropi_product_id = p.dropi_product_id
          WHERE p.pais = :pais AND p.dropi_product_id <> :id
            AND (p.nombre_norm = :norm OR (:ext IS NOT NULL AND p.external_id = :ext))
            AND (p.proveedor_id IS NULL OR p.proveedor_id <> :prov)
          ORDER BY ventas_30d DESC LIMIT 30`,
        { ...sv.repl, id, norm: fila.nombre_norm, ext: fila.external_id || null, prov: fila.proveedor_id ?? -1 },
      )
    : [];
  const suma_iguales = {
    proveedores: iguales.length + 1,
    ventas_30d: Number(producto.ventas_30d) + iguales.reduce((n, i) => n + Number(i.ventas_30d), 0),
    ventas_total: Number(producto.ventas_total) + iguales.reduce((n, i) => n + Number(i.ventas_total), 0),
  };
  const palabras = String(fila?.nombre_norm || '').split(' ').filter((w) => w.length >= 4).slice(0, 2);
  const anuncios = palabras.length
    ? await q(
        `SELECT ad_archive_id, pagina_nombre, dominio, tipo, media_url, imagen_url, inicio,
                DATEDIFF(CURDATE(), inicio) AS dias_activo
           FROM espia_anuncio
          WHERE activo = 1 AND (pais = :pais OR pais = 'ALL')
            AND ${palabras.map((_, i) => `(producto LIKE :w${i} OR titulo LIKE :w${i} OR texto LIKE :w${i})`).join(' AND ')}
          ORDER BY ultima_vez_visto DESC LIMIT 12`,
        Object.fromEntries([['pais', pais], ...palabras.map((w, i) => [`w${i}`, `%${w}%`])]),
      )
    : [];
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
  return rows.map((r) => r.categoria);
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
    'tipo', 'media_url', 'imagen_url', 'plataformas', 'inicio', 'primera_vez_visto', 'ultima_vez_visto', 'activo',
    'n_duplicados', 'veces_visto', 'visto_por',
  ];
  const filas = limpios.map((a) => [
    a.ad_archive_id, a.pais, a.pagina_id, a.pagina_nombre, a.dominio, a.url_destino, a.producto, a.titulo, a.texto,
    a.tipo, a.media_url, a.imagen_url, a.plataformas, a.inicio, ahora, ahora, 1, a.n_duplicados, 1, idSub,
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
       imagen_url = COALESCE(VALUES(imagen_url), imagen_url),
       plataformas = COALESCE(VALUES(plataformas), plataformas),
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

  return {
    recibidos: limpios.length,
    nuevos: nuevos_ids.length,
    nuevos_ids,
    conocidos_ids: ids.filter((id) => conocidos.has(id)),
    tiendas: [...porDominio.keys()],
  };
}

async function actualizarTienda(dominio, pais, nuevosHoy, hoy, ahora) {
  const [c] = await q(
    `SELECT COUNT(*) AS n, SUM(ultima_vez_visto >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS hoy
       FROM espia_anuncio WHERE dominio = :dominio AND activo = 1`,
    { dominio },
  );
  const activos = Number(c?.n || 0);
  await q(
    `INSERT INTO espia_tienda (dominio, pais_principal, anuncios_activos, primera_vez, ultima_vez)
     VALUES (:dominio, :pais, :activos, :ahora, :ahora)
     ON DUPLICATE KEY UPDATE anuncios_activos = VALUES(anuncios_activos), ultima_vez = VALUES(ultima_vez),
       pais_principal = IF(:pais = 'ALL', pais_principal, :pais)`,
    { dominio, pais: pais === 'ALL' ? null : pais, activos, ahora },
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
  a.titulo, a.texto, a.tipo, a.media_url, a.imagen_url, a.plataformas, a.inicio, a.primera_vez_visto, a.ultima_vez_visto,
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

async function listarTiendas(params = {}, sessionUser = {}) {
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 30));
  const page = Math.max(1, Number(params.page) || 1);
  const idSub = Number(sessionUser.id_sub_usuario) || 0;
  const where = ['1=1'];
  const repl = { limit, offset: (page - 1) * limit, idSub };
  const pais = String(params.pais || '').toUpperCase();
  if (pais && pais !== 'ALL') { where.push('(t.pais_principal = :pais OR t.pais_principal IS NULL)'); repl.pais = pais; }
  if (params.q && String(params.q).trim().length >= 2) { where.push('(t.dominio LIKE :q OR t.nombre LIKE :q)'); repl.q = `%${String(params.q).trim()}%`; }
  if (params.es_shopify === '1' || params.es_shopify === 1 || params.es_shopify === true) where.push('t.es_shopify = 1');
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
  const [prod] = await q(`SELECT COUNT(*) AS n, MAX(ultima_vez) AS ultima FROM espia_producto WHERE pais = :pais`, { pais });
  const [anu] = await q(
    `SELECT COUNT(*) AS n, MAX(ultima_vez_visto) AS ultima FROM espia_anuncio WHERE activo = 1 AND (pais = :pais OR pais = 'ALL')`,
    { pais },
  );
  const [tie] = await q(`SELECT COUNT(*) AS n FROM espia_tienda WHERE pais_principal = :pais OR pais_principal IS NULL`, { pais });
  const [vd] = await q(`SELECT COUNT(DISTINCT fecha) AS dias FROM espia_ventas_dia WHERE pais = :pais`, { pais });
  let cuenta;
  if (pais === 'QA') {
    cuenta = { id_configuracion: null, nombre_configuracion: 'Pruebas', store_name: 'Mock', integracion_id: null };
  } else {
    try {
      const c = await cuentaDe(pais);
      cuenta = { id_configuracion: c.id_configuracion, nombre_configuracion: c.nombre_configuracion, store_name: c.store_name, integracion_id: c.id };
    } catch (e) {
      cuenta = { id_configuracion: CUENTA_POR_PAIS[pais], error: e.message };
    }
  }
  return {
    pais,
    cuenta,
    fuente: process.env.ESPIA_MOCK_DIR ? 'mock' : 'dropi',
    ultima_pasada: ultima || null,
    corriendo: Boolean(corriendo[pais]),
    freno_hasta: frenoHasta[pais] && Date.now() < frenoHasta[pais] ? new Date(frenoHasta[pais]) : null,
    productos_total: Number(prod?.n || 0),
    productos_ultima_vez: prod?.ultima || null,
    dias_con_ventas: Number(vd?.dias || 0),
    cron_activo: String(process.env.CRONS_ENABLED ?? 'true').toLowerCase() !== 'false',
    extension: { anuncios_total: Number(anu?.n || 0), tiendas_total: Number(tie?.n || 0), ultimo_envio: anu?.ultima || null },
  };
}

const fmt = (n) => Number(n || 0).toLocaleString('es-EC');
const corto = (s, n = 38) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

async function reporte(paisCrudo) {
  const pais = validarPais(paisCrudo);
  const nombrePais = pais === 'MX' ? 'México' : pais === 'QA' ? 'Pruebas (QA)' : 'Ecuador';
  const enlace = (atajo) => `${FRONTEND_URL}/espia-mercado?pais=${pais}&tab=productos&atajo=${atajo}`;
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
  const lineas = [];
  lineas.push(`📡 *Espía de mercado · ${nombrePais}* · ${calc.fechaLocal(new Date(), pais)}`);
  if (!est.ultima_pasada) {
    lineas.push('Todavía no hay una pasada del catálogo. Cuando corra el recolector, este reporte trae los productos.');
  } else {
    lineas.push(`Catálogo: ${fmt(est.productos_total)} productos · ${est.dias_con_ventas} días medidos`);
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
  bloque('🔥 Los que más subieron (7 días vs 7 anteriores)', subieron, 'todos&orden=subida', (p) => `${fmt(p.ventas_7d)} vs ${fmt(p.ventas_7d_prev)} · stock ${fmt(p.stock_actual)}`);
  bloque('🚀 Sin escalar (7d 10–120, 30d 120–500, stock ≥ 80)', sinEscalar, 'sin_escalar', (p) => `7d ${fmt(p.ventas_7d)} · 30d ${fmt(p.ventas_30d)} · ${corto(p.proveedor_nombre, 18)}`);
  bloque('🌱 Nuevos con tracción (≤ 90 días, 100–2.000 totales)', nuevos, 'nuevos_traccion', (p) => `total ${fmt(p.ventas_total)} · 7d ${fmt(p.ventas_7d)} · reab ${p.reabastecimientos}`);
  if (seguidas.length) {
    lineas.push('');
    lineas.push('*👀 Tiendas que sigues*');
    for (const t of seguidas) {
      lineas.push(`• ${t.dominio} · ${fmt(t.anuncios_activos)} activos · ${fmt(t.nuevos)} nuevos`);
    }
    lineas.push(`👉 ${FRONTEND_URL}/espia-mercado?pais=${pais}&tab=tiendas&solo_seguidas=1`);
  }
  lineas.push('');
  lineas.push('_Ventas estimadas por baja de stock en Dropi; un traslado o ajuste puede verse como venta._');
  return { pais, texto: lineas.join('\n'), generado_en: new Date() };
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
    responsable: 'Espía de mercado',
  });
  return { enviado: true, pais, telefono: `…${telefono.slice(-4)}` };
}

module.exports = {
  PAISES,
  CUENTA_POR_PAIS,
  cuentaDe,
  pasada,
  listarProductos,
  detalleProducto,
  categorias,
  recibirAnuncios,
  registrarVistaTienda,
  perfilarTienda,
  perfilarPendientes,
  marcarInactivos,
  listarAnuncios,
  listarTiendas,
  detalleTienda,
  seguir,
  estado,
  reporte,
  enviarReporteWhatsapp,
  _interno: { fichaDe, paginasMock, limpiarDominio, dominioDe },
};
