// ════════════════════════════════════════════════════════════
// kanban_asistente.controller.js
// CRUD completo de asistentes OpenAI desde KanbanConfig
// ════════════════════════════════════════════════════════════

const axios = require('axios');
const FormData = require('form-data');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');

const {
  compilarPromptFinal,
  quitarBloqueInstruccionesExtra,
} = require('../utils/promptCompiler');
const {
  sanitizarRespuestaAgente,
} = require('../utils/openia/sanitizador_agente');
const { construirContextoColumna } = require('../utils/contextoColumna');
const { humanizarFechas } = require('../utils/humanizarFechas');
const { limpiarColetillas } = require('../utils/limpiarColetillas');
const {
  toolFileSearchResponses,
  usaCatalogoInline,
} = require('../utils/openia/fileSearch');
const { usaResponsesApi } = require('../utils/openia/responsesApi');
const { esSinSaldoOpenAI } = require('../utils/openia/sinSaldo');

// Configuraciones donde los documentos que sube el usuario van a un vector
// store PROPIO (kanban_columnas.vector_store_docs_id) en vez de compartir el
// del catálogo. Misma convención que USAR_RESPONSES_API y
// CONFIGS_CON_CATALOGO_INLINE: lista a mano para ver hasta dónde llegó esto.
//
// Solo decide DÓNDE se guardan los archivos nuevos. Todo lo demás (listarlos,
// borrarlos, mandárselos al bot) lee vector_store_docs_id directamente.
//
// ⚠️ En la Responses API los docs separados NO son opcionales: con el catálogo
// inline la llamada ya no manda vector_store_id, así que un archivo adjuntado
// al store del catálogo es invisible para el bot — y encima el sync del
// catálogo recrea ese store y lo borra. Caso 569 del 2026-08-18: el PDF de
// agencias subido desde KanbanConfig cayó al store del catálogo y el bot
// inventaba direcciones. Por eso subirArchivo trata TODA cuenta migrada a
// Responses como docs separados; esta lista queda solo para el camino viejo
// de Assistants, donde el asistente admite un único store y el catálogo lo
// ocupa.
const CONFIGS_CON_DOCS_SEPARADOS = [10];

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

    if (msg.includes('unsupported'))
      return `Tipo de archivo no soportado por OpenAI. Usa PDF, DOCX, TXT, CSV, JSON, MD, XLSX o PPTX.`;
    if (msg.includes('too large') || msg.includes('size'))
      return `El archivo supera el tamaño máximo permitido (512 MB por archivo, 100 MB para sin parsear).`;
    // Antes esto solo miraba 'quota', así que el saldo agotado del modelo
    // prepago ("You have no credits remaining", code rate_limit_exceeded) caía
    // más abajo en el rate_limit y el cliente leía "intenta en unos segundos"
    // para siempre. Va antes que el rate_limit a propósito.
    if (esSinSaldoOpenAI({ response: { status, data } }))
      return `Tu cuenta de OpenAI se quedó sin saldo. Recarga créditos en platform.openai.com para que el asistente vuelva a responder.`;
    if (msg.includes('quota') || code === 'insufficient_quota')
      return `Tu API key no tiene saldo suficiente en OpenAI.`;
    if (msg.includes('invalid_api_key'))
      return `API key de OpenAI inválida o expirada. Verifica en Configuración.`;
    if (status === 401)
      return `Error de autenticación con OpenAI (transitorio). Intenta de nuevo.`;
    if (msg.includes('rate_limit') || code === 'rate_limit_exceeded')
      return `Límite de peticiones a OpenAI alcanzado. Intenta en unos segundos.`;
    if (msg.includes('model_not_found'))
      return `El modelo seleccionado no está disponible con tu API key.`;
    if (msg.includes('vector_store'))
      return `Error en el almacén vectorial de OpenAI: ${msg}`;

    return msg;
  }

  if (status === 404)
    return 'Asistente no encontrado en OpenAI. Es posible que haya sido eliminado.';
  if (status === 429)
    return 'Demasiadas peticiones a OpenAI. Espera unos segundos e intenta de nuevo.';
  if (status === 500) return 'Error interno de OpenAI. Intenta más tarde.';

  return err.message || 'Error desconocido al conectar con OpenAI.';
}

async function withRetry(fn, { intentos = 5, delayMs = 2000 } = {}) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      const transitorio = [401, 429, 500, 502, 503].includes(status);
      if (!transitorio) throw err;
      ultimoError = err;
      if (i < intentos - 1)
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw ultimoError;
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
    `SELECT id, assistant_id, instrucciones, modelo, nombre,
            vector_store_id, vector_store_docs_id, id_configuracion
     FROM kanban_columnas WHERE id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));

  if (!col.assistant_id) {
    return res.status(200).json({ success: true, data: null });
  }

  const apiKey = await getApiKey(col.id_configuracion);
  const USAR_RESPONSES_API = usaResponsesApi(col.id_configuracion);

  let asistenteData;

  if (USAR_RESPONSES_API) {
    // Nuevo sistema: no hay objeto Assistant en OpenAI, todo vive en BD.
    asistenteData = {
      assistant_id: col.assistant_id,
      nombre: col.nombre,
      instrucciones: col.instrucciones,
      modelo: col.modelo,
    };

    console.log('SISTEMA NUEVO SIN ASSISTANTS');
  } else {
    console.log('SISTEMA VIEJO CON ASSISTANTS');
    try {
      const asstRes = await withRetry(() =>
        axios.get(`https://api.openai.com/v1/assistants/${col.assistant_id}`, {
          headers: headersJson(apiKey),
        }),
      );
      const asst = asstRes.data;
      asistenteData = {
        assistant_id: asst.id,
        nombre: asst.name,
        instrucciones: asst.instructions,
        modelo: asst.model,
      };
    } catch (err) {
      const mensaje = parsearErrorOpenAI(err);
      return next(
        new AppError(
          `Error al obtener asistente: ${mensaje}`,
          err?.response?.status || 500,
        ),
      );
    }
  }

  // Archivos de los vector stores — común a ambos sistemas.
  //
  // Son DOS stores desde que se separó el catálogo de los documentos: el del
  // catálogo (lo maneja la sincronización) y el de documentos (lo que sube el
  // usuario). Se listan los dos y se devuelven juntos para no cambiarle la
  // forma a la respuesta; cada archivo trae `origen` por si el front quiere
  // separarlos en la biblioteca más adelante.
  const listarArchivos = async (vectorStoreId, origen) => {
    if (!vectorStoreId) return [];
    try {
      const vsFiles = await axios.get(
        `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files?limit=20`,
        { headers: headersJson(apiKey) },
      );
      const files = vsFiles.data?.data || [];

      return await Promise.all(
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
              origen,
            };
          } catch {
            return {
              id: f.id,
              nombre: f.id,
              bytes: 0,
              status: f.status,
              origen,
            };
          }
        }),
      );
    } catch (_) {
      /* ignorar error de archivos, no romper el flujo */
      return [];
    }
  };

  const [archivosCatalogo, archivosDocs] = await Promise.all([
    listarArchivos(col.vector_store_id, 'catalogo'),
    listarArchivos(col.vector_store_docs_id, 'documento'),
  ]);
  const archivos = [...archivosDocs, ...archivosCatalogo];

  return res.status(200).json({
    success: true,
    data: {
      ...asistenteData,
      vector_store_id: col.vector_store_id,
      vector_store_docs_id: col.vector_store_docs_id,
      archivos,
    },
  });
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

  const USAR_RESPONSES_API = usaResponsesApi(col.id_configuracion);

  if (USAR_RESPONSES_API) {
    console.log('SISTEMA NUEVO SIN ASSISTANTS');
    // Nuevo sistema: id local, sin llamar a OpenAI
    const assistant_id = `local_${id}_${Date.now()}`;

    await db.query(
      `UPDATE kanban_columnas 
       SET assistant_id = ?, instrucciones = ?, modelo = ?
       WHERE id = ?`,
      {
        replacements: [assistant_id, instruccionesFinal, modelo, id],
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
  }
  console.log('SISTEMA VIEJO CON ASSISTANTS');

  // Sistema viejo: Assistant real en OpenAI
  const apiKey = await getApiKey(col.id_configuracion);

  try {
    const asstRes = await axios.post(
      'https://api.openai.com/v1/assistants',
      { name: nombreFinal, instructions: instruccionesFinal, model: modelo },
      { headers: headersJson(apiKey) },
    );

    const assistant_id = asstRes.data?.id;
    if (!assistant_id) throw new Error('OpenAI no devolvió un assistant_id');

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
    `SELECT kc.id, kc.id_configuracion, kc.assistant_id, kc.nombre,
            c.kanban_global_id
     FROM kanban_columnas kc
     JOIN configuraciones c ON c.id = kc.id_configuracion
     WHERE kc.id = ? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));

  const usaGlobal = !!col.kanban_global_id;
  let instruccionesFinal = instrucciones ?? null;

  // ─────────────────────────────────────────────────────────
  // Si la columna usa plantilla global y el cliente edita la
  // estructura a mano: el texto del cliente PASA A SER el nuevo
  // snapshot. Así el modal de personalización ya NO revierte.
  // ─────────────────────────────────────────────────────────
  if (usaGlobal && typeof instrucciones === 'string' && instrucciones.trim()) {
    const [perso] = await db.query(
      `SELECT nombre_tienda, nombre_asistente_publico, instrucciones_extra,
              info_envio, productos_destacados, tono_personalizado
       FROM kanban_columnas_personalizaciones
       WHERE id_kanban_columna = ? LIMIT 1`,
      { replacements: [id], type: db.QueryTypes.SELECT },
    );

    let estructura = quitarBloqueInstruccionesExtra(instrucciones);

    if (!estructura.includes('[BLOQUE_INSTRUCCIONES_EXTRA]')) {
      estructura = `${estructura.trim()}\n\n[BLOQUE_INSTRUCCIONES_EXTRA]`;
    }

    await db.query(
      `INSERT INTO kanban_columnas_personalizaciones
         (id_kanban_columna, id_configuracion, prompt_base_snapshot)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE prompt_base_snapshot = VALUES(prompt_base_snapshot)`,
      {
        replacements: [id, col.id_configuracion, estructura],
        type: db.QueryTypes.INSERT,
      },
    );

    instruccionesFinal = compilarPromptFinal(estructura, perso || {});
  }

  await db.query(
    `UPDATE kanban_columnas
     SET activa_ia = ?, max_tokens = ?, instrucciones = ?, modelo = ?
     WHERE id = ?`,
    {
      replacements: [
        activa_ia ?? null,
        max_tokens ?? null,
        instruccionesFinal,
        modelo ?? null,
        id,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );

  const USAR_RESPONSES_API = usaResponsesApi(col.id_configuracion);

  // OpenAI: solo sistema viejo (hay Assistant real que sincronizar)
  if (
    !USAR_RESPONSES_API &&
    col.assistant_id &&
    (nombre || instruccionesFinal || modelo)
  ) {
    console.log('SISTEMA VIEJO CON ASSISTANTS');
    const apiKey = await getApiKey(col.id_configuracion);
    const MODELOS_VALIDOS = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
    const modeloFinal =
      modelo && MODELOS_VALIDOS.includes(modelo) ? modelo : undefined;

    const body = {};
    if (nombre) body.name = nombre.trim();
    if (instruccionesFinal) body.instructions = instruccionesFinal.trim();
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
  } else {
    console.log('SISTEMA NUEVO SIN ASSISTANTS');
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

  const MAX_BYTES = 100 * 1024 * 1024;
  if (archivo.size > MAX_BYTES) {
    const mb = (archivo.size / (1024 * 1024)).toFixed(1);
    return next(
      new AppError(`El archivo (${mb} MB) supera el límite de 100 MB.`, 400),
    );
  }

  const [col] = await db.query(
    `SELECT id, id_configuracion, assistant_id, vector_store_id,
            vector_store_docs_id
       FROM kanban_columnas WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));
  if (!col.assistant_id)
    return next(
      new AppError('La columna no tiene asistente. Créalo primero.', 400),
    );

  const apiKey = await getApiKey(col.id_configuracion);
  const USAR_RESPONSES_API = usaResponsesApi(col.id_configuracion);
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
    //
    // Con docs separados el archivo va a vector_store_docs_id, que la
    // sincronización nunca toca. Antes iba al mismo store del catálogo, y como
    // el sync lo recrea entero en cada corrida, el archivo del usuario se
    // borraba en cuanto alguien guardaba un producto.
    const docsSeparados =
      USAR_RESPONSES_API ||
      CONFIGS_CON_DOCS_SEPARADOS.includes(Number(col.id_configuracion));
    const campoVs = docsSeparados ? 'vector_store_docs_id' : 'vector_store_id';

    let vectorStoreId = docsSeparados
      ? col.vector_store_docs_id
      : col.vector_store_id;

    if (!vectorStoreId) {
      const vsRes = await axios.post(
        'https://api.openai.com/v1/vector_stores',
        {
          name: docsSeparados
            ? `kanban_docs_${col.id}_${Date.now()}`
            : `kanban_${col.id}_${Date.now()}`,
        },
        { headers: headersJson(apiKey) },
      );
      vectorStoreId = vsRes.data?.id;
      if (!vectorStoreId) throw new Error('No se pudo crear vector store');

      await db.query(
        `UPDATE kanban_columnas SET ${campoVs} = ? WHERE id = ?`,
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
    // OJO: solo sistema viejo. En el nuevo, assistant_id es local_...
    // (no existe en OpenAI) y este GET tiraría 404.
    if (!USAR_RESPONSES_API) {
      console.log('SISTEMA VIEJO CON ASSISTANTS');
      const asstRes = await axios.get(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        { headers: headersJson(apiKey) },
      );
      const tools = Array.isArray(asstRes.data?.tools)
        ? asstRes.data.tools
        : [];
      const tieneFileSearch = tools.some((t) => t?.type === 'file_search');

      // ⚠️ UN SOLO store. tool_resources.file_search.vector_store_ids admite
      // máximo 1 en la Assistants API: con 2 devuelve 400 "array too long.
      // Expected an array with maximum length 1". El máximo de 2 es de la
      // Responses API, por llamada — son dos límites distintos. Y se reemplaza
      // entero, no se fusiona, así que el que se mande es el único que queda.
      //
      // Con un solo cupo:
      //   - cuenta con catálogo inline → los DOCUMENTOS, porque el catálogo ya
      //     viaja dentro de las instrucciones y no necesita búsqueda.
      //   - cuenta sin inline → el CATÁLOGO, que es lo único que el modelo no
      //     puede saber de memoria. Ahí los documentos conviven en ese mismo
      //     store, que es como funcionó siempre.
      const storeAsistente =
        usaCatalogoInline(col.id_configuracion) && docsSeparados
          ? vectorStoreId
          : col.vector_store_id || vectorStoreId;

      await axios.post(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        {
          tools: tieneFileSearch ? tools : [...tools, { type: 'file_search' }],
          tool_resources: {
            file_search: { vector_store_ids: [storeAsistente] },
          },
        },
        { headers: headersJson(apiKey) },
      );
    } else {
      console.log('SISTEMA NUEVO SIN ASSISTANTS');
    }

    return res.status(200).json({
      success: true,
      file_id,
      nombre: archivo.originalname,
      bytes: archivo.size,
      status: 'completed',
      origen: docsSeparados ? 'documento' : 'catalogo',
      // Se devuelven los dos por separado para que el front no tenga que
      // adivinar cuál cambió. Los que ya usan `vector_store_id` siguen
      // recibiéndolo con el mismo significado de siempre.
      vector_store_id: docsSeparados ? col.vector_store_id : vectorStoreId,
      vector_store_docs_id: docsSeparados
        ? vectorStoreId
        : col.vector_store_docs_id,
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
    `SELECT id, id_configuracion, vector_store_id, vector_store_docs_id
       FROM kanban_columnas WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!col) return next(new AppError('Columna no encontrada', 404));

  const apiKey = await getApiKey(col.id_configuracion);
  const errores = [];

  // El archivo puede estar en cualquiera de los dos stores y el front no manda
  // en cuál: se intenta en ambos y basta con que uno funcione. Un 404 en el
  // otro es lo esperado, no un error que valga la pena mostrar.
  const stores = [col.vector_store_id, col.vector_store_docs_id].filter(
    Boolean,
  );
  let desvinculado = false;

  for (const vsId of stores) {
    try {
      await axios.delete(
        `https://api.openai.com/v1/vector_stores/${vsId}/files/${file_id}`,
        { headers: headersJson(apiKey) },
      );
      desvinculado = true;
    } catch (_) {
      /* el archivo no estaba en este store */
    }
  }

  if (stores.length && !desvinculado) {
    errores.push(
      'No se pudo quitar del vector store: el archivo no estaba en ninguno.',
    );
  }

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

exports.chat_prueba = catchAsync(async (req, res, next) => {
  const { id, mensaje, previous_response_id } = req.body;

  if (!id || !mensaje) return next(new AppError('Faltan campos', 400));

  const [columna] = await db.query(
    `SELECT kc.instrucciones, kc.modelo, kc.vector_store_id,
            kc.vector_store_docs_id, kc.id_configuracion, c.api_key_openai
     FROM kanban_columnas kc
     INNER JOIN configuraciones c ON c.id = kc.id_configuracion
     WHERE kc.id = ? AND kc.activo = 1 LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );

  if (!columna) return next(new AppError('Columna no encontrada', 404));
  if (!columna.api_key_openai)
    return next(new AppError('Sin API key de OpenAI', 400));

  /* Mismo contexto que en producción (sedes, disponibilidad de la agenda). Sin
     esto la prueba mentía: el prompt decide la cobertura con la lista de sedes
     y aquí esa lista no llegaba, así que el bot mandaba fuera de zona hasta a
     la ciudad donde el negocio tiene local. */
  const acciones = await db.query(
    `SELECT tipo_accion, config FROM kanban_acciones
      WHERE id_kanban_columna = ? AND activo = 1 ORDER BY orden ASC`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  const bloqueContexto = await construirContextoColumna(
    columna.id_configuracion,
    acciones,
    null,
    { mensaje },
  );

  const headers = {
    Authorization: `Bearer ${columna.api_key_openai}`,
    'Content-Type': 'application/json',
  };

  const tools = [];
  // El tope de fragmentos solo se aplica a las configs de CONFIGS_CON_TOPE.
  // Aquí importa pasar el id: a diferencia del flujo de producción, el chat de
  // prueba usa la Responses API para CUALQUIER cuenta, no solo las migradas.
  const toolBusqueda = toolFileSearchResponses(
    [columna.vector_store_id, columna.vector_store_docs_id],
    columna.id_configuracion,
  );
  if (toolBusqueda) {
    tools.push(toolBusqueda);
  }

  const body = {
    model: columna.modelo || 'gpt-4o-mini',
    instructions: columna.instrucciones,
    input: bloqueContexto.trim()
      ? `🧾 Contexto adicional:\n\n${bloqueContexto.trim()}\n\n${mensaje}`
      : mensaje,
    store: true,
    ...(tools.length > 0 && { tools }),
    ...(previous_response_id && { previous_response_id }),
  };

  let response;
  try {
    response = await axios.post('https://api.openai.com/v1/responses', body, {
      headers,
      timeout: 140000,
    });
  } catch (err) {
    console.log('\n========== 🔴 ERROR DE OPENAI ==========');
    console.log('HTTP Status:', err.response?.status);
    console.log('Error code:', err.code);
    console.log('Error message:', err.message);
    console.log('---- BODY DE RESPUESTA DE OPENAI ----');
    console.log(JSON.stringify(err.response?.data, null, 2));
    console.log('========================================\n');

    return next(
      new AppError(
        err.response?.data?.error?.message ||
          err.message ||
          'Error llamando a OpenAI',
        err.response?.status || 500,
      ),
    );
  }

  const data = response.data;

  const outputText =
    data.output_text ||
    data.output
      ?.filter((o) => o.type === 'message')
      ?.flatMap((o) => o.content)
      ?.filter((c) => c.type === 'output_text')
      ?.map((c) => c.text)
      ?.join('') ||
    '';

  /* Mismo post-proceso que producción. El chat de prueba mostraba el texto
     crudo, así que la fecha del bloque de agendamiento se veía "2026-08-06
     16:00" y parecía un error del prompt — cuando en WhatsApp al cliente ya le
     llega "jueves 6 de agosto, 16:00". Probar contra algo distinto de lo que
     recibe el cliente hace perder tiempo persiguiendo fallas que no existen. */
  const respuestaLimpia = humanizarFechas(
    limpiarColetillas(sanitizarRespuestaAgente(outputText)),
  );

  /* Qué habría hecho el tablero con esta respuesta.
     Probar el bot sin ver esto es probar a medias: la conversación puede sonar
     perfecta y no mover la tarjeta porque el asistente nunca escribió el tag, y
     desde la pantalla no hay forma de distinguir un caso del otro. */
  const acciones_detectadas = [];
  const texto = String(outputText || '').toLowerCase();

  for (const ac of acciones) {
    let cfg = ac.config;
    if (typeof cfg === 'string') {
      try {
        cfg = JSON.parse(cfg);
      } catch (_) {
        cfg = {};
      }
    }
    const trigger = cfg?.trigger;
    if (!trigger || !texto.includes(String(trigger).toLowerCase())) continue;

    acciones_detectadas.push({
      trigger,
      tipo_accion: ac.tipo_accion,
      estado_destino: cfg.estado_destino || null,
    });
  }

  /* A dónde pasaría la conversación. En producción, tras un cambio de estado el
     siguiente mensaje lo contesta el asistente de ESA columna; el chat de prueba
     seguía hablando con el mismo y hacía creer que Contacto Inicial agenda
     citas, cuando en realidad ya no le tocaba a él. */
  let siguiente = null;
  const destino = acciones_detectadas.find(
    (a) => a.tipo_accion === 'cambiar_estado' && a.estado_destino,
  );
  if (destino) {
    const [col] = await db.query(
      `SELECT id, nombre, activa_ia FROM kanban_columnas
        WHERE id_configuracion = ? AND estado_db = ? AND activo = 1 LIMIT 1`,
      {
        replacements: [columna.id_configuracion, destino.estado_destino],
        type: db.QueryTypes.SELECT,
      },
    );
    if (col) {
      siguiente = {
        id: col.id,
        nombre: col.nombre,
        estado_db: destino.estado_destino,
        // Sin IA la conversación la sigue una persona: no hay a quién escribirle.
        activa_ia: Number(col.activa_ia) === 1,
      };
    }
  }

  return res.json({
    success: true,
    respuesta: respuestaLimpia,
    response_id: data.id,
    acciones_detectadas,
    siguiente_columna: siguiente,
    // Los triggers que esta columna sabe reconocer, para poder decir "esperaba
    // uno de estos y no llegó ninguno" en vez de solo callar.
    triggers_disponibles: [
      ...new Set(
        acciones
          .map((a) => {
            try {
              const c =
                typeof a.config === 'string' ? JSON.parse(a.config) : a.config;
              return c?.trigger || null;
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean),
      ),
    ],
  });
});
