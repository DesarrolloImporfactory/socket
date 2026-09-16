/**
 * Unifica las dos cuentas de un alumno de Imporsuit cuando se creó una cuenta
 * a mano (con config y tarjeta) en vez de entrar por el botón de cursos, que
 * le da 3 meses del plan 21 a otra cuenta con su correo de alumno:
 *
 *   - cuenta CURSOS  (email de Imporsuit): cortesía sin usar, sin configuraciones.
 *                                          Se BORRA junto con sus sub_usuarios.
 *   - cuenta CONFIG  (email manual):       tiene todo. Recibe el correo y la
 *                                          tienda de cursos, y su admin pasa a
 *                                          loguearse con ese correo.
 *
 * Con esto el newLogin tipo cursos_imporsuit encuentra la cuenta CONFIG por
 * id_plataforma y NO aplica la cortesía porque ya tiene stripe_subscription_id.
 * Los 3 meses gratis se dan extendiendo el trial en Stripe (manual, dashboard).
 * Ojo: si el trial ya venció y la factura se cobró, va reembolso + cupón.
 *
 * Uso:
 *   node scripts/unificarCuentaAlumno.js --cursos a@x.com --config b@y.com
 *   node scripts/unificarCuentaAlumno.js --cursos a@x.com --config b@y.com --aplicar
 */
require('dotenv').config();
const { db } = require('../src/database/config');

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const EMAIL_CURSOS = arg('cursos');
const EMAIL_CONFIG = arg('config');
const APLICAR = process.argv.includes('--aplicar');

if (!EMAIL_CURSOS || !EMAIL_CONFIG) {
  console.error('Uso: --cursos <email alumno> --config <email cuenta configurada> [--aplicar]');
  process.exit(1);
}

const q = (sql, replacements, type, transaction) =>
  db.query(sql, { replacements, type, transaction });

const mostrar = async (titulo, ids) => {
  console.log(`\n=== ${titulo} ===`);
  console.table(
    await q(
      `SELECT id_usuario, email_propietario, id_plataforma, id_plan, estado,
              fecha_renovacion, trial_end, stripe_subscription_id, stripe_subscription_status
         FROM usuarios_chat_center WHERE id_usuario IN (:ids)`,
      { ids }, db.QueryTypes.SELECT,
    ),
  );
  console.table(
    await q(
      `SELECT id_sub_usuario, id_usuario, usuario, email, rol
         FROM sub_usuarios_chat_center WHERE id_usuario IN (:ids)`,
      { ids }, db.QueryTypes.SELECT,
    ),
  );
};

/** Filas en cualquier tabla que apunten a la cuenta cursos o a sus subs. */
const referencias = async (idUsuario, idsSub) => {
  const cols = await q(
    `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('id_usuario', 'id_sub_usuario')`,
    {}, db.QueryTypes.SELECT,
  );
  const out = [];
  for (const { t, c } of cols) {
    if (t === 'usuarios_chat_center') continue;
    if (t === 'sub_usuarios_chat_center') continue;
    if (t === 'password_reset_codes') continue; // se limpia con los subs
    const vals = c === 'id_usuario' ? [idUsuario] : idsSub;
    if (!vals.length) continue;
    try {
      const [{ n }] = await q(
        `SELECT COUNT(*) n FROM \`${t}\` WHERE \`${c}\` IN (:vals)`,
        { vals }, db.QueryTypes.SELECT,
      );
      if (Number(n) > 0) out.push({ tabla: t, columna: c, filas: Number(n) });
    } catch (e) {
      out.push({ tabla: t, columna: c, error: e.message.slice(0, 80) });
    }
  }
  return out;
};

(async () => {
  const [cursos] = await q(
    `SELECT id_usuario, id_plataforma, stripe_subscription_id FROM usuarios_chat_center
      WHERE email_propietario = :e`, { e: EMAIL_CURSOS }, db.QueryTypes.SELECT,
  );
  const [config] = await q(
    `SELECT id_usuario, id_plataforma, stripe_subscription_id FROM usuarios_chat_center
      WHERE email_propietario = :e`, { e: EMAIL_CONFIG }, db.QueryTypes.SELECT,
  );
  if (!cursos) throw new Error(`No existe cuenta con ${EMAIL_CURSOS}`);
  if (!config) throw new Error(`No existe cuenta con ${EMAIL_CONFIG}`);
  if (cursos.stripe_subscription_id) throw new Error(`La cuenta cursos ${cursos.id_usuario} tiene Stripe sub`);
  if (!config.stripe_subscription_id) throw new Error(`La cuenta config ${config.id_usuario} NO tiene Stripe sub`);
  if (!cursos.id_plataforma) throw new Error(`La cuenta cursos ${cursos.id_usuario} no tiene id_plataforma`);

  const subsCursos = await q(
    `SELECT id_sub_usuario FROM sub_usuarios_chat_center WHERE id_usuario = :id`,
    { id: cursos.id_usuario }, db.QueryTypes.SELECT,
  );
  const idsSubCursos = subsCursos.map((s) => s.id_sub_usuario);
  const [admin] = await q(
    `SELECT id_sub_usuario FROM sub_usuarios_chat_center
      WHERE id_usuario = :id AND rol = 'administrador' ORDER BY id_sub_usuario LIMIT 1`,
    { id: config.id_usuario }, db.QueryTypes.SELECT,
  );
  if (!admin) throw new Error(`La cuenta config ${config.id_usuario} no tiene admin`);

  await mostrar('ANTES', [cursos.id_usuario, config.id_usuario]);

  const refs = await referencias(cursos.id_usuario, idsSubCursos);
  console.log(`\nReferencias a la cuenta cursos ${cursos.id_usuario} / subs [${idsSubCursos}]:`);
  console.table(refs);
  if (refs.length) throw new Error('La cuenta cursos tiene datos colgados; revisar antes de borrar');

  console.log(`\nPlan: borrar ${cursos.id_usuario} (+ subs ${idsSubCursos}), ` +
    `${config.id_usuario} toma ${EMAIL_CURSOS} y tienda ${cursos.id_plataforma}, ` +
    `admin ${admin.id_sub_usuario} se loguea con ${EMAIL_CURSOS}.`);

  if (!APLICAR) {
    console.log('\nSin --aplicar no se toca nada.');
    process.exit(0);
  }

  await db.transaction(async (t) => {
    // Sequelize crudo: DELETE con BULKDELETE y UPDATE con UPDATE devuelven affectedRows.
    if (idsSubCursos.length) {
      await q(
        `DELETE FROM password_reset_codes WHERE id_sub_usuario IN (:ids)`,
        { ids: idsSubCursos }, db.QueryTypes.BULKDELETE, t,
      );
    }
    const nSubs = await q(
      `DELETE FROM sub_usuarios_chat_center WHERE id_usuario = :id`,
      { id: cursos.id_usuario }, db.QueryTypes.BULKDELETE, t,
    );
    if (nSubs !== idsSubCursos.length) throw new Error('subs de cursos: filas inesperadas');

    const nCursos = await q(
      `DELETE FROM usuarios_chat_center
        WHERE id_usuario = :id AND email_propietario = :e
          AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')`,
      { id: cursos.id_usuario, e: EMAIL_CURSOS }, db.QueryTypes.BULKDELETE, t,
    );
    if (nCursos !== 1) throw new Error('cuenta cursos: filas inesperadas');

    const [, nConfig] = await q(
      `UPDATE usuarios_chat_center SET email_propietario = :e, id_plataforma = :tienda
        WHERE id_usuario = :id AND stripe_subscription_id IS NOT NULL`,
      { e: EMAIL_CURSOS, tienda: cursos.id_plataforma, id: config.id_usuario }, db.QueryTypes.UPDATE, t,
    );
    if (nConfig !== 1) throw new Error('cuenta config: filas inesperadas');

    const [, nAdmin] = await q(
      `UPDATE sub_usuarios_chat_center SET usuario = :e, email = :e
        WHERE id_sub_usuario = :sub AND id_usuario = :id`,
      { e: EMAIL_CURSOS, sub: admin.id_sub_usuario, id: config.id_usuario }, db.QueryTypes.UPDATE, t,
    );
    if (nAdmin !== 1) throw new Error('admin config: filas inesperadas');
  });

  await mostrar('DESPUÉS', [cursos.id_usuario, config.id_usuario]);
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
