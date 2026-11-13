const ExcelJS = require('exceljs');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const Stripe = require('stripe');
const accesoPermanente = require('../services/acceso_permanente.service');

// Misma selección de llave que stripe.controller: live en producción, test en
// local. Cancelar una suscripción live desde local falla (no existe en test);
// para eso está scripts/darAccesoPermanente.js, que exige la live.
const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY || ''
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET
  ? new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' })
  : null;

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

  // Cancelación programada AÚN SALVABLE: pidió irse pero todavía no se va.
  // Es la lista de trabajo real del asesor de retención — distinta de
  // cancel_at_period_end a secas, que incluye a los que ya se fueron.
  if (isTrue(body.cancelacion_programada)) {
    where.push(`
      u.cancel_at_period_end = 1
      AND (u.cancel_at IS NULL OR u.cancel_at > NOW())
      AND u.estado NOT IN ('cancelado')
    `);
  }

  // Sin WhatsApp personal registrado: para campañas de completar el dato.
  if (isTrue(body.sin_whatsapp_personal)) {
    where.push(`(u.whatsapp_lead IS NULL OR TRIM(u.whatsapp_lead) = '')`);
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

  // Con seguimientos: clientes con al menos un registro de seguimiento
  if (isTrue(body.con_seguimientos)) {
    where.push(`EXISTS (
      SELECT 1 FROM seguimiento_clientes_chat_center sg
       WHERE sg.id_usuario = u.id_usuario
    )`);
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

      /* ── WhatsApp PERSONAL del dueño (el del registro) ──
         Ojo: NO confundir con telefono_principal, que es el número de
         WhatsApp Business de la conexión. Para llamar a un cliente que se
         está yendo, el que sirve es este. Se captura en el alta
         (auth.controller) y es obligatorio desde entonces; los usuarios
         antiguos lo tienen vacío. */
      u.whatsapp_lead,
      u.whatsapp_lead_pais,
      CASE
        WHEN COALESCE(TRIM(u.whatsapp_lead),'') = '' THEN NULL
        ELSE CONCAT(
          COALESCE(NULLIF(TRIM(u.whatsapp_lead_pais),''), '+593'),
          REGEXP_REPLACE(TRIM(u.whatsapp_lead), '^0+', '')
        )
      END AS whatsapp_personal_e164,
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

      /* ── Seguimientos del cliente ── */
      (SELECT COUNT(*)
         FROM seguimiento_clientes_chat_center sg
        WHERE sg.id_usuario = u.id_usuario)                AS total_seguimientos,

      (SELECT MAX(sg.fecha_seguimiento)
         FROM seguimiento_clientes_chat_center sg
        WHERE sg.id_usuario = u.id_usuario)                AS ultimo_seguimiento,
     
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

      /* ── Cancelación programada ──
         El cliente ya pidió irse pero su suscripción SIGUE viva hasta
         cancel_at. Es la ventana en la que todavía se puede retener, y por
         eso se expone aparte: filtrar por stripe_status='canceled' llega
         tarde, cuando ya se fue. */
      CASE
        WHEN u.cancel_at_period_end = 1 AND u.cancel_at IS NOT NULL
          THEN DATEDIFF(u.cancel_at, NOW())
        ELSE NULL
      END AS dias_para_cancelar,

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
    // Urgencia de retención: los que cancelan primero, arriba.
    dias_para_cancelar: 'dias_para_cancelar',
    ultimo_seguimiento: 'ultimo_seguimiento',
  };
  const orderCol = ORDER_COLS[order_by] || 'fecha_registro';

  // MySQL pone los NULL primero al ordenar ASC. En las columnas donde NULL
  // significa "no aplica" (nunca contactado, sin cancelación programada) eso
  // llenaría la primera página de filas irrelevantes, justo lo contrario de
  // lo que busca el asesor.
  const nullsLast = ['dias_para_cancelar', 'ultimo_seguimiento'].includes(
    orderCol,
  )
    ? `t.${orderCol} IS NULL,`
    : '';

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
    ORDER BY ${nullsLast} t.${orderCol} ${order_dir}
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

  usuario.imporkiller = await leerImporKiller(id_usuario);

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
    // El personal del dueño: es con el que se le llama, no el de la conexión.
    { header: 'WhatsApp personal', key: 'whatsapp_personal_e164', width: 18 },
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
    { header: 'Días p/ cancelar', key: 'dias_para_cancelar', width: 12 },
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
    { header: 'Total seguimientos', key: 'total_seguimientos', width: 12 },
    { header: 'Últ. seguimiento', key: 'ultimo_seguimiento', width: 20 },
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

/* ══════════════════════════════════════════════════════════════
   MÉTRICAS DE GESTIÓN (para los gráficos del asesor)

   Mide el trabajo de retención sobre seguimiento_clientes_chat_center.
   IMPORTANTE al leer estos números: miden lo que se REGISTRA, no
   necesariamente lo que se hace. Un asesor que llama y no anota aparece
   igual que uno que no llama. Antes de usarlos para evaluar a alguien hay
   que acordar que todo contacto se registra.
   ══════════════════════════════════════════════════════════════ */

exports.metricasGestionAdmin = catchAsync(async (req, res, next) => {
  const meses = Math.min(Math.max(Number(req.query?.meses) || 6, 1), 24);

  /* 1. Evolución mensual: volumen y efectividad del contacto */
  const evolucion = await db.query(
    `SELECT DATE_FORMAT(fecha_seguimiento, '%Y-%m')            AS mes,
            COUNT(*)                                           AS total,
            SUM(resultado = 'contactado_exitoso')              AS contactados,
            SUM(resultado = 'no_contesto')                     AS no_contesto,
            SUM(resultado = 'numero_invalido')                 AS numero_invalido,
            SUM(resultado IN ('retenido','convertido'))        AS recuperados,
            SUM(resultado = 'cancelado')                       AS perdidos,
            COUNT(DISTINCT id_usuario)                         AS clientes_tocados
       FROM seguimiento_clientes_chat_center
      WHERE fecha_seguimiento >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      GROUP BY 1
      ORDER BY 1 ASC`,
    { replacements: [meses], type: db.QueryTypes.SELECT },
  );

  /* 2. Embudo de resultados */
  const embudo = await db.query(
    `SELECT resultado, COUNT(*) AS total
       FROM seguimiento_clientes_chat_center
      WHERE fecha_seguimiento >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      GROUP BY 1
      ORDER BY total DESC`,
    { replacements: [meses], type: db.QueryTypes.SELECT },
  );

  /* 3. Por canal usado */
  const canales = await db.query(
    `SELECT tipo, COUNT(*) AS total
       FROM seguimiento_clientes_chat_center
      WHERE fecha_seguimiento >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      GROUP BY 1
      ORDER BY total DESC`,
    { replacements: [meses], type: db.QueryTypes.SELECT },
  );

  /* 4. Desempeño por asesor. `vencidos` = compromisos de próximo contacto
     que ya pasaron sin registrar nada después: es la métrica que delata
     seguimiento abandonado, más que el volumen. */
  const asesores = await db.query(
    `SELECT sg.ejecutado_por_nombre                            AS asesor,
            COUNT(*)                                           AS seguimientos,
            COUNT(DISTINCT sg.id_usuario)                      AS clientes,
            SUM(sg.resultado = 'contactado_exitoso')           AS contactados,
            SUM(sg.resultado IN ('retenido','convertido'))     AS recuperados,
            SUM(sg.proximo_contacto IS NOT NULL
                AND sg.proximo_contacto < CURDATE())           AS compromisos_vencidos,
            MAX(sg.fecha_seguimiento)                          AS ultimo
       FROM seguimiento_clientes_chat_center sg
      WHERE sg.fecha_seguimiento >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      GROUP BY 1
      ORDER BY seguimientos DESC`,
    { replacements: [meses], type: db.QueryTypes.SELECT },
  );

  /* 5. Motivos de cancelación */
  const motivos = await db.query(
    `SELECT COALESCE(NULLIF(TRIM(motivo_cancelacion),''), 'Sin motivo') AS motivo,
            COUNT(*) AS total
       FROM seguimiento_clientes_chat_center
      WHERE motivo_cancelacion IS NOT NULL AND TRIM(motivo_cancelacion) <> ''
        AND fecha_seguimiento >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      GROUP BY 1
      ORDER BY total DESC
      LIMIT 10`,
    { replacements: [meses], type: db.QueryTypes.SELECT },
  );

  /* 6. Cobertura: de los que se están yendo, ¿a cuántos se contactó?
     Es la pregunta que de verdad importa — no cuántas llamadas se hicieron,
     sino si se atendió a los que estaban en riesgo. */
  const [cobertura] = await db.query(
    `SELECT
        COUNT(*) AS en_riesgo,
        SUM(EXISTS (
          SELECT 1 FROM seguimiento_clientes_chat_center sg
           WHERE sg.id_usuario = u.id_usuario
             AND sg.fecha_seguimiento >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        )) AS contactados_30d
       FROM usuarios_chat_center u
      WHERE u.cancel_at_period_end = 1
        AND (u.cancel_at IS NULL OR u.cancel_at > NOW())
        AND u.estado <> 'cancelado'`,
    { type: db.QueryTypes.SELECT },
  );

  /* 7. Agenda: compromisos de contacto pendientes */
  const [agenda] = await db.query(
    `SELECT
        SUM(proximo_contacto < CURDATE())                      AS vencidos,
        SUM(proximo_contacto = CURDATE())                      AS hoy,
        SUM(proximo_contacto BETWEEN DATE_ADD(CURDATE(), INTERVAL 1 DAY)
                                 AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)) AS proximos_7d
       FROM seguimiento_clientes_chat_center
      WHERE proximo_contacto IS NOT NULL`,
    { type: db.QueryTypes.SELECT },
  );

  return res.json({
    status: 'success',
    data: {
      meses,
      evolucion,
      embudo,
      canales,
      asesores,
      motivos,
      cobertura: cobertura || { en_riesgo: 0, contactados_30d: 0 },
      agenda: agenda || { vencidos: 0, hoy: 0, proximos_7d: 0 },
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   ACCESO PERMANENTE Y COMPLEMENTOS (solo super_administrador)

   Lo que antes se hacía a mano con SQL sobre usuarios_chat_center para las
   cuentas del equipo y las cortesías (Imporfactory Pro, la 10 de Eve…).
   La lógica del permanente (y la cancelación en Stripe) vive en
   services/acceso_permanente.service.js, compartida con
   scripts/darAccesoPermanente.js. imporkiller = 1 abre la extensión y los
   anuncios sin pasar por Stripe (una cuenta permanente ya lo tiene).
   ══════════════════════════════════════════════════════════════ */

const MAX_ADICIONALES = 999;

/** La columna imporkiller no está en el modelo (ver usuarios_chat_center.model). */
async function leerImporKiller(id_usuario) {
  try {
    const [[r]] = await db.query(
      `SELECT imporkiller FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
      { replacements: [id_usuario] },
    );
    return Number(r?.imporkiller || 0);
  } catch (e) {
    return 0;
  }
}

async function leerUsuarioAdmin(id_usuario) {
  const rows = await db.query(
    `SELECT * FROM (${buildBaseSelect()} WHERE u.id_usuario = ?) AS t LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  const usuario = rows?.[0] || null;
  if (usuario) usuario.imporkiller = await leerImporKiller(id_usuario);
  return usuario;
}

/** Quién ejecuta, para la nota de Seguimientos y el log. */
async function nombreDelEjecutor(req) {
  const id_sub = req.sessionUser?.id_sub_usuario;
  const rows = id_sub
    ? await db.query(
        `SELECT nombre_encargado, usuario FROM sub_usuarios_chat_center
          WHERE id_sub_usuario = ? LIMIT 1`,
        { replacements: [id_sub], type: db.QueryTypes.SELECT },
      )
    : [];
  const s = rows?.[0];
  return {
    id: id_sub || null,
    nombre: s?.nombre_encargado || s?.usuario || `subusuario ${id_sub}`,
  };
}

const errorAHttp = (e, next) =>
  next(e?.statusCode ? new AppError(e.message, e.statusCode) : e);

/**
 * POST /admin_usuarios/acceso_permanente
 * body: { id_usuario, activar: true|false, id_plan?, cancelar_stripe? }
 *
 * activar=true  → permanente = 1, estado activo y el plan elegido (o el que
 *                 ya tiene, o Avanzado). Sirve también para cambiar el plan
 *                 de una cuenta ya permanente. Con cancelar_stripe se cancela
 *                 YA la suscripción viva en Stripe (sin más cobros).
 * activar=false → permanente = 0 y vuelven las reglas normales.
 */
exports.accesoPermanenteAdmin = catchAsync(async (req, res, next) => {
  const id_usuario = parseInt(req.body?.id_usuario, 10);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  const activar = isTrue(req.body?.activar);
  const ejecutor = await nombreDelEjecutor(req);

  let asunto;
  let stripeInfo = null;
  let stripe_error = null;
  try {
    if (activar) {
      const r = await accesoPermanente.activarAccesoPermanente({
        id_usuario,
        id_plan: parseInt(req.body?.id_plan, 10) || null,
        cancelar_stripe: isTrue(req.body?.cancelar_stripe),
        stripe,
        ejecutor,
      });
      asunto = r.asunto;
      stripeInfo = r.stripe;
      stripe_error = r.stripe_error;
      if (stripe_error && stripe && !STRIPE_SECRET.startsWith('sk_live_')) {
        stripe_error +=
          ' (este servidor usa la llave de prueba de Stripe; la suscripción vive en live: usa scripts/darAccesoPermanente.js)';
      }
    } else {
      const r = await accesoPermanente.quitarAccesoPermanente({
        id_usuario,
        ejecutor,
      });
      asunto = r.asunto;
    }
  } catch (e) {
    return errorAHttp(e, next);
  }

  const message = stripe_error
    ? `${asunto}, pero no se pudo cancelar en Stripe: ${stripe_error}`
    : stripeInfo?.cancelada
      ? `${asunto}. Suscripción de Stripe cancelada: no se le cobra más`
      : asunto;

  return res.json({
    status: 'success',
    message,
    data: {
      usuario: await leerUsuarioAdmin(id_usuario),
      stripe: stripeInfo,
      stripe_error,
    },
  });
});

/**
 * POST /admin_usuarios/suscripcion_cortesia
 * body: { id_usuario, id_plan, meses }
 *
 * Crea en Stripe una suscripción real al plan con `meses` de prueba (gratis)
 * y cobro mensual después, con la misma metadata que el checkout para que el
 * webhook la lleve como cualquier otra. Cancela la sub viva anterior y anula
 * las facturas abiertas del customer. Si Stripe falla no se toca la BD.
 */
exports.suscripcionCortesiaAdmin = catchAsync(async (req, res, next) => {
  const id_usuario = parseInt(req.body?.id_usuario, 10);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  const id_plan = parseInt(req.body?.id_plan, 10);
  if (!id_plan) return next(new AppError('id_plan requerido', 400));

  const ejecutor = await nombreDelEjecutor(req);
  let r;
  try {
    r = await accesoPermanente.crearSuscripcionCortesia({
      stripe,
      id_usuario,
      id_plan,
      meses: req.body?.meses,
      ejecutor,
    });
  } catch (e) {
    if (e?.statusCode) return next(new AppError(e.message, e.statusCode));
    let msg = `Stripe: ${e?.message || e}`;
    if (stripe && !STRIPE_SECRET.startsWith('sk_live_')) {
      msg +=
        ' (este servidor usa la llave de prueba de Stripe; el cliente vive en live: usa scripts/darMesesGratis.js)';
    }
    return next(new AppError(msg, 502));
  }

  return res.json({
    status: 'success',
    message: `${r.asunto}. Suscripción ${r.sub.id} creada; cobra desde el ${r.trial_end.toISOString().slice(0, 10)}`,
    data: { usuario: await leerUsuarioAdmin(id_usuario), cortesia: r },
  });
});

/**
 * POST /admin_usuarios/complementos
 * body: { id_usuario, conexiones_adicionales?, subusuarios_adicionales?, imporkiller? }
 *
 * Fija (no suma) los cupos extra y el complemento ImporKiller sin pasar por
 * Stripe. Solo se tocan los campos que vienen en el body.
 */
exports.complementosAdmin = catchAsync(async (req, res, next) => {
  const id_usuario = parseInt(req.body?.id_usuario, 10);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));

  const antes = await leerUsuarioAdmin(id_usuario);
  if (!antes) return next(new AppError('Usuario no encontrado', 404));

  const leerCupo = (v, campo) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 0 || n > MAX_ADICIONALES) {
      throw new AppError(
        `${campo} debe ser un entero entre 0 y ${MAX_ADICIONALES}`,
        400,
      );
    }
    return n;
  };

  const body = req.body || {};
  const conexiones = leerCupo(
    body.conexiones_adicionales,
    'conexiones_adicionales',
  );
  const subusuarios = leerCupo(
    body.subusuarios_adicionales,
    'subusuarios_adicionales',
  );
  const imporkiller =
    body.imporkiller === undefined || body.imporkiller === null
      ? undefined
      : isTrue(body.imporkiller)
        ? 1
        : 0;

  if (
    conexiones === undefined &&
    subusuarios === undefined &&
    imporkiller === undefined
  ) {
    return next(
      new AppError('No se envió ningún complemento para cambiar', 400),
    );
  }

  const sets = [];
  const reps = [];
  const cambios = [];

  if (conexiones !== undefined) {
    sets.push('conexiones_adicionales = ?');
    reps.push(conexiones);
    if (conexiones !== Number(antes.conexiones_adicionales || 0)) {
      cambios.push(
        `conexiones adicionales ${Number(antes.conexiones_adicionales || 0)} → ${conexiones}`,
      );
    }
  }
  if (subusuarios !== undefined) {
    sets.push('subusuarios_adicionales = ?');
    reps.push(subusuarios);
    if (subusuarios !== Number(antes.subusuarios_adicionales || 0)) {
      cambios.push(
        `usuarios adicionales ${Number(antes.subusuarios_adicionales || 0)} → ${subusuarios}`,
      );
    }
  }
  if (sets.length) {
    sets.push('updated_at = NOW()');
    await db.query(
      `UPDATE usuarios_chat_center SET ${sets.join(', ')} WHERE id_usuario = ?`,
      { replacements: [...reps, id_usuario] },
    );
  }

  if (imporkiller !== undefined) {
    try {
      await db.query(
        `UPDATE usuarios_chat_center SET imporkiller = ?, updated_at = NOW()
          WHERE id_usuario = ?`,
        { replacements: [imporkiller, id_usuario] },
      );
      if (imporkiller !== Number(antes.imporkiller || 0)) {
        cambios.push(`ImporKiller ${imporkiller ? 'activado' : 'desactivado'}`);
      }
    } catch (e) {
      return next(
        new AppError(
          'No se pudo guardar ImporKiller: falta la columna imporkiller en la BD',
          500,
        ),
      );
    }
  }

  if (cambios.length) {
    const ejecutor = await nombreDelEjecutor(req);
    const contenido = `${ejecutor.nombre} ajustó complementos a mano: ${cambios.join(', ')}.`;
    await accesoPermanente.anotarSeguimiento(
      id_usuario,
      ejecutor,
      'Complementos ajustados',
      contenido,
    );
    console.log(`[admin_usuarios] ${contenido} (cuenta ${id_usuario})`);
  }

  return res.json({
    status: 'success',
    message: cambios.length ? 'Complementos guardados' : 'Sin cambios',
    data: { usuario: await leerUsuarioAdmin(id_usuario) },
  });
});

/* ══════════════════════════════════════════════════════════════
   COMBOS (solo super_administrador)

   Productos vendidos por fuera de la plataforma que traen meses gratis de un
   plan y complementos (Combo Implementación: $297, 6 meses de ImporChat e
   ImporKiller). Se activan por correo: la cuenta puede existir o no. Toda la
   lógica vive en services/combos.service.js.
   ══════════════════════════════════════════════════════════════ */

const combos = require('../services/combos.service');

const paramsCombo = (body = {}) => ({
  stripe,
  email: body.email,
  id_usuario: parseInt(body.id_usuario, 10) || null,
  clave: body.clave || undefined,
  id_plan: parseInt(body.id_plan, 10) || null,
  meses: body.meses,
  desde: body.desde === 'sumar' ? 'sumar' : 'hoy',
});

const errorDeCombo = (e, next) => {
  if (e?.statusCode) return next(new AppError(e.message, e.statusCode));
  let msg = `Stripe: ${e?.message || e}`;
  if (stripe && !STRIPE_SECRET.startsWith('sk_live_')) {
    msg +=
      ' (este servidor usa la llave de prueba de Stripe; los clientes viven en live)';
  }
  return next(new AppError(msg, 502));
};

/** GET /admin_usuarios/combos → catálogo y combos otorgados. */
exports.combosListarAdmin = catchAsync(async (req, res) => {
  const planes = await db.query(
    `SELECT id_plan, nombre_plan, precio_plan
       FROM planes_chat_center
      WHERE activo = 1 AND id_price IS NOT NULL
        AND nombre_plan NOT LIKE '%TEST%'
      ORDER BY precio_plan, id_plan`,
    { type: db.QueryTypes.SELECT },
  );
  return res.json({
    status: 'success',
    data: {
      catalogo: combos.catalogo(),
      planes,
      otorgados: await combos.listarCombos({ limite: req.query?.limite }),
    },
  });
});

/** POST /admin_usuarios/combos/previa → qué pasaría, sin escribir nada. */
exports.combosPreviaAdmin = catchAsync(async (req, res, next) => {
  try {
    const data = await combos.prepararCombo(paramsCombo(req.body));
    return res.json({ status: 'success', data });
  } catch (e) {
    return errorDeCombo(e, next);
  }
});

/** POST /admin_usuarios/combos/otorgar → activa el combo. */
exports.combosOtorgarAdmin = catchAsync(async (req, res, next) => {
  const ejecutor = await nombreDelEjecutor(req);
  try {
    const data = await combos.otorgarCombo({
      ...paramsCombo(req.body),
      ejecutor,
      repetir: isTrue(req.body?.repetir),
      nota: req.body?.nota,
    });
    return res.json({ status: 'success', message: data.mensaje, data });
  } catch (e) {
    return errorDeCombo(e, next);
  }
});

/** POST /admin_usuarios/combos/anular → anula uno que aún no se aplicó. */
exports.combosAnularAdmin = catchAsync(async (req, res, next) => {
  const id = parseInt(req.body?.id, 10);
  if (!id) return next(new AppError('id requerido', 400));
  const ejecutor = await nombreDelEjecutor(req);
  try {
    const data = await combos.anularCombo({ id, ejecutor });
    return res.json({ status: 'success', message: 'Combo anulado', data });
  } catch (e) {
    return errorDeCombo(e, next);
  }
});
