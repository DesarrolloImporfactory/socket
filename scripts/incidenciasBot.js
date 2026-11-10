/**
 * Consulta de bot_incidencias_log: los turnos del bot donde el código
 * intervino o algo falló (services/bot_incidencias.service.js). Sirve para
 * diagnosticar un reclamo sin entrar al servidor a leer debug_log.txt.
 *
 *   node scripts/incidenciasBot.js resumen [días]            qué pasa y en qué cuentas
 *   node scripts/incidenciasBot.js cuenta <cfg> [días]       incidencias de una cuenta
 *   node scripts/incidenciasBot.js chat <id_cliente> [días]  turno a turno de un chat
 *   node scripts/incidenciasBot.js ver <id>                  una fila con su traza completa
 *   node scripts/incidenciasBot.js tipo <tipo> [días]        últimas de un tipo
 *   node scripts/incidenciasBot.js vigilar <cfg> [días] [nota]  guarda TODOS los turnos de la cuenta
 *   node scripts/incidenciasBot.js vigiladas                 cuentas en vigilancia
 *   node scripts/incidenciasBot.js soltar <cfg>              deja de vigilar
 *
 * Solo lectura, salvo vigilar/soltar (una fila en bot_incidencias_vigilar).
 * Las tablas se crean solas la primera vez (misma BD dev/prod).
 */
require('dotenv').config();
const { db } = require('../src/database/config');
const {
  ensureTablas,
  vigilar,
} = require('../src/services/bot_incidencias.service');

const sel = (sql, replacements = []) =>
  db.query(sql, { replacements, type: db.QueryTypes.SELECT });
const dias = (v, def = 3) => Math.min(Math.max(parseInt(v, 10) || def, 1), 30);
const una = (v, max = 110) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
// Hora de Ecuador (UTC-5), que es como se leen los chats.
const hora = (d) =>
  new Date(new Date(d).getTime() - 5 * 3600 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(5, 16);

function fila(r) {
  console.log(
    `#${r.id} ${hora(r.created_at)} cfg=${r.id_configuracion} cliente=${r.id_cliente} [${r.columna || '-'}] ${r.marcas}`,
  );
  if (r.mensaje_cliente) console.log(`   cliente : ${una(r.mensaje_cliente)}`);
  if (r.respuesta_modelo) console.log(`   modelo  : ${una(r.respuesta_modelo)}`);
  if (r.respuesta_enviada) console.log(`   enviado : ${una(r.respuesta_enviada)}`);
  if (r.error) console.log(`   error   : ${una(r.error, 200)}`);
}

async function main() {
  const [cmd, a, b, ...resto] = process.argv.slice(2);
  await ensureTablas();

  if (cmd === 'resumen') {
    const d = dias(a, 1);
    const porTipo = await sel(
      `SELECT tipo, COUNT(*) n, COUNT(DISTINCT id_configuracion) cuentas,
              COUNT(DISTINCT id_cliente) chats
         FROM bot_incidencias_log
        WHERE created_at > NOW() - INTERVAL ? DAY
        GROUP BY tipo ORDER BY n DESC`,
      [d],
    );
    console.log(`Incidencias de los últimos ${d} día(s), por tipo:`);
    console.table(porTipo);
    const porCuenta = await sel(
      `SELECT id_configuracion cfg, COUNT(*) n,
              COUNT(DISTINCT id_cliente) chats,
              SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT tipo ORDER BY tipo), ',', 5) tipos
         FROM bot_incidencias_log
        WHERE created_at > NOW() - INTERVAL ? DAY
        GROUP BY id_configuracion ORDER BY n DESC LIMIT 25`,
      [d],
    );
    console.log('Cuentas con más incidencias:');
    console.table(porCuenta);
  } else if (cmd === 'cuenta' || cmd === 'chat' || cmd === 'tipo') {
    if (!a) throw new Error(`falta el dato: ${cmd} <valor> [días]`);
    const campo = { cuenta: 'id_configuracion', chat: 'id_cliente', tipo: 'tipo' }[cmd];
    const filas = await sel(
      `SELECT id, id_configuracion, id_cliente, columna, tipo, marcas,
              mensaje_cliente, respuesta_modelo, respuesta_enviada, error,
              created_at
         FROM bot_incidencias_log
        WHERE ${campo} = ? AND created_at > NOW() - INTERVAL ? DAY
        ORDER BY id ${cmd === 'chat' ? 'ASC' : 'DESC'} LIMIT 80`,
      [a, dias(b, cmd === 'chat' ? 30 : 3)],
    );
    if (!filas.length) console.log('Sin incidencias registradas.');
    filas.forEach(fila);
  } else if (cmd === 'ver') {
    const [r] = await sel(`SELECT * FROM bot_incidencias_log WHERE id = ?`, [a]);
    if (!r) throw new Error(`no existe la fila ${a}`);
    console.log(
      `#${r.id} ${hora(r.created_at)} cfg=${r.id_configuracion} cliente=${r.id_cliente} canal=${r.canal} columna=${r.columna} ${r.duracion_ms} ms`,
    );
    console.log(`marcas: ${r.marcas}`);
    console.log(`\n--- CLIENTE ---\n${r.mensaje_cliente || ''}`);
    console.log(`\n--- LO QUE ESCRIBIÓ EL MODELO ---\n${r.respuesta_modelo || '(nada)'}`);
    console.log(`\n--- LO QUE SE ENVIÓ ---\n${r.respuesta_enviada || '(nada)'}`);
    if (r.error) console.log(`\n--- ERROR ---\n${r.error}`);
    console.log(`\n--- TRAZA DEL TURNO ---\n${r.traza || ''}`);
  } else if (cmd === 'vigilar') {
    if (!a) throw new Error('falta la cuenta: vigilar <cfg> [días] [nota]');
    const d = Math.min(dias(b, 3), 14);
    await vigilar(a, d, resto.join(' ') || null);
    console.log(
      `Cuenta ${a} en vigilancia por ${d} día(s): se guardan todos sus turnos (el servidor lo toma en ≤2 min).`,
    );
  } else if (cmd === 'vigiladas') {
    console.table(
      await sel(
        `SELECT id_configuracion cfg, hasta, nota FROM bot_incidencias_vigilar
          WHERE hasta > NOW() ORDER BY hasta`,
      ),
    );
  } else if (cmd === 'soltar') {
    await db.query(`DELETE FROM bot_incidencias_vigilar WHERE id_configuracion = ?`, {
      replacements: [a],
      type: db.QueryTypes.DELETE,
    });
    console.log(`Cuenta ${a} fuera de vigilancia.`);
  } else {
    console.log(
      'Uso: resumen [días] | cuenta <cfg> [días] | chat <id_cliente> [días] | ver <id> | tipo <tipo> [días] | vigilar <cfg> [días] [nota] | vigiladas | soltar <cfg>',
    );
  }
}

main()
  .catch((e) => {
    console.error('Error:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
