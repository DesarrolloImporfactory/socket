// controllers/etiquetas_custom_chat_center.controller.js
const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

// ─────────────────────────────────────────────
// 1) Listar opciones (asesor | ciclo | ambos)
// GET /etiquetas-custom/listar?tipo=asesor&id_configuracion=123
// GET /etiquetas-custom/listar?id_configuracion=123  ← trae ambos
// ─────────────────────────────────────────────
exports.listar = catchAsync(async (req, res, next) => {
  const { tipo, id_configuracion } = req.query;

  if (!id_configuracion) {
    return next(new AppError('Falta id_configuracion', 400));
  }

  // tipo es opcional — si viene, debe ser válido
  if (tipo && !['asesor', 'ciclo'].includes(tipo)) {
    return next(new AppError('tipo debe ser "asesor" o "ciclo"', 400));
  }

  const whereTipo = tipo ? 'AND tipo = :tipo' : '';

  const rows = await db.query(
    `SELECT id, tipo, nombre
       FROM etiquetas_custom_chat_center
      WHERE id_configuracion = :id_configuracion
        ${whereTipo}
        AND deleted_at IS NULL
      ORDER BY tipo ASC, nombre ASC`,
    {
      replacements: { id_configuracion, ...(tipo ? { tipo } : {}) },
      type: QueryTypes.SELECT,
    },
  );

  res.status(200).json({ status: 200, data: rows });
});

// ─────────────────────────────────────────────
// 2) Crear nueva opción
// POST /etiquetas-custom/crear  { tipo, nombre, id_configuracion }
// ─────────────────────────────────────────────
exports.crear = catchAsync(async (req, res, next) => {
  const { tipo, nombre, id_configuracion } = req.body;

  if (!id_configuracion) {
    return next(new AppError('Falta id_configuracion', 400));
  }
  if (!['asesor', 'ciclo'].includes(tipo)) {
    return next(new AppError('tipo debe ser "asesor" o "ciclo"', 400));
  }
  if (!nombre || !nombre.trim()) {
    return next(new AppError('El nombre es obligatorio', 400));
  }

  const trimmed = nombre.trim();

  // Verificar si ya existe (activa)
  const [existing] = await db.query(
    `SELECT id FROM etiquetas_custom_chat_center
      WHERE id_configuracion = :id_configuracion
        AND tipo = :tipo
        AND nombre = :nombre
        AND deleted_at IS NULL
      LIMIT 1`,
    {
      replacements: { id_configuracion, tipo, nombre: trimmed },
      type: QueryTypes.SELECT,
    },
  );

  if (existing) {
    return res.status(200).json({
      status: 200,
      message: 'Ya existe esta opción',
      data: { id: existing.id, nombre: trimmed },
    });
  }

  // Verificar si existe soft-deleted → reactivar
  const [softDeleted] = await db.query(
    `SELECT id FROM etiquetas_custom_chat_center
      WHERE id_configuracion = :id_configuracion
        AND tipo = :tipo
        AND nombre = :nombre
        AND deleted_at IS NOT NULL
      LIMIT 1`,
    {
      replacements: { id_configuracion, tipo, nombre: trimmed },
      type: QueryTypes.SELECT,
    },
  );

  if (softDeleted) {
    await db.query(
      `UPDATE etiquetas_custom_chat_center SET deleted_at = NULL WHERE id = :id`,
      { replacements: { id: softDeleted.id }, type: QueryTypes.UPDATE },
    );

    return res.status(201).json({
      status: 201,
      message: 'Opción reactivada',
      data: { id: softDeleted.id, nombre: trimmed },
    });
  }

  // Insertar nueva
  const [insertId] = await db.query(
    `INSERT INTO etiquetas_custom_chat_center (id_configuracion, tipo, nombre)
     VALUES (:id_configuracion, :tipo, :nombre)`,
    {
      replacements: { id_configuracion, tipo, nombre: trimmed },
      type: QueryTypes.INSERT,
    },
  );

  res.status(201).json({
    status: 201,
    message: 'Opción creada',
    data: { id: insertId, nombre: trimmed },
  });
});

// ─────────────────────────────────────────────
// 3) Eliminar opción (soft delete)
// DELETE /etiquetas-custom/eliminar/:id?id_configuracion=123
// ─────────────────────────────────────────────
exports.eliminar = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { id_configuracion } = req.query;

  if (!id_configuracion) {
    return next(new AppError('Falta id_configuracion', 400));
  }

  const [row] = await db.query(
    `SELECT id, tipo FROM etiquetas_custom_chat_center
      WHERE id = :id AND id_configuracion = :id_configuracion AND deleted_at IS NULL
      LIMIT 1`,
    {
      replacements: { id, id_configuracion },
      type: QueryTypes.SELECT,
    },
  );

  if (!row) {
    return next(new AppError('Opción no encontrada', 404));
  }

  // Soft delete
  await db.query(
    `UPDATE etiquetas_custom_chat_center SET deleted_at = NOW() WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.UPDATE },
  );

  // Limpiar referencia en clientes que tenían esta opción asignada
  const column =
    row.tipo === 'asesor' ? 'id_etiqueta_asesor' : 'id_etiqueta_ciclo';

  await db.query(
    `UPDATE clientes_chat_center SET ${column} = NULL WHERE ${column} = :id`,
    { replacements: { id }, type: QueryTypes.UPDATE },
  );

  res.status(200).json({ status: 200, message: 'Opción eliminada' });
});

// ─────────────────────────────────────────────
// 4) Asignar etiqueta a un cliente
// POST /etiquetas-custom/asignar  { id_cliente, tipo, id_etiqueta }
//   id_etiqueta = null → desasignar
// ─────────────────────────────────────────────
exports.asignar = catchAsync(async (req, res, next) => {
  const { id_cliente, tipo, id_etiqueta } = req.body;

  if (!id_cliente) {
    return next(new AppError('id_cliente es obligatorio', 400));
  }
  if (!['asesor', 'ciclo'].includes(tipo)) {
    return next(new AppError('tipo debe ser "asesor" o "ciclo"', 400));
  }

  const column = tipo === 'asesor' ? 'id_etiqueta_asesor' : 'id_etiqueta_ciclo';

  await db.query(
    `UPDATE clientes_chat_center SET ${column} = :id_etiqueta WHERE id = :id_cliente`,
    {
      replacements: { id_etiqueta: id_etiqueta || null, id_cliente },
      type: QueryTypes.UPDATE,
    },
  );

  res.status(200).json({
    status: 200,
    message: `Etiqueta ${tipo} ${id_etiqueta ? 'asignada' : 'removida'}`,
  });
});

// ─────────────────────────────────────────────
// 5) Obtener etiquetas asignadas a un cliente
// GET /etiquetas-custom/cliente/:id_cliente
// ─────────────────────────────────────────────
exports.obtenerPorCliente = catchAsync(async (req, res, next) => {
  const { id_cliente } = req.params;

  const [row] = await db.query(
    `SELECT
       c.id_etiqueta_asesor,
       ea.nombre AS nombre_asesor,
       c.id_etiqueta_ciclo,
       ec.nombre AS nombre_ciclo
     FROM clientes_chat_center c
     LEFT JOIN etiquetas_custom_chat_center ea
       ON ea.id = c.id_etiqueta_asesor AND ea.deleted_at IS NULL
     LEFT JOIN etiquetas_custom_chat_center ec
       ON ec.id = c.id_etiqueta_ciclo AND ec.deleted_at IS NULL
     WHERE c.id = :id_cliente
     LIMIT 1`,
    {
      replacements: { id_cliente },
      type: QueryTypes.SELECT,
    },
  );

  res.status(200).json({
    status: 200,
    data: row || {
      id_etiqueta_asesor: null,
      nombre_asesor: null,
      id_etiqueta_ciclo: null,
      nombre_ciclo: null,
    },
  });
});
