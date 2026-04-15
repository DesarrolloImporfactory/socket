// services/syncCatalogoKanbanColumna.service.js

const axios = require('axios');
const FormData = require('form-data');
const { db } = require('../database/config');

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

  const { id_configuracion, assistant_id } = columna;

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

  // ── 3. LIMPIAR TODOS los vector stores del asistente ──────
  // Esto garantiza que al finalizar solo exista 1 VS con 1 archivo.
  await cleanupAllAssistantVectorStores(
    assistant_id,
    headersJson,
    headersBase,
    logger,
  );

  // Limpiar también los IDs viejos en BD para esta columna
  await db.query(
    `UPDATE kanban_columnas
     SET vector_store_id = NULL, catalog_file_id = NULL
     WHERE id = ?`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.UPDATE },
  );

  // ── 4. Obtener catálogo de productos ──────────────────────
  const productos = await db.query(
    `SELECT pc.id AS id_producto, pc.id_configuracion,
            pc.nombre, pc.descripcion, pc.tipo, pc.precio,
            pc.duracion, pc.id_categoria, pc.imagen_url, pc.video_url,
            pc.stock, pc.nombre_upsell, pc.descripcion_upsell,
            pc.precio_upsell, pc.imagen_upsell_url, pc.combos_producto,
            pc.fecha_actualizacion, pc.material, pc.landing_url, pc.precio_proveedor,
            cc.nombre AS nombre_categoria
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

  // ── 5. Crear vector store nuevo (siempre fresco) ──────────
  const vectorStoreId = await createFreshVectorStore(
    id_configuracion,
    columna.nombre,
    headersJson,
    logger,
  );

  // ── 6. Subir archivo catálogo ─────────────────────────────
  const newFileId = await uploadCatalogFile(
    catalogPayload,
    id_configuracion,
    columna.estado_db,
    headersBase,
    logger,
  );

  // ── 7. Adjuntar al vector store ───────────────────────────
  const { vectorStoreFileId } = await attachFileToVectorStore(
    vectorStoreId,
    newFileId,
    headersJson,
    logger,
  );

  // ── 8. Esperar indexación ─────────────────────────────────
  await waitVectorStoreFileProcessed(
    vectorStoreId,
    vectorStoreFileId,
    headersJson,
    logger,
    sleep,
  );

  // ── 9. Actualizar asistente con el nuevo VS ───────────────
  await ensureAssistantHasFileSearch(
    assistant_id,
    vectorStoreId,
    headersJson,
    logger,
  );

  // ── 10. Guardar IDs nuevos en BD ──────────────────────────
  await db.query(
    `UPDATE kanban_columnas
   SET vector_store_id = ?, catalog_file_id = ?, catalog_synced_at = NOW()
   WHERE id = ?`,
    {
      replacements: [vectorStoreId, newFileId, id_kanban_columna],
      type: db.QueryTypes.UPDATE,
    },
  );

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
// syncCatalogoTodasColumnasConfig  (sin cambios de lógica)
// ─────────────────────────────────────────────────────────────
async function syncCatalogoTodasColumnasConfig(id_configuracion, opts = {}) {
  const logger = opts.logger || (async (...a) => console.log(...a));

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
// NUEVO HELPER: cleanupAllAssistantVectorStores
// ══════════════════════════════════════════════════════════════
// Elimina TODOS los vector stores que el asistente tenga en
// tool_resources.file_search.vector_store_ids.
// Por cada VS:
//   1. Lista todos sus files → los desvincular + elimina de Files API
//   2. Elimina el vector store de OpenAI
// Finalmente deja al asistente con vector_store_ids: []
// ──────────────────────────────────────────────────────────────
async function cleanupAllAssistantVectorStores(
  assistantId,
  headersJson,
  headersBase,
  logger,
) {
  // ── a) Obtener IDs actuales del asistente ──────────────────
  let existingVsIds = [];
  try {
    const res = await axios.get(
      `https://api.openai.com/v1/assistants/${assistantId}`,
      { headers: headersJson },
    );
    existingVsIds =
      res.data?.tool_resources?.file_search?.vector_store_ids || [];
  } catch (err) {
    await logger(
      `⚠️ No se pudo obtener el asistente ${assistantId}: ${err?.response?.data?.error?.message || err.message}`,
    );
    return; // Si falla, continuar igual (el VS nuevo se creará limpio)
  }

  if (!existingVsIds.length) {
    await logger(
      `ℹ️ Asistente ${assistantId} no tiene vector stores. Nada que limpiar.`,
    );
    return;
  }

  await logger(
    `🧹 Limpiando ${existingVsIds.length} vector store(s) del asistente ${assistantId}: ${existingVsIds.join(', ')}`,
  );

  // ── b) Por cada vector store, eliminar sus archivos y luego el VS ──
  for (const vsId of existingVsIds) {
    try {
      // b.1) Listar todos los files del vector store (paginado)
      let allVsFiles = [];
      let hasMore = true;
      let afterCursor = undefined;

      while (hasMore) {
        const params = { limit: 100 };
        if (afterCursor) params.after = afterCursor;

        const listRes = await axios.get(
          `https://api.openai.com/v1/vector_stores/${vsId}/files`,
          { headers: headersJson, params },
        );

        const pageFiles = listRes.data?.data || [];
        allVsFiles = allVsFiles.concat(pageFiles);
        hasMore = listRes.data?.has_more || false;
        afterCursor = pageFiles.length
          ? pageFiles[pageFiles.length - 1].id
          : undefined;
      }

      await logger(
        `  📋 VS ${vsId}: ${allVsFiles.length} archivo(s) encontrado(s)`,
      );

      // b.2) Desvincular cada file del VS y eliminarlo de Files API
      for (const vsFile of allVsFiles) {
        const fileId = vsFile.id;

        // Desvincular del vector store
        try {
          await axios.delete(
            `https://api.openai.com/v1/vector_stores/${vsId}/files/${fileId}`,
            { headers: headersJson },
          );
          await logger(`    🔗 File ${fileId} desvinculado de VS ${vsId}`);
        } catch (err) {
          await logger(
            `    ⚠️ No se pudo desvincular ${fileId} de VS ${vsId}: ${err?.response?.data?.error?.message || err.message}`,
          );
        }

        // Eliminar de OpenAI Files API
        try {
          await axios.delete(`https://api.openai.com/v1/files/${fileId}`, {
            headers: headersBase,
          });
          await logger(`    🗑️ File ${fileId} eliminado de OpenAI Files`);
        } catch (err) {
          await logger(
            `    ⚠️ No se pudo eliminar file ${fileId}: ${err?.response?.data?.error?.message || err.message}`,
          );
        }
      }

      // b.3) Eliminar el vector store en sí
      try {
        await axios.delete(`https://api.openai.com/v1/vector_stores/${vsId}`, {
          headers: headersJson,
        });
        await logger(`  🗑️ Vector store ${vsId} eliminado`);
      } catch (err) {
        await logger(
          `  ⚠️ No se pudo eliminar VS ${vsId}: ${err?.response?.data?.error?.message || err.message}`,
        );
      }
    } catch (err) {
      await logger(
        `⚠️ Error procesando VS ${vsId}: ${err?.response?.data?.error?.message || err.message}`,
      );
    }
  }

  // ── c) Dejar al asistente con vector_store_ids vacío ──────
  try {
    const currentRes = await axios.get(
      `https://api.openai.com/v1/assistants/${assistantId}`,
      { headers: headersJson },
    );
    const tools = currentRes.data?.tools || [];

    await axios.post(
      `https://api.openai.com/v1/assistants/${assistantId}`,
      {
        tools,
        tool_resources: { file_search: { vector_store_ids: [] } },
      },
      { headers: headersJson },
    );
    await logger(`✅ Asistente ${assistantId} limpio — vector_store_ids: []`);
  } catch (err) {
    await logger(
      `⚠️ No se pudo limpiar tool_resources del asistente: ${err?.response?.data?.error?.message || err.message}`,
    );
  }
}

// ══════════════════════════════════════════════════════════════
// Helpers (modificados/renombrados)
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

// Renombrado: ya no "reutiliza", siempre crea uno nuevo
async function createFreshVectorStore(
  id_configuracion,
  columnaNombre,
  headersJson,
  logger,
) {
  const res = await axios.post(
    'https://api.openai.com/v1/vector_stores',
    {
      name: `kanban_catalogo_${id_configuracion}_${columnaNombre}_${Date.now()}`,
    },
    { headers: headersJson },
  );
  const vsId = res?.data?.id;
  if (!vsId) throw new Error('No se pudo crear vector_store');
  await logger(`✅ Vector store nuevo creado: ${vsId}`);
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

// ── Normalizadores (sin cambios) ──────────────────────────────
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

    const encodeUrl = (url) => {
      if (!url) return null;
      try {
        const lastSlash = url.lastIndexOf('/');
        const base = url.substring(0, lastSlash + 1);
        const filename = url.substring(lastSlash + 1);
        return base + encodeURIComponent(filename);
      } catch {
        return url;
      }
    };

    const imagen_url = encodeUrl(r.imagen_url);
    const video_url = encodeUrl(r.video_url);
    const imagen_upsell_url = encodeUrl(r.imagen_upsell_url);

    let bloque_prompt = '';
    bloque_prompt += `🛒 Producto: ${r.nombre || ''}\n`;
    bloque_prompt += `📃 Descripción: ${r.descripcion || ''}\n`;
    bloque_prompt += `Precio: ${r.precio ?? ''}\n`;
    if (combos_texto) bloque_prompt += `${combos_texto}\n`;
    if (imagen_url) bloque_prompt += `[producto_imagen_url]: ${imagen_url}\n`;
    if (video_url) bloque_prompt += `[producto_video_url]: ${video_url}\n`;
    bloque_prompt += `Tipo: ${r.tipo || ''}\n`;
    bloque_prompt += `Categoría: ${r.nombre_categoria || ''}\n`;
    bloque_prompt += `Nombre_upsell: ${r.nombre_upsell || ''}\n`;
    bloque_prompt += `Descripcion_upsell: ${r.descripcion_upsell || ''}\n`;
    bloque_prompt += `Precio_upsell: ${r.precio_upsell ?? ''}\n`;
    if (imagen_upsell_url)
      bloque_prompt += `[upsell_imagen_url]: ${imagen_upsell_url}\n`;
    if (r.material) bloque_prompt += `[ficha_tecnica_url]: ${r.material}\n`;
    if (r.landing_url) bloque_prompt += `[landing_url]: ${r.landing_url}\n`;
    if (r.precio_proveedor)
      bloque_prompt += `precio_proveedor ${r.precio_proveedor}\n`;

    return {
      id_producto: r.id_producto,
      id_configuracion: r.id_configuracion,
      actualizado_en: r.fecha_actualizacion || null,
      nombre: r.nombre || '',
      descripcion: r.descripcion || '',
      tipo: r.tipo || '',
      precio: r.precio ?? null,
      duracion: r.duracion ?? null,
      stock: r.stock ?? null,
      id_categoria: r.id_categoria ?? null,
      nombre_categoria: r.nombre_categoria || null,
      nombre_producto: r.nombre || '',
      descripcion_producto: r.descripcion || '',
      precio_producto: r.precio ?? null,
      producto_imagen_url: imagen_url,
      producto_video_url: video_url,
      nombre_upsell: r.nombre_upsell || null,
      descripcion_upsell: r.descripcion_upsell || null,
      precio_upsell: r.precio_upsell ?? null,
      material: r.material || null,
      landing_url: r.landing_url || null,
      precio_proveedor: r.precio_proveedor || null,
      upsell_imagen_url: imagen_upsell_url,
      combos_producto: combos_json,
      combos_producto_texto: combos_texto,
      bloque_prompt: bloque_prompt.trim(),
    };
  });
}

module.exports = { syncCatalogoKanbanColumna, syncCatalogoTodasColumnasConfig };
