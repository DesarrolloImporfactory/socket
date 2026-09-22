/**
 * Reconcilia usuarios_chat_center contra Stripe LIVE.
 *
 *   node scripts/reconciliarSuscripcionesStripe.js            → solo informa (dry-run)
 *   node scripts/reconciliarSuscripcionesStripe.js --aplicar  → escribe en BD
 *
 * Qué corrige:
 *  - Usuarios con stripe_subscription_status vivo (active/trialing/past_due)
 *    cuya sub en Stripe ya terminó (canceled / incomplete_expired / no existe):
 *    aplica la misma decisión que el webhook en customer.subscription.deleted
 *    (services/stripe_baja.service.js): apunta a otra sub viva del customer
 *    si la hay, o marca canceled + estado 'cancelado'.
 *  - Usuarios cuyo status en BD no coincide con el de Stripe pero la sub sigue
 *    viva (p. ej. BD active y Stripe past_due): sincroniza el status y las
 *    banderas de cancelación. No toca `estado`.
 * Qué solo informa:
 *  - Subs active en Stripe cuyo id no está en la BD (add-ons, subs dobles,
 *    usuarios borrados): requieren revisión a mano.
 *
 * Usa STRIPE_SECRET_KEY (live) a propósito: la BD del .env ya es la de
 * producción (dev y prod comparten base) y con NODE_ENV=development los
 * demás scripts eligen la llave de test, que no tiene nada que ver con
 * estos usuarios.
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');
const {
  resolverBajaSuscripcion,
  ESTADOS_VIVOS,
} = require('../src/services/stripe_baja.service');

const APLICAR = process.argv.includes('--aplicar');
const ESTADOS_TERMINADOS = ['canceled', 'incomplete_expired'];

if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY no es una llave live; abortando.');
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const fechaDe = (ts) => (ts ? new Date(ts * 1000) : null);

(async () => {
  console.log(
    `Reconciliación Stripe ↔ BD (${APLICAR ? 'APLICANDO' : 'dry-run, sin escribir'})\n`,
  );

  const stripeSubs = new Map();
  for await (const s of stripe.subscriptions.list({
    status: 'all',
    limit: 100,
  })) {
    stripeSubs.set(s.id, s);
  }
  console.log(`Subs en Stripe (todos los estados): ${stripeSubs.size}`);

  const vivosBD = await db.query(
    `SELECT u.id_usuario, u.email_propietario AS email, u.estado, u.permanente,
            u.stripe_subscription_id AS sub_id,
            u.stripe_subscription_status AS st_bd
       FROM usuarios_chat_center u
      WHERE u.stripe_subscription_id IS NOT NULL
        AND u.stripe_subscription_status IN (:vivos)`,
    { replacements: { vivos: ESTADOS_VIVOS }, type: db.QueryTypes.SELECT },
  );
  console.log(`Usuarios con sub viva en BD: ${vivosBD.length}\n`);

  const resumen = {
    ok: 0,
    cancelada: 0,
    reemplazada: 0,
    status_sync: 0,
    ignorada: 0,
    no_existe: 0,
  };

  for (const u of vivosBD) {
    let s = stripeSubs.get(u.sub_id);
    if (!s) {
      try {
        s = await stripe.subscriptions.retrieve(u.sub_id);
      } catch (e) {
        console.log(
          `  ✗ ${u.id_usuario} ${u.email} ${u.sub_id}: no existe en Stripe live (${e.code || e.message}). Revisar a mano.`,
        );
        resumen.no_existe++;
        continue;
      }
    }

    if (s.status === u.st_bd) {
      resumen.ok++;
      continue;
    }

    if (ESTADOS_TERMINADOS.includes(s.status)) {
      const r = await resolverBajaSuscripcion({
        stripe,
        sub: s,
        id_usuario: u.id_usuario,
        idPago: `reconcile_${s.id}_${Date.now()}`,
        aplicar: APLICAR,
      });
      console.log(
        `  → ${u.id_usuario} ${u.email} ${s.id} Stripe=${s.status} ended=${
          fechaDe(s.ended_at)?.toISOString().slice(0, 10) || '-'
        } | BD st=${u.st_bd} estado=${u.estado} ⇒ ${r.accion} ${JSON.stringify(
          r.detalle || {},
        )}`,
      );
      if (r.accion === 'cancelada') resumen.cancelada++;
      else if (r.accion === 'reemplazada') resumen.reemplazada++;
      else resumen.ignorada++;
      continue;
    }

    // Sub viva pero con otro status (active↔trialing↔past_due)
    console.log(
      `  ~ ${u.id_usuario} ${u.email} ${s.id} status BD=${u.st_bd} Stripe=${s.status} ⇒ sync status`,
    );
    if (APLICAR) {
      await db.query(
        `UPDATE usuarios_chat_center
            SET stripe_subscription_status = ?,
                cancel_at_period_end = ?,
                cancel_at = ?,
                canceled_at = ?
          WHERE id_usuario = ? AND stripe_subscription_id = ? LIMIT 1`,
        {
          replacements: [
            s.status,
            s.cancel_at_period_end ? 1 : 0,
            fechaDe(s.cancel_at),
            fechaDe(s.canceled_at),
            u.id_usuario,
            s.id,
          ],
        },
      );
    }
    resumen.status_sync++;
  }

  // Informativo: active en Stripe sin fila en BD
  const todosBD = await db.query(
    `SELECT id_usuario, email_propietario AS email, estado,
            stripe_subscription_id AS sub_id, stripe_subscription_status AS st
       FROM usuarios_chat_center WHERE stripe_subscription_id IS NOT NULL`,
    { type: db.QueryTypes.SELECT },
  );
  const bdPorSub = new Map(todosBD.map((u) => [u.sub_id, u]));
  const huerfanas = [...stripeSubs.values()].filter(
    (s) => s.status === 'active' && !bdPorSub.has(s.id),
  );
  if (huerfanas.length) {
    console.log(
      `\nActive en Stripe sin registro en BD (${huerfanas.length}), revisar a mano:`,
    );
    for (const s of huerfanas) {
      const cus = await stripe.customers.retrieve(s.customer).catch(() => null);
      const monto =
        s.items.data.reduce((a, i) => a + (i.price?.unit_amount || 0), 0) / 100;
      const dueno = s.metadata?.id_usuario
        ? `metadata.id_usuario=${s.metadata.id_usuario}`
        : 'sin metadata';
      console.log(
        `  ${s.id} ${cus?.email || s.customer} $${monto} creada=${fechaDe(
          s.created,
        )
          .toISOString()
          .slice(0, 10)} ${dueno}`,
      );
    }
  }

  console.log('\nResumen:', resumen);
  if (!APLICAR && resumen.cancelada + resumen.reemplazada + resumen.status_sync)
    console.log('Nada se escribió. Repetir con --aplicar para corregir.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
