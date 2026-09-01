/**
 * Backfill del catálogo inline para las columnas que siguen en file_search.
 *
 * Contexto (medido 2026-09-01): 484 columnas IA ya van por inline, pero 338
 * siguen inyectando ~16k tokens de fragmentos de file_search por llamada
 * porque nunca sincronizaron su catalogo_inline — ese texto solo se llena al
 * guardar un producto, y esas cuentas no han guardado ninguno desde que
 * GENERAR_CATALOGO_INLINE está activo.
 *
 * Este script genera el texto con generarInlineColumna (la MISMA lógica del
 * sync normal, sin tocar OpenAI: ni archivos, ni vector stores, ni API keys).
 * Llenar catalogo_inline es lo único que falta para que el runtime las pase a
 * inline solo (TODAS_INLINE + tope): las que no quepan en el tope siguen en
 * file_search sin que nadie las toque, que es el comportamiento probado.
 *
 * Alcance a propósito: SOLO columnas activas con IA y CON vector_store_id.
 * Una columna sin vector store hoy no tiene catálogo; llenarle el inline le
 * cambiaría el comportamiento (el bot empezaría a ver productos que antes no
 * veía), y eso no es un backfill, es una decisión.
 *
 * Uso:
 *   node scripts/backfillCatalogoInline.js            # dry-run: reporta, no escribe
 *   node scripts/backfillCatalogoInline.js --aplicar  # escribe catalogo_inline
 */

require('dotenv').config();
const { db } = require('../src/database/config');
const {
  generarInlineColumna,
} = require('../src/services/syncCatalogoKanbanColumna.service');
const { TOPE_CATALOGO_INLINE } = require('../src/utils/openia/fileSearch');

const APLICAR = process.argv.includes('--aplicar');

(async () => {
  const candidatas = await db.query(
    `SELECT kc.id, kc.id_configuracion, kc.nombre
       FROM kanban_columnas kc
      WHERE kc.activo = 1 AND kc.activa_ia = 1
        AND kc.vector_store_id IS NOT NULL AND kc.vector_store_id <> ''
        AND (kc.catalogo_inline IS NULL OR kc.catalogo_inline = ''
             OR COALESCE(kc.catalogo_inline_tokens, 0) = 0)
      ORDER BY kc.id_configuracion, kc.id`,
    { type: db.QueryTypes.SELECT },
  );

  console.log(
    `${APLICAR ? '✍️ APLICANDO' : '👓 DRY-RUN (nada se escribe; corre con --aplicar)'}` +
      ` — ${candidatas.length} columnas candidatas\n`,
  );

  let pasanAInline = 0;
  let quedanPorTope = 0;
  let sinProductos = 0;
  let errores = 0;

  for (const col of candidatas) {
    try {
      const r = await generarInlineColumna(col.id, {
        dryRun: !APLICAR,
        logger: async () => {}, // el resumen de abajo ya lo dice todo
      });

      if (r.skipped) {
        sinProductos++;
        console.log(
          `— columna=${col.id} config=${col.id_configuracion} "${col.nombre}": ${r.reason}`,
        );
        continue;
      }

      const cabe = r.tokens <= TOPE_CATALOGO_INLINE;
      if (cabe) pasanAInline++;
      else quedanPorTope++;
      console.log(
        `${cabe ? '📄' : '🔎'} columna=${col.id} config=${col.id_configuracion} ` +
          `"${col.nombre}": ${r.total_items} items, ${r.tokens} tokens` +
          `${cabe ? '' : ` (> tope ${TOPE_CATALOGO_INLINE}: sigue en file_search)`}`,
      );
    } catch (err) {
      errores++;
      console.error(
        `❌ columna=${col.id} config=${col.id_configuracion}: ${err.message}`,
      );
    }
  }

  console.log(
    `\nResumen: ${pasanAInline} pasan a inline, ${quedanPorTope} quedan en ` +
      `file_search por tope, ${sinProductos} sin productos, ${errores} errores.`,
  );
  if (!APLICAR) {
    console.log('Nada se escribió. Para aplicar: node scripts/backfillCatalogoInline.js --aplicar');
  }

  await db.close();
  process.exit(errores ? 1 : 0);
})().catch((err) => {
  console.error('ERROR fatal:', err.message);
  process.exit(1);
});
