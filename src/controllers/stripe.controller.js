const Stripe = require('stripe');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

//Selección automática de variables por entorno (production vs test)
const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// Helper: lee la variable PROD si existe, si no usa TEST; en no-prod prioriza TEST.
const envPick = (prodKey, testKey, fallback = '') => {
  const prodVal = process.env[prodKey];
  const testVal = process.env[testKey];

  if (isProd) return prodVal ?? fallback; // prod => PROD
  return testVal ?? prodVal ?? fallback; // dev/test => TEST (si no, PROD)
};

/**
 * Variables Stripe según entorno
 * - En producción: STRIPE_SECRET_KEY
 * - En no-producción: STRIPE_SECRET_KEY_TEST (y si falta, cae a STRIPE_SECRET_KEY)
 */
const STRIPE_SECRET = envPick('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST');

//Cupones por entorno
const COUPON_PLAN2 = envPick(
  'STRIPE_COUPON_PLAN2_FIRST_MONTH',
  'STRIPE_COUPON_PLAN2_FIRST_MONTH_TEST',
);
const COUPON_PLAN3 = envPick(
  'STRIPE_COUPON_PLAN3_FIRST_MONTH',
  'STRIPE_COUPON_PLAN3_FIRST_MONTH_TEST',
);
const COUPON_PLAN4 = envPick(
  'STRIPE_COUPON_PLAN4_FIRST_MONTH',
  'STRIPE_COUPON_PLAN4_FIRST_MONTH_TEST',
);

// URLs por entorno
const FRONT_SUCCESS_URL = envPick(
  'FRONT_SUCCESS_URL',
  'FRONT_SUCCESS_URL_TEST',
);
const FRONT_CANCEL_URL = envPick('FRONT_CANCEL_URL', 'FRONT_CANCEL_URL_TEST');

const STRIPE_PLAN_CONEXION_ID = Number(
  envPick('STRIPE_PLAN_CONEXION_ID', 'STRIPE_PLAN_CONEXION_ID_TEST'),
);

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

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
 * - Trial: 15 días SOLO si el usuario no lo ha usado (free_trial_used=0) en el id_plan 2
 * - Cupon de descuento: $5 por el primer mes en cualquier plan, solo se puede utilizar 1 vez.
 */
exports.crearSesionPago = catchAsync(async (req, res, next) => {
  const { id_usuario, id_plan, id_plataforma = null } = req.body;

  if (!id_usuario || !id_plan) {
    return next(new AppError('Faltan id_usuario o id_plan.', 400));
  }

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const plan = await getPlanById(id_plan);
  if (!plan || !plan.id_price) {
    return next(new AppError('Plan inválido o sin id_price en Stripe.', 400));
  }

  const CONEXION_PLAN_ID = STRIPE_PLAN_CONEXION_ID;
  // =========================
  // 1) TRIAL (solo Plan 2)
  // =========================
  const eligibleTrial = Number(user.free_trial_used || 0) === 0;
  const shouldApplyTrial =
    eligibleTrial && Number(id_plan) === CONEXION_PLAN_ID;
  const trialDays = shouldApplyTrial ? 15 : undefined;

  // =========================
  // 2) PROMO $5 PRIMER MES (planes 2,3,4) UNA SOLA VEZ TOTAL
  //    - Se controla con promo_plan2_used como "promo_5_used"
  //// IMPORTANTE: Promo $5: marcar promo_plan2_used SOLO si hubo descuento real en test (planes 16/17/18)
  // =========================
  const PROMO_PLANS = new Set([2, 3, 4]);

  const couponByPlan = {
    2: COUPON_PLAN2,
    3: COUPON_PLAN3,
    4: COUPON_PLAN4,
  };

  const isPromoPlan = PROMO_PLANS.has(Number(id_plan));
  const couponId = couponByPlan[Number(id_plan)] || null;

  const promoNotUsedYet = Number(user.promo_plan2_used || 0) === 0; // <-- bandera global
  const canApplyPromo = isPromoPlan && promoNotUsedYet && Boolean(couponId);

  // =========================
  // URLs + customer params
  // =========================
  const successUrl = `${FRONT_SUCCESS_URL}`;
  const cancelUrl = FRONT_CANCEL_URL;

  const customerParam = user.id_costumer
    ? { customer: user.id_costumer }
    : { customer_email: user.email_propietario || undefined };

  const customerUpdateParam = user.id_costumer
    ? { customer_update: { address: 'auto', name: 'auto' } }
    : {};

  // metadata común
  const meta = {
    id_usuario: String(id_usuario),
    id_plan: String(id_plan),
    id_plataforma: id_plataforma ? String(id_plataforma) : '',
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: plan.id_price, quantity: 1 }],

    ...customerParam,
    ...customerUpdateParam,

    client_reference_id: String(id_usuario),
    payment_method_collection: 'always',

    metadata: meta,

    // Promo $5 (cupón "once") — se aplica si está habilitado para el usuario
    ...(canApplyPromo ? { discounts: [{ coupon: couponId }] } : {}),

    subscription_data: {
      // Trial solo si aplica (Plan 2 y elegible)
      ...(trialDays ? { trial_period_days: trialDays } : {}),

      metadata: meta,
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

// Helper: escoger la suscripción "vigente" de Stripe para este customer
const pickCurrentStripeSubscription = async (customerId) => {
  if (!customerId) return null;

  // Traemos varias para poder elegir correctamente
  const list = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
  });

  const subs = list?.data || [];
  if (!subs.length) return null;

  // Priorización:
  // 1) active/trialing
  // 2) si no hay, past_due (por si quiere mostrar suspendido)
  // 3) si no hay, la más reciente
  const preferredStatuses = ['active', 'trialing', 'past_due'];
  for (const st of preferredStatuses) {
    const found = subs
      .filter((s) => s.status === st)
      .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    if (found) return found;
  }

  return subs.sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;
};

/**
/**
 * Obtener suscripción activa (para MiPlan)
 * Retorna plan mezclando BD + estado Stripe.
 * Robustez: si en BD quedó una suscripción cancelada/incorrecta y el customer tiene otra activa,
 * se elige automáticamente la vigente (active/trialing/past_due) y se sincroniza a BD.
 */
exports.obtenerSuscripcionActiva = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  // Si el usuario no tiene plan, devolvemos null + flags
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

  // Flags base desde BD (vienen del webhook o BD)
  let stripeStatus = user.stripe_subscription_status || null;
  let cancelAtPeriodEnd = user.cancel_at_period_end ? 1 : 0;
  let cancelAt = user.cancel_at || null;
  let canceledAt = user.canceled_at || null;

  /**
   * Stripe Resolution:
   * - Si existe stripe_subscription_id, intentamos retrieve.
   * - Si está cancelada/no existe y tenemos customer, buscamos la "vigente" (helper del usuario).
   * - Si encontramos una distinta, sincronizamos BD para evitar futuros errores.
   */
  let sub = null;

  // 1) Retrieve por el id guardado en BD (si existe)
  if (user.stripe_subscription_id) {
    try {
      sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
    } catch (e) {
      console.warn('Stripe sub retrieve fail:', e?.message);
      sub = null;
    }
  }

  // 2) Si la suscripción recuperada es mala/incorrecta, resolvemos por customer (si existe)
  const statusBad =
    !sub ||
    ['canceled', 'unpaid'].includes(String(sub.status || '').toLowerCase());

  if (statusBad && user.id_costumer) {
    try {
      // Helper (ya lo creó usted): debe devolver la suscripción vigente del customer
      // Ej: active/trialing; si no existe, puede devolver past_due o la más reciente.
      const picked = await pickCurrentStripeSubscription(user.id_costumer);

      if (picked) {
        sub = picked;

        // Sincronizar BD si difiere (para que la próxima consulta ya sea correcta)
        if (
          user.stripe_subscription_id !== sub.id ||
          user.stripe_subscription_status !== sub.status
        ) {
          try {
            await db.query(
              `UPDATE usuarios_chat_center
               SET stripe_subscription_id = ?,
                   stripe_subscription_status = ?,
                   cancel_at_period_end = ?,
                   cancel_at = ?,
                   canceled_at = ?
               WHERE id_usuario = ?
               LIMIT 1`,
              {
                replacements: [
                  sub.id,
                  sub.status,
                  sub.cancel_at_period_end ? 1 : 0,
                  sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
                  sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
                  id_usuario,
                ],
              },
            );
          } catch (e) {
            console.warn(
              'DB sync stripe_subscription_id/status fail:',
              e?.message,
            );
          }
        }
      }
    } catch (e) {
      console.warn('Stripe pick current subscription fail:', e?.message);
    }
  }

  // 3) Si tenemos sub válida, ajustamos estado/fechas/flags desde Stripe
  if (sub?.status) {
    stripeStatus = sub.status;

    // status: active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused...
    if (sub.status === 'trialing' || sub.status === 'active')
      estadoFinal = 'activo';
    else if (sub.status === 'canceled') estadoFinal = 'cancelado';
    else if (sub.status === 'past_due' || sub.status === 'unpaid')
      estadoFinal = 'suspendido';
    else estadoFinal = (user.estado || 'inactivo').toLowerCase();

    // flags
    cancelAtPeriodEnd = sub?.cancel_at_period_end ? 1 : 0;
    cancelAt = sub?.cancel_at ? new Date(sub.cancel_at * 1000) : null;
    canceledAt = sub?.canceled_at ? new Date(sub.canceled_at * 1000) : null;

    // Fechas (period_end o trial_end)
    if (sub?.current_period_end)
      fechaRenovacion = new Date(sub.current_period_end * 1000);
    else if (sub?.trial_end) fechaRenovacion = new Date(sub.trial_end * 1000);

    // Si está cancelada de forma inmediata (no al final del periodo), no tiene sentido mostrar "renovación"
    // (evita confusiones en frontend)
    if (sub.status === 'canceled' && !sub.cancel_at_period_end) {
      fechaRenovacion = null;
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

      // flags para frontend
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
    return_url: return_url || FRONT_SUCCESS_URL,
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
    return_url: FRONT_SUCCESS_URL,
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
    return_url: FRONT_SUCCESS_URL,
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

    // 1) Actualiza la suscripción y pide que expanda latest_invoice + payment_intent
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

    const latestInvoice = updated.latest_invoice;

    if (!latestInvoice || !latestInvoice.id) {
      return res.status(400).json({
        success: false,
        message:
          'No se pudo generar la factura de prorrateo para el upgrade. Intente nuevamente.',
      });
    }

    // 2) Verifique monto (su regla: debe haber cobro real)
    const invoiceTotal = Number(latestInvoice.total || 0);
    const invoiceAmountDue = Number(latestInvoice.amount_due || 0);

    // Si Stripe todavía no calculó totales en el objeto expandido, recargue
    const invFresh = await stripe.invoices.retrieve(latestInvoice.id, {
      expand: ['payment_intent'],
    });

    console.log('[upgrade] invoice debug:', {
      id: invFresh.id,
      total: invFresh.total,
      amount_due: invFresh.amount_due,
      amount_paid: invFresh.amount_paid,
      starting_balance: invFresh.starting_balance,
      ending_balance: invFresh.ending_balance,
      customer_balance: invFresh.customer_balance,
      lines: (invFresh.lines?.data || []).map((l) => ({
        amount: l.amount,
        proration: l.proration,
        description: l.description,
        price: l.price?.id,
      })),
    });

    const totalFresh = Number(invFresh.total || 0);
    const dueFresh = Number(invFresh.amount_due || 0);

    if (totalFresh <= 0 || dueFresh <= 0) {
      // Regla de negocio: no hay cobro => NO se permite upgrade
      // (Opcional) revertir el price al anterior para no dejarlo “medio aplicado”
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: subItem.id, price: subItem.price.id }],
        proration_behavior: 'none',
        payment_behavior: 'allow_incomplete',
        metadata: {
          ...(sub.metadata || {}),
          pending_plan_id: '',
          pending_change: '',
          pending_invoice_id: '',
        },
      });

      await db.query(
        `UPDATE usuarios_chat_center
       SET pending_plan_id = NULL,
           pending_change = NULL,
           pending_effective_at = NULL
       WHERE id_usuario = ?`,
        { replacements: [id_usuario] },
      );

      return res.status(400).json({
        success: false,
        message:
          'No se pudo generar un cobro inmediato para el upgrade (importe $0). Revise saldo/créditos del cliente o intente nuevamente.',
      });
    }

    // 3) Guardar la invoice que DEBE gatillar el upgrade en el webhook
    try {
      await stripe.subscriptions.update(updated.id, {
        metadata: {
          ...(updated.metadata || {}),
          pending_invoice_id: invFresh.id,
        },
      });
    } catch (e) {
      console.log(
        '[cambiarPlan] metadata pending_invoice_id failed:',
        e?.message,
      );
    }

    // 4) Intentar cobrar
    let paid = null;
    try {
      paid = await stripe.invoices.pay(invFresh.id, {
        expand: ['payment_intent'],
      });
    } catch (e) {
      // requiere SCA, no rompemos
    }

    const pi = paid?.payment_intent || invFresh?.payment_intent || null;

    if (paid && paid.status === 'paid') {
      return res.status(200).json({
        success: true,
        actionRequired: false,
        subscription_id: updated.id,
        invoice_id: paid.id,
        message: 'Upgrade cobrado y aplicado exitosamente.',
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
        invoice_id: invFresh.id,
        message:
          'Requiere confirmación bancaria (3DS) para completar el upgrade.',
      });
    }

    // Fallback: hosted_invoice_url
    const invForUrl = await stripe.invoices.retrieve(invFresh.id);
    return res.status(200).json({
      success: true,
      actionRequired: true,
      subscription_id: updated.id,
      invoice_id: invFresh.id,
      hosted_invoice_url: invForUrl.hosted_invoice_url,
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
