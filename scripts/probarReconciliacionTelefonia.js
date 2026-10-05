/**
 * Pruebas de la reconciliación de telefonía (services/telefonia_reconciliar).
 *
 *   node scripts/probarReconciliacionTelefonia.js
 *
 * Usa la base real pero SOLO con una conexión ficticia (id 990000001) que
 * crea y borra al terminar; las estadísticas de Zadarma van inyectadas, no
 * se llama a su API. No toca llamadas, saldos ni chats de ninguna conexión
 * real. Sale con código 1 si alguna comprobación falla.
 */
process.env.CRONS_ENABLED = 'false';
require('dotenv').config();
const { db } = require('../src/database/config');
const TelefoniaLlamadas = require('../src/models/telefonia_llamadas.model');
const TelefoniaCuentas = require('../src/models/telefonia_cuentas.model');
const TelefoniaMovimientos = require('../src/models/telefonia_movimientos.model');
const zadarma = require('../src/services/zadarma.service');
const { reconciliar, emparejar } = require('../src/services/telefonia_reconciliar.service');

const CFG = 990000001;
const SUB = 990000001;
let fallas = 0;
const ok = (cond, nombre, extra = '') => {
  console.log(`${cond ? '  ✔' : '  ✘ FALLA'} ${nombre}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fallas += 1;
};
/** Hora de Ecuador "YYYY-MM-DD HH:MM:SS" de hace N segundos. */
const haceEc = (seg) => new Date(Date.now() - 5 * 3600_000 - seg * 1000).toISOString().slice(0, 19).replace('T', ' ');

async function limpiar() {
  await TelefoniaMovimientos.destroy({ where: { id_configuracion: CFG } });
  await TelefoniaLlamadas.destroy({ where: { id_configuracion: CFG } });
  await TelefoniaCuentas.destroy({ where: { id_configuracion: CFG } });
}
const crear = (extra) =>
  db
    .query(
      `INSERT INTO telefonia_llamadas (id_configuracion, id_sub_usuario, extension, telefono_cliente, estado, inicio_at, pbx_call_id, fin_at, disposition, duracion_seg, costo_centavos, grabada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      {
        replacements: [CFG, SUB, extra.extension || '901', extra.telefono, extra.estado || 'pedida', extra.inicio, extra.pbx || null, extra.fin || null, extra.disposition || null, extra.duracion ?? null, extra.costo ?? null],
        type: db.QueryTypes.INSERT,
      },
    )
    .then(([id]) => id);
const leer = (id) => TelefoniaLlamadas.findByPk(id);
const saldo = async () => Number((await TelefoniaCuentas.findByPk(CFG)).saldo_centavos);

(async () => {
  await db.authenticate();
  await limpiar();

  console.log('\n1. Emparejar llamadas con las estadísticas de Zadarma (función pura)');
  {
    const ll = [
      { id: 1, extension: '901', telefono_cliente: '593900000001', inicio_at: '2026-10-05 10:00:00' },
      { id: 2, extension: '901', telefono_cliente: '593900000001', inicio_at: '2026-10-05 10:01:00' },
      { id: 3, extension: '902', telefono_cliente: '593900000001', inicio_at: '2026-10-05 10:00:00' },
      { id: 4, extension: '901', telefono_cliente: '593900000009', inicio_at: '2026-10-05 10:00:00' },
    ];
    const st = [
      { sip: '901', destination: 593900000001, callstart: '2026-10-05 10:00:03', disposition: 'no answer', seconds: 0 },
      { sip: '901', destination: 593900000001, callstart: '2026-10-05 10:01:02', disposition: 'answered', seconds: 40 },
      { sip: '901', destination: 593900000009, callstart: '2026-10-05 10:20:00', disposition: 'answered', seconds: 5 },
    ];
    const p = emparejar(ll, st);
    ok(p.get(1)?.disposition === 'no answer', 'dos llamadas seguidas al mismo número: la primera toma el primer registro');
    ok(p.get(2)?.seconds === 40, 'la segunda toma el segundo registro (cada registro se usa una vez)');
    ok(!p.has(3), 'otra extensión no empareja');
    ok(!p.has(4), 'mismo número pero 20 min después no empareja (fuera de la ventana de 3 min)');
  }

  console.log('\n2. Reconciliar una conexión de prueba (base real, Zadarma simulado)');
  await TelefoniaCuentas.create({ id_configuracion: CFG, saldo_centavos: 1000, tarifa_centavos_min: 40, activo: 1 });
  const tA = haceEc(600); // hace 10 min: contestada 65 s, el aviso de fin se perdió
  const tB = haceEc(1800); // hace 30 min: nunca se marcó
  const tC = haceEc(60); // hace 1 min: recién pedida, no se toca
  const tD = haceEc(1500); // hace 25 min: ya cerrada y cobrada por el webhook
  const tH = haceEc(1560); // un minuto ANTES de D, mismo número: intento que nunca se marcó
  const tE = haceEc(400); // hace ~7 min: empezó (tiene pbx_call_id) y aún no hay rastro
  const A = await crear({ telefono: '593900000001', inicio: tA, pbx: 'out_prueba_A', estado: 'ringing' });
  const B = await crear({ telefono: '593900000002', inicio: tB });
  const C = await crear({ telefono: '593900000003', inicio: tC });
  const D = await crear({ telefono: '593900000004', inicio: tD, estado: 'answered', disposition: 'answered', fin: haceEc(1400), duracion: 30, costo: 20 });
  const H = await crear({ telefono: '593900000004', inicio: tH });
  const E = await crear({ telefono: '593900000005', inicio: tE, pbx: 'out_prueba_E', estado: 'ringing' });
  const stats = [
    { sip: '901', destination: 593900000001, callstart: haceEc(597), disposition: 'answered', seconds: 65, is_recorded: 'false', call_id: 'x.1' },
    { sip: '901', destination: 593900000004, callstart: haceEc(1497), disposition: 'answered', seconds: 30, is_recorded: 'false', call_id: 'x.4' },
  ];

  const seco = await reconciliar({ dryRun: true, statsPbx: stats, soloConfig: CFG });
  ok(seco.cerradas === 1 && seco.no_marco === 2 && seco.en_espera === 1, 'modo prueba: anuncia 1 cierre, 2 no marcadas, 1 en espera', JSON.stringify({ c: seco.cerradas, n: seco.no_marco, e: seco.en_espera }));
  ok((await leer(A)).fin_at == null && (await saldo()) === 1000, 'modo prueba no escribe nada');

  const r1 = await reconciliar({ statsPbx: stats, soloConfig: CFG, conGrabaciones: false });
  const a = await leer(A);
  ok(a.estado === 'answered' && Number(a.duracion_seg) === 65, 'A (aviso perdido) queda contestada con 65 s', `${a.estado} ${a.duracion_seg}s`);
  ok(Number(a.costo_centavos) === 44, 'A cuesta 44 ¢ (65 s a 40 ¢/min, redondeo hacia arriba)', `${a.costo_centavos} ¢`);
  ok((await saldo()) === 956, 'el saldo de la conexión baja de 1000 a 956', String(await saldo()));
  ok((await TelefoniaMovimientos.count({ where: { id_configuracion: CFG, id_llamada: A, tipo: 'consumo' } })) === 1, 'queda un movimiento de consumo para A');
  const b = await leer(B);
  ok(b.estado === 'failed' && b.disposition === 'no_marco' && Number(b.costo_centavos) === 0, 'B (sin rastro, 30 min) se cierra como no marcada, sin costo', `${b.estado}/${b.disposition}`);
  ok((await leer(C)).fin_at == null, 'C (1 min) no se toca: el aviso normal aún puede llegar');
  const d = await leer(D);
  ok(Number(d.costo_centavos) === 20 && (await TelefoniaMovimientos.count({ where: { id_llamada: D } })) === 0, 'D (ya cerrada por el webhook) no se vuelve a cobrar');
  const h = await leer(H);
  ok(h.disposition === 'no_marco' && Number(h.costo_centavos) === 0, 'H (intento sin marcar, 1 min antes de D al mismo número) NO se queda con la llamada de D: no se cobra doble', `${h.estado}/${h.disposition} ${h.costo_centavos} ¢`);
  ok((await leer(E)).fin_at == null, 'E (empezó hace 7 min, sin rastro) sigue abierta: puede estar en curso');
  ok(r1.cerradas === 1 && r1.cobrado_centavos === 44, 'el resumen dice 1 cerrada y 44 ¢ cobrados', JSON.stringify({ c: r1.cerradas, m: r1.cobrado_centavos }));

  console.log('\n3. Idempotencia: correrlo otra vez no cobra dos veces');
  const r2 = await reconciliar({ statsPbx: stats, soloConfig: CFG, conGrabaciones: false });
  ok(r2.cerradas === 0 && (await saldo()) === 956, 'segunda corrida: 0 cierres y el saldo sigue en 956', `cerradas ${r2.cerradas}, saldo ${await saldo()}`);
  ok((await TelefoniaMovimientos.count({ where: { id_configuracion: CFG, tipo: 'consumo' } })) === 1, 'sigue habiendo un solo movimiento de consumo');

  console.log('\n4. Carrera webhook + cron: uno solo cobra');
  {
    const F = await crear({ telefono: '593900000006', inicio: haceEc(300), pbx: 'out_prueba_F', estado: 'ringing' });
    const datos = { duracion: 30, disposition: 'answered', avisar: false };
    const [x, y] = await Promise.all([zadarma.cerrarLlamada(await leer(F), datos), zadarma.cerrarLlamada(await leer(F), datos)]);
    ok([x, y].filter(Boolean).length === 1, 'de dos cierres simultáneos, solo uno procede');
    ok((await saldo()) === 936, 'el saldo baja una sola vez (956 − 20 = 936)', String(await saldo()));
  }

  console.log('\n5. Cierre provisional que luego se corrige con el dato real');
  {
    const tarde = [...stats, { sip: '901', destination: 593900000002, callstart: haceEc(1795), disposition: 'answered', seconds: 120, is_recorded: 'false', call_id: 'x.2' }];
    const r3 = await reconciliar({ statsPbx: tarde, soloConfig: CFG, conGrabaciones: false });
    const b2 = await leer(B);
    ok(b2.estado === 'answered' && Number(b2.costo_centavos) === 80, 'B aparece después en Zadarma: pasa de "no marcada" a contestada y se cobra 80 ¢', `${b2.estado} ${b2.costo_centavos} ¢`);
    ok(r3.cerradas === 1 && (await saldo()) === 856, 'saldo 936 − 80 = 856', String(await saldo()));
    const r4 = await reconciliar({ statsPbx: tarde, soloConfig: CFG, conGrabaciones: false });
    ok(r4.cerradas === 0 && (await saldo()) === 856, 'y ya es definitivo: otra corrida no la toca');
  }

  console.log('\n6. Llamada que empezó y nunca tuvo cierre (2 h)');
  {
    const G = await crear({ telefono: '593900000007', inicio: haceEc(7500), pbx: 'out_prueba_G', estado: 'ringing' });
    await reconciliar({ statsPbx: stats, soloConfig: CFG, conGrabaciones: false });
    const g = await leer(G);
    ok(g.estado === 'failed' && g.disposition === 'sin_cierre' && Number(g.costo_centavos) === 0, 'se cierra como "sin cierre", sin costo', `${g.estado}/${g.disposition}`);
  }

  await limpiar();
  ok((await TelefoniaLlamadas.count({ where: { id_configuracion: CFG } })) === 0 && !(await TelefoniaCuentas.findByPk(CFG)), 'limpieza: no queda nada de la conexión de prueba');

  console.log(fallas ? `\n${fallas} comprobación(es) fallaron.` : '\nTodo en verde.');
  process.exit(fallas ? 1 : 0);
})().catch(async (e) => {
  console.error('ERROR', e);
  await limpiar().catch(() => {});
  process.exit(1);
});
