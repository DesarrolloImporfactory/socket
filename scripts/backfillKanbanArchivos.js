// ════════════════════════════════════════════════════════════
// backfillKanbanArchivos.js
//
// Registra en kanban_archivos / kanban_columna_archivos los documentos que ya
// están indexados en OpenAI pero son anteriores a la migración, para que el
// sync del catálogo sepa que debe protegerlos.
//
// IMPORTANTE: el archivo del catálogo (kanban_columnas.catalog_file_id) se
// EXCLUYE a propósito. Ese sí es propiedad del sync y debe poder borrarse.
//
// Uso:
//   node scripts/backfillKanbanArchivos.js            → simulacro (no escribe)
//   node scripts/backfillKanbanArchivos.js --aplicar  → escribe en BD
//   node scripts/backfillKanbanArchivos.js --aplicar --config=10
// ════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const argConfig = process.argv.find((a) => a.startsWith('--config='));
const SOLO_CONFIG = argConfig ? Number(argConfig.split('=')[1]) : null;

async function getApiKey(id_configuracion) {
  const [row] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row?.api_key_openai || null;
}

async function listarArchivosDeStore(vectorStoreId, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const todos = [];
  let after;
  let hasMore = true;

  while (hasMore) {
    const params = { limit: 100 };
    if (after) params.after = after;

    const res = await axios.get(
      `https://api.openai.com/v1/vector_stores/${vectorStoreId}/files`,
      { headers, params },
    );

    const pagina = res.data?.data || [];
    todos.push(...pagina);
    hasMore = res.data?.has_more || false;
    after = pagina.length ? pagina[pagina.length - 1].id : undefined;
  }

  return todos;
}

async function detalleArchivo(fileId, apiKey) {
  try {
    const res = await axios.get(`https://api.openai.com/v1/files/${fileId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
      },
    });
    return {
      filename: res.data?.filename || fileId,
      bytes: res.data?.bytes || 0,
    };
  } catch {
    return { filename: fileId, bytes: 0 };
  }
}

(async () => {
  console.log(
    APLICAR
      ? '🚀 MODO APLICAR — se va a escribir en la base de datos\n'
      : '🔍 SIMULACRO — no se escribe nada. Añade --aplicar para ejecutar.\n',
  );

  const columnas = await db.query(
    `SELECT id, id_configuracion, nombre, vector_store_id,
            vector_store_docs_id, catalog_file_id
     FROM kanban_columnas
     WHERE activo = 1
       AND (vector_store_id IS NOT NULL OR vector_store_docs_id IS NOT NULL)
       ${SOLO_CONFIG ? 'AND id_configuracion = :cfg' : ''}
     ORDER BY id_configuracion, id`,
    {
      replacements: SOLO_CONFIG ? { cfg: SOLO_CONFIG } : {},
      type: db.QueryTypes.SELECT,
    },
  );

  console.log(`📦 ${columnas.length} columna(s) con vector store\n`);

  const keys = new Map();
  let registrados = 0;
  let vinculados = 0;
  let omitidosCatalogo = 0;

  for (const col of columnas) {
    if (!keys.has(col.id_configuracion)) {
      keys.set(col.id_configuracion, await getApiKey(col.id_configuracion));
    }
    const apiKey = keys.get(col.id_configuracion);
    if (!apiKey) {
      console.log(`⚠️  config ${col.id_configuracion}: sin api_key_openai, se omite`);
      continue;
    }

    const stores = [col.vector_store_docs_id, col.vector_store_id].filter(Boolean);

    for (const vsId of stores) {
      let archivos;
      try {
        archivos = await listarArchivosDeStore(vsId, apiKey);
      } catch (err) {
        console.log(
          `⚠️  col ${col.id} store ${vsId}: ${err?.response?.data?.error?.message || err.message}`,
        );
        continue;
      }

      for (const f of archivos) {
        // El catálogo es del sync, no del cliente.
        if (f.id === col.catalog_file_id) {
          omitidosCatalogo++;
          continue;
        }

        const [yaEsta] = await db.query(
          `SELECT id FROM kanban_archivos WHERE openai_file_id = ? LIMIT 1`,
          { replacements: [f.id], type: db.QueryTypes.SELECT },
        );

        let idArchivo = yaEsta?.id;

        if (!idArchivo) {
          const info = await detalleArchivo(f.id, apiKey);
          console.log(
            `  + [col ${col.id} "${col.nombre}"] ${info.filename} (${f.id})`,
          );

          if (APLICAR) {
            const [insertId] = await db.query(
              `INSERT INTO kanban_archivos
                 (id_configuracion, nombre_original, mime, bytes,
                  openai_file_id, storage_path, status)
               VALUES (?, ?, NULL, ?, ?, NULL, ?)`,
              {
                replacements: [
                  col.id_configuracion,
                  info.filename,
                  info.bytes,
                  f.id,
                  f.status || 'completed',
                ],
                type: db.QueryTypes.INSERT,
              },
            );
            idArchivo = insertId;
          }
          registrados++;
        }

        if (APLICAR && idArchivo) {
          await db.query(
            `INSERT INTO kanban_columna_archivos
               (id_kanban_columna, id_archivo, vector_store_id,
                vector_store_file_id, status)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               vector_store_id = VALUES(vector_store_id),
               status = VALUES(status)`,
            {
              replacements: [
                col.id,
                idArchivo,
                vsId,
                f.id,
                f.status || 'completed',
              ],
              type: db.QueryTypes.INSERT,
            },
          );
          vinculados++;
        }
      }
    }
  }

  console.log('\n─────────────────────────────────');
  console.log(`Archivos a registrar : ${registrados}`);
  console.log(`Vínculos escritos    : ${vinculados}`);
  console.log(`Catálogos omitidos   : ${omitidosCatalogo}`);
  if (!APLICAR && registrados > 0) {
    console.log('\nVuelve a correrlo con --aplicar para escribirlo.');
  }

  await db.close();
})().catch(async (err) => {
  console.error('❌', err.response?.data || err.message);
  try {
    await db.close();
  } catch (_) {}
  process.exit(1);
});
