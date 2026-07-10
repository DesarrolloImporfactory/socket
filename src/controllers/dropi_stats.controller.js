/**
 * dropi_stats.controller.js
 * Estadísticas derivadas de dropi_orders_cache (fuente más completa; el webhook
 * solo cubre ~22%).
 *
 *  - semaforoTransportadoras: efectividad (entregas vs devoluciones) por
 *    transportadora SOLO en la ciudad seleccionada, en una ventana de tiempo
 *    (1/3/6 meses). GLOBAL por ciudad (todas las tiendas). Ayuda al cliente a
 *    elegir transportadora antes de crear la orden. (Se descartó agregar por
 *    provincia: el valor salía demasiado general y no servía para decidir.)
 *  - rankingTiendas: top tiendas por VENTA entregada (no utilidad). SOLO tiendas
 *    que usan el sistema (tienen configuración), mostrando el nombre de la
 *    configuración. Para inspirar a los vendedores.
 *  - transportadorasHistorico: vista analítica de transportadoras por CIUDAD
 *    con costo de flete promedio y rango de fechas. TODAS las órdenes
 *    (no requiere que la tienda tenga configuración en el sistema).
 */
const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { resolveRegion } = require('../utils/phoneFactor');

// Moneda por país (para mostrar el monto correcto en el ranking).
const MONEDA_POR_ISO = {
  EC: 'USD',
  PA: 'USD',
  MX: 'MXN',
  CO: 'COP',
  PE: 'PEN',
  CL: 'CLP',
  GT: 'GTQ',
  AR: 'ARS',
};

// classified_status buckets relevantes
const EN_CURSO = [
  'en_transito',
  'en_reparto',
  'guia_generada',
  'pendiente',
  'retiro_agencia',
];
const EN_CURSO_SQL = EN_CURSO.map((s) => db.escape(s)).join(',');

// Umbrales de color del semáforo (efectividad de entrega).
const UMBRAL_VERDE = 75;
const UMBRAL_AMARILLO = 55;
const MIN_MUESTRA = 8; // mínimo entregadas+devoluciones para calificar color

// Ventana de tiempo en meses según el filtro pedido.
const MESES_POR_PERIODO = { '1mes': 1, '3meses': 3, '6meses': 6, '12meses': 12 };

// Columna generada PERSISTENT (ver migración add_dropi_cache_geo_indexes.js):
//   flete_amount  = order_data.$.shipping_amount  (numérico, 0 → NULL)
// Antes esto se hacía con JSON_EXTRACT por fila → full scans lentos.
// (La columna generada `provincia` sigue existiendo en la tabla, pero ya no se
// usa: toda la tasa de entrega se mide por CIUDAD.)
const FLETE_SQL = `AVG(flete_amount)`;

/**
 * Convierte una fila agregada (entregadas/devoluciones/…) al objeto de
 * transportadora con efectividad y color de semáforo. Reutilizado por el
 * semáforo y la vista de transportadoras.
 */
function armarTransportadora(r) {
  const entregadas = Number(r.entregadas) || 0;
  const devoluciones = Number(r.devoluciones) || 0;
  const novedades = Number(r.novedades) || 0;
  const finalizadas = entregadas + devoluciones;
  const efectividad =
    finalizadas > 0 ? Math.round((entregadas / finalizadas) * 100) : null;
  const suficiente = finalizadas >= MIN_MUESTRA;
  let semaforo = 'gris';
  if (suficiente && efectividad != null) {
    semaforo =
      efectividad >= UMBRAL_VERDE
        ? 'verde'
        : efectividad >= UMBRAL_AMARILLO
        ? 'amarillo'
        : 'rojo';
  }
  return {
    transportadora: r.transportadora,
    entregadas,
    devoluciones,
    novedades,
    en_curso: Number(r.en_curso) || 0,
    total: Number(r.total) || 0,
    flete_promedio: r.flete_promedio != null ? Number(r.flete_promedio) : null,
    finalizadas,
    efectividad,
    suficiente,
    semaforo,
  };
}

function ordenarTransportadoras(a, b) {
  if (a.suficiente !== b.suficiente) return a.suficiente ? -1 : 1;
  if ((b.efectividad || 0) !== (a.efectividad || 0))
    return (b.efectividad || 0) - (a.efectividad || 0);
  return b.total - a.total;
}

// Resuelve el país (country_code raw) del que consulta: primero por su config
// actual (id_configuracion), luego el dominante entre sus configs; fallback EC.
// configuraciones.pais está hardcodeado "ec", NO sirve → se usa dropi_integrations.
async function resolverPaisRaw(idConfig, misConfigs) {
  if (idConfig) {
    const [r] = await db.query(
      `SELECT country_code FROM dropi_integrations
        WHERE id_configuracion = ? AND deleted_at IS NULL
        ORDER BY is_active DESC, id DESC LIMIT 1`,
      { replacements: [idConfig], type: db.QueryTypes.SELECT },
    );
    if (r?.country_code) return r.country_code;
  }
  if (misConfigs?.length) {
    const [r] = await db.query(
      `SELECT country_code, COUNT(*) n FROM dropi_integrations
        WHERE id_configuracion IN (${misConfigs.join(',')}) AND deleted_at IS NULL
        GROUP BY country_code ORDER BY n DESC LIMIT 1`,
      { type: db.QueryTypes.SELECT },
    );
    if (r?.country_code) return r.country_code;
  }
  return 'EC';
}

// Ids de configuración de un país. Se usa como `c.id_configuracion IN (...)` en
// vez de un JOIN a dropi_integrations: así las consultas siguen siendo
// index-only sobre los índices cubridores (que terminan en id_configuracion).
async function configsDePais(paisRaw) {
  const rows = await db.query(
    `SELECT DISTINCT id_configuracion FROM dropi_integrations
      WHERE deleted_at IS NULL AND country_code = ?`,
    { replacements: [paisRaw], type: db.QueryTypes.SELECT },
  );
  return rows.map((r) => Number(r.id_configuracion)).filter(Boolean);
}

// ───────────────────────────────────────────────────────────────
// SEMÁFORO DE TRANSPORTADORAS — SOLO por ciudad seleccionada
// POST /api/v1/dropi_stats/semaforo_transportadoras  { ciudad, periodo }
//   periodo: '1mes' (default) | '3meses' | '6meses'
// Sin fallback a provincia: la tasa provincial salía muy general y confundía.
// ───────────────────────────────────────────────────────────────
exports.semaforoTransportadoras = catchAsync(async (req, res, next) => {
  const ciudad = String(req.body?.ciudad || '').trim();
  if (!ciudad) return next(new AppError('Falta la ciudad', 400));

  const periodo = MESES_POR_PERIODO[req.body?.periodo] ? req.body.periodo : '1mes';
  const meses = MESES_POR_PERIODO[periodo];

  const rows = await db.query(
    `SELECT shipping_company AS transportadora,
            SUM(classified_status = 'entregada')  AS entregadas,
            SUM(classified_status = 'devolucion') AS devoluciones,
            SUM(classified_status = 'novedad')    AS novedades,
            SUM(classified_status IN (${EN_CURSO_SQL})) AS en_curso,
            COUNT(*)                              AS total,
            ${FLETE_SQL}                          AS flete_promedio
       FROM dropi_orders_cache
      WHERE shipping_company IS NOT NULL AND TRIM(shipping_company) <> ''
        AND order_created_at >= (NOW() - INTERVAL ${meses} MONTH)
        AND city = ?
      GROUP BY shipping_company`,
    { replacements: [ciudad], type: db.QueryTypes.SELECT },
  );

  const transportadoras = rows.map(armarTransportadora).sort(ordenarTransportadoras);

  return res.json({
    success: true,
    data: { nivel: 'ciudad', ciudad, periodo, meses, transportadoras },
  });
});

// ───────────────────────────────────────────────────────────────
// RANKING DE TIENDAS por venta entregada — SOLO tiendas del sistema
// POST /api/v1/dropi_stats/ranking_tiendas  { periodo, id_configuracion }
// ───────────────────────────────────────────────────────────────
exports.rankingTiendas = catchAsync(async (req, res) => {
  const idUsuario = req.sessionUser?.id_usuario || -1;
  const idConfig = Number(req.body?.id_configuracion) || null;
  const periodo = ['mes_actual', 'mes_anterior', '30dias'].includes(
    req.body?.periodo,
  )
    ? req.body.periodo
    : 'mes_actual';
  const LIMIT = 10;

  // Configs del que mira. dropi_orders_cache.id_usuario suele venir 0 (huérfano),
  // así que identificamos "sus tiendas" por id_configuracion (siempre presente).
  const misConfigs = (
    await db.query(`SELECT id FROM configuraciones WHERE id_usuario = ?`, {
      replacements: [idUsuario],
      type: db.QueryTypes.SELECT,
    })
  )
    .map((r) => Number(r.id))
    .filter(Boolean);
  const inMias = misConfigs.length
    ? `c.id_configuracion IN (${misConfigs.join(',')})`
    : '0';

  // 1. País del que mira: country_code de su integración Dropi (donde conectó y
  //    eligió el país). configuraciones.pais está hardcodeado "ec", NO sirve.
  let paisRaw = null;
  if (idConfig) {
    const [r] = await db.query(
      `SELECT country_code FROM dropi_integrations
        WHERE id_configuracion = ? AND deleted_at IS NULL
        ORDER BY is_active DESC, id DESC LIMIT 1`,
      { replacements: [idConfig], type: db.QueryTypes.SELECT },
    );
    if (r?.country_code) paisRaw = r.country_code;
  }
  if (!paisRaw && misConfigs.length) {
    const [r] = await db.query(
      `SELECT country_code, COUNT(*) n
         FROM dropi_integrations
        WHERE id_configuracion IN (${misConfigs.join(',')})
          AND deleted_at IS NULL
        GROUP BY country_code
        ORDER BY n DESC LIMIT 1`,
      { type: db.QueryTypes.SELECT },
    );
    if (r?.country_code) paisRaw = r.country_code;
  }
  paisRaw = paisRaw || 'EC';
  const paisIso = resolveRegion(paisRaw); // para etiqueta/moneda
  const moneda = MONEDA_POR_ISO[paisIso] || 'USD';

  // 2. Rango de fechas según periodo
  let fechaCond;
  if (periodo === 'mes_anterior') {
    fechaCond = `c.order_created_at >= DATE_FORMAT(NOW() - INTERVAL 1 MONTH, '%Y-%m-01')
                 AND c.order_created_at < DATE_FORMAT(NOW(), '%Y-%m-01')`;
  } else if (periodo === '30dias') {
    fechaCond = `c.order_created_at >= (NOW() - INTERVAL 30 DAY)`;
  } else {
    fechaCond = `c.order_created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`;
  }

  // JOIN a configuraciones = SOLO tiendas que existen en el sistema (evita
  // "basura" de proveedores que generan guías de cualquier tienda). País por
  // dropi_integrations. Agrupamos por configuración y mostramos su nombre.
  const joins = `
      JOIN configuraciones cfg ON cfg.id = c.id_configuracion
      JOIN usuarios_chat_center u ON u.id_usuario = cfg.id_usuario
      JOIN (
        SELECT id_configuracion, MAX(country_code) cc
          FROM dropi_integrations WHERE deleted_at IS NULL
         GROUP BY id_configuracion
      ) di ON di.id_configuracion = c.id_configuracion`;

  // Excluir tiendas PROVEEDORAS: matan el ánimo del resto (una sola proveedora
  // vende más que todas). Por la marca manual `es_proveedor=1` y, como esa marca
  // está incompleta, también por heurística de nombre ("...proveedor...").
  const noProveedor = `(cfg.es_proveedor IS NULL OR cfg.es_proveedor <> 1)
      AND LOWER(cfg.nombre_configuracion) NOT LIKE '%proveedor%'
      AND (c.shop_name IS NULL OR LOWER(c.shop_name) NOT LIKE '%proveedor%')`;

  // VENTA TOTAL (todas las órdenes del periodo, no solo entregadas: la venta
  // entregada daba números muy bajos y no motivaba). Solo cuentas ACTIVAS:
  //  - config NO suspendida
  //  - usuario con estado activo/trial/promo en usuarios_chat_center (una cuenta
  //    CANCELADA seguía apareciendo en el top aunque no paga).
  const base = `${fechaCond}
      AND di.cc = ?
      AND (cfg.suspendido = 0 OR cfg.suspendido IS NULL)
      AND u.estado IN ('activo','trial_usage','promo_usage')
      AND ${noProveedor}`;

  // top, resumen del país y "mi tienda" en PARALELO (independientes entre sí).
  const [top, [tot = {}], [propia = null]] = await Promise.all([
    db.query(
      // GROUP BY solo por configuración (una tienda = una config). Si se agrupa
      // también por shop_name, una tienda con 2 nombres de shop en el periodo
      // aparecía DUPLICADA (bug "mes pasado repetía tiendas").
      `SELECT c.id_configuracion,
              cfg.nombre_configuracion AS nombre,
              MAX(c.shop_name)    AS shop_name,
              COUNT(*)            AS pedidos,
              SUM(c.total_order)  AS monto,
              MAX(${inMias})      AS es_mia
         FROM dropi_orders_cache c ${joins}
        WHERE ${base}
        GROUP BY c.id_configuracion, cfg.nombre_configuracion
        ORDER BY monto DESC
        LIMIT ${LIMIT}`,
      { replacements: [paisRaw], type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT COUNT(DISTINCT c.id_configuracion) AS tiendas, SUM(c.total_order) AS monto
         FROM dropi_orders_cache c ${joins}
        WHERE ${base}`,
      { replacements: [paisRaw], type: db.QueryTypes.SELECT },
    ),
    misConfigs.length
      ? db.query(
          `SELECT c.id_configuracion, cfg.nombre_configuracion AS nombre,
                  COUNT(*) AS pedidos, SUM(c.total_order) AS monto
             FROM dropi_orders_cache c ${joins}
            WHERE ${base} AND ${inMias}
            GROUP BY c.id_configuracion, cfg.nombre_configuracion
            ORDER BY monto DESC LIMIT 1`,
          { replacements: [paisRaw], type: db.QueryTypes.SELECT },
        )
      : Promise.resolve([null]),
  ]);

  const ranking = top.map((r, i) => ({
    posicion: i + 1,
    id_configuracion: Number(r.id_configuracion),
    nombre: r.nombre || r.shop_name || `Tienda ${r.id_configuracion}`,
    shop_name: r.shop_name || null,
    pedidos: Number(r.pedidos) || 0,
    monto: Number(r.monto) || 0,
    es_mia: !!Number(r.es_mia),
  }));

  const resumen = {
    total_tiendas: Number(tot.tiendas) || ranking.length,
    total_pais: Number(tot.monto) || 0,
  };

  // Posición del que mira dentro de su país (por si no está en el top)
  let mi_tienda = null;

  if (propia) {
    const [{ pos } = { pos: null }] = await db.query(
      `SELECT COUNT(*) + 1 AS pos FROM (
          SELECT c.id_configuracion, SUM(c.total_order) AS monto
            FROM dropi_orders_cache c ${joins}
           WHERE ${base}
           GROUP BY c.id_configuracion
          HAVING monto > ?
       ) t`,
      {
        replacements: [paisRaw, Number(propia.monto) || 0],
        type: db.QueryTypes.SELECT,
      },
    );
    mi_tienda = {
      posicion: Number(pos) || null,
      id_configuracion: Number(propia.id_configuracion),
      nombre: propia.nombre || `Tienda ${propia.id_configuracion}`,
      pedidos: Number(propia.pedidos) || 0,
      monto: Number(propia.monto) || 0,
      es_mia: true,
      en_top: ranking.some((r) => r.es_mia),
    };
  }

  return res.json({
    success: true,
    data: { periodo, pais: paisIso, moneda, ranking, mi_tienda, resumen },
  });
});

// ───────────────────────────────────────────────────────────────
// TRANSPORTADORAS — vista analítica SOLO por ciudad + flete promedio
// POST /api/v1/dropi_stats/transportadoras_historico
//   { ciudad?, desde?, hasta?, id_configuracion? }
// La tasa de entrega se mide por CIUDAD (la provincial daba un valor demasiado
// general). Todas las tiendas (proveedoras incluidas) PERO acotado al PAÍS del
// que mira (un cliente MX no debe ver transportadoras de EC). Las 3 consultas
// corren en paralelo y usan índices cubridores → ~0.9s en vez de ~5s.
// ───────────────────────────────────────────────────────────────
exports.transportadorasHistorico = catchAsync(async (req, res) => {
  const ciudad = String(req.body?.ciudad || '').trim();
  const desde = String(req.body?.desde || '').trim(); // YYYY-MM-DD
  const hasta = String(req.body?.hasta || '').trim();
  const fechaOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  // País del que mira (para no mezclar transportadoras de otros países)
  const idUsuario = req.sessionUser?.id_usuario || -1;
  const idConfig = Number(req.body?.id_configuracion) || null;
  const misConfigs = (
    await db.query(`SELECT id FROM configuraciones WHERE id_usuario = ?`, {
      replacements: [idUsuario],
      type: db.QueryTypes.SELECT,
    })
  )
    .map((r) => Number(r.id))
    .filter(Boolean);
  const paisRaw = await resolverPaisRaw(idConfig, misConfigs);
  const paisIso = resolveRegion(paisRaw);
  const configIds = await configsDePais(paisRaw);
  const inPais = configIds.length
    ? `c.id_configuracion IN (${configIds.join(',')})`
    : '0';

  const cond = [
    `c.shipping_company IS NOT NULL AND TRIM(c.shipping_company) <> ''`,
    inPais,
  ];
  const repl = [];
  if (ciudad) {
    cond.push('c.city = ?');
    repl.push(ciudad);
  }
  if (fechaOk(desde)) {
    cond.push('c.order_created_at >= ?');
    repl.push(`${desde} 00:00:00`);
  }
  if (fechaOk(hasta)) {
    cond.push('c.order_created_at <= ?');
    repl.push(`${hasta} 23:59:59`);
  }
  const where = cond.join(' AND ');

  // El desglose de zonas es SIEMPRE por ciudad (nada de provincias).
  const zonaExpr = 'c.city';

  // Las 3 consultas en paralelo (misma selección, distinto GROUP BY).
  const [filas, [{ flete_global } = {}], zonasRows] = await Promise.all([
    db.query(
      `SELECT c.shipping_company AS transportadora,
              SUM(c.classified_status = 'entregada')  AS entregadas,
              SUM(c.classified_status = 'devolucion') AS devoluciones,
              SUM(c.classified_status = 'novedad')    AS novedades,
              SUM(c.classified_status IN (${EN_CURSO_SQL})) AS en_curso,
              COUNT(*)                                AS total,
              AVG(c.flete_amount)                     AS flete_promedio
         FROM dropi_orders_cache c
        WHERE ${where}
        GROUP BY c.shipping_company`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT AVG(c.flete_amount) AS flete_global
         FROM dropi_orders_cache c
        WHERE ${where}`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT ${zonaExpr} AS zona,
              SUM(c.classified_status = 'entregada')  AS entregadas,
              SUM(c.classified_status = 'devolucion') AS devoluciones,
              COUNT(*)                                AS total,
              AVG(c.flete_amount)                     AS flete_promedio
         FROM dropi_orders_cache c
        WHERE ${where} AND ${zonaExpr} IS NOT NULL AND TRIM(${zonaExpr}) <> ''
        GROUP BY zona
        ORDER BY total DESC
        LIMIT 20`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    ),
  ]);

  const transportadoras = filas
    .map(armarTransportadora)
    .sort(ordenarTransportadoras);

  const totalPedidos = transportadoras.reduce((a, t) => a + t.total, 0);
  const totalEntregadas = transportadoras.reduce((a, t) => a + t.entregadas, 0);
  const totalDevol = transportadoras.reduce((a, t) => a + t.devoluciones, 0);
  const finGlobal = totalEntregadas + totalDevol;
  const resumen = {
    total: totalPedidos,
    entregadas: totalEntregadas,
    devoluciones: totalDevol,
    efectividad: finGlobal > 0 ? Math.round((totalEntregadas / finGlobal) * 100) : null,
    flete_promedio: flete_global != null ? Number(flete_global) : null,
  };

  const zonas = zonasRows.map((r) => {
    const entregadas = Number(r.entregadas) || 0;
    const devoluciones = Number(r.devoluciones) || 0;
    const fin = entregadas + devoluciones;
    return {
      zona: r.zona,
      total: Number(r.total) || 0,
      entregadas,
      efectividad: fin > 0 ? Math.round((entregadas / fin) * 100) : null,
      flete_promedio: r.flete_promedio != null ? Number(r.flete_promedio) : null,
    };
  });

  return res.json({
    success: true,
    data: {
      pais: paisIso,
      ciudad,
      desde: fechaOk(desde) ? desde : null,
      hasta: fechaOk(hasta) ? hasta : null,
      nivel_zona: 'ciudad',
      resumen,
      transportadoras,
      zonas,
    },
  });
});

// ───────────────────────────────────────────────────────────────
// Lista para el filtro de la vista Transportadoras (ciudades con datos).
// GET /api/v1/dropi_stats/zonas_disponibles
// ───────────────────────────────────────────────────────────────
exports.zonasDisponibles = catchAsync(async (req, res) => {
  // Acotado al país del que mira (no mostrar ciudades de otros países).
  const idUsuario = req.sessionUser?.id_usuario || -1;
  const idConfig = Number(req.query?.id_configuracion) || null;
  const misConfigs = (
    await db.query(`SELECT id FROM configuraciones WHERE id_usuario = ?`, {
      replacements: [idUsuario],
      type: db.QueryTypes.SELECT,
    })
  )
    .map((r) => Number(r.id))
    .filter(Boolean);
  const paisRaw = await resolverPaisRaw(idConfig, misConfigs);
  const configIds = await configsDePais(paisRaw);
  const inPais = configIds.length
    ? `c.id_configuracion IN (${configIds.join(',')})`
    : '0';

  const ciudades = await db.query(
    `SELECT c.city AS zona, COUNT(*) AS total
       FROM dropi_orders_cache c
      WHERE ${inPais} AND c.city IS NOT NULL AND TRIM(c.city) <> ''
      GROUP BY zona
      ORDER BY total DESC
      LIMIT 300`,
    { type: db.QueryTypes.SELECT },
  );
  return res.json({
    success: true,
    data: {
      ciudades: ciudades.map((r) => ({ nombre: r.zona, total: Number(r.total) })),
    },
  });
});
