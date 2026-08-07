// ═══════════════════════════════════════════════════════════════
// repararAsistentesVectorStores.js
//
// Deja a cada asistente apuntando al vector store que le corresponde según la
// BD, y avisa cuando no coincide.
//
// ⚠️ UN SOLO store por asistente: tool_resources.file_search.vector_store_ids
// admite máximo 1 en la Assistants API (con 2 devuelve 400 "array too long").
// El máximo de 2 es de la Responses API, por llamada. Como tool_resources se
// reemplaza entero y no se fusiona, el que se mande es el único que queda.
//
// Con un solo cupo:
//   - cuenta con catálogo inline → los DOCUMENTOS (el catálogo va en el prompt)
//   - cuenta sin inline          → el CATÁLOGO (sus documentos viven adentro)
//
// Es idempotente: si ya coincide, no toca nada.
//
// USO
//   node scripts/repararAsistentesVectorStores.js           (dry-run)
//   node scripts/repararAsistentesVectorStores.js --apply
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');
const { catalogoInlineActivo } = require('../src/utils/openia/fileSearch');

const APLICAR = process.argv.includes('--apply');
const log = (...a) => console.log(...a);

async function main() {
  log(APLICAR ? '⚠️  MODO APLICAR' : '🔍 DRY-RUN — no se escribe nada');
  log('');

  const columnas = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.estado_db, kc.assistant_id,
            kc.vector_store_id, kc.vector_store_docs_id,
            kc.catalogo_inline_tokens, c.api_key_openai
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.activo = 1
        AND kc.assistant_id IS NOT NULL
        AND kc.vector_store_docs_id IS NOT NULL
        AND c.api_key_openai IS NOT NULL AND c.api_key_openai <> ''`,
    { type: db.QueryTypes.SELECT },
  );

  log(`Columnas con vector store de documentos: ${columnas.length}`);

  let ok = 0;
  let reparadas = 0;
  let fallidas = 0;

  for (const col of columnas) {
    const headers = {
      Authorization: `Bearer ${col.api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };

    const esperados = [
      catalogoInlineActivo(col.id_configuracion, col.catalogo_inline_tokens) &&
      col.vector_store_docs_id
        ? col.vector_store_docs_id
        : col.vector_store_id,
    ].filter(Boolean);

    try {
      const aRes = await axios.get(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        { headers },
      );
      const actuales =
        aRes.data?.tool_resources?.file_search?.vector_store_ids || [];

      const iguales =
        actuales.length === esperados.length &&
        esperados.every((v) => actuales.includes(v));

      log('');
      log(`── cfg ${col.id_configuracion} · columna ${col.id} (${col.estado_db})`);
      log(`   asistente : ${col.assistant_id}`);
      log(`   esperado  : [${esperados.join(', ')}]`);
      log(`   actual    : [${actuales.join(', ')}]`);

      if (iguales) {
        log('   ✅ ya coincide');
        ok++;
        continue;
      }

      if (!APLICAR) {
        log('   → se corregiría');
        continue;
      }

      const tools = (aRes.data?.tools || []).filter(
        (t) => t?.type !== 'file_search',
      );
      await axios.post(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        {
          tools: [...tools, { type: 'file_search' }],
          tool_resources: { file_search: { vector_store_ids: esperados } },
        },
        { headers },
      );
      log('   🤖 corregido');
      reparadas++;
    } catch (err) {
      fallidas++;
      log('');
      log(`── cfg ${col.id_configuracion} · columna ${col.id}`);
      log(
        `   ❌ ${err?.response?.status || ''} ${err?.response?.data?.error?.message || err.message}`,
      );
    }
  }

  log('');
  log('═══ RESUMEN ═══');
  log(`  ya correctas : ${ok}`);
  log(`  ${APLICAR ? 'reparadas' : 'a reparar '}    : ${reparadas}`);
  log(`  fallidas     : ${fallidas}`);

  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e?.response?.data || e.message);
  process.exit(1);
});
