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
    `SELECT id_usuario, email_propietario, free_trial_used, id_costumer, stripe_subscription_id, id_plan, estado, fecha_renovacion, trial_end
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
     WHERE id_plan = ? AND activo = 1
     LIMIT 1`,
    { replacements: [id_plan] },
  );
  return p || null;
};

/**
 *  Checkout Session - subscription
 * - Trial: 15 días SOLO si el usuario no lo ha usado (free_trial_used=0)
 * - Usted puede forzar trial SOLO para plan Conexión si desea (abajo le dejo cómo)
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

  // Trial elegible (por BD)
  const eligibleTrial = Number(user.free_trial_used) === 0;

  /**
   *  OPCIÓN ACTIVA (SU CASO): Trial SOLO para Plan Conexión
   * - Si el usuario ya usó trial => no aplica
   * - Si el plan NO es Conexión (plan_id:2) => no aplica
   */
  const CONEXION_PLAN_ID = 2;
  const shouldApplyTrial =
    eligibleTrial && Number(id_plan) === CONEXION_PLAN_ID;

  /**
   *  OPCIÓN ALTERNATIVA : Trial para CUALQUIER plan de pago
   */
  // const shouldApplyTrial = eligibleTrial;

  const trialDays = shouldApplyTrial ? 15 : undefined;

  const successUrl = `${process.env.FRONT_SUCCESS_URL}`;
  const cancelUrl = process.env.FRONT_CANCEL_URL;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: plan.id_price, quantity: 1 }],

    customer_email: user.email_propietario || undefined,
    client_reference_id: String(id_usuario),

    //  Obligar tarjeta aunque haya trial
    payment_method_collection: 'always',

    metadata: { id_usuario: String(id_usuario), id_plan: String(id_plan) },
    subscription_data: {
      trial_period_days: trialDays,
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
  });
});

/**
 *  Obtener suscripción activa (para MiPlan)
 * Retorna plan mezclando BD + estado Stripe si existe subscription_id
 */
exports.obtenerSuscripcionActiva = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  // Si no tiene plan en BD, retornamos null para que el front muestre “sin plan”
  if (!user.id_plan) {
    return res.status(200).json({ success: true, plan: null });
  }

  const planDb = await getPlanById(user.id_plan);

  // Estado base desde BD
  let estadoFinal = user.estado || 'inactivo';
  let fechaRenovacion = user.fecha_renovacion || null;

  // Si existe subscription, consultamos Stripe para mayor exactitud
  if (user.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(
        user.stripe_subscription_id,
      );

      // status: active, trialing, past_due, canceled, unpaid...
      if (sub?.status) {
        if (sub.status === 'trialing')
          estadoFinal = 'activo'; // o "trial" si quiere
        else if (sub.status === 'active') estadoFinal = 'activo';
        else if (sub.status === 'canceled') estadoFinal = 'inactivo';
        else if (sub.status === 'past_due') estadoFinal = 'suspendido';
        else estadoFinal = user.estado || 'inactivo';
      }

      // current_period_end en segundos
      if (sub?.current_period_end) {
        fechaRenovacion = new Date(sub.current_period_end * 1000);
      } else if (sub?.trial_end) {
        fechaRenovacion = new Date(sub.trial_end * 1000);
      }
    } catch (e) {
      // si Stripe falla, no rompemos la pantalla
      console.warn('Stripe sub retrieve fail:', e?.message);
    }
  }

  return res.status(200).json({
    success: true,
    plan: {
      id_plan: user.id_plan,
      nombre_plan: planDb?.nombre_plan || 'Plan',
      descripcion_plan: planDb?.descripcion_plan || '',
      estado: estadoFinal,
      fecha_renovacion: fechaRenovacion,
      tipo_plan: user.tipo_plan,
      permanente: user.permanente,
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
