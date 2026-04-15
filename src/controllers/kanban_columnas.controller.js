// controllers/kanban_columnas.controller.js
// CRUD de columnas Kanban por configuración
// ─────────────────────────────────────────────────────────────

const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const {
  syncCatalogoKanbanColumna,
} = require('../services/syncCatalogoKanbanColumna.service');

// ─── Helpers ──────────────────────────────────────────────────

/** Devuelve todas las columnas activas de una configuración ordenadas */
async function getColumnas(id_configuracion) {
  return db.query(
    `SELECT id, nombre, estado_db, color_fondo, color_texto, icono, orden,
        activo, es_estado_final, es_principal, activa_ia, max_tokens,
        assistant_id, vector_store_id, catalog_file_id, catalog_synced_at
     FROM kanban_columnas
     WHERE id_configuracion = ?
     ORDER BY orden ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

// ─── Listar columnas ──────────────────────────────────────────
// POST /kanban_columnas/listar
exports.listarColumnas = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const columnas = await getColumnas(id_configuracion);

  return res.status(200).json({ success: true, data: columnas });
});

// ─── Crear columna ────────────────────────────────────────────
// POST /kanban_columnas/crear
exports.crearColumna = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    nombre,
    estado_db,
    color_fondo = '#e3f2fd',
    color_texto = '#1a237e',
    icono = null,
    es_estado_final = 0,
  } = req.body;

  if (!id_configuracion || !nombre || !estado_db)
    return next(new AppError('Faltan campos obligatorios', 400));

  // Sanitizar estado_db → lowercase snake_case
  const estado_db_clean = estado_db.trim().toLowerCase().replace(/\s+/g, '_');

  // Verificar duplicado
  const [dup] = await db.query(
    `SELECT id FROM kanban_columnas
     WHERE id_configuracion = ? AND estado_db = ?`,
    {
      replacements: [id_configuracion, estado_db_clean],
      type: db.QueryTypes.SELECT,
    },
  );
  if (dup)
    return next(new AppError('Ya existe una columna con ese estado_db', 409));

  // Obtener el máximo orden actual
  const [{ maxOrden }] = await db.query(
    `SELECT COALESCE(MAX(orden), 0) AS maxOrden
     FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const [id] = await db.query(
    `INSERT INTO kanban_columnas
       (id_configuracion, nombre, estado_db, color_fondo, color_texto, icono, orden, es_estado_final)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        nombre.trim(),
        estado_db_clean,
        color_fondo,
        color_texto,
        icono,
        maxOrden + 1,
        es_estado_final ? 1 : 0,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(201).json({ success: true, id, data: columnas });
});

// ─── Actualizar columna ───────────────────────────────────────
// POST /kanban_columnas/actualizar
exports.actualizarColumna = catchAsync(async (req, res, next) => {
  const {
    id,
    id_configuracion,
    nombre,
    estado_db,
    color_fondo,
    color_texto,
    icono,
    activo,
    es_estado_final,
  } = req.body;

  if (!id || !id_configuracion)
    return next(new AppError('Faltan campos obligatorios', 400));

  const sets = [];
  const params = [];

  if (nombre !== undefined) {
    sets.push('nombre = ?');
    params.push(nombre.trim());
  }
  if (estado_db !== undefined) {
    const clean = estado_db.trim().toLowerCase().replace(/\s+/g, '_');
    sets.push('estado_db = ?');
    params.push(clean);
  }
  if (color_fondo !== undefined) {
    sets.push('color_fondo = ?');
    params.push(color_fondo);
  }
  if (color_texto !== undefined) {
    sets.push('color_texto = ?');
    params.push(color_texto);
  }
  if (icono !== undefined) {
    sets.push('icono = ?');
    params.push(icono);
  }
  if (activo !== undefined) {
    sets.push('activo = ?');
    params.push(activo ? 1 : 0);
  }
  if (es_estado_final !== undefined) {
    sets.push('es_estado_final = ?');
    params.push(es_estado_final ? 1 : 0);
  }

  if (!sets.length)
    return next(new AppError('No se enviaron campos para actualizar', 400));

  await db.query(
    `UPDATE kanban_columnas SET ${sets.join(', ')}
     WHERE id = ? AND id_configuracion = ?`,
    {
      replacements: [...params, id, id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

// ─── Eliminar columna ─────────────────────────────────────────
// POST /kanban_columnas/eliminar
exports.eliminarColumna = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  await db.query(
    `DELETE FROM kanban_columnas WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.DELETE },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

// ─── Reordenar columnas ───────────────────────────────────────
// POST /kanban_columnas/reordenar
// Body: { id_configuracion, orden: [{ id, orden }] }
exports.reordenarColumnas = catchAsync(async (req, res, next) => {
  const { id_configuracion, orden } = req.body;

  if (!id_configuracion || !Array.isArray(orden) || !orden.length)
    return next(new AppError('Faltan datos para reordenar', 400));

  // Actualizar en batch (una query por fila — simple y seguro)
  await Promise.all(
    orden.map(({ id, orden: o }) =>
      db.query(
        `UPDATE kanban_columnas SET orden = ?
         WHERE id = ? AND id_configuracion = ?`,
        { replacements: [o, id, id_configuracion], type: db.QueryTypes.UPDATE },
      ),
    ),
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

// ─── Obtener columna por id ───────────────────────────────────
// POST /kanban_columnas/obtener
exports.obtenerColumna = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  const [columna] = await db.query(
    `SELECT * FROM kanban_columnas WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columna) return next(new AppError('Columna no encontrada', 404));
  return res.status(200).json({ success: true, data: columna });
});

// ── sync_catalogo ─────────────────────────────────────────────
exports.syncCatalogo = catchAsync(async (req, res, next) => {
  const { id_kanban_columna } = req.body;
  if (!id_kanban_columna)
    return next(new AppError('Falta id_kanban_columna', 400));

  const resultado = await syncCatalogoKanbanColumna(id_kanban_columna);

  if (resultado.skipped) {
    return res
      .status(200)
      .json({ success: true, skipped: true, message: resultado.reason });
  }

  return res.status(200).json({
    success: true,
    vector_store_id: resultado.vector_store_id,
    catalog_file_id: resultado.catalog_file_id,
    total_items: resultado.total_items,
  });
});

exports.sincronizarCatalogo = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  // Marcar como procesando ANTES de responder
  await db.query(
    `UPDATE kanban_columnas SET sync_status = 'procesando', sync_at = NOW() WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE },
  );

  // Responder inmediatamente
  res.status(200).json({ success: true, procesando: true });

  // Procesar en background
  setImmediate(async () => {
    try {
      await syncCatalogoKanbanColumna(id, {
        logger: async (msg) => console.log(`[sync_catalogo] ${msg}`),
      });
      await db.query(
        `UPDATE kanban_columnas SET sync_status = 'completado', sync_at = NOW() WHERE id = ?`,
        { replacements: [id], type: db.QueryTypes.UPDATE },
      );
      console.log(`[sync_catalogo] ✅ Completado columna id=${id}`);
    } catch (err) {
      await db.query(
        `UPDATE kanban_columnas SET sync_status = 'error', sync_at = NOW() WHERE id = ?`,
        { replacements: [id], type: db.QueryTypes.UPDATE },
      );
      console.error(`[sync_catalogo] ❌ Error: ${err.message}`);
    }
  });
});

exports.syncStatus = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  const [col] = await db.query(
    `SELECT sync_status, sync_at FROM kanban_columnas WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  return res.json({ success: true, data: col });
});

exports.marcarPrincipal = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion)
    return next(new AppError('Faltan id e id_configuracion', 400));

  // Desmarcar todas las columnas de esta configuración
  await db.query(
    `UPDATE kanban_columnas SET es_principal = 0 WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  // Marcar solo la seleccionada
  await db.query(
    `UPDATE kanban_columnas SET es_principal = 1 WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});

exports.quitarPrincipal = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  await db.query(
    `UPDATE kanban_columnas SET es_principal = 0 WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const columnas = await getColumnas(id_configuracion);
  return res.status(200).json({ success: true, data: columnas });
});
