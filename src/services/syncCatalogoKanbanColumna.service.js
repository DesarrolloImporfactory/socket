// services/syncCatalogoKanbanColumna.service.js

const axios = require('axios');
const FormData = require('form-data');
const { db } = require('../database/config');

const fs = require('fs');
const path = require('path');

const { catalogoInlineActivo } = require('../utils/openia/fileSearch');

// ✅ ACTIVO: generación del catálogo en texto plano para mandarlo dentro de
// las instrucciones en vez de usar file_search.
//
// GENERAR y USAR son dos decisiones distintas, a propósito:
//   - aquí se GENERA y se guarda en kanban_columnas.catalogo_inline. Es
//     inofensivo: solo llena una columna, no cambia cómo responde el bot.
//   - en kanban_ia.service.js se DECIDE si se usa, y ahí manda
//     CONFIGS_CON_CATALOGO_INLINE, que hoy es solo la 10.
//
// Está activo para todos porque el texto tiene que existir ANTES de poder
// medirlo o activarlo en una cuenta. Si se generara solo para las cuentas de
// la lista, activar una nueva obligaría a re-sincronizarla a mano primero.
const GENERAR_CATALOGO_INLINE = true;

async function saveCatalogToDisk(
  catalogPayload,
  id_configuracion,
  columnaNombre,
  outputDir,
  logger,
) {
  try {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const safeNombre = String(columnaNombre || 'columna').replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    );
    const filename = `catalogo_${id_configuracion}_${safeNombre}_${Date.now()}.json`;
    const fullPath = path.join(outputDir, filename);
    await fs.promises.writeFile(
      fullPath,
      JSON.stringify(catalogPayload, null, 2),
      'utf8',
    );
    await logger(`💾 JSON guardado localmente: ${fullPath}`);
    return fullPath;
  } catch (err) {
    await logger(`⚠️ No se pudo guardar JSON local: ${err.message}`);
    return null;
  }
}

async function syncCatalogoKanbanColumna(id_kanban_columna, opts = {}) {
  const logger = opts.logger || (async (...a) => console.log(...a));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 1. Obtener datos de la columna ────────────────────────
  const [columna] = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.nombre, kc.estado_db,
            kc.assistant_id, kc.vector_store_id, kc.vector_store_docs_id,
            kc.catalog_file_id
     FROM   kanban_columnas kc
     WHERE  kc.id = ?`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );

  if (!columna)
    throw new Error(`kanban_columna id=${id_kanban_columna} no encontrada`);

  const { id_configuracion, assistant_id } = columna;

  // IDs viejos: NO se borran todavía. Solo se limpian al final, cuando el
  // reemplazo ya está creado y guardado en BD (ver paso 11).
  const vsAnterior = columna.vector_store_id || null;

  // Vector store de DOCUMENTOS (archivos que sube el usuario desde el front).
  // La sincronización no lo crea, no lo llena y no lo borra: solo lo lee para
  // dos cosas —adjuntarlo al asistente junto al catálogo, y meterlo en la
  // lista de "no borrar" de la limpieza—. Es NULL en las cuentas que todavía
  // no lo usan y todo se comporta como siempre.
  const vsDocs = columna.vector_store_docs_id || null;

  // El assistant_id es opcional: las columnas que corren por Responses API no
  // usan asistentes (las instrucciones salen de la BD). Sin él se sincroniza
  // el catálogo igual y solo se saltan los pasos que tocan al asistente.
  if (!assistant_id) {
    await logger(
      `ℹ️ La columna "${columna.nombre}" no tiene assistant_id: se sincroniza solo el vector store`,
    );
  }

  // ── 1.b Detectar si es cuenta proveedor ───────────────────
  // Solo proveedores reciben ID Dropi y stock detallado en bloque_prompt.
  // El resto (tiendas dropshipper como Sara) mantiene el formato original.
  const [conf] = await db.query(
    `SELECT COALESCE(es_proveedor, 0) AS es_proveedor
     FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const esProveedor = Number(conf?.es_proveedor || 0) === 1;

  await logger(
    `🏷️ Modo sync: ${esProveedor ? 'PROVEEDOR (con ID Dropi y stock detallado)' : 'DROPSHIPPER (formato estándar)'}`,
  );

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

  // ── 3. (movido al final) ──────────────────────────────────
  // Antes aquí se borraban los vector stores viejos y se ponía la columna en
  // vector_store_id = NULL. Eso dejaba a la columna SIN catálogo si cualquier
  // paso posterior fallaba, y el store recién creado quedaba huérfano en
  // OpenAI porque el UPDATE final nunca llegaba a ejecutarse.
  // Ahora la limpieza va en el paso 11, después de guardar el reemplazo.

  // ── 4. Obtener catálogo de productos ──────────────────────
  // El armado vive en armarCatalogPayload, compartido con
  // generarInlineColumna: una sola fuente de verdad para el contenido.
  const catalogPayload = await armarCatalogPayload({
    id_configuracion,
    id_kanban_columna,
    columna_nombre: columna.nombre,
    esProveedor,
  });

  if (!catalogPayload) {
    await logger(
      `ℹ️ Sin productos para id_configuracion=${id_configuracion}. No se sincroniza.`,
    );
    return { ok: true, skipped: true, reason: 'Sin productos' };
  }

  // El texto plano se arma acá, antes de tocar OpenAI, porque de sus tokens
  // depende una decisión que se toma más abajo: si un fallo indexando puede
  // perdonarse o no. Es una función pura sobre catalogPayload, no cuesta nada
  // adelantarla.
  const inline = GENERAR_CATALOGO_INLINE
    ? construirCatalogoInline(catalogPayload)
    : null;

  // ── 4.5 Guardar JSON localmente (opcional, por defecto activo) ──
  /* const saveToDisk = opts.saveToDisk !== false; */ // true por defecto
  const saveToDisk = false;
  const outputDir =
    opts.outputDir || path.join(process.cwd(), 'catalogos_sync');

  let localFilePath = null;
  if (saveToDisk) {
    localFilePath = await saveCatalogToDisk(
      catalogPayload,
      id_configuracion,
      columna.nombre,
      outputDir,
      logger,
    );
  }

  // ── 5. Crear vector store nuevo ───────────────────────────
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
  // OpenAI falla indexando cada tanto con {"code":"server_error","message":"An
  // internal error occurred."} sobre archivos perfectamente válidos: el
  // 2026-08-05 falló en 2 de las 3 columnas de la config 10 con exactamente el
  // mismo catálogo que en la tercera indexó sin problema (0 fallos en los 4
  // meses anteriores, así que es rachas, no una condición estable).
  //
  // Encima tarda en marcar el archivo como `failed`: waitVectorStoreFileProcessed
  // lo ve `in_progress` durante los 60 intentos y sale por timeout, y recién
  // después OpenAI lo pasa a `failed`. Por eso el log dice "Timeout" y no
  // "Falló".
  //
  // Se reintenta una vez SUBIENDO UN ARCHIVO NUEVO, no readjuntando el mismo:
  // cuando un file falla la indexación queda inservible (usage_bytes = 0) y
  // volver a colgarlo del store repite el error.
  // ⚠️ No alcanza con "está en la lista": tiene que CABER. Una cuenta
  // habilitada cuyo catálogo se pasa del tope sigue leyendo su vector store, y
  // para ella un fallo de indexación NO se puede perdonar — se quedaría con el
  // catálogo viejo en silencio. Por eso se pregunta con los tokens en la mano.
  const vaInline = catalogoInlineActivo(id_configuracion, inline?.tokens);
  let indexado = false;
  let fileIdFinal = newFileId;
  let vsFileIdFinal = vectorStoreFileId;

  for (let intento = 1; intento <= 2 && !indexado; intento++) {
    if (intento > 1) {
      await logger('🔁 Reintentando indexación con una subida nueva del catálogo');
      fileIdFinal = await uploadCatalogFile(
        catalogPayload,
        id_configuracion,
        columna.estado_db,
        headersBase,
        logger,
      );
      const reattach = await attachFileToVectorStore(
        vectorStoreId,
        fileIdFinal,
        headersJson,
        logger,
      );
      vsFileIdFinal = reattach.vectorStoreFileId;
    }

    try {
      await waitVectorStoreFileProcessed(
        vectorStoreId,
        vsFileIdFinal,
        headersJson,
        logger,
        sleep,
      );
      indexado = true;
    } catch (err) {
      await logger(`⚠️ Indexación fallida (intento ${intento}/2): ${err.message}`);

      // Para las cuentas que siguen leyendo el vector store, un catálogo sin
      // indexar no sirve de nada: se corta acá, igual que siempre, y la columna
      // conserva en BD el store anterior (que sí está indexado). Pero el store
      // nuevo se descarta ANTES de cortar: el throw se lleva por delante la
      // limpieza del paso 11, y así es como se acumularon los huérfanos.
      if (intento === 2 && !vaInline) {
        await descartarVectorStore(vectorStoreId, headersJson, logger);
        throw err;
      }
    }
  }

  if (!indexado) {
    // Solo llega acá una cuenta con catálogo inline. Para ella el vector store
    // NO está en el camino de lectura del bot —lee kanban_columnas.catalogo_inline—
    // así que dejar que un error de OpenAI en un paso que no usa le bloquee la
    // actualización del catálogo era el peor de los dos mundos: el bot seguía
    // citando productos viejos y en el log solo aparecía un "Timeout indexando".
    await logger(
      `📄 La config ${id_configuracion} va por catálogo inline: se guarda el ` +
        'catálogo nuevo igual y se conserva el vector store anterior',
    );
  }

  // ── 9. Actualizar asistente con el nuevo VS (NO fatal) ────
  // Las columnas por Responses API no usan asistente, y un asistente borrado
  // en OpenAI no debe tumbar un catálogo que ya está creado e indexado.
  //
  // Si la indexación falló no se toca el asistente: apuntarlo a un store con un
  // archivo roto es peor que dejarlo en el anterior, que sí funciona.
  let assistantActualizado = false;
  if (assistant_id && indexado) {
    try {
      // El asistente tiene UN solo cupo (ver ensureAssistantHasFileSearch).
      // Si la cuenta va inline, el catálogo viaja en las instrucciones y el
      // cupo se le da a los documentos; si no, al catálogo.
      await ensureAssistantHasFileSearch(
        assistant_id,
        vaInline && vsDocs ? [vsDocs] : [vectorStoreId],
        headersJson,
        logger,
      );
      assistantActualizado = true;
    } catch (err) {
      await logger(
        `⚠️ No se pudo actualizar el asistente ${assistant_id}: ` +
          `${err?.response?.data?.error?.message || err.message} ` +
          `— el catálogo se guarda igual`,
      );
    }
  }

  // ── 10. Guardar IDs nuevos en BD ──────────────────────────
  // Va ANTES de cualquier borrado: si el proceso muere aquí, la columna ya
  // apunta a un vector store válido.
  //
  // El catálogo inline (si está activo) se guarda en el mismo UPDATE para que
  // el texto y el vector store queden siempre de la misma sincronización.
  // `inline` ya viene armado desde el paso 4.5, donde hizo falta para decidir
  // si un fallo de indexación era perdonable.

  if (indexado) {
    await db.query(
      `UPDATE kanban_columnas
       SET vector_store_id = ?, catalog_file_id = ?, catalog_synced_at = NOW()
           ${inline ? ', catalogo_inline = ?, catalogo_inline_tokens = ?' : ''}
       WHERE id = ?`,
      {
        replacements: inline
          ? [
              vectorStoreId,
              fileIdFinal,
              inline.texto,
              inline.tokens,
              id_kanban_columna,
            ]
          : [vectorStoreId, fileIdFinal, id_kanban_columna],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else if (inline) {
    // Indexación fallida en una cuenta inline: se guarda SOLO el texto.
    // vector_store_id y catalog_file_id se dejan como estaban a propósito —el
    // store viejo sigue vivo e indexado, el nuevo tiene un archivo roto— y así
    // la columna nunca queda apuntando a algo que no responde.
    //
    // catalog_synced_at sí se actualiza: para esta cuenta el catálogo que lee
    // el bot ES el inline, y ese quedó al día.
    await db.query(
      `UPDATE kanban_columnas
       SET catalogo_inline = ?, catalogo_inline_tokens = ?, catalog_synced_at = NOW()
       WHERE id = ?`,
      {
        replacements: [inline.texto, inline.tokens, id_kanban_columna],
        type: db.QueryTypes.UPDATE,
      },
    );
  }

  if (inline) {
    await logger(
      `📄 Catálogo inline guardado: ~${inline.tokens} tokens (${inline.texto.length} caracteres)`,
    );
  }

  // ── 11. Recién ahora, limpiar lo viejo (NO fatal) ─────────
  // Se le pasa el vector store que tenía la columna en BD para poder borrarlo
  // aunque el asistente ya no exista; si solo se preguntara al asistente, los
  // stores viejos quedarían acumulándose en la cuenta de OpenAI.
  //
  // vsDocs va en conservarVsIds y NO es opcional: los candidatos a borrar
  // salen, entre otras fuentes, de los vector stores adjuntos al asistente, y
  // el de documentos está adjunto ahí. Sin esta línea la sincronización
  // borraría los archivos del usuario en la primera corrida.
  if (indexado) {
    try {
      await cleanupAllAssistantVectorStores(
        assistant_id,
        headersJson,
        headersBase,
        logger,
        {
          extraVsIds: [vsAnterior],
          conservarVsIds: [vectorStoreId, vsDocs],
          vsDestinoRescate: vectorStoreId,
        },
      );
    } catch (err) {
      await logger(`⚠️ Limpieza de vector stores viejos falló: ${err.message}`);
    }
  } else {
    // La limpieza normal borraría el store ANTERIOR, que es justamente el que la
    // columna sigue usando. Al revés: el que sobra es el que se acaba de crear.
    //
    // Sin esto cada indexación fallida deja un vector store huérfano para
    // siempre (había 3 del 2026-08-05 y 5 del 2026-04-15 en la cuenta).
    await descartarVectorStore(vectorStoreId, headersJson, logger);
  }

  await logger(
    `${indexado ? '✅ Sync completo' : '⚠️ Sync parcial (solo catálogo inline)'}: ` +
      `columna="${columna.nombre}" assistant=${assistant_id} items=${catalogPayload.total_items} modo=${esProveedor ? 'proveedor' : 'dropshipper'}`,
  );

  return {
    ok: true,
    // Sin indexación no hay vector store nuevo: la columna quedó con el de
    // antes, y esto tiene que decir lo que hay en BD, no lo que se intentó.
    indexado,
    id_kanban_columna,
    id_configuracion,
    assistant_id,
    vector_store_id: indexado ? vectorStoreId : vsAnterior || null,
    catalog_file_id: indexado ? fileIdFinal : columna.catalog_file_id || null,
    total_items: catalogPayload.total_items,
    local_file_path: localFilePath, // ← NUEVO
  };
}

// ─────────────────────────────────────────────────────────────
// syncCatalogoTodasColumnasConfig (sin cambios)
// ─────────────────────────────────────────────────────────────
async function syncCatalogoTodasColumnasConfig(id_configuracion, opts = {}) {
  const logger = opts.logger || (async (...a) => console.log(...a));

  const columnas = await db.query(
    `SELECT DISTINCT kc.id
     FROM   kanban_columnas kc
     INNER JOIN kanban_acciones ka ON ka.id_kanban_columna = kc.id
     WHERE  kc.id_configuracion = ?
       AND  kc.activo = 1
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
      console.error(err.response?.data);
      console.error(err.response?.status);
      console.error(err.config?.url);

      await logger(
        `⚠️ Error sync columna id=${id}: ${
          err.response?.status || ''
        } ${err.message}
    URL: ${err.config?.url}
    DATA: ${JSON.stringify(err.response?.data)}`,
      );

      resultados.push({
        ok: false,
        id_kanban_columna: id,
        error: err.message,
      });
    }
  }

  return {
    ok: resultados.every((r) => r.ok),
    id_configuracion,
    resultados,
  };
}

// ══════════════════════════════════════════════════════════════
// cleanupAllAssistantVectorStores (sin cambios)
// ══════════════════════════════════════════════════════════════
// Borra vector stores viejos. Los candidatos salen de DOS fuentes que se
// suman: los que tenga adjuntos el asistente (si existe) y los que se pasen
// explícitamente en opts.extraVsIds — normalmente el que la columna tenía
// guardado en BD. Esa segunda fuente es la que evita dejar basura cuando el
// asistente ya no existe en OpenAI.
// opts.conservarVsIds nunca se borra (el reemplazo recién creado).
async function cleanupAllAssistantVectorStores(
  assistantId,
  headersJson,
  headersBase,
  logger,
  opts = {},
) {
  const conservar = new Set((opts.conservarVsIds || []).filter(Boolean));
  const candidatos = new Set((opts.extraVsIds || []).filter(Boolean));

  // Vector store al que se mueven los archivos que NO son catálogo antes de
  // destruir el store viejo. Sin él, la limpieza vuelve al comportamiento de
  // antes (borrar todo), así que conviene pasarlo siempre.
  const vsDestinoRescate = opts.vsDestinoRescate || null;

  if (assistantId) {
    try {
      const res = await axios.get(
        `https://api.openai.com/v1/assistants/${assistantId}`,
        { headers: headersJson },
      );
      for (const id of res.data?.tool_resources?.file_search
        ?.vector_store_ids || []) {
        candidatos.add(id);
      }
    } catch (err) {
      // No es fatal: se sigue con los IDs que vinieron por BD.
      await logger(
        `⚠️ No se pudo obtener el asistente ${assistantId}: ${err?.response?.data?.error?.message || err.message}`,
      );
    }
  }

  const existingVsIds = [...candidatos].filter((id) => !conservar.has(id));

  if (!existingVsIds.length) {
    await logger(`ℹ️ No hay vector stores viejos que limpiar.`);
  }

  if (existingVsIds.length) {
    await logger(
      `🧹 Limpiando ${existingVsIds.length} vector store(s) viejo(s): ${existingVsIds.join(', ')}`,
    );
  }

  for (const vsId of existingVsIds) {
    try {
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

      for (const vsFile of allVsFiles) {
        const fileId = vsFile.id;

        // ¿Es un catálogo generado por nosotros o un documento del usuario?
        //
        // Antes esto no se preguntaba: se borraba todo lo que hubiera en el
        // vector store viejo. Como hasta ahora los archivos que el usuario
        // subía desde el front vivían en ESE MISMO store, se los llevaba por
        // delante en cada sincronización — o sea, en cada vez que alguien
        // guardaba un producto.
        //
        // Los catálogos los sube uploadCatalogFile() con el nombre
        // `catalogo_<config>_<estado>_<timestamp>.json`. Cualquier otra cosa es
        // del usuario y se rescata al vector store nuevo en vez de borrarse.
        //
        // Ante la duda (no se pudo leer el nombre) se RESCATA, no se borra:
        // acumular un archivo de más cuesta centavos, perder el manual de un
        // cliente no se deshace.
        let nombreArchivo = null;
        try {
          const meta = await axios.get(
            `https://api.openai.com/v1/files/${fileId}`,
            { headers: headersBase },
          );
          nombreArchivo = meta?.data?.filename || null;
        } catch (_) {
          /* sin nombre → se trata como documento del usuario */
        }

        const esCatalogo = (nombreArchivo || '').startsWith('catalogo_');

        if (!esCatalogo && vsDestinoRescate && vsDestinoRescate !== vsId) {
          try {
            await axios.post(
              `https://api.openai.com/v1/vector_stores/${vsDestinoRescate}/files`,
              { file_id: fileId },
              { headers: headersJson },
            );
            await logger(
              `    🛟 File ${fileId} (${nombreArchivo || 'sin nombre'}) NO es catálogo: rescatado a VS ${vsDestinoRescate}`,
            );
          } catch (err) {
            await logger(
              `    ⚠️ No se pudo rescatar ${fileId} a ${vsDestinoRescate}: ${err?.response?.data?.error?.message || err.message}`,
            );
          }
          // No se desvincula del store viejo ni se borra de OpenAI Files.
          // Borrar un vector store NO borra los archivos que contiene, así que
          // el DELETE del store que viene más abajo ya deshace el vínculo. Y si
          // el rescate falló, dejarlo quieto es lo que hay que hacer: el
          // archivo sigue existiendo en Files y se puede recuperar. La opción
          // de "desvincular igual" lo dejaría huérfano e invisible.
          continue;
        }

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

  /* Dejar en el asistente SOLO los stores que se conservan (el recién
     sincronizado). Antes esto mandaba `vector_store_ids: []` siempre, y  dejaba al asistente sin catálogo: la columna quedaba con
     un vector_store válido en BD y el asistente sin nada que buscar.

     Corre SIEMPRE, aunque no haya nada viejo que borrar: el paso 9 adjunta el
     store al asistente pero no es fatal si falla, así que esta es la única
     reconciliación que queda. Cuando se salía antes por "no hay nada que
     limpiar", un paso 9 fallido dejaba al asistente sin catálogo de forma
     permanente y el bot contestaba precios inventados sin que nada avisara
     (le pasó a la columna Contacto Inicial de la config 818). */
  if (!assistantId) return;

  const conservarIds = [...conservar];
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
        tool_resources: { file_search: { vector_store_ids: conservarIds } },
      },
      { headers: headersJson },
    );
    await logger(
      `✅ Asistente ${assistantId} actualizado — vector_store_ids: [${conservarIds.join(', ')}]`,
    );
  } catch (err) {
    await logger(
      `⚠️ No se pudo limpiar tool_resources del asistente: ${err?.response?.data?.error?.message || err.message}`,
    );
  }
}

// ══════════════════════════════════════════════════════════════
// Helpers (sin cambios)
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

async function createFreshVectorStore(
  id_configuracion,
  columnaNombre,
  headersJson,
  logger,
) {
  await logger('➡️ Voy a crear Vector Store');

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/vector_stores',
      {
        name: `kanban_catalogo_${id_configuracion}_${columnaNombre}_${Date.now()}`,
      },
      {
        headers: headersJson,
        timeout: 60000,
      },
    );

    await logger('⬅️ OpenAI respondió create vector store');

    const vsId = res.data.id;

    await logger(`✅ Vector store creado ${vsId}`);

    return vsId;
  } catch (err) {
    console.error(err.response?.status);
    console.error(err.response?.data);
    console.error(err.config?.url);

    throw err;
  }
}

/* El documento de file_search viaja TROCEADO: un fragmento puede traer la
   imagen de un producto pegada al texto de otro. Caso real (285, 2026-08-17):
   el cliente preguntó "¿protege la cabeza?", el retrieval trajo por semántica
   el fragmento del "Intercomunicador Bluetooth para CASCO", y el bot —hablando
   correctamente de la máscara— mandó la foto del intercomunicador, que venía
   dentro del fragmento.

   Por eso las URLs de imagen/video NO viajan en el documento del vector
   store: la foto llega solo por el canal determinista (bloque del referral y
   ficha de contextoColumna), que nunca cruza productos. El catálogo INLINE sí
   las conserva: ahí el modelo ve el documento entero y exacto, sin troceo.
   Solo toca la copia que se sube: catalogPayload (del que sale el inline) no
   se modifica. */
function sinMediaParaFileSearch(payload) {
  const items = (payload.items || []).map((item) => {
    const { producto_imagen_url, producto_video_url, ...resto } = item;
    return {
      ...resto,
      bloque_prompt: String(resto.bloque_prompt || '')
        .split('\n')
        .filter((l) => !/^\[producto_(imagen|video)_url\]:/.test(l.trim()))
        .join('\n'),
    };
  });

  const instrucciones_uso_ia = (payload.instrucciones_uso_ia || []).map((t) =>
    t.includes('[producto_imagen_url]')
      ? 'Las fotos y videos de los productos los adjunta el sistema por su propio canal: NO escriba URLs de imagen o video, ni las etiquetas [producto_imagen_url]/[producto_video_url], a partir de este catálogo.'
      : t,
  );

  return { ...payload, items, instrucciones_uso_ia };
}

async function uploadCatalogFile(
  catalogPayload,
  id_configuracion,
  estado_db,
  headersBase,
  logger,
) {
  const filename = `catalogo_${id_configuracion}_${estado_db}_${Date.now()}.json`;
  const buffer = Buffer.from(
    JSON.stringify(sinMediaParaFileSearch(catalogPayload), null, 2),
    'utf8',
  );

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

// Borra un vector store que se creó pero no llegó a servir. Nunca lanza: es
// higiene de la cuenta de OpenAI, no puede tumbar un sync ni tapar el error
// original que llevó hasta acá.
async function descartarVectorStore(vectorStoreId, headersJson, logger) {
  if (!vectorStoreId) return;
  try {
    await axios.delete(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}`,
      { headers: headersJson },
    );
    await logger(
      `🗑️ Vector store ${vectorStoreId} descartado (no llegó a indexar)`,
    );
  } catch (err) {
    await logger(
      `⚠️ No se pudo descartar el vector store ${vectorStoreId}: ` +
        `${err?.response?.data?.error?.message || err.message}`,
    );
  }
}

// ⚠️ UN SOLO vector store por asistente.
//
// tool_resources.file_search.vector_store_ids admite MÁXIMO 1 elemento en la
// Assistants API; mandarle 2 devuelve 400 "array too long. Expected an array
// with maximum length 1". El límite de 2 que sí existe es de la Responses API,
// por llamada, y no aplica acá — eran dos límites distintos que estábamos
// confundiendo.
//
// Con un solo cupo hay que elegir, y quien elige es el llamador:
//   - cuenta con catálogo inline → conviene el store de DOCUMENTOS, porque el
//     catálogo ya viaja dentro de las instrucciones y no necesita búsqueda.
//   - cuenta sin inline → el store del CATÁLOGO, que es lo único que el modelo
//     no puede saber de memoria. Sus documentos siguen conviviendo dentro de
//     ese mismo store, como siempre.
//
// Se sigue aceptando un array por compatibilidad con los llamadores, pero se
// queda con el primero que no sea nulo.
async function ensureAssistantHasFileSearch(
  assistantId,
  vectorStoreIds,
  headersJson,
  logger,
) {
  const stores = (
    Array.isArray(vectorStoreIds) ? vectorStoreIds : [vectorStoreIds]
  )
    .filter(Boolean)
    .slice(0, 1);
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
      tool_resources: { file_search: { vector_store_ids: stores } },
    },
    { headers: headersJson },
  );
  await logger(
    `✅ Assistant ${assistantId} actualizado con file_search + vector_store(s) ${stores.join(', ')}`,
  );
}

// ─────────────────────────────────────────────────────────────
// construirCatalogoInline
// Arma el MISMO catálogo pero en texto plano, para poder pegarlo al final de
// las instrucciones en vez de dárselo al modelo por file_search.
//
// Sale mucho más barato: file_search trocea el archivo en fragmentos de 800
// tokens con 400 de solapamiento y devuelve hasta 20, así que termina
// inyectando el catálogo entero DUPLICADO en cada llamada. Medido en la
// config 10: 16.230 tokens por file_search contra 2.221 del mismo catálogo en
// texto. Y de paso el modelo ve el catálogo COMPLETO, sin depender de que la
// búsqueda semántica acierte.
//
// Solo se llama si GENERAR_CATALOGO_INLINE está en true.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// armarCatalogPayload
// Lee los productos de la config y arma el payload del catálogo (items
// normalizados + instrucciones de uso). Compartido entre el sync completo y
// generarInlineColumna: el contenido del catálogo tiene UNA sola fuente de
// verdad — duplicar esta lógica es cómo se desincronizan los dos caminos.
// Devuelve null si la config no tiene productos.
// ─────────────────────────────────────────────────────────────
async function armarCatalogPayload({
  id_configuracion,
  id_kanban_columna,
  columna_nombre,
  esProveedor,
}) {
  // Si es proveedor, traemos external_id/external_source. Si no, omitimos.
  const selectExternal = esProveedor
    ? ', pc.external_id, pc.external_source'
    : '';

  const productos = await db.query(
    `SELECT pc.id AS id_producto, pc.id_configuracion,
            pc.nombre, pc.descripcion, pc.tipo, pc.precio,
            pc.duracion, pc.id_categoria, pc.imagen_url, pc.video_url,
            pc.stock, pc.combos_producto, pc.es_variable,
            pc.fecha_actualizacion, pc.material, pc.landing_url, pc.precio_proveedor,
            -- Solo el nombre del atributo y sus valores: "Color: Negro, Cafe".
            -- Sin stock y sin repetir el atributo en cada opción, porque el
            -- bot copia literal lo que ve y terminaba recitándole al cliente
            -- "Variante: Negro (stock 387)".
            (SELECT CONCAT(
                      MAX(pv.atributo), ': ',
                      GROUP_CONCAT(pv.valor ORDER BY pv.id SEPARATOR ', '))
               FROM productos_variaciones pv
              WHERE pv.id_producto = pc.id AND pv.activo = 1) AS variantes_texto
            ${selectExternal},
            cc.nombre AS nombre_categoria
     FROM   productos_chat_center pc
     LEFT JOIN categorias_chat_center cc ON cc.id = pc.id_categoria
     WHERE  pc.id_configuracion = ?
     ORDER  BY pc.id DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!productos.length) return null;

  const catalogoNormalizado = normalizeCatalogProducts(productos, esProveedor);

  const catalogoProductos = catalogoNormalizado.filter(
    (p) => String(p.tipo || '').toLowerCase() !== 'servicio',
  );
  const catalogoServicios = catalogoNormalizado.filter(
    (p) => String(p.tipo || '').toLowerCase() === 'servicio',
  );

  /* Van SIEMPRE los dos. Antes era `productos.length ? productos : servicios`,
     o sea que un solo producto suelto dejaba al asistente sin ver ningún
     servicio: una estética que además vende una plancha de cabello perdía todo
     su catálogo de tratamientos y el bot respondía que no ofrecen nada.

     Los negocios de servicios que también venden algo (estéticas, barberías,
     veterinarias, talleres) son la norma, no la excepción. Lo que sí cambia es
     QUÉ se hace con cada uno: un servicio se agenda, un producto se despacha.
     Por eso van juntos pero etiquetados, y las instrucciones se lo explican. */
  const itemsFinales = [...catalogoServicios, ...catalogoProductos];
  const tipoCatalogo =
    catalogoServicios.length && catalogoProductos.length
      ? 'mixto'
      : catalogoProductos.length
        ? 'productos'
        : 'servicios';

  // Instrucciones diferenciadas según tipo de cuenta
  const instrucciones_uso_ia = esProveedor
    ? [
        'Use este catálogo como base de conocimiento.',
        'Cada item incluye id_dropi (cuando aplica): el cliente puede pedir un producto solo con su ID Dropi (ej: "tienes el 158923?", "info del #158923", "ID 158923"). Búsquelo por id_dropi/external_id.',
        'Cada item incluye stock al momento de la sincronización. Es referencial.',
        'Use los identificadores [producto_imagen_url], [producto_video_url] cuando existan.',
        'Si un item dice "PRODUCTO VARIABLE", PREGUNTE al cliente qué variedad quiere (color, talla…) antes de cerrar la venta y agregue la línea "🎨 Variedad: <la elegida>" al resumen del pedido. Si el item no es variable, NO agregue esa línea.',
        'Si el cliente pide MÁS DE UNA variedad, escriba cuántas unidades de cada una: "🎨 Variedad: Negro x2, Cafe x1". Las cantidades tienen que sumar exactamente la cantidad total del pedido. Con una sola variedad basta el nombre.',
        'Si el sistema provee datos de stock/precio en tiempo real por base de datos, prefiera esos sobre los del catálogo.',
      ]
    : [
        'Use este catálogo como base de conocimiento.',
        'Cada item puede incluir un campo "bloque_prompt" con etiquetas compatibles con datos_pedido.',
        'IMPORTANTE: este catálogo es información INTERNA de consulta. NUNCA copie el formato de estos bloques (🛒 Producto, 📃 Descripción, etc.) en sus mensajes ni en el resumen del pedido: el formato del resumen lo define el prompt del agente, no este archivo.',
        'Use los identificadores [producto_imagen_url], [producto_video_url] cuando existan.',
        'Si un item dice "PRODUCTO VARIABLE", PREGUNTE al cliente qué variedad quiere (color, talla…) antes de cerrar la venta y agregue la línea "🎨 Variedad: <la elegida>" al resumen del pedido. Si el item no es variable, NO agregue esa línea.',
        'Si el cliente pide MÁS DE UNA variedad, escriba cuántas unidades de cada una: "🎨 Variedad: Negro x2, Cafe x1". Las cantidades tienen que sumar exactamente la cantidad total del pedido. Con una sola variedad basta el nombre.',
        'No asuma stock/precio en tiempo real si el sistema provee esos datos por base de datos.',
        'Priorice datos en tiempo real sobre file_search si hay diferencias.',
      ];

  /* Con catálogo mixto hay que decirle explícitamente qué hacer con cada tipo:
     si no, ofrece agendar una cita para comprar una plancha, o intenta vender
     un tratamiento como si se lo llevara a casa. */
  if (tipoCatalogo === 'mixto') {
    instrucciones_uso_ia.push(
      'Este catálogo tiene SERVICIOS y PRODUCTOS mezclados. Cada item trae su campo "tipo": respételo.',
      'Un item con tipo "servicio" se PRESTA en el local y se AGENDA (cita con fecha y hora).',
      'Un item con tipo "producto" se VENDE y se entrega o se despacha: NO se agenda cita para comprarlo.',
      'Si el cliente pregunta por algo que se vende, respóndale con el producto; no lo redirija a agendar una cita salvo que él lo pida.',
      'Si un cliente quiere las dos cosas (por ejemplo un tratamiento y llevarse un producto), atienda primero lo que agenda y mencione el producto al cerrar.',
    );
  }

  return {
    schema_version: esProveedor ? '1.1-proveedor' : '1.0',
    id_configuracion: Number(id_configuracion),
    id_kanban_columna: Number(id_kanban_columna),
    columna_nombre,
    tipo_catalogo: tipoCatalogo,
    modo: esProveedor ? 'proveedor' : 'dropshipper',
    generado_en: new Date().toISOString(),
    total_items: itemsFinales.length,
    items: itemsFinales,
    instrucciones_uso_ia,
  };
}

// ─────────────────────────────────────────────────────────────
// generarInlineColumna
// Genera y guarda SOLO kanban_columnas.catalogo_inline (+ tokens), sin tocar
// OpenAI: no sube archivos, no crea ni borra vector stores, no necesita la
// API key del cliente. Es el camino del backfill de columnas que nunca
// sincronizaron: para ellas basta con que el texto exista — usarlo o no lo
// decide el runtime solo (TODAS_INLINE + tope de tokens).
// catalog_synced_at NO se toca a propósito: esa fecha habla del vector store,
// que acá queda exactamente como estaba.
// ─────────────────────────────────────────────────────────────
async function generarInlineColumna(id_kanban_columna, opts = {}) {
  const logger = opts.logger || (async (...a) => console.log(...a));

  if (!GENERAR_CATALOGO_INLINE) {
    return { ok: true, skipped: true, reason: 'GENERAR_CATALOGO_INLINE off' };
  }

  const [columna] = await db.query(
    `SELECT id, id_configuracion, nombre FROM kanban_columnas WHERE id = ?`,
    { replacements: [id_kanban_columna], type: db.QueryTypes.SELECT },
  );
  if (!columna)
    throw new Error(`kanban_columna id=${id_kanban_columna} no encontrada`);

  const [conf] = await db.query(
    `SELECT COALESCE(es_proveedor, 0) AS es_proveedor
     FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [columna.id_configuracion], type: db.QueryTypes.SELECT },
  );
  const esProveedor = Number(conf?.es_proveedor || 0) === 1;

  const catalogPayload = await armarCatalogPayload({
    id_configuracion: columna.id_configuracion,
    id_kanban_columna,
    columna_nombre: columna.nombre,
    esProveedor,
  });
  if (!catalogPayload) {
    return { ok: true, skipped: true, reason: 'Sin productos' };
  }

  const inline = construirCatalogoInline(catalogPayload);

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      tokens: inline.tokens,
      total_items: catalogPayload.total_items,
      // El texto viaja en el dry-run para poder compararlo contra el inline
      // guardado (prueba de equivalencia del refactor) sin escribir nada.
      texto: inline.texto,
    };
  }

  await db.query(
    `UPDATE kanban_columnas
       SET catalogo_inline = ?, catalogo_inline_tokens = ?
     WHERE id = ?`,
    {
      replacements: [inline.texto, inline.tokens, id_kanban_columna],
      type: db.QueryTypes.UPDATE,
    },
  );
  await logger(
    `📄 inline generado: columna=${id_kanban_columna} "${columna.nombre}" ` +
      `config=${columna.id_configuracion} items=${catalogPayload.total_items} tokens=${inline.tokens}`,
  );
  return { ok: true, tokens: inline.tokens, total_items: catalogPayload.total_items };
}

function construirCatalogoInline(catalogPayload) {
  const encabezado = [
    '=== CATÁLOGO (información interna de consulta) ===',
    ...(catalogPayload.instrucciones_uso_ia || []).map((i) => `- ${i}`),
  ].join('\n');

  const bloques = (catalogPayload.items || [])
    .map((it) => String(it.bloque_prompt || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const texto = `${encabezado}\n\n${bloques}`.trim();

  // Estimación, NO tokenizador real: ~4 caracteres por token en español.
  // Solo sirve para compararla contra TOPE_CATALOGO_INLINE, no para facturar.
  return { texto, tokens: Math.ceil(texto.length / 4) };
}

// ── Normalizadores ───────────────────────────────────────────
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
    if (Array.isArray(combosNormalizados)) {
      // Al catálogo del bot solo van nombre/cantidad/precio: el id_dropi del
      // combo es dato interno del auto-pedido y los combos vacíos son ruido.
      combosNormalizados = combosNormalizados
        .filter(
          (c) =>
            (c?.cantidad ?? '') !== '' || (c?.precio ?? c?.valor ?? '') !== '',
        )
        .map((c) => {
          const limpio = {};
          const nombre = c?.nombre || c?.titulo;
          if (nombre) limpio.nombre = nombre;
          if ((c?.cantidad ?? '') !== '') limpio.cantidad = c.cantidad;
          const precio = c?.precio ?? c?.valor;
          if (precio != null && precio !== '') limpio.precio = precio;
          return limpio;
        });
    }
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
    } else if (
      !Array.isArray(combosNormalizados) &&
      typeof combosNormalizados === 'object'
    ) {
      combosTexto += `Combos disponibles:\n${JSON.stringify(combosNormalizados, null, 2)}`;
    }
  } catch (_) {}

  return { combos_json: combosNormalizados, combos_texto: combosTexto.trim() };
}

// ─────────────────────────────────────────────────────────────
// normalizeCatalogProducts
// Si esProveedor=true: incluye id_dropi (triplicado) + stock detallado en bloque_prompt.
// Si esProveedor=false: comportamiento idéntico al original (no rompe Sara ni dropshippers).
// ─────────────────────────────────────────────────────────────
function normalizeCatalogProducts(rows, esProveedor = false) {
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

    // ── Solo proveedor: ID Dropi y stock detallado ──────────
    const dropiId =
      esProveedor && r.external_source === 'DROPI' && r.external_id != null
        ? String(r.external_id).trim()
        : null;

    let bloque_prompt = '';
    bloque_prompt += `🛒 Producto: ${r.nombre || ''}\n`;

    if (esProveedor && dropiId) {
      // ID triplicado para máxima coincidencia en file_search
      bloque_prompt += `🆔 ID Dropi: ${dropiId}\n`;
      bloque_prompt += `id_dropi: ${dropiId} | dropi_id: ${dropiId} | external_id: ${dropiId} | ID: ${dropiId} | #${dropiId}\n`;
    }

    if (esProveedor) {
      // Stock detallado solo para proveedor (los dropshippers consultan stock)
      const stockNum = r.stock != null ? Number(r.stock) : null;
      const stockTexto =
        stockNum == null
          ? 'sin información de stock'
          : stockNum > 0
            ? `${stockNum} unidades disponibles`
            : 'sin stock';
      bloque_prompt += `📦 Stock: ${stockTexto}\n`;
    }

    bloque_prompt += `📃 Descripción: ${r.descripcion || ''}\n`;
    bloque_prompt += `Precio: ${r.precio ?? ''}\n`;
    if (combos_texto) bloque_prompt += `${combos_texto}\n`;
    if (imagen_url) bloque_prompt += `[producto_imagen_url]: ${imagen_url}\n`;
    if (video_url) bloque_prompt += `[producto_video_url]: ${video_url}\n`;
    bloque_prompt += `Tipo: ${r.tipo || ''}\n`;
    /* Producto variable: se listan las variedades para que el asistente
       PREGUNTE cuál quiere antes de cerrar. Sin esto el bot cerraba la venta
       "a secas" y el asesor tenía que reescribir al cliente por el color o
       la talla, y el auto-orden fallaba por no saber qué variante subir. */
    if (Number(r.es_variable) === 1 && r.variantes_texto) {
      bloque_prompt += `⚠️ PRODUCTO VARIABLE — pregunta cuál quiere antes de cerrar y ponla en "🎨 Variedad:" del resumen. Si pide varias, escribe cuántas de cada una ("Negro x2, Cafe x1") y que sumen la cantidad total. NUNCA menciones el stock ni listes las opciones numeradas.\n`;
      bloque_prompt += `Variedades disponibles → ${r.variantes_texto}\n`;
    } else {
      // Se dice explícitamente para que el bot NO agregue la línea de más:
      // el resumen ya es largo y en productos simples no aporta nada.
      bloque_prompt += `Producto simple: NO incluyas la línea "🎨 Variedad:" en el resumen.\n`;
    }
    bloque_prompt += `Categoría: ${r.nombre_categoria || ''}\n`;
    /* Upsell fuera del catálogo: ningún prompt pide ofrecerlo (la única
       mención era la regla de formato de la imagen) y la mayoría de estos
       campos venían vacíos, así que solo gastaban tokens en cada consulta a
       file_search. Las columnas siguen en la base con lo ya cargado. */
    if (r.material) bloque_prompt += `[ficha_tecnica_url]: ${r.material}\n`;
    if (r.landing_url) bloque_prompt += `[landing_url]: ${r.landing_url}\n`;
    if (r.precio_proveedor)
      bloque_prompt += `precio_proveedor ${r.precio_proveedor}\n`;

    const baseReturn = {
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
      material: r.material || null,
      landing_url: r.landing_url || null,
      precio_proveedor: r.precio_proveedor || null,
      es_variable: Number(r.es_variable) === 1,
      variedades: r.variantes_texto || null,
      combos_producto: combos_json,
      combos_producto_texto: combos_texto,
      bloque_prompt: bloque_prompt.trim(),
    };

    // Solo agregar campos Dropi si es proveedor
    if (esProveedor) {
      baseReturn.id_dropi = dropiId;
      baseReturn.external_id = dropiId;
      baseReturn.external_source = r.external_source || null;
    }

    return baseReturn;
  });
}

module.exports = {
  syncCatalogoKanbanColumna,
  syncCatalogoTodasColumnasConfig,
  // Camino liviano del backfill: solo genera el inline, sin tocar OpenAI.
  generarInlineColumna,
  // Exportada para la batería de regresión: que el doc de file_search salga
  // sin URLs de media es una garantía que no puede perderse en silencio.
  sinMediaParaFileSearch,
};
