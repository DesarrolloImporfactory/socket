// Repara la frase del precio del combo en la regla 5 (COMBOS) de los prompts
// de Contacto Inicial. El script del 2026-09-08 la insertó con un
// String.replace donde "$2" se leyó como grupo de captura (el "\n6. VARIEDAD"
// de la regla siguiente) y quedó así en las 5 plantillas e-commerce y en
// todas las cuentas que las aplicaron después:
//
//   (si 1 cuesta \n6. VARIEDAD0 y el combo de 2 cuesta \n6. VARIEDAD5, dos unidades = \n6. VARIEDAD5, NUNCA $40).
//
// en vez de
//
//   (si 1 cuesta $20 y el combo de 2 cuesta $25, dos unidades = $25, NUNCA $40).
//
// Qué hace:
//   1. Plantillas globales (por defecto 13 EC, 26 CO, 27 PE, 28 GT; la 25 MX
//      ya se reparó en su v6.4): corrige la frase y sube la versión +0.1.
//   2. Cuentas: corrige la misma frase en kanban_columnas.instrucciones (lo
//      que lee la Responses API) y en kanban_columnas_personalizaciones
//      .prompt_base_snapshot (para que el próximo resync/personalizar no la
//      reviva), en TODA columna que la tenga, use la plantilla que use.
//   3. Las cuentas de esas plantillas que estaban al día (prompt_version ==
//      versión vieja) y quedaron parchadas pasan a la versión nueva: el
//      cambio ya lo tienen, no hay que marcarles "desactualizado".
//
//   node scripts/repararFraseCombo.js            → muestra qué cambiaría
//   node scripts/repararFraseCombo.js --aplicar  → escribe
const ROOT = require('path').join(__dirname, '..');
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/.env' });
const fs = require('fs');
const path = require('path');
const { db } = require(ROOT + '/src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const PLANTILLAS = [13, 26, 27, 28];
/* La frase rota aparece con variantes en las cuentas: el editor del cliente
   quita los "$" ("NUNCA 40)"), a veces se pierde el ")." final y hay prompts
   re-envueltos a 80 columnas ("(si 1\ncuesta 6. VARIEDAD0…"). La regex cubre
   todas; el reemplazo va por función para que "$" no se interprete. */
const ROTA_RE =
  /\(si 1\s+cuesta\s*6\. VARIEDAD0 y el combo de 2 cuesta\s*6\. VARIEDAD5, dos unidades =\s*6\. VARIEDAD5, NUNCA \$?40\)?\.?/g;
const ROTA_LIKE = '%6. VARIEDAD0 y el combo%';
const BUENA =
  '(si 1 cuesta $20 y el combo de 2 cuesta $25, dos unidades = $25, NUNCA $40).';
const S = path.join(ROOT, 'logs', 'plantillas');
fs.mkdirSync(S, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');

const vecesRota = (t) => (String(t || '').match(ROTA_RE) || []).length;
const reparar = (t) => String(t).replace(ROTA_RE, () => BUENA);

(async () => {
  /* 1. Plantillas globales */
  const versiones = {}; // id → { vieja, nueva }
  const pls = await db.query(
    `SELECT id, nombre, pais, version, data FROM kanban_plantillas_globales WHERE id IN (?)`,
    { replacements: [PLANTILLAS], type: db.QueryTypes.SELECT },
  );
  for (const p of pls) {
    const data = JSON.parse(p.data);
    const ci = data.columnas.find((c) => c.estado_db === 'contacto_inicial');
    const n = vecesRota(ci?.instrucciones);
    if (n !== 1) {
      console.log(
        `plantilla ${p.id} ${p.pais} v${p.version}: frase rota encontrada ${n} veces → se deja como está`,
      );
      continue;
    }
    const nueva = Math.round((Number(p.version) + 0.1) * 10) / 10;
    versiones[p.id] = { vieja: Number(p.version), nueva };
    console.log(
      `plantilla ${p.id} ${p.pais} v${p.version} → v${nueva}: frase del combo reparada`,
    );
    if (APLICAR) {
      fs.writeFileSync(
        path.join(S, `combo_${p.id}_antes_${ts}.txt`),
        ci.instrucciones,
      );
      ci.instrucciones = reparar(ci.instrucciones);
      await db.query(
        `UPDATE kanban_plantillas_globales SET data = ?, version = ROUND(version + 0.1, 1) WHERE id = ?`,
        {
          replacements: [JSON.stringify(data), p.id],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
  }

  /* 2. Columnas de las cuentas (instrucciones + snapshot) */
  const cols = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.estado_db, kc.instrucciones,
            c.kanban_global_id, c.prompt_version
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.instrucciones LIKE ?`,
    { replacements: [ROTA_LIKE], type: db.QueryTypes.SELECT },
  );
  const snaps = await db.query(
    `SELECT id, id_kanban_columna, id_configuracion, prompt_base_snapshot
       FROM kanban_columnas_personalizaciones
      WHERE prompt_base_snapshot LIKE ?`,
    { replacements: [ROTA_LIKE], type: db.QueryTypes.SELECT },
  );
  const cfgsTocadas = new Set(cols.map((c) => c.id_configuracion));
  const porPlantilla = {};
  for (const c of cols)
    porPlantilla[c.kanban_global_id ?? 'sin'] =
      (porPlantilla[c.kanban_global_id ?? 'sin'] || 0) + 1;
  console.log(
    `\nColumnas con la frase rota: ${cols.length} (en ${cfgsTocadas.size} cuentas; por plantilla: ${JSON.stringify(porPlantilla)}) · snapshots: ${snaps.length}`,
  );

  if (APLICAR) {
    fs.writeFileSync(
      path.join(S, `combo_columnas_antes_${ts}.json`),
      JSON.stringify(
        cols.map((c) => ({
          id: c.id,
          id_configuracion: c.id_configuracion,
          instrucciones: c.instrucciones,
        })),
        null,
        2,
      ),
    );
    let nCols = 0;
    for (const c of cols) {
      const [, meta] = await db.query(
        `UPDATE kanban_columnas SET instrucciones = ? WHERE id = ?`,
        {
          replacements: [reparar(c.instrucciones), c.id],
          type: db.QueryTypes.UPDATE,
        },
      );
      nCols += Number(meta?.affectedRows ?? meta ?? 0) ? 1 : 0;
    }
    for (const s of snaps) {
      await db.query(
        `UPDATE kanban_columnas_personalizaciones SET prompt_base_snapshot = ? WHERE id = ?`,
        {
          replacements: [reparar(s.prompt_base_snapshot), s.id],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
    console.log(
      `   ✔ ${nCols} columnas y ${snaps.length} snapshots reparados (respaldo en logs/plantillas/combo_columnas_antes_${ts}.json)`,
    );
  }

  /* 3. Versión de las cuentas que ya estaban al día */
  for (const [idPl, v] of Object.entries(versiones)) {
    const ids = [...cfgsTocadas].filter((id) =>
      cols.some(
        (c) =>
          c.id_configuracion === id &&
          Number(c.kanban_global_id) === Number(idPl) &&
          Number(c.prompt_version) === v.vieja,
      ),
    );
    console.log(
      `plantilla ${idPl}: ${ids.length} cuentas al día (v${v.vieja}) pasan a v${v.nueva}${ids.length ? ` → ${ids.join(', ')}` : ''}`,
    );
    if (APLICAR && ids.length) {
      await db.query(
        `UPDATE configuraciones SET prompt_version = ? WHERE id IN (?)`,
        {
          replacements: [v.nueva, ids],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
  }

  /* Verificación */
  if (APLICAR) {
    const [{ n }] = await db.query(
      `SELECT COUNT(*) n FROM kanban_columnas WHERE instrucciones LIKE ?`,
      {
        replacements: [ROTA_LIKE],
        type: db.QueryTypes.SELECT,
      },
    );
    const [{ m }] = await db.query(
      `SELECT COUNT(*) m FROM kanban_plantillas_globales WHERE data LIKE ?`,
      {
        replacements: [ROTA_LIKE],
        type: db.QueryTypes.SELECT,
      },
    );
    console.log(
      `\nVerificación: columnas con la frase rota = ${n}, plantillas con la frase rota = ${m}`,
    );
  } else {
    console.log('\n(sin --aplicar: no se escribió nada)');
  }
  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
