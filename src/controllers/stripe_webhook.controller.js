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

    // 1) TOMA EL ID DE SUSCRIPCIÓN COMO TÚ LO VENÍAS HACIENDO (PRIMARIO)
    let subscriptionId =
      lineItem?.parent?.subscription_item_details?.subscription
      // 2) FALLBACK OFICIAL (por si algún día Stripe lo manda aquí)
      || invoice.subscription
      // 3) OTROS INTENTOS SUAVES (por compatibilidad)
      || lineItem?.subscription_details?.subscription
      || lineItem?.subscription
      || null;

    const customerId = invoice.customer;

    if (!subscriptionId || !customerId) {
      console.warn('[WH] invoice.payment_succeeded: faltan subscriptionId/customerId', {
        invoiceId: invoice.id, subscriptionId, customerId
      });
      // No cortar el flujo del webhook
      return res.status(200).json({ received: true });
    }

    // 4) METADATA: primero intenta desde la SUSCRIPCIÓN (tú la llenas en checkout)
    let id_usuario = undefined;
    let id_plan = undefined;

    let subStatus = 'sin_suscripcion';
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      subStatus = sub?.status || subStatus;
      if (sub?.metadata) {
        id_usuario = sub.metadata.id_usuario || id_usuario;
        id_plan    = sub.metadata.id_plan    || id_plan;
      }
    } catch (e) {
      console.warn('[WH] No se pudo expandir la suscripción para leer metadata:', e?.raw?.message || e.message);
    }

    // 5) FALLBACK: si no vino en la sub, toma metadata del lineItem (tu flujo actual)
    if (!id_usuario || !id_plan) {
      const md = lineItem?.metadata || {};
      id_usuario = id_usuario || md.id_usuario;
      id_plan    = id_plan    || md.id_plan;
    }

    // 6) ÚLTIMO FALLBACK para id_usuario: resolverlo por customer_id en tu tabla
    if (!id_usuario && customerId) {
      const [u] = await db.query(`
        SELECT id_usuario
        FROM transacciones_stripe_chat
        WHERE customer_id = ?
        ORDER BY fecha DESC
        LIMIT 1
      `, { replacements: [customerId] });
      id_usuario = u?.[0]?.id_usuario;
    }

    // Si aún faltan datos críticos, al menos registramos la transacción y salimos 200
    if (!id_usuario || !id_plan) {
      console.warn('[WH] invoice.payment_succeeded: metadata incompleta', { id_usuario, id_plan, subscriptionId, customerId });
      await db.query(`
        UPDATE transacciones_stripe_chat
        SET id_suscripcion = ?, estado_suscripcion = ?, fecha = NOW()
        WHERE customer_id = ?
      `, { replacements: [subscriptionId, subStatus, customerId] });
      return res.status(200).json({ received: true });
    }

    // 7) Activar usuario y fechas (tu lógica original)
    const usuario = await Usuarios_chat_center.findByPk(id_usuario);
    const plan = await Planes_chat_center.findByPk(id_plan);
    if (!usuario || !plan) {
      console.warn('[WH] Usuario o plan no encontrado', { id_usuario, id_plan });
      // Aun así, registra la transacción
      await db.query(`
        UPDATE transacciones_stripe_chat
        SET id_suscripcion = ?, id_usuario = ?, estado_suscripcion = ?, fecha = NOW()
        WHERE customer_id = ?
      `, { replacements: [subscriptionId, id_usuario || null, subStatus, customerId] });
      return res.status(200).json({ received: true });
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

    // 8) Persistencia en tu tabla (igual que hacías)
    await db.query(`
      UPDATE transacciones_stripe_chat 
      SET id_suscripcion = ?, id_usuario = ?, estado_suscripcion = ?, fecha = NOW()
      WHERE customer_id = ?
    `, { replacements: [subscriptionId, id_usuario, subStatus, customerId] });

    console.log(`invoice.payment_succeeded OK -> cust:${customerId} sub:${subscriptionId}`);
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ invoice.payment_succeeded handler:', error);
    // Nunca respondas 500 a Stripe; responde 200 y loguea
    return res.status(200).json({ received: true });
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


// Guarda el PM cuando se completa un SetupIntent (Checkout setup o Portal)
if (event.type === 'setup_intent.succeeded') {
  const si = event.data.object; // SetupIntent
  try {
    const pmId = si.payment_method;
    const customerId = si.customer;

    // Resuelve id_usuario a partir del customer o metadata
    let id_usuario = si.metadata?.id_usuario;
    if (!id_usuario && customerId) {
      const [u] = await db.query(`
        SELECT id_usuario
        FROM transacciones_stripe_chat
        WHERE customer_id = ?
        ORDER BY fecha DESC
        LIMIT 1
      `, { replacements: [customerId] });
      id_usuario = u?.[0]?.id_usuario;
    }
    if (!pmId || !id_usuario) return res.status(200).json({ received: true });

    const [p] = await db.query(
      `SELECT COALESCE(MAX(priority),0) AS maxp
       FROM user_payment_methods
       WHERE id_usuario = ?`,
      { replacements: [id_usuario] }
    );
    const nextPriority = (p?.[0]?.maxp || 0) + 1;

    await db.query(`
      INSERT INTO user_payment_methods (id_usuario, pm_id, priority, status)
      VALUES (?, ?, ?, 'active')
      ON DUPLICATE KEY UPDATE status = VALUES(status)
    `, { replacements: [id_usuario, pmId, nextPriority] });

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('❌ setup_intent.succeeded handler:', e);
    return res.status(500).json({ message: 'Error guardando PM' });
  }
}

// También captura cuando Stripe adjunta un PM al customer (por Portal/otros flujos)
if (event.type === 'payment_method.attached') {
  const pm = event.data.object; // PaymentMethod
  try {
    const pmId = pm.id;
    const customerId = pm.customer;

    const [u] = await db.query(`
      SELECT id_usuario
      FROM transacciones_stripe_chat
      WHERE customer_id = ?
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [customerId] });
    const id_usuario = u?.[0]?.id_usuario;
    if (!pmId || !id_usuario) return res.status(200).json({ received: true });

    const [p] = await db.query(
      `SELECT COALESCE(MAX(priority),0) AS maxp
       FROM user_payment_methods
       WHERE id_usuario = ?`,
      { replacements: [id_usuario] }
    );
    const nextPriority = (p?.[0]?.maxp || 0) + 1;

    await db.query(`
      INSERT INTO user_payment_methods (id_usuario, pm_id, priority, status)
      VALUES (?, ?, ?, 'active')
      ON DUPLICATE KEY UPDATE status = 'active'
    `, { replacements: [id_usuario, pmId, nextPriority] });

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('❌ payment_method.attached handler:', e);
    return res.status(500).json({ message: 'Error guardando PM (attached)' });
  }
}
/* reintentar con la siguiente tarjeta */
if (event.type === 'invoice.payment_failed') {
  const invoice = event.data.object;
  try {
    const customerId = invoice.customer;
    const invoiceId = invoice.id;

    // ¿Qué usuario es?
    const [u] = await db.query(`
      SELECT id_usuario
      FROM transacciones_stripe_chat
      WHERE customer_id = ?
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [customerId] });
    const id_usuario = u?.[0]?.id_usuario;
    if (!id_usuario) return res.status(200).json({ received: true });

    // PM que falló (default del invoice)
    const failedPm = invoice.default_payment_method || null;

    // Candidatos en orden de prioridad
    const [pmRows] = await db.query(`
      SELECT pm_id
      FROM user_payment_methods
      WHERE id_usuario = ? AND status = 'active'
      ORDER BY priority ASC
    `, { replacements: [id_usuario] });

    const candidates = pmRows
      .map(r => r.pm_id)
      .filter(pm => pm && pm !== failedPm);

    for (const nextPm of candidates) {
      try {
        // Reintenta el mismo invoice con otra tarjeta del MISMO customer
        const paid = await stripe.invoices.pay(invoiceId, { payment_method: nextPm });

        // Si cobró, fija default para futuros ciclos y corta el bucle
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: nextPm }
        });
        if (invoice.subscription) {
          await stripe.subscriptions.update(invoice.subscription, {
            default_payment_method: nextPm
          });
        }
        console.log(`✅ Fallback OK con ${nextPm} en invoice ${invoiceId}`);
        return res.status(200).json({ received: true });
      } catch (e) {
        console.warn(`PM ${nextPm} falló, probando siguiente...`, e?.raw?.message || e.message);
        continue;
      }
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('❌ Error en fallback invoice.payment_failed:', e);
    return res.status(500).json({ message: 'Fallback failed' });
  }
}

// ➕ NUEVO: completar upgrade cuando se paga la diferencia en Checkout
if (event.type === 'checkout.session.completed') {
  const session = event.data.object;
  try {
    // Solo nos interesan las sesiones de pago de "diferencia de upgrade"
    if (session.mode !== 'payment') return res.status(200).json({ received: true });
    const md = session.metadata || {};
    if (md.tipo !== 'upgrade_delta') return res.status(200).json({ received: true });

    const subscriptionId = md.subscription_id;
    const toPriceId = md.to_price_id;
    const id_usuario = md.id_usuario;
    const id_plan = md.id_plan;

    if (!subscriptionId || !toPriceId || !id_usuario || !id_plan) {
      console.warn('[WH checkout.session.completed] Falta metadata para upgrade_delta', md);
      return res.status(200).json({ received: true });
    }

    // Recupera item actual de la suscripción
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const itemId = sub.items?.data?.[0]?.id;
    if (!itemId) {
      console.warn('[WH checkout.session.completed] No se encontró item en la suscripción', subscriptionId);
      return res.status(200).json({ received: true });
    }

    // Cambia al nuevo price SIN prorrateo (ya cobramos la diferencia como pago único)
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, price: toPriceId }],
      proration_behavior: 'none'
    });

    // Reflejar en DB: cambia id_plan y REINICIA fechas
    const usuario = await Usuarios_chat_center.findByPk(id_usuario);
    const plan = await Planes_chat_center.findByPk(id_plan);
    if (usuario && plan) {
      const hoy = new Date();
      const nuevaFechaRenovacion = new Date(hoy);
      nuevaFechaRenovacion.setDate(hoy.getDate() + 30);

      await usuario.update({
        id_plan: plan.id_plan,
        id_product_stripe: plan.id_product_stripe,
        estado: 'activo',
        fecha_inicio: hoy,
        fecha_renovacion: nuevaFechaRenovacion
      });
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('❌ WH checkout.session.completed (upgrade_delta):', e);
    return res.status(200).json({ received: true });
  }
}





  return res.json({ received: true });
};




