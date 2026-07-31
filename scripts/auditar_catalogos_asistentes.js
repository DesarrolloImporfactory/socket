/**
 * Audita que el catálogo de cada columna con IA esté REALMENTE conectado a su
 * asistente de OpenAI.
 *
 * Por qué existe: hasta el 30/07/2026 la limpieza del sync mandaba
 * `vector_store_ids: []` al asistente, así que la columna quedaba con un vector
 * store válido en BD y el asistente sin nada que buscar. El bot seguía
 * contestando —inventando precios y datos— y nada avisaba. Se encontraron 121
 * columnas así en 45 cuentas.
 *
 * Uso:
 *   node scripts/auditar_catalogos_asistentes.js             → solo reporta
 *   node scripts/auditar_catalogos_asistentes.js --reparar   → vuelve a adjuntar
 *
 * Reparar solo re-adjunta el store que la columna YA tiene en BD: no recrea
 * catálogos ni sube archivos. Si el store ya no existe en OpenAI, lo dice y no
 * toca nada — esa columna necesita resincronizar el catálogo desde el panel.
 */

require('dotenv').config();
const axios = require('axios');
const { db } = require('../src/database/config');

const REPARAR = process.argv.includes('--reparar');

async function main() {
  const columnas = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.nombre, kc.estado_db,
            kc.assistant_id, kc.vector_store_id, c.api_key_openai
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.activo = 1 AND kc.activa_ia = 1
        AND kc.assistant_id IS NOT NULL AND kc.assistant_id <> ''
        AND kc.vector_store_id IS NOT NULL AND kc.vector_store_id <> ''
        AND c.api_key_openai IS NOT NULL AND c.api_key_openai <> ''
        AND c.suspendido = 0
      ORDER BY kc.id_configuracion, kc.orden`,
    { type: db.QueryTypes.SELECT },
  );

  console.log(`Revisando ${columnas.length} columnas con catálogo…\n`);

  let desconectadas = 0;
  let reparadas = 0;
  let inaccesibles = 0;
  let sinStore = 0;

  for (const col of columnas) {
    const headers = {
      Authorization: `Bearer ${col.api_key_openai}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json',
    };

    let asistente;
    try {
      const { data } = await axios.get(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        { headers, timeout: 20000 },
      );
      asistente = data;
    } catch (err) {
      // Asistente borrado o api key inválida: es otro problema, no este.
      inaccesibles++;
      continue;
    }

    const adjuntos =
      asistente.tool_resources?.file_search?.vector_store_ids || [];
    if (adjuntos.includes(col.vector_store_id)) continue;

    desconectadas++;
    console.log(
      `⚠️  config ${col.id_configuracion} · col ${col.id} · ${col.estado_db} «${col.nombre}»\n` +
        `    bd=${col.vector_store_id}  assistant=[${adjuntos.join(', ') || 'vacío'}]`,
    );

    if (!REPARAR) continue;

    // El store de la BD tiene que existir de verdad antes de adjuntarlo.
    try {
      await axios.get(
        `https://api.openai.com/v1/vector_stores/${col.vector_store_id}`,
        { headers, timeout: 20000 },
      );
    } catch (err) {
      sinStore++;
      console.log(
        '    ⛔ el store de la BD ya no existe en OpenAI: hay que resincronizar el catálogo',
      );
      continue;
    }

    const tools = Array.isArray(asistente.tools) ? asistente.tools : [];
    const conFileSearch = tools.some((t) => t?.type === 'file_search')
      ? tools
      : [...tools, { type: 'file_search' }];

    try {
      await axios.post(
        `https://api.openai.com/v1/assistants/${col.assistant_id}`,
        {
          tools: conFileSearch,
          tool_resources: {
            file_search: { vector_store_ids: [col.vector_store_id] },
          },
        },
        { headers, timeout: 20000 },
      );
      reparadas++;
      console.log('    ✅ reparado');
    } catch (err) {
      console.log(
        '    ❌ no se pudo reparar: ' +
          (err.response?.data?.error?.message || err.message),
      );
    }
  }

  console.log(
    `\nResumen: ${desconectadas} columna(s) con el catálogo desconectado` +
      (REPARAR ? ` · ${reparadas} reparada(s) · ${sinStore} sin store` : '') +
      ` · ${inaccesibles} asistente(s) inaccesibles` +
      (REPARAR ? '' : '\n(corre con --reparar para adjuntarlos)'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
