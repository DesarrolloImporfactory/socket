// controllers/kanban_ia_v2.controller.js
// ─────────────────────────────────────────────────────────────
// V2 — Structured outputs por columna.
//
// Endpoints:
//   POST /kanban_ia_v2/config/listar     → ver columnas opt-in a V2
//   POST /kanban_ia_v2/config/obtener    → ver schema+accion_map de una columna
//   POST /kanban_ia_v2/config/guardar    → crear/actualizar config V2
//   POST /kanban_ia_v2/config/eliminar   → desactivar V2 en una columna
//   POST /kanban_ia_v2/config/usar_seed_sara
//                                        → cargar el schema seed de Sara
//                                          a una columna
//   POST /kanban_ia_v2/probar            → procesar un mensaje manual con V2
// ─────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs').promises;

const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const MensajeCliente = require('../models/mensaje_cliente.model');

const {
  procesarMensajeKanbanV2,
  cargarConfigV2,
} = require('../services/kanban_ia_v2.service');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function getApiKey(id_configuracion) {
  const [row] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row?.api_key_openai || null;
}

async function ensureColumnaPertenece(id_kanban_columna, id_configuracion) {
  const [col] = await db.query(
    `SELECT id, id_configuracion FROM kanban_columnas WHERE id = ? LIMIT 1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );
  if (!col) return { ok: false, motivo: 'columna_inexistente' };
  if (Number(col.id_configuracion) !== Number(id_configuracion)) {
    return { ok: false, motivo: 'columna_de_otra_configuracion' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// POST /listar — columnas con V2 activa de una configuracion
// ─────────────────────────────────────────────────────────────
exports.listar = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion) return next(new AppError('Falta id_configuracion', 400));

  const rows = await db.query(
    `SELECT v.id, v.id_kanban_columna, v.modelo, v.activo, v.created_at, v.updated_at,
            kc.nombre AS columna_nombre, kc.estado_db
     FROM   kanban_columnas_v2_schemas v
     INNER  JOIN kanban_columnas kc ON kc.id = v.id_kanban_columna
     WHERE  kc.id_configuracion = ?
     ORDER  BY v.updated_at DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  return res.status(200).json({ success: true, data: rows });
});

// ─────────────────────────────────────────────────────────────
// POST /obtener — schema + accion_map + modelo de una columna
// ─────────────────────────────────────────────────────────────
exports.obtener = catchAsync(async (req, res, next) => {
  const { id_kanban_columna, id_configuracion } = req.body;
  if (!id_kanban_columna || !id_configuracion) {
    return next(new AppError('Falta id_kanban_columna o id_configuracion', 400));
  }

  const check = await ensureColumnaPertenece(id_kanban_columna, id_configuracion);
  if (!check.ok) return next(new AppError(check.motivo, 403));

  const [row] = await db.query(
    `SELECT id, id_kanban_columna, response_schema, accion_map, modelo, activo,
            created_at, updated_at
     FROM   kanban_columnas_v2_schemas
     WHERE  id_kanban_columna = ?
     LIMIT  1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  if (!row) return res.status(200).json({ success: true, data: null });

  return res.status(200).json({
    success: true,
    data: {
      ...row,
      response_schema: safeJson(row.response_schema),
      accion_map: safeJson(row.accion_map),
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /guardar — upsert config V2 para una columna
// Body: { id_configuracion, id_kanban_columna, response_schema (object),
//         accion_map (object), modelo (string|null), activo (0/1) }
// ─────────────────────────────────────────────────────────────
exports.guardar = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    id_kanban_columna,
    response_schema,
    accion_map = {},
    modelo = null,
    activo = 1,
  } = req.body;

  if (!id_configuracion || !id_kanban_columna || !response_schema) {
    return next(
      new AppError(
        'Falta id_configuracion, id_kanban_columna o response_schema',
        400,
      ),
    );
  }

  const check = await ensureColumnaPertenece(id_kanban_columna, id_configuracion);
  if (!check.ok) return next(new AppError(check.motivo, 403));

  // Validacion minima: schema debe tener `name` y `schema`
  const schemaObj =
    typeof response_schema === 'string'
      ? safeJson(response_schema)
      : response_schema;
  if (!schemaObj || !schemaObj.name || !schemaObj.schema) {
    return next(
      new AppError(
        'response_schema debe tener forma { name, strict?, schema } (segun OpenAI json_schema)',
        400,
      ),
    );
  }

  const schemaStr = JSON.stringify(schemaObj);
  const accionStr = JSON.stringify(accion_map || {});

  // Upsert
  await db.query(
    `INSERT INTO kanban_columnas_v2_schemas
       (id_kanban_columna, response_schema, accion_map, modelo, activo)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       response_schema = VALUES(response_schema),
       accion_map      = VALUES(accion_map),
       modelo          = VALUES(modelo),
       activo          = VALUES(activo),
       updated_at      = CURRENT_TIMESTAMP`,
    {
      replacements: [
        id_kanban_columna,
        schemaStr,
        accionStr,
        modelo,
        activo ? 1 : 0,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /eliminar — desactivar V2 en una columna (borrado logico)
// ─────────────────────────────────────────────────────────────
exports.eliminar = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_kanban_columna } = req.body;
  if (!id_configuracion || !id_kanban_columna) {
    return next(new AppError('Falta id_configuracion o id_kanban_columna', 400));
  }

  const check = await ensureColumnaPertenece(id_kanban_columna, id_configuracion);
  if (!check.ok) return next(new AppError(check.motivo, 403));

  await db.query(
    `UPDATE kanban_columnas_v2_schemas
     SET    activo = 0, updated_at = CURRENT_TIMESTAMP
     WHERE  id_kanban_columna = ?`,
    {
      replacements: [id_kanban_columna],
      type: db.QueryTypes.UPDATE,
    },
  );

  return res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /usar_seed_sara
// Carga el schema seed `sara_imporshop.schema.json` en una columna,
// con el mapa de acciones por defecto para Imporshop.
// Body: { id_configuracion, id_kanban_columna, accion_map? }
// ─────────────────────────────────────────────────────────────
exports.usarSeedSara = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_kanban_columna, accion_map } = req.body;
  if (!id_configuracion || !id_kanban_columna) {
    return next(new AppError('Falta id_configuracion o id_kanban_columna', 400));
  }

  const check = await ensureColumnaPertenece(id_kanban_columna, id_configuracion);
  if (!check.ok) return next(new AppError(check.motivo, 403));

  const seedPath = path.join(
    process.cwd(),
    'src/schemas/kanban/sara_imporshop.schema.json',
  );
  const seedRaw = await fs.readFile(seedPath, 'utf8');
  const seed = JSON.parse(seedRaw);

  const mapa = accion_map || {
    generar_guia: 'pedidos_confirmados',
    cancelar: 'cancelados',
    escalar_asesor: 'asesor',
  };

  await db.query(
    `INSERT INTO kanban_columnas_v2_schemas
       (id_kanban_columna, response_schema, accion_map, modelo, activo)
     VALUES (?, ?, ?, NULL, 1)
     ON DUPLICATE KEY UPDATE
       response_schema = VALUES(response_schema),
       accion_map      = VALUES(accion_map),
       activo          = 1,
       updated_at      = CURRENT_TIMESTAMP`,
    {
      replacements: [
        id_kanban_columna,
        JSON.stringify(seed),
        JSON.stringify(mapa),
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.status(200).json({
    success: true,
    data: {
      id_kanban_columna,
      response_schema: seed,
      accion_map: mapa,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /probar — disparar V2 manualmente para una prueba
// Body: { id_configuracion, id_cliente, telefono, mensaje,
//         estado_contacto, business_phone_id, accessToken }
// ─────────────────────────────────────────────────────────────
exports.probar = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    id_cliente,
    telefono,
    mensaje,
    estado_contacto,
    business_phone_id,
    accessToken,
  } = req.body;

  if (
    !id_configuracion ||
    !id_cliente ||
    !telefono ||
    !mensaje ||
    !estado_contacto
  ) {
    return next(
      new AppError(
        'Falta id_configuracion, id_cliente, telefono, mensaje o estado_contacto',
        400,
      ),
    );
  }

  const api_key_openai = await getApiKey(id_configuracion);
  if (!api_key_openai) {
    return next(new AppError('Sin api_key_openai para esta configuracion', 400));
  }

  // Persistir el mensaje ENTRANTE (rol_mensaje=0) para que el front
  // pueda reconstruir el flujo completo de la prueba. El saliente lo
  // guarda enviarMensajeWhatsapp / enviarMedioWhatsapp por su cuenta.
  try {
    await MensajeCliente.create({
      id_configuracion,
      id_cliente,
      mid_mensaje: business_phone_id || null,
      tipo_mensaje: 'text',
      texto_mensaje: mensaje,
      ruta_archivo: null,
      rol_mensaje: 0,
      celular_recibe: id_cliente,
      uid_whatsapp: telefono,
      visto: 1,
      estado_meta: 0,
      responsable: 'PROBAR_V2',
    });
  } catch (err) {
    // No bloquear la prueba si la inserción falla
    console.error('No se pudo guardar el mensaje entrante de prueba:', err.message);
  }

  const resultado = await procesarMensajeKanbanV2({
    id_configuracion,
    id_cliente,
    telefono,
    mensaje,
    estado_contacto,
    api_key_openai,
    business_phone_id,
    accessToken,
  });

  return res.status(200).json({ success: true, resultado });
});

// ─────────────────────────────────────────────────────────────
// POST /cargar_config — endpoint utilitario para que el front
// confirme si una columna esta opt-in a V2 (devuelve null si no).
// ─────────────────────────────────────────────────────────────
exports.cargarConfig = catchAsync(async (req, res, next) => {
  const { id_kanban_columna } = req.body;
  if (!id_kanban_columna) return next(new AppError('Falta id_kanban_columna', 400));

  const cfg = await cargarConfigV2(id_kanban_columna);
  return res.status(200).json({ success: true, data: cfg });
});
