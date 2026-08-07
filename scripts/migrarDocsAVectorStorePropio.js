// ═══════════════════════════════════════════════════════════════
// migrarDocsAVectorStorePropio.js
//
// Separa los documentos que subió el usuario del vector store del catálogo.
//
// POR QUÉ
//
// Hasta ahora cada columna tenía UN solo vector store, compartido entre el
// catálogo (que regenera la sincronización) y los archivos que sube la tienda.
// Eso rompe de dos maneras:
//
//   1. Cuando la cuenta pasa a catálogo inline, el runtime manda
//      vector_store_id: null para apagar file_search sobre el catálogo — y se
//      lleva puestos los documentos, que no tienen otra vía de llegar al modelo.
//   2. La limpieza de la sincronización borra el store viejo entero.
//
// Después de esta migración cada columna tiene:
//   vector_store_id       → solo catálogo, lo maneja la sincronización
//   vector_store_docs_id  → solo documentos, los maneja subir/eliminar archivo
//
// Son exactamente 2, que es el máximo que admite file_search en la Responses
// API por llamada. OJO: en la Assistants API el asistente solo puede tener 1.
//
// USO
//   node scripts/migrarDocsAVectorStorePropio.js           (dry-run, no escribe)
//   node scripts/migrarDocsAVectorStorePropio.js --apply   (ejecuta)
// ═══════════════════════════════════════════════════════════════

// ⚠️ SOLO PARA CUENTAS CON CATÁLOGO INLINE
//
// Separar los stores en una cuenta que NO va inline le deja los documentos
// inalcanzables, porque el asistente admite UN SOLO vector store
// (tool_resources.file_search.vector_store_ids: máximo 1) y ese cupo lo tiene
// que ocupar el catálogo. Pasó de verdad el 2026-08-05 con las columnas 2106,
// 3735 y 3740: se migraron, sus bots se quedaron sin los archivos de agencias
// y hubo que devolverlos al store del catálogo.
//
// El split recién tiene sentido cuando el catálogo viaja en el prompt y libera
// el cupo. De ahí el filtro por catalogoInlineActivo(), que además del alta
// de la cuenta comprueba que el catálogo QUEPA: una cuenta habilitada cuyo
// catálogo se pasa del tope sigue leyendo su vector store y tampoco se puede
// tocar.

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const { catalogoInlineActivo } = require('../src/utils/openia/fileSearch');

const APLICAR = process.argv.includes('--apply');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(...a);

async function main() {
  log(APLICAR ? '⚠️  MODO APLICAR — se escribe en OpenAI y en BD' : '🔍 DRY-RUN — no se escribe nada');
  log('');

  // Columnas activas con store de catálogo y sin store de documentos.
  const columnas = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.estado_db, kc.assistant_id,
            kc.vector_store_id, kc.catalogo_inline_tokens, c.api_key_openai
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.activo = 1
        AND kc.vector_store_id IS NOT NULL
        AND kc.vector_store_docs_id IS NULL
        AND c.api_key_openai IS NOT NULL AND c.api_key_openai <> ''`,
    { type: db.QueryTypes.SELECT },
  );

  const candidatas = columnas.filter((c) =>
    catalogoInlineActivo(c.id_configuracion, c.catalogo_inline_tokens),
  );
  log(
    `Columnas con store de catálogo y sin store de documentos: ${columnas.length}`,
  );
  log(`De esas, en cuentas con catálogo inline: ${candidatas.length}`);
  if (!candidatas.length) {
    log('');
    log('Nada que migrar. El split solo es seguro en cuentas inline:');
    log('agrega la config a CONFIGS_CON_CATALOGO_INLINE antes de correr esto.');
    process.exit(0);
  }

  let conDocs = 0;
  let migradas = 0;
  let fallidas = 0;

  for (const col of candidatas) {
    const headersBase = { Authorization: `Bearer ${col.api_key_openai}` };
    const headersJson = { ...headersBase, 'Content-Type': 'application/json' };
    // Los endpoints de /assistants exigen este header; los de /vector_stores no
    // lo piden pero tampoco molesta, así que va en el mismo juego.
    const headersAssistants = { ...headersJson, 'OpenAI-Beta': 'assistants=v2' };

    // ¿Qué archivos hay en el store del catálogo?
    let archivos;
    try {
      const r = await axios.get(
        `https://api.openai.com/v1/vector_stores/${col.vector_store_id}/files?limit=100`,
        { headers: headersJson },
      );
      archivos = r.data?.data || [];
    } catch (_) {
      continue; // key muerta o store borrado: no hay nada que migrar
    }

    if (archivos.length <= 1) continue; // solo el catálogo

    // Los documentos del usuario son los que NO se llaman catalogo_*
    const docs = [];
    for (const a of archivos) {
      try {
        const meta = await axios.get(`https://api.openai.com/v1/files/${a.id}`, {
          headers: headersBase,
        });
        const nombre = meta.data?.filename || '';
        if (!nombre.startsWith('catalogo_')) docs.push({ id: a.id, nombre });
      } catch (_) {
        // Sin nombre no se puede decidir; se trata como documento para no perderlo.
        docs.push({ id: a.id, nombre: '(sin nombre)' });
      }
    }

    if (!docs.length) continue;

    conDocs++;
    log('');
    log(`── cfg ${col.id_configuracion} · columna ${col.id} (${col.estado_db})`);
    log(`   store catálogo: ${col.vector_store_id}`);
    docs.forEach((d) => log(`   📄 ${d.nombre}  (${d.id})`));

    if (!APLICAR) {
      log('   → se crearía un vector store de documentos y se moverían ahí');
      continue;
    }

    try {
      // 1. Vector store propio para los documentos
      const vsRes = await axios.post(
        'https://api.openai.com/v1/vector_stores',
        { name: `kanban_docs_${col.id}_${Date.now()}` },
        { headers: headersJson },
      );
      const vsDocs = vsRes.data?.id;
      if (!vsDocs) throw new Error('No se pudo crear el vector store de documentos');
      log(`   ✅ vector store docs creado: ${vsDocs}`);

      // 2. Adjuntar cada documento y esperar a que indexe
      for (const d of docs) {
        const at = await axios.post(
          `https://api.openai.com/v1/vector_stores/${vsDocs}/files`,
          { file_id: d.id },
          { headers: headersJson },
        );
        const vsFileId = at.data?.id;

        let ok = false;
        for (let i = 1; i <= 60 && !ok; i++) {
          const st = await axios.get(
            `https://api.openai.com/v1/vector_stores/${vsDocs}/files/${vsFileId}`,
            { headers: headersJson },
          );
          const status = st.data?.status;
          if (status === 'completed') ok = true;
          else if (status === 'failed' || status === 'cancelled')
            throw new Error(`Indexación ${status} para ${d.nombre}`);
          else await sleep(2000);
        }
        if (!ok) throw new Error(`Timeout indexando ${d.nombre}`);
        log(`   📎 ${d.nombre} indexado en el store de documentos`);
      }

      // 3. Guardar en BD. Va ANTES de desvincular nada: si el proceso muere
      //    acá, los documentos están en los DOS stores, que es recuperable.
      //    Al revés no.
      await db.query(
        `UPDATE kanban_columnas SET vector_store_docs_id = ? WHERE id = ?`,
        { replacements: [vsDocs, col.id], type: db.QueryTypes.UPDATE },
      );
      log(`   💾 vector_store_docs_id guardado en la columna ${col.id}`);

      // 4. El asistente se queda con el store de DOCUMENTOS. Solo cabe uno
      //    (máximo 1 en tool_resources.file_search.vector_store_ids), y como
      //    esto solo corre en cuentas inline, el catálogo ya viaja en el prompt
      //    y no necesita el cupo. Se reemplaza entero: NO se fusiona.
      if (col.assistant_id) {
        try {
          const aRes = await axios.get(
            `https://api.openai.com/v1/assistants/${col.assistant_id}`,
            { headers: headersAssistants },
          );
          const tools = (aRes.data?.tools || []).filter((t) => t?.type !== 'file_search');
          await axios.post(
            `https://api.openai.com/v1/assistants/${col.assistant_id}`,
            {
              tools: [...tools, { type: 'file_search' }],
              tool_resources: { file_search: { vector_store_ids: [vsDocs] } },
            },
            { headers: headersAssistants },
          );
          log(`   🤖 asistente ${col.assistant_id} apuntando al store de documentos`);
        } catch (err) {
          log(
            `   ⚠️ No se pudo actualizar el asistente: ${err?.response?.data?.error?.message || err.message}`,
          );
        }
      }

      // 5. Desvincular los documentos del store del catálogo. NO borra el
      //    archivo de OpenAI Files, solo lo saca de ese store. Así la próxima
      //    sincronización no los encuentra ahí y no los duplica al rescatarlos.
      for (const d of docs) {
        try {
          await axios.delete(
            `https://api.openai.com/v1/vector_stores/${col.vector_store_id}/files/${d.id}`,
            { headers: headersJson },
          );
          log(`   🔗 ${d.nombre} desvinculado del store del catálogo`);
        } catch (err) {
          log(`   ⚠️ No se pudo desvincular ${d.nombre}: ${err.message}`);
        }
      }

      migradas++;
    } catch (err) {
      fallidas++;
      log(
        `   ❌ Falló la migración de la columna ${col.id}: ` +
          `${err?.response?.data?.error?.message || err.message}`,
      );
    }
  }

  log('');
  log('═══ RESUMEN ═══');
  log(`  columnas con documentos : ${conDocs}`);
  if (APLICAR) {
    log(`  migradas correctamente  : ${migradas}`);
    log(`  fallidas                : ${fallidas}`);
  } else {
    log('  (dry-run: no se escribió nada — repetir con --apply)');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e?.response?.data || e.message);
  process.exit(1);
});
