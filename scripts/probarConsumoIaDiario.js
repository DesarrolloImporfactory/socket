// scripts/probarConsumoIaDiario.js
// Compara el panel de consumo de IA calculado desde el resumen diario
// (consumo_ia_diario) contra el mismo período leído entero de
// mensajes_clientes. Deben dar lo mismo salvo decimales de coma flotante.
//
//   node scripts/probarConsumoIaDiario.js <id_configuracion> [dias=7] [proveedor]
//
// La primera vez resume los días que falten de esa cuenta (solo lectura sobre
// mensajes_clientes; escribe en las tablas consumo_ia_diario*).
require('dotenv').config();
const { db } = require('../src/database/config');

const cfg = Number(process.argv[2]);
const dias = Number(process.argv[3] ?? 7);
const proveedor = process.argv[4] || '';
if (!cfg) {
  console.error(
    'Uso: node scripts/probarConsumoIaDiario.js <id_configuracion> [dias] [proveedor]',
  );
  process.exit(1);
}

function llamar(handler, body) {
  return new Promise((resolve, reject) => {
    const res = {
      status() {
        return res;
      },
      json(cuerpo) {
        resolve(cuerpo);
        return res;
      },
    };
    handler({ body }, res, reject);
  });
}

function diferencias(a, b, ruta = '', out = []) {
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) > tol) out.push(`${ruta}: ${a} ≠ ${b}`);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diferencias(a[k], b[k], ruta ? `${ruta}.${k}` : k, out);
    }
  } else if (a !== b) {
    out.push(`${ruta}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  }
  return out;
}

(async () => {
  const controller = require('../src/controllers/consumo_ia.controller');
  const body = { id_configuracion: cfg, dias, proveedor, refrescar: true };

  let t = Date.now();
  await llamar(controller.resumen, body);
  const ms1 = Date.now() - t;
  t = Date.now();
  const conResumen = await llamar(controller.resumen, body);
  const ms2 = Date.now() - t;

  process.env.CONSUMO_IA_DIARIO = '0';
  t = Date.now();
  const directo = await llamar(controller.resumen, body);
  const ms3 = Date.now() - t;

  const ordenar = (r) => {
    const d = JSON.parse(JSON.stringify(r.data));
    d.dias.sort((x, y) => (x.dia < y.dia ? 1 : -1));
    return d;
  };
  const dif = diferencias(ordenar(conResumen), ordenar(directo));
  const tt = conResumen.data.totales;
  console.log(`cfg ${cfg} · ${dias} días${proveedor ? ' · ' + proveedor : ''}`);
  console.log(`  con resumen (1.ª vez, llena lo que falte): ${ms1} ms`);
  console.log(`  con resumen (2.ª vez):                     ${ms2} ms`);
  console.log(`  leyendo todo de mensajes_clientes:         ${ms3} ms`);
  console.log(
    `  respuestas IA ${tt.msgs_ia} · sin IA ${tt.msgs_sin_ia} · recordatorios ${tt.msgs_remarketing} · clientes ${tt.clientes_atendidos} · costo $${tt.costo_usd.toFixed(4)} · días ${conResumen.data.dias.length}`,
  );
  if (dif.length) {
    console.log(`  DIFERENCIAS (${dif.length}):`);
    dif.slice(0, 30).forEach((x) => console.log('    ' + x));
  } else {
    console.log('  IGUALES');
  }
  await db.close();
  process.exit(dif.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
