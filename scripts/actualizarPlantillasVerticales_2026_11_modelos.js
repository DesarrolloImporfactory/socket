// Plantillas globales de las verticales (21 Clínicas, 23 Centros Estéticos,
// 29 Inmobiliario) — modelo recomendado por columna.
//
// Revisión del 2026-11-12 (reclamo de gasto de la cfg 1512): las plantillas
// de e-commerce (13, 25, 26, 27, 28) y de proveeduría (30-34) ya traen
// gpt-5-mini en todas las columnas con IA y la de agencias (35) nació con la
// familia 4.1. Las tres verticales viejas siguen con gpt-4o en las columnas
// de seguimiento: cuesta 6 veces más que gpt-4.1-mini por la misma tarea
// (entrada 2,50 vs 0,40 USD por millón; salida 10 vs 1,60).
//
// Criterio, el mismo de la plantilla 35:
//   - la columna que califica al cliente      → gpt-4.1  (sucesor directo de 4o, 20% menos)
//   - el resto de columnas que estaban en 4o  → gpt-4.1-mini
//   - lo que ya estaba en gpt-4o-mini no se toca (es más barato todavía)
// Ninguno de los dos razona, así que max_tokens queda igual.
//
// Sube la versión +0.1: las cuentas instaladas ven el aviso «Actualizar
// tablero» y el modelo viaja con la actualización (es opcional para ellas).
//
// OJO: en migrarModeloKanban.js las verticales se dejaron en la familia 4o «a
// propósito». Antes de aplicar, probar el cambio en la cuenta donde se pule
// cada tablero (estética: 818).
//
//   node scripts/actualizarPlantillasVerticales_2026_11_modelos.js            → muestra los cambios
//   node scripts/actualizarPlantillasVerticales_2026_11_modelos.js --aplicar  → escribe
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const path = require('path');
const { db } = require(ROOT + '/src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const S = path.join(__dirname, '..', 'logs', 'plantillas');

const PLANTILLAS = [21, 23, 29];
const ORIGEN = 'gpt-4o';
const COLUMNA_QUE_CALIFICA = 'califica';
const MODELO_CALIFICA = 'gpt-4.1';
const MODELO_RESTO = 'gpt-4.1-mini';

function nuevoModelo(col) {
  if (Number(col.activa_ia) !== 1) return null;
  if (String(col.modelo || '').trim() !== ORIGEN) return null;
  return col.estado_db === COLUMNA_QUE_CALIFICA ? MODELO_CALIFICA : MODELO_RESTO;
}

(async () => {
  const plantillas = await db.query(
    `SELECT id, nombre, pais, version, data FROM kanban_plantillas_globales
      WHERE id IN (:ids) AND activo = 1 ORDER BY id`,
    { replacements: { ids: PLANTILLAS }, type: db.QueryTypes.SELECT },
  );

  if (APLICAR) {
    fs.mkdirSync(S, { recursive: true });
    fs.writeFileSync(
      path.join(S, `respaldo_plantillas_verticales_${Date.now()}.json`),
      JSON.stringify(plantillas, null, 1),
    );
  }

  for (const p of plantillas) {
    const data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
    const cambios = [];
    for (const col of data.columnas || []) {
      const destino = nuevoModelo(col);
      if (!destino) continue;
      cambios.push(`${col.estado_db}: ${col.modelo} → ${destino}`);
      col.modelo = destino;
    }
    const versionNueva = Math.round((Number(p.version) + 0.1) * 10) / 10;
    if (!cambios.length) {
      console.log(`\n${p.id} ${p.nombre} v${p.version}: sin cambios`);
      continue;
    }
    console.log(
      `\n${p.id} ${p.nombre} v${p.version} → v${versionNueva}\n   - ${cambios.join('\n   - ')}`,
    );
    if (!APLICAR) continue;
    await db.query(
      `UPDATE kanban_plantillas_globales SET data = ?, version = ROUND(version + 0.1, 1) WHERE id = ?`,
      { replacements: [JSON.stringify(data), p.id], type: db.QueryTypes.UPDATE },
    );
    console.log('   aplicada');
  }

  if (!APLICAR) console.log('\nSolo se mostraron los cambios. Repite con --aplicar para escribir.');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
