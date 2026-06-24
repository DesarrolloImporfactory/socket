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

// Catálogo Kanban (fuente única de verdad, compartida con el controller normal)
const {
  KANBAN_TEMPLATES_META,
  KANBAN_RESPUESTAS_RAPIDAS,
  DROPI_CONFIG_POR_DEFECTO,
  REMARKETING_POR_DEFECTO,
} = require('../utils/kanban_catalogo.data');

const {
  TIPOS_VALIDOS,
  getTemplatesMetaMerged,
  getRespuestasRapidasMerged,
  getDropiConfigMerged,
  getRemarketingMerged,
  getTemplateLookups,
} = require('../utils/kanban_catalogo.provider');

const {
  uploadToUploader,
  validateMetaMediaOrThrow,
  inferHeaderFormatFromMime,
} = require('../utils/whatsappTemplate.helpers');

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
 *                   instrucciones, modelo, acciones: [...] } ],
 *     setup: { ... } }  ← opcional, ver normalizarSetup
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

/**
 * Normaliza el bloque "setup" de la plantilla (automatizaciones).
 *
 * Master toggles (bool): qué bloques se aplican al cliente.
 *   - templates_meta · dropi_config · remarketing · respuestas_rapidas
 *   - Default true (retrocompatible: plantillas viejas sin setup → todo).
 *
 * Selección granular (array | null): qué ítems exactos crear de cada bloque.
 *   - *_items: array de keys, o null = "todos los del catálogo".
 *   - Se preserva tal cual venga del front; el controller que aplica
 *     (aplicarGlobal) decide con _resolverSetup.
 *
 * Si el front NO manda setup, devuelve todo true / null = comportamiento
 * histórico (se crea todo).
 */
function normalizarSetup(setup) {
  const s = setup || {};
  const arr = (v) => (Array.isArray(v) ? v : null);
  return {
    // Master toggles por bloque
    templates_meta: s.templates_meta !== false,
    dropi_config: s.dropi_config !== false,
    remarketing: s.remarketing !== false,
    respuestas_rapidas: s.respuestas_rapidas !== false,
    // Selección granular por ítem (null = todos)
    templates_meta_items: arr(s.templates_meta_items),
    respuestas_rapidas_items: arr(s.respuestas_rapidas_items),
    remarketing_items: arr(s.remarketing_items),
    dropi_config_items: arr(s.dropi_config_items),
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
      data, // ← objeto completo con columnas, acciones y setup
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

  // Normalizar columnas + setup (automatizaciones)
  const dataNormalizada = {
    columnas: dataObj.columnas.map((c, i) => normalizarColumna(c, i)),
    setup: normalizarSetup(dataObj.setup),
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
// ACTUALIZAR DATA (admin) — reemplaza el JSON de columnas/acciones/setup
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
    setup: normalizarSetup(dataObj.setup),
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

exports.catalogoSetup = catchAsync(async (req, res) => {
  const preview = (txt, n = 90) => {
    const limpio = String(txt || '')
      .replace(/\s+/g, ' ')
      .trim();
    return limpio.length > n ? `${limpio.slice(0, n)}…` : limpio;
  };

  const [
    templatesMerged,
    rapidasMerged,
    dropiMerged,
    remarketingMerged,
    { bodyByName },
  ] = await Promise.all([
    getTemplatesMetaMerged(),
    getRespuestasRapidasMerged(),
    getDropiConfigMerged(),
    getRemarketingMerged(),
    getTemplateLookups(),
  ]);

  const findBody = (name) => bodyByName.get(name) || null;

  // ── Plantillas Meta ──
  const templates_meta = templatesMerged.map((t) => {
    const header = t.components.find((c) => c.type === 'HEADER');
    const body = t.components.find((c) => c.type === 'BODY');
    const botonesComp = t.components.find((c) => c.type === 'BUTTONS');
    const esHeaderMedia =
      header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format);
    return {
      key: t.name,
      label: t.name,
      categoria: t.category,
      language: t.language,
      formato_header: header ? (esHeaderMedia ? header.format : 'TEXT') : null,
      header_media_url: esHeaderMedia
        ? header?.example?.header_handle?.[0] || null
        : null,
      header_texto: header && !esHeaderMedia ? header.text || null : null,
      body: body?.text || null,
      body_ejemplo: body?.example?.body_text?.[0] || null,
      preview: preview(body?.text),
      botones: (botonesComp?.buttons || []).map((b) => ({
        tipo: b.type,
        texto: b.text,
        url: b.url || null,
        ejemplo: Array.isArray(b.example) ? b.example[0] : b.example || null,
      })),
      custom: !!t._custom,
      custom_id: t._catalogo_id || null,
    };
  });

  // ── Respuestas rápidas ──
  const respuestas_rapidas = rapidasMerged.map((r) => ({
    key: r.atajo,
    label: r.atajo,
    tipo: r.tipo_mensaje || 'text',
    mensaje: r.mensaje || '',
    preview: preview(r.mensaje),
    media_url: r.ruta_archivo || null,
    file_name: r.file_name || null,
    custom: !!r._custom,
    custom_id: r._catalogo_id || null,
  }));

  // ── Remarketing ──
  const remarketing = [];
  for (const grupo of remarketingMerged) {
    for (const sec of grupo.secuencias) {
      remarketing.push({
        key: sec.nombre_template,
        label: `Secuencia ${sec.secuencia}`,
        estado_contacto: grupo.estado_contacto,
        secuencia: sec.secuencia,
        tiempo_espera_horas: sec.tiempo_espera_horas,
        estado_destino: sec.estado_destino || null,
        header_format: sec.header_format || null,
        metodo: sec.metodo_dentro_24h || 'ia',
        template_fuera_24h: sec.nombre_template,
        template_fuera_24h_body: findBody(sec.nombre_template),
        prompt_ia: sec.prompt_ia || null,
        depende_template_meta: sec.nombre_template,
        preview: preview(sec.prompt_ia, 110),
        custom: !!sec._custom,
        custom_id: sec._catalogo_id || null,
      });
    }
  }

  // ── Config Dropi ──
  const dropi_config = dropiMerged.map((d) => ({
    key: d.estado_dropi,
    label: d.estado_dropi,
    template: d.nombre_template,
    template_body: d.body_text || findBody(d.nombre_template),
    columna_destino: d.columna_destino || null,
    usar_respuesta_rapida: !!d.usar_respuesta_rapida,
    mensaje_rapido: d.mensaje_rapido || null,
    parametros: d.parametros || null,
    depende_template_meta: d.nombre_template,
    preview: preview(d.mensaje_rapido || findBody(d.nombre_template)),
    custom: !!d._custom,
    custom_id: d._catalogo_id || null,
  }));

  return res.json({
    success: true,
    data: { templates_meta, respuestas_rapidas, remarketing, dropi_config },
  });
});

// ════════════════════════════════════════════════════════════════
// (3) CRUD DE ITEMS DE CATÁLOGO (setup custom)
//     El super admin agrega/edita/elimina qué puede contener un tablero.
//     item_key se DERIVA del data (no lo manda el front).
// ════════════════════════════════════════════════════════════════

// Deriva la clave única del item según su tipo.
function _deriveItemKey(tipo, data) {
  const d = data || {};
  if (tipo === 'templates_meta') return d.name || null;
  if (tipo === 'respuestas_rapidas') return d.atajo || null;
  if (tipo === 'remarketing') return d.nombre_template || null;
  if (tipo === 'dropi_config') return d.estado_dropi || null;
  return null;
}

// Valida la forma mínima del data según el tipo. Devuelve array de errores.
function _validarCatalogoItem(tipo, data) {
  const errores = [];
  const d = data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return ['data debe ser un objeto'];
  }
  switch (tipo) {
    case 'templates_meta':
      if (!d.name || typeof d.name !== 'string')
        errores.push('data.name es obligatorio');
      else if (!/^[a-z0-9_]+$/.test(d.name))
        errores.push(
          'data.name solo minúsculas, números y _ (regla de nombre de Meta)',
        );
      if (!d.language) errores.push('data.language es obligatorio (ej: es)');
      if (!d.category)
        errores.push('data.category es obligatorio (ej: MARKETING / UTILITY)');
      if (!Array.isArray(d.components) || d.components.length === 0)
        errores.push('data.components debe ser un array no vacío');
      break;
    case 'respuestas_rapidas':
      if (!d.atajo || typeof d.atajo !== 'string')
        errores.push('data.atajo es obligatorio');
      if (!d.mensaje && !d.ruta_archivo)
        errores.push('data.mensaje (o ruta_archivo para media) es obligatorio');
      break;
    case 'remarketing':
      if (!d.estado_contacto)
        errores.push('data.estado_contacto es obligatorio');
      if (!d.nombre_template)
        errores.push('data.nombre_template es obligatorio');
      if (d.tiempo_espera_horas == null || isNaN(Number(d.tiempo_espera_horas)))
        errores.push('data.tiempo_espera_horas es obligatorio (número)');
      break;
    case 'dropi_config':
      if (!d.estado_dropi) errores.push('data.estado_dropi es obligatorio');
      if (!d.nombre_template && !d.usar_respuesta_rapida)
        errores.push(
          'data.nombre_template es obligatorio (o usar_respuesta_rapida + mensaje_rapido)',
        );
      break;
    default:
      errores.push(`tipo inválido: ${tipo}`);
  }
  return errores;
}

// ── LISTAR items custom (gestión admin) ──
// POST /kanban_plantillas_admin/catalogo_item_listar
// Body: { tipo?, incluir_inactivos? }
exports.catalogoItemListar = catchAsync(async (req, res, next) => {
  const { tipo, incluir_inactivos = false } = req.body || {};
  if (tipo && !TIPOS_VALIDOS.includes(tipo))
    return next(new AppError(`tipo inválido: ${tipo}`, 400));

  const where = [];
  const repl = [];
  if (tipo) {
    where.push('tipo = ?');
    repl.push(tipo);
  }
  if (!incluir_inactivos) where.push('activo = 1');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await db.query(
    `SELECT id, tipo, item_key, data, activo, created_at, updated_at
     FROM kanban_catalogo_items
     ${whereSql}
     ORDER BY tipo ASC, id DESC`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  return res.json({
    success: true,
    data: rows.map((r) => ({
      ...r,
      activo: !!r.activo,
      data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
    })),
  });
});

// ── CREAR item custom ──
// POST /kanban_plantillas_admin/catalogo_item_crear
// Body: { tipo, data }
exports.catalogoItemCrear = catchAsync(async (req, res, next) => {
  const { tipo, data } = req.body || {};
  if (!TIPOS_VALIDOS.includes(tipo))
    return next(
      new AppError(
        `tipo inválido. Debe ser uno de: ${TIPOS_VALIDOS.join(', ')}`,
        400,
      ),
    );

  const dataObj = typeof data === 'string' ? JSON.parse(data) : data;
  const errores = _validarCatalogoItem(tipo, dataObj);
  if (errores.length)
    return next(new AppError(`data inválido: ${errores.join('; ')}`, 400));

  const item_key = _deriveItemKey(tipo, dataObj);
  if (!item_key)
    return next(new AppError('No se pudo derivar item_key del data', 400));

  try {
    const [insertId] = await db.query(
      `INSERT INTO kanban_catalogo_items (tipo, item_key, data, activo)
       VALUES (?, ?, ?, 1)`,
      {
        replacements: [tipo, item_key, JSON.stringify(dataObj)],
        type: db.QueryTypes.INSERT,
      },
    );
    return res.json({
      success: true,
      message: 'Item de catálogo creado',
      id: insertId,
      tipo,
      item_key,
    });
  } catch (err) {
    if (err?.parent?.code === 'ER_DUP_ENTRY') {
      return next(
        new AppError(
          `Ya existe un item "${item_key}" en ${tipo}. Edítalo en vez de crear uno nuevo.`,
          409,
        ),
      );
    }
    throw err;
  }
});

// ── ACTUALIZAR item custom (data y/o activo) ──
// POST /kanban_plantillas_admin/catalogo_item_actualizar
// Body: { id, data?, activo? }
exports.catalogoItemActualizar = catchAsync(async (req, res, next) => {
  const { id, data, activo } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  const [existe] = await db.query(
    `SELECT id, tipo FROM kanban_catalogo_items WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!existe) return next(new AppError('Item no encontrado', 404));

  const sets = [];
  const repl = [];

  if (data !== undefined) {
    const dataObj = typeof data === 'string' ? JSON.parse(data) : data;
    const errores = _validarCatalogoItem(existe.tipo, dataObj);
    if (errores.length)
      return next(new AppError(`data inválido: ${errores.join('; ')}`, 400));
    const item_key = _deriveItemKey(existe.tipo, dataObj);
    if (!item_key)
      return next(new AppError('No se pudo derivar item_key del data', 400));
    sets.push('item_key = ?');
    repl.push(item_key);
    sets.push('data = ?');
    repl.push(JSON.stringify(dataObj));
  }
  if (activo !== undefined) {
    sets.push('activo = ?');
    repl.push(activo ? 1 : 0);
  }
  if (!sets.length)
    return next(new AppError('No se enviaron campos para actualizar', 400));

  repl.push(id);
  try {
    await db.query(
      `UPDATE kanban_catalogo_items SET ${sets.join(', ')} WHERE id = ?`,
      { replacements: repl, type: db.QueryTypes.UPDATE },
    );
  } catch (err) {
    if (err?.parent?.code === 'ER_DUP_ENTRY') {
      return next(
        new AppError(
          'Esa clave ya existe en este tipo (colisión de UNIQUE tipo+item_key).',
          409,
        ),
      );
    }
    throw err;
  }

  return res.json({ success: true, message: 'Item de catálogo actualizado' });
});

// ── ELIMINAR item custom (hard delete: es solo una definición) ──
// POST /kanban_plantillas_admin/catalogo_item_eliminar
// Body: { id }
exports.catalogoItemEliminar = catchAsync(async (req, res, next) => {
  const { id } = req.body || {};
  if (!id) return next(new AppError('Falta id', 400));

  await db.query(`DELETE FROM kanban_catalogo_items WHERE id = ?`, {
    replacements: [id],
    type: db.QueryTypes.DELETE,
  });

  return res.json({ success: true, message: 'Item de catálogo eliminado' });
});

// POST /kanban_plantillas_admin/catalogo_subir_media
// multipart/form-data, campo "file"
// body: { modo: 'respuesta_rapida' | 'template', format?: IMAGE|VIDEO|AUDIO|DOCUMENT }
exports.catalogoSubirMedia = catchAsync(async (req, res, next) => {
  if (!req.file)
    return next(new AppError('Falta el archivo (campo file)', 400));

  const modo = req.body?.modo || 'respuesta_rapida';
  const format =
    (req.body?.format && String(req.body.format).toUpperCase()) ||
    inferHeaderFormatFromMime(req.file.mimetype);

  // Respuestas rápidas: el archivo viaja tal cual por WhatsApp → validar peso/MIME.
  // Templates: Meta re-transcodifica → no validamos (solo el tope de multer).
  if (modo === 'respuesta_rapida') {
    try {
      validateMetaMediaOrThrow({ file: req.file, format });
    } catch (err) {
      return next(new AppError(err.message, err.statusCode || 400));
    }
  }

  const folder =
    modo === 'template'
      ? 'catalogo/templates/header'
      : 'catalogo/respuestas_rapidas';

  let result;
  try {
    result = await uploadToUploader({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      folder,
    });
  } catch (err) {
    return next(
      new AppError(
        err.message || 'Error subiendo el archivo al uploader',
        err.statusCode || 502,
      ),
    );
  }

  return res.json({
    success: true,
    url: result.fileUrl,
    mime_type: req.file.mimetype || null,
    file_name: req.file.originalname || null,
    size: req.file.size || req.file.buffer?.length || null,
    format,
  });
});
