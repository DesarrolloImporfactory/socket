const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

function toMySQLDateTime(input) {
  if (!input) return null;
  try {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   GET /seguimientos/:id_usuario
   Historial completo + evidencias agrupadas
   ══════════════════════════════════════════════════════════════ */
exports.listar = catchAsync(async (req, res, next) => {
  const id_usuario = parseInt(req.params.id_usuario, 10);
  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));

  const seguimientos = await db.query(
    `SELECT *
       FROM seguimiento_clientes_chat_center
      WHERE id_usuario = ?
      ORDER BY fecha_seguimiento DESC, id_seguimiento DESC`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );

  if (seguimientos.length === 0) {
    return res.json({ status: 'success', data: [] });
  }

  const ids = seguimientos.map((s) => s.id_seguimiento);
  const evidencias = await db.query(
    `SELECT * FROM seguimiento_evidencias_chat_center
      WHERE id_seguimiento IN (:ids)
      ORDER BY id_evidencia ASC`,
    { replacements: { ids }, type: db.QueryTypes.SELECT },
  );

  const evByMaster = {};
  evidencias.forEach((e) => {
    (evByMaster[e.id_seguimiento] = evByMaster[e.id_seguimiento] || []).push(e);
  });

  const data = seguimientos.map((s) => ({
    ...s,
    evidencias: evByMaster[s.id_seguimiento] || [],
  }));

  res.json({ status: 'success', data });
});

/* ══════════════════════════════════════════════════════════════
   POST /seguimientos
   body: {
     id_usuario, tipo, resultado, asunto, contenido,
     motivo_cancelacion, motivo_cancelacion_detalle,
     fecha_seguimiento (opcional), proximo_contacto (opcional),
     evidencias: [{url, tipo, nombre_archivo, mime_type, tamano_bytes}, ...]
   }
   ══════════════════════════════════════════════════════════════ */
exports.crear = catchAsync(async (req, res, next) => {
  const {
    id_usuario,
    tipo = 'nota_interna',
    resultado = 'sin_resultado',
    asunto = null,
    contenido,
    motivo_cancelacion = null,
    motivo_cancelacion_detalle = null,
    fecha_seguimiento = null,
    proximo_contacto = null,
    evidencias = [],
  } = req.body || {};

  if (!id_usuario) return next(new AppError('id_usuario requerido', 400));
  if (!contenido || !contenido.trim())
    return next(new AppError('El contenido del seguimiento es requerido', 400));

  // Validación para cancelación/retención
  if (tipo === 'cancelacion' || tipo === 'retencion') {
    if (!motivo_cancelacion) {
      return next(
        new AppError(
          'Para cancelación/retención debes seleccionar un motivo',
          400,
        ),
      );
    }
    if (!motivo_cancelacion_detalle || !motivo_cancelacion_detalle.trim()) {
      return next(
        new AppError(
          'Para cancelación/retención debes agregar un detalle del motivo',
          400,
        ),
      );
    }
  }

  const fecha_seguimiento_sql = toMySQLDateTime(fecha_seguimiento);
  // Quien lo registra (del session/middleware protect)
  const ejecutado_por_id = req.sessionUser?.id_sub_usuario || null;
  const ejecutado_por_nombre =
    req.sessionUser?.nombre_encargado || req.sessionUser?.usuario || null;

  // INSERT seguimiento
  const [result] = await db.query(
    `
    INSERT INTO seguimiento_clientes_chat_center
      (id_usuario, tipo, resultado, asunto, contenido,
       motivo_cancelacion, motivo_cancelacion_detalle,
       ejecutado_por_id, ejecutado_por_nombre,
       fecha_seguimiento, proximo_contacto)
    VALUES (?,?,?,?,?,?,?,?,?,COALESCE(?, NOW()),?)
    `,
    {
      replacements: [
        id_usuario,
        tipo,
        resultado,
        asunto,
        contenido,
        motivo_cancelacion,
        motivo_cancelacion_detalle,
        ejecutado_por_id,
        ejecutado_por_nombre,
        fecha_seguimiento_sql,
        proximo_contacto,
      ],
    },
  );

  const id_seguimiento = result;

  // INSERT evidencias
  if (Array.isArray(evidencias) && evidencias.length > 0) {
    const values = evidencias.map((e) => [
      id_seguimiento,
      e.url,
      e.tipo || 'file',
      e.nombre_archivo || null,
      e.mime_type || null,
      e.tamano_bytes || null,
    ]);
    await db.query(
      `INSERT INTO seguimiento_evidencias_chat_center
        (id_seguimiento, url, tipo, nombre_archivo, mime_type, tamano_bytes)
       VALUES ${values.map(() => '(?,?,?,?,?,?)').join(',')}`,
      { replacements: values.flat() },
    );
  }

  res.json({ status: 'success', id_seguimiento });
});

/* ══════════════════════════════════════════════════════════════
   PUT /seguimientos/:id_seguimiento
   ══════════════════════════════════════════════════════════════ */
exports.editar = catchAsync(async (req, res, next) => {
  const id_seguimiento = parseInt(req.params.id_seguimiento, 10);
  if (!id_seguimiento) return next(new AppError('id requerido', 400));

  // Validación para cancelación/retención
  if (req.body.tipo === 'cancelacion' || req.body.tipo === 'retencion') {
    if (!req.body.motivo_cancelacion) {
      return next(
        new AppError(
          'Para cancelación/retención debes seleccionar un motivo',
          400,
        ),
      );
    }
    if (
      !req.body.motivo_cancelacion_detalle ||
      !req.body.motivo_cancelacion_detalle.trim()
    ) {
      return next(
        new AppError(
          'Para cancelación/retención debes agregar un detalle del motivo',
          400,
        ),
      );
    }
  }

  const campos = [
    'tipo',
    'resultado',
    'asunto',
    'contenido',
    'motivo_cancelacion',
    'motivo_cancelacion_detalle',
    'fecha_seguimiento',
    'proximo_contacto',
  ];

  const sets = [];
  const reps = [];

  campos.forEach((k) => {
    if (req.body[k] !== undefined) {
      sets.push(`${k} = ?`);
      reps.push(
        k === 'fecha_seguimiento' ? toMySQLDateTime(req.body[k]) : req.body[k],
      );
    }
  });

  let updateMeta = null;
  if (sets.length > 0) {
    reps.push(id_seguimiento);
    const [, meta] = await db.query(
      `UPDATE seguimiento_clientes_chat_center
          SET ${sets.join(', ')}
        WHERE id_seguimiento = ?`,
      { replacements: reps },
    );
    updateMeta = meta;
    console.log('[editar] UPDATE meta:', meta);
    console.log('[editar] SQL ejecutado:', `SET ${sets.join(', ')}`);
  }

  let evidenciasAgregadas = 0;
  if (
    Array.isArray(req.body.evidencias_nuevas) &&
    req.body.evidencias_nuevas.length > 0
  ) {
    const values = req.body.evidencias_nuevas.map((e) => [
      id_seguimiento,
      e.url,
      e.tipo || 'file',
      e.nombre_archivo || null,
      e.mime_type || null,
      e.tamano_bytes || null,
    ]);
    await db.query(
      `INSERT INTO seguimiento_evidencias_chat_center
        (id_seguimiento, url, tipo, nombre_archivo, mime_type, tamano_bytes)
       VALUES ${values.map(() => '(?,?,?,?,?,?)').join(',')}`,
      { replacements: values.flat() },
    );
    evidenciasAgregadas = values.length;
  }

  res.json({
    status: 'success',
    campos_intentados: sets.length,
    affected_rows: updateMeta?.affectedRows ?? updateMeta ?? 0,
    changed_rows: updateMeta?.changedRows ?? null,
    evidencias_agregadas: evidenciasAgregadas,
  });
});

/* ══════════════════════════════════════════════════════════════
   DELETE /seguimientos/:id_seguimiento
   ══════════════════════════════════════════════════════════════ */
exports.eliminar = catchAsync(async (req, res, next) => {
  const id = parseInt(req.params.id_seguimiento, 10);
  if (!id) return next(new AppError('id requerido', 400));
  await db.query(
    `DELETE FROM seguimiento_clientes_chat_center WHERE id_seguimiento = ?`,
    { replacements: [id] },
  );
  res.json({ status: 'success' });
});

/* ══════════════════════════════════════════════════════════════
   DELETE /seguimientos/evidencia/:id_evidencia
   ══════════════════════════════════════════════════════════════ */
exports.eliminarEvidencia = catchAsync(async (req, res, next) => {
  const id = parseInt(req.params.id_evidencia, 10);
  if (!id) return next(new AppError('id requerido', 400));
  await db.query(
    `DELETE FROM seguimiento_evidencias_chat_center WHERE id_evidencia = ?`,
    { replacements: [id] },
  );
  res.json({ status: 'success' });
});

/* ══════════════════════════════════════════════════════════════
   GET /seguimientos/proximos
   Lista de próximos contactos agendados (recordatorio)
   ══════════════════════════════════════════════════════════════ */
exports.proximos = catchAsync(async (req, res) => {
  const rows = await db.query(
    `
    SELECT
      s.id_seguimiento,
      s.id_usuario,
      s.proximo_contacto,
      s.asunto,
      s.tipo,
      u.nombre AS empresa,
      u.email_propietario AS email,
      DATEDIFF(s.proximo_contacto, CURDATE()) AS dias
    FROM seguimiento_clientes_chat_center s
    INNER JOIN usuarios_chat_center u ON u.id_usuario = s.id_usuario
    WHERE s.proximo_contacto IS NOT NULL
      AND s.proximo_contacto >= CURDATE()
    ORDER BY s.proximo_contacto ASC
    LIMIT 50
    `,
    { type: db.QueryTypes.SELECT },
  );
  res.json({ status: 'success', data: rows });
});
