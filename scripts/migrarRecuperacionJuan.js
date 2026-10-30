/**
 * Salida de Ariel Caraguay (2988) — pedido 2026-10-30. Dos días después de
 * recibir la cartera de recuperación (ver migrarRecuperacionAriel.js), Ariel
 * también se fue. Todo lo suyo pasa a Juan Felipe Garzón (2474), que ya es
 * asesor de recuperación y ya está en el departamento de Expertos.
 *
 *  1) Departamentos: se saca a Ariel de TODOS sus departamentos. El round
 *     robin (utils/webhook_whatsapp/round_robin.js) elige candidatos con
 *     asignacion_auto=1 en sub_usuarios_departamento, así que con esto dejan
 *     de llegarle chats nuevos. Estaba en Ventas Imporfactory (depto 5, cfg
 *     242, con asignación automática) y en Expertos (depto 7, cfg 265).
 *  2) Recuperación: se quita de la lista de asesores (como se hizo con
 *     Alexandra) y TODOS sus casos abiertos pasan a Juan.
 *  3) Chats a su nombre:
 *     - Expertos (cfg 265): pasan a Juan, con fila en historial_encargados.
 *     - Ventas Imporfactory (cfg 242): Juan NO pertenece a ese departamento y
 *       no podría abrirlos, así que se liberan (id_encargado = NULL) para que
 *       el equipo de Ventas los vea y el round robin reparta al que vuelva a
 *       escribir. También con fila en historial_encargados.
 *
 *   node scripts/migrarRecuperacionJuan.js            → simula
 *   node scripts/migrarRecuperacionJuan.js --aplicar  → escribe
 */
require('dotenv').config();
process.env.CRONS_ENABLED = 'false';
const { db } = require('../src/database/config');

const APLICAR = process.argv.includes('--aplicar');
const ARIEL = 2988;
const JUAN = 2474;
const DEPTO_EXPERTOS = 7;
const CFG_EXPERTOS = 265;

const q = (sql, replacements = [], type = db.QueryTypes.SELECT) =>
  db.query(sql, { replacements, type });

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (agrega --aplicar para escribir) ===');

  const subs = await q(
    `SELECT id_sub_usuario, COALESCE(NULLIF(TRIM(nombre_encargado), ''), usuario, email) AS nombre
       FROM sub_usuarios_chat_center WHERE id_sub_usuario IN (?)`,
    [[ARIEL, JUAN]],
  );
  const nombre = new Map(subs.map((s) => [Number(s.id_sub_usuario), String(s.nombre).trim()]));
  if (!nombre.has(ARIEL) || !nombre.has(JUAN)) throw new Error('No existe alguno de los subusuarios');
  console.log(`De ${nombre.get(ARIEL)} (${ARIEL}) → a ${nombre.get(JUAN)} (${JUAN})`);

  // 1) Departamentos
  console.log('\n== 1) Departamentos de Ariel ==');
  const deps = await q(
    `SELECT sd.id, sd.id_departamento, d.nombre_departamento, d.id_configuracion, sd.asignacion_auto
       FROM sub_usuarios_departamento sd
       JOIN departamentos_chat_center d ON d.id_departamento = sd.id_departamento
      WHERE sd.id_sub_usuario = ?`,
    [ARIEL],
  );
  for (const d of deps) {
    console.log(`· Sale de «${String(d.nombre_departamento).trim()}» (depto ${d.id_departamento}, cfg ${d.id_configuracion}, auto=${d.asignacion_auto})`);
  }
  if (!deps.length) console.log('· Ya no está en ningún departamento');
  const juanEnExpertos = await q(
    `SELECT 1 FROM sub_usuarios_departamento WHERE id_departamento = ? AND id_sub_usuario = ?`,
    [DEPTO_EXPERTOS, JUAN],
  );
  if (!juanEnExpertos.length) throw new Error('Juan no está en el departamento de Expertos: revisar antes de mover chats');
  if (APLICAR && deps.length) {
    await q(`DELETE FROM sub_usuarios_departamento WHERE id_sub_usuario = ?`, [ARIEL], db.QueryTypes.BULKDELETE);
    console.log('  borradas sus filas de sub_usuarios_departamento');
  }

  // 2) Recuperación: lista de asesores + casos
  console.log('\n== 2) Recuperación ==');
  const [ase] = await q(`SELECT activo FROM recuperacion_asesores_chat_center WHERE id_sub_usuario = ?`, [ARIEL]);
  console.log(ase ? `· Se quita de la lista de asesores (estaba activo=${ase.activo})` : '· Ya no está en la lista de asesores');
  if (ase && APLICAR) {
    await q(`DELETE FROM recuperacion_asesores_chat_center WHERE id_sub_usuario = ?`, [ARIEL], db.QueryTypes.BULKDELETE);
  }
  const casos = await q(
    `SELECT cohorte, COUNT(*) AS n FROM recuperacion_casos_chat_center
      WHERE asignado_a_id = ? AND estado = 'abierto' GROUP BY cohorte ORDER BY n DESC`,
    [ARIEL],
  );
  const totalCasos = casos.reduce((t, c) => t + Number(c.n), 0);
  console.log(`· Casos abiertos que pasan a ${nombre.get(JUAN)}: ${totalCasos}`);
  console.table(casos);
  if (APLICAR && totalCasos) {
    const [, r] = await db.query(
      `UPDATE recuperacion_casos_chat_center
          SET asignado_a_id = ?, asignado_a_nombre = ?, asignado_en = NOW()
        WHERE asignado_a_id = ? AND estado = 'abierto'`,
      { replacements: [JUAN, nombre.get(JUAN), ARIEL], type: db.QueryTypes.UPDATE },
    );
    console.log(`  casos actualizados: ${r?.affectedRows ?? r}`);
  }
  const despues = await q(
    `SELECT asignado_a_nombre AS asesor, COUNT(*) AS abiertos FROM recuperacion_casos_chat_center
      WHERE estado = 'abierto' GROUP BY asignado_a_nombre ORDER BY abiertos DESC`,
  );
  console.log('· Casos abiertos por asesor (estado actual en BD):');
  console.table(despues);

  // 3) Chats
  console.log('\n== 3) Chats a nombre de Ariel ==');
  const chats = await q(
    `SELECT c.id, c.id_configuracion, c.nombre_cliente,
            EXISTS(SELECT 1 FROM mensajes_clientes m
                    WHERE m.celular_recibe = c.id AND m.id_configuracion = c.id_configuracion
                      AND m.rol_mensaje = 0 AND m.created_at > NOW() - INTERVAL 7 DAY) AS vivo7
       FROM clientes_chat_center c WHERE c.id_encargado = ?`,
    [ARIEL],
  );
  const porCfg = {};
  for (const c of chats) {
    const k = String(c.id_configuracion);
    porCfg[k] = porCfg[k] || { chats: 0, cliente_escribio_7d: 0 };
    porCfg[k].chats += 1;
    if (Number(c.vivo7)) porCfg[k].cliente_escribio_7d += 1;
  }
  console.table(porCfg);
  const aJuan = chats.filter((c) => Number(c.id_configuracion) === CFG_EXPERTOS);
  const aLiberar = chats.filter((c) => Number(c.id_configuracion) !== CFG_EXPERTOS);
  console.log(`· Expertos (cfg ${CFG_EXPERTOS}) → ${nombre.get(JUAN)}: ${aJuan.length} chats`);
  console.log(`· Otras cuentas (Juan no está en ese departamento) → se liberan para su equipo: ${aLiberar.length} chats`);

  // Departamento para el historial de los liberados: el de la cuenta donde
  // estaba Ariel (depto 5 para la 242); si no se conoce, NULL.
  const deptoDeCfg = new Map(deps.map((d) => [Number(d.id_configuracion), Number(d.id_departamento)]));

  if (APLICAR) {
    let n1 = 0;
    for (const c of aJuan) {
      await q(
        `UPDATE clientes_chat_center SET id_encargado = ? WHERE id = ? AND id_encargado = ?`,
        [JUAN, c.id, ARIEL],
        db.QueryTypes.UPDATE,
      );
      await q(
        `INSERT INTO historial_encargados (id_cliente_chat_center, id_departamento_asginado, id_encargado_anterior, id_encargado_nuevo, motivo)
         VALUES (?, ?, ?, ?, ?)`,
        [c.id, DEPTO_EXPERTOS, ARIEL, JUAN, 'Recuperación: salida de Ariel Caraguay, cartera a Juan Felipe Garzón'],
        db.QueryTypes.INSERT,
      );
      n1 += 1;
    }
    console.log(`  chats pasados a Juan: ${n1}`);
    let n2 = 0;
    for (const c of aLiberar) {
      await q(
        `UPDATE clientes_chat_center SET id_encargado = NULL WHERE id = ? AND id_encargado = ?`,
        [c.id, ARIEL],
        db.QueryTypes.UPDATE,
      );
      await q(
        `INSERT INTO historial_encargados (id_cliente_chat_center, id_departamento_asginado, id_encargado_anterior, id_encargado_nuevo, motivo)
         VALUES (?, ?, ?, NULL, ?)`,
        [c.id, deptoDeCfg.get(Number(c.id_configuracion)) ?? null, ARIEL, 'Salida de Ariel Caraguay: chat liberado para el equipo'],
        db.QueryTypes.INSERT,
      );
      n2 += 1;
    }
    console.log(`  chats liberados: ${n2}`);
  }

  // Comprobación final
  if (APLICAR) {
    const [chk] = await q(
      `SELECT
         (SELECT COUNT(*) FROM clientes_chat_center WHERE id_encargado = ?) AS chats,
         (SELECT COUNT(*) FROM recuperacion_casos_chat_center WHERE asignado_a_id = ? AND estado = 'abierto') AS casos,
         (SELECT COUNT(*) FROM sub_usuarios_departamento WHERE id_sub_usuario = ?) AS departamentos,
         (SELECT COUNT(*) FROM recuperacion_asesores_chat_center WHERE id_sub_usuario = ?) AS asesor`,
      [ARIEL, ARIEL, ARIEL, ARIEL],
    );
    console.log('\n== Comprobación: lo que queda a nombre de Ariel ==', chk);
  } else {
    console.log('\nNo se escribió nada. Corre con --aplicar para migrar.');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
