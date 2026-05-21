require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');

(async () => {
  const idCol = Number(process.argv[2]);
  const [row] = await db.query(
    `SELECT id_kanban_columna, response_schema, accion_map, modelo, activo, created_at, updated_at
     FROM kanban_columnas_v2_schemas WHERE id_kanban_columna = ? LIMIT 1`,
    { replacements: [idCol], type: db.QueryTypes.SELECT },
  );
  if (!row) {
    console.log('Sin config V2 para columna', idCol);
    process.exit(0);
  }
  const safe = (v) => {
    if (!v) return null;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  };
  console.log('id_kanban_columna:', row.id_kanban_columna);
  console.log('activo:', row.activo);
  console.log('modelo:', row.modelo);
  console.log('created_at:', row.created_at);
  console.log('updated_at:', row.updated_at);
  console.log('\naccion_map:', safe(row.accion_map));
  const sch = safe(row.response_schema);
  console.log('\nresponse_schema.name:', sch?.name);
  console.log('response_schema.strict:', sch?.strict);
  console.log('response_schema.schema.required:', sch?.schema?.required);
  console.log('response_schema.schema.properties.accion.enum:', sch?.schema?.properties?.accion?.enum);
  process.exit(0);
})();
