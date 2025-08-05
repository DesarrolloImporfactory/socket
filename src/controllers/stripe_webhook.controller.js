const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const { db } = require('../database/config');

exports.stripeWebhook = async (req, res) => {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Guardar id_pago y customer
  if (event.type === 'payment_intent.created') {
    const paymentIntent = event.data.object;

    try {
      const paymentId = paymentIntent.id;
      const customerId = paymentIntent.customer;

      if (!paymentId || !customerId) {
        console.warn('⚠️ paymentId o customerId no presente en payment_intent.created');
        return res.status(400).json({ message: 'Faltan datos' });
      }

      await db.query(
        `INSERT INTO transacciones_stripe_chat (id_pago, customer_id, fecha) VALUES (?, ?, NOW())`,
        { replacements: [paymentId, customerId] }
      );

      console.log(`✅ id_pago registrado con customer: ${paymentId}, ${customerId}`);
      return res.status(200).json({ received: true });

    } catch (error) {
      console.error("❌ Error en payment_intent.created:", error);
      return res.status(500).json({ message: "Error interno" });
    }
  }

  // ✅ Activar usuario y actualizar fila usando customer
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;

    try {
      const lineItem = invoice.lines?.data?.[0];
      const subscriptionId = lineItem?.parent?.subscription_item_details?.subscription;
      const metadata = lineItem?.metadata || {};
      const customerId = invoice.customer;

      if (!subscriptionId || !customerId) {
        console.warn('⚠️ subscriptionId o customerId no encontrado');
        return res.status(400).json({ message: 'Faltan datos en webhook' });
      }

      const id_usuario = metadata.id_usuario;
      const id_plan = metadata.id_plan;

      if (!id_usuario || !id_plan) {
        console.warn('⚠️ Faltan datos de metadata');
        return res.status(400).json({ message: 'Faltan datos de usuario/plan' });
      }

      const usuario = await Usuarios_chat_center.findByPk(id_usuario);
      const plan = await Planes_chat_center.findByPk(id_plan);

      if (!usuario || !plan) {
        return res.status(404).json({ message: 'Usuario o plan no encontrado' });
      }

      const hoy = new Date();
      const fechaRenovacion = new Date(hoy);
      fechaRenovacion.setDate(hoy.getDate() + 30);

      await usuario.update({
        id_plan,
        fecha_inicio: hoy,
        fecha_renovacion: fechaRenovacion,
        estado: 'activo',
        id_product_stripe: plan.id_product_stripe
      });

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const status = subscription.status || 'sin_suscripcion';

      await db.query(
        `UPDATE transacciones_stripe_chat 
         SET id_suscripcion = ?, id_usuario = ?, estado_suscripcion = ?, fecha = NOW()
         WHERE customer_id = ?`,
        { replacements: [subscriptionId, id_usuario, status, customerId] }
      );

      console.log(`✅ Transacción completada para customer: ${customerId}`);
      return res.status(200).json({ received: true });

    } catch (error) {
      console.error("❌ Error en invoice.payment_succeeded:", error);
      return res.status(500).json({ message: "Error interno" });
    }
  }
  // Cuando termina el periodo de una suscripción cancelada
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;

    try {
      const subscriptionId = subscription.id;

      // Actualiza en tu base de datos el estado a 'cancelado'
      await db.query(
        `UPDATE transacciones_stripe_chat 
         SET estado_suscripcion = 'canceled'
         WHERE id_suscripcion = ?`,
        { replacements: [subscriptionId] }
      );

      // Opcional: también puedes actualizar el estado del usuario si lo deseas
      await db.query(
        `UPDATE usuarios_chat_center
         SET estado = 'inactivo', id_plan = NULL
         WHERE id_usuario = (
           SELECT id_usuario 
           FROM transacciones_stripe_chat 
           WHERE id_suscripcion = ?
           ORDER BY fecha DESC 
           LIMIT 1
         )`,
        { replacements: [subscriptionId] }
      );

      console.log(`✅ Suscripción cancelada definitivamente: ${subscriptionId}`);
      return res.status(200).json({ received: true });

    } catch (error) {
      console.error("❌ Error en customer.subscription.deleted:", error);
      return res.status(500).json({ message: "Error al manejar cancelación final" });
    }
  }


  return res.json({ received: true });
};


