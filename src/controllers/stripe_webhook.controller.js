const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const PlanesPersonalizadosStripe = require('../models/planes_personalizados_stripe.model');
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

  // Activar usuario y actualizar fila usando customer

if (event.type === 'invoice.payment_succeeded') {
  const invoice = event.data.object;

  try {
      /* ────────────────────────────────────────────────────────────
         A) BRANCH: Upgrades por “delta” (Checkout mode: payment)
         Detectamos por metadata que enviaste en invoice_creation.invoice_data.metadata
         ──────────────────────────────────────────────────────────── */
      const metaInv = invoice?.metadata || {};
      if (metaInv?.tipo === 'upgrade_delta') {
        const customerId     = invoice.customer;
        const subscriptionId = metaInv.subscription_id || null;
        const toPriceId      = metaInv.to_price_id || null;
        let   id_usuario     = metaInv.id_usuario || null;
        const id_plan        = metaInv.id_plan || null;

        // Resolver id_usuario por customerId si no vino en metadata
        if (!id_usuario && customerId) {
          const [u] = await db.query(`
            SELECT id_usuario
            FROM transacciones_stripe_chat
            WHERE customer_id = ?
            ORDER BY fecha DESC
            LIMIT 1
          `, { replacements: [customerId] });
          id_usuario = u?.[0]?.id_usuario || null;
        }

        // 1) Actualizar la SUSCRIPCIÓN al nuevo price (sin prorratear de nuevo)
        if (subscriptionId && toPriceId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data'] });
          const itemId = sub?.items?.data?.[0]?.id;
          if (itemId) {
            await stripe.subscriptions.update(subscriptionId, {
              items: [{ id: itemId, price: toPriceId }],
              proration_behavior: 'none', // ya cobraste la diferencia
            });
          }
        }

        // 2) Promover el plan en tu DB (no tocar fechas para conservar el ciclo)
        if (id_usuario && id_plan) {
          const usuario = await Usuarios_chat_center.findByPk(id_usuario);
          const plan = await Planes_chat_center.findByPk(id_plan);
          if (usuario && plan) {
            await usuario.update({
              id_plan: plan.id_plan,
              id_product_stripe: plan.id_product_stripe,
              estado: 'activo',
            });
          }
        }

        // 3) Persistencia mínima en transacciones_stripe_chat
        await db.query(`
          UPDATE transacciones_stripe_chat
          SET id_suscripcion = COALESCE(?, id_suscripcion),
              estado_suscripcion = 'active',
              fecha = NOW()
          WHERE customer_id = ?
        `, { replacements: [subscriptionId || null, invoice.customer] });

        // Cortamos aquí: no ejecutar la rama de suscripciones normales
        return res.status(200).json({ received: true });
      }
      
      // ────────────────────────────────────────────────────────────
    // C) Plan PERSONALIZADO (NUEVO – guarda en tabla per-user)
    // ────────────────────────────────────────────────────────────
    if (metaInv?.tipo === 'personalizado') {
      const customerId      = invoice.customer;
      const id_usuario      = Number(metaInv.id_usuario);
      const id_plan_base    = Number(metaInv.id_plan || 5);
      const n_conexiones    = Number(metaInv.n_conexiones || 0);
      const max_subusuarios = Number(metaInv.max_subusuarios || metaInv.n_subusuarios || 0);

      await db.query(`
        INSERT INTO planes_personalizados_stripe
          (id_usuario, id_plan_base, n_conexiones, max_subusuarios)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          id_plan_base = VALUES(id_plan_base),
          n_conexiones = VALUES(n_conexiones),
          max_subusuarios = VALUES(max_subusuarios),
          updated_at = CURRENT_TIMESTAMP()
      `, { replacements: [id_usuario, id_plan_base, n_conexiones, max_subusuarios] });

      if (customerId && id_usuario) {
        await db.query(`
          UPDATE transacciones_stripe_chat
          SET id_usuario = COALESCE(id_usuario, ?), fecha = NOW()
          WHERE customer_id = ?
        `, { replacements: [id_usuario, customerId] });
      }

      return res.status(200).json({ received: true });
    }


      /* ────────────────────────────────────────────────────────────
         B) BRANCH: Suscripciones normales (mode: subscription)
         (Tu flujo original)
         ──────────────────────────────────────────────────────────── */
      const lineItem = invoice.lines?.data?.[0];

      // 1) Intenta obtener subscriptionId (varios fallbacks)
      let subscriptionId =
        lineItem?.parent?.subscription_item_details?.subscription
        || invoice.subscription
        || lineItem?.subscription_details?.subscription
        || lineItem?.subscription
        || null;

      const customerId = invoice.customer;

      if (!subscriptionId || !customerId) {
        console.warn('[WH] invoice.payment_succeeded: faltan subscriptionId/customerId', {
          invoiceId: invoice.id, subscriptionId, customerId
        });
        // No cortar el flujo: responde 200 para que Stripe no reintente
        return res.status(200).json({ received: true });
      }

      // 2) Intenta leer metadata desde la SUSCRIPCIÓN
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

      // 3) Si la sub sigue en trial o la invoice fue de $0, solo registra y sal
      if (subStatus === 'trialing' || (invoice.amount_paid || 0) === 0) {
        await db.query(`
          UPDATE transacciones_stripe_chat
          SET id_suscripcion = ?, estado_suscripcion = ?, fecha = NOW()
          WHERE customer_id = ?
        `, { replacements: [subscriptionId, subStatus, customerId] });
        return res.status(200).json({ received: true });
      }

      // 4) Fallback: metadata desde el lineItem (tu flujo actual)
      if (!id_usuario || !id_plan) {
        const md = lineItem?.metadata || {};
        id_usuario = id_usuario || md.id_usuario;
        id_plan    = id_plan    || md.id_plan;
      }

      // 5) Último fallback: resolver id_usuario por customer_id en tu tabla
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

      // 6) Si aún faltan datos críticos, al menos registra y sal
      if (!id_usuario || !id_plan) {
        console.warn('[WH] invoice.payment_succeeded: metadata incompleta', { id_usuario, id_plan, subscriptionId, customerId });
        await db.query(`
          UPDATE transacciones_stripe_chat
          SET id_suscripcion = ?, estado_suscripcion = ?, fecha = NOW()
          WHERE customer_id = ?
        `, { replacements: [subscriptionId, subStatus, customerId] });
        return res.status(200).json({ received: true });
      }

      // 7) Activar usuario en DB (tu lógica original: setea fechas y estado)
      const usuario = await Usuarios_chat_center.findByPk(id_usuario);
      const plan = await Planes_chat_center.findByPk(id_plan);
      if (!usuario || !plan) {
        console.warn('[WH] Usuario o plan no encontrado', { id_usuario, id_plan });
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

      // 8) Persistencia en tu tabla de transacciones
      await db.query(`
        UPDATE transacciones_stripe_chat 
        SET id_suscripcion = ?, id_usuario = ?, estado_suscripcion = ?, fecha = NOW()
        WHERE customer_id = ?
      `, { replacements: [subscriptionId, id_usuario, subStatus, customerId] });

      console.log(`invoice.payment_succeeded OK -> cust:${customerId} sub:${subscriptionId}`);
      return res.status(200).json({ received: true });

    } catch (error) {
      console.error('❌ invoice.payment_succeeded handler:', error);
      // Importante: responde 200 para evitar reintentos agresivos de Stripe
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
         SET estado = 'vencido', id_plan = NULL
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

// ➕ NUEVO: completar upgrade cuando se paga la diferencia en Checkout y free trial
if (event.type === 'checkout.session.completed') {
  const session = event.data.object;
  try {
    const md = session.metadata || {};

    // 1) FREE TRIAL vía Checkout (suscripción con trial: no cobra ahora)
    if (session.mode === 'subscription' && md.tipo === 'free_trial') {
      const id_usuario = Number(md.id_usuario);
      const planFinalId = Number(md.plan_final_id || md.id_plan); // fallback si usas otra clave
      const subscriptionId = session.subscription;
      const customerId = session.customer;

      // Traemos la suscripción para leer trial_end/status
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const trialEnd = sub?.trial_end ? new Date(sub.trial_end * 1000) : null;

      // Durante el trial, deja al usuario en plan FREE (id 1)
      const hoy = new Date();
      const fechaRenovacion = trialEnd || new Date(hoy.getTime() + 15 * 24 * 60 * 60 * 1000);

      await Usuarios_chat_center.update(
        {
          id_plan: 1,
          estado: 'activo',
          fecha_inicio: hoy,
          fecha_renovacion: fechaRenovacion,
          free_trial_used: 1
        },
        { where: { id_usuario } }
      );

      // Guarda/actualiza referencia de suscripción en tu tabla de transacciones
      // Evitar duplicado si ya existe esa suscripción
      const [ex] = await db.query(
        `SELECT id FROM transacciones_stripe_chat WHERE id_suscripcion = ? LIMIT 1`,
        { replacements: [subscriptionId] }
      );
      if (!ex?.length) {
        await db.query(`
          INSERT INTO transacciones_stripe_chat (id_usuario, id_suscripcion, customer_id, estado_suscripcion, fecha)
          VALUES (?, ?, ?, ?, NOW())
        `, { replacements: [id_usuario, subscriptionId, customerId, sub?.status || 'trialing'] });
      }
      // si ya existe, no hacemos nada


      return res.status(200).json({ received: true });
    }

    // 2) UPGRADE DELTA (pago único de diferencia) — tu lógica existente
    if (session.mode === 'payment' && md.tipo === 'upgrade_delta') {
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

      // Cambia al nuevo price SIN prorrateo (ya cobraste la diferencia)
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: toPriceId }],
        proration_behavior: 'none',
      });

      // Refleja en DB: cambia id_plan y reinicia fechas
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
          fecha_renovacion: nuevaFechaRenovacion,
        });
      }

      return res.status(200).json({ received: true });
    }

    // Si no es ninguno de los dos casos, respondemos 200 y seguimos
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('WH checkout.session.completed:', e);
    return res.status(200).json({ received: true });
  }
}


// ➕ ADDON conexión: pago único completado en Checkout
if (event.type === 'checkout.session.completed') {
  const session = event.data.object;
  try {
    const md = session?.metadata || {};
    if (session?.mode === 'payment' && md.tipo === 'addon_conexion') {
      const id_usuario = md.id_usuario;
      if (id_usuario) {
        await db.query(
          `UPDATE usuarios_chat_center
           SET conexiones_adicionales = COALESCE(conexiones_adicionales, 0) + 1
           WHERE id_usuario = ?`,
          { replacements: [id_usuario] }
        );
        console.log(`addon_conexion aplicado a id_usuario=${id_usuario} (+1 conexiones_adicionales)`);
      }
      return res.status(200).json({ received: true });
    }
  } catch (e) {
    console.error('WH addon_conexion (checkout.session.completed):', e);
    return res.status(200).json({ received: true });
  }
}


// ➕ Fallback: por si deseas basarte en el intent directo
if (event.type === 'payment_intent.succeeded') {
  const pi = event.data.object;
  try {
    const md = pi?.metadata || {};
    if (md.tipo === 'addon_conexion' && md.id_usuario) {
      await db.query(
        `UPDATE usuarios_chat_center
         SET conexiones_adicionales = COALESCE(conexiones_adicionales, 0) + 1
         WHERE id_usuario = ?`,
        { replacements: [md.id_usuario] }
      );
      console.log(`addon_conexion (PI) aplicado a id_usuario=${md.id_usuario} (+1 conexiones_adicionales)`);
      return res.status(200).json({ received: true });
    }
  } catch (e) {
    console.error('WH addon_conexion (payment_intent.succeeded):', e);
    return res.status(200).json({ received: true });
  }
}

  // 🔹 Registrar transacción addon_subusuario
  if (event.type === 'payment_intent.created') {
    const pi = event.data.object;
    const md = pi.metadata || {};

    if (md.tipo === 'addon_subusuario' && md.id_usuario && pi.customer) {
      try {
        await db.query(`
          INSERT INTO transacciones_stripe_chat (id_pago, customer_id, id_usuario, fecha)
          VALUES (?, ?, ?, NOW())
        `, { replacements: [pi.id, pi.customer, md.id_usuario] });

        console.log(`🟢 Transacción registrada para addon_subusuario: ${pi.id}`);
      } catch (err) {
        console.error('❌ Error registrando transacción addon_subusuario:', err);
      }
    }

    return res.status(200).json({ received: true });
  }

  // 🔹 Confirmación de compra addon_subusuario
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};

    if (md.tipo === 'addon_subusuario' && md.id_usuario) {
      try {
        await db.query(`
          UPDATE usuarios_chat_center
          SET subusuarios_adicionales = COALESCE(subusuarios_adicionales, 0) + 1
          WHERE id_usuario = ?
        `, { replacements: [md.id_usuario] });

        console.log(`✅ Subusuario adicional aplicado a id_usuario=${md.id_usuario}`);
      } catch (err) {
        console.error(`❌ Error aplicando addon_subusuario:`, err);
      }
    }

    return res.status(200).json({ received: true });
  }

  // 🔹 Fallback en caso de fallo en sesión pero éxito en pago
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const md = pi.metadata || {};

    if (md.tipo === 'addon_subusuario' && md.id_usuario) {
      try {
        await db.query(`
          UPDATE usuarios_chat_center
          SET subusuarios_adicionales = COALESCE(subusuarios_adicionales, 0) + 1
          WHERE id_usuario = ?
        `, { replacements: [md.id_usuario] });

        console.log(`✅ Subusuario adicional (fallback) aplicado a id_usuario=${md.id_usuario}`);
      } catch (err) {
        console.error(`❌ Error fallback addon_subusuario:`, err);
      }
    }

    return res.status(200).json({ received: true });
  }



  return res.json({ received: true });
};




