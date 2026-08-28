/**
 * Historial de suspensiones / reactivaciones de una conexión.
 *
 *   node scripts/verSuspensiones.js 320        → historial de la conexión 320
 *   node scripts/verSuspensiones.js            → últimos 30 cambios de toda la plataforma
 *
 * Sirve para responder "¿quién suspendió esta conexión?" sin entrar a la BD.
 * Ojo: solo registra lo que pasa por la API. Un UPDATE hecho a mano en la BD
 * (como las reactivaciones que hacemos nosotros) no aparece aquí salvo que se
 * habilite el trigger opcional de configuraciones_suspension_log_migration.sql.
 */
require('dotenv').config();
const { db } = require('../src/database/config');

const LIMITE = 30;

(async () => {
  const idConfig = Number(process.argv[2]) || null;

  const filas = await db.query(
    `SELECT l.*, c.nombre_configuracion, c.telefono,
            c.suspendido AS suspendido_actual
       FROM configuraciones_suspension_log l
       LEFT JOIN configuraciones c ON c.id = l.id_configuracion
      ${idConfig ? 'WHERE l.id_configuracion = ?' : ''}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${LIMITE}`,
    {
      replacements: idConfig ? [idConfig] : [],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!filas.length) {
    console.log(
      idConfig
        ? `Sin registros para la conexión ${idConfig}.`
        : 'Sin registros todavía.',
    );
    console.log(
      'Recuerda que el log arranca desde que se aplicó la migración: los cambios anteriores no están.',
    );
    process.exit(0);
  }

  if (idConfig) {
    const f = filas[0];
    console.log(
      `\nConexión ${idConfig} · ${f.nombre_configuracion || '?'} · ${
        f.telefono || '?'
      } · estado actual: ${
        Number(f.suspendido_actual) === 1 ? 'SUSPENDIDA' : 'activa'
      }\n`,
    );
  }

  for (const f of filas) {
    const quien =
      f.actor_tipo === 'sistema'
        ? `SISTEMA (${f.origen})`
        : `${f.actor_usuario || '?'} <${f.actor_email || '?'}> · rol ${
            f.actor_rol || '?'
          } · sub_usuario ${f.actor_id_sub_usuario}`;

    const ajeno =
      f.actor_id_usuario &&
      f.id_usuario &&
      Number(f.actor_id_usuario) !== Number(f.id_usuario)
        ? '  ⚠️ ACTOR DE OTRA CUENTA'
        : '';

    console.log(
      [
        `[${f.created_at}] ${f.accion.toUpperCase()}`,
        idConfig ? '' : `conexión ${f.id_configuracion}`,
        `cuenta ${f.id_usuario}`,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    console.log(`    quién:  ${quien}${ajeno}`);
    if (f.ip || f.user_agent) {
      console.log(
        `    desde:  ${f.ip || '-'} · ${(f.user_agent || '-').slice(0, 90)}`,
      );
    }
    if (f.detalle) console.log(`    extra:  ${f.detalle}`);
    console.log('');
  }

  process.exit(0);
})();
