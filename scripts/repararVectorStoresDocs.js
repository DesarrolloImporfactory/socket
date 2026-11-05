/* Repara los vector stores de DOCUMENTOS que la llave actual de OpenAI de la
   cuenta ya no ve (404 "Vector store vs_… not found in organization …").

   Pasa cuando la cuenta cambia su API Key por una de otro proyecto: el
   catálogo lo recrea la sincronización, pero los documentos (p. ej. el
   directorio de agencias Servientrega) quedaban apuntando al proyecto viejo y
   el bot se quedaba mudo en esas columnas (cfg 1511 MaeliShop, 29-10 →
   05-11-2026; cfg 613 ImporVerito). Desde el 05-11 el motor se cura solo en el
   turno y el guardado de la llave también lo revisa; este script sirve para
   barrer lo que ya estaba roto o para revisar una cuenta puntual.

   Los bytes salen de la copia local del server (src/uploads/kanban_docs/…),
   del default de la plataforma (src/assets/kanban_defaults/) o del texto
   extraído. Sin ninguna de las tres, el archivo queda 'perdido' y la columna
   sigue sin él.

   node scripts/repararVectorStoresDocs.js --cfg 1511            solo muestra
   node scripts/repararVectorStoresDocs.js --cfg 1511 --aplicar  repara
   node scripts/repararVectorStoresDocs.js --todas [--aplicar]   barre las 137 cuentas con documentos
*/
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');
const { leerApiKeyOpenAI } = require('../src/utils/openia/apiKeyOpenAI');
const {
  columnasConDocsInvisibles,
  recrearVectorStoresDocs,
} = require('../src/services/kanban_archivos.service');

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const APLICAR = process.argv.includes('--aplicar');
const cfgPedida = Number(arg('cfg')) || null;
const TODAS = process.argv.includes('--todas');

const q = (s, r) => db.query(s, { replacements: r, type: db.QueryTypes.SELECT });

(async () => {
  if (!cfgPedida && !TODAS) {
    console.log('Uso: --cfg <id> | --todas   [--aplicar]');
    process.exit(1);
  }
  console.log(APLICAR ? '⚠️  MODO APLICAR' : '🔍 Solo muestra (sin --aplicar no se escribe nada)');

  const cuentas = await q(
    `SELECT c.id, c.nombre_configuracion, c.api_key_openai,
            COUNT(kc.id) columnas
       FROM configuraciones c
       JOIN kanban_columnas kc ON kc.id_configuracion = c.id AND kc.vector_store_docs_id IS NOT NULL
      WHERE ${cfgPedida ? 'c.id = ?' : '1=1'}
      GROUP BY c.id ORDER BY c.id`,
    cfgPedida ? [cfgPedida] : [],
  );
  console.log(`${cuentas.length} cuenta(s) con documentos\n`);

  let rotasTotal = 0;
  let reparadas = 0;
  for (const c of cuentas) {
    const apiKey = leerApiKeyOpenAI(c.api_key_openai);
    if (!apiKey) {
      console.log(`cfg ${c.id} ${c.nombre_configuracion}: sin llave de OpenAI, se salta`);
      continue;
    }
    let rotas;
    try {
      rotas = await columnasConDocsInvisibles(c.id, apiKey);
    } catch (e) {
      console.log(`cfg ${c.id} ${c.nombre_configuracion}: no se pudo revisar (${e.message})`);
      continue;
    }
    if (!rotas.length) {
      if (cfgPedida) console.log(`cfg ${c.id} ${c.nombre_configuracion}: ${c.columnas} columna(s) con documentos, todas visibles ✔`);
      continue;
    }
    rotasTotal++;
    console.log(`cfg ${c.id} ${c.nombre_configuracion}: ${rotas.length}/${c.columnas} columna(s) con el store de documentos INVISIBLE para la llave actual (columnas ${rotas.join(', ')})`);
    if (!APLICAR) continue;
    try {
      const r = await recrearVectorStoresDocs(c.id, {
        apiKey,
        soloColumnas: rotas,
        logger: async (m) => console.log(`   ${m}`),
      });
      reparadas++;
      console.log(`   → ${r.columnas} columna(s), ${r.archivos} archivo(s) reindexados` + (r.perdidos.length ? `, perdidos: ${r.perdidos.join(', ')}` : ''));
    } catch (e) {
      console.log(`   ✖ falló la reparación: ${e?.response?.data?.error?.message || e.message}`);
    }
  }
  console.log(`\nCuentas con documentos invisibles: ${rotasTotal}` + (APLICAR ? ` · reparadas: ${reparadas}` : ''));
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
