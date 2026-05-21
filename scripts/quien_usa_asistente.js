require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');
(async () => {
  const aid = process.argv[2];
  const rows = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.nombre, kc.estado_db, kc.activo, kc.activa_ia
     FROM kanban_columnas kc WHERE kc.assistant_id = ?`,
    { replacements: [aid], type: db.QueryTypes.SELECT },
  );
  console.log(`Columnas con assistant_id = ${aid}:`);
  rows.forEach((r) =>
    console.log(`  cfg=${r.id_configuracion} col=${r.id} "${r.nombre}" estado=${r.estado_db} activo=${r.activo} activa_ia=${r.activa_ia}`),
  );
  process.exit(0);
})();
