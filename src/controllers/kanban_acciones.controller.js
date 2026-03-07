// ════════════════════════════════════════════════════════════
// kanban_acciones.controller.js
// ════════════════════════════════════════════════════════════
const AppError   = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { db }     = require('../database/config');

// ── listar ────────────────────────────────────────────────────
exports.listar = catchAsync(async (req, res, next) => {
  const { id_kanban_columna } = req.body;
  if (!id_kanban_columna) return next(new AppError('Falta id_kanban_columna', 400));

  const rows = await db.query(
    `SELECT id, tipo_accion, config, activo, orden
     FROM   kanban_acciones
     WHERE  id_kanban_columna = ? AND activo = 1
     ORDER  BY orden ASC`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  // Parsear config JSON
  const data = rows.map((r) => ({
    ...r,
    config: typeof r.config === 'string' ? JSON.parse(r.config || '{}') : (r.config || {}),
  }));

  return res.status(200).json({ success: true, data });
});

// ── crear ─────────────────────────────────────────────────────
exports.crear = catchAsync(async (req, res, next) => {
  const { id_kanban_columna, id_configuracion, tipo_accion, config = {}, orden = 0 } = req.body;
  if (!id_kanban_columna || !tipo_accion) return next(new AppError('Faltan campos obligatorios', 400));

  const TIPOS_VALIDOS = ['cambiar_estado','contexto_productos','contexto_calendario','enviar_media','agendar_cita','separador_productos'];
  if (!TIPOS_VALIDOS.includes(tipo_accion)) return next(new AppError(`tipo_accion inválido: ${tipo_accion}`, 400));

  const [result] = await db.query(
    `INSERT INTO kanban_acciones (id_kanban_columna, id_configuracion, tipo_accion, config, orden, activo)
     VALUES (?, ?, ?, ?, ?, 1)`,
    { replacements: [id_kanban_columna, id_configuracion, tipo_accion, JSON.stringify(config), orden], type: db.QueryTypes.INSERT },
  );

  return res.status(200).json({ success: true, id: result });
});

// ── actualizar ────────────────────────────────────────────────
exports.actualizar = catchAsync(async (req, res, next) => {
  const { id, config } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  await db.query(
    `UPDATE kanban_acciones SET config = ? WHERE id = ?`,
    { replacements: [JSON.stringify(config || {}), id], type: db.QueryTypes.UPDATE },
  );

  return res.status(200).json({ success: true });
});

// ── eliminar ──────────────────────────────────────────────────
exports.eliminar = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  await db.query(
    `UPDATE kanban_acciones SET activo = 0 WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE },
  );

  return res.status(200).json({ success: true });
});