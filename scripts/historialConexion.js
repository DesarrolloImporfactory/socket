/* Historial del número de una conexión: quién lo cambió, desconectó o
   conectó, desde dónde y cómo quedó la fila (configuraciones_numero_log).
   Es para soporte; en el front no se muestra.

   node scripts/historialConexion.js --cfg 793
   node scripts/historialConexion.js --usuario 2616      todas las conexiones del dueño
   node scripts/historialConexion.js --cfg 793 --json    filas completas */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db } = require('../src/database/config');

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const cfgId = Number(arg('cfg')) || null;
const usuarioId = Number(arg('usuario')) || null;
const json = arg('json') === true;

(async () => {
  if (!cfgId && !usuarioId) {
    console.log('Uso: node scripts/historialConexion.js --cfg N | --usuario N [--json]');
    process.exit(1);
  }
  const filas = await db.query(
    `SELECT l.*, c.nombre_configuracion
       FROM configuraciones_numero_log l
       LEFT JOIN configuraciones c ON c.id = l.id_configuracion
      WHERE ${cfgId ? 'l.id_configuracion = ?' : 'l.id_usuario = ?'}
      ORDER BY l.created_at ASC, l.id ASC`,
    { replacements: [cfgId || usuarioId], type: db.QueryTypes.SELECT },
  );
  if (!filas.length) {
    console.log('Sin movimientos registrados.');
    process.exit(0);
  }
  if (json) {
    console.log(JSON.stringify(filas, null, 2));
    process.exit(0);
  }
  const f = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
  for (const r of filas) {
    const quien =
      r.actor_tipo === 'sistema'
        ? 'sistema'
        : `${r.actor_usuario || r.actor_email || 'usuario ' + r.actor_id_usuario}` +
          (r.actor_rol ? ` (${r.actor_rol})` : '') +
          (r.ip ? ` · IP ${r.ip}` : '');
    let que;
    if (r.accion === 'cambio_numero') que = `número ${r.telefono_anterior} → ${r.telefono_nuevo}`;
    else if (r.accion === 'cambio_nombre') que = `nombre «${r.nombre_anterior}» → «${r.nombre_nuevo}»`;
    else if (r.accion === 'desconectar') que = `desconectó ${r.telefono_anterior} (phone_id ${r.id_telefono_anterior || '-'}, WABA ${r.id_whatsapp_anterior || '-'})`;
    else if (r.accion === 'conectar') que = `conectó ${r.telefono_nuevo} (phone_id ${r.id_telefono_nuevo || '-'}, WABA ${r.id_whatsapp_nuevo || '-'}` +
      (r.id_whatsapp_anterior && r.id_whatsapp_anterior !== r.id_whatsapp_nuevo ? `, antes WABA ${r.id_whatsapp_anterior}` : '') + ')';
    else que = r.accion;
    console.log(
      `${f(r.created_at)} · cfg ${r.id_configuracion} ${r.nombre_configuracion || ''} · ${r.origen} · ${que} · ${r.wa_status_anterior || '-'} → ${r.wa_status_nuevo || '-'} · por ${quien}` +
        (r.detalle ? `\n    ${r.detalle}` : ''),
    );
  }
  process.exit(0);
})().catch((e) => {
  if (e?.original?.code === 'ER_NO_SUCH_TABLE') {
    console.log('Todavía no hay historial: la tabla se crea con el primer movimiento.');
    process.exit(0);
  }
  console.error(e?.message || e);
  process.exit(1);
});
