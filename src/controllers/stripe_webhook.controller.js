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
       * opcional
       * Cuando completa checkout, actualizamos datos del usuario
       * PERO no insertamos en transacciones (porque el pago real llega en invoice.*)
       */
      case 'checkout.session.completed': {
        console.log('[stripe] checkout.session.completed');

        const session = event.data.object;

        const id_usuario = Number(
          session.client_reference_id || session.metadata?.id_usuario,
        );

        const customerId = session.customer || null;
        const subscriptionId = session.subscription || null;

        console.log('[stripe] session.id:', session.id);
        console.log('[stripe] id_usuario:', id_usuario || null);
        console.log('[stripe] customerId:', customerId);
        console.log('[stripe] subscriptionId:', subscriptionId);

        if (!id_usuario) break;

        await db.query(
          `UPDATE usuarios_chat_center
           SET id_costumer = IFNULL(id_costumer, ?),
               stripe_subscription_id = IFNULL(stripe_subscription_id, ?)
           WHERE id_usuario = ?`,
          {
            replacements: [customerId, subscriptionId, id_usuario],
          },
        );

        break;
      }

      /**
       * Pago exitoso (evento más importante)
       * - Actualiza plan/estado/fechas en usuarios_chat_center
       * - Inserta transacción (idempotente con INSERT IGNORE + UNIQUE(id_pago))
       */
      case 'invoice.payment_succeeded': {
        console.log('[stripe] invoice.payment_succeeded');

        const invoice = event.data.object;

        const customerId = invoice.customer || null;

        const firstLine = invoice.lines?.data?.[0] || null;

        // Fallbacks EXACTOS para su payload
        const subscriptionId =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          firstLine?.parent?.subscription_item_details?.subscription ||
          firstLine?.subscription ||
          null;

        // Fallbacks de metadata para id_usuario / id_plan desde el invoice
        const metaFromParent =
          invoice.parent?.subscription_details?.metadata || {};
        const metaFromLine = firstLine?.metadata || {};

        console.log('[stripe] invoice.id:', invoice.id);
        console.log('[stripe] billing_reason:', invoice.billing_reason || null);
        console.log('[stripe] customerId:', customerId);
        console.log('[stripe] subscriptionId:', subscriptionId);
        console.log(
          '[stripe] line.period.start:',
          firstLine?.period?.start || null,
        );
        console.log(
          '[stripe] line.period.end:',
          firstLine?.period?.end || null,
        );
        console.log('[stripe] meta(parent):', metaFromParent);
        console.log('[stripe] meta(line):', metaFromLine);

        // Siempre insertar transacción (aunque subscriptionId sea null)
        try {
          await db.query(
            `INSERT IGNORE INTO transacciones_stripe_chat
             (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
             VALUES (?, ?, ?, ?, NOW(), ?)`,
            {
              replacements: [
                invoice.id,
                subscriptionId || null,
                null, // luego lo actualizamos si logramos resolver id_usuario
                'payment_succeeded',
                customerId || null,
              ],
            },
          );
          console.log(
            '[stripe] transacciones inserted/ignored for invoice:',
            invoice.id,
          );
        } catch (e) {
          console.log('[stripe] transacciones insert failed:', e?.message);
        }

        //  Resolver id_usuario / id_plan:
        // 1) intentamos desde la suscripción (metadata fuerte)
        // 2) si falla, usamos metadata del invoice (parent/line)
        let id_usuario = null;
        let id_plan = null;

        // Fechas por defecto desde el invoice line.period (payload lo trae)
        let start = firstLine?.period?.start
          ? new Date(firstLine.period.start * 1000)
          : null;
        let end = firstLine?.period?.end
          ? new Date(firstLine.period.end * 1000)
          : null;
        let trialEnd = null;

        if (subscriptionId) {
          try {
            const subscription =
              await stripe.subscriptions.retrieve(subscriptionId);

            const metaSub = subscription.metadata || {};

            id_usuario = Number(metaSub?.id_usuario) || null;
            id_plan = Number(metaSub?.id_plan) || null;

            // Si Stripe trae periodos, preferimos Stripe
            if (subscription.current_period_start) {
              start = new Date(subscription.current_period_start * 1000);
            }
            if (subscription.current_period_end) {
              end = new Date(subscription.current_period_end * 1000);
            }
            if (subscription.trial_end) {
              trialEnd = new Date(subscription.trial_end * 1000);
            }

            console.log('[stripe] subscription.id:', subscriptionId);
            console.log('[stripe] meta(subscription):', metaSub);
            console.log('[stripe] id_usuario(from subscription):', id_usuario);
            console.log('[stripe] id_plan(from subscription):', id_plan);
            console.log('[stripe] start(from subscription or line):', start);
            console.log('[stripe] end(from subscription or line):', end);
            console.log('[stripe] trialEnd(from subscription):', trialEnd);
          } catch (e) {
            console.log('[stripe] subscriptions.retrieve failed:', e?.message);
          }
        }

        // Fallback a metadata del invoice si no salió desde subscription
        if (!id_usuario) {
          id_usuario =
            Number(metaFromParent?.id_usuario || metaFromLine?.id_usuario) ||
            null;
          console.log(
            '[stripe] id_usuario fallback (invoice metadata):',
            id_usuario,
          );
        }
        if (!id_plan) {
          id_plan =
            Number(metaFromParent?.id_plan || metaFromLine?.id_plan) || null;
          console.log('[stripe] id_plan fallback (invoice metadata):', id_plan);
        }

        // Si no tenemos id_usuario, no podemos actualizar BD, pero la transacción ya quedó registrada
        if (!id_usuario) {
          console.log(
            '[stripe] WARNING: id_usuario not found. Skipping usuarios_chat_center update.',
          );
          break;
        }

        //  Actualizar usuario con fechas/plan
        const [updateResult] = await db.query(
          `UPDATE usuarios_chat_center
           SET id_plan = ?,
               estado = 'activo',
               fecha_inicio = IFNULL(fecha_inicio, ?),
               fecha_renovacion = ?,
               free_trial_used = 1,
               id_costumer = IFNULL(id_costumer, ?),
               stripe_subscription_id = IFNULL(stripe_subscription_id, ?),
               trial_end = ?
           WHERE id_usuario = ?`,
          {
            replacements: [
              id_plan || null,
              start,
              end,
              customerId || null,
              subscriptionId || null,
              trialEnd,
              id_usuario,
            ],
          },
        );

        console.log(
          '[stripe] usuarios_chat_center update result:',
          updateResult,
        );

        // Completar id_usuario en transacciones (porque arriba lo insertamos con null)
        try {
          await db.query(
            `UPDATE transacciones_stripe_chat
             SET id_usuario = IFNULL(id_usuario, ?),
                 id_suscripcion = IFNULL(id_suscripcion, ?),
                 customer_id = IFNULL(customer_id, ?)
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
            '[stripe] transacciones updated with id_usuario for invoice:',
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
       * - Inserta transacción
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

        if (subscriptionId) {
          try {
            const subscription =
              await stripe.subscriptions.retrieve(subscriptionId);
            id_usuario = Number(subscription.metadata?.id_usuario) || null;
            console.log(
              '[stripe] id_usuario (subscription.metadata):',
              id_usuario,
            );
          } catch (e) {
            console.log('[stripe] subscriptions.retrieve failed:', e?.message);
          }
        }

        if (id_usuario) {
          await db.query(
            `UPDATE usuarios_chat_center
             SET estado = 'suspendido'
             WHERE id_usuario = ?`,
            { replacements: [id_usuario] },
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
