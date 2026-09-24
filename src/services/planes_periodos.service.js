const { db } = require('../database/config');

/**
 * Periodos de pago adelantado (semestral / anual) de los planes.
 *
 * El plan (id_plan) NO cambia con el periodo: límites, herramientas y MRR
 * siguen colgando de planes_chat_center. Aquí solo se resuelve qué price de
 * Stripe cobrar y cuántos meses cubre. Tabla: planes_periodos_chat_center
 * (planes_periodos_migration.sql).
 *
 * Todo es tolerante a que la migración no haya corrido: dev y prod comparten
 * base y develop se despliega solo, así que sin la tabla simplemente no hay
 * periodos y todo sigue mensual.
 */

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const PERIODOS_VALIDOS = new Set(['mensual', 'semestral', 'anual']);
const MESES_POR_PERIODO = { mensual: 1, semestral: 6, anual: 12 };

const esTablaFaltante = (e) =>
  (e?.original?.code || e?.parent?.code || e?.code) === 'ER_NO_SUCH_TABLE';

let _cache = { at: 0, filas: null };
const CACHE_MS = 60 * 1000;

async function filasActivas() {
  const now = Date.now();
  if (_cache.filas && now - _cache.at < CACHE_MS) return _cache.filas;
  try {
    const filas = await db.query(
      `SELECT id_plan, periodo, meses, precio, id_price_prod, id_price_test
         FROM planes_periodos_chat_center
        WHERE activo = 1`,
      { type: db.QueryTypes.SELECT },
    );
    _cache = { at: now, filas };
    return filas;
  } catch (e) {
    if (esTablaFaltante(e)) {
      _cache = { at: now, filas: [] };
      return [];
    }
    throw e;
  }
}

const idPriceDe = (fila) =>
  isProd ? fila.id_price_prod : fila.id_price_test || fila.id_price_prod;

const normalizarPeriodo = (p) => {
  const v = String(p || 'mensual')
    .toLowerCase()
    .trim();
  return PERIODOS_VALIDOS.has(v) ? v : null;
};

/**
 * Periodos disponibles por plan, listos para el catálogo público.
 * @param {number} precioMensual  para calcular el ahorro
 * @returns {Promise<Array<{periodo, meses, precio, precio_mes_equivalente, ahorro}>>}
 */
async function periodosDePlan(id_plan, precioMensual) {
  const filas = (await filasActivas()).filter(
    (f) => Number(f.id_plan) === Number(id_plan) && idPriceDe(f),
  );
  return filas
    .map((f) => {
      const precio = Number(f.precio);
      const meses = Number(f.meses);
      const total = Number(precioMensual || 0) * meses;
      return {
        periodo: f.periodo,
        meses,
        precio,
        precio_mes_equivalente: Number((precio / meses).toFixed(2)),
        ahorro: Number(Math.max(0, total - precio).toFixed(2)),
      };
    })
    .sort((a, b) => a.meses - b.meses);
}

/**
 * Price de Stripe (del entorno) para un plan y periodo. `mensual` devuelve
 * null a propósito: ese price vive en planes_chat_center.id_price.
 */
async function resolverPrecioPeriodo(id_plan, periodo) {
  const p = normalizarPeriodo(periodo);
  if (!p || p === 'mensual') return null;
  const fila = (await filasActivas()).find(
    (f) => Number(f.id_plan) === Number(id_plan) && f.periodo === p,
  );
  if (!fila) return null;
  const id_price = idPriceDe(fila);
  if (!id_price) return null;
  return {
    id_plan: Number(fila.id_plan),
    periodo: p,
    meses: Number(fila.meses),
    precio: Number(fila.precio),
    id_price,
  };
}

/**
 * Inverso: dado un price de Stripe, ¿de qué plan y periodo es? Solo conoce
 * los periodos adelantados; para el mensual el caller consulta planes.
 */
async function planPorPricePeriodico(priceId) {
  if (!priceId) return null;
  // Primero por id_price_prod: en producción es único por plan, y en dev los
  // planes TEST (16/17/18/23) guardan ahí su price de test, que puede ser el
  // mismo que el id_price_test del plan real (17 y 3 comparten producto TEST).
  // Sin esta preferencia, un pago del plan TEST se atribuía al plan real.
  const filas = await filasActivas();
  const fila =
    filas.find((f) => f.id_price_prod === priceId) ||
    filas.find((f) => f.id_price_test === priceId);
  if (!fila) return null;
  return {
    id_plan: Number(fila.id_plan),
    periodo: fila.periodo,
    meses: Number(fila.meses),
    precio: Number(fila.precio),
  };
}

/**
 * periodo_pago del usuario, tolerante a que la columna no exista.
 */
async function periodoPagoDeUsuario(id_usuario) {
  try {
    const [[u]] = await db.query(
      `SELECT periodo_pago FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
      { replacements: [id_usuario] },
    );
    return normalizarPeriodo(u?.periodo_pago) || 'mensual';
  } catch (e) {
    return 'mensual';
  }
}

/**
 * Escribe periodo_pago. Nunca lanza: si la columna no existe, se registra y
 * sigue (el webhook no puede caerse por esto).
 */
async function guardarPeriodoPago(id_usuario, periodo) {
  const p = normalizarPeriodo(periodo);
  if (!id_usuario || !p) return false;
  try {
    await db.query(
      `UPDATE usuarios_chat_center SET periodo_pago = ? WHERE id_usuario = ?`,
      { replacements: [p, id_usuario] },
    );
    return true;
  } catch (e) {
    console.log('[periodos] no se pudo guardar periodo_pago:', e?.message);
    return false;
  }
}

module.exports = {
  PERIODOS_VALIDOS,
  MESES_POR_PERIODO,
  normalizarPeriodo,
  periodosDePlan,
  resolverPrecioPeriodo,
  planPorPricePeriodico,
  periodoPagoDeUsuario,
  guardarPeriodoPago,
};
