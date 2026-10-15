/* Corrige configuraciones.pais: nunca se guardaba y todas quedaron con el
   default 'ec', también las de números de México. Se deduce del prefijo
   del teléfono; las que no se reconocen no se tocan.
   Uso: node scripts/backfillPaisConfiguraciones.js [--dry] */
require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
});
const { db } = require('../src/database/config');
const { paisDesdeTelefono } = require('../src/utils/paisDesdeTelefono');

const DRY = process.argv.includes('--dry');

(async () => {
  const rows = await db.query(
    `SELECT c.id, c.nombre_configuracion, c.telefono, c.pais,
            (SELECT d.country_code FROM dropi_integrations d
              WHERE d.id_configuracion = c.id AND d.deleted_at IS NULL
              LIMIT 1) AS pais_dropi
       FROM configuraciones c`,
    { type: db.QueryTypes.SELECT },
  );

  const cambios = [];
  const porPais = {};
  for (const r of rows) {
    const nuevo = paisDesdeTelefono(r.telefono);
    if (!nuevo || nuevo === String(r.pais || '').toLowerCase()) continue;
    cambios.push({ ...r, nuevo });
    porPais[nuevo] = (porPais[nuevo] || 0) + 1;
  }

  console.log(
    `Configuraciones: ${rows.length} · a corregir: ${cambios.length}`,
  );
  console.log('Por país nuevo:', porPais);

  // Aviso: el número dice un país y Dropi otro (no se cambia el criterio).
  const choques = cambios.filter(
    (c) => c.pais_dropi && c.pais_dropi.toLowerCase() !== c.nuevo,
  );
  if (choques.length) {
    console.log(`\nNúmero y Dropi no coinciden (${choques.length}):`);
    choques.forEach((c) =>
      console.log(
        `  cfg ${c.id} ${c.telefono} → ${c.nuevo} · Dropi ${c.pais_dropi}`,
      ),
    );
  }

  if (DRY) {
    cambios
      .slice(0, 15)
      .forEach((c) =>
        console.log(
          `  cfg ${c.id} "${c.nombre_configuracion}" ${c.telefono}: ${c.pais} → ${c.nuevo}`,
        ),
      );
    console.log('\n--dry: no se escribió nada.');
    process.exit(0);
  }

  for (const [pais, n] of Object.entries(porPais)) {
    const ids = cambios.filter((c) => c.nuevo === pais).map((c) => c.id);
    await db.query(`UPDATE configuraciones SET pais = ? WHERE id IN (?)`, {
      replacements: [pais, ids],
    });
    console.log(`  ${pais}: ${n} actualizadas`);
  }
  console.log('Listo.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
