const { db } = require('../database/config');

/* ──────────────────────────────────────────────────────────────
   FILTROS DE NEGOCIO
   ────────────────────────────────────────────────────────────── */

// Excluye planes TEST de todos los cálculos
const FILTRO_NO_TEST = `(p.nombre_plan IS NULL OR p.nombre_plan NOT LIKE '%TEST%')`;

const COND_MRR_STRIPE = `
  u.stripe_subscription_id IS NOT NULL
  AND u.stripe_subscription_status = 'active'
  AND u.permanente = 0
  AND ${FILTRO_NO_TEST}
`;

const COND_TRIAL_STRIPE = `
  u.stripe_subscription_id IS NOT NULL
  AND u.stripe_subscription_status = 'trialing'
  AND u.permanente = 0
  AND ${FILTRO_NO_TEST}
`;

const COND_ACCESO_MANUAL = `
  u.estado = 'activo'
  AND u.permanente = 0
  AND u.id_plan IS NOT NULL
  AND (
    u.stripe_subscription_id IS NULL
    OR u.stripe_subscription_status IS NULL
    OR u.stripe_subscription_status NOT IN ('active','trialing')
  )
  AND (u.fecha_renovacion IS NULL OR u.fecha_renovacion > NOW())
  AND ${FILTRO_NO_TEST}
`;

async function calcularSnapshot(fecha = null, esEstimado = false) {
  const dia = fecha || new Date().toISOString().split('T')[0];
  const diaFin = `${dia} 23:59:59`;
  const diaInicio = `${dia} 00:00:00`;

  let resumen;

  if (esEstimado) {
    [resumen] = await db.query(
      `
      SELECT
        SUM(CASE
              WHEN u.permanente = 0
               AND u.id_plan IS NOT NULL
               AND u.fecha_inicio <= :diaFin
               AND (u.canceled_at IS NULL OR u.canceled_at > :diaFin)
               AND (u.fecha_renovacion IS NULL OR u.fecha_renovacion >= :diaInicio)
               AND ${FILTRO_NO_TEST}
              THEN 1 ELSE 0
            END) AS suscriptores_estimados,
        SUM(CASE
              WHEN u.permanente = 0
               AND u.id_plan IS NOT NULL
               AND u.fecha_inicio <= :diaFin
               AND (u.canceled_at IS NULL OR u.canceled_at > :diaFin)
               AND (u.fecha_renovacion IS NULL OR u.fecha_renovacion >= :diaInicio)
               AND ${FILTRO_NO_TEST}
              THEN COALESCE(p.precio_plan, 0) ELSE 0
            END) AS mrr_potencial_estimado,
        SUM(CASE WHEN u.permanente = 1 AND u.fecha_inicio <= :diaFin THEN 1 ELSE 0 END) AS clientes_cortesia,
        SUM(CASE WHEN DATE(u.created_at) = :dia THEN 1 ELSE 0 END) AS nuevos_dia,
        SUM(CASE WHEN DATE(u.canceled_at) = :dia THEN 1 ELSE 0 END) AS cancelados_dia
      FROM usuarios_chat_center u
      LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      `,
      { replacements: { dia, diaInicio, diaFin }, type: db.QueryTypes.SELECT },
    );

    return {
      fecha_snapshot: dia,
      is_estimated: 1,
      mrr: 0,
      arr: 0,
      mrr_stripe: 0,
      arr_stripe: 0,
      mrr_potencial: Number(resumen?.mrr_potencial_estimado || 0),
      clientes_pagando_stripe: 0,
      clientes_trial_stripe: 0,
      clientes_periodo_gratis: 0,
      clientes_acceso_manual: Number(resumen?.suscriptores_estimados || 0),
      por_convertir_30d: 0,
      por_convertir_60d: 0,
      clientes_activos: Number(resumen?.suscriptores_estimados || 0),
      clientes_trial: 0,
      clientes_promo: 0,
      clientes_cortesia: Number(resumen?.clientes_cortesia || 0),
      clientes_vencidos: 0,
      clientes_suspendidos: 0,
      clientes_cancelados_acumulado: 0,
      nuevos_dia: Number(resumen?.nuevos_dia || 0),
      cancelados_dia: Number(resumen?.cancelados_dia || 0),
      desglose_planes: '[]',
    };
  }

  // REAL — excluye planes TEST
  [resumen] = await db.query(
    `
    SELECT
      SUM(CASE WHEN ${COND_MRR_STRIPE} THEN COALESCE(p.precio_plan, 0) ELSE 0 END) AS mrr_stripe,
      SUM(CASE WHEN ${COND_TRIAL_STRIPE} THEN 1 ELSE 0 END) AS clientes_trial_stripe,
      SUM(CASE WHEN ${COND_MRR_STRIPE} THEN 1 ELSE 0 END) AS clientes_pagando_stripe,
      SUM(CASE WHEN ${COND_ACCESO_MANUAL} THEN 1 ELSE 0 END) AS clientes_acceso_manual,
      SUM(CASE
            WHEN ${COND_MRR_STRIPE} OR ${COND_TRIAL_STRIPE} OR ${COND_ACCESO_MANUAL}
            THEN COALESCE(p.precio_plan, 0) ELSE 0
          END) AS mrr_potencial,
      SUM(CASE
            WHEN ${COND_ACCESO_MANUAL}
             AND u.fecha_renovacion IS NOT NULL
             AND u.fecha_renovacion BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
            THEN 1 ELSE 0
          END) AS por_convertir_30d,
      SUM(CASE
            WHEN ${COND_ACCESO_MANUAL}
             AND u.fecha_renovacion IS NOT NULL
             AND u.fecha_renovacion BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 60 DAY)
            THEN 1 ELSE 0
          END) AS por_convertir_60d,
      SUM(CASE WHEN u.estado = 'activo' AND u.permanente = 0 AND u.id_plan IS NOT NULL AND ${FILTRO_NO_TEST} THEN 1 ELSE 0 END) AS clientes_activos_total,
      SUM(CASE WHEN u.estado = 'trial_usage' AND ${FILTRO_NO_TEST} THEN 1 ELSE 0 END) AS clientes_trial_usage,
      SUM(CASE WHEN u.estado = 'promo_usage' AND ${FILTRO_NO_TEST} THEN 1 ELSE 0 END) AS clientes_promo_usage,
      SUM(CASE WHEN u.permanente = 1 THEN 1 ELSE 0 END) AS clientes_cortesia,
      SUM(CASE WHEN u.estado = 'vencido' THEN 1 ELSE 0 END) AS clientes_vencidos,
      SUM(CASE WHEN u.estado = 'suspendido' THEN 1 ELSE 0 END) AS clientes_suspendidos,
      SUM(CASE WHEN u.estado = 'cancelado' THEN 1 ELSE 0 END) AS clientes_cancelados_acumulado,
      SUM(CASE WHEN u.estado = 'inactivo' OR u.id_plan IS NULL THEN 1 ELSE 0 END) AS clientes_inactivos,
      COUNT(*) AS total_registros_bd,
      SUM(CASE WHEN DATE(u.created_at) = :dia THEN 1 ELSE 0 END) AS nuevos_dia,
      SUM(CASE WHEN DATE(u.canceled_at) = :dia THEN 1 ELSE 0 END) AS cancelados_dia
    FROM usuarios_chat_center u
    LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
    `,
    { replacements: { dia }, type: db.QueryTypes.SELECT },
  );

  const mrrStripe = Number(resumen?.mrr_stripe || 0);
  const mrrPotencial = Number(resumen?.mrr_potencial || 0);

  // Desglose por plan — EXCLUYE TEST
  const desglose = await db.query(
    `
    SELECT
      p.id_plan,
      p.nombre_plan,
      p.precio_plan,
      p.tools_access,
      p.duracion_plan,
      COUNT(u.id_usuario) AS activos_total,
      SUM(CASE WHEN ${COND_MRR_STRIPE} THEN 1 ELSE 0 END) AS pagando_stripe,
      SUM(CASE WHEN ${COND_TRIAL_STRIPE} THEN 1 ELSE 0 END) AS trial_stripe,
      SUM(CASE WHEN ${COND_ACCESO_MANUAL} THEN 1 ELSE 0 END) AS acceso_manual,
      SUM(CASE WHEN ${COND_MRR_STRIPE} THEN COALESCE(p.precio_plan,0) ELSE 0 END) AS mrr_stripe_plan,
      SUM(CASE WHEN u.permanente = 1 AND u.estado = 'activo' THEN 1 ELSE 0 END) AS permanentes_en_plan
    FROM planes_chat_center p
    LEFT JOIN usuarios_chat_center u
           ON u.id_plan = p.id_plan
          AND u.estado = 'activo'
    WHERE p.activo = 1
      AND p.nombre_plan NOT LIKE '%TEST%'
    GROUP BY p.id_plan, p.nombre_plan, p.precio_plan, p.tools_access, p.duracion_plan
    HAVING activos_total > 0
    ORDER BY mrr_stripe_plan DESC, activos_total DESC
    `,
    { type: db.QueryTypes.SELECT },
  );

  return {
    fecha_snapshot: dia,
    is_estimated: 0,
    mrr: mrrStripe,
    arr: mrrStripe * 12,
    mrr_stripe: mrrStripe,
    arr_stripe: mrrStripe * 12,
    mrr_potencial: mrrPotencial,
    clientes_pagando_stripe: Number(resumen?.clientes_pagando_stripe || 0),
    clientes_trial_stripe: Number(resumen?.clientes_trial_stripe || 0),
    clientes_periodo_gratis: Number(resumen?.clientes_acceso_manual || 0),
    clientes_acceso_manual: Number(resumen?.clientes_acceso_manual || 0),
    por_convertir_30d: Number(resumen?.por_convertir_30d || 0),
    por_convertir_60d: Number(resumen?.por_convertir_60d || 0),
    clientes_activos: Number(resumen?.clientes_activos_total || 0),
    clientes_trial: Number(resumen?.clientes_trial_usage || 0),
    clientes_promo: Number(resumen?.clientes_promo_usage || 0),
    clientes_cortesia: Number(resumen?.clientes_cortesia || 0),
    clientes_vencidos: Number(resumen?.clientes_vencidos || 0),
    clientes_suspendidos: Number(resumen?.clientes_suspendidos || 0),
    clientes_cancelados_acumulado: Number(
      resumen?.clientes_cancelados_acumulado || 0,
    ),
    clientes_inactivos: Number(resumen?.clientes_inactivos || 0),
    total_registros_bd: Number(resumen?.total_registros_bd || 0),
    nuevos_dia: Number(resumen?.nuevos_dia || 0),
    cancelados_dia: Number(resumen?.cancelados_dia || 0),
    desglose_planes: JSON.stringify(desglose),
  };
}

async function guardarSnapshot(snapshot) {
  await db.query(
    `
    INSERT INTO metricas_snapshot_chat_center
      (fecha_snapshot, is_estimated,
       mrr, arr, mrr_stripe, arr_stripe, mrr_potencial,
       clientes_pagando_stripe, clientes_trial_stripe, clientes_periodo_gratis,
       clientes_activos, clientes_trial, clientes_promo, clientes_cortesia,
       clientes_vencidos, clientes_suspendidos, clientes_cancelados_acumulado,
       por_convertir_30d, por_convertir_60d,
       nuevos_dia, cancelados_dia, desglose_planes)
    VALUES
      (:fecha_snapshot, :is_estimated,
       :mrr, :arr, :mrr_stripe, :arr_stripe, :mrr_potencial,
       :clientes_pagando_stripe, :clientes_trial_stripe, :clientes_periodo_gratis,
       :clientes_activos, :clientes_trial, :clientes_promo, :clientes_cortesia,
       :clientes_vencidos, :clientes_suspendidos, :clientes_cancelados_acumulado,
       :por_convertir_30d, :por_convertir_60d,
       :nuevos_dia, :cancelados_dia, :desglose_planes)
    ON DUPLICATE KEY UPDATE
      is_estimated = VALUES(is_estimated),
      mrr = VALUES(mrr), arr = VALUES(arr),
      mrr_stripe = VALUES(mrr_stripe), arr_stripe = VALUES(arr_stripe),
      mrr_potencial = VALUES(mrr_potencial),
      clientes_pagando_stripe = VALUES(clientes_pagando_stripe),
      clientes_trial_stripe = VALUES(clientes_trial_stripe),
      clientes_periodo_gratis = VALUES(clientes_periodo_gratis),
      clientes_activos = VALUES(clientes_activos),
      clientes_trial = VALUES(clientes_trial),
      clientes_promo = VALUES(clientes_promo),
      clientes_cortesia = VALUES(clientes_cortesia),
      clientes_vencidos = VALUES(clientes_vencidos),
      clientes_suspendidos = VALUES(clientes_suspendidos),
      clientes_cancelados_acumulado = VALUES(clientes_cancelados_acumulado),
      por_convertir_30d = VALUES(por_convertir_30d),
      por_convertir_60d = VALUES(por_convertir_60d),
      nuevos_dia = VALUES(nuevos_dia),
      cancelados_dia = VALUES(cancelados_dia),
      desglose_planes = VALUES(desglose_planes)
    `,
    { replacements: snapshot, type: db.QueryTypes.INSERT },
  );
}

/**
 * Métricas en vivo con periodo de comparación variable
 * @param {number} dias - 7, 14, 30, 60, 90 (default 30)
 */
async function metricasEnVivo(dias = 30) {
  const diasComp = Math.min(180, Math.max(1, Number(dias) || 30));
  const snapshot = await calcularSnapshot(null, false);

  // Tasa de conversión REAL — excluyendo TEST
  const [conv] = await db.query(
    `
    SELECT
      COUNT(*) AS total_post_gratis,
      SUM(CASE WHEN u.stripe_subscription_status = 'active'
                AND u.stripe_subscription_id IS NOT NULL
               THEN 1 ELSE 0 END) AS convertidos
    FROM usuarios_chat_center u
    LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
    WHERE u.id_plan IS NOT NULL
      AND u.permanente = 0
      AND u.fecha_renovacion BETWEEN DATE_SUB(NOW(), INTERVAL 90 DAY) AND NOW()
      AND ${FILTRO_NO_TEST}
    `,
    { type: db.QueryTypes.SELECT },
  );
  const tasaConversion =
    Number(conv?.total_post_gratis || 0) > 0
      ? (Number(conv.convertidos) / Number(conv.total_post_gratis)) * 100
      : null;

  // Snapshot de referencia (hace N días)
  const hace = new Date(Date.now() - diasComp * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  const [ref] = await db.query(
    `SELECT * FROM metricas_snapshot_chat_center
       WHERE fecha_snapshot <= ?
       ORDER BY fecha_snapshot DESC LIMIT 1`,
    { replacements: [hace], type: db.QueryTypes.SELECT },
  );

  const delta = (actual, anterior) => {
    if (anterior === null || anterior === undefined) return null;
    const a = Number(actual) || 0;
    const b = Number(anterior) || 0;
    return { abs: a - b, pct: b === 0 ? null : ((a - b) / b) * 100 };
  };

  const [nuevosMes] = await db.query(
    `SELECT COUNT(*) AS n FROM usuarios_chat_center
       WHERE DATE_FORMAT(created_at,'%Y-%m') = DATE_FORMAT(NOW(),'%Y-%m')`,
    { type: db.QueryTypes.SELECT },
  );
  const [nuevosMesAnt] = await db.query(
    `SELECT COUNT(*) AS n FROM usuarios_chat_center
       WHERE DATE_FORMAT(created_at,'%Y-%m') = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH),'%Y-%m')`,
    { type: db.QueryTypes.SELECT },
  );
  const [cancelMes] = await db.query(
    `SELECT COUNT(*) AS n FROM usuarios_chat_center
       WHERE DATE_FORMAT(canceled_at,'%Y-%m') = DATE_FORMAT(NOW(),'%Y-%m')`,
    { type: db.QueryTypes.SELECT },
  );

  const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString()
    .split('T')[0];
  const [snapInicioMes] = await db.query(
    `SELECT clientes_pagando_stripe FROM metricas_snapshot_chat_center
      WHERE fecha_snapshot <= ?
      ORDER BY fecha_snapshot DESC LIMIT 1`,
    { replacements: [inicioMes], type: db.QueryTypes.SELECT },
  );
  const pagandoInicioMes = Number(
    snapInicioMes?.clientes_pagando_stripe || snapshot.clientes_pagando_stripe,
  );
  const churnMes =
    pagandoInicioMes > 0 ? (Number(cancelMes.n) / pagandoInicioMes) * 100 : 0;

  const arpu =
    snapshot.clientes_pagando_stripe > 0
      ? snapshot.mrr_stripe / snapshot.clientes_pagando_stripe
      : 0;
  const ltv = churnMes > 0 ? arpu / (churnMes / 100) : null;

  return {
    mrr_stripe: snapshot.mrr_stripe,
    arr_stripe: snapshot.arr_stripe,
    mrr_potencial: snapshot.mrr_potencial,
    arr_potencial: snapshot.mrr_potencial * 12,

    clientes_pagando_stripe: snapshot.clientes_pagando_stripe,
    clientes_trial_stripe: snapshot.clientes_trial_stripe,
    clientes_acceso_manual: snapshot.clientes_acceso_manual,
    clientes_cortesia: snapshot.clientes_cortesia,
    clientes_trial_usage: snapshot.clientes_trial,
    clientes_promo_usage: snapshot.clientes_promo,
    clientes_vencidos: snapshot.clientes_vencidos,
    clientes_suspendidos: snapshot.clientes_suspendidos,
    clientes_cancelados: snapshot.clientes_cancelados_acumulado,
    clientes_inactivos: snapshot.clientes_inactivos,
    clientes_activos_total: snapshot.clientes_activos,
    total_registros_bd: snapshot.total_registros_bd,

    por_convertir_30d: snapshot.por_convertir_30d,
    por_convertir_60d: snapshot.por_convertir_60d,
    tasa_conversion_pct: tasaConversion,
    conversion_muestra: {
      total: Number(conv?.total_post_gratis || 0),
      convertidos: Number(conv?.convertidos || 0),
    },

    nuevos_mes: Number(nuevosMes.n),
    cancelados_mes: Number(cancelMes.n),
    churn_pct: churnMes,
    arpu,
    ltv,

    desglose_planes: JSON.parse(snapshot.desglose_planes || '[]'),

    deltas: ref
      ? {
          mrr_stripe: delta(snapshot.mrr_stripe, ref.mrr_stripe),
          mrr_potencial: delta(snapshot.mrr_potencial, ref.mrr_potencial),
          clientes_pagando_stripe: delta(
            snapshot.clientes_pagando_stripe,
            ref.clientes_pagando_stripe,
          ),
          clientes_acceso_manual: delta(
            snapshot.clientes_acceso_manual,
            ref.clientes_periodo_gratis,
          ),
          clientes_activos: delta(
            snapshot.clientes_activos,
            ref.clientes_activos,
          ),
          nuevos_mes: delta(Number(nuevosMes.n), Number(nuevosMesAnt.n)),
        }
      : null,
    dias_comparacion: diasComp,
    referencia_delta: ref?.fecha_snapshot || null,
  };
}

module.exports = { calcularSnapshot, guardarSnapshot, metricasEnVivo };
