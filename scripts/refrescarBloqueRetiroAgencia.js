// scripts/refrescarBloqueRetiroAgencia.js
// ─────────────────────────────────────────────────────────────
// Vuelve a escribir el bloque de plataforma "RETIRO EN AGENCIA SERVIENTREGA"
// en el prompt de cada columna IA de las cuentas con el switch ENCENDIDO.
//
// El bloque vive en kanban_columnas.instrucciones (lo que lee la Responses
// API) y solo se regenera al encender el switch o al recompilar el prompt
// (personalizar / resincronizar). Cuando cambia el TEXTO del bloque en
// promptCompiler.js (2026-09-08: "ciudad grande, primero el sector" y "solo
// oficinas que están en el archivo", tras el caso 411 de Santa Elena), las
// cuentas que ya lo tienen siguen con la versión vieja hasta que alguien
// toque su prompt. Este script las pone al día sin apagar/encender nada.
//
//   node scripts/refrescarBloqueRetiroAgencia.js            → solo muestra
//   node scripts/refrescarBloqueRetiroAgencia.js --aplicar  → escribe
//   node scripts/refrescarBloqueRetiroAgencia.js --aplicar --config 411
//
// Es idempotente: aplicarBloqueRetiroAgencia quita el bloque viejo y pone el
// nuevo; el resto del prompt no se toca. Misma BD que producción: correr
// DESPUÉS de deployar el código (la guardia en código y el bloque nuevo van
// juntos).
// ─────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');
const {
  aplicarBloqueRetiroAgencia,
} = require('../src/utils/promptCompiler');

const APLICAR = process.argv.includes('--aplicar');
const i = process.argv.indexOf('--config');
const SOLO = i > -1 ? Number(process.argv[i + 1]) : null;

(async () => {
  const cfgs = await db.query(
    `SELECT id, nombre_configuracion FROM configuraciones
      WHERE retiro_agencia_activo = 1 ${SOLO ? 'AND id = ?' : ''}
      ORDER BY id`,
    { replacements: SOLO ? [SOLO] : [], type: db.QueryTypes.SELECT },
  );
  console.log(`${cfgs.length} cuenta(s) con el switch encendido${APLICAR ? '' : ' (solo lectura; agregá --aplicar)'}\n`);

  let tocadas = 0;
  for (const cfg of cfgs) {
    const cols = await db.query(
      `SELECT id, nombre, instrucciones FROM kanban_columnas
        WHERE id_configuracion = ? AND activa_ia = 1 AND activo = 1
          AND instrucciones IS NOT NULL AND LENGTH(instrucciones) > 50`,
      { replacements: [cfg.id], type: db.QueryTypes.SELECT },
    );
    for (const col of cols) {
      const nuevo = aplicarBloqueRetiroAgencia(col.instrucciones, true);
      const cambia = nuevo !== String(col.instrucciones || '').trim();
      console.log(
        `  cfg ${cfg.id} (${cfg.nombre_configuracion}) · col ${col.id} ${col.nombre}: ` +
          (cambia ? `${APLICAR ? 'ACTUALIZADA' : 'cambiaría'} (${col.instrucciones.length} → ${nuevo.length} chars)` : 'ya al día'),
      );
      if (cambia && APLICAR) {
        await db.query(`UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`, {
          replacements: [nuevo, col.id],
        });
        tocadas++;
      }
    }
  }
  console.log(`\n${APLICAR ? `${tocadas} columna(s) actualizada(s)` : 'Nada escrito'}.`);
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
