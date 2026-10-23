/**
 * Corre "Adaptar el bot a mi negocio" desde la terminal, sin pasar por el
 * front. Sirve para montarle el tablero a un cliente desde soporte y para
 * probar el generador contra casos reales.
 *
 * Uso:
 *   node scripts/adaptar_tablero.js <id_configuracion> <respuestas.json>            → solo comprende (imprime ficha + plan)
 *   node scripts/adaptar_tablero.js <id_configuracion> <respuestas.json> --construir → además BORRA el tablero actual e instala el nuevo
 *   node scripts/adaptar_tablero.js <id_configuracion> --ficha <ficha.json> --construir → construye desde una ficha ya revisada
 *
 * El JSON de respuestas usa las claves del cuestionario
 * (kanban_adaptar.service.CUESTIONARIO): nombre_negocio, que_ofreces, rubro,
 * clientes, objetivos[], lugar_servicio, cobertura, forma_pago, datos_extra,
 * nombre_asistente, tono, reglas, objeciones, cuando_humano.
 *
 * Los archivos con datos de clientes NO van en el repo (es público): guárdalos
 * fuera y pásalos por ruta.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const adaptar = require('../src/services/kanban_adaptar.service');

const args = process.argv.slice(2);
const ID_CONFIG = Number(args[0]);
const CONSTRUIR = args.includes('--construir');
const idxFicha = args.indexOf('--ficha');
const rutaFicha = idxFicha >= 0 ? args[idxFicha + 1] : null;
const rutaRespuestas = args.slice(1).find((a) => a.endsWith('.json') && a !== rutaFicha);

if (!ID_CONFIG || (!rutaRespuestas && !rutaFicha)) {
  console.error(
    'Uso: node scripts/adaptar_tablero.js <id_configuracion> <respuestas.json> [--construir]\n' +
      '     node scripts/adaptar_tablero.js <id_configuracion> --ficha <ficha.json> --construir',
  );
  process.exit(1);
}

const leer = (ruta) => JSON.parse(fs.readFileSync(path.resolve(ruta), 'utf8'));

async function main() {
  let ficha;
  let plan;
  let respuestas = null;

  if (rutaFicha) {
    ficha = leer(rutaFicha);
    if (rutaRespuestas) respuestas = leer(rutaRespuestas);
    plan = require('../src/utils/kanban_bloques_servicios.data').armarPlan(
      adaptar.reconciliar(ficha, respuestas || {}),
    );
  } else {
    respuestas = leer(rutaRespuestas);
    console.log(`→ Comprendiendo el negocio de la configuración ${ID_CONFIG}…`);
    const r = await adaptar.comprender({ id_configuracion: ID_CONFIG, respuestas });
    ficha = r.ficha;
    plan = r.plan;
  }

  console.log('\n══ FICHA ══');
  console.log(JSON.stringify(ficha, null, 2));
  console.log('\n══ PLAN ══');
  plan.columnas.forEach((c) =>
    console.log(`  ${c.ia ? '🤖' : '👤'} ${c.estado_db.padEnd(18)} ${c.nombre} — ${c.para_que}`),
  );
  console.log('  seguimientos:', plan.seguimientos.map((s) => `${s.estado_db} (${s.pasos.join(', ')})`).join(' | '));

  if (!CONSTRUIR) {
    console.log('\n(solo comprensión; agrega --construir para instalar el tablero)');
    return;
  }

  console.log(`\n→ Construyendo el tablero de la configuración ${ID_CONFIG} (se borra el actual)…`);
  const r = await adaptar.construir({
    id_configuracion: ID_CONFIG,
    ficha,
    respuestas,
    sincronizar_catalogo: false,
  });
  console.log(`✔ ${r.columnas.length} columnas, ${r.seguimientos} seguimientos, tablero anterior: ${r.borrado.columnas_eliminadas} columnas borradas, contactos recolocados: ${r.contactos_recolocados}`);
  r.columnas.forEach((c) =>
    console.log(`  #${c.id} ${c.estado_db.padEnd(18)} ${c.nombre} ia=${c.activa_ia} acciones=${c.acciones}`),
  );
  if (r.agenda) console.log(`  agenda: calendario ${r.agenda}`);
  if (r.sede) console.log(`  sede: ${JSON.stringify(r.sede)}`);

  /* Acá sí se espera: en segundo plano el proceso se cerraría a mitad. */
  console.log('\n→ Sincronizando el catálogo en las columnas con IA…');
  const {
    syncCatalogoTodasColumnasConfig,
  } = require('../src/services/syncCatalogoKanbanColumna.service');
  await syncCatalogoTodasColumnasConfig(ID_CONFIG, {
    logger: async (...a) => console.log('  [sync]', ...a),
  });
  console.log('✔ Catálogo sincronizado');
}

main()
  .then(() => setTimeout(() => process.exit(0), 1500))
  .catch((e) => {
    console.error('✖', e.message);
    process.exit(1);
  });
