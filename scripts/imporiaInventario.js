// ═══════════════════════════════════════════════════════════════
// imporiaInventario.js
//
// Solo lectura. Fotografía lo que hay ANTES de migrar ImporIA de la
// Assistants API a la Responses API.
//
// POR QUÉ HACE FALTA
//
// ImporIA quedó fuera de la migración de agosto y sigue corriendo contra
// threads/runs (openai_assistants.controller.js → enviar_mensaje_gpt). Todo lo
// que define su comportamiento —prompt, modelo y los archivos adjuntos— vive
// DENTRO de dos objetos assistant en OpenAI:
//
//   EC  asst_UVA7p8j7JINZi7M0BkrKMUSF
//   MX  asst_shnGt8Pr5raINBP5oDktNhuT
//
// Para migrar hay que sacar todo eso a la BD, y este script dice qué se puede
// rescatar todavía y qué no.
//
// LO QUE IMPORTA DE VERDAD: LOS VECTOR STORES
//
// Los vector stores NO son parte de la Assistants API: viven en su propio
// endpoint (/v1/vector_stores) y la Responses API los consume igual, vía la
// herramienta file_search. O sea que los archivos de ImporIA se reusan tal
// cual, sin volver a subir nada — SIEMPRE que sepamos los ids.
//
// Los ids están en el assistant (tool_resources.file_search.vector_store_ids).
// Si la Assistants API ya está apagada no se pueden leer de ahí, y por eso el
// script además LISTA los vector stores de la cuenta para identificarlos por
// nombre a mano.
//
// USO
//   node scripts/imporiaInventario.js
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const { db_2 } = require('../src/database/config');

const API_KEY = process.env.OPENAI_API_KEY;

// Los mismos que están quemados hoy en openai_assistants.controller.js:801-807.
const ASISTENTES = [
  { pais: 'EC', assistant_id: 'asst_UVA7p8j7JINZi7M0BkrKMUSF' },
  { pais: 'MX', assistant_id: 'asst_shnGt8Pr5raINBP5oDktNhuT' },
];

const headersAssistants = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2',
};

const headersPlanos = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

function detalleError(err) {
  const status = err?.response?.status;
  const msg =
    err?.response?.data?.error?.message || err?.message || 'error desconocido';
  return status ? `HTTP ${status} — ${msg}` : msg;
}

// ─────────────────────────────────────────────────────────────
// 1. Los assistants: ¿se pueden leer todavía?
// ─────────────────────────────────────────────────────────────
async function inspeccionarAssistants() {
  console.log('\n═══ 1. ASSISTANTS ═══\n');

  const storesEncontrados = new Set();
  let algunoRespondio = false;

  for (const { pais, assistant_id } of ASISTENTES) {
    try {
      const { data } = await axios.get(
        `https://api.openai.com/v1/assistants/${assistant_id}`,
        { headers: headersAssistants, timeout: 30000 },
      );

      algunoRespondio = true;

      const stores =
        data?.tool_resources?.file_search?.vector_store_ids ||
        data?.tool_resources?.file_search?.vector_stores ||
        [];
      stores.forEach((s) => storesEncontrados.add(s));

      console.log(`✅ ${pais}  ${assistant_id}`);
      console.log(`   nombre       : ${data.name || '(sin nombre)'}`);
      console.log(`   modelo       : ${data.model}`);
      console.log(`   temperature  : ${data.temperature ?? '(default)'}`);
      console.log(`   top_p        : ${data.top_p ?? '(default)'}`);
      console.log(
        `   tools        : ${(data.tools || []).map((t) => t.type).join(', ') || '(ninguna)'}`,
      );
      console.log(
        `   vector stores: ${stores.length ? stores.join(', ') : '(ninguno)'}`,
      );
      console.log(
        `   instructions : ${(data.instructions || '').length} chars`,
      );

      // El prompt completo va a un archivo aparte: en consola se pierde, y es
      // justo lo que hay que sembrar en imporia_prompts.
      const fs = require('fs');
      const ruta = `scripts/imporia_prompt_${pais}.txt`;
      fs.writeFileSync(ruta, data.instructions || '', 'utf8');
      console.log(`   → prompt guardado en ${ruta}`);
      console.log('');
    } catch (err) {
      console.log(`❌ ${pais}  ${assistant_id}`);
      console.log(`   ${detalleError(err)}`);
      console.log('');
    }
  }

  if (!algunoRespondio) {
    console.log(
      '⚠️  Ningún assistant respondió. Si el error es 404/410 o menciona que\n' +
        '    la API fue retirada, la Assistants API ya está apagada: el prompt y\n' +
        '    el modelo hay que ponerlos a mano, y los vector stores identificarlos\n' +
        '    por nombre en la lista de abajo.\n',
    );
  }

  return storesEncontrados;
}

// ─────────────────────────────────────────────────────────────
// 2. Los vector stores de la cuenta (endpoint propio, sigue vivo)
// ─────────────────────────────────────────────────────────────
async function listarVectorStores(idsDelAssistant) {
  console.log('\n═══ 2. VECTOR STORES DE LA CUENTA ═══\n');

  try {
    /* Hay que paginar sí o sí: la cuenta tiene cientos de stores de ChatCenter
       (kanban_catalogo_*, que el sync recrea en cada corrida) y vienen del más
       nuevo al más viejo. Los de ImporIA son de hace meses: con una sola página
       de 100 ni aparecen. */
    const stores = [];
    let after = null;
    let paginas = 0;

    do {
      const url =
        'https://api.openai.com/v1/vector_stores?limit=100' +
        (after ? `&after=${after}` : '');
      const { data } = await axios.get(url, {
        headers: headersPlanos,
        timeout: 30000,
      });
      const pagina = data?.data || [];
      stores.push(...pagina);
      after = data?.has_more ? data?.last_id : null;
      paginas++;
    } while (after && paginas < 50);

    if (!stores.length) {
      console.log('(la cuenta no tiene vector stores)\n');
      return;
    }

    /* Los de ChatCenter se reconocen por el nombre que les pone
       syncCatalogoKanbanColumna.service.js. Se esconden para que quede a la
       vista lo que NO es de ahí, que es donde están los de ImporIA. */
    const esDeChatCenter = (n) =>
      /^kanban_(catalogo|docs)_/i.test(String(n || ''));
    const ocultos = stores.filter((s) => esDeChatCenter(s.name)).length;
    const candidatos = stores.filter((s) => !esDeChatCenter(s.name));

    console.log(
      `${stores.length} vector stores en la cuenta; ${ocultos} son de ChatCenter (kanban_*) y no se listan.\n`,
    );

    if (!candidatos.length) {
      console.log(
        '⚠️  Todos los stores son de ChatCenter: ImporIA no tiene ninguno propio,\n' +
          '    o sus archivos se borraron junto con los assistants.\n',
      );
    }

    for (const s of candidatos) {
      const marca = idsDelAssistant.has(s.id) ? '★ ImporIA' : '';
      const archivos = s.file_counts?.completed ?? '?';
      const mb = s.usage_bytes
        ? (s.usage_bytes / 1024 / 1024).toFixed(1) + ' MB'
        : '0 MB';
      const ultimo = s.last_active_at
        ? new Date(s.last_active_at * 1000).toISOString().slice(0, 10)
        : '(nunca)';
      console.log(
        `${s.id}  ${archivos} archivos  ${mb}  activo:${ultimo}  ${s.name || '(sin nombre)'} ${marca}`,
      );
    }

    console.log(
      '\n💡 Si arriba no salió ningún ★, identifica por NOMBRE cuál es el de EC\n' +
        '   y cuál el de MX: esos ids van en imporia_prompts.vector_store_id.\n',
    );
  } catch (err) {
    console.log(`❌ No se pudieron listar los vector stores: ${detalleError(err)}\n`);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. Estado en la BD: cuánto historial hay que migrar
// ─────────────────────────────────────────────────────────────
async function estadoBD() {
  console.log('\n═══ 3. ESTADO EN LA BD (imporsuit) ═══\n');

  try {
    const [t] = await db_2.query(
      `SELECT COUNT(*) AS total,
              MIN(fecha_creacion_chat) AS primero,
              MAX(fecha_creacion_chat) AS ultimo
         FROM threads_imporsuit`,
      { type: db_2.QueryTypes.SELECT },
    );
    // Vienen como Date de mysql2: String() da "Thu Oct 02 2025 …", que cortado
    // a 10 no es una fecha. toISOString sí.
    const fecha = (v) =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    console.log(
      `threads_imporsuit      : ${t.total} conversaciones (${fecha(t.primero)} → ${fecha(t.ultimo)})`,
    );

    const [m] = await db_2.query(
      `SELECT COUNT(*) AS total FROM mensajes_gpt_imporsuit`,
      { type: db_2.QueryTypes.SELECT },
    );
    console.log(`mensajes_gpt_imporsuit : ${m.total} mensajes`);

    // Cuántas conversaciones están vivas de verdad: son las que van a notar el
    // corte de contexto, y por las que vale la pena sembrar el recap.
    const [act] = await db_2.query(
      `SELECT COUNT(DISTINCT t.id) AS activas
         FROM threads_imporsuit t
         INNER JOIN mensajes_gpt_imporsuit m ON m.id_thread = t.id
        WHERE m.fecha_creacion >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      { type: db_2.QueryTypes.SELECT },
    );
    console.log(
      `activas últimos 30 días: ${act.activas} conversaciones con mensajes`,
    );

    const cols = await db_2.query(`SHOW COLUMNS FROM threads_imporsuit`, {
      type: db_2.QueryTypes.SELECT,
    });
    console.log(
      `\ncolumnas de threads_imporsuit: ${cols.map((c) => c.Field).join(', ')}`,
    );
    if (cols.some((c) => c.Field === 'response_id')) {
      console.log('  → response_id YA existe (migración SQL ya aplicada)');
    } else {
      console.log(
        '  → falta response_id: hay que aplicar imporia_responses_migration.sql',
      );
    }
    console.log('');
  } catch (err) {
    console.log(`❌ Error leyendo la BD: ${err.message}\n`);
  }
}

(async () => {
  if (!API_KEY) {
    console.log('❌ Falta OPENAI_API_KEY en el .env');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════');
  console.log(' INVENTARIO IMPORIA — previo a Responses API');
  console.log('═══════════════════════════════════════════════');

  const stores = await inspeccionarAssistants();
  await listarVectorStores(stores);
  await estadoBD();

  process.exit(0);
})();
