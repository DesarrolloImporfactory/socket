const axios = require('axios');
const FormData = require('form-data');
const { db, db_2 } = require('../../database/config');

/**
 * Sincroniza catálogo de productos/servicios al file_search (vector store) de los assistants
 * asociados a una configuración.
 *
 * Requiere columnas en oia_assistants_cliente:
 * - vector_store_id (nullable)
 * - catalog_file_id (nullable)
 *
 * @param {number|string} id_configuracion
 * @param {object} opts
 * @param {string} opts.apiKeyOpenAI - API key de OpenAI (opcional si usa process.env)
 * @param {function} opts.logger - función async para logs (opcional)
 */
async function syncCatalogoAsistentesPorConfiguracion(
  id_configuracion,
  opts = {},
) {
  const logger =
    opts.logger ||
    (async (...args) => {
      console.log(...args);
    });

  // 1) API key por configuración (fallback opcional a opts.apiKeyOpenAI)
  const apiKey =
    opts.apiKeyOpenAI ||
    (await obtenerApiKeyOpenAIPorConfiguracion(id_configuracion));

  if (!apiKey) {
    throw new Error(
      `No se pudo resolver api_key_openai para id_configuracion=${id_configuracion}`,
    );
  }

  const headersJson = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const headersBase = {
    Authorization: `Bearer ${apiKey}`,
    'OpenAI-Beta': 'assistants=v2',
  };

  // ===== Helpers internos =====
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    if (!combos) {
      return {
        combos_json: null,
        combos_texto: '',
      };
    }

    // Si ya viene array/object, lo mantenemos
    let combosNormalizados = combos;

    // Texto “prompt-friendly”
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
        combosTexto += `Combos disponibles:\n${JSON.stringify(
          combosNormalizados,
          null,
          2,
        )}`;
      }
    } catch (_) {}

    return {
      combos_json: combosNormalizados,
      combos_texto: combosTexto.trim(),
    };
  }

  function normalizeCatalogProducts(rows) {
    return rows.map((r) => {
      const { combos_json, combos_texto } = formatearCombosParaCatalogo(
        r.combos_producto,
      );

      // Bloque textual estilo "datos_pedido" / prompt-friendly
      let bloque_prompt = '';
      bloque_prompt += `🛒 Producto: ${r.nombre || ''}\n`;
      bloque_prompt += `📃 Descripción: ${r.descripcion || ''}\n`;
      bloque_prompt += `Precio: ${r.precio ?? ''}\n`;
      // bloque_prompt += `Stock: ${r.stock ?? ''}\n`; // opcional si luego quiere incluirlo
      if (combos_texto) bloque_prompt += `${combos_texto}\n`;
      if (r.imagen_url)
        bloque_prompt += `[producto_imagen_url]: ${r.imagen_url}\n`;
      if (r.video_url)
        bloque_prompt += `[producto_video_url]: ${r.video_url}\n`;
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

        // Campos exactos que su prompt reconoce mejor
        nombre_producto: r.nombre || '',
        descripcion_producto: r.descripcion || '',
        precio_producto: r.precio ?? null,
        producto_imagen_url: r.imagen_url || null,
        producto_video_url: r.video_url || null,

        nombre_upsell: r.nombre_upsell || null,
        descripcion_upsell: r.descripcion_upsell || null,
        precio_upsell: r.precio_upsell ?? null,
        upsell_imagen_url: r.imagen_upsell_url || null,

        combos_producto: combos_json, // estructura útil
        combos_producto_texto: combos_texto, // texto útil para retrieval/prompt

        // Bloque textual altamente compatible con su prompt
        bloque_prompt: bloque_prompt.trim(),
      };
    });
  }

  /**
   * Obtiene la API key de OpenAI desde tabla configuraciones
   */
  async function obtenerApiKeyOpenAIPorConfiguracion(id_configuracion) {
    const rows = await db.query(
      `
    SELECT api_key_openai
    FROM configuraciones
    WHERE id = :id_configuracion
    LIMIT 1
    `,
      {
        replacements: { id_configuracion },
        type: db.QueryTypes.SELECT,
      },
    );

    const apiKey = rows?.[0]?.api_key_openai || null;

    if (!apiKey) {
      throw new Error(
        `No se encontró api_key_openai en configuraciones para id_configuracion=${id_configuracion}`,
      );
    }

    return apiKey;
  }

  async function createVectorStoreIfNeeded(existingVectorStoreId, label) {
    if (existingVectorStoreId) {
      return existingVectorStoreId;
    }

    const payload = {
      name: `catalogo_config_${id_configuracion}_${label || 'assistant'}`,
    };

    const res = await axios.post(
      'https://api.openai.com/v1/vector_stores',
      payload,
      { headers: headersJson },
    );

    const vsId = res?.data?.id;
    if (!vsId) {
      throw new Error('No se pudo crear vector_store_id');
    }

    await logger(
      `✅ Vector store creado (${label || 'assistant'}): ${vsId} para config ${id_configuracion}`,
    );

    return vsId;
  }

  async function uploadCatalogFile(jsonObject, label) {
    const filename = `catalogo_${id_configuracion}_${label || 'ventas'}_${Date.now()}.json`;
    const buffer = Buffer.from(JSON.stringify(jsonObject, null, 2), 'utf8');

    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', buffer, {
      filename,
      contentType: 'application/json',
    });

    const res = await axios.post('https://api.openai.com/v1/files', form, {
      headers: {
        ...headersBase,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const fileId = res?.data?.id;
    if (!fileId) {
      throw new Error(
        'No se pudo subir el archivo de catálogo (file_id vacío)',
      );
    }

    await logger(`✅ Archivo catálogo subido (${label}): ${fileId}`);
    return fileId;
  }

  async function attachFileToVectorStore(vectorStoreId, fileId, label) {
    const res = await axios.post(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      { file_id: fileId },
      { headers: headersJson },
    );

    const vsFileId = res?.data?.id;
    const status = res?.data?.status || 'unknown';

    await logger(
      `📎 Archivo ${fileId} agregado al vector store ${vectorStoreId} (${label}) status=${status} vs_file_id=${vsFileId}`,
    );

    return {
      vectorStoreFileId: vsFileId,
      status,
    };
  }

  async function waitVectorStoreFileProcessed(
    vectorStoreId,
    vectorStoreFileId,
    maxAttempts = 30,
    intervalMs = 1000,
  ) {
    // Poll al endpoint del archivo dentro del vector store
    for (let i = 1; i <= maxAttempts; i++) {
      const res = await axios.get(
        `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files/${vectorStoreFileId}`,
        { headers: headersJson },
      );

      const status = res?.data?.status;
      await logger(
        `⏳ Indexando catálogo (intento ${i}/${maxAttempts}) vs_file=${vectorStoreFileId} vs=${vectorStoreId} status=${status}`,
      );

      if (status === 'completed') return true;
      if (status === 'failed' || status === 'cancelled') {
        throw new Error(
          `Falló indexación del archivo del vector store ${vectorStoreFileId} en vector store ${vectorStoreId}. status=${status}`,
        );
      }

      await sleep(intervalMs);
    }

    throw new Error(
      `Timeout esperando indexación de catálogo vs_file=${vectorStoreFileId} vs=${vectorStoreId}`,
    );
  }

  async function ensureAssistantHasFileSearch(assistantId, vectorStoreId) {
    // 1) Leer assistant actual
    const getRes = await axios.get(
      `https://api.openai.com/v1/assistants/${assistantId}`,
      {
        headers: headersJson,
      },
    );

    const assistant = getRes.data || {};
    const currentTools = Array.isArray(assistant.tools) ? assistant.tools : [];

    // Asegurar file_search en tools (sin eliminar otros tools)
    const hasFileSearch = currentTools.some((t) => t?.type === 'file_search');
    const tools = hasFileSearch
      ? currentTools
      : [...currentTools, { type: 'file_search' }];

    // 2) Actualizar assistant con vector_store_id
    await axios.post(
      `https://api.openai.com/v1/assistants/${assistantId}`,
      {
        tools,
        tool_resources: {
          file_search: {
            vector_store_ids: [vectorStoreId], // máximo 1 por assistant
          },
        },
      },
      { headers: headersJson },
    );

    await logger(
      `✅ Assistant ${assistantId} actualizado con file_search + vector_store ${vectorStoreId}`,
    );
  }

  async function deleteOpenAIFileIfExists(fileId, label) {
    if (!fileId) return;

    try {
      await axios.delete(`https://api.openai.com/v1/files/${fileId}`, {
        headers: headersBase,
      });
      await logger(
        `🗑️ Archivo catálogo anterior eliminado (${label}): ${fileId}`,
      );
    } catch (err) {
      // No rompemos la sync por fallo al borrar el viejo
      await logger(
        `⚠️ No se pudo eliminar archivo anterior ${fileId} (${label}): ${
          err?.response?.data?.error?.message || err.message
        }`,
      );
    }
  }

  // ===== 1) Buscar assistants por template_key =====
  const assistants = await db.query(
    `
    SELECT 
      id,
      id_configuracion,
      template_key,
      assistant_id,
      model,
      vector_store_id,
      catalog_file_id
    FROM oia_assistants_cliente
    WHERE id_configuracion = :id_configuracion
      AND template_key IN (
        'ventas_productos',
        'ventas_servicios',
        'ventas_productos_imporshop'
      )
    `,
    {
      replacements: { id_configuracion },
      type: db.QueryTypes.SELECT,
    },
  );

  if (!assistants || assistants.length === 0) {
    await logger(
      `ℹ️ No hay assistants ventas_productos/ventas_servicios para id_configuracion=${id_configuracion}. Se omite sync.`,
    );
    return {
      ok: true,
      skipped: true,
      reason: 'No hay assistants objetivo',
      id_configuracion,
    };
  }

  // ===== 2) Consultar catálogo de productos/servicios =====
  const productos = await db.query(
    `
    SELECT 
      pc.id AS id_producto,
      pc.id_configuracion,
      pc.nombre,
      pc.descripcion,
      pc.tipo,
      pc.precio,
      pc.duracion,
      pc.id_categoria,
      pc.imagen_url,
      pc.video_url,
      pc.stock,
      pc.nombre_upsell,
      pc.descripcion_upsell,
      pc.precio_upsell,
      pc.imagen_upsell_url,
      pc.combos_producto,
      pc.fecha_actualizacion,
      cc.nombre AS nombre_categoria
    FROM productos_chat_center pc
    LEFT JOIN categorias_chat_center cc ON cc.id = pc.id_categoria
    WHERE pc.id_configuracion = :id_configuracion
    ORDER BY pc.id DESC
    `,
    {
      replacements: { id_configuracion },
      type: db.QueryTypes.SELECT,
    },
  );

  const catalogoNormalizado = normalizeCatalogProducts(productos || []);

  // ===== 3) Construir catálogos por tipo (mejor que uno mezclado) =====
  const catalogoProductos = catalogoNormalizado.filter(
    (p) => String(p.tipo || '').toLowerCase() !== 'servicio',
  );

  const catalogoServicios = catalogoNormalizado.filter(
    (p) => String(p.tipo || '').toLowerCase() === 'servicio',
  );

  const makeCatalogPayload = (tipoCatalogo, items) => ({
    schema_version: '1.0',
    id_configuracion: Number(id_configuracion),
    tipo_catalogo: tipoCatalogo, // "productos" | "servicios"
    generado_en: new Date().toISOString(),
    total_items: items.length,
    items,
    instrucciones_uso_ia: [
      'Use este catálogo como base de conocimiento.',
      'Cada item puede incluir un campo "bloque_prompt" con etiquetas compatibles con datos_pedido.',
      'Use los identificadores [producto_imagen_url], [producto_video_url], [upsell_imagen_url] cuando existan.',
      'No asuma stock/precio en tiempo real si el sistema provee esos datos por base de datos.',
      'Priorice datos_pedido sobre file_search si hay diferencias.',
    ],
  });

  const payloadByTemplate = {
    ventas_productos: makeCatalogPayload('productos', catalogoProductos),
    ventas_productos_imporshop: makeCatalogPayload(
      'productos',
      catalogoProductos,
    ),
    ventas_servicios: makeCatalogPayload('servicios', catalogoServicios),
  };

  const resultados = [];

  // ===== 4) Procesar cada assistant =====
  for (const row of assistants) {
    const {
      id, // PK tabla local oia_assistants_cliente
      template_key,
      assistant_id,
      vector_store_id: currentVectorStoreId,
      catalog_file_id: previousCatalogFileId,
    } = row;

    if (!assistant_id) {
      await logger(
        `⚠️ Registro oia_assistants_cliente.id=${id} no tiene assistant_id. Se omite.`,
      );
      resultados.push({
        oia_id: id,
        template_key,
        assistant_id: null,
        ok: false,
        error: 'assistant_id vacío',
      });
      continue;
    }

    const catalogPayload = payloadByTemplate[template_key];
    if (!catalogPayload) {
      await logger(
        `ℹ️ template_key=${template_key} no mapeado para sync catálogo. Se omite.`,
      );
      resultados.push({
        oia_id: id,
        template_key,
        assistant_id,
        ok: true,
        skipped: true,
      });
      continue;
    }

    try {
      await logger(
        `🚀 Iniciando sync catálogo para assistant ${assistant_id} (template=${template_key}, config=${id_configuracion})`,
      );

      // 4.1) Crear/reutilizar vector store
      const vectorStoreId = await createVectorStoreIfNeeded(
        currentVectorStoreId,
        template_key,
      );

      // 4.2) Subir archivo catálogo nuevo
      const newCatalogFileId = await uploadCatalogFile(
        catalogPayload,
        template_key,
      );

      // 4.3) Agregar archivo al vector store
      const attachResult = await attachFileToVectorStore(
        vectorStoreId,
        newCatalogFileId,
        template_key,
      );

      // 4.4) Esperar indexación (usar vectorStoreFileId, no fileId)
      await waitVectorStoreFileProcessed(
        vectorStoreId,
        attachResult.vectorStoreFileId,
      );

      // 4.5) Asociar file_search al assistant
      await ensureAssistantHasFileSearch(assistant_id, vectorStoreId);

      // 4.6) Guardar IDs nuevos en BD
      await db.query(
        `
        UPDATE oia_assistants_cliente
        SET vector_store_id = :vector_store_id,
            catalog_file_id = :catalog_file_id
        WHERE id = :id
        `,
        {
          replacements: {
            id,
            vector_store_id: vectorStoreId,
            catalog_file_id: newCatalogFileId,
          },
          type: db.QueryTypes.UPDATE,
        },
      );

      // 4.7) Eliminar archivo anterior (solo después de éxito total)
      if (previousCatalogFileId && previousCatalogFileId !== newCatalogFileId) {
        await deleteOpenAIFileIfExists(previousCatalogFileId, template_key);
      }

      resultados.push({
        oia_id: id,
        template_key,
        assistant_id,
        ok: true,
        vector_store_id: vectorStoreId,
        catalog_file_id: newCatalogFileId,
        total_items: catalogPayload.total_items,
      });

      await logger(
        `✅ Sync catálogo completado assistant=${assistant_id} template=${template_key} items=${catalogPayload.total_items}`,
      );
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      const detalle = data?.error?.message || data || err.message;

      await logger(
        `⚠️ Error sync catálogo assistant=${assistant_id} template=${template_key} status=${status}: ${
          typeof detalle === 'string' ? detalle : JSON.stringify(detalle)
        }`,
      );

      // (opcional) log extra para depurar la key sin exponerla completa
      await logger(
        `🔑 apiKey usada (preview): ${apiKey ? apiKey.slice(0, 10) + '...' : 'null'}`,
      );
    }
  }

  const okCount = resultados.filter((r) => r.ok).length;
  const failCount = resultados.filter((r) => !r.ok).length;

  return {
    ok: failCount === 0,
    id_configuracion,
    total_assistants: assistants.length,
    okCount,
    failCount,
    resultados,
  };
}

module.exports = {
  syncCatalogoAsistentesPorConfiguracion,
};
