const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const PlanesPersonalizadosStripe = require('../models/planes_personalizados_stripe.model');
const { db } = require('../database/config');

// === NUEVO === id interno de tu plan LITE en la BD
const LITE_PLAN_ID = 6; // ajusta si en tu BD es otro id

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

  // ─────────────────────────────────────────────────────────────
  // Guard: LITE-FREE oculto (tu lógica existente)
  // ─────────────────────────────────────────────────────────────
  try {
    const li = invoice.lines?.data?.[0] || null;
    const priceId = li?.price?.id || null;

    let hidden = priceId === 'price_1SAb5GRwAlJ5h5wg3dEb69Zs';

    if (!hidden && invoice.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        if (sub?.metadata?.hidden_ui === 'true' || sub?.metadata?.special_plan === 'lite_free') {
          hidden = true;
        }
      } catch (_) {}
    }

    if (hidden) {
      await db.query(`
        UPDATE transacciones_stripe_chat
        SET id_suscripcion = COALESCE(?, id_suscripcion),
            estado_suscripcion = COALESCE(?, estado_suscripcion),
            fecha = NOW()
        WHERE customer_id = ?
      `, { replacements: [invoice.subscription || null, invoice.status || 'paid', invoice.customer] });

      return res.status(200).json({ received: true });
    }
  } catch (e) {
    console.warn('[WH] lite_free guard (invoice):', e?.message);
  }

  // ─────────────────────────────────────────────────────────────
  // Dispatcher por metadata
  // ─────────────────────────────────────────────────────────────
  /* ==========================================================
   1) LITE (downgrade_fullswitch) — PAGO COMPLETO + SWAP DE SUB
   ========================================================== */
    try {
      // Mezclar metadata desde invoice + payment_intent (sin el puntito 🚫)
      let metaInv = { ...(invoice?.metadata || {}) };
      if (
        (!metaInv?.tipo || !metaInv?.subscription_id || !metaInv?.to_price_id || !metaInv?.id_usuario) &&
        invoice?.payment_intent
      ) {
        try {
          const pi = await stripe.paymentIntents.retrieve(invoice.payment_intent);
          if (pi?.metadata) {
            metaInv = { ...metaInv, ...pi.metadata };
          }
        } catch (e) {
          console.warn('[WH] No se pudo expandir payment_intent para metadata:', e?.raw?.message || e.message);
        }
      }

      if (metaInv?.tipo === 'downgrade_fullswitch') {
        try {
          const customerId     = invoice.customer;
          const subscriptionId = metaInv.subscription_id || null;
          const toPriceId      = metaInv.to_price_id || null;
          let   id_usuario     = Number(metaInv.id_usuario || 0) || null;
          const id_plan        = Number(metaInv.id_plan || LITE_PLAN_ID) || LITE_PLAN_ID;

          console.log('[WH][LITE] invoice.payment_succeeded → downgrade_fullswitch', {
            invoice_id: invoice.id, customerId, subscriptionId, toPriceId, id_usuario, id_plan
          });

          // Resolver id_usuario por customer si no vino
          if (!id_usuario && customerId) {
            const [u] = await db.query(`
              SELECT id_usuario
              FROM transacciones_stripe_chat
              WHERE customer_id = ?
              ORDER BY fecha DESC
              LIMIT 1
            `, { replacements: [customerId] });
            id_usuario = u?.[0]?.id_usuario || null;
            console.log('[WH][LITE] id_usuario resuelto por customer:', id_usuario);
          }

          if (!subscriptionId || !toPriceId || !id_usuario) {
            console.warn('[WH][LITE] FALTAN DATOS CRÍTICOS', { subscriptionId, toPriceId, id_usuario, customerId });
            return res.status(200).json({ received: true });
          }

          // 1) Obtener item de la suscripción y hacer swap → LITE (idempotente)
          const subBefore   = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
          const itemId      = subBefore?.items?.data?.[0]?.id;
          const beforePrice = subBefore?.items?.data?.[0]?.price?.id;

          if (!itemId) {
            console.warn('[WH][LITE] NO HAY itemId en la suscripción, no se puede hacer swap');
            return res.status(200).json({ received: true });
          }

          let subAfter = subBefore;
          if (beforePrice !== toPriceId) {
            subAfter = await stripe.subscriptions.update(subscriptionId, {
              items: [{ id: itemId, price: toPriceId }],
              proration_behavior: 'none',
              billing_cycle_anchor: 'now',
              cancel_at_period_end: false
            });
          }

          // Fechas alineadas al nuevo ciclo
          const fechaInicio = new Date();
          const fechaRenov  = subAfter?.current_period_end
            ? new Date(subAfter.current_period_end * 1000)
            : new Date(fechaInicio.getTime() + 30 * 24 * 60 * 60 * 1000);

          // 2) Actualizar usuarios_chat_center (ORM y, si no afecta filas, fallback SQL)
          try {
            const usuario = await Usuarios_chat_center.findByPk(id_usuario);
            const plan    = await Planes_chat_center.findByPk(id_plan, { attributes: ['id_plan','id_product_stripe'] });

            if (usuario) {
              const [affected] = await Usuarios_chat_center.update({
                id_plan: id_plan,
                fecha_inicio: fechaInicio,
                fecha_renovacion: fechaRenov,
                estado: 'activo',
                ...(plan?.id_product_stripe ? { id_product_stripe: plan.id_product_stripe } : {})
              }, { where: { id_usuario } });

              if (!affected) {
                await db.query(`
                  UPDATE usuarios_chat_center
                  SET id_plan = ?, fecha_inicio = ?, fecha_renovacion = ?, estado = 'activo'
                  WHERE id_usuario = ?
                `, { replacements: [id_plan, fechaInicio, fechaRenov, id_usuario] });
              }
            } else {
              console.warn('[WH][LITE] Usuario no encontrado en BD (no ORM update)');
              await db.query(`
                UPDATE usuarios_chat_center
                SET id_plan = ?, fecha_inicio = ?, fecha_renovacion = ?, estado = 'activo'
                WHERE id_usuario = ?
              `, { replacements: [id_plan, fechaInicio, fechaRenov, id_usuario] });
            }
          } catch (e) {
            console.warn('[WH][LITE] ORM update falló, hago fallback SQL:', e?.message);
            await db.query(`
              UPDATE usuarios_chat_center
              SET id_plan = ?, fecha_inicio = ?, fecha_renovacion = ?, estado = 'activo'
              WHERE id_usuario = ?
            `, { replacements: [id_plan, fechaInicio, fechaRenov, id_usuario] });
          }

          // 3) Persistencia de transacción (rellenar id_usuario si venía nulo)
          await db.query(`
            UPDATE transacciones_stripe_chat
            SET id_suscripcion = COALESCE(?, id_suscripcion),
                id_usuario = COALESCE(id_usuario, ?),
                estado_suscripcion = ?,
                fecha = NOW()
            WHERE customer_id = ?
          `, { replacements: [subscriptionId, id_usuario, subAfter?.status || 'active', customerId] });

          console.log('✅ [WH][LITE] COMPLETADO: swap + BD actualizada para usuario:', id_usuario);
          return res.status(200).json({ received: true });
        } catch (e) {
          console.error('❌ [WH][LITE] Error general en downgrade_fullswitch:', e);
          return res.status(200).json({ received: true }); // evita reintentos agresivos
        }
      }
    } catch (e) {
      console.error('❌ Dispatcher downgrade_fullswitch:', e);
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

    // 0) FREE TRIAL ESPECIAL: LITE-FREE (plan Lite id 6 con 12 meses)
    if (session.mode === 'subscription' && md.tipo === 'lite_free') {
      const id_usuario     = Number(md.id_usuario);
      const subscriptionId = session.subscription;
      const customerId     = session.customer;

      if (!id_usuario || !subscriptionId || !customerId) {
        return res.status(200).json({ received: true });
      }

      // Leer trial_end / status de la suscripción
      let trialEnd = null;
      let subStatus = 'trialing';
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        trialEnd  = sub?.trial_end ? new Date(sub.trial_end * 1000) : null;
        subStatus = sub?.status || subStatus;
      } catch (_) {}

      // Obtener datos del plan LITE (id=6) para id_product_stripe
      let planLite = null;
      try {
        planLite = await Planes_chat_center.findByPk(6, { attributes: ['id_plan','id_product_stripe'] });
      } catch (_) {}

      // Actualizar usuario: asignar plan 6 + marcar free_trial_used
      const hoy = new Date();
      const fechaRenov = trialEnd || new Date(hoy.getTime() + 365 * 24 * 60 * 60 * 1000);

      await Usuarios_chat_center.update({
        id_plan: 6,
        estado: 'activo',
        fecha_inicio: hoy,
        fecha_renovacion: fechaRenov,
        free_trial_used: 1,
        ...(planLite?.id_product_stripe ? { id_product_stripe: planLite.id_product_stripe } : {})
      }, { where: { id_usuario } });

      // Vincular/actualizar transacción
      const [ex] = await db.query(
        `SELECT id FROM transacciones_stripe_chat WHERE id_suscripcion = ? LIMIT 1`,
        { replacements: [subscriptionId] }
      );
      if (!ex?.length) {
        await db.query(`
          INSERT INTO transacciones_stripe_chat
            (id_usuario, id_suscripcion, customer_id, estado_suscripcion, fecha)
          VALUES (?, ?, ?, ?, NOW())
        `, { replacements: [id_usuario, subscriptionId, customerId, subStatus] });
      } else {
        await db.query(`
          UPDATE transacciones_stripe_chat
             SET id_usuario = COALESCE(id_usuario, ?),
                 customer_id = COALESCE(customer_id, ?),
                 estado_suscripcion = ?,
                 fecha = NOW()
           WHERE id_suscripcion = ?
        `, { replacements: [id_usuario, customerId, subStatus, subscriptionId] });
      }

      return res.status(200).json({ received: true });
    }

    // 0.5) Si viene marcado hidden_ui pero NO es lite_free → ignorar
    if (md && md.hidden_ui === 'true') {
      return res.status(200).json({ received: true });
    }

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
    if (session.mode === 'payment' && md.tipo === 'downgrade_fullswitch') {
      const customerId     = session.customer;
      const subscriptionId = md.subscription_id || null;
      const toPriceId      = md.to_price_id || null;
      let   id_usuario     = Number(md.id_usuario || 0) || null;
      const id_plan        = Number(md.id_plan || LITE_PLAN_ID) || LITE_PLAN_ID;

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

      if (!subscriptionId || !toPriceId || !id_usuario) {
        console.warn('[WH checkout.session.completed][LITE] faltan datos', { subscriptionId, toPriceId, id_usuario });
        return res.status(200).json({ received: true });
      }

      // 1) SWAP seguro (idempotente)
      const subBefore = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
      const itemId      = subBefore?.items?.data?.[0]?.id;
      const beforePrice = subBefore?.items?.data?.[0]?.price?.id;
      if (!itemId) return res.status(200).json({ received: true });

      let subAfter = subBefore;
      if (beforePrice !== toPriceId) {
        subAfter = await stripe.subscriptions.update(subscriptionId, {
          items: [{ id: itemId, price: toPriceId }],
          proration_behavior: 'none',
          billing_cycle_anchor: 'now',
          cancel_at_period_end: false
        });
      }

      const fechaInicio = new Date();
      const fechaRenov  = subAfter?.current_period_end
        ? new Date(subAfter.current_period_end * 1000)
        : new Date(fechaInicio.getTime() + 30 * 24 * 60 * 60 * 1000);

      // 2) Actualiza usuarios_chat_center (ORM o fallback SQL)
      try {
        const [rows] = await Usuarios_chat_center.update({
          id_plan: id_plan,
          fecha_inicio: fechaInicio,
          fecha_renovacion: fechaRenov,
          estado: 'activo'
        }, { where: { id_usuario } });

        if (!rows) {
          await db.query(`
            UPDATE usuarios_chat_center
            SET id_plan = ?, fecha_inicio = ?, fecha_renovacion = ?, estado = 'activo'
            WHERE id_usuario = ?
          `, { replacements: [id_plan, fechaInicio, fechaRenov, id_usuario] });
        }
      } catch {
        await db.query(`
          UPDATE usuarios_chat_center
          SET id_plan = ?, fecha_inicio = ?, fecha_renovacion = ?, estado = 'activo'
          WHERE id_usuario = ?
        `, { replacements: [id_plan, fechaInicio, fechaRenov, id_usuario] });
      }

      // 3) Persistir transacción
      await db.query(`
        UPDATE transacciones_stripe_chat
        SET id_suscripcion = COALESCE(?, id_suscripcion),
            id_usuario = COALESCE(id_usuario, ?),
            estado_suscripcion = ?,
            fecha = NOW()
        WHERE customer_id = ?
      `, { replacements: [subscriptionId, id_usuario, (subAfter?.status || 'active'), customerId] });

      console.log('✅ [WH checkout.session.completed][LITE] COMPLETADO');
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




