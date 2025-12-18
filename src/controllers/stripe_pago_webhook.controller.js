const stripe = require('stripe')(process.env.STRIPE_V2_SECRET_KEY);
const AppError = require('../utils/appError');

// ✅ Aquí usted debe implementar su lógica real de activación
async function activarPlanEnSistema({ id_usuario, id_plan, customer, subscription, price_id, invoice_id }) {
  // EJEMPLO (pseudocódigo):
  // 1) Marcar plan activo en tabla de suscripciones/planes del usuario
  // 2) Guardar stripe_customer_id, stripe_subscription_id, stripe_price_id, invoice_id
  // 3) Definir fechas de vigencia si su sistema las maneja
  // await UsuarioPlan.update({...}, { where: { id_usuario } })
  console.log('[ACTIVAR PLAN]', { id_usuario, id_plan, customer, subscription, price_id, invoice_id });
}

async function registrarEventoProcesado(eventId) {
  // Recomendado: guardar eventId en BD para idempotencia (Stripe puede reenviar eventos)
  // En pruebas puede dejarlo vacío, pero en prod guárdelo sí o sí.
  return;
}

exports.stripeWebhook = async (req, res, next) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // whsec_...

  if (!endpointSecret) {
    return next(new AppError('Falta STRIPE_WEBHOOK_SECRET en .env', 500));
  }

  let event;

  try {
    // req.body aquí es Buffer porque usamos express.raw()
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ Idempotencia (recomendado en PROD)
    await registrarEventoProcesado(event.id);

    switch (event.type) {
      /**
       * ✅ CASO RECOMENDADO PARA SUSCRIPCIONES:
       * Se dispara cuando la factura se pagó con éxito.
       */
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;

        // invoice.subscription existe si es suscripción
        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;
        const invoiceId = invoice.id;

        if (!subscriptionId) {
          // Puede ocurrir si es pago no recurrente
          break;
        }

        // Recuperamos metadata del subscription (usted la pone en subscription_data.metadata en Checkout)
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        const id_plan = subscription.metadata?.id_plan;
        const id_usuario = subscription.metadata?.id_usuario;

        // Opcional: obtener price_id del subscription
        const price_id =
          subscription.items?.data?.[0]?.price?.id || '';

        if (!id_plan || !id_usuario) {
          console.warn('⚠️ Falta metadata id_plan/id_usuario en subscription:', subscriptionId);
          break;
        }

        await activarPlanEnSistema({
          id_usuario,
          id_plan,
          customer: customerId,
          subscription: subscriptionId,
          price_id,
          invoice_id: invoiceId,
        });

        break;
      }

      /**
       * ✅ ÚTIL PARA PAGOS ÚNICOS (o para registrar la sesión):
       * Checkout finalizó. Para suscripciones, a veces ocurre ANTES del cobro final (por eso invoice.payment_succeeded es mejor).
       */
      case 'checkout.session.completed': {
        const session = event.data.object;

        // metadata viene desde su checkout.session.create({ metadata: {...} })
        const id_plan = session.metadata?.id_plan;
        const id_usuario = session.metadata?.id_usuario;

        // Si fuera pago único puede activar aquí,
        // pero para suscripción recomiendo esperar invoice.payment_succeeded
        console.log('✅ checkout.session.completed:', {
          session_id: session.id,
          id_plan,
          id_usuario,
          mode: session.mode,
        });

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn('⚠️ invoice.payment_failed:', invoice.id, 'customer:', invoice.customer);
        // Aquí puede marcar “pago fallido / plan en riesgo” en su sistema
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.warn('⚠️ subscription deleted:', sub.id, 'customer:', sub.customer);
        // Aquí puede desactivar plan en su sistema
        break;
      }

      default:
        // Eventos no manejados
        // console.log(`Unhandled event type ${event.type}`);
        break;
    }

    // Stripe exige 2xx
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ Error procesando webhook:', err);
    return next(new AppError(err.message || 'Error webhook', 500));
  }
};
