// ════════════════════════════════════════════════════════════
// kanban_asistente.controller.js
// CRUD completo de asistentes OpenAI desde KanbanConfig
// ════════════════════════════════════════════════════════════

const axios = require('axios');
const FormData = require('form-data');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');

// Tipos de archivo aceptados por OpenAI para file_search
// https://platform.openai.com/docs/assistants/tools/file-search/supported-files
const MIME_TYPES_PERMITIDOS = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/json',
  'text/csv',
  'text/x-python',
  'application/x-python-code',
  'text/javascript',
  'text/x-typescript',
]);

const EXT_LABEL = {
  'application/pdf': 'PDF',
  'text/plain': 'TXT',
  'text/markdown': 'MD',
  'text/html': 'HTML',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'DOCX',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'PPTX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/json': 'JSON',
  'text/csv': 'CSV',
};

async function getApiKey(id_configuracion) {
  const [row] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!row?.api_key_openai)
    throw new Error(
      `Sin api_key_openai para id_configuracion=${id_configuracion}`,
    );
  return row.api_key_openai;
}

function headersJson(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}
function headersBase(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' };
}

// ── Extraer mensaje de error de OpenAI ───────────────────────
function parsearErrorOpenAI(err) {
  const data = err?.response?.data;
  const status = err?.response?.status;

  if (data?.error?.message) {
    const msg = data.error.message;
    const tipo = data.error.type || '';
    const code = data.error.code || '';

    // Errores comunes de archivos
    if (msg.includes('unsupported'))
      return `Tipo de archivo no soportado por OpenAI. Usa PDF, DOCX, TXT, CSV, JSON, MD, XLSX o PPTX.`;
    if (msg.includes('too large') || msg.includes('size'))
      return `El archivo supera el tamaño máximo permitido (512 MB por archivo, 100 MB para sin parsear).`;
    if (msg.includes('quota') || code === 'insufficient_quota')
      return `Tu API key no tiene saldo suficiente en OpenAI.`;
    if (msg.includes('invalid_api_key') || status === 401)
      return `API key de OpenAI inválida o expirada. Verifica en Configuración.`;
    if (msg.includes('rate_limit') || code === 'rate_limit_exceeded')
      return `Límite de peticiones a OpenAI alcanzado. Intenta en unos segundos.`;
    if (msg.includes('model_not_found'))
      return `El modelo seleccionado no está disponible con tu API key.`;
    if (msg.includes('vector_store'))
      return `Error en el almacén vectorial de OpenAI: ${msg}`;

    return msg; // mensaje original si no matchea ningún patrón conocido
  }

  if (status === 404)
    return 'Asistente no encontrado en OpenAI. Es posible que haya sido eliminado.';
  if (status === 429)
    return 'Demasiadas peticiones a OpenAI. Espera unos segundos e intenta de nuevo.';
  if (status === 500) return 'Error interno de OpenAI. Intenta más tarde.';

  return err.message || 'Error desconocido al conectar con OpenAI.';
}

// ─────────────────────────────────────────────────────────────
// obtenerAsistente
// POST /kanban_columnas/obtener_asistente
// Devuelve datos del asistente OpenAI + archivos adjuntos
// ─────────────────────────────────────────────────────────────
exports.obtenerAsistente = catchAsync(async (req, res, next) => {
  const { id } = req.body; // id de kanban_columnas
  if (!id) return next(new AppError('Falta id', 400));

  const [col] = await db.query(
    `SELECT id, assistant_id, vector_store_id, id_configuracion FROM kanban_columnas WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));

  if (!col.assistant_id) {
    return res.status(200).json({ success: true, data: null });
  }

  const apiKey = await getApiKey(col.id_configuracion);

  try {
    // Obtener datos del asistente
    const asstRes = await axios.get(
      `https://api.openai.com/v1/assistants/${col.assistant_id}`,
      { headers: headersJson(apiKey) },
    );

    const asst = asstRes.data;

    // Obtener archivos del vector store (si existe)
    let archivos = [];
    if (col.vector_store_id) {
      try {
        const vsFiles = await axios.get(
          `https://api.openai.com/v1/vector_stores/${col.vector_store_id}/files?limit=20`,
          { headers: headersJson(apiKey) },
        );
        const files = vsFiles.data?.data || [];

        // Para cada archivo, obtener su nombre desde /v1/files
        archivos = await Promise.all(
          files.map(async (f) => {
            try {
              const fileRes = await axios.get(
                `https://api.openai.com/v1/files/${f.id}`,
                { headers: headersBase(apiKey) },
              );
              return {
                id: f.id,
                nombre: fileRes.data?.filename || f.id,
                bytes: fileRes.data?.bytes || 0,
                status: f.status,
                created: f.created_at,
              };
            } catch {
              return { id: f.id, nombre: f.id, bytes: 0, status: f.status };
            }
          }),
        );
      } catch (_) {
        /* ignorar error de archivos, no romper el flujo */
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        assistant_id: asst.id,
        nombre: asst.name,
        instrucciones: asst.instructions,
        modelo: asst.model,
        vector_store_id: col.vector_store_id,
        archivos,
      },
    });
  } catch (err) {
    const mensaje = parsearErrorOpenAI(err);
    return next(
      new AppError(
        `Error al obtener asistente: ${mensaje}`,
        err?.response?.status || 500,
      ),
    );
  }
});

// ─────────────────────────────────────────────────────────────
// crearAsistente
// POST /kanban_columnas/crear_asistente
// ─────────────────────────────────────────────────────────────
exports.crearAsistente = catchAsync(async (req, res, next) => {
  const { id, nombre, instrucciones, modelo = 'gpt-4o-mini' } = req.body;
  if (!id) return next(new AppError('Falta id de columna', 400));

  const [col] = await db.query(
    `SELECT id, id_configuracion, nombre AS col_nombre, assistant_id FROM kanban_columnas WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));
  if (col.assistant_id)
    return next(
      new AppError(
        'Esta columna ya tiene un asistente. Edítalo en lugar de crear uno nuevo.',
        400,
      ),
    );

  const apiKey = await getApiKey(col.id_configuracion);

  const nombreFinal = nombre?.trim() || `Asistente - ${col.col_nombre}`;
  const instruccionesFinal =
    instrucciones?.trim() ||
    `Eres un asistente de ventas. Responde en español de forma cordial y profesional.`;

  const MODELOS_VALIDOS = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
  if (!MODELOS_VALIDOS.includes(modelo))
    return next(
      new AppError(
        `Modelo inválido. Opciones: ${MODELOS_VALIDOS.join(', ')}`,
        400,
      ),
    );

  try {
    const asstRes = await axios.post(
      'https://api.openai.com/v1/assistants',
      { name: nombreFinal, instructions: instruccionesFinal, model: modelo },
      { headers: headersJson(apiKey) },
    );

    const assistant_id = asstRes.data?.id;
    if (!assistant_id) throw new Error('OpenAI no devolvió un assistant_id');

    // Guardar en BD
    await db.query(
      `UPDATE kanban_columnas 
   SET assistant_id = ?, instrucciones = ?, modelo = ?
   WHERE id = ?`,
      {
        replacements: [assistant_id, instrucciones, modelo, id],
        type: db.QueryTypes.UPDATE,
      },
    );

    return res.status(200).json({
      success: true,
      assistant_id,
      nombre: nombreFinal,
      instrucciones: instruccionesFinal,
      modelo,
    });
  } catch (err) {
    const mensaje = parsearErrorOpenAI(err);
    return next(new AppError(mensaje, err?.response?.status || 500));
  }
});

// ─────────────────────────────────────────────────────────────
// actualizarAsistente
// POST /kanban_columnas/actualizar_asistente
// Actualiza nombre, instrucciones, modelo + activa_ia, max_tokens en BD
// ─────────────────────────────────────────────────────────────
exports.actualizarAsistente = catchAsync(async (req, res, next) => {
  const { id, nombre, instrucciones, modelo, activa_ia, max_tokens } = req.body;
  if (!id) return next(new AppError('Falta id', 400));

  const [col] = await db.query(
    `SELECT id, id_configuracion, assistant_id FROM kanban_columnas WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));

  // Actualizar BD siempre (activa_ia, max_tokens)
  await db.query(
    `UPDATE kanban_columnas 
   SET activa_ia = ?, max_tokens = ?, instrucciones = ?, modelo = ?
   WHERE id = ?`,
    {
      replacements: [
        activa_ia ?? null,
        max_tokens ?? null,
        instrucciones ?? null, // ← aquí estaba fallando (índice 2)
        modelo ?? null,
        id,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );

  // Si tiene asistente, actualizar también en OpenAI
  if (col.assistant_id && (nombre || instrucciones || modelo)) {
    const apiKey = await getApiKey(col.id_configuracion);
    const MODELOS_VALIDOS = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
    const modeloFinal =
      modelo && MODELOS_VALIDOS.includes(modelo) ? modelo : undefined;

    const body = {};
    if (nombre) body.name = nombre.trim();
    if (instrucciones) body.instructions = instrucciones.trim();
    if (modeloFinal) body.model = modeloFinal;

    try {
      await axios.post(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        body,
        { headers: headersJson(apiKey) },
      );
    } catch (err) {
      const mensaje = parsearErrorOpenAI(err);
      return next(
        new AppError(
          `Cambios en BD guardados, pero error en OpenAI: ${mensaje}`,
          500,
        ),
      );
    }
  }

  return res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// subirArchivo
// POST /kanban_columnas/subir_archivo
// multipart/form-data: file + id (kanban_columna id)
// ─────────────────────────────────────────────────────────────
exports.subirArchivo = catchAsync(async (req, res, next) => {
  const { id } = req.body;
  const archivo = req.file; // multer

  if (!id) return next(new AppError('Falta id de columna', 400));
  if (!archivo) return next(new AppError('No se recibió ningún archivo', 400));

  // Validar tipo MIME antes de llamar a OpenAI
  if (!MIME_TYPES_PERMITIDOS.has(archivo.mimetype)) {
    const formatoRecibido = archivo.mimetype || 'desconocido';
    const formatosOk = [
      'PDF',
      'DOCX',
      'TXT',
      'CSV',
      'JSON',
      'MD',
      'XLSX',
      'PPTX',
      'HTML',
    ].join(', ');
    return next(
      new AppError(
        `Formato "${formatoRecibido}" no aceptado por OpenAI. Sube un archivo: ${formatosOk}.`,
        400,
      ),
    );
  }

  // Validar tamaño (512 MB límite OpenAI, usamos 100 MB como límite práctico)
  const MAX_BYTES = 100 * 1024 * 1024;
  if (archivo.size > MAX_BYTES) {
    const mb = (archivo.size / (1024 * 1024)).toFixed(1);
    return next(
      new AppError(`El archivo (${mb} MB) supera el límite de 100 MB.`, 400),
    );
  }

  const [col] = await db.query(
    `SELECT id, id_configuracion, assistant_id, vector_store_id FROM kanban_columnas WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));
  if (!col.assistant_id)
    return next(
      new AppError('La columna no tiene asistente. Créalo primero.', 400),
    );

  const apiKey = await getApiKey(col.id_configuracion);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 1. Subir archivo a OpenAI Files
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', archivo.buffer, {
      filename: archivo.originalname,
      contentType: archivo.mimetype,
    });

    const fileRes = await axios.post('https://api.openai.com/v1/files', form, {
      headers: { ...headersBase(apiKey), ...form.getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const file_id = fileRes.data?.id;
    if (!file_id) throw new Error('OpenAI no devolvió file_id');

    // 2. Crear o reutilizar vector store
    let vectorStoreId = col.vector_store_id;
    if (!vectorStoreId) {
      const vsRes = await axios.post(
        'https://api.openai.com/v1/vector_stores',
        { name: `kanban_${col.id}_${Date.now()}` },
        { headers: headersJson(apiKey) },
      );
      vectorStoreId = vsRes.data?.id;
      if (!vectorStoreId) throw new Error('No se pudo crear vector store');

      await db.query(
        `UPDATE kanban_columnas SET vector_store_id = ? WHERE id = ?`,
        { replacements: [vectorStoreId, id], type: db.QueryTypes.UPDATE },
      );
    }

    // 3. Adjuntar archivo al vector store
    const attachRes = await axios.post(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      { file_id },
      { headers: headersJson(apiKey) },
    );
    const vsFileId = attachRes.data?.id;

    // 4. Esperar indexación (máx 30s)
    let status = 'in_progress';
    let intentos = 0;
    while (status === 'in_progress' && intentos < 30) {
      await sleep(1000);
      intentos++;
      const poll = await axios.get(
        `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${vsFileId}`,
        { headers: headersJson(apiKey) },
      );
      status = poll.data?.status;
      if (status === 'failed' || status === 'cancelled') {
        throw new Error(
          `OpenAI no pudo indexar el archivo (status=${status}). El formato puede no ser compatible para búsqueda semántica.`,
        );
      }
    }

    // 5. Asegurar file_search en el asistente
    const asstRes = await axios.get(
      `https://api.openai.com/v1/assistants/${col.assistant_id}`,
      { headers: headersJson(apiKey) },
    );
    const tools = Array.isArray(asstRes.data?.tools) ? asstRes.data.tools : [];
    const tieneFileSearch = tools.some((t) => t?.type === 'file_search');

    await axios.post(
      `https://api.openai.com/v1/assistants/${col.assistant_id}`,
      {
        tools: tieneFileSearch ? tools : [...tools, { type: 'file_search' }],
        tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
      },
      { headers: headersJson(apiKey) },
    );

    return res.status(200).json({
      success: true,
      file_id,
      nombre: archivo.originalname,
      bytes: archivo.size,
      status: 'completed',
      vector_store_id: vectorStoreId,
    });
  } catch (err) {
    const mensaje = parsearErrorOpenAI(err);
    return next(new AppError(mensaje, err?.response?.status || 500));
  }
});

// ─────────────────────────────────────────────────────────────
// eliminarArchivo
// POST /kanban_columnas/eliminar_archivo
// ─────────────────────────────────────────────────────────────
exports.eliminarArchivo = catchAsync(async (req, res, next) => {
  const { id, file_id } = req.body;
  if (!id || !file_id) return next(new AppError('Faltan id o file_id', 400));

  const [col] = await db.query(
    `SELECT id, id_configuracion, vector_store_id FROM kanban_columnas WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));

  const apiKey = await getApiKey(col.id_configuracion);
  const errores = [];

  // Quitar del vector store
  if (col.vector_store_id) {
    try {
      await axios.delete(
        `https://api.openai.com/v1/vector_stores/${col.vector_store_id}/files/${file_id}`,
        { headers: headersJson(apiKey) },
      );
    } catch (err) {
      errores.push(
        `No se pudo quitar del vector store: ${parsearErrorOpenAI(err)}`,
      );
    }
  }

  // Eliminar el archivo de OpenAI
  try {
    await axios.delete(`https://api.openai.com/v1/files/${file_id}`, {
      headers: headersBase(apiKey),
    });
  } catch (err) {
    errores.push(`No se pudo eliminar el archivo: ${parsearErrorOpenAI(err)}`);
  }

  if (errores.length) {
    return res.status(200).json({ success: false, errores });
  }

  return res.status(200).json({ success: true });
});
