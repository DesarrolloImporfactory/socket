const Stripe = require('stripe');
const { db } = require('../database/config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

exports.stripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
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
        if (!id_usuario) break;

        const customerId = session.customer || null;
        const subscriptionId = session.subscription || null;

        // Guardar customer/subscription si existen (sin activar plan aquí)
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
        const invoice = event.data.object;

        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;

        if (!subscriptionId) break;

        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);

        const id_usuario = Number(subscription.metadata?.id_usuario);
        const id_plan = Number(subscription.metadata?.id_plan);

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
          await db.query(
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
        }

        // ✅ Guardar SOLO este momento como "pago confirmado"
        await db.query(
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

        break;
      }

      /**
       * ❌ Pago fallido
       * - Suspende usuario
       * - Inserta transacción
       */
      case 'invoice.payment_failed': {
        const invoice = event.data.object;

        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;

        if (!subscriptionId) break;

        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);
        const id_usuario = Number(subscription.metadata?.id_usuario);

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
              subscriptionId,
              id_usuario || null,
              'payment_failed',
              customerId || null,
            ],
          },
        );

        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ received: false, error: err.message });
  }
};
