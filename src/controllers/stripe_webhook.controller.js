const Stripe = require('stripe');
const { db } = require('../database/config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

exports.stripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  console.log('--- STRIPE WEBHOOK HIT ---');
  console.log('sig exists?', !!sig);
  console.log('secret exists?', !!process.env.STRIPE_WEBHOOK_SECRET_PLAN);
  console.log('body is buffer?', Buffer.isBuffer(req.body));
  console.log('content-type:', req.headers['content-type']);

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET_PLAN,
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log('[stripe] type:', event.type);

    switch (event.type) {
      /**
       *  Opcional
       * Checkout completado: guardamos ids básicos (NO es el pago real)
       */
      case 'checkout.session.completed': {
        console.log('[stripe] checkout.session.completed');

        const session = event.data.object;

        const id_usuario =
          Number(session.client_reference_id || session.metadata?.id_usuario) ||
          null;

        const customerId = session.customer || null;
        const subscriptionId = session.subscription || null;

        console.log('[stripe] session.id:', session.id);
        console.log('[stripe] id_usuario:', id_usuario);
        console.log('[stripe] customerId:', customerId);
        console.log('[stripe] subscriptionId:', subscriptionId);

        if (!id_usuario) break;

        await db.query(
          `UPDATE usuarios_chat_center
           SET id_costumer = COALESCE(?, id_costumer),
               stripe_subscription_id = COALESCE(?, stripe_subscription_id)
           WHERE id_usuario = ?`,
          {
            replacements: [customerId, subscriptionId, id_usuario],
          },
        );

        break;
      }

      /**
       *  Pago exitoso (FUENTE DE VERDAD)
       * - Activa usuario
       * - Actualiza plan/fechas
       * - Sincroniza status/flags de Stripe en columnas nuevas
       * - Inserta transacción idempotente
       */
      case 'invoice.payment_succeeded': {
        console.log('[stripe] invoice.payment_succeeded');

        const invoice = event.data.object;

        const customerId = invoice.customer || null;
        const firstLine = invoice.lines?.data?.[0] || null;

        const subscriptionId =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          firstLine?.parent?.subscription_item_details?.subscription ||
          firstLine?.subscription ||
          null;

        const metaFromParent =
          invoice.parent?.subscription_details?.metadata || {};
        const metaFromLine = firstLine?.metadata || {};

        console.log('[stripe] invoice.id:', invoice.id);
        console.log('[stripe] billing_reason:', invoice.billing_reason || null);
        console.log('[stripe] customerId:', customerId);
        console.log('[stripe] subscriptionId:', subscriptionId);
        console.log('[stripe] meta(parent):', metaFromParent);
        console.log('[stripe] meta(line):', metaFromLine);

        // 1) Insertar transacción (idempotente)
        try {
          await db.query(
            `INSERT IGNORE INTO transacciones_stripe_chat
             (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
             VALUES (?, ?, ?, ?, NOW(), ?)`,
            {
              replacements: [
                invoice.id,
                subscriptionId || null,
                null,
                'payment_succeeded',
                customerId || null,
              ],
            },
          );
          console.log('[stripe] transacciones inserted/ignored:', invoice.id);
        } catch (e) {
          console.log('[stripe] transacciones insert failed:', e?.message);
        }

        // 2) Resolver id_usuario / id_plan + fechas + flags Stripe
        let id_usuario = null;
        let id_plan = null;

        let start = firstLine?.period?.start
          ? new Date(firstLine.period.start * 1000)
          : null;
        let end = firstLine?.period?.end
          ? new Date(firstLine.period.end * 1000)
          : null;
        let trialEnd = null;

        let subStatus = null;
        let cancelAtPeriodEnd = 0;
        let cancelAt = null;
        let canceledAt = null;

        if (subscriptionId) {
          try {
            const subscription =
              await stripe.subscriptions.retrieve(subscriptionId);
            const metaSub = subscription.metadata || {};

            id_usuario = Number(metaSub?.id_usuario) || null;
            id_plan = Number(metaSub?.id_plan) || null;

            if (subscription.current_period_start)
              start = new Date(subscription.current_period_start * 1000);
            if (subscription.current_period_end)
              end = new Date(subscription.current_period_end * 1000);
            if (subscription.trial_end)
              trialEnd = new Date(subscription.trial_end * 1000);

            //  Flags/status reales
            subStatus = subscription.status || null;
            cancelAtPeriodEnd = subscription.cancel_at_period_end ? 1 : 0;
            cancelAt = subscription.cancel_at
              ? new Date(subscription.cancel_at * 1000)
              : null;
            canceledAt = subscription.canceled_at
              ? new Date(subscription.canceled_at * 1000)
              : null;

            console.log('[stripe] meta(subscription):', metaSub);
            console.log('[stripe] id_usuario(sub):', id_usuario);
            console.log('[stripe] id_plan(sub):', id_plan);
            console.log('[stripe] sub.status:', subStatus);
            console.log('[stripe] cancel_at_period_end:', cancelAtPeriodEnd);
          } catch (e) {
            console.log('[stripe] subscriptions.retrieve failed:', e?.message);
          }
        }

        // Fallback metadata invoice si no vino desde subscription
        if (!id_usuario) {
          id_usuario =
            Number(metaFromParent?.id_usuario || metaFromLine?.id_usuario) ||
            null;
          console.log(
            '[stripe] id_usuario fallback(invoice meta):',
            id_usuario,
          );
        }
        if (!id_plan) {
          id_plan =
            Number(metaFromParent?.id_plan || metaFromLine?.id_plan) || null;
          console.log('[stripe] id_plan fallback(invoice meta):', id_plan);
        }

        if (!id_usuario) {
          console.log(
            '[stripe] WARNING: id_usuario not found. Skipping usuarios_chat_center update.',
          );
          break;
        }

        // 3) Update usuario: aquí dejamos TODO sincronizado
        const [updateResult] = await db.query(
          `UPDATE usuarios_chat_center
           SET id_plan = ?,
               estado = 'activo',
               fecha_inicio = COALESCE(fecha_inicio, ?),
               fecha_renovacion = ?,
               free_trial_used = 1,
               id_costumer = COALESCE(?, id_costumer),
               stripe_subscription_id = COALESCE(?, stripe_subscription_id),
               trial_end = ?,
               stripe_subscription_status = COALESCE(?, stripe_subscription_status),
               cancel_at_period_end = COALESCE(?, cancel_at_period_end),
               cancel_at = COALESCE(?, cancel_at),
               canceled_at = COALESCE(?, canceled_at)
           WHERE id_usuario = ?`,
          {
            replacements: [
              id_plan || null,
              start,
              end,
              customerId || null,
              subscriptionId || null,
              trialEnd,
              subStatus || null,
              cancelAtPeriodEnd,
              cancelAt,
              canceledAt,
              id_usuario,
            ],
          },
        );

        console.log(
          '[stripe] usuarios_chat_center update result:',
          updateResult,
        );

        // 4) Completar id_usuario en transacciones
        try {
          await db.query(
            `UPDATE transacciones_stripe_chat
             SET id_usuario = COALESCE(id_usuario, ?),
                 id_suscripcion = COALESCE(id_suscripcion, ?),
                 customer_id = COALESCE(customer_id, ?)
             WHERE id_pago = ?`,
            {
              replacements: [
                id_usuario,
                subscriptionId || null,
                customerId || null,
                invoice.id,
              ],
            },
          );
          console.log(
            '[stripe] transacciones updated with id_usuario:',
            invoice.id,
          );
        } catch (e) {
          console.log('[stripe] transacciones update failed:', e?.message);
        }

        break;
      }

      /**
       * ❌ Pago fallido
       * - Suspende usuario
       * - Sincroniza status/flags de Stripe
       * - Inserta transacción idempotente
       */
      case 'invoice.payment_failed': {
        console.log('[stripe] invoice.payment_failed');

        const invoice = event.data.object;

        const customerId = invoice.customer || null;
        const firstLine = invoice.lines?.data?.[0] || null;

        const subscriptionId =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          firstLine?.parent?.subscription_item_details?.subscription ||
          firstLine?.subscription ||
          null;

        console.log('[stripe] invoice.id:', invoice.id);
        console.log('[stripe] customerId:', customerId);
        console.log('[stripe] subscriptionId:', subscriptionId);

        let id_usuario = null;

        let subStatus = null;
        let cancelAtPeriodEnd = 0;
        let cancelAt = null;
        let canceledAt = null;

        if (subscriptionId) {
          try {
            const subscription =
              await stripe.subscriptions.retrieve(subscriptionId);
            id_usuario = Number(subscription.metadata?.id_usuario) || null;

            subStatus = subscription.status || null;
            cancelAtPeriodEnd = subscription.cancel_at_period_end ? 1 : 0;
            cancelAt = subscription.cancel_at
              ? new Date(subscription.cancel_at * 1000)
              : null;
            canceledAt = subscription.canceled_at
              ? new Date(subscription.canceled_at * 1000)
              : null;

            console.log('[stripe] id_usuario(subscription.meta):', id_usuario);
            console.log('[stripe] sub.status:', subStatus);
          } catch (e) {
            console.log('[stripe] subscriptions.retrieve failed:', e?.message);
          }
        }

        if (id_usuario) {
          await db.query(
            `UPDATE usuarios_chat_center
             SET estado = 'suspendido',
                 stripe_subscription_status = COALESCE(?, stripe_subscription_status),
                 cancel_at_period_end = COALESCE(?, cancel_at_period_end),
                 cancel_at = COALESCE(?, cancel_at),
                 canceled_at = COALESCE(?, canceled_at)
             WHERE id_usuario = ?`,
            {
              replacements: [
                subStatus,
                cancelAtPeriodEnd,
                cancelAt,
                canceledAt,
                id_usuario,
              ],
            },
          );
        }

        await db.query(
          `INSERT IGNORE INTO transacciones_stripe_chat
           (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
           VALUES (?, ?, ?, ?, NOW(), ?)`,
          {
            replacements: [
              invoice.id,
              subscriptionId || null,
              id_usuario || null,
              'payment_failed',
              customerId || null,
            ],
          },
        );

        break;
      }

      /**
       *  Cambios en la suscripción (cancelación programada / cancelación efectiva)
       * - Actualiza flags/status
       * - Si ya terminó realmente: estado = 'cancelado'
       * - Inserta auditoría idempotente
       */
      case 'customer.subscription.updated': {
        console.log('[stripe] customer.subscription.updated');

        const sub = event.data.object;

        const subscriptionId = sub.id || null;
        const customerId = sub.customer || null;

        const id_usuario = Number(sub.metadata?.id_usuario) || null;
        const id_plan = Number(sub.metadata?.id_plan) || null;

        const cancelAtPeriodEnd = sub.cancel_at_period_end ? 1 : 0;

        const cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000) : null;
        const canceledAt = sub.canceled_at
          ? new Date(sub.canceled_at * 1000)
          : null;

        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null;

        const status = sub.status || null;

        console.log('[stripe] subscriptionId:', subscriptionId);
        console.log('[stripe] customerId:', customerId);
        console.log('[stripe] id_usuario:', id_usuario);
        console.log('[stripe] id_plan:', id_plan);
        console.log('[stripe] cancel_at_period_end:', cancelAtPeriodEnd);
        console.log('[stripe] cancel_at:', cancelAt);
        console.log('[stripe] canceled_at:', canceledAt);
        console.log('[stripe] current_period_end:', currentPeriodEnd);
        console.log('[stripe] status:', status);

        // 1) Actualizar flags del usuario
        if (id_usuario) {
          await db.query(
            `UPDATE usuarios_chat_center
             SET id_plan = COALESCE(?, id_plan),
                 id_costumer = COALESCE(?, id_costumer),
                 stripe_subscription_id = COALESCE(?, stripe_subscription_id),
                 fecha_renovacion = COALESCE(?, fecha_renovacion),
                 stripe_subscription_status = ?,
                 cancel_at_period_end = ?,
                 cancel_at = ?,
                 canceled_at = ?
             WHERE id_usuario = ?`,
            {
              replacements: [
                id_plan || null,
                customerId || null,
                subscriptionId || null,
                currentPeriodEnd,
                status,
                cancelAtPeriodEnd,
                cancelAt,
                canceledAt,
                id_usuario,
              ],
            },
          );

          //  Si ya terminó realmente: cancelar en su BD
          if (status === 'canceled' || sub.ended_at) {
            await db.query(
              `UPDATE usuarios_chat_center
               SET estado = 'cancelado'
               WHERE id_usuario = ?`,
              { replacements: [id_usuario] },
            );
          }
        }

        // 2) Auditoría idempotente
        const estadoTx =
          status === 'canceled' || sub.ended_at
            ? 'subscription_canceled'
            : cancelAtPeriodEnd
              ? 'cancel_scheduled'
              : 'subscription_updated';

        const idPago = `subupd_${subscriptionId}_${estadoTx}_${sub.canceled_at || 'na'}_${sub.cancel_at || 'na'}`;

        await db.query(
          `INSERT IGNORE INTO transacciones_stripe_chat
           (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
           VALUES (?, ?, ?, ?, NOW(), ?)`,
          {
            replacements: [
              idPago,
              subscriptionId || null,
              id_usuario || null,
              estadoTx,
              customerId || null,
            ],
          },
        );

        break;
      }

      default:
        console.log('[stripe] ignored event:', event.type);
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.log('[stripe] webhook handler error:', err?.message);
    return res.status(500).json({ received: false, error: err.message });
  }
};
