// ════════════════════════════════════════════════════════════
// kanban_archivos.service.js
// Archivos de conocimiento de las columnas del Kanban IA.
//
// El catálogo de productos y los documentos que sube el cliente viven en
// vector stores SEPARADOS:
//
//   kanban_columnas.vector_store_id       → catálogo. Lo recrea desde cero
//                                           syncCatalogoKanbanColumna en cada
//                                           guardado de producto.
//   kanban_columnas.vector_store_docs_id  → documentos. Persistente, el sync
//                                           NO lo toca.
//
// Antes ambos compartían vector_store_id y la limpieza del sync borraba los
// documentos del cliente de OpenAI Files sin avisar.
//
// La Responses API acepta los dos a la vez (verificado: el máximo son 2 vector
// stores por llamada; con 3 responde 400 "maximum of 2 vector stores allowed").
// El sistema viejo de Assistants solo admite 1 por asistente, así que en esas
// configuraciones el archivo se adjunta ADEMÁS al store del catálogo y el sync
// lo vuelve a enganchar tras reconstruirlo.
// ════════════════════════════════════════════════════════════

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { db } = require('../database/config');
const { usaResponsesApi } = require('../utils/openia/responsesApi');

// Tipos aceptados por OpenAI para file_search
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

const FORMATOS_LEGIBLES =
  'PDF, DOCX, TXT, CSV, JSON, MD, XLSX, PPTX, HTML';

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

// Tope por cuenta. Cada archivo indexado se paga dos veces: almacenamiento del
// vector store en OpenAI y tokens de retrieval en CADA mensaje del bot. Sin
// techo, una cuenta sube 40 PDFs e infla la factura de todas sus conversaciones.
const MAX_ARCHIVOS_POR_CONFIGURACION = 25;

const DIR_UPLOADS = path.join(__dirname, '..', 'uploads', 'kanban_docs');

// ─────────────────────────────────────────────────────────────
// Helpers de infraestructura
// ─────────────────────────────────────────────────────────────
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

const headersJson = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2',
});

const headersBase = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  'OpenAI-Beta': 'assistants=v2',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function obtenerColumna(id_kanban_columna) {
  const [col] = await db.query(
    `SELECT id, id_configuracion, assistant_id, vector_store_id,
            vector_store_docs_id
     FROM kanban_columnas WHERE id = ? LIMIT 1`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );
  return col || null;
}

// ─────────────────────────────────────────────────────────────
// guardarCopiaLocal
// Sin copia local, si el archivo se pierde en OpenAI no hay forma de
// re-indexarlo: habría que pedirle al cliente que lo vuelva a subir.
// Un fallo aquí NO tumba la subida — el archivo ya está en OpenAI.
// ─────────────────────────────────────────────────────────────
async function guardarCopiaLocal(buffer, id_configuracion, nombreOriginal) {
  try {
    const dir = path.join(DIR_UPLOADS, String(id_configuracion));
    await fs.promises.mkdir(dir, { recursive: true });

    const safe = String(nombreOriginal || 'archivo')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(-120);
    const filename = `${Date.now()}_${safe}`;
    await fs.promises.writeFile(path.join(dir, filename), buffer);

    // Ruta relativa: la absoluta cambia entre local y el server de producción.
    return path.posix.join('kanban_docs', String(id_configuracion), filename);
  } catch (err) {
    console.error(`[kanban_archivos] No se pudo guardar copia local:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// asegurarVectorStoreDocs
// Crea el vector store de documentos de la columna si todavía no existe y lo
// persiste. Es el único punto donde nace ese store.
// ─────────────────────────────────────────────────────────────
async function asegurarVectorStoreDocs(col, apiKey) {
  if (col.vector_store_docs_id) return col.vector_store_docs_id;

  const res = await axios.post(
    'https://api.openai.com/v1/vector_stores',
    { name: `kanban_docs_${col.id_configuracion}_col${col.id}_${Date.now()}` },
    { headers: headersJson(apiKey) },
  );

  const vsId = res.data?.id;
  if (!vsId) throw new Error('OpenAI no devolvió el id del vector store');

  await db.query(
    `UPDATE kanban_columnas SET vector_store_docs_id = ? WHERE id = ?`,
    { replacements: [vsId, col.id], type: db.QueryTypes.UPDATE },
  );

  col.vector_store_docs_id = vsId;
  return vsId;
}

// ─────────────────────────────────────────────────────────────
// adjuntarAVectorStore
// Adjunta un file_id ya existente en OpenAI Files a un vector store y espera
// la indexación. Devuelve { vectorStoreFileId, status }.
// ─────────────────────────────────────────────────────────────
async function adjuntarAVectorStore(vectorStoreId, file_id, apiKey, maxEspera = 30) {
  let vsFileId;

  try {
    const res = await axios.post(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      { file_id },
      { headers: headersJson(apiKey) },
    );
    vsFileId = res.data?.id;
  } catch (err) {
    // Ya estaba adjunto: no es un error, es el estado que queríamos.
    const msg = err?.response?.data?.error?.message || '';
    if (!msg.includes('already')) throw err;
    vsFileId = file_id;
  }

  let status = 'in_progress';
  for (let i = 0; i < maxEspera && status === 'in_progress'; i++) {
    await sleep(1000);
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

  return { vectorStoreFileId: vsFileId, status: status || 'in_progress' };
}

async function desadjuntarDeVectorStore(vectorStoreId, file_id, apiKey) {
  if (!vectorStoreId || !file_id) return;
  try {
    await axios.delete(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${file_id}`,
      { headers: headersJson(apiKey) },
    );
  } catch (err) {
    // 404 = ya no estaba. No es un problema.
    if (err?.response?.status !== 404) throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// sincronizarConAsistenteViejo
// El sistema viejo (Assistants API) solo admite UN vector store por asistente,
// y ese cupo lo ocupa el catálogo. Para que esas configuraciones también vean
// sus documentos, el archivo se adjunta ADEMÁS al store del catálogo.
// El sync lo respeta y lo vuelve a enganchar (ver syncCatalogoKanbanColumna).
//
// En el sistema nuevo esto no se llama: los dos stores van juntos en la
// llamada a /v1/responses.
// ─────────────────────────────────────────────────────────────
async function sincronizarConAsistenteViejo(col, file_id, apiKey) {
  if (!col.vector_store_id) return null;

  try {
    const { vectorStoreFileId } = await adjuntarAVectorStore(
      col.vector_store_id,
      file_id,
      apiKey,
    );
    return vectorStoreFileId;
  } catch (err) {
    console.error(
      `[kanban_archivos] No se pudo adjuntar ${file_id} al store del catálogo:`,
      err?.response?.data?.error?.message || err.message,
    );
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// API pública
// ═════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// validarArchivo — checks que no requieren tocar OpenAI
// ─────────────────────────────────────────────────────────────
function validarArchivo(archivo) {
  if (!archivo) return 'No se recibió ningún archivo';

  if (!MIME_TYPES_PERMITIDOS.has(archivo.mimetype)) {
    return `Formato "${archivo.mimetype || 'desconocido'}" no aceptado por OpenAI. Sube un archivo: ${FORMATOS_LEGIBLES}.`;
  }

  if (archivo.size > MAX_BYTES) {
    const mb = (archivo.size / (1024 * 1024)).toFixed(1);
    return `El archivo (${mb} MB) supera el límite de 100 MB.`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// subirArchivo
// Sube a OpenAI Files, guarda copia local, registra en BD y lo vincula a la
// columna. Devuelve la fila lista para pintar en la UI.
// ─────────────────────────────────────────────────────────────
async function subirArchivo({ id_kanban_columna, archivo, id_sub_usuario = null }) {
  const col = await obtenerColumna(id_kanban_columna);
  if (!col) throw new Error('Columna no encontrada');

  const cuota = await contarArchivos(col.id_configuracion);
  if (cuota >= MAX_ARCHIVOS_POR_CONFIGURACION) {
    throw new Error(
      `Llegaste al límite de ${MAX_ARCHIVOS_POR_CONFIGURACION} archivos de conocimiento en la cuenta. Elimina alguno para subir uno nuevo.`,
    );
  }

  const apiKey = await getApiKey(col.id_configuracion);
  const USAR_RESPONSES_API = usaResponsesApi(col.id_configuracion);

  // 1. Subir los bytes a OpenAI Files
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

  const openai_file_id = fileRes.data?.id;
  if (!openai_file_id) throw new Error('OpenAI no devolvió file_id');

  // 2. Copia local (best-effort)
  const storage_path = await guardarCopiaLocal(
    archivo.buffer,
    col.id_configuracion,
    archivo.originalname,
  );

  // 3. Registrar en la biblioteca de la cuenta
  const [id_archivo] = await db.query(
    `INSERT INTO kanban_archivos
       (id_configuracion, nombre_original, mime, bytes, openai_file_id,
        storage_path, status, id_sub_usuario)
     VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
    {
      replacements: [
        col.id_configuracion,
        archivo.originalname,
        archivo.mimetype,
        archivo.size,
        openai_file_id,
        storage_path,
        id_sub_usuario,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  // 4. Indexar en el vector store de documentos de la columna.
  // Si el indexado falla hay que deshacer el registro: si no, queda una fila
  // huérfana consumiendo cuota y apareciendo en la biblioteca como "pendiente"
  // para un archivo que ninguna columna puede usar.
  let vsDocs;
  let vectorStoreFileId;
  let status;
  try {
    vsDocs = await asegurarVectorStoreDocs(col, apiKey);
    ({ vectorStoreFileId, status } = await adjuntarAVectorStore(
      vsDocs,
      openai_file_id,
      apiKey,
    ));
  } catch (err) {
    await db
      .query(`DELETE FROM kanban_archivos WHERE id = ?`, {
        replacements: [id_archivo],
        type: db.QueryTypes.DELETE,
      })
      .catch(() => {});
    await axios
      .delete(`https://api.openai.com/v1/files/${openai_file_id}`, {
        headers: headersBase(apiKey),
      })
      .catch(() => {});
    throw err;
  }

  await db.query(
    `INSERT INTO kanban_columna_archivos
       (id_kanban_columna, id_archivo, vector_store_id, vector_store_file_id, status)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       vector_store_id = VALUES(vector_store_id),
       vector_store_file_id = VALUES(vector_store_file_id),
       status = VALUES(status)`,
    {
      replacements: [id_kanban_columna, id_archivo, vsDocs, vectorStoreFileId, status],
      type: db.QueryTypes.INSERT,
    },
  );

  await db.query(`UPDATE kanban_archivos SET status = ? WHERE id = ?`, {
    replacements: [status, id_archivo],
    type: db.QueryTypes.UPDATE,
  });

  // 5. Sistema viejo: además al store del catálogo (único cupo del asistente)
  if (!USAR_RESPONSES_API) {
    await sincronizarConAsistenteViejo(col, openai_file_id, apiKey);
  }

  return {
    id: id_archivo,
    file_id: openai_file_id,
    nombre: archivo.originalname,
    bytes: archivo.size,
    mime: archivo.mimetype,
    status,
    vector_store_docs_id: vsDocs,
  };
}

// ─────────────────────────────────────────────────────────────
// vincularArchivo
// Reutiliza un archivo que ya está en la biblioteca de la cuenta: NO resube
// los bytes, solo lo indexa en el vector store de esta columna.
// ─────────────────────────────────────────────────────────────
async function vincularArchivo({ id_kanban_columna, id_archivo }) {
  const col = await obtenerColumna(id_kanban_columna);
  if (!col) throw new Error('Columna no encontrada');

  const [arch] = await db.query(
    `SELECT id, id_configuracion, openai_file_id, nombre_original
     FROM kanban_archivos
     WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    { replacements: [id_archivo], type: db.QueryTypes.SELECT },
  );
  if (!arch) throw new Error('Archivo no encontrado');

  // Un archivo de otra cuenta no puede cruzarse a esta.
  if (Number(arch.id_configuracion) !== Number(col.id_configuracion)) {
    throw new Error('El archivo pertenece a otra configuración');
  }

  const apiKey = await getApiKey(col.id_configuracion);
  const USAR_RESPONSES_API = usaResponsesApi(col.id_configuracion);

  const vsDocs = await asegurarVectorStoreDocs(col, apiKey);
  const { vectorStoreFileId, status } = await adjuntarAVectorStore(
    vsDocs,
    arch.openai_file_id,
    apiKey,
  );

  await db.query(
    `INSERT INTO kanban_columna_archivos
       (id_kanban_columna, id_archivo, vector_store_id, vector_store_file_id, status)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       vector_store_id = VALUES(vector_store_id),
       vector_store_file_id = VALUES(vector_store_file_id),
       status = VALUES(status)`,
    {
      replacements: [id_kanban_columna, arch.id, vsDocs, vectorStoreFileId, status],
      type: db.QueryTypes.INSERT,
    },
  );

  if (!USAR_RESPONSES_API) {
    await sincronizarConAsistenteViejo(col, arch.openai_file_id, apiKey);
  }

  return { id: arch.id, nombre: arch.nombre_original, status };
}

// ─────────────────────────────────────────────────────────────
// desvincularArchivo
// Lo quita de ESTA columna. El archivo sigue en la biblioteca y en las demás
// columnas que lo usen.
// ─────────────────────────────────────────────────────────────
async function desvincularArchivo({ id_kanban_columna, id_archivo }) {
  const col = await obtenerColumna(id_kanban_columna);
  if (!col) throw new Error('Columna no encontrada');

  const [vinculo] = await db.query(
    `SELECT kca.id, kca.vector_store_id, ka.openai_file_id
     FROM kanban_columna_archivos kca
     INNER JOIN kanban_archivos ka ON ka.id = kca.id_archivo
     WHERE kca.id_kanban_columna = ? AND kca.id_archivo = ? LIMIT 1`,
    {
      replacements: [id_kanban_columna, id_archivo],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!vinculo) return { ok: true, yaNoEstaba: true };

  const apiKey = await getApiKey(col.id_configuracion);

  await desadjuntarDeVectorStore(
    vinculo.vector_store_id || col.vector_store_docs_id,
    vinculo.openai_file_id,
    apiKey,
  );

  // Sistema viejo: también estaba en el store del catálogo.
  const USAR_RESPONSES_API = usaResponsesApi(col.id_configuracion);
  if (!USAR_RESPONSES_API && col.vector_store_id) {
    await desadjuntarDeVectorStore(
      col.vector_store_id,
      vinculo.openai_file_id,
      apiKey,
    );
  }

  await db.query(`DELETE FROM kanban_columna_archivos WHERE id = ?`, {
    replacements: [vinculo.id],
    type: db.QueryTypes.DELETE,
  });

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// eliminarArchivo
// Borra el archivo de la cuenta entera: lo desvincula de todas las columnas,
// lo saca de OpenAI Files y borra la copia local.
// ─────────────────────────────────────────────────────────────
async function eliminarArchivo({ id_archivo, id_configuracion }) {
  const [arch] = await db.query(
    `SELECT id, id_configuracion, openai_file_id, storage_path
     FROM kanban_archivos WHERE id = ? LIMIT 1`,
    { replacements: [id_archivo], type: db.QueryTypes.SELECT },
  );
  if (!arch) throw new Error('Archivo no encontrado');

  if (
    id_configuracion != null &&
    Number(arch.id_configuracion) !== Number(id_configuracion)
  ) {
    throw new Error('El archivo pertenece a otra configuración');
  }

  const apiKey = await getApiKey(arch.id_configuracion);
  const errores = [];

  const vinculos = await db.query(
    `SELECT id, id_kanban_columna, vector_store_id
     FROM kanban_columna_archivos WHERE id_archivo = ?`,
    { replacements: [id_archivo], type: db.QueryTypes.SELECT },
  );

  for (const v of vinculos) {
    try {
      await desadjuntarDeVectorStore(
        v.vector_store_id,
        arch.openai_file_id,
        apiKey,
      );
    } catch (err) {
      errores.push(
        `No se pudo quitar del vector store ${v.vector_store_id}: ${err?.response?.data?.error?.message || err.message}`,
      );
    }
  }

  // También del store del catálogo, si el sistema viejo lo había adjuntado ahí.
  const columnas = await db.query(
    `SELECT DISTINCT kc.vector_store_id
     FROM kanban_columna_archivos kca
     INNER JOIN kanban_columnas kc ON kc.id = kca.id_kanban_columna
     WHERE kca.id_archivo = ? AND kc.vector_store_id IS NOT NULL`,
    { replacements: [id_archivo], type: db.QueryTypes.SELECT },
  );
  for (const c of columnas) {
    try {
      await desadjuntarDeVectorStore(
        c.vector_store_id,
        arch.openai_file_id,
        apiKey,
      );
    } catch (_) {
      /* el store del catálogo es efímero: si falla, se recrea igual */
    }
  }

  try {
    await axios.delete(
      `https://api.openai.com/v1/files/${arch.openai_file_id}`,
      { headers: headersBase(apiKey) },
    );
  } catch (err) {
    if (err?.response?.status !== 404) {
      errores.push(
        `No se pudo eliminar de OpenAI: ${err?.response?.data?.error?.message || err.message}`,
      );
    }
  }

  if (arch.storage_path) {
    try {
      await fs.promises.unlink(
        path.join(__dirname, '..', 'uploads', arch.storage_path),
      );
    } catch (_) {
      /* la copia local ya no existe: no es un problema */
    }
  }

  // El ON DELETE CASCADE limpia kanban_columna_archivos.
  await db.query(`DELETE FROM kanban_archivos WHERE id = ?`, {
    replacements: [id_archivo],
    type: db.QueryTypes.DELETE,
  });

  return { ok: errores.length === 0, errores };
}

// ─────────────────────────────────────────────────────────────
// listarArchivosColumna — lo que alimenta a ESTA columna
// Sale de la BD, no de OpenAI: sin N+1 y sin el tope de 20 que tenía la
// lectura anterior contra /vector_stores/{id}/files.
// ─────────────────────────────────────────────────────────────
async function listarArchivosColumna(id_kanban_columna) {
  return db.query(
    `SELECT ka.id, ka.openai_file_id AS file_id, ka.nombre_original AS nombre,
            ka.mime, ka.bytes, ka.created_at, ka.id_sub_usuario,
            kca.status, kca.vector_store_id,
            (SELECT COUNT(*) FROM kanban_columna_archivos x
              WHERE x.id_archivo = ka.id) AS columnas_usando
     FROM kanban_columna_archivos kca
     INNER JOIN kanban_archivos ka ON ka.id = kca.id_archivo
     WHERE kca.id_kanban_columna = ? AND ka.deleted_at IS NULL
     ORDER BY ka.created_at DESC`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );
}

// ─────────────────────────────────────────────────────────────
// listarBiblioteca — todo lo de la cuenta, marcando qué usa esta columna
// ─────────────────────────────────────────────────────────────
async function listarBiblioteca(id_configuracion, id_kanban_columna = null) {
  return db.query(
    `SELECT ka.id, ka.openai_file_id AS file_id, ka.nombre_original AS nombre,
            ka.mime, ka.bytes, ka.status, ka.created_at,
            (SELECT COUNT(*) FROM kanban_columna_archivos x
              WHERE x.id_archivo = ka.id) AS columnas_usando,
            EXISTS (SELECT 1 FROM kanban_columna_archivos y
                     WHERE y.id_archivo = ka.id
                       AND y.id_kanban_columna = ?) AS vinculado
     FROM kanban_archivos ka
     WHERE ka.id_configuracion = ? AND ka.deleted_at IS NULL
     ORDER BY ka.created_at DESC`,
    {
      replacements: [id_kanban_columna, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
}

async function contarArchivos(id_configuracion) {
  const [row] = await db.query(
    `SELECT COUNT(*) AS total FROM kanban_archivos
     WHERE id_configuracion = ? AND deleted_at IS NULL`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return Number(row?.total || 0);
}

// ─────────────────────────────────────────────────────────────
// fileIdsDeColumna
// Los openai_file_id registrados para una columna. Lo usa el sync del catálogo
// para NO borrarlos de OpenAI Files al limpiar los vector stores viejos.
// ─────────────────────────────────────────────────────────────
async function fileIdsDeColumna(id_kanban_columna) {
  const rows = await db.query(
    `SELECT ka.openai_file_id
     FROM kanban_columna_archivos kca
     INNER JOIN kanban_archivos ka ON ka.id = kca.id_archivo
     WHERE kca.id_kanban_columna = ? AND ka.deleted_at IS NULL`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );
  return rows.map((r) => r.openai_file_id).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// reindexarEnCatalogo
// Sistema viejo: tras reconstruir el vector store del catálogo, vuelve a
// enganchar ahí los documentos de la columna, porque el asistente solo puede
// apuntar a UN store. En el sistema nuevo no hace falta — los documentos viven
// en su propio store y viajan como segundo vector_store_id.
// ─────────────────────────────────────────────────────────────
async function reindexarEnCatalogo(id_kanban_columna, vectorStoreId, apiKey, logger) {
  const log = logger || (async () => {});
  const fileIds = await fileIdsDeColumna(id_kanban_columna);
  if (!fileIds.length) return 0;

  let ok = 0;
  for (const file_id of fileIds) {
    try {
      await adjuntarAVectorStore(vectorStoreId, file_id, apiKey, 15);
      ok++;
    } catch (err) {
      await log(
        `⚠️ No se pudo re-adjuntar el documento ${file_id}: ${err?.response?.data?.error?.message || err.message}`,
      );
    }
  }
  await log(`📎 ${ok}/${fileIds.length} documento(s) del cliente re-adjuntados al catálogo`);
  return ok;
}

// ─────────────────────────────────────────────────────────────
// vectorStoresDeColumna
// Los stores que hay que mandar en la llamada, en orden de prioridad.
// OpenAI acepta un MÁXIMO DE 2 (con 3 responde 400), y aquí son exactamente
// dos: documentos + catálogo. No queda cupo para un tercero.
// ─────────────────────────────────────────────────────────────
function vectorStoresDeColumna(columna) {
  return [columna?.vector_store_docs_id, columna?.vector_store_id]
    .filter(Boolean)
    .slice(0, 2);
}

module.exports = {
  MIME_TYPES_PERMITIDOS,
  FORMATOS_LEGIBLES,
  MAX_BYTES,
  MAX_ARCHIVOS_POR_CONFIGURACION,
  validarArchivo,
  subirArchivo,
  vincularArchivo,
  desvincularArchivo,
  eliminarArchivo,
  listarArchivosColumna,
  listarBiblioteca,
  contarArchivos,
  fileIdsDeColumna,
  reindexarEnCatalogo,
  vectorStoresDeColumna,
  asegurarVectorStoreDocs,
};
