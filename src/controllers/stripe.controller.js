const Stripe = require('stripe');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

/**
 * Helpers
 */
const getUserById = async (id_usuario) => {
  const [[u]] = await db.query(
    `SELECT
        id_usuario,
        email_propietario,
        free_trial_used,
        promo_plan2_used,
        id_costumer,
        stripe_subscription_id,
        id_plan,
        estado,
        fecha_renovacion,
        trial_end,
        tipo_plan,
        permanente,
        stripe_subscription_status,
        cancel_at_period_end,
        cancel_at,
        canceled_at
     FROM usuarios_chat_center
     WHERE id_usuario = ?
     LIMIT 1`,
    { replacements: [id_usuario] },
  );

  return u || null;
};

const getPlanById = async (id_plan) => {
  const [[p]] = await db.query(
    `SELECT id_plan, nombre_plan, descripcion_plan, id_price, duracion_plan, precio_plan
     FROM planes_chat_center
     WHERE id_plan = ?
     LIMIT 1`,
    { replacements: [id_plan] },
  );
  return p || null;
};

/**
 *  Checkout Session - subscription
 * - Trial: 15 días SOLO si el usuario no lo ha usado (free_trial_used=0)
 */
exports.crearSesionPago = catchAsync(async (req, res, next) => {
  const { id_usuario, id_plan } = req.body;

  if (!id_usuario || !id_plan) {
    return next(new AppError('Faltan id_usuario o id_plan.', 400));
  }

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const plan = await getPlanById(id_plan);
  if (!plan || !plan.id_price) {
    return next(new AppError('Plan inválido o sin id_price en Stripe.', 400));
  }

  const CONEXION_PLAN_ID = Number(process.env.STRIPE_PLAN_CONEXION_ID || 2);

  // Trial elegible
  const eligibleTrial = Number(user.free_trial_used) === 0;
  const shouldApplyTrial =
    eligibleTrial && Number(id_plan) === CONEXION_PLAN_ID;
  const trialDays = shouldApplyTrial ? 15 : undefined;

  // Promo cupón (solo plan 2 y solo si el usuario no lo ha usado)
  const couponId = process.env.STRIPE_COUPON_PLAN2_FIRST_MONTH || 'MK4ojy0N';
  const canApplyPromo =
    Number(id_plan) === CONEXION_PLAN_ID &&
    Number(user.promo_plan2_used || 0) === 0 &&
    Number(user.free_trial_used || 0) === 0 &&
    Boolean(couponId);

  const successUrl = `${process.env.FRONT_SUCCESS_URL}`;
  const cancelUrl = process.env.FRONT_CANCEL_URL;

  const customerParam = user.id_costumer
    ? { customer: user.id_costumer }
    : { customer_email: user.email_propietario || undefined };

  const customerUpdateParam = user.id_costumer
    ? { customer_update: { address: 'auto', name: 'auto' } }
    : {};

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: plan.id_price, quantity: 1 }],

    ...customerParam,
    ...customerUpdateParam,

    client_reference_id: String(id_usuario),
    payment_method_collection: 'always',
    metadata: { id_usuario: String(id_usuario), id_plan: String(id_plan) },

    // Aplica cupón “una vez” (primer cobro) SIN tocar trial
    ...(canApplyPromo ? { discounts: [{ coupon: couponId }] } : {}),

    subscription_data: {
      ...(trialDays ? { trial_period_days: trialDays } : {}),
      metadata: { id_usuario: String(id_usuario), id_plan: String(id_plan) },
    },

    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return res.status(200).json({
    success: true,
    url: session.url,
    sessionId: session.id,
    trialApplied: !!trialDays,
    promoApplied: !!canApplyPromo,
  });
});

/**
 * Obtener suscripción activa (para MiPlan)
 * Retorna plan mezclando BD + (opcional) estado Stripe si existe subscription_id
 */
exports.obtenerSuscripcionActiva = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  if (!user.id_plan) {
    return res.status(200).json({
      success: true,
      plan: null,
      user_flags: {
        trial_eligible: Number(user.free_trial_used || 0) === 0,
        promo_plan2_used: Number(user.promo_plan2_used || 0),
        promo_plan2_eligible: Number(user.promo_plan2_used || 0) === 0,
      },
    });
  }

  const planDb = await getPlanById(user.id_plan);

  // Estado base desde BD
  let estadoFinal = (user.estado || 'inactivo').toLowerCase();
  let fechaRenovacion = user.fecha_renovacion || null;

  // Flags base desde BD (ya vienen del webhook)
  let stripeStatus = user.stripe_subscription_status || null;
  let cancelAtPeriodEnd = user.cancel_at_period_end ? 1 : 0;
  let cancelAt = user.cancel_at || null;
  let canceledAt = user.canceled_at || null;

  // Si existe subscription, consultamos Stripe para exactitud (opcional, pero usted lo tenía)
  if (user.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(
        user.stripe_subscription_id,
      );

      // status: active, trialing, past_due, canceled, unpaid...
      if (sub?.status) {
        stripeStatus = sub.status;

        if (sub.status === 'trialing') estadoFinal = 'activo';
        else if (sub.status === 'active') estadoFinal = 'activo';
        else if (sub.status === 'canceled') estadoFinal = 'cancelado';
        else if (sub.status === 'past_due' || sub.status === 'unpaid')
          estadoFinal = 'suspendido';
        else estadoFinal = (user.estado || 'inactivo').toLowerCase();
      }

      // flags
      cancelAtPeriodEnd = sub?.cancel_at_period_end ? 1 : 0;
      cancelAt = sub?.cancel_at ? new Date(sub.cancel_at * 1000) : cancelAt;
      canceledAt = sub?.canceled_at
        ? new Date(sub.canceled_at * 1000)
        : canceledAt;

      // current_period_end / trial_end
      if (sub?.current_period_end)
        fechaRenovacion = new Date(sub.current_period_end * 1000);
      else if (sub?.trial_end) fechaRenovacion = new Date(sub.trial_end * 1000);
    } catch (e) {
      console.warn('Stripe sub retrieve fail:', e?.message);
      // Si Stripe falla, usamos BD sin romper pantalla
    }
  }

  return res.status(200).json({
    success: true,
    plan: {
      id_plan: user.id_plan,
      nombre_plan: planDb?.nombre_plan || 'Plan',
      descripcion_plan: planDb?.descripcion_plan || '',
      estado: estadoFinal, // activo | suspendido | cancelado | vencido | inactivo
      fecha_renovacion: fechaRenovacion,

      // nuevos flags para frontend
      stripe_subscription_status: stripeStatus,
      cancel_at_period_end: cancelAtPeriodEnd,
      cancel_at: cancelAt,
      canceled_at: canceledAt,

      // extras
      tipo_plan: user.tipo_plan,
      permanente: user.permanente,
      free_trial_used: Number(user.free_trial_used || 0),
      trial_eligible: Number(user.free_trial_used || 0) === 0,
      promo_plan2_used: Number(user.promo_plan2_used || 0),
      promo_plan2_eligible: Number(user.promo_plan2_used || 0) === 0,
    },
  });
});

/**
 *  Facturas del usuario (para MiPlan)
 * Requiere customer id en usuarios_chat_center.id_costumer
 */
exports.facturasUsuario = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const customer = user.id_costumer; //  su columna real
  if (!customer) {
    return res.status(200).json({ success: true, data: [] });
  }

  const invoices = await stripe.invoices.list({
    customer,
    limit: 20,
  });

  const data = (invoices?.data || []).map((inv) => ({
    id: inv.id,
    created: inv.created,
    paid: inv.paid,
    amount_paid: inv.amount_paid,
    hosted_invoice_url: inv.hosted_invoice_url,
    invoice_pdf: inv.invoice_pdf,
    status: inv.status,
  }));

  return res.status(200).json({ success: true, data });
});

/**
 *  Portal Cliente (SaaS)
 * Facturas + Cancelación + Métodos + Cambios (según configuración del portal en Stripe)
 */
exports.portalCliente = catchAsync(async (req, res, next) => {
  const { id_usuario, return_url } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const customer = user.id_costumer; //  su columna real
  if (!customer) {
    return next(
      new AppError(
        'Usuario sin id_costumer (customer de Stripe). Sincronice el customer al crear la suscripción.',
        400,
      ),
    );
  }

  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: return_url || process.env.FRONT_PORTAL_RETURN_URL,
  });

  return res.status(200).json({ success: true, url: session.url });
});

/**
 *  Cancelar suscripción (opcional: si usa botón directo)
 */
exports.cancelarSuscripcion = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  if (!user.stripe_subscription_id) {
    return next(new AppError('Usuario no tiene stripe_subscription_id.', 400));
  }

  // Cancel al final del periodo actual (no corta de inmediato)
  const sub = await stripe.subscriptions.update(user.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  return res.status(200).json({
    success: true,
    message: 'Suscripción cancelada al final del periodo.',
    stripe_status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
  });
});

/**
 * (Opcional) Portal métodos - si quiere mantener endpoints específicos
 * Nota: Stripe recomienda usar SOLO portalCliente, pero esto lo dejo por compatibilidad con su front actual.
 */
exports.portalGestionMetodos = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user?.id_costumer)
    return next(new AppError('Usuario sin id_costumer.', 400));

  const session = await stripe.billingPortal.sessions.create({
    customer: user.id_costumer,
    return_url: process.env.FRONT_PORTAL_RETURN_URL,
  });

  return res.status(200).json({ success: true, url: session.url });
});

exports.portalAddPaymentMethod = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user?.id_costumer)
    return next(new AppError('Usuario sin id_costumer.', 400));

  const session = await stripe.billingPortal.sessions.create({
    customer: user.id_costumer,
    return_url: process.env.FRONT_PORTAL_RETURN_URL,
  });

  return res.status(200).json({ success: true, url: session.url });
});

exports.cambiarPlan = catchAsync(async (req, res, next) => {
  const { id_usuario, id_plan_nuevo } = req.body;

  if (!id_usuario || !id_plan_nuevo) {
    return next(new AppError('Faltan id_usuario o id_plan_nuevo.', 400));
  }

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  if (!user.stripe_subscription_id) {
    return next(new AppError('Usuario no tiene stripe_subscription_id.', 400));
  }

  const planActual = user.id_plan ? await getPlanById(user.id_plan) : null;
  const planNuevo = await getPlanById(id_plan_nuevo);

  if (!planNuevo?.id_price) {
    return next(new AppError('Plan nuevo inválido o sin id_price.', 400));
  }

  // Si ya está en ese plan, no hacer nada
  if (Number(user.id_plan) === Number(id_plan_nuevo)) {
    return res
      .status(200)
      .json({ success: true, message: 'Ya está en ese plan.' });
  }

  // Cargar suscripción real para tomar itemId y period_end
  let sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id, {
    expand: ['items.data.price'],
  });

  const subItem = sub.items?.data?.[0];
  if (!subItem?.id) {
    return next(new AppError('Suscripción sin subscription item.', 400));
  }

  const precioActual = Number(planActual?.precio_plan || 0);
  const precioNuevo = Number(planNuevo?.precio_plan || 0);

  const esUpgrade = precioNuevo > precioActual;
  const esDowngrade = precioNuevo < precioActual;

  // ===========================
  // si es UPGRADE y existe schedule por downgrade anterior,
  // libérelo para evitar "cambios fantasma" o conflictos futuros.
  // ===========================
  if (esUpgrade && sub.schedule) {
    try {
      await stripe.subscriptionSchedules.release(sub.schedule);

      // Releer suscripción ya sin schedule
      sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id, {
        expand: ['items.data.price'],
      });
    } catch (e) {
      console.log('[cambiarPlan] schedule release failed:', e?.message);
      // no rompemos, pero idealmente se libera
    }
  }

  // ===========================
  // MISMO PRECIO: cambio inmediato sin cobro
  // ===========================
  if (!esUpgrade && !esDowngrade) {
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: subItem.id, price: planNuevo.id_price }],
      proration_behavior: 'none',
      payment_behavior: 'allow_incomplete',
      metadata: {
        ...(sub.metadata || {}),
        id_plan: String(id_plan_nuevo),
        pending_plan_id: '',
        pending_change: '',
      },
    });

    await db.query(
      `UPDATE usuarios_chat_center
       SET id_plan = ?,
           pending_plan_id = NULL,
           pending_change = NULL,
           pending_effective_at = NULL
       WHERE id_usuario = ?`,
      { replacements: [id_plan_nuevo, id_usuario] },
    );

    const idPagoAudit = `plan_same_${user.stripe_subscription_id}_${Date.now()}_${id_usuario}_${user.id_plan}_${id_plan_nuevo}`;

    await db.query(
      `INSERT IGNORE INTO transacciones_stripe_chat
       (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      {
        replacements: [
          idPagoAudit,
          user.stripe_subscription_id,
          id_usuario,
          `plan_changed_same_price:${user.id_plan}->${id_plan_nuevo}`,
          user.id_costumer || null,
        ],
      },
    );

    return res.status(200).json({
      success: true,
      message: 'Plan cambiado (mismo precio). No hubo cobro.',
    });
  }

  // Guardar "pending" en BD (para trazabilidad)
  await db.query(
    `UPDATE usuarios_chat_center
     SET pending_plan_id = ?,
         pending_change = ?,
         pending_effective_at = ?
     WHERE id_usuario = ?`,
    {
      replacements: [
        id_plan_nuevo,
        esUpgrade ? 'upgrade' : 'downgrade',
        esUpgrade ? new Date() : new Date(sub.current_period_end * 1000),
        id_usuario,
      ],
    },
  );

  // ===========================
  // UPGRADE: cobrar YA (prorrateo)
  // ===========================
  if (esUpgrade) {
    const cortarTrial = sub.status === 'trialing';

    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: subItem.id, price: planNuevo.id_price }],
      proration_behavior: 'create_prorations',
      payment_behavior: 'default_incomplete',
      ...(cortarTrial ? { trial_end: 'now' } : {}),
      metadata: {
        ...(sub.metadata || {}),
        pending_plan_id: String(id_plan_nuevo),
        pending_change: 'upgrade',
      },
      expand: ['latest_invoice.payment_intent'],
    });

    const inv = await stripe.invoices.create({
      customer: updated.customer,
      subscription: updated.id,
      auto_advance: true,
      metadata: {
        id_usuario: String(id_usuario),
        pending_change: 'upgrade',
        pending_plan_id: String(id_plan_nuevo),
      },
    });

    const finalized = await stripe.invoices.finalizeInvoice(inv.id, {
      expand: ['payment_intent'],
    });

    try {
      await stripe.subscriptions.update(updated.id, {
        metadata: {
          ...(updated.metadata || {}),
          pending_invoice_id: finalized.id,
        },
      });
    } catch (e) {
      console.log(
        '[cambiarPlan] metadata pending_invoice_id failed:',
        e?.message,
      );
    }

    let paid = null;
    try {
      paid = await stripe.invoices.pay(finalized.id, {
        expand: ['payment_intent'],
      });
    } catch (e) {
      // si requiere SCA, no rompemos
    }

    const pi = paid?.payment_intent || finalized?.payment_intent || null;

    if (paid && paid.status === 'paid') {
      return res.status(200).json({
        success: true,
        actionRequired: false,
        subscription_id: updated.id,
        invoice_id: paid.id,
        message: 'Upgrade cobrado y aplicado exitósamente.',
      });
    }

    if (
      pi &&
      pi.client_secret &&
      ['requires_action', 'requires_payment_method'].includes(pi.status)
    ) {
      return res.status(200).json({
        success: true,
        actionRequired: true,
        payment_intent_client_secret: pi.client_secret,
        payment_intent_status: pi.status,
        subscription_id: updated.id,
        invoice_id: finalized.id,
        message:
          'Requiere confirmación bancaria (3DS) para completar el upgrade.',
      });
    }

    const refreshedInvoice = await stripe.invoices.retrieve(finalized.id);
    return res.status(200).json({
      success: true,
      actionRequired: true,
      subscription_id: updated.id,
      invoice_id: finalized.id,
      hosted_invoice_url: refreshedInvoice.hosted_invoice_url,
      message: 'Debe completar el pago para finalizar el upgrade.',
    });
  }

  // ===========================
  // DOWNGRADE: aplicar al CORTE usando Schedule
  // ===========================
  if (esDowngrade) {
    const periodEnd = sub.current_period_end;
    const currentPriceId = subItem.price?.id;

    // 1) Si ya tiene schedule, úselo. Si no, créelo.
    let scheduleId = sub.schedule;

    if (!scheduleId) {
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.id,
      });
      scheduleId = schedule.id;
    }

    // 2) Actualizar el schedule (2 fases)
    await stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: 'release',
      phases: [
        {
          start_date: sub.current_period_start,
          end_date: periodEnd,
          items: [{ price: currentPriceId, quantity: 1 }],
        },
        {
          start_date: periodEnd,
          items: [{ price: planNuevo.id_price, quantity: 1 }],
        },
      ],
      metadata: {
        pending_plan_id: String(id_plan_nuevo),
        pending_change: 'downgrade',
        id_usuario: String(id_usuario),
      },
    });

    return res.status(200).json({
      success: true,
      message:
        'Downgrade programado para el próximo corte. Se mantendrá el plan actual hasta esa fecha.',
      effective_at: new Date(periodEnd * 1000),
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Cambio solicitado.',
  });
});
