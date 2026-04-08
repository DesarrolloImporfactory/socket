// controllers/kanban_plantillas.controller.js
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

const { getConfigFromDB } = require('../utils/whatsappTemplate.helpers');
const axios = require('axios');

// ── Plantillas hardcodeadas ───────────────────────────────────
const PLANTILLAS = {};

// ── GET plantillas disponibles ────────────────────────────────
exports.listar = catchAsync(async (req, res) => {
  const lista = Object.entries(PLANTILLAS).map(([key, p]) => ({
    key,
    nombre: p.nombre,
    descripcion: p.descripcion,
    total_columnas: p.columnas.length,
    columnas_ia: p.columnas.filter((c) => c.activa_ia).length,
  }));
  return res.json({ success: true, data: lista });
});

// ── POST aplicar plantilla ─────────────────────────────────────
exports.aplicar = catchAsync(async (req, res, next) => {
  const { id_configuracion, plantilla_key, empresa } = req.body;

  if (!id_configuracion || !plantilla_key || !empresa) {
    return next(new AppError('Faltan campos obligatorios', 400));
  }

  // ── Obtener api_key_openai desde BD ──
  const [configRow] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const api_key_openai = configRow?.api_key_openai || null;

  if (!api_key_openai) {
    return next(new AppError('No hay API key de OpenAI configurada', 400));
  }

  const plantilla = PLANTILLAS[plantilla_key];
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  const prompts = getPrompts(empresa);
  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const resultado = [];

  for (const col of plantilla.columnas) {
    // 1. Crear asistente en OpenAI si tiene prompt
    let assistant_id = null;
    if (col.prompt_key && prompts[col.prompt_key] && api_key_openai) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: `${col.nombre} - ${empresa}`,
            instructions: prompts[col.prompt_key],
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(
          `Error creando asistente para ${col.nombre}:`,
          err.message,
        );
      }
    }

    // 2. Insertar columna
    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
       (id_configuracion, nombre, estado_db, color_fondo, color_texto,
        icono, orden, activo, es_estado_final, activa_ia, max_tokens,
        assistant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.activa_ia,
          col.max_tokens,
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    const id_columna = insertResult;

    // 3. Insertar acciones
    for (const accion of col.acciones) {
      await db.query(
        `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            id_columna,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
      acciones: col.acciones.length,
    });
  }

  // 4. Activar tipo_configuracion = kanban
  await db.query(
    `UPDATE configuraciones SET tipo_configuracion = 'kanban' WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  return res.json({
    success: true,
    message: `Plantilla "${plantilla.nombre}" aplicada correctamente`,
    data: resultado,
  });
});

exports.reiniciar = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  // 0. Saber qué plantilla tenía (ANTES de borrar)
  const [config] = await db.query(
    `SELECT kanban_global_id FROM configuraciones WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const id_plantilla = config?.kanban_global_id;

  // 1. Obtener IDs de columnas
  const columnas = await db.query(
    `SELECT id FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (columnas.length) {
    const ids = columnas.map((c) => c.id);

    await db.query(
      `DELETE FROM kanban_acciones WHERE id_kanban_columna IN (${ids.join(',')})`,
      { type: db.QueryTypes.DELETE },
    );
  }

  // 2. Borrar columnas
  await db.query(`DELETE FROM kanban_columnas WHERE id_configuracion = ?`, {
    replacements: [id_configuracion],
    type: db.QueryTypes.DELETE,
  });

  // 3. Borrar config de remarketing
  await db.query(
    `DELETE FROM configuracion_remarketing WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.DELETE },
  );

  // 4. Limpiar estado global
  await db.query(
    `UPDATE configuraciones 
     SET kanban_global_activo = 0, kanban_global_id = NULL
     WHERE id = ?`,
    { replacements: [id_configuracion] },
  );

  // 5. LOG 🔥 (esto es clave)
  await db.query(
    `INSERT INTO configuraciones_kanban_global_log
     (id_configuracion, id_plantilla, accion, detalle)
     VALUES (?, ?, 'eliminado', ?)`,
    {
      replacements: [
        id_configuracion,
        id_plantilla || null,
        JSON.stringify({
          motivo: 'reinicio_manual',
          columnas_eliminadas: columnas.length,
        }),
      ],
    },
  );

  return res.json({
    success: true,
    message: 'Configuración reiniciada',
  });
});

// ── Guardar plantilla del cliente ─────────────────────────────
exports.guardarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, descripcion } = req.body;
  if (!id_configuracion || !nombre)
    return next(new AppError('Faltan campos obligatorios', 400));

  // Leer columnas actuales con sus acciones
  const columnas = await db.query(
    `SELECT id, nombre, estado_db, color_fondo, color_texto, icono,
          orden, activo, es_estado_final, activa_ia, max_tokens,
          instrucciones, modelo
   FROM kanban_columnas
   WHERE id_configuracion = ? AND activo = 1
   ORDER BY orden ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columnas.length)
    return next(new AppError('No hay columnas para guardar', 400));

  // Leer acciones de cada columna
  const ids = columnas.map((c) => c.id);
  const acciones = await db.query(
    `SELECT id_kanban_columna, tipo_accion, config, orden
     FROM kanban_acciones
     WHERE id_kanban_columna IN (${ids.join(',')}) AND activo = 1
     ORDER BY orden ASC`,
    { type: db.QueryTypes.SELECT },
  );

  // Construir estructura
  const data = {
    columnas: columnas.map((col) => ({
      nombre: col.nombre,
      estado_db: col.estado_db,
      color_fondo: col.color_fondo,
      color_texto: col.color_texto,
      icono: col.icono,
      orden: col.orden,
      activo: col.activo,
      es_estado_final: col.es_estado_final,
      activa_ia: col.activa_ia,
      max_tokens: col.max_tokens,
      instrucciones: col.instrucciones || null,
      modelo: col.modelo || 'gpt-4o-mini',
      acciones: acciones
        .filter((a) => a.id_kanban_columna === col.id)
        .map((a) => ({
          tipo_accion: a.tipo_accion,
          config:
            typeof a.config === 'string' ? JSON.parse(a.config) : a.config,
          orden: a.orden,
        })),
    })),
  };

  await db.query(
    `INSERT INTO kanban_plantillas_guardadas
     (id_configuracion, nombre, descripcion, data)
     VALUES (?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        nombre.trim(),
        descripcion?.trim() || null,
        JSON.stringify(data),
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.json({ success: true, message: 'Plantilla guardada' });
});

// ── Listar plantillas guardadas del cliente ───────────────────
exports.listarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));

  const plantillas = await db.query(
    `SELECT id, nombre, descripcion, created_at, data,
          JSON_LENGTH(JSON_EXTRACT(data, '$.columnas')) AS total_columnas
   FROM kanban_plantillas_guardadas
   WHERE id_configuracion = ?
   ORDER BY created_at DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  return res.json({
    success: true,
    data: plantillas.map((p) => {
      const parsed = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
      const total_prompts = (parsed?.columnas || []).filter(
        (c) => c.instrucciones,
      ).length;
      return {
        ...p,
        data: undefined,
        total_columnas: p.total_columnas,
        total_prompts,
      };
    }),
  });
});

// ── Aplicar plantilla guardada ────────────────────────────────
exports.aplicarCliente = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_plantilla } = req.body;
  if (!id_configuracion || !id_plantilla)
    return next(new AppError('Faltan campos obligatorios', 400));

  const [plantilla] = await db.query(
    `SELECT data FROM kanban_plantillas_guardadas WHERE id = ? LIMIT 1`,
    { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
  );
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  // ── Obtener api_key para crear asistentes ──
  const [configRow] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const api_key_openai = configRow?.api_key_openai || null;

  const headers = api_key_openai
    ? {
        Authorization: `Bearer ${api_key_openai}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
      }
    : null;

  const { columnas } =
    typeof plantilla.data === 'string'
      ? JSON.parse(plantilla.data)
      : plantilla.data;

  const resultado = [];

  for (const col of columnas) {
    // ── Verificar si ya existe esa columna ──
    const [existente] = await db.query(
      `SELECT id FROM kanban_columnas 
     WHERE id_configuracion = ? AND estado_db = ? LIMIT 1`,
      {
        replacements: [id_configuracion, col.estado_db],
        type: db.QueryTypes.SELECT,
      },
    );

    if (existente) {
      resultado.push({
        columna: col.nombre,
        estado_db: col.estado_db,
        assistant_id: null,
        omitida: true, // ← saltada por duplicado
      });
      continue; // ← no insertar, seguir con la siguiente
    }

    let assistant_id = null;
    if (col.instrucciones && headers) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: empresa ? `${col.nombre} - ${empresa}` : col.nombre,
            instructions: empresa
              ? col.instrucciones.replace(/\[empresa\]/gi, empresa)
              : col.instrucciones,
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(`Error creando asistente ${col.nombre}:`, err.message);
      }
    }

    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
     (id_configuracion, nombre, estado_db, color_fondo, color_texto,
      icono, orden, activo, es_estado_final, activa_ia, max_tokens,
      instrucciones, modelo, assistant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.activa_ia,
          col.max_tokens,
          col.instrucciones || null,
          col.modelo || 'gpt-4o-mini',
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    for (const accion of col.acciones || []) {
      await db.query(
        `INSERT INTO kanban_acciones
       (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
       VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            insertResult,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
    });
  }

  return res.json({ success: true, data: resultado });
});

// ── Eliminar plantilla guardada ───────────────────────────────
exports.eliminarCliente = catchAsync(async (req, res, next) => {
  const { id, id_configuracion } = req.body;
  if (!id || !id_configuracion) return next(new AppError('Faltan campos', 400));

  await db.query(
    `DELETE FROM kanban_plantillas_guardadas WHERE id = ? AND id_configuracion = ?`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.DELETE },
  );

  return res.json({ success: true });
});

/* seccion de plantillas globales */
// ── Guardar plantilla global (solo superadmin) ─────────────
exports.guardarGlobal = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, descripcion, icono, color } = req.body;
  if (!id_configuracion || !nombre)
    return next(new AppError('Faltan campos obligatorios', 400));

  const columnas = await db.query(
    `SELECT id, nombre, estado_db, color_fondo, color_texto, icono,
          orden, activo, es_estado_final, es_principal, activa_ia, max_tokens,
          instrucciones, modelo
   FROM kanban_columnas
   WHERE id_configuracion = ? AND activo = 1
   ORDER BY orden ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columnas.length)
    return next(new AppError('No hay columnas para guardar', 400));

  const ids = columnas.map((c) => c.id);
  const acciones = await db.query(
    `SELECT id_kanban_columna, tipo_accion, config, orden
     FROM kanban_acciones
     WHERE id_kanban_columna IN (${ids.join(',')}) AND activo = 1
     ORDER BY orden ASC`,
    { type: db.QueryTypes.SELECT },
  );

  const data = {
    columnas: columnas.map((col) => ({
      nombre: col.nombre,
      estado_db: col.estado_db,
      color_fondo: col.color_fondo,
      color_texto: col.color_texto,
      icono: col.icono,
      orden: col.orden,
      activo: col.activo,
      es_estado_final: col.es_estado_final,
      es_principal: col.es_principal || 0, // ← agregar
      activa_ia: col.activa_ia,
      max_tokens: col.max_tokens,
      instrucciones: col.instrucciones || null,
      modelo: col.modelo || 'gpt-4o-mini',
      acciones: acciones
        .filter((a) => a.id_kanban_columna === col.id)
        .map((a) => ({
          tipo_accion: a.tipo_accion,
          config:
            typeof a.config === 'string' ? JSON.parse(a.config) : a.config,
          orden: a.orden,
        })),
    })),
  };

  await db.query(
    `INSERT INTO kanban_plantillas_globales
     (nombre, descripcion, icono, color, data, creado_por)
     VALUES (?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        nombre.trim(),
        descripcion?.trim() || null,
        icono || 'bx bx-layout',
        color || '#6366f1',
        JSON.stringify(data),
        id_configuracion,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return res.json({ success: true, message: 'Plantilla global guardada' });
});

// ── Listar plantillas globales ─────────────────────────────
exports.listarGlobales = catchAsync(async (req, res) => {
  const plantillas = await db.query(
    `SELECT id, nombre, descripcion, icono, color, created_at,
            JSON_LENGTH(JSON_EXTRACT(data, '$.columnas')) AS total_columnas,
            data
     FROM kanban_plantillas_globales
     WHERE activo = 1
     ORDER BY created_at DESC`,
    { type: db.QueryTypes.SELECT },
  );

  const resultado = plantillas.map((p) => {
    const parsed = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
    const columnas_ia = (parsed?.columnas || []).filter(
      (c) => c.activa_ia,
    ).length;
    return {
      id: p.id,
      nombre: p.nombre,
      descripcion: p.descripcion,
      icono: p.icono,
      color: p.color,
      created_at: p.created_at,
      total_columnas: p.total_columnas,
      columnas_ia,
      tipo: 'global',
    };
  });

  return res.json({ success: true, data: resultado });
});

const mediaCache = new Map();

async function getBufferFromUrl(url) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
  });
  return Buffer.from(resp.data);
}

function getMimeType(format) {
  if (format === 'VIDEO') return 'video/mp4';
  if (format === 'IMAGE') return 'image/jpeg';
  if (format === 'DOCUMENT') return 'application/pdf';
  return 'application/octet-stream';
}

const FB_APP_ID = process.env.FB_APP_ID;

/**
 * Flujo basado en ejemplos públicos donde la respuesta devuelve "h" y eso se usa en header_handle. :contentReference[oaicite:5]{index=5}
 */
async function uploadResumableAndGetHandle({
  accessToken,
  fileBuffer,
  mimeType,
  fileName,
}) {
  if (!FB_APP_ID) {
    throw new Error('Falta FB_APP_ID');
  }

  const ax = axios.create({
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 30000,
    validateStatus: () => true,
  });

  // 1) Crear sesión de subida (upload session)
  const startUrl = `https://graph.facebook.com/v22.0/${FB_APP_ID}/uploads`;
  const startResp = await ax.post(startUrl, null, {
    params: {
      file_length: fileBuffer.length,
      file_type: mimeType,
      file_name: fileName,
    },
  });

  if (startResp.status < 200 || startResp.status >= 300) {
    throw new Error(
      `No se pudo iniciar upload session: ${startResp.status} ${JSON.stringify(startResp.data)}`,
    );
  }

  const uploadSessionId = startResp.data?.id;
  if (!uploadSessionId) {
    throw new Error(`Upload session sin id: ${JSON.stringify(startResp.data)}`);
  }

  // 2) Subir binario
  const uploadUrl = `https://graph.facebook.com/v22.0/${uploadSessionId}`;
  const uploadResp = await axios.post(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      file_offset: '0',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (uploadResp.status < 200 || uploadResp.status >= 300) {
    throw new Error(
      `No se pudo subir archivo: ${uploadResp.status} ${JSON.stringify(uploadResp.data)}`,
    );
  }

  // En ejemplos, se usa "h" como handle para header_handle. :contentReference[oaicite:6]{index=6}
  const handle = uploadResp.data?.h;
  if (!handle) {
    throw new Error(
      `Respuesta sin handle (h): ${JSON.stringify(uploadResp.data)}`,
    );
  }

  return handle;
}

async function prepareComponentsWithHandles(components, ACCESS_TOKEN) {
  const newComponents = [];

  for (const comp of components) {
    if (
      comp?.type === 'HEADER' &&
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(comp?.format) &&
      comp?.example?.header_handle?.[0]
    ) {
      const url = comp.example.header_handle[0];

      try {
        let handle;

        if (mediaCache.has(url)) {
          handle = mediaCache.get(url);
        } else {
          const buffer = await getBufferFromUrl(url);

          handle = await uploadResumableAndGetHandle({
            accessToken: ACCESS_TOKEN,
            fileBuffer: buffer,
            mimeType: getMimeType(comp.format),
            fileName: `file.${getMimeType(comp.format).split('/')[1]}`,
          });

          mediaCache.set(url, handle);
        }

        newComponents.push({
          ...comp,
          example: { header_handle: [handle] },
        });
      } catch (err) {
        throw new Error(`MEDIA_ERROR: ${url}`);
      }
    } else {
      newComponents.push(comp);
    }
  }

  return newComponents;
}

// ── Helpers internos ( solo retornan data) ──
async function _crearTemplatesMeta(id_configuracion) {
  const wabaConfig = await getConfigFromDB(id_configuracion);
  if (!wabaConfig?.WABA_ID || !wabaConfig?.ACCESS_TOKEN)
    return [{ status: 'skipped', mensaje: 'Sin config WABA' }];

  const { WABA_ID, ACCESS_TOKEN } = wabaConfig;

  let existentes = [];
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates?access_token=${ACCESS_TOKEN}&limit=200`,
    );
    existentes = (data.data || []).map((p) => p.name);
  } catch (e) {
    console.error('Error listando templates:', e.message);
  }

  const resultados = [];

  for (const tpl of KANBAN_TEMPLATES_META) {
    if (existentes.includes(tpl.name)) {
      resultados.push({ nombre: tpl.name, status: 'omitido' });
      continue;
    }

    try {
      let componentsPrepared;

      try {
        componentsPrepared = await prepareComponentsWithHandles(
          tpl.components,
          ACCESS_TOKEN,
        );
      } catch (mediaError) {
        // 🚨 NO crear template si falla media
        resultados.push({
          nombre: tpl.name,
          status: 'error_media',
          error: mediaError.message,
        });
        continue; // sigue con el siguiente template
      }

      const payload = {
        name: tpl.name,
        language: tpl.language,
        category: tpl.category,
        components: componentsPrepared,
      };

      const r = await axios.post(
        `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      resultados.push({
        nombre: tpl.name,
        status: 'success',
        id: r.data?.id,
      });
    } catch (err) {
      resultados.push({
        nombre: tpl.name,
        status: 'error',
        error: err.response?.data?.error?.message || err.message,
      });
    }
  }
  return resultados;
}

async function _crearRespuestasRapidas(id_configuracion) {
  let existentes = [];
  try {
    const rows = await db.query(
      `SELECT atajo FROM templates_chat_center WHERE id_configuracion = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    existentes = rows.map((r) => r.atajo);
  } catch (e) {
    console.error('Error consultando existentes:', e.message);
  }

  const resultados = [];
  for (const rr of KANBAN_RESPUESTAS_RAPIDAS) {
    if (existentes.includes(rr.atajo)) {
      resultados.push({ atajo: rr.atajo, status: 'omitido' });
      continue;
    }
    try {
      const [insertId] = await db.query(
        `INSERT INTO templates_chat_center
         (atajo, mensaje, id_configuracion, tipo_mensaje, ruta_archivo, mime_type, file_name)
         VALUES (?, ?, ?, 'text', NULL, NULL, NULL)`,
        {
          replacements: [rr.atajo, rr.mensaje, id_configuracion],
          type: db.QueryTypes.INSERT,
        },
      );
      resultados.push({ atajo: rr.atajo, status: 'success', insertId });
    } catch (err) {
      resultados.push({ atajo: rr.atajo, status: 'error', error: err.message });
    }
  }
  return resultados;
}

// ── Aplicar plantilla global ───────────────────────────────
exports.aplicarGlobal = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_plantilla, empresa } = req.body;
  if (!id_configuracion || !id_plantilla)
    return next(new AppError('Faltan campos obligatorios', 400));

  const [plantilla] = await db.query(
    `SELECT data FROM kanban_plantillas_globales WHERE id = ? AND activo = 1 LIMIT 1`,
    { replacements: [id_plantilla], type: db.QueryTypes.SELECT },
  );
  if (!plantilla) return next(new AppError('Plantilla no encontrada', 404));

  const [configRow] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const api_key_openai = configRow?.api_key_openai || null;

  const headers = api_key_openai
    ? {
        Authorization: `Bearer ${api_key_openai}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
      }
    : null;

  const { columnas } =
    typeof plantilla.data === 'string'
      ? JSON.parse(plantilla.data)
      : plantilla.data;

  const resultado = [];

  for (const col of columnas) {
    let assistant_id = null;

    if (col.instrucciones && headers) {
      try {
        const aRes = await axios.post(
          'https://api.openai.com/v1/assistants',
          {
            name: empresa ? `${col.nombre} - ${empresa}` : col.nombre,
            instructions: empresa
              ? col.instrucciones.replace(/\[empresa\]/gi, empresa)
              : col.instrucciones,
            model: col.modelo || 'gpt-4o-mini',
            tools: [{ type: 'file_search' }],
          },
          { headers },
        );
        assistant_id = aRes.data?.id || null;
      } catch (err) {
        console.error(`Error creando asistente ${col.nombre}:`, err.message);
      }
    }

    const [insertResult] = await db.query(
      `INSERT INTO kanban_columnas
   (id_configuracion, nombre, estado_db, color_fondo, color_texto,
    icono, orden, activo, es_estado_final, es_principal, activa_ia, max_tokens,
    instrucciones, modelo, assistant_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.es_principal || 0, // ← agregar
          col.activa_ia,
          col.max_tokens,
          col.instrucciones || null,
          col.modelo || 'gpt-4o-mini',
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    for (const accion of col.acciones || []) {
      await db.query(
        `INSERT INTO kanban_acciones
         (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, 1, ?)`,
        {
          replacements: [
            insertResult,
            id_configuracion,
            accion.tipo_accion,
            JSON.stringify(accion.config),
            accion.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    resultado.push({
      columna: col.nombre,
      estado_db: col.estado_db,
      assistant_id,
    });
  }

  await db.query(
    `UPDATE configuraciones SET tipo_configuracion = 'kanban' WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  const resultadoTemplates = await _crearTemplatesMeta(id_configuracion);
  const resultadoRapidas = await _crearRespuestasRapidas(id_configuracion);

  // Guardar estado actual
  await db.query(
    `UPDATE configuraciones 
   SET kanban_global_activo = 1, kanban_global_id = ?
   WHERE id = ?`,
    { replacements: [id_plantilla, id_configuracion] },
  );

  await db.query(
    `INSERT INTO configuraciones_kanban_global_log
   (id_configuracion, id_plantilla, accion, detalle)
   VALUES (?, ?, 'aplicado', ?)`,
    {
      replacements: [
        id_configuracion,
        id_plantilla,
        JSON.stringify({
          columnas: resultado,
          templates_meta: resultadoTemplates,
          respuestas_rapidas: resultadoRapidas,
        }),
      ],
    },
  );

  return res.json({
    success: true,
    data: {
      columnas: resultado,
      templates_meta: resultadoTemplates,
      respuestas_rapidas: resultadoRapidas,
    },
  });
});

// ── Eliminar plantilla global ──────────────────────────────
exports.eliminarGlobal = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  await db.query(
    `UPDATE kanban_plantillas_globales SET activo = 0 WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE },
  );

  return res.json({ success: true });
});
/* seccion de plantillas globales */

const KANBAN_TEMPLATES_META = [
  {
    name: 'remarketing_k1',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'VIDEO',
        example: {
          header_handle: [
            'https://new.imporsuitpro.com/Videos/stream/3619a3291e1ccfe2388174618b50b550',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Tu pedido ya está listo para salir. Compárteme tu ubicación para coordinar el envío de inmediato.',
      },
    ],
  },
  {
    name: 'remarketing_k2',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'VIDEO',
        example: {
          header_handle: [
            'https://new.imporsuitpro.com/Videos/stream/58b0a69a64359e85d12dd722f27f7afe',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Tu pedido está listo y tenemos cupos de envío GRATIS disponibles por poco tiempo.\nRecuerda, el pago lo realizas directamente al transportista al momento de la entrega.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Quiero envío hoy' },
          { type: 'QUICK_REPLY', text: 'Tengo una consulta' },
        ],
      },
    ],
  },
  {
    name: 'remarketing_k3',
    language: 'es',
    category: 'MARKETING',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: {
          header_handle: [
            'https://imp-datas.s3.amazonaws.com/images/2026-04-07T21-27-32-154Z-534427295_813699714500800_6839605187360868450_n.png',
          ],
        },
      },
      {
        type: 'BODY',
        text: 'Se aplicó un ajuste especial del 10% a tu pedido. Envíame tu ubicación para coordinar el despacho.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Quiero mi descuento' },
          { type: 'QUICK_REPLY', text: 'Enviar ubicación' },
        ],
      },
    ],
  },
  // ── GUÍA GENERADA (con botones URL corregidos) ──
  {
    name: 'guia_generada_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'La guía de envío de tu pedido ha sido generada. El tiempo estimado de entrega es de 2 a 3 días hábiles.',
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Descargar Guía',
            url: 'https://d39ru7awumhhs2.cloudfront.net/{{1}}',
            example: [
              'https://d39ru7awumhhs2.cloudfront.net/guias/ejemplo.pdf',
            ],
          },
          {
            type: 'URL',
            text: 'Seguimiento del pedido',
            url: 'https://chat.imporfactory.app/api/v1/kanban_plantillas/t/{{1}}',
            example: [
              'https://chat.imporfactory.app/api/v1/kanban_plantillas/t/LC123456',
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'novedad_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Te comento que se ha gestionado un nuevo intento de entrega con la transportadora. Por favor, estar atento para que puedas recibir tu pedido sin inconvenientes.',
      },
    ],
  },
  {
    name: 'novedad_k2',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Estimado cliente, le recordamos que al seleccionar pago contraentrega, usted se comprometió a recibir y pagar el pedido, conforme a la ley 67 del 2022 de Comercio Electrónico.\n\nEl costo del envío ya fue asumido por nuestra empresa.\nSe ha programado un nuevo intento de entrega para el día {{1}}.\n\nEs importante contar con su disponibilidad para evitar cancelación del pedido y posibles restricciones en futuras compras.',
        example: { body_text: [['15 de Abril']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmo recepción' },
          { type: 'QUICK_REPLY', text: 'Reprogramar entrega' },
        ],
      },
    ],
  },
  {
    name: 'retiro_agencia_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'AVISO IMPORTANTE',
      },
      {
        type: 'BODY',
        text: 'Estimado Cliente:\nServientrega le notifica que su pedido esta listo para ser retirado en agencia: {{1}}\nPor favor acercarse lo más pronto posible.',
        example: { body_text: [['Agencia Norte Quito']] },
      },
    ],
  },
  // ── CONFIRMACIÓN DE PEDIDO ──
  {
    name: 'confirmacion_pedido_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero confirmar tus datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n\nPor favor, selecciona *CONFIRMAR PEDIDO* si tus datos son correctos ✅, o *ACTUALIZAR INFORMACIÓN* para corregirlos antes de proceder con el envío de tu producto. 🚚',
        example: {
          body_text: [
            [
              'Daniel',
              '35.00',
              'Audífonos Bluetooth',
              'Daniel Bonilla',
              '0987654321',
              'Av. Simón Bolívar y Mariscal Sucre',
            ],
          ],
        },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'CONFIRMAR PEDIDO' },
          { type: 'QUICK_REPLY', text: 'ACTUALIZAR INFORMACIÓN' },
        ],
      },
    ],
  },
  // ── ZONA DE ENTREGA ──
  {
    name: 'zona_entrega_k1',
    language: 'es',
    category: 'UTILITY',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'Llego el día de entrega',
      },
      {
        type: 'BODY',
        text: 'Hoy tu pedido ha llegado 📦✅ a {{1}} y está próximo a ser entregado en {{2}}, en el horario de 9 am a 6 pm. ¡Te recordamos tener el valor total de {{3}} en efectivo! Agradecemos estar atento a las llamadas del courier 🚚 Revisa el estado de tu guía aquí {{4}} 😊.',
        example: {
          body_text: [
            [
              'Quito',
              'Av. Amazonas 123',
              '$20.00',
              'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=LC123',
            ],
          ],
        },
      },
    ],
  },
];

// ── Respuestas rápidas para Kanban ───────────────────────────
const KANBAN_RESPUESTAS_RAPIDAS = [
  {
    atajo: 'orden_aprobada',
    mensaje:
      'Tu orden ya ha sido aprobada correctamente.\nEstamos a la espera de que la transportadora genere la guía de envío. 📦 Apenas esté disponible, te la compartiré de inmediato para que puedas hacer el seguimiento.',
  },
  {
    atajo: 'agradecimiento',
    mensaje:
      'Muchas gracias por confiar en nosotros y bienvenid@ a la familia 🙌🛍 espero disfrutes de nuestros productos.',
  },
  {
    atajo: 'pago_contraentrega',
    mensaje:
      'El pago es CONTRA-ENTREGA 💵, es decir, que vas a pagar tu pedido en efectivo cuando el transportista te lo entregue.',
  },
  {
    atajo: 'genera_preguntas',
    mensaje:
      '¿Tienes alguna pregunta específica sobre el producto? 🤔\nEstoy aquí para proporcionarte más información y aclarar cualquier duda que puedas tener. 😊',
  },
  {
    atajo: 'despedida',
    mensaje:
      'Agradezco tu tiempo y consideración. 🙌\nEspero con ansias tu respuesta y la oportunidad de brindarte una solución de calidad. ¡Que tengas un maravilloso día! ✨',
  },
  {
    atajo: 'ubicacion_incorrecta',
    mensaje:
      'Genial, en este momento procedo con el empaque de su pedido. 📦\nPor favor si me ayuda con la ubicación por Google Maps 📍 para que el transportista llegue con facilidad.',
  },
  {
    atajo: 'antes_generar_guia',
    mensaje:
      'Perfecto, en este momento procedemos con su despacho, en un momento le comparto su guía de envío. 😊\nCualquier duda que tenga estoy para ayudarle 📦',
  },
];

exports.crearTemplatesMeta = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));
  const data = await _crearTemplatesMeta(id_configuracion);
  return res.json({ success: true, data });
});

exports.crearRespuestasRapidas = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));
  const data = await _crearRespuestasRapidas(id_configuracion);
  return res.json({ success: true, data });
});

exports.trackingRedirect = (req, res) => {
  const g = String(req.params.guide || '').trim();
  if (!g) return res.status(400).send('Guía requerida');

  const upper = g.toUpperCase();
  let url;

  if (
    upper.startsWith('LC') ||
    upper.startsWith('IMP') ||
    upper.startsWith('MKP')
  )
    url = `https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=${encodeURIComponent(g)}`;
  else if (upper.startsWith('D0') || upper.startsWith('I0'))
    url = `https://ec.gintracom.site/web/site/tracking?guia=${encodeURIComponent(g)}`;
  else if (upper.startsWith('V'))
    url = `https://tracking.veloces.app/tracking-client/${encodeURIComponent(g)}`;
  else if (upper.startsWith('WYB'))
    url = `https://app.urbano.com.ec/plugin/etracking/etracking/?guia=${encodeURIComponent(g)}`;
  else
    url = `https://www.servientrega.com.ec/Tracking/?guia=${encodeURIComponent(g)}&tipo=GUIA`;

  return res.redirect(url);
};
