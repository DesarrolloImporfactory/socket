/**
 * scripts/verificar_dedupe.js
 *
 * Comprobación de SOLO LECTURA del estado del índice de identidad de
 * contactos (uq_ccc_dedupe). No modifica nada.
 *
 * Uso:  node scripts/verificar_dedupe.js
 */
require('dotenv').config();
const { db } = require('../src/database/config');

(async () => {
  let fallos = 0;
  const ok = (cond, txt, extra = '') => {
    if (!cond) fallos++;
    console.log(`${cond ? '  OK  ' : ' FALLA'} | ${txt}${extra ? ' → ' + extra : ''}`);
  };

  try {
    console.log('\n=== 1. Triggers de dedupe ===');
    const [trg] = await db.query("SHOW TRIGGERS LIKE 'clientes_chat_center'");
    const bu = trg.find((t) => t.Trigger === 'trg_ccc_dedupe_bu');
    ok(!!trg.find((t) => t.Trigger === 'trg_ccc_dedupe_bi'), 'existe trg_ccc_dedupe_bi');
    ok(!!bu, 'existe trg_ccc_dedupe_bu');
    ok(
      !!bu && /OLD\.dedupe_key IS NOT NULL/.test(bu.Statement),
      'trg_ccc_dedupe_bu recalcula la clave (migración aplicada)',
      bu && !/OLD\.dedupe_key IS NOT NULL/.test(bu.Statement)
        ? 'sigue la versión vieja: falta correr contactos_dedupe_update_migration.sql'
        : '',
    );

    console.log('\n=== 2. Claves desincronizadas (la causa del 500) ===');
    const [des] = await db.query(
      `SELECT COUNT(*) n FROM clientes_chat_center
        WHERE dedupe_key IS NOT NULL AND source='wa' AND deleted_at IS NULL
          AND dedupe_key <> CONCAT(id_configuracion,':wa:',celular_last9)`,
    );
    ok(des[0].n === 0, 'ninguna dedupe_key apunta a un número ajeno', `${des[0].n} filas`);

    console.log('\n=== 3. Cobertura del índice ===');
    const [cob] = await db.query(
      `SELECT COUNT(*) total, SUM(dedupe_key IS NOT NULL) conKey
         FROM clientes_chat_center
        WHERE deleted_at IS NULL AND source='wa' AND CHAR_LENGTH(celular_last9)>=8`,
    );
    console.log(
      `  INFO | contactos WA vivos: ${cob[0].total} | protegidos: ${cob[0].conKey}` +
        ` (${((100 * cob[0].conKey) / cob[0].total).toFixed(1)}%)`,
    );

    console.log('\n=== 4. Duplicados por número (mismo cfg + últimos 9) ===');
    const [dup] = await db.query(
      `SELECT COUNT(*) grupos FROM (
         SELECT id_configuracion, celular_last9
           FROM clientes_chat_center
          WHERE deleted_at IS NULL AND source='wa' AND CHAR_LENGTH(celular_last9)>=8
          GROUP BY id_configuracion, celular_last9 HAVING COUNT(*)>1) t`,
    );
    console.log(`  INFO | ${dup[0].grupos} números duplicados (históricos, no se limpian aquí)`);

    console.log(
      `\n${fallos === 0 ? '✅ Todo correcto' : `❌ ${fallos} comprobación(es) fallida(s)`}\n`,
    );
  } catch (e) {
    console.error('ERROR:', e.message);
  }
  process.exit(0);
})();
