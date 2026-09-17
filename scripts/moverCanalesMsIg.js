/**
 * Traspasa los canales Messenger e Instagram de una conexión a otra SIN
 * volver a hacer el proceso de vinculación con Meta: se cambia el
 * id_configuracion de todo lo que cuelga de esas dos redes.
 *
 * Caso de uso (2026-09): ADMIN 2590 (cfg 525) → Imporfactory Ventas (cfg 242).
 * Después de esto se suspende la conexión origen.
 *
 * FUSIÓN: si la misma página ya estuvo vinculada al destino (fue el caso:
 * la 242 la tuvo hasta mayo-2026), la misma persona (source + page_id +
 * external_id) existe en las dos conexiones y el índice único
 * uq_ccc_cfg_source_page_external no deja moverla. Para esos "pares" se
 * FUSIONA: los mensajes y el historial del contacto origen pasan al contacto
 * destino, el destino hereda el estado más reciente y el origen queda con
 * soft-delete (deleted_at) en la conexión vieja.
 *
 * Qué mueve (en UNA transacción):
 *   1. messenger_pages / instagram_pages          → enruta los webhooks
 *   2. messenger_oauth_sessions / instagram_oauth_sessions
 *   3. messenger_conversations / messenger_messages
 *      instagram_conversations / instagram_messages
 *      facebook_posts / facebook_comments         (tablas legacy, por si hay filas)
 *   4. clientes_chat_center con source IN ('ms','ig') (los que NO tienen par):
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
 *        - celular_recibe → en los pares, el contacto destino
 *   6. historial_encargados de los pares → contacto destino
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

// Pares (origen ↔ destino): misma persona en las dos conexiones.
const SQL_PARES = `
  SELECT a.id id_origen, b.id id_destino,
         (a.ultimo_mensaje_at IS NOT NULL AND (b.ultimo_mensaje_at IS NULL OR a.ultimo_mensaje_at > b.ultimo_mensaje_at)) origen_mas_reciente
    FROM clientes_chat_center a
    JOIN clientes_chat_center b
      ON b.id_configuracion = ? AND b.deleted_at IS NULL
     AND b.source = a.source AND b.page_id <=> a.page_id AND b.external_id <=> a.external_id
   WHERE a.id_configuracion = ? AND a.source IN ('ms','ig') AND a.deleted_at IS NULL`;

(async () => {
  const q = (sql, r = [], t) =>
    db.query(sql, { replacements: r, type: db.QueryTypes.SELECT, transaction: t });
  const upd = async (sql, r = [], t) => {
    const [, n] = await db.query(sql, { replacements: r, type: db.QueryTypes.UPDATE, transaction: t });
    return n;
  };

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
  const [cli] = await q(`SELECT COUNT(*) n FROM clientes_chat_center WHERE id_configuracion=? AND source IN ('ms','ig') AND deleted_at IS NULL`, [ORIGEN]);
  const [msg] = await q(`SELECT COUNT(*) n FROM mensajes_clientes m JOIN clientes_chat_center c ON c.id=m.celular_recibe WHERE m.id_configuracion=? AND c.id_configuracion=? AND c.source IN ('ms','ig')`, [ORIGEN, ORIGEN]);
  const pares = await q(SQL_PARES, [DESTINO, ORIGEN]);
  const [msgPares] = pares.length
    ? await q(`SELECT COUNT(*) n FROM mensajes_clientes WHERE celular_recibe IN (${pares.map(() => '?').join(',')})`, pares.map((p) => p.id_origen))
    : [{ n: 0 }];
  const estados = await q(`SELECT estado_contacto, COUNT(*) n FROM clientes_chat_center WHERE id_configuracion=? AND source IN ('ms','ig') AND deleted_at IS NULL GROUP BY estado_contacto`, [ORIGEN]);
  console.log(`  ${'clientes ms/ig'.padEnd(28)} ${cli.n}  (${pares.length} ya existen en destino → se FUSIONAN; ${cli.n - pares.length} se mueven)`);
  console.log(`  ${'mensajes de esos clientes'.padEnd(28)} ${msg.n}  (${msgPares.n} de los fusionados)`);
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
    // 0) Tabla temporal con los pares (vive en la conexión de la transacción)
    await db.query(`DROP TEMPORARY TABLE IF EXISTS tmp_pares_msig`, { transaction: t });
    await db.query(
      `CREATE TEMPORARY TABLE tmp_pares_msig (id_origen BIGINT PRIMARY KEY, id_destino BIGINT, origen_mas_reciente TINYINT) ENGINE=MEMORY`,
      { transaction: t },
    );
    await db.query(`INSERT INTO tmp_pares_msig ${SQL_PARES}`, {
      replacements: [DESTINO, ORIGEN], type: db.QueryTypes.INSERT, transaction: t,
    });
    const [{ n: nPares }] = await q(`SELECT COUNT(*) n FROM tmp_pares_msig`, [], t);
    console.log(`\nPares a fusionar: ${nPares}`);

    // 1) Mensajes de los PARES → contacto destino
    const mPares = await upd(
      `UPDATE mensajes_clientes m JOIN tmp_pares_msig p ON p.id_origen = m.celular_recibe
          SET m.id_configuracion = ?, m.id_cliente = ?, m.celular_recibe = p.id_destino
        WHERE m.id_configuracion = ?`,
      [DESTINO, owner.id, ORIGEN], t,
    );
    console.log(`mensajes fusionados: ${mPares}`);

    // 2) Historial de encargados de los pares → contacto destino
    const hPares = await upd(
      `UPDATE historial_encargados h JOIN tmp_pares_msig p ON p.id_origen = h.id_cliente_chat_center
          SET h.id_cliente_chat_center = p.id_destino`,
      [], t,
    );
    console.log(`historial_encargados fusionados: ${hPares}`);

    // 3) El destino hereda estado/encargado si el origen era más reciente,
    //    y siempre queda abierto si el origen estaba abierto.
    const setEncPar = ENCARGADO
      ? 'b.id_encargado = ?'
      : 'b.id_encargado = IF(p.origen_mas_reciente = 1 AND a.id_encargado IS NOT NULL, a.id_encargado, b.id_encargado)';
    const dPares = await upd(
      `UPDATE clientes_chat_center b
         JOIN tmp_pares_msig p ON p.id_destino = b.id
         JOIN clientes_chat_center a ON a.id = p.id_origen
          SET ${setEncPar},
              b.id_departamento = ?,
              b.chat_cerrado = IF(a.chat_cerrado = 0, 0, b.chat_cerrado),
              b.chat_cerrado_at = IF(a.chat_cerrado = 0, NULL, b.chat_cerrado_at),
              b.nombre_cliente = IF(COALESCE(b.nombre_cliente,'') = '', a.nombre_cliente, b.nombre_cliente),
              b.updated_at = NOW()`,
      [...(ENCARGADO ? [ENCARGADO] : []), depto.id_departamento], t,
    );
    console.log(`contactos destino actualizados: ${dPares}`);

    // 4) Recalcular "último mensaje" de los destinos fusionados a partir de
    //    los mensajes (ahora ya incluyen los del origen).
    const uPares = await upd(
      `UPDATE clientes_chat_center b
         JOIN (
           SELECT m.celular_recibe, m.id, m.created_at, m.texto_mensaje, m.tipo_mensaje, m.rol_mensaje, m.ruta_archivo
             FROM mensajes_clientes m
             JOIN (SELECT celular_recibe, MAX(id) mid FROM mensajes_clientes
                    WHERE celular_recibe IN (SELECT id_destino FROM tmp_pares_msig) GROUP BY celular_recibe) x
               ON x.mid = m.id
         ) u ON u.celular_recibe = b.id
          SET b.ultimo_mensaje_at = u.created_at, b.ultimo_msg_id = u.id,
              b.ultimo_texto = LEFT(u.texto_mensaje, 255), b.ultimo_tipo_mensaje = u.tipo_mensaje,
              b.ultimo_rol_mensaje = u.rol_mensaje, b.ultimo_ruta_archivo = u.ruta_archivo`,
      [], t,
    );
    console.log(`"último mensaje" recalculado en: ${uPares}`);

    // 5) Soft-delete de los contactos origen fusionados (quedan en la
    //    conexión vieja, sin mensajes; el trigger libera su dedupe_key).
    const sPares = await upd(
      `UPDATE clientes_chat_center a JOIN tmp_pares_msig p ON p.id_origen = a.id
          SET a.deleted_at = NOW(), a.updated_at = NOW()`,
      [], t,
    );
    console.log(`contactos origen fusionados (soft-delete): ${sPares}`);

    // 6) Mensajes del resto (contactos sin par) → destino
    const mResto = await upd(
      `UPDATE mensajes_clientes m
         JOIN clientes_chat_center c ON c.id = m.celular_recibe
          SET m.id_configuracion = ?, m.id_cliente = ?
        WHERE m.id_configuracion = ? AND c.id_configuracion = ? AND c.source IN ('ms','ig') AND c.deleted_at IS NULL`,
      [DESTINO, owner.id, ORIGEN, ORIGEN], t,
    );
    console.log(`mensajes movidos (sin par): ${mResto}`);

    // 7) Contactos sin par → destino
    const setEnc = ENCARGADO ? ', id_encargado = ?' : '';
    const cResto = await upd(
      `UPDATE clientes_chat_center
          SET id_configuracion = ?, id_departamento = ?${setEnc},
              estado_contacto = CASE WHEN estado_contacto IN (${columnasDestino.map(() => '?').join(',')}) THEN estado_contacto ELSE ? END,
              updated_at = NOW()
        WHERE id_configuracion = ? AND source IN ('ms','ig') AND deleted_at IS NULL`,
      [DESTINO, depto.id_departamento, ...(ENCARGADO ? [ENCARGADO] : []), ...columnasDestino, columnaDefault, ORIGEN], t,
    );
    console.log(`contactos movidos (sin par): ${cResto}`);

    // 8) Tablas simples
    for (const tabla of TABLAS_SIMPLES) {
      const n = await upd(`UPDATE ${tabla} SET id_configuracion = ? WHERE id_configuracion = ?`, [DESTINO, ORIGEN], t);
      console.log(`${tabla.padEnd(28)} movidos: ${n}`);
    }

    await db.query(`DROP TEMPORARY TABLE IF EXISTS tmp_pares_msig`, { transaction: t });
    await t.commit();

    // Verificación
    const [chk] = await q(`SELECT COUNT(*) n FROM clientes_chat_center WHERE id_configuracion=? AND source IN ('ms','ig') AND deleted_at IS NULL AND dedupe_key NOT LIKE CONCAT(?, ':%')`, [DESTINO, DESTINO]);
    const [rest] = await q(`SELECT COUNT(*) n FROM clientes_chat_center WHERE id_configuracion=? AND source IN ('ms','ig') AND deleted_at IS NULL`, [ORIGEN]);
    const [huerf] = await q(`SELECT COUNT(*) n FROM mensajes_clientes m JOIN clientes_chat_center c ON c.id=m.celular_recibe WHERE m.id_configuracion <> c.id_configuracion AND c.id_configuracion IN (?, ?)`, [ORIGEN, DESTINO]);
    console.log(`\nVerificación: dedupe sin recalcular=${chk.n} (0) · ms/ig activos que quedaron en origen=${rest.n} (0) · mensajes con conexión distinta a su contacto=${huerf.n} (0)`);
    console.log('LISTO. Ahora puedes suspender la conexión origen.');
    process.exit(0);
  } catch (e) {
    await t.rollback();
    console.error('ROLLBACK:', e.parent?.sqlMessage || e.message);
    process.exit(1);
  }
})().catch((e) => {
  console.error('ERROR:', e.parent?.sqlMessage || e.message);
  process.exit(1);
});
