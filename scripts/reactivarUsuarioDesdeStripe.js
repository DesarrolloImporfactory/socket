/**
 * Reactiva en BD a un usuario cuya suscripción VIVA en Stripe (active /
 * trialing) no llegó a la fila de usuarios_chat_center.
 *
 *   node scripts/reactivarUsuarioDesdeStripe.js <id_usuario>            → dry-run
 *   node scripts/reactivarUsuarioDesdeStripe.js <id_usuario> --aplicar  → escribe
 *
 * Caso típico (2256, 2026-10-08): la sub anterior se canceló por cobro
 * rebotado (estado='suspendido'), se le creó una sub nueva con trial desde el
 * dashboard de Stripe (sin metadata) y el webhook no pudo resolver al usuario
 * porque la BD aún apuntaba a la sub vieja. El login sincronizó id/status pero
 * no estado ni trial_end, y checkPlanActivo seguía devolviendo ACCOUNT_BLOCKED.
 *
 * Qué hace:
 *  - Elige la sub viva más reciente del customer (active > trialing). Si no
 *    hay ninguna, no toca nada.
 *  - Escribe stripe_subscription_id/status, trial_end, fecha_renovacion
 *    (fin del trial si está en trial, si no fin del periodo), limpia las
 *    banderas de cancelación y pone estado='activo'.
 *  - Graba metadata.id_usuario / id_plan en la sub de Stripe para que los
 *    eventos siguientes (renovación, baja) se resuelvan sin depender de la BD.
 *
 * Usa STRIPE_SECRET_KEY (live) a propósito: la BD del .env es la de
 * producción y con NODE_ENV=development los controladores eligen la llave de
 * test, que no conoce a estos customers.
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');

const idUsuario = Number(process.argv[2]);
const APLICAR = process.argv.includes('--aplicar');

if (!idUsuario) {
  console.error(
    'Uso: node scripts/reactivarUsuarioDesdeStripe.js <id_usuario> [--aplicar]',
  );
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY no es una llave live; abortando.');
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const fechaDe = (ts) => (ts ? new Date(ts * 1000) : null);
const periodEndDeSub = (sub) =>
  sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;

(async () => {
  const [[user]] = await db.query(
    `SELECT id_usuario, nombre, estado, permanente, id_plan, id_costumer,
            stripe_subscription_id, stripe_subscription_status,
            trial_end, fecha_renovacion
       FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
    { replacements: [idUsuario] },
  );
  if (!user) throw new Error(`Usuario ${idUsuario} no existe`);
  console.log('BD antes:', user);

  if (!user.id_costumer) throw new Error('El usuario no tiene id_costumer');

  const list = await stripe.subscriptions.list({
    customer: user.id_costumer,
    status: 'all',
    limit: 20,
  });
  const subs = list.data || [];
  console.log(
    'Subs en Stripe:',
    subs.map((s) => ({
      id: s.id,
      status: s.status,
      trial_end: fechaDe(s.trial_end),
      period_end: fechaDe(periodEndDeSub(s)),
      metadata: s.metadata,
    })),
  );

  let viva = null;
  for (const st of ['active', 'trialing']) {
    viva = subs
      .filter((s) => s.status === st)
      .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    if (viva) break;
  }
  if (!viva) {
    console.log(
      'No hay sub active/trialing para este customer. Nada que hacer.',
    );
    process.exit(0);
  }

  const trialEnd = fechaDe(viva.trial_end);
  const fechaRenovacion =
    viva.status === 'trialing' && trialEnd
      ? trialEnd
      : fechaDe(periodEndDeSub(viva));

  const cambios = {
    stripe_subscription_id: viva.id,
    stripe_subscription_status: viva.status,
    trial_end: trialEnd,
    fecha_renovacion: fechaRenovacion,
    estado: 'activo',
  };
  console.log(`\nSub elegida: ${viva.id} (${viva.status})`);
  console.log('Cambios a escribir:', cambios);

  if (!APLICAR) {
    console.log('\nDry-run: nada se escribió. Repetir con --aplicar.');
    process.exit(0);
  }

  const [, afectadas] = await db.query(
    `UPDATE usuarios_chat_center
        SET stripe_subscription_id = ?,
            stripe_subscription_status = ?,
            trial_end = ?,
            fecha_renovacion = COALESCE(?, fecha_renovacion),
            cancel_at_period_end = ?,
            cancel_at = ?,
            canceled_at = ?,
            estado = 'activo'
      WHERE id_usuario = ? LIMIT 1`,
    {
      replacements: [
        viva.id,
        viva.status,
        trialEnd,
        fechaRenovacion,
        viva.cancel_at_period_end ? 1 : 0,
        fechaDe(viva.cancel_at),
        fechaDe(viva.canceled_at),
        idUsuario,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
  console.log('Filas afectadas:', afectadas);

  const meta = viva.metadata || {};
  if (!meta.id_usuario || !meta.id_plan) {
    await stripe.subscriptions.update(viva.id, {
      metadata: {
        ...meta,
        id_usuario: String(idUsuario),
        id_plan: String(meta.id_plan || user.id_plan || ''),
      },
    });
    console.log('Metadata grabada en la sub de Stripe.');
  }

  const [[despues]] = await db.query(
    `SELECT estado, stripe_subscription_id, stripe_subscription_status,
            trial_end, fecha_renovacion
       FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
    { replacements: [idUsuario] },
  );
  console.log('BD después:', despues);
  process.exit(0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
