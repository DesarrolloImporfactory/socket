require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');

(async () => {
  const tablas = ['configuraciones', 'clientes_chat_center', 'kanban_columnas', 'kanban_acciones'];
  for (const t of tablas) {
    console.log(`\n══ ${t} ══`);
    const cols = await db.query(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY ordinal_position`,
      { replacements: [t], type: db.QueryTypes.SELECT },
    );
    cols.forEach((c) => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  }
  process.exit(0);
})();
