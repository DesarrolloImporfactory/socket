/* Prueba de los ajustes del bot por cuenta (src/utils/ajustesIA.js): horario y
   lista blanca. Solo las cuentas; no conecta a la base.

     node scripts/probar_ajustes_ia.js
*/
const path = require('path');

// `ajustesIA` importa la base solo para leer la fila; aquí no se usa.
const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {} } };

const {
  normalizar,
  dentroDeHorario,
  esNumeroPermitido,
  esNumeroExcluido,
} = require('../src/utils/ajustesIA');

let ok = 0;
let fallos = 0;
function prueba(nombre, pasa, detalle = '') {
  if (pasa) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    fallos++;
    console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// Hora de Ecuador (UTC-5) → Date. 2026-10-12 es lunes.
const ec = (fecha, hora) => new Date(`${fecha}T${hora}:00-05:00`);
const noche = normalizar({ horario: { desde: '16:00', hasta: '08:00' } });

console.log('1. Sin horario nada cambia');
prueba('cuenta sin ajustes: contesta a cualquier hora', dentroDeHorario(normalizar(null), ec('2026-10-12', '12:00')));
prueba('ajustes sin horario: contesta a cualquier hora', dentroDeHorario(normalizar({ espera_rafaga_seg: 20 }), ec('2026-10-12', '12:00')));
prueba('los ajustes que ya existían siguen igual', normalizar({ espera_rafaga_seg: 20, numeros_excluidos: ['0991234567'] }).espera_rafaga_ms === 20000
  && esNumeroExcluido(normalizar({ numeros_excluidos: ['0991234567'] }), '593991234567'));

console.log('\n2. Franja 16:00 → 08:00 (cruza la medianoche)');
for (const [hora, esperado] of [
  ['15:59', false], ['16:00', true], ['19:30', true], ['23:59', true], ['00:00', true],
  ['03:00', true], ['07:59', true], ['08:00', false], ['12:00', false],
]) {
  prueba(`lunes ${hora} → ${esperado ? 'contesta' : 'calla'}`, dentroDeHorario(noche, ec('2026-10-12', hora)) === esperado);
}
prueba('sábado 10:00 calla (la franja vale igual todos los días)', !dentroDeHorario(noche, ec('2026-10-17', '10:00')));
prueba('domingo 20:00 contesta', dentroDeHorario(noche, ec('2026-10-18', '20:00')));

console.log('\n3. Franja que no cruza la medianoche y días completos');
const tarde = normalizar({ horario: { desde: '13:00', hasta: '14:00' } });
prueba('13:00–14:00: 13:30 contesta, 14:00 calla, 12:59 calla',
  dentroDeHorario(tarde, ec('2026-10-12', '13:30')) && !dentroDeHorario(tarde, ec('2026-10-12', '14:00')) && !dentroDeHorario(tarde, ec('2026-10-12', '12:59')));
const conDomingo = normalizar({ horario: { desde: '16:00', hasta: '08:00', dias_completos: [0] } });
prueba('con domingo completo: domingo 11:00 contesta', dentroDeHorario(conDomingo, ec('2026-10-18', '11:00')));
prueba('con domingo completo: lunes 11:00 sigue callado', !dentroDeHorario(conDomingo, ec('2026-10-19', '11:00')));
prueba('con domingo completo: sábado 23:30 de Ecuador todavía es sábado (franja), domingo 00:10 ya es día completo',
  dentroDeHorario(conDomingo, ec('2026-10-17', '23:30')) && dentroDeHorario(conDomingo, ec('2026-10-18', '00:10')));
const soloDias = normalizar({ horario: { dias_completos: [6, 0] } });
prueba('solo días completos (sin franja): sábado sí, lunes no', dentroDeHorario(soloDias, ec('2026-10-17', '10:00')) && !dentroDeHorario(soloDias, ec('2026-10-12', '20:00')));
const mx = normalizar({ horario: { desde: '16:00', hasta: '08:00', utc: -6 } });
prueba('otra zona (utc -6): 16:30 de Ecuador son 15:30 allá → calla', !dentroDeHorario(mx, ec('2026-10-12', '16:30')));
prueba('la hora no depende de la zona del servidor', dentroDeHorario(noche, new Date('2026-10-12T21:00:00Z')) === true && dentroDeHorario(noche, new Date('2026-10-12T20:59:00Z')) === false);

console.log('\n4. Un horario mal escrito calla al bot (nunca lo suelta las 24 horas)');
for (const [nombre, h] of [
  ['hora ilegible', { desde: 'cuatro', hasta: '08:00' }],
  ['falta «hasta»', { desde: '16:00' }],
  ['desde igual a hasta', { desde: '08:00', hasta: '08:00' }],
  ['hora 25:00', { desde: '25:00', hasta: '08:00' }],
  ['no es un objeto', '16-8'],
  ['objeto vacío', {}],
]) {
  const a = normalizar({ horario: h });
  prueba(nombre, a.horario === null && a.horario_invalido === true && !dentroDeHorario(a, ec('2026-10-12', '20:00')) && !dentroDeHorario(a, ec('2026-10-12', '12:00')));
}
const roto = normalizar('{"horario": {"desde": "16:00", "hasta": "08:00"');
prueba('JSON roto que traía un horario: calla', roto.horario_invalido === true && !dentroDeHorario(roto, ec('2026-10-12', '20:00')));
prueba('JSON roto sin horario: sigue siendo «sin ajustes», como antes', dentroDeHorario(normalizar('{"espera_rafaga_seg": 20'), ec('2026-10-12', '12:00')));
prueba('formatos de hora aceptados: "8", "8:30", "24:00"',
  normalizar({ horario: { desde: '16', hasta: '8:30' } }).horario.hasta_min === 510 && normalizar({ horario: { desde: '18:00', hasta: '24:00' } }).horario.hasta_min === 0);
prueba('días fuera de 0–6 se descartan', JSON.stringify(normalizar({ horario: { desde: '16:00', hasta: '08:00', dias_completos: [0, 7, -1, 'x', 0] } }).horario.dias_completos) === '[0]');

console.log('\n5. Lista blanca de pruebas');
const lista = normalizar({ solo_numeros: ['0991234567', '+52 1 55 1234 5678', '12'] });
prueba('sin lista: pasa cualquiera', esNumeroPermitido(normalizar({}), '593987654321'));
prueba('en la lista, con o sin código de país', esNumeroPermitido(lista, '593991234567') && esNumeroPermitido(lista, '0991234567'));
prueba('fuera de la lista: no pasa', !esNumeroPermitido(lista, '593987654321'));
prueba('teléfono vacío con lista activa: no pasa', !esNumeroPermitido(lista, ''));
prueba('entradas basura de la lista se descartan', lista.solo_numeros.length === 2);

console.log(`\n${fallos === 0 ? 'TODO BIEN' : 'HAY FALLAS'}: ${ok} pasan, ${fallos} fallan`);
process.exit(fallos === 0 ? 0 : 1);
