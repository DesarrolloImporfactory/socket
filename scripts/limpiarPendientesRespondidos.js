/**
 * Marca como vistos los mensajes entrantes de Messenger / Instagram que ya
 * fueron respondidos (hay un mensaje nuestro posterior) y seguían con
 * visto=0, inflando el contador de "pendientes" del sidebar en chats cuyo
 * último mensaje era nuestro.
 *
 * Desde hoy messenger_store.saveOutgoingMessageUnified lo hace solo al
 * responder; este script limpia lo acumulado antes del cambio.
 *
 * Uso:
 *   node scripts/limpiarPendientesRespondidos.js --config=242            (dry-run)
 *   node scripts/limpiarPendientesRespondidos.js --config=242 --apply
 *   node scripts/limpiarPendientesRespondidos.js --config=todas --apply   (todas las conexiones)
 */
require('dotenv').config();
const { db } = require('../src/database/config');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }),
);
const APPLY = args.apply === true;
const CFG = args.config === 'todas' ? null : Number(args.config);
if (args.config !== 'todas' && !CFG) {
  console.error('Uso: --config=<id|todas> [--apply]');
  process.exit(1);
}

// Entrantes (rol 0) no vistos, anteriores al último mensaje del chat cuando
// ese último mensaje es nuestro (rol 1).
const WHERE = `
  c.source IN ('ms','ig')
  AND c.deleted_at IS NULL
  AND c.ultimo_rol_mensaje = 1
  AND m.rol_mensaje = 0 AND m.visto = 0
  AND m.id < c.ultimo_msg_id
  ${CFG ? 'AND c.id_configuracion = ?' : ''}`;

(async () => {
  const rep = CFG ? [CFG] : [];
  const [res] = await db.query(
    `SELECT COUNT(*) mensajes, COUNT(DISTINCT c.id) chats
       FROM mensajes_clientes m JOIN clientes_chat_center c ON c.id = m.celular_recibe
      WHERE ${WHERE}`,
    { replacements: rep, type: db.QueryTypes.SELECT },
  );
  console.log(`A marcar como vistos: ${res.mensajes} mensajes en ${res.chats} chats${CFG ? ` (config ${CFG})` : ''}`);

  if (!APPLY) {
    console.log('DRY-RUN: no se cambió nada. Repite con --apply.');
    process.exit(0);
  }

  const [, n] = await db.query(
    `UPDATE mensajes_clientes m JOIN clientes_chat_center c ON c.id = m.celular_recibe
        SET m.visto = 1
      WHERE ${WHERE}`,
    { replacements: rep, type: db.QueryTypes.UPDATE },
  );
  console.log(`Listo: ${n} mensajes marcados como vistos.`);
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
