const ExcelJS = require('exceljs');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

/* ══════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════ */

const ESTADOS_VALIDOS = [
  'activo',
  'inactivo',
  'suspendido',
  'vencido',
  'cancelado',
  'trial_usage',
  'promo_usage',
];

const SEMAFOROS_VALIDOS = ['verde', 'amarillo', 'rojo', 'gris'];

/** Parser consistente de toggles: acepta 1, '1', true, 'true' */
const isTrue = (v) => v === 1 || v === '1' || v === true || v === 'true';

/**
 * WhatsApp activo = configuración NO suspendida + los 4 campos esenciales
 * completos (id_telefono, id_whatsapp, token, webhook_url).
 * (el campo `telefono` es solo display, no es requisito de conexión)
 */
const WHATSAPP_ACTIVO_SQL = `
  c.suspendido = 0
  AND COALESCE(c.id_telefono,'')  <> ''
  AND COALESCE(c.id_whatsapp,'')  <> ''
  AND COALESCE(c.token,'')        <> ''
  AND COALESCE(c.webhook_url,'')  <> ''
`;

function construirFiltros(body) {
  const {
    search,
    estado,
    id_plan,
    tipo_plan,
    stripe_status,
    tools_access,
    fecha_registro_desde,
    fecha_registro_hasta,
    fecha_renovacion_desde,
    fecha_renovacion_hasta,
  } = body;

  const where = [];
  const replacements = [];

  if (search && search.trim()) {
    const like = `%${search.trim().toLowerCase()}%`;
    where.push(`(
      LOWER(u.nombre) LIKE ? OR
      LOWER(u.email_propietario) LIKE ? OR
      CAST(u.id_usuario AS CHAR) LIKE ? OR
      EXISTS (
        SELECT 1 FROM configuraciones c
         WHERE c.id_usuario = u.id_usuario
           AND LOWER(c.telefono) LIKE ?
      )
    )`);
    replacements.push(like, like, like, like);
  }

  if (estado && ESTADOS_VALIDOS.includes(estado)) {
    where.push('u.estado = ?');
    replacements.push(estado);
  }

  if (id_plan !== undefined && id_plan !== null && id_plan !== '') {
    where.push('u.id_plan = ?');
    replacements.push(Number(id_plan));
  }

  /* Toggles — usan el parser tolerante */
  if (isTrue(body.sin_plan)) {
    where.push('u.id_plan IS NULL');
  }

  if (tipo_plan && ['mensual', 'conversaciones'].includes(tipo_plan)) {
    where.push('u.tipo_plan = ?');
    replacements.push(tipo_plan);
  }

  if (stripe_status && stripe_status.trim()) {
    where.push('u.stripe_subscription_status = ?');
    replacements.push(stripe_status.trim());
  }

  /* Producto — EXACT MATCH:
     "imporchat"    → solo acceso a ImporChat (exclusivo)
     "insta_landing"→ solo acceso a Insta Landing (exclusivo)
     "both"         → acceso a ambos productos
  */
  if (
    tools_access &&
    ['imporchat', 'insta_landing', 'both'].includes(tools_access)
  ) {
    where.push('p.tools_access = ?');
    replacements.push(tools_access);
  }

  if (isTrue(body.cancel_at_period_end)) {
    where.push('u.cancel_at_period_end = 1');
  }

  if (isTrue(body.permanente)) {
    where.push('u.permanente = 1');
  }

  if (fecha_registro_desde) {
    where.push('u.created_at >= ?');
    replacements.push(fecha_registro_desde);
  }

  if (fecha_registro_hasta) {
    where.push('u.created_at <= ?');
    replacements.push(fecha_registro_hasta + ' 23:59:59');
  }

  if (fecha_renovacion_desde) {
    where.push('u.fecha_renovacion >= ?');
    replacements.push(fecha_renovacion_desde);
  }

  if (fecha_renovacion_hasta) {
    where.push('u.fecha_renovacion <= ?');
    replacements.push(fecha_renovacion_hasta + ' 23:59:59');
  }

  if (isTrue(body.con_whatsapp_activo)) {
    where.push(`EXISTS (
      SELECT 1 FROM configuraciones c
       WHERE c.id_usuario = u.id_usuario
         AND ${WHATSAPP_ACTIVO_SQL}
    )`);
  }

  /* ── Pseudo-filtros de KPIs ── */

  // Trial + Promo: clientes en estado trial_usage o promo_usage
  if (isTrue(body.estado_trial_o_promo)) {
    where.push(`u.estado IN ('trial_usage','promo_usage')`);
  }

  // Por vencer 7d: activos cuya fecha de renovación es en los próximos 0-7 días
  if (isTrue(body.por_vencer_7d)) {
    where.push(`
      u.estado = 'activo'
      AND u.fecha_renovacion IS NOT NULL
      AND DATEDIFF(u.fecha_renovacion, NOW()) BETWEEN 0 AND 7
    `);
  }

  // Nuevos 30d: registrados en los últimos 30 días
  if (isTrue(body.nuevos_30d)) {
    where.push(`u.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`);
  }

  return { where, replacements };
}

/**
 * Query base: SELECT + FROM + JOINs + semáforo calculado.
 */
function buildBaseSelect() {
  return `
    SELECT
      u.id_usuario,
      u.nombre                    AS empresa,
      u.email_propietario         AS email,
      u.estado,
      u.id_plan,
      u.tipo_plan,
      u.permanente,
      u.fecha_inicio,
      u.fecha_renovacion,
      u.free_trial_used,
      u.promo_plan2_used,
      u.stripe_subscription_id,
      u.stripe_subscription_status,
      u.cancel_at_period_end,
      u.cancel_at,
      u.canceled_at,
      u.trial_end,
      u.cant_conversaciones_mes,
      u.subusuarios_adicionales,
      u.conexiones_adicionales,
      u.created_at                AS fecha_registro,
      u.updated_at                AS ultima_actualizacion,
      u.il_trial_used,
      u.il_imagenes_usadas,
      u.promo_imagenes_restantes,
      u.promo_angulos_restantes,

      /* Plan actual */
      p.nombre_plan,
      p.precio_plan,
      p.duracion_plan,
      p.max_subusuarios,
      p.max_conexiones,
      p.max_agentes_whatsapp,
      p.max_banners_mes,
      p.max_imagenes_ia,
      p.tools_access,

      /* Plan pendiente (upgrade/downgrade) */
      pp.nombre_plan              AS pending_plan_nombre,
      u.pending_change,
      u.pending_effective_at,

      /* Conteos */
      (SELECT COUNT(*)
         FROM sub_usuarios_chat_center su
        WHERE su.id_usuario = u.id_usuario)                AS total_subusuarios,

      (SELECT COUNT(*)
         FROM configuraciones c
        WHERE c.id_usuario = u.id_usuario
          AND c.suspendido = 0)                            AS total_conexiones_activas,

      (SELECT COUNT(*)
         FROM configuraciones c
        WHERE c.id_usuario = u.id_usuario)                 AS total_conexiones,

      /* ── WhatsApp activo: validación ESTRICTA
         (id_telefono + id_whatsapp + token + webhook_url completos) */
      (SELECT COUNT(*)
         FROM configuraciones c
        WHERE c.id_usuario = u.id_usuario
          AND ${WHATSAPP_ACTIVO_SQL})                      AS total_whatsapp_activos,

      (SELECT COUNT(*)
         FROM configuraciones c
        WHERE c.id_usuario = u.id_usuario
          AND c.suspendido = 0
          AND COALESCE(c.api_key_openai,'') <> '')         AS total_agentes_ia,

      /* Teléfono principal (primera config conectada) */
      (SELECT c.telefono
         FROM configuraciones c
        WHERE c.id_usuario = u.id_usuario
          AND c.suspendido = 0
          AND c.telefono IS NOT NULL
        ORDER BY c.id ASC
        LIMIT 1)                                           AS telefono_principal,

      /* Última actividad: último mensaje del usuario */
      (SELECT MAX(mm.created_at)
         FROM mensajes_clientes mm
         INNER JOIN configuraciones cc
                 ON cc.id = mm.id_configuracion
        WHERE cc.id_usuario = u.id_usuario)                AS ultimo_mensaje,

      /* Días hasta vencimiento */
      CASE
        WHEN u.fecha_renovacion IS NULL THEN NULL
        ELSE DATEDIFF(u.fecha_renovacion, NOW())
      END AS dias_hasta_vencimiento,

      /* Semáforo */
      CASE
        WHEN u.permanente = 1 AND u.estado = 'activo'                    THEN 'verde'
        WHEN u.estado IN ('vencido','cancelado','inactivo','suspendido') THEN 'rojo'
        WHEN u.id_plan IS NULL OR u.fecha_renovacion IS NULL             THEN 'gris'
        WHEN DATEDIFF(u.fecha_renovacion, NOW()) < 0                     THEN 'rojo'
        WHEN DATEDIFF(u.fecha_renovacion, NOW()) <= 7                    THEN 'amarillo'
        WHEN u.estado IN ('trial_usage','promo_usage')                   THEN 'amarillo'
        ELSE 'verde'
      END AS semaforo

    FROM usuarios_chat_center u
    LEFT JOIN planes_chat_center p  ON p.id_plan  = u.id_plan
    LEFT JOIN planes_chat_center pp ON pp.id_plan = u.pending_plan_id
  `;
}

/* ══════════════════════════════════════════════════════════════
   LISTAR (paginado + filtros)
   ══════════════════════════════════════════════════════════════ */

exports.listarUsuariosAdmin = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.body?.page ?? 1, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(req.body?.limit ?? 25, 10) || 25),
  );
  const offset = (page - 1) * limit;

  const order_by = req.body?.order_by || 'fecha_registro';
  const order_dir =
    (req.body?.order_dir || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  /* Alias del subquery `t` */
  const ORDER_COLS = {
    fecha_registro: 'fecha_registro',
    empresa: 'empresa',
    email: 'email',
    fecha_renovacion: 'fecha_renovacion',
    estado: 'estado',
    plan: 'nombre_plan',
    ultimo_mensaje: 'ultimo_mensaje',
    total_whatsapp_activos: 'total_whatsapp_activos',
    dias_hasta_vencimiento: 'dias_hasta_vencimiento',
  };
  const orderCol = ORDER_COLS[order_by] || 'fecha_registro';

  const { where, replacements } = construirFiltros(req.body || {});
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const semaforoFiltro =
    req.body?.semaforo && SEMAFOROS_VALIDOS.includes(req.body.semaforo)
      ? req.body.semaforo
      : null;

  const baseSelect = buildBaseSelect();

  const sql = `
    SELECT * FROM (
      ${baseSelect}
      ${whereSql}
    ) AS t
    ${semaforoFiltro ? 'WHERE t.semaforo = ?' : ''}
    ORDER BY t.${orderCol} ${order_dir}
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) AS total FROM (
      ${baseSelect}
      ${whereSql}
    ) AS t
    ${semaforoFiltro ? 'WHERE t.semaforo = ?' : ''}
  `;

  const reps = [...replacements];
  const repsCnt = [...replacements];

  if (semaforoFiltro) {
    reps.push(semaforoFiltro);
    repsCnt.push(semaforoFiltro);
  }
  reps.push(limit, offset);

  const [rows, totalRow] = await Promise.all([
    db.query(sql, { replacements: reps, type: db.QueryTypes.SELECT }),
    db.query(countSql, { replacements: repsCnt, type: db.QueryTypes.SELECT }),
  ]);

  const total = totalRow?.[0]?.total || 0;

  return res.json({
    status: 'success',
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
    data: rows,
  });
});

/* ══════════════════════════════════════════════════════════════
   DETALLE
   ══════════════════════════════════════════════════════════════ */

exports.detalleUsuarioAdmin = catchAsync(async (req, res, next) => {
  const id_usuario = parseInt(req.params.id_usuario, 10);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));

  const baseSelect = buildBaseSelect();

  const usuarioRows = await db.query(
    `SELECT * FROM (${baseSelect} WHERE u.id_usuario = ?) AS t LIMIT 1`,
    {
      replacements: [id_usuario],
      type: db.QueryTypes.SELECT,
    },
  );
  const usuario = usuarioRows?.[0];

  if (!usuario) return next(new AppError('Usuario no encontrado', 404));

  const subusuarios = await db.query(
    `SELECT id_sub_usuario, usuario, email, nombre_encargado, rol, activar_cotizacion
       FROM sub_usuarios_chat_center
      WHERE id_usuario = ?
      ORDER BY id_sub_usuario ASC`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );

  const configuraciones = await db.query(
    `SELECT
        c.id,
        c.nombre_configuracion,
        c.telefono,
        c.tipo_configuracion,
        c.suspendido,
        c.suspended_at,
        c.created_at,
        c.updated_at,
        c.pais,
        c.sincronizo_coexistencia,

        /* Checklist (sin exponer el token) */
        CASE WHEN COALESCE(c.id_telefono,'') <> '' THEN 1 ELSE 0 END AS tiene_id_telefono,
        CASE WHEN COALESCE(c.id_whatsapp,'') <> '' THEN 1 ELSE 0 END AS tiene_id_whatsapp,
        CASE WHEN COALESCE(c.token,'')       <> '' THEN 1 ELSE 0 END AS tiene_token,
        CASE WHEN COALESCE(c.webhook_url,'') <> '' THEN 1 ELSE 0 END AS tiene_webhook,

        CASE
          WHEN c.suspendido = 0
           AND COALESCE(c.id_telefono,'') <> ''
           AND COALESCE(c.id_whatsapp,'') <> ''
           AND COALESCE(c.token,'')       <> ''
           AND COALESCE(c.webhook_url,'') <> ''
          THEN 1 ELSE 0
        END AS whatsapp_conectado,

        CASE
          WHEN COALESCE(c.api_key_openai,'') <> '' THEN 1 ELSE 0
        END AS tiene_agente_ia
       FROM configuraciones c
      WHERE c.id_usuario = ?
      ORDER BY c.id DESC`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );

  return res.json({
    status: 'success',
    data: {
      usuario,
      subusuarios,
      configuraciones,
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   EXPORTAR XLSX
   ══════════════════════════════════════════════════════════════ */

exports.exportarUsuariosAdmin = catchAsync(async (req, res, next) => {
  const { where, replacements } = construirFiltros(req.body || {});
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const semaforoFiltro =
    req.body?.semaforo && SEMAFOROS_VALIDOS.includes(req.body.semaforo)
      ? req.body.semaforo
      : null;

  const baseSelect = buildBaseSelect();

  const sql = `
    SELECT * FROM (
      ${baseSelect}
      ${whereSql}
    ) AS t
    ${semaforoFiltro ? 'WHERE t.semaforo = ?' : ''}
    ORDER BY t.fecha_registro DESC
    LIMIT 10000
  `;

  const reps = [...replacements];
  if (semaforoFiltro) reps.push(semaforoFiltro);

  const rows = await db.query(sql, {
    replacements: reps,
    type: db.QueryTypes.SELECT,
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ImporChat Admin';
  wb.created = new Date();

  const ws = wb.addWorksheet('Usuarios');

  ws.columns = [
    { header: 'ID', key: 'id_usuario', width: 8 },
    { header: 'Empresa', key: 'empresa', width: 30 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Teléfono principal', key: 'telefono_principal', width: 16 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Semáforo', key: 'semaforo', width: 10 },
    { header: 'Plan', key: 'nombre_plan', width: 22 },
    { header: 'Producto', key: 'tools_access', width: 14 },
    { header: 'Precio plan', key: 'precio_plan', width: 12 },
    { header: 'Tipo plan', key: 'tipo_plan', width: 14 },
    { header: 'Permanente', key: 'permanente', width: 10 },
    { header: 'Fecha inicio', key: 'fecha_inicio', width: 18 },
    { header: 'Fecha renovación', key: 'fecha_renovacion', width: 18 },
    { header: 'Días p/ vencer', key: 'dias_hasta_vencimiento', width: 10 },
    { header: 'Stripe status', key: 'stripe_subscription_status', width: 16 },
    { header: 'Cancel at period end', key: 'cancel_at_period_end', width: 10 },
    { header: 'Subusuarios', key: 'total_subusuarios', width: 10 },
    {
      header: 'Conexiones activas',
      key: 'total_conexiones_activas',
      width: 10,
    },
    { header: 'WhatsApp conectados', key: 'total_whatsapp_activos', width: 10 },
    { header: 'Agentes IA', key: 'total_agentes_ia', width: 10 },
    { header: 'Últ. mensaje', key: 'ultimo_mensaje', width: 20 },
    { header: 'Fecha registro', key: 'fecha_registro', width: 20 },
  ];

  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0B1426' },
  };

  rows.forEach((r) => ws.addRow(r));

  const colores = {
    verde: 'FFD1FAE5',
    amarillo: 'FFFEF3C7',
    rojo: 'FFFECACA',
    gris: 'FFE5E7EB',
  };
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const sem = row.getCell('semaforo').value;
    if (colores[sem]) {
      row.getCell('semaforo').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: colores[sem] },
      };
    }
  });

  const buffer = await wb.xlsx.writeBuffer();

  const fecha = new Date().toISOString().split('T')[0];
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="usuarios_admin_${fecha}.xlsx"`,
  );

  return res.send(Buffer.from(buffer));
});

/* ══════════════════════════════════════════════════════════════
   KPIs
   ══════════════════════════════════════════════════════════════ */

exports.kpisUsuariosAdmin = catchAsync(async (req, res, next) => {
  const rows = await db.query(
    `
    SELECT
      COUNT(*) AS total_usuarios,

      SUM(CASE WHEN estado = 'activo'      THEN 1 ELSE 0 END) AS total_activos,
      SUM(CASE WHEN estado = 'inactivo'    THEN 1 ELSE 0 END) AS total_inactivos,
      SUM(CASE WHEN estado = 'suspendido'  THEN 1 ELSE 0 END) AS total_suspendidos,
      SUM(CASE WHEN estado = 'vencido'     THEN 1 ELSE 0 END) AS total_vencidos,
      SUM(CASE WHEN estado = 'cancelado'   THEN 1 ELSE 0 END) AS total_cancelados,
      SUM(CASE WHEN estado = 'trial_usage' THEN 1 ELSE 0 END) AS total_trial,
      SUM(CASE WHEN estado = 'promo_usage' THEN 1 ELSE 0 END) AS total_promo,

      SUM(CASE
            WHEN estado = 'activo'
             AND fecha_renovacion IS NOT NULL
             AND DATEDIFF(fecha_renovacion, NOW()) BETWEEN 0 AND 7
            THEN 1 ELSE 0 END)                                AS por_vencer_7d,

      SUM(CASE WHEN cancel_at_period_end = 1 THEN 1 ELSE 0 END) AS cancelaciones_programadas,

      SUM(CASE
            WHEN created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
            THEN 1 ELSE 0 END)                                AS nuevos_ultimos_30d,

      SUM(CASE WHEN permanente = 1 THEN 1 ELSE 0 END)         AS total_permanentes

    FROM usuarios_chat_center
    `,
    { type: db.QueryTypes.SELECT },
  );

  return res.json({ status: 'success', data: rows?.[0] || {} });
});
