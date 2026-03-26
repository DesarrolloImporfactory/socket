// services/syncCatalogoKanbanColumna.service.js
// Basado en syncCatalogoAsistentesPorConfiguracion pero targeting kanban_columnas.
// Sincroniza el catálogo de productos al vector store del asistente
// ligado a UNA columna Kanban específica.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const FormData = require('form-data');
const { db } = require('../database/config');

// ─────────────────────────────────────────────────────────────
// syncCatalogoKanbanColumna
// @param {number}   id_kanban_columna  — PK de kanban_columnas
// @param {object}   opts
// @param {string}   opts.apiKeyOpenAI  — opcional (si no, busca de configuraciones)
// @param {function} opts.logger        — async logger opcional
// ─────────────────────────────────────────────────────────────
async function syncCatalogoKanbanColumna(id_kanban_columna, opts = {}) {
  const logger = opts.logger || (async (...a) => console.log(...a));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 1. Obtener datos de la columna ────────────────────────
  const [columna] = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.nombre, kc.estado_db,
            kc.assistant_id, kc.vector_store_id, kc.catalog_file_id
     FROM   kanban_columnas kc
     WHERE  kc.id = ?`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  if (!columna)
    throw new Error(`kanban_columna id=${id_kanban_columna} no encontrada`);
  if (!columna.assistant_id)
    throw new Error(
      `La columna "${columna.nombre}" no tiene assistant_id configurado`,
    );

  const {
    id_configuracion,
    assistant_id,
    vector_store_id: currentVsId,
    catalog_file_id: previousFileId,
  } = columna;

  // ── 2. Obtener API key ────────────────────────────────────
  const apiKey = opts.apiKeyOpenAI || (await getApiKey(id_configuracion));

  const headersJson = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
  const headersBase = {
    Authorization: `Bearer ${apiKey}`,
    'OpenAI-Beta': 'assistants=v2',
  };

  // ── 3. Obtener catálogo de productos ─────────────────────
  const productos = await db.query(
    `SELECT pc.id AS id_producto, pc.id_configuracion,
            pc.nombre, pc.descripcion, pc.tipo, pc.precio,
            pc.duracion, pc.id_categoria, pc.imagen_url, pc.video_url,
            pc.stock, pc.nombre_upsell, pc.descripcion_upsell,
            pc.precio_upsell, pc.imagen_upsell_url, pc.combos_producto,
            pc.fecha_actualizacion, cc.nombre AS nombre_categoria
     FROM   productos_chat_center pc
     LEFT JOIN categorias_chat_center cc ON cc.id = pc.id_categoria
     WHERE  pc.id_configuracion = ?
     ORDER  BY pc.id DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!productos.length) {
    await logger(
      `ℹ️ Sin productos para id_configuracion=${id_configuracion}. No se sincroniza.`,
    );
    return { ok: true, skipped: true, reason: 'Sin productos' };
  }

  const catalogoNormalizado = normalizeCatalogProducts(productos);

  // Separar productos de servicios (igual que syncCatalogoAsistentesPorConfiguracion)
  const catalogoProductos = catalogoNormalizado.filter(
    (p) => String(p.tipo || '').toLowerCase() !== 'servicio',
  );
  const catalogoServicios = catalogoNormalizado.filter(
    (p) => String(p.tipo || '').toLowerCase() === 'servicio',
  );
  const itemsFinales = catalogoProductos.length
    ? catalogoProductos
    : catalogoServicios;
  const tipoCatalogo = catalogoProductos.length ? 'productos' : 'servicios';

  const catalogPayload = {
    schema_version: '1.0',
    id_configuracion: Number(id_configuracion),
    id_kanban_columna: Number(id_kanban_columna),
    columna_nombre: columna.nombre,
    tipo_catalogo: tipoCatalogo,
    generado_en: new Date().toISOString(),
    total_items: itemsFinales.length,
    items: itemsFinales,
    instrucciones_uso_ia: [
      'Use este catálogo como base de conocimiento.',
      'Cada item puede incluir un campo "bloque_prompt" con etiquetas compatibles con datos_pedido.',
      'Use los identificadores [producto_imagen_url], [producto_video_url], [upsell_imagen_url] cuando existan.',
      'No asuma stock/precio en tiempo real si el sistema provee esos datos por base de datos.',
      'Priorice datos en tiempo real sobre file_search si hay diferencias.',
    ],
  };

  // ── 4. Crear o reutilizar vector store ───────────────────
  const vectorStoreId = await createOrReuseVectorStore(
    currentVsId,
    id_configuracion,
    columna.nombre,
    headersJson,
    logger,
  );

  // ── 5. Subir archivo catálogo ─────────────────────────────
  const newFileId = await uploadCatalogFile(
    catalogPayload,
    id_configuracion,
    columna.estado_db,
    headersBase,
    logger,
  );

  // ── 6. Adjuntar al vector store ───────────────────────────
  const { vectorStoreFileId } = await attachFileToVectorStore(
    vectorStoreId,
    newFileId,
    headersJson,
    logger,
  );

  // ── 7. Esperar indexación ─────────────────────────────────
  await waitVectorStoreFileProcessed(
    vectorStoreId,
    vectorStoreFileId,
    headersJson,
    logger,
    sleep,
  );

  // ── 8. Asegurar file_search en el asistente ───────────────
  await ensureAssistantHasFileSearch(
    assistant_id,
    vectorStoreId,
    headersJson,
    logger,
  );

  // ── 9. Guardar IDs en kanban_columnas ─────────────────────
  await db.query(
    `UPDATE kanban_columnas
     SET vector_store_id = ?, catalog_file_id = ?
     WHERE id = ?`,
    {
      replacements: [vectorStoreId, newFileId, id_kanban_columna],
      type: db.QueryTypes.UPDATE,
    },
  );

  // ── 10. Eliminar archivo anterior ────────────────────────
  if (previousFileId && previousFileId !== newFileId) {
    await deleteFileIfExists(
      previousFileId,
      vectorStoreId,
      headersBase,
      headersJson,
      logger,
    );
  }

  await logger(
    `✅ Sync completo: columna="${columna.nombre}" assistant=${assistant_id} items=${catalogoNormalizado.length}`,
  );

  return {
    ok: true,
    id_kanban_columna,
    id_configuracion,
    assistant_id,
    vector_store_id: vectorStoreId,
    catalog_file_id: newFileId,
    total_items: catalogoNormalizado.length,
  };
}

// ─────────────────────────────────────────────────────────────
// syncCatalogoTodasColumnasConfig
// Sincroniza todas las columnas activas de una configuración
// que tengan activa_ia=1 y contexto_productos habilitado.
// ─────────────────────────────────────────────────────────────
async function syncCatalogoTodasColumnasConfig(id_configuracion, opts = {}) {
  const logger = opts.logger || (async (...a) => console.log(...a));

  // Columnas con IA activa Y acción contexto_productos
  const columnas = await db.query(
    `SELECT DISTINCT kc.id
     FROM   kanban_columnas kc
     INNER JOIN kanban_acciones ka ON ka.id_kanban_columna = kc.id
     WHERE  kc.id_configuracion = ?
       AND  kc.activo = 1
       AND  kc.activa_ia = 1
       AND  kc.assistant_id IS NOT NULL
       AND  ka.tipo_accion = 'contexto_productos'
       AND  ka.activo = 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!columnas.length) {
    await logger(
      `ℹ️ Sin columnas con contexto_productos para id_configuracion=${id_configuracion}`,
    );
    return { ok: true, skipped: true };
  }

  const apiKey = opts.apiKeyOpenAI || (await getApiKey(id_configuracion));
  const resultados = [];

  for (const { id } of columnas) {
    try {
      const r = await syncCatalogoKanbanColumna(id, {
        ...opts,
        apiKeyOpenAI: apiKey,
        logger,
      });
      resultados.push(r);
    } catch (err) {
      await logger(`⚠️ Error sync columna id=${id}: ${err.message}`);
      resultados.push({ ok: false, id_kanban_columna: id, error: err.message });
    }
  }

  return {
    ok: resultados.every((r) => r.ok),
    id_configuracion,
    resultados,
  };
}

// ══════════════════════════════════════════════════════════════
// Helpers internos
// ══════════════════════════════════════════════════════════════

async function getApiKey(id_configuracion) {
  const [row] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!row?.api_key_openai)
    throw new Error(
      `No se encontró api_key_openai para id_configuracion=${id_configuracion}`,
    );
  return row.api_key_openai;
}

async function createOrReuseVectorStore(
  existingId,
  id_configuracion,
  columnaNombre,
  headersJson,
  logger,
) {
  // ← Verificar que el vector store existente siga vivo en OpenAI
  if (existingId) {
    try {
      await axios.get(`https://api.openai.com/v1/vector_stores/${existingId}`, {
        headers: headersJson,
      });
      await logger(`♻️ Reutilizando vector store: ${existingId}`);
      return existingId;
    } catch (err) {
      await logger(
        `⚠️ Vector store ${existingId} no existe en OpenAI (${err?.response?.status}) — creando uno nuevo`,
      );
      // Limpiar el ID inválido de la BD
      await db.query(
        `UPDATE kanban_columnas SET vector_store_id = NULL WHERE id_configuracion = ? AND vector_store_id = ?`,
        {
          replacements: [id_configuracion, existingId],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
  }

  const res = await axios.post(
    'https://api.openai.com/v1/vector_stores',
    {
      name: `kanban_catalogo_${id_configuracion}_${columnaNombre}_${Date.now()}`,
    },
    { headers: headersJson },
  );
  const vsId = res?.data?.id;
  if (!vsId) throw new Error('No se pudo crear vector_store');
  await logger(`✅ Vector store creado: ${vsId}`);
  return vsId;
}

async function uploadCatalogFile(
  catalogPayload,
  id_configuracion,
  estado_db,
  headersBase,
  logger,
) {
  const filename = `catalogo_${id_configuracion}_${estado_db}_${Date.now()}.json`;
  const buffer = Buffer.from(JSON.stringify(catalogPayload, null, 2), 'utf8');

  const form = new FormData();
  form.append('purpose', 'assistants');
  form.append('file', buffer, { filename, contentType: 'application/json' });

  const res = await axios.post('https://api.openai.com/v1/files', form, {
    headers: { ...headersBase, ...form.getHeaders() },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const fileId = res?.data?.id;
  if (!fileId) throw new Error('No se pudo subir el archivo catálogo');
  await logger(`✅ Archivo catálogo subido: ${fileId}`);
  return fileId;
}

async function attachFileToVectorStore(
  vectorStoreId,
  fileId,
  headersJson,
  logger,
) {
  const res = await axios.post(
    `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
    { file_id: fileId },
    { headers: headersJson },
  );
  const vectorStoreFileId = res?.data?.id;
  await logger(
    `📎 Archivo ${fileId} adjunto al vector store ${vectorStoreId} vsFileId=${vectorStoreFileId}`,
  );
  return { vectorStoreFileId, status: res?.data?.status };
}

async function waitVectorStoreFileProcessed(
  vectorStoreId,
  vectorStoreFileId,
  headersJson,
  logger,
  sleep,
  maxAttempts = 60,
) {
  for (let i = 1; i <= maxAttempts; i++) {
    const res = await axios.get(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${vectorStoreFileId}`,
      { headers: headersJson },
    );
    const status = res?.data?.status;
    await logger(`⏳ Indexando (intento ${i}/${maxAttempts}) status=${status}`);
    if (status === 'completed') return true;
    if (status === 'failed' || status === 'cancelled')
      throw new Error(
        `Falló indexación vsFile=${vectorStoreFileId} status=${status}`,
      );
    await sleep(2000);
  }
  throw new Error(`Timeout indexando vsFile=${vectorStoreFileId}`);
}

async function ensureAssistantHasFileSearch(
  assistantId,
  vectorStoreId,
  headersJson,
  logger,
) {
  const getRes = await axios.get(
    `https://api.openai.com/v1/assistants/${assistantId}`,
    { headers: headersJson },
  );
  const currentTools = Array.isArray(getRes.data?.tools)
    ? getRes.data.tools
    : [];
  const hasFileSearch = currentTools.some((t) => t?.type === 'file_search');
  const tools = hasFileSearch
    ? currentTools
    : [...currentTools, { type: 'file_search' }];

  await axios.post(
    `https://api.openai.com/v1/assistants/${assistantId}`,
    {
      tools,
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    },
    { headers: headersJson },
  );
  await logger(
    `✅ Assistant ${assistantId} actualizado con file_search + vector_store ${vectorStoreId}`,
  );
}

async function deleteFileIfExists(
  fileId,
  vectorStoreId,
  headersBase,
  headersJson,
  logger,
) {
  try {
    // ── 1. Desvincular del vector store primero ──
    if (vectorStoreId) {
      try {
        await axios.delete(
          `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${fileId}`,
          { headers: headersJson },
        );
        await logger(
          `🔗 Archivo ${fileId} desvinculado del vector store ${vectorStoreId}`,
        );
      } catch (err) {
        await logger(
          `⚠️ No se pudo desvincular ${fileId} del vector store: ${err?.response?.data?.error?.message || err.message}`,
        );
      }
    }

    // ── 2. Eliminar el archivo de OpenAI Files ──
    await axios.delete(`https://api.openai.com/v1/files/${fileId}`, {
      headers: headersBase,
    });
    await logger(`🗑️ Archivo anterior eliminado: ${fileId}`);
  } catch (err) {
    await logger(
      `⚠️ No se pudo eliminar archivo ${fileId}: ${err?.response?.data?.error?.message || err.message}`,
    );
  }
}

// ── Normalizar productos (idéntico a syncCatalogoAsistentesPorConfiguracion) ──
function safeJSONParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatearCombosParaCatalogo(combosProducto) {
  const combos = safeJSONParse(combosProducto, null);
  if (!combos) return { combos_json: null, combos_texto: '' };

  let combosNormalizados = combos;
  let combosTexto = '';

  try {
    if (Array.isArray(combosNormalizados) && combosNormalizados.length > 0) {
      combosTexto += `Combos disponibles:\n`;
      combosNormalizados.forEach((c, i) => {
        const nombre = c?.nombre || c?.titulo || `Combo ${i + 1}`;
        const precio = c?.precio ?? c?.valor ?? '';
        const cantidad = c?.cantidad ?? '';
        combosTexto += `- ${nombre}`;
        if (cantidad) combosTexto += ` | Cantidad: ${cantidad}`;
        if (precio !== '') combosTexto += ` | Precio: ${precio}`;
        combosTexto += `\n`;
      });
    } else if (typeof combosNormalizados === 'object') {
      combosTexto += `Combos disponibles:\n${JSON.stringify(combosNormalizados, null, 2)}`;
    }
  } catch (_) {}

  return { combos_json: combosNormalizados, combos_texto: combosTexto.trim() };
}

function normalizeCatalogProducts(rows) {
  return rows.map((r) => {
    const { combos_json, combos_texto } = formatearCombosParaCatalogo(
      r.combos_producto,
    );

    let bloque_prompt = '';
    bloque_prompt += `🛒 Producto: ${r.nombre || ''}\n`;
    bloque_prompt += `📃 Descripción: ${r.descripcion || ''}\n`;
    bloque_prompt += `Precio: ${r.precio ?? ''}\n`;
    if (combos_texto) bloque_prompt += `${combos_texto}\n`;
    if (r.imagen_url)
      bloque_prompt += `[producto_imagen_url]: ${r.imagen_url}\n`;
    if (r.video_url) bloque_prompt += `[producto_video_url]: ${r.video_url}\n`;
    bloque_prompt += `Tipo: ${r.tipo || ''}\n`;
    bloque_prompt += `Categoría: ${r.nombre_categoria || ''}\n`;
    bloque_prompt += `Nombre_upsell: ${r.nombre_upsell || ''}\n`;
    bloque_prompt += `Descripcion_upsell: ${r.descripcion_upsell || ''}\n`;
    bloque_prompt += `Precio_upsell: ${r.precio_upsell ?? ''}\n`;
    if (r.imagen_upsell_url)
      bloque_prompt += `[upsell_imagen_url]: ${r.imagen_upsell_url}\n`;

    console.log('bloque_prompt: ' + bloque_prompt);

    return {
      // Metadatos
      id_producto: r.id_producto,
      id_configuracion: r.id_configuracion,
      actualizado_en: r.fecha_actualizacion || null,

      // Campos estructurados
      nombre: r.nombre || '',
      descripcion: r.descripcion || '',
      tipo: r.tipo || '',
      precio: r.precio ?? null,
      duracion: r.duracion ?? null,
      stock: r.stock ?? null,
      id_categoria: r.id_categoria ?? null,
      nombre_categoria: r.nombre_categoria || null,

      // Campos que el prompt reconoce mejor
      nombre_producto: r.nombre || '',
      descripcion_producto: r.descripcion || '',
      precio_producto: r.precio ?? null,
      producto_imagen_url: r.imagen_url || null,
      producto_video_url: r.video_url || null,

      nombre_upsell: r.nombre_upsell || null,
      descripcion_upsell: r.descripcion_upsell || null,
      precio_upsell: r.precio_upsell ?? null,
      upsell_imagen_url: r.imagen_upsell_url || null,

      combos_producto: combos_json,
      combos_producto_texto: combos_texto,

      bloque_prompt: bloque_prompt.trim(),
    };
  });
}

module.exports = { syncCatalogoKanbanColumna, syncCatalogoTodasColumnasConfig };
