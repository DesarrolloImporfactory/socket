const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const { metricasEnVivo } = require('../services/metricas.service');

/* ══════════════════════════════════════════════════════════════
   GET /admin_dashboard/resumen
   Header del dashboard: KPIs grandes + deltas vs hace 30 días
   ══════════════════════════════════════════════════════════════ */
exports.resumen = catchAsync(async (req, res) => {
  const dias = parseInt(req.query.dias, 10) || 30;
  const data = await metricasEnVivo(dias);
  res.json({ status: 'success', data });
});
/* ══════════════════════════════════════════════════════════════
   GET /admin_dashboard/serie?meses=12
   Serie histórica de MRR + activos para gráfico
   Toma el snapshot del último día de cada mes.
   ══════════════════════════════════════════════════════════════ */
exports.serie = catchAsync(async (req, res) => {
  const meses = Math.min(36, Math.max(1, parseInt(req.query.meses, 10) || 12));

  const rows = await db.query(
    `
    SELECT
      DATE_FORMAT(fecha_snapshot, '%Y-%m') AS mes,
      MAX(fecha_snapshot) AS ultimo_dia
    FROM metricas_snapshot_chat_center
    WHERE fecha_snapshot >= DATE_SUB(CURDATE(), INTERVAL :meses MONTH)
    GROUP BY DATE_FORMAT(fecha_snapshot, '%Y-%m')
    ORDER BY mes ASC
    `,
    { replacements: { meses }, type: db.QueryTypes.SELECT },
  );

  if (rows.length === 0) return res.json({ status: 'success', data: [] });

  const fechas = rows.map((r) => r.ultimo_dia);
  const snaps = await db.query(
    `
    SELECT fecha_snapshot, is_estimated,
           mrr_stripe, mrr_potencial,
           clientes_pagando_stripe, clientes_trial_stripe,
           clientes_periodo_gratis, clientes_activos,
           clientes_trial, clientes_promo, clientes_cortesia,
           nuevos_dia, cancelados_dia
    FROM metricas_snapshot_chat_center
    WHERE fecha_snapshot IN (:fechas)
    ORDER BY fecha_snapshot ASC
    `,
    { replacements: { fechas }, type: db.QueryTypes.SELECT },
  );

  const mesesData = await db.query(
    `
    SELECT
      DATE_FORMAT(fecha_snapshot, '%Y-%m') AS mes,
      SUM(nuevos_dia) AS nuevos_mes,
      SUM(cancelados_dia) AS cancelados_mes
    FROM metricas_snapshot_chat_center
    WHERE fecha_snapshot >= DATE_SUB(CURDATE(), INTERVAL :meses MONTH)
    GROUP BY DATE_FORMAT(fecha_snapshot, '%Y-%m')
    ORDER BY mes ASC
    `,
    { replacements: { meses }, type: db.QueryTypes.SELECT },
  );

  const mapMes = Object.fromEntries(mesesData.map((m) => [m.mes, m]));

  const data = snaps.map((s) => {
    const mes = s.fecha_snapshot.toISOString
      ? s.fecha_snapshot.toISOString().slice(0, 7)
      : String(s.fecha_snapshot).slice(0, 7);
    return {
      mes,
      fecha: s.fecha_snapshot,
      is_estimated: s.is_estimated,
      mrr_stripe: Number(s.mrr_stripe || 0),
      mrr_potencial: Number(s.mrr_potencial || 0),
      clientes_pagando: Number(s.clientes_pagando_stripe || 0),
      clientes_trial_stripe: Number(s.clientes_trial_stripe || 0),
      clientes_acceso_manual: Number(s.clientes_periodo_gratis || 0),
      clientes_activos: Number(s.clientes_activos || 0),
      clientes_cortesia: Number(s.clientes_cortesia || 0),
      nuevos_mes: Number(mapMes[mes]?.nuevos_mes || 0),
      cancelados_mes: Number(mapMes[mes]?.cancelados_mes || 0),
    };
  });

  res.json({ status: 'success', data });
});

/* ══════════════════════════════════════════════════════════════
   GET /admin_dashboard/cancelaciones_mes?mes=YYYY-MM
   Tabla de cancelaciones del mes con motivo (si hay seguimiento)
   ══════════════════════════════════════════════════════════════ */
exports.cancelacionesMes = catchAsync(async (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0, 7); // YYYY-MM

  const rows = await db.query(
    `
    SELECT
      u.id_usuario,
      u.nombre AS empresa,
      u.email_propietario AS email,
      u.estado,
      u.canceled_at,
      u.cancel_at,
      u.cancel_at_period_end,
      u.fecha_inicio,
      DATEDIFF(COALESCE(u.canceled_at, NOW()), u.fecha_inicio) AS dias_de_vida,
      p.nombre_plan,
      p.precio_plan,

      /* Último seguimiento tipo=cancelacion (si existe) */
      (SELECT sc.motivo_cancelacion
         FROM seguimiento_clientes_chat_center sc
        WHERE sc.id_usuario = u.id_usuario
          AND sc.tipo = 'cancelacion'
        ORDER BY sc.fecha_seguimiento DESC LIMIT 1) AS motivo_cancelacion,

      (SELECT sc.motivo_cancelacion_detalle
         FROM seguimiento_clientes_chat_center sc
        WHERE sc.id_usuario = u.id_usuario
          AND sc.tipo = 'cancelacion'
        ORDER BY sc.fecha_seguimiento DESC LIMIT 1) AS motivo_detalle,

      (SELECT COUNT(*)
         FROM seguimiento_clientes_chat_center sc
        WHERE sc.id_usuario = u.id_usuario) AS total_seguimientos
    FROM usuarios_chat_center u
    LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
    WHERE DATE_FORMAT(u.canceled_at, '%Y-%m') = :mes
       OR (u.cancel_at_period_end = 1 AND DATE_FORMAT(u.cancel_at, '%Y-%m') = :mes)
    ORDER BY u.canceled_at DESC, u.cancel_at DESC
    `,
    { replacements: { mes }, type: db.QueryTypes.SELECT },
  );

  res.json({ status: 'success', mes, total: rows.length, data: rows });
});

/* ══════════════════════════════════════════════════════════════
   GET /admin_dashboard/desglose_planes
   Distribución actual de clientes activos por plan
   ══════════════════════════════════════════════════════════════ */
exports.desglosePlanes = catchAsync(async (req, res) => {
  const rows = await db.query(
    `
    SELECT
      p.id_plan, p.nombre_plan, p.precio_plan, p.tools_access, p.duracion_plan,
      COUNT(u.id_usuario) AS activos,
      COALESCE(SUM(p.precio_plan),0) AS mrr_plan,
      SUM(CASE WHEN u.tipo_plan = 'mensual' THEN 1 ELSE 0 END) AS activos_mensual,
      SUM(CASE WHEN u.tipo_plan = 'conversaciones' THEN 1 ELSE 0 END) AS activos_conversaciones,
      SUM(CASE WHEN u.permanente = 1 THEN 1 ELSE 0 END) AS permanentes_en_plan
    FROM planes_chat_center p
    LEFT JOIN usuarios_chat_center u
           ON u.id_plan = p.id_plan
          AND u.estado = 'activo'
    WHERE p.activo = 1
      AND p.nombre_plan NOT LIKE '%TEST%'
    GROUP BY p.id_plan, p.nombre_plan, p.precio_plan, p.tools_access, p.duracion_plan
    ORDER BY mrr_plan DESC
    `,
    { type: db.QueryTypes.SELECT },
  );
  res.json({ status: 'success', data: rows });
});

/* ══════════════════════════════════════════════════════════════
   POST /admin_dashboard/snapshot_now
   Botón "recalcular ahora" en el dashboard.
   ══════════════════════════════════════════════════════════════ */
const {
  calcularSnapshot,
  guardarSnapshot,
} = require('../services/metricas.service');

exports.snapshotAhora = catchAsync(async (req, res) => {
  const snap = await calcularSnapshot(null, false);
  await guardarSnapshot(snap);
  res.json({ status: 'success', data: snap });
});

/* ══════════════════════════════════════════════════════════════
   GET /admin_dashboard/clientes_por_categoria?categoria=acceso_manual&limit=100
   Devuelve la lista de clientes de cada categoría (para drawer)
   ══════════════════════════════════════════════════════════════ */
exports.clientesPorCategoria = catchAsync(async (req, res) => {
  const categoria = String(req.query.categoria || '').toLowerCase();
  const limit = Math.min(
    200,
    Math.max(1, parseInt(req.query.limit, 10) || 100),
  );

  const baseSelect = `
    SELECT
      u.id_usuario, u.nombre AS empresa, u.email_propietario AS email,
      u.estado, u.fecha_inicio, u.fecha_renovacion,
      u.stripe_subscription_status, u.stripe_subscription_id,
      u.permanente, u.cancel_at_period_end,
      p.nombre_plan, p.precio_plan, p.duracion_plan,
      DATEDIFF(NOW(), u.fecha_inicio) AS dias_de_vida,
      DATEDIFF(u.fecha_renovacion, NOW()) AS dias_para_vencer,
      (SELECT MAX(mm.created_at)
         FROM mensajes_clientes mm
         INNER JOIN configuraciones cc ON cc.id = mm.id_configuracion
        WHERE cc.id_usuario = u.id_usuario) AS ultimo_mensaje
    FROM usuarios_chat_center u
    LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
  `;

  const NO_TEST = `(p.nombre_plan IS NULL OR p.nombre_plan NOT LIKE '%TEST%')`;
  let where = '';

  switch (categoria) {
    case 'pagando_stripe':
      where = `WHERE u.stripe_subscription_id IS NOT NULL
                 AND u.stripe_subscription_status = 'active'
                 AND u.permanente = 0 AND ${NO_TEST}`;
      break;
    case 'trial_stripe':
      where = `WHERE u.stripe_subscription_id IS NOT NULL
                 AND u.stripe_subscription_status = 'trialing'
                 AND u.permanente = 0 AND ${NO_TEST}`;
      break;
    case 'acceso_manual':
      where = `WHERE u.estado = 'activo' AND u.permanente = 0
                 AND u.id_plan IS NOT NULL
                 AND (
                   u.stripe_subscription_id IS NULL
                   OR u.stripe_subscription_status IS NULL
                   OR u.stripe_subscription_status NOT IN ('active','trialing')
                 )
                 AND (u.fecha_renovacion IS NULL OR u.fecha_renovacion > NOW())
                 AND ${NO_TEST}`;
      break;
    case 'permanentes':
      where = `WHERE u.permanente = 1`;
      break;
    case 'trial_usage':
      where = `WHERE u.estado = 'trial_usage' AND ${NO_TEST}`;
      break;
    case 'promo_usage':
      where = `WHERE u.estado = 'promo_usage' AND ${NO_TEST}`;
      break;
    case 'vencidos':
      where = `WHERE u.estado = 'vencido'`;
      break;
    case 'suspendidos':
      where = `WHERE u.estado = 'suspendido'`;
      break;
    case 'cancelados':
      where = `WHERE u.estado = 'cancelado'`;
      break;
    case 'inactivos':
      where = `WHERE u.estado = 'inactivo' OR u.id_plan IS NULL`;
      break;
    case 'por_convertir_30d':
      where = `WHERE u.estado = 'activo' AND u.permanente = 0
                 AND u.id_plan IS NOT NULL
                 AND (
                   u.stripe_subscription_id IS NULL
                   OR u.stripe_subscription_status NOT IN ('active','trialing')
                 )
                 AND u.fecha_renovacion BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
                 AND ${NO_TEST}`;
      break;
    default:
      return res
        .status(400)
        .json({ status: 'error', message: 'categoria inválida' });
  }

  const sql = `${baseSelect} ${where} ORDER BY u.fecha_renovacion ASC, u.fecha_inicio DESC LIMIT ${limit}`;
  const rows = await db.query(sql, { type: db.QueryTypes.SELECT });
  return res.json({
    status: 'success',
    categoria,
    total: rows.length,
    data: rows,
  });
});
