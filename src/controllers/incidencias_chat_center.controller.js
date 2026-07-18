const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

// Bitácora de incidencias por chat (contacto). La escriben los asesores que
// confirman órdenes: intentos de llamada, mensajes, etc. Cada uno solo puede
// borrar las suyas.

exports.listar = catchAsync(async (req, res, next) => {
  const id_cliente = Number(req.query.id_cliente || req.params.id_cliente);
  if (!id_cliente) return next(new AppError('Falta id_cliente', 400));

  const [rows] = await db.query(
    `SELECT id, id_sub_usuario, autor_nombre, descripcion, created_at
       FROM incidencias_chat_center
      WHERE id_cliente_chat_center = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    { replacements: [id_cliente] },
  );

  const yo = Number(req.sessionUser?.id_sub_usuario) || null;
  res.json({
    status: 'success',
    data: rows.map((r) => ({ ...r, propia: Number(r.id_sub_usuario) === yo })),
  });
});

exports.crear = catchAsync(async (req, res, next) => {
  const id_cliente = Number(req.body.id_cliente);
  const id_configuracion = Number(req.body.id_configuracion) || null;
  const descripcion = String(req.body.descripcion || '').trim();

  if (!id_cliente || !descripcion) {
    return next(new AppError('Falta id_cliente o descripción', 400));
  }

  const autor =
    req.sessionUser?.nombre_encargado ||
    req.sessionUser?.usuario ||
    req.sessionUser?.email ||
    'Asesor';
  const id_sub_usuario = req.sessionUser?.id_sub_usuario || null;

  // db.query de un INSERT devuelve [insertId, affectedRows]; el id es [0].
  const [insertId] = await db.query(
    `INSERT INTO incidencias_chat_center
       (id_cliente_chat_center, id_configuracion, id_sub_usuario, autor_nombre, descripcion, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    {
      replacements: [
        id_cliente,
        id_configuracion,
        id_sub_usuario,
        autor,
        descripcion.slice(0, 2000),
      ],
    },
  );

  res.status(201).json({
    status: 'success',
    data: {
      id: insertId,
      id_sub_usuario,
      autor_nombre: autor,
      descripcion: descripcion.slice(0, 2000),
      created_at: new Date(),
      propia: true,
    },
  });
});

exports.eliminar = catchAsync(async (req, res, next) => {
  const id = Number(req.params.id || req.body.id);
  if (!id) return next(new AppError('Falta id', 400));

  const [rows] = await db.query(
    `SELECT id_sub_usuario FROM incidencias_chat_center
      WHERE id = ? AND deleted_at IS NULL`,
    { replacements: [id] },
  );
  if (!rows.length) return next(new AppError('Incidencia no encontrada', 404));

  const yo = Number(req.sessionUser?.id_sub_usuario) || null;
  if (Number(rows[0].id_sub_usuario) !== yo) {
    return next(new AppError('Solo puedes borrar tus propias incidencias', 403));
  }

  await db.query(
    `UPDATE incidencias_chat_center SET deleted_at = NOW() WHERE id = ?`,
    { replacements: [id] },
  );
  res.json({ status: 'success' });
});
