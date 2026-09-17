/**
 * Traspasa los canales Messenger e Instagram de una conexión a otra SIN
 * volver a hacer el proceso de vinculación con Meta: se cambia el
 * id_configuracion de todo lo que cuelga de esas dos redes.
 *
 * Caso de uso (2026-09): ADMIN 2590 (cfg 525) → Imporfactory Ventas (cfg 242).
 * Después de esto se suspende la conexión origen.
 *
 * Qué mueve (en UNA transacción):
 *   1. messenger_pages / instagram_pages          → enruta los webhooks
 *   2. messenger_oauth_sessions / instagram_oauth_sessions
 *   3. messenger_conversations / messenger_messages
 *      instagram_conversations / instagram_messages
 *      facebook_posts / facebook_comments         (tablas legacy, por si hay filas)
 *   4. clientes_chat_center con source IN ('ms','ig'):
 *        - id_configuracion → destino
 *        - id_departamento  → departamento del destino
 *        - estado_contacto  → si la columna kanban no existe en el destino,
 *                             la primera columna del destino
 *        - id_encargado     → se conserva (mismo dueño de cuenta). Con
 *                             --encargado=<id_sub_usuario> se reasignan TODOS.
 *        - dedupe_key la recalcula el trigger trg_ccc_dedupe_bu.
 *   5. mensajes_clientes de esos contactos:
 *        - id_configuracion → destino
 *        - id_cliente (fila "propietario" del negocio) → propietario del destino
 *
 * Uso:
 *   node scripts/moverCanalesMsIg.js --origen=525 --destino=242            (dry-run)
 *   node scripts/moverCanalesMsIg.js --origen=525 --destino=242 --apply
 *   node scripts/moverCanalesMsIg.js --origen=525 --destino=242 --apply --encargado=2021
 */
require('dotenv').config();
const { db } = require('../src/database/config');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }),
);

const ORIGEN = Number(args.origen);
const DESTINO = Number(args.destino);
const APPLY = args.apply === true;
const ENCARGADO = args.encargado ? Number(args.encargado) : null;

if (!ORIGEN || !DESTINO || ORIGEN === DESTINO) {
  console.error('Uso: --origen=<cfg> --destino=<cfg> [--apply] [--encargado=<id_sub_usuario>]');
  process.exit(1);
}

const TABLAS_SIMPLES = [
  'messenger_pages',
  'instagram_pages',
  'messenger_oauth_sessions',
  'instagram_oauth_sessions',
  'messenger_conversations',
  'messenger_messages',
  'instagram_conversations',
  'instagram_messages',
  'facebook_posts',
  'facebook_comments',
];

(async () => {
  const q = (sql, r = [], t) =>
    db.query(sql, { replacements: r, type: db.QueryTypes.SELECT, transaction: t });
  const u = (sql, r = [], t) =>
    db.query(sql, { replacements: r, type: db.QueryTypes.UPDATE, transaction: t });

  // ── Validaciones ──────────────────────────────────────────────────────
  const cfgs = await q(`SELECT id, nombre_configuracion, id_usuario, suspendido FROM configuraciones WHERE id IN (?, ?)`, [ORIGEN, DESTINO]);
  const cO = cfgs.find((c) => c.id === ORIGEN);
  const cD = cfgs.find((c) => c.id === DESTINO);
  if (!cO || !cD) throw new Error('Origen o destino no existen');
  if (cO.id_usuario !== cD.id_usuario)
    throw new Error(`Las conexiones son de dueños distintos (${cO.id_usuario} vs ${cD.id_usuario}); abortado`);
  console.log(`Origen : ${ORIGEN} "${cO.nombre_configuracion}"`);
  console.log(`Destino: ${DESTINO} "${cD.nombre_configuracion}"`);

  const yaTiene = await q(
    `SELECT 'ms' t, page_id FROM messenger_pages WHERE id_configuracion=? UNION ALL SELECT 'ig', page_id FROM instagram_pages WHERE id_configuracion=?`,
    [DESTINO, DESTINO],
  );
  if (yaTiene.length) throw new Error(`El destino ya tiene páginas vinculadas: ${JSON.stringify(yaTiene)}; abortado`);

  const [depto] = await q(`SELECT id_departamento, nombre_departamento FROM departamentos_chat_center WHERE id_configuracion=? ORDER BY id_departamento ASC LIMIT 1`, [DESTINO]);
  if (!depto) throw new Error('El destino no tiene departamento; créalo primero');

  const [owner] = await q(`SELECT MIN(id) id FROM clientes_chat_center WHERE id_configuracion=? AND propietario=1 AND deleted_at IS NULL`, [DESTINO]);
  if (!owner?.id) throw new Error('El destino no tiene fila propietario (propietario=1)');

  const columnasDestino = (await q(`SELECT estado_db FROM kanban_columnas WHERE id_configuracion=? ORDER BY id`, [DESTINO])).map((c) => c.estado_db);
  if (!columnasDestino.length) throw new Error('El destino no tiene columnas kanban');
  const columnaDefault = columnasDestino[0];

  if (ENCARGADO) {
    const [enc] = await q(`SELECT id_sub_usuario, usuario FROM sub_usuarios_chat_center WHERE id_sub_usuario=? AND id_usuario=?`, [ENCARGADO, cD.id_usuario]);
    if (!enc) throw new Error(`--encargado=${ENCARGADO} no es un sub-usuario de esta cuenta`);
    console.log(`Encargado para TODOS los contactos: ${enc.usuario} (${ENCARGADO})`);
  }

  // ── Inventario ────────────────────────────────────────────────────────
  console.log('\nInventario en origen:');
  for (const t of TABLAS_SIMPLES) {
    const [c] = await q(`SELECT COUNT(*) n FROM ${t} WHERE id_configuracion=?`, [ORIGEN]);
    console.log(`  ${t.padEnd(28)} ${c.n}`);
  }
  const [cli] = await q(`SELECT COUNT(*) n FROM clientes_chat_center WHERE id_configuracion=? AND source IN ('ms','ig')`, [ORIGEN]);
  const [msg] = await q(`SELECT COUNT(*) n FROM mensajes_clientes m JOIN clientes_chat_center c ON c.id=m.celular_recibe WHERE m.id_configuracion=? AND c.id_configuracion=? AND c.source IN ('ms','ig')`, [ORIGEN, ORIGEN]);
  const estados = await q(`SELECT estado_contacto, COUNT(*) n FROM clientes_chat_center WHERE id_configuracion=? AND source IN ('ms','ig') GROUP BY estado_contacto`, [ORIGEN]);
  console.log(`  ${'clientes ms/ig'.padEnd(28)} ${cli.n}`);
  console.log(`  ${'mensajes de esos clientes'.padEnd(28)} ${msg.n}`);
  console.log(`  Departamento destino: ${depto.id_departamento} "${depto.nombre_departamento}" · propietario destino: ${owner.id}`);
  console.log('  Columnas kanban:');
  for (const e of estados) {
    const ok = columnasDestino.includes(e.estado_contacto);
    console.log(`    ${String(e.estado_contacto).padEnd(22)} ${String(e.n).padStart(5)}  ${ok ? 'existe en destino' : `→ ${columnaDefault}`}`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN: no se cambió nada. Repite con --apply para ejecutar.');
    process.exit(0);
  }

  // ── Ejecución ─────────────────────────────────────────────────────────
  const t = await db.transaction();
  try {
    // 5) Mensajes primero (necesitan el JOIN con el cliente todavía en origen)
    const [, msgRows] = await db.query(
      `UPDATE mensajes_clientes m
         JOIN clientes_chat_center c ON c.id = m.celular_recibe
          SET m.id_configuracion = ?, m.id_cliente = ?
        WHERE m.id_configuracion = ? AND c.id_configuracion = ? AND c.source IN ('ms','ig')`,
      { replacements: [DESTINO, owner.id, ORIGEN, ORIGEN], type: db.QueryTypes.UPDATE, transaction: t },
    );
    console.log(`\nmensajes_clientes movidos: ${msgRows}`);

    // 4) Contactos
    const setEnc = ENCARGADO ? ', id_encargado = ?' : '';
    const [, cliRows] = await db.query(
      `UPDATE clientes_chat_center
          SET id_configuracion = ?, id_departamento = ?${setEnc},
              estado_contacto = CASE WHEN estado_contacto IN (${columnasDestino.map(() => '?').join(',')}) THEN estado_contacto ELSE ? END,
              updated_at = NOW()
        WHERE id_configuracion = ? AND source IN ('ms','ig')`,
      {
        replacements: [DESTINO, depto.id_departamento, ...(ENCARGADO ? [ENCARGADO] : []), ...columnasDestino, columnaDefault, ORIGEN],
        type: db.QueryTypes.UPDATE,
        transaction: t,
      },
    );
    console.log(`clientes_chat_center movidos: ${cliRows}`);

    // 1-3) Tablas simples
    for (const tabla of TABLAS_SIMPLES) {
      const [, n] = await db.query(`UPDATE ${tabla} SET id_configuracion = ? WHERE id_configuracion = ?`, {
        replacements: [DESTINO, ORIGEN], type: db.QueryTypes.UPDATE, transaction: t,
      });
      console.log(`${tabla.padEnd(28)} movidos: ${n}`);
    }

    await t.commit();

    // Verificación
    const [chk] = await q(`SELECT COUNT(*) n FROM clientes_chat_center WHERE id_configuracion=? AND source IN ('ms','ig') AND dedupe_key NOT LIKE CONCAT(?, ':%')`, [DESTINO, DESTINO]);
    console.log(`\nVerificación dedupe_key sin recalcular: ${chk.n} (debe ser 0)`);
    console.log('LISTO. Ahora puedes suspender la conexión origen.');
    process.exit(0);
  } catch (e) {
    await t.rollback();
    console.error('ROLLBACK:', e.message);
    process.exit(1);
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
