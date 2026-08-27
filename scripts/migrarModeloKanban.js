/**
 * scripts/migrarModeloKanban.js
 *
 * Migra a gpt-5-mini las columnas kanban con IA activa que siguen en
 * gpt-4o-mini, SOLO en cuentas de las plantillas e-commerce (13 EC, 25 MX,
 * 26 CO, 27 PE, 28 GT) — las verticales clínica/estética/inmobiliaria (21,
 * 23, 29) se quedan en 4o-mini a propósito. De paso sube max_tokens al piso
 * de 2000 que los modelos de razonamiento necesitan.
 *
 * Mismo criterio que el rollout de plantillas globales del 24/08: el cambio
 * es en BD (kanban_columnas.modelo); las cuentas en Responses API lo toman
 * de ahí. Una cuenta legacy con Assistants conserva el modelo del assistant
 * hasta que se resincronice.
 *
 * Uso:
 *   node scripts/migrarModeloKanban.js           (dry-run)
 *   node scripts/migrarModeloKanban.js --apply   (aplica)
 */
require('dotenv').config();
const { db } = require('../src/database/config');

const APPLY = process.argv.includes('--apply');
const PLANTILLAS_ECOMMERCE = [13, 25, 26, 27, 28];
const DESTINO = 'gpt-5-mini';

(async () => {
  const candidatas = await db.query(
    `SELECT kc.id_configuracion, COUNT(*) AS columnas
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.activo = 1 AND kc.activa_ia = 1
        AND kc.modelo = 'gpt-4o-mini'
        AND c.kanban_global_id IN (:pl)
        AND COALESCE(c.suspendido, 0) = 0
      GROUP BY kc.id_configuracion
      ORDER BY kc.id_configuracion`,
    { replacements: { pl: PLANTILLAS_ECOMMERCE }, type: db.QueryTypes.SELECT },
  );

  const totalCols = candidatas.reduce((a, c) => a + Number(c.columnas), 0);
  console.log(
    `${candidatas.length} configuraciones e-commerce con ${totalCols} columnas IA en gpt-4o-mini.`,
  );
  console.table(candidatas.slice(0, 20));
  if (candidatas.length > 20)
    console.log(`… y ${candidatas.length - 20} configs más.`);

  if (!APPLY) {
    console.log('\nDRY-RUN: nada se cambió. Repite con --apply para migrar.');
    process.exit(0);
  }

  const [, meta] = await db.query(
    `UPDATE kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
        SET kc.modelo = :destino,
            kc.max_tokens = GREATEST(COALESCE(kc.max_tokens, 500), 2000)
      WHERE kc.activo = 1 AND kc.activa_ia = 1
        AND kc.modelo = 'gpt-4o-mini'
        AND c.kanban_global_id IN (:pl)
        AND COALESCE(c.suspendido, 0) = 0`,
    {
      replacements: { destino: DESTINO, pl: PLANTILLAS_ECOMMERCE },
      type: db.QueryTypes.UPDATE,
    },
  );
  console.log(`\n✅ ${meta?.affectedRows ?? meta} columnas migradas a ${DESTINO}.`);
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
