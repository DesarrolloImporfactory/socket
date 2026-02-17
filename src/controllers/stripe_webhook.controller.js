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
        const session = event.data.object;

        const id_usuario = Number(
          session.client_reference_id || session.metadata?.id_usuario,
        );

        console.log('[stripe] checkout.session.completed');
        console.log('[stripe] session.id:', session?.id);
        console.log('[stripe] id_usuario:', id_usuario);
        console.log('[stripe] customerId:', session?.customer || null);
        console.log('[stripe] subscriptionId:', session?.subscription || null);

        if (!id_usuario) break;

        const customerId = session.customer || null;
        const subscriptionId = session.subscription || null;

        // Guardar customer/subscription si existen (sin activar plan aquí)
        const [upd] = await db.query(
          `UPDATE usuarios_chat_center
           SET id_costumer = IFNULL(id_costumer, ?),
               stripe_subscription_id = IFNULL(stripe_subscription_id, ?)
           WHERE id_usuario = ?`,
          {
            replacements: [customerId, subscriptionId, id_usuario],
          },
        );

        console.log('[stripe] usuarios_chat_center update result:', upd);
        break;
      }

      /**
       * Pago exitoso (evento más importante)
       * - Actualiza plan/estado/fechas en usuarios_chat_center
       * - Inserta transacción (idempotente con INSERT IGNORE + UNIQUE(id_pago))
       */
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;

        console.log('[stripe] invoice.payment_succeeded');
        console.log('[stripe] invoice.id:', invoice?.id);
        console.log('[stripe] subscriptionId:', invoice?.subscription || null);
        console.log('[stripe] customerId:', invoice?.customer || null);

        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;

        if (!subscriptionId) break;

        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);

        console.log('[stripe] sub.id:', subscription?.id);
        console.log('[stripe] sub.status:', subscription?.status);
        console.log('[stripe] sub.metadata:', subscription?.metadata);

        // ✅ fallback robusto
        let id_usuario = Number(subscription.metadata?.id_usuario);
        let id_plan = Number(subscription.metadata?.id_plan);

        // Si metadata viene vacío, resolver por BD usando customerId
        if (!id_usuario && customerId) {
          const [[row]] = await db.query(
            `SELECT id_usuario FROM usuarios_chat_center WHERE id_costumer = ? LIMIT 1`,
            { replacements: [customerId] },
          );
          id_usuario = Number(row?.id_usuario) || null;
        }

        // Si id_plan no viene, inferirlo por price del invoice
        if (!id_plan && invoice?.lines?.data?.[0]?.price?.id) {
          const priceId = invoice.lines.data[0].price.id;
          const [[planRow]] = await db.query(
            `SELECT id_plan FROM planes_chat_center WHERE id_price = ? LIMIT 1`,
            { replacements: [priceId] },
          );
          id_plan = Number(planRow?.id_plan) || null;
        }

        console.log('[stripe] resolved id_usuario:', id_usuario);
        console.log('[stripe] resolved id_plan:', id_plan);

        const start = subscription.current_period_start
          ? new Date(subscription.current_period_start * 1000)
          : null;

        const end = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null;

        const trialEnd = subscription.trial_end
          ? new Date(subscription.trial_end * 1000)
          : null;

        if (id_usuario) {
          const [upd] = await db.query(
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

          console.log('[stripe] usuarios_chat_center update result:', upd);
        } else {
          console.log(
            '[stripe] WARNING: id_usuario not resolved, skipping usuarios_chat_center update',
          );
        }

        // ✅ Guardar SOLO este momento como "pago confirmado"
        const [ins] = await db.query(
          `INSERT IGNORE INTO transacciones_stripe_chat
           (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
           VALUES (?, ?, ?, ?, NOW(), ?)`,
          {
            replacements: [
              invoice.id, // invoice id (único)
              subscriptionId,
              id_usuario || null,
              'payment_succeeded',
              customerId || null,
            ],
          },
        );

        console.log('[stripe] transacciones insert result:', ins);
        break;
      }

      /**
       * ❌ Pago fallido
       * - Suspende usuario
       * - Inserta transacción
       */
      case 'invoice.payment_failed': {
        const invoice = event.data.object;

        console.log('[stripe] invoice.payment_failed');
        console.log('[stripe] invoice.id:', invoice?.id);
        console.log('[stripe] subscriptionId:', invoice?.subscription || null);
        console.log('[stripe] customerId:', invoice?.customer || null);

        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;

        if (!subscriptionId) break;

        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);

        console.log('[stripe] sub.id:', subscription?.id);
        console.log('[stripe] sub.status:', subscription?.status);
        console.log('[stripe] sub.metadata:', subscription?.metadata);

        // ✅ fallback robusto
        let id_usuario = Number(subscription.metadata?.id_usuario);

        if (!id_usuario && customerId) {
          const [[row]] = await db.query(
            `SELECT id_usuario FROM usuarios_chat_center WHERE id_costumer = ? LIMIT 1`,
            { replacements: [customerId] },
          );
          id_usuario = Number(row?.id_usuario) || null;
        }

        console.log('[stripe] resolved id_usuario:', id_usuario);

        if (id_usuario) {
          const [upd] = await db.query(
            `UPDATE usuarios_chat_center
             SET estado = 'suspendido'
             WHERE id_usuario = ?`,
            { replacements: [id_usuario] },
          );

          console.log('[stripe] usuarios_chat_center suspend result:', upd);
        } else {
          console.log(
            '[stripe] WARNING: id_usuario not resolved, skipping usuarios_chat_center suspend',
          );
        }

        const [ins] = await db.query(
          `INSERT IGNORE INTO transacciones_stripe_chat
           (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
           VALUES (?, ?, ?, ?, NOW(), ?)`,
          {
            replacements: [
              invoice.id,
              subscriptionId,
              id_usuario || null,
              'payment_failed',
              customerId || null,
            ],
          },
        );

        console.log('[stripe] transacciones insert result:', ins);
        break;
      }

      default: {
        console.log('[stripe] ignored event:', event.type);
        break;
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.log('[stripe] handler error:', err?.message);
    return res.status(500).json({ received: false, error: err.message });
  }
};
