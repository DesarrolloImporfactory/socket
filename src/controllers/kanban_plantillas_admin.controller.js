// controllers/kanban_plantillas_admin.controller.js
// CRUD completo de plantillas globales — solo super_administrador.
// Las rutas que usan este controller deben pasar por:
//   protect → requireSuperAdmin
// (definido en routes/kanban_plantillas_admin.routes.js)
//
// IMPORTANTE: Este controller NO depende de id_configuracion del cliente.
// Las plantillas globales son recursos compartidos entre todos los clientes,
// y solo el super admin puede crearlas/modificarlas/eliminarlas.

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Valida la estructura del campo "data" de una plantilla global.
 * Devuelve { valido: bool, errores: [] }.
 *
 * Estructura esperada:
 *   { columnas: [ { nombre, estado_db, color_fondo, color_texto, icono,
 *                   orden, activo, es_estado_final, es_principal,
 *                   es_dropi_principal, activa_ia, max_tokens,
 *                   instrucciones, modelo, acciones: [...] } ] }
 */
function validarDataPlantilla(data) {
  const errores = [];

  if (!data || typeof data !== 'object') {
    return { valido: false, errores: ['data debe ser un objeto'] };
  }
  if (!Array.isArray(data.columnas)) {
    return { valido: false, errores: ['data.columnas debe ser un array'] };
  }
  if (data.columnas.length === 0) {
    return { valido: false, errores: ['data.columnas no puede estar vacío'] };
  }

  // Validar cada columna
  const estadosDb = new Set();
  data.columnas.forEach((col, i) => {
    const prefix = `columna[${i}]`;

    if (!col.nombre || typeof col.nombre !== 'string') {
      errores.push(`${prefix}.nombre es obligatorio`);
    }
    if (!col.estado_db || typeof col.estado_db !== 'string') {
      errores.push(`${prefix}.estado_db es obligatorio`);
    } else if (!/^[a-z0-9_]+$/.test(col.estado_db)) {
      errores.push(
        `${prefix}.estado_db solo puede contener letras minúsculas, números y _`,
      );
    } else if (estadosDb.has(col.estado_db)) {
      errores.push(
        `${prefix}.estado_db duplicado: "${col.estado_db}" ya existe en otra columna`,
      );
    } else {
      estadosDb.add(col.estado_db);
    }

    if (col.acciones && !Array.isArray(col.acciones)) {
      errores.push(`${prefix}.acciones debe ser un array`);
    }
  });

  // Validar que solo haya UNA columna principal y UNA dropi_principal (o ninguna)
  const principales = data.columnas.filter((c) => c.es_principal).length;
  if (principales > 1) {
    errores.push('Solo puede haber una columna marcada como es_principal');
  }
  const dropiPrincipales = data.columnas.filter(
    (c) => c.es_dropi_principal,
  ).length;
  if (dropiPrincipales > 1) {
    errores.push(
      'Solo puede haber una columna marcada como es_dropi_principal',
    );
  }

  return { valido: errores.length === 0, errores };
}

/**
 * Normaliza una columna antes de guardarla en data.
 * Asegura tipos correctos y defaults.
 */
function normalizarColumna(col, indiceFallback) {
  return {
    nombre: String(col.nombre || '').trim(),
    estado_db: String(col.estado_db || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_'),
    color_fondo: col.color_fondo || '#EFF6FF',
    color_texto: col.color_texto || '#1D4ED8',
    icono: col.icono || 'bx bx-circle',
    orden: Number.isInteger(col.orden) ? col.orden : indiceFallback + 1,
    activo: col.activo === 0 || col.activo === false ? 0 : 1,
    es_estado_final: col.es_estado_final ? 1 : 0,
    es_principal: col.es_principal ? 1 : 0,
    es_dropi_principal: col.es_dropi_principal ? 1 : 0,
    activa_ia: col.activa_ia ? 1 : 0,
    max_tokens: Number.isInteger(col.max_tokens) ? col.max_tokens : 500,
    instrucciones: col.instrucciones || null,
    modelo: col.modelo || 'gpt-4o-mini',
    acciones: Array.isArray(col.acciones)
      ? col.acciones.map((a, j) => ({
          tipo_accion: String(a.tipo_accion || '').trim(),
          config: a.config || {},
          orden: Number.isInteger(a.orden) ? a.orden : j + 1,
        }))
      : [],
  };
}

// ═════════════════════════════════════════════════════════════
// LISTAR (admin) — incluye inactivas para gestión
// POST /kanban_plantillas_admin/listar
// ═════════════════════════════════════════════════════════════
exports.listar = catchAsync(async (req, res) => {
  const { incluir_inactivas = true } = req.body || {};

  const where = incluir_inactivas ? '' : 'WHERE activo = 1';

  const plantillas = await db.query(
    `SELECT id, nombre, descripcion, icono, color, activo,
            creado_por, created_at, updated_at,
            JSON_LENGTH(JSON_EXTRACT(data, '$.columnas')) AS total_columnas,
            data
     FROM kanban_plantillas_globales
     ${where}
     ORDER BY activo DESC, created_at DESC`,
    { type: db.QueryTypes.SELECT },
  );

  const resultado = plantillas.map((p) => {
    const parsed = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
    const cols = parsed?.columnas || [];

    return {
      id: p.id,
      nombre: p.nombre,
      descripcion: p.descripcion,
      icono: p.icono,
      color: p.color,
      activo: !!p.activo,
      creado_por: p.creado_por,
      created_at: p.created_at,
      updated_at: p.updated_at,
      total_columnas: p.total_columnas,
      columnas_ia: cols.filter((c) => c.activa_ia).length,
      columnas_preview: cols
        .slice()
        .sort((a, b) => (a.orden || 0) - (b.orden || 0))
        .map((c) => ({
          nombre: c.nombre,
          estado_db: c.estado_db,
          icono: c.icono,
          color_fondo: c.color_fondo,
          color_texto: c.color_texto,
          activa_ia: !!c.activa_ia,
          es_principal: !!c.es_principal,
          es_dropi_principal: !!c.es_dropi_principal,
        })),
    };
  });

  return res.json({ success: true, data: resultado });
});

// ═════════════════════════════════════════════════════════════
// OBTENER UNA (admin) — devuelve la plantilla COMPLETA con su data
// POST /kanban_plantillas_admin/obtener
// ═════════════════════════════════════════════════════════════
exports.obtener = catchAsync(async (req, res, next) => {
  const { id } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  const [p] = await db.query(
    `SELECT id, nombre, descripcion, icono, color, activo,
            creado_por, created_at, updated_at, data
     FROM kanban_plantillas_globales
     WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  if (!p) return next(new AppError('Plantilla no encontrada', 404));

  const data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;

  return res.json({
    success: true,
    data: {
      id: p.id,
      nombre: p.nombre,
      descripcion: p.descripcion,
      icono: p.icono,
      color: p.color,
      activo: !!p.activo,
      creado_por: p.creado_por,
      created_at: p.created_at,
      updated_at: p.updated_at,
      data, // ← objeto completo con columnas y sus acciones
    },
  });
});

// ═════════════════════════════════════════════════════════════
// CREAR (admin) — desde cero, recibiendo data completo
// POST /kanban_plantillas_admin/crear
// ═════════════════════════════════════════════════════════════
exports.crear = catchAsync(async (req, res, next) => {
  const {
    nombre,
    descripcion = null,
    icono = 'bx bx-layout',
    color = '#6366f1',
    data,
  } = req.body || {};

  if (!nombre || !nombre.trim())
    return next(new AppError('El nombre es obligatorio', 400));

  if (!data) return next(new AppError('El campo data es obligatorio', 400));

  const dataObj = typeof data === 'string' ? JSON.parse(data) : data;

  const validacion = validarDataPlantilla(dataObj);
  if (!validacion.valido) {
    return next(
      new AppError(`data inválido: ${validacion.errores.join('; ')}`, 400),
    );
  }

  // Normalizar columnas
  const dataNormalizada = {
    columnas: dataObj.columnas.map((c, i) => normalizarColumna(c, i)),
  };

  const id_creador = req.sessionUser?.id_sub_usuario || null;

  const [insertId] = await db.query(
    `INSERT INTO kanban_plantillas_globales
     (nombre, descripcion, icono, color, data, creado_por, activo)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    {
      replacements: [
        nombre.trim(),
        descripcion?.trim() || null,
        icono || 'bx bx-layout',
        color || '#6366f1',
        JSON.stringify(dataNormalizada),
        id_creador,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.json({
    success: true,
    message: 'Plantilla global creada',
    id: insertId,
  });
});

// ═════════════════════════════════════════════════════════════
// ACTUALIZAR METADATA (admin) — solo nombre/desc/icono/color
// POST /kanban_plantillas_admin/actualizar_metadata
// ═════════════════════════════════════════════════════════════
exports.actualizarMetadata = catchAsync(async (req, res, next) => {
  const { id, nombre, descripcion, icono, color } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  const sets = [];
  const params = [];

  if (nombre !== undefined) {
    if (!nombre.trim())
      return next(new AppError('El nombre no puede estar vacío', 400));
    sets.push('nombre = ?');
    params.push(nombre.trim());
  }
  if (descripcion !== undefined) {
    sets.push('descripcion = ?');
    params.push(descripcion?.trim() || null);
  }
  if (icono !== undefined) {
    sets.push('icono = ?');
    params.push(icono || 'bx bx-layout');
  }
  if (color !== undefined) {
    sets.push('color = ?');
    params.push(color || '#6366f1');
  }

  if (!sets.length)
    return next(new AppError('No se enviaron campos para actualizar', 400));

  params.push(id);

  await db.query(
    `UPDATE kanban_plantillas_globales SET ${sets.join(', ')} WHERE id = ?`,
    { replacements: params, type: db.QueryTypes.UPDATE },
  );

  return res.json({ success: true, message: 'Metadata actualizada' });
});

// ═════════════════════════════════════════════════════════════
// ACTUALIZAR DATA (admin) — reemplaza el JSON de columnas/acciones
// POST /kanban_plantillas_admin/actualizar_data
// ═════════════════════════════════════════════════════════════
exports.actualizarData = catchAsync(async (req, res, next) => {
  const { id, data } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));
  if (!data) return next(new AppError('Falta data', 400));

  const dataObj = typeof data === 'string' ? JSON.parse(data) : data;

  const validacion = validarDataPlantilla(dataObj);
  if (!validacion.valido) {
    return next(
      new AppError(`data inválido: ${validacion.errores.join('; ')}`, 400),
    );
  }

  const dataNormalizada = {
    columnas: dataObj.columnas.map((c, i) => normalizarColumna(c, i)),
  };

  // Verificar que existe
  const [existe] = await db.query(
    `SELECT id FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!existe) return next(new AppError('Plantilla no encontrada', 404));

  await db.query(
    `UPDATE kanban_plantillas_globales SET data = ? WHERE id = ?`,
    {
      replacements: [JSON.stringify(dataNormalizada), id],
      type: db.QueryTypes.UPDATE,
    },
  );

  return res.json({
    success: true,
    message: 'Data actualizada',
    total_columnas: dataNormalizada.columnas.length,
  });
});

// ═════════════════════════════════════════════════════════════
// ELIMINAR (admin) — soft delete (activo = 0)
// POST /kanban_plantillas_admin/eliminar
// ═════════════════════════════════════════════════════════════
exports.eliminar = catchAsync(async (req, res, next) => {
  const { id } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  await db.query(
    `UPDATE kanban_plantillas_globales SET activo = 0 WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE },
  );

  return res.json({ success: true, message: 'Plantilla desactivada' });
});

// ═════════════════════════════════════════════════════════════
// RESTAURAR (admin) — reactivar soft-deleted
// POST /kanban_plantillas_admin/restaurar
// ═════════════════════════════════════════════════════════════
exports.restaurar = catchAsync(async (req, res, next) => {
  const { id } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  await db.query(
    `UPDATE kanban_plantillas_globales SET activo = 1 WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE },
  );

  return res.json({ success: true, message: 'Plantilla restaurada' });
});

// ═════════════════════════════════════════════════════════════
// ELIMINAR DEFINITIVO (admin) — hard delete, solo si nunca se aplicó
// POST /kanban_plantillas_admin/eliminar_definitivo
// ═════════════════════════════════════════════════════════════
exports.eliminarDefinitivo = catchAsync(async (req, res, next) => {
  const { id } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  // Verificar que no haya configuraciones usando esta plantilla
  const [enUso] = await db.query(
    `SELECT COUNT(*) AS total FROM configuraciones WHERE kanban_global_id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  if (enUso.total > 0) {
    return next(
      new AppError(
        `No se puede eliminar: ${enUso.total} configuración(es) aún usan esta plantilla. Usa "eliminar" (soft delete) en su lugar.`,
        409,
      ),
    );
  }

  await db.query(`DELETE FROM kanban_plantillas_globales WHERE id = ?`, {
    replacements: [id],
    type: db.QueryTypes.DELETE,
  });

  return res.json({
    success: true,
    message: 'Plantilla eliminada permanentemente',
  });
});

// ═════════════════════════════════════════════════════════════
// DUPLICAR (admin) — clona una plantilla existente
// POST /kanban_plantillas_admin/duplicar
// ═════════════════════════════════════════════════════════════
exports.duplicar = catchAsync(async (req, res, next) => {
  const { id, nombre_nuevo } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  const [original] = await db.query(
    `SELECT nombre, descripcion, icono, color, data
     FROM kanban_plantillas_globales WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  if (!original) return next(new AppError('Plantilla no encontrada', 404));

  const id_creador = req.sessionUser?.id_sub_usuario || null;
  const nombreFinal = nombre_nuevo?.trim() || `${original.nombre} (copia)`;

  const [insertId] = await db.query(
    `INSERT INTO kanban_plantillas_globales
     (nombre, descripcion, icono, color, data, creado_por, activo)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    {
      replacements: [
        nombreFinal,
        original.descripcion,
        original.icono,
        original.color,
        typeof original.data === 'string'
          ? original.data
          : JSON.stringify(original.data),
        id_creador,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.json({
    success: true,
    message: 'Plantilla duplicada',
    id: insertId,
  });
});

// ═════════════════════════════════════════════════════════════
// ESTADÍSTICAS DE USO (admin) — cuántas configs usan cada plantilla
// POST /kanban_plantillas_admin/uso
// ═════════════════════════════════════════════════════════════
exports.uso = catchAsync(async (req, res, next) => {
  const { id } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  const configs = await db.query(
    `SELECT c.id, c.nombre_configuracion, c.telefono,
            c.kanban_global_activo, c.tipo_configuracion
     FROM configuraciones c
     WHERE c.kanban_global_id = ?
     ORDER BY c.id DESC
     LIMIT 200`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  return res.json({
    success: true,
    data: {
      total: configs.length,
      configuraciones: configs,
    },
  });
});
