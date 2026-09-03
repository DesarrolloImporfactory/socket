/* Diagnóstico de la API pública para la cfg 277 (Guardian): estado de la
   llave, columna scopes, tabla de auditoría y prompts del tablero. Solo lee. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');

(async () => {
  const q = (sql, repl = []) =>
    db.query(sql, { replacements: repl, type: db.QueryTypes.SELECT });

  console.log('══ columnas de api_keys ══');
  const cols = await q(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'api_keys'
     ORDER BY ordinal_position`,
  );
  console.log(cols.map((c) => c.COLUMN_NAME).join(', '));

  console.log('\n══ llaves de la cfg 277 ══');
  const tieneScopes = cols.some((c) => c.COLUMN_NAME === 'scopes');
  const llaves = await q(
    `SELECT id, nombre, key_prefix, ${tieneScopes ? 'scopes,' : ''} activo, usos,
            last_used_at, created_at, revoked_at
       FROM api_keys WHERE id_configuracion = 277`,
  );
  console.log(JSON.stringify(llaves, null, 2));

  console.log('\n══ tabla api_public_auditoria ══');
  const aud = await q(`SHOW TABLES LIKE 'api_public_auditoria'`);
  console.log(aud.length ? 'existe' : 'NO existe');
  if (aud.length) {
    const filas = await q(
      `SELECT id, id_api_key, recurso, accion, created_at
         FROM api_public_auditoria WHERE id_configuracion = 277
         ORDER BY id DESC LIMIT 20`,
    );
    console.log(JSON.stringify(filas, null, 2));
  }

  console.log('\n══ tablero cfg 277: columnas y prompts ══');
  const tablero = await q(
    `SELECT id, nombre, estado_db, activo,
            CHAR_LENGTH(COALESCE(instrucciones,'')) AS chars_prompt,
            LEFT(COALESCE(instrucciones,''), 120) AS inicio_prompt
       FROM kanban_columnas WHERE id_configuracion = 277 ORDER BY id`,
  );
  console.log(JSON.stringify(tablero, null, 2));

  const colsKanban = await q(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'kanban_columnas'
       AND COLUMN_NAME IN ('created_at','updated_at','fecha_actualizacion','fecha_creacion')`,
  );
  console.log('\ncolumnas de fecha en kanban_columnas:', colsKanban.map((c) => c.COLUMN_NAME).join(', ') || '(ninguna)');

  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
