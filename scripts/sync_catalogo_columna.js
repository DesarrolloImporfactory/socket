/**
 * Sincroniza el catálogo de UNA columna del kanban con OpenAI: sube el archivo,
 * crea el vector store y lo deja adjunto al asistente de esa columna.
 *
 * Es lo que hay que correr después de crear una columna a mano; sin esto el
 * asistente responde sin catálogo, que es como termina inventando precios.
 *
 * Uso:
 *   node scripts/sync_catalogo_columna.js <id_kanban_columna>
 */

require('dotenv').config();
const initModels = require('../src/models/initModels');
const {
  syncCatalogoKanbanColumna,
} = require('../src/services/syncCatalogoKanbanColumna.service');

const ID_COLUMNA = Number(process.argv[2]);

if (!ID_COLUMNA) {
  console.error('Falta el id de la columna. Ej: node scripts/sync_catalogo_columna.js 6740');
  process.exit(1);
}

initModels();

syncCatalogoKanbanColumna(ID_COLUMNA)
  .then((r) => {
    console.log('\n✅ Sincronizado:', JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
