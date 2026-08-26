'use strict';

/**
 * CLI de soporte sobre la auditoría de la API pública. La lógica real vive en
 * src/services/apiAuditoria.service.js — la MISMA que usa la pestaña
 * "Actividad" de /api-metricas, así el dueño y el soporte ven y revierten
 * exactamente igual.
 *
 * Uso:
 *   node scripts/revertirCambioApi.js 277                  → últimos cambios
 *   node scripts/revertirCambioApi.js 277 --ver 15         → previo vs nuevo
 *   node scripts/revertirCambioApi.js 277 --revertir 15    → aplica el previo
 */

require('dotenv').config();
const {
  listarAuditoria,
  obtenerCambio,
  revertirCambio,
} = require('../src/services/apiAuditoria.service');

const [, , cfgArg, accion, idArg] = process.argv;
const id_configuracion = Number(cfgArg);
const idAuditoria = Number(idArg);

const uso = () => {
  console.log(
    'Uso: node scripts/revertirCambioApi.js <id_configuracion> [--ver <id> | --revertir <id>]',
  );
  process.exit(1);
};

(async () => {
  if (!id_configuracion) uso();

  if (!accion) {
    const filas = await listarAuditoria(id_configuracion, 20);
    if (!filas.length) {
      console.log(`Sin cambios auditados para la config ${id_configuracion}.`);
    } else {
      console.table(
        filas.map((f) => ({
          id: f.id,
          cuando: f.created_at,
          llave: f.llave || '?',
          accion: f.accion,
          recurso: f.recurso,
        })),
      );
      console.log('Detalle: --ver <id> · Deshacer: --revertir <id>');
    }
    process.exit(0);
  }

  if (accion === '--ver' && idAuditoria) {
    const fila = await obtenerCambio(idAuditoria, id_configuracion);
    if (!fila) {
      console.error(`No existe el cambio #${idAuditoria} en esa config.`);
      process.exit(1);
    }
    console.log(
      `── Cambio #${fila.id} · ${fila.accion} · ${fila.recurso} · ${fila.created_at} · llave: ${fila.llave || '?'}`,
    );
    console.log('\n▼ PREVIO (lo que se restauraría):');
    console.log(JSON.stringify(fila.previo, null, 2)?.slice(0, 4000) || '(nada)');
    console.log('\n▼ NUEVO (lo que escribió el tercero):');
    console.log(JSON.stringify(fila.nuevo, null, 2)?.slice(0, 4000) || '(nada)');
    process.exit(0);
  }

  if (accion === '--revertir' && idAuditoria) {
    const r = await revertirCambio({
      id: idAuditoria,
      id_configuracion,
      actor: 'script',
    });
    console.log(`✅ ${r.mensaje}`);
    process.exit(0);
  }

  uso();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
