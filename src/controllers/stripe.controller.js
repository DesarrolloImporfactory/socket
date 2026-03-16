const Stripe = require('stripe');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

// ─────────────────────────────────────────────────────────────
// Selección automática de variables por entorno
// ─────────────────────────────────────────────────────────────
const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const envPick = (prodKey, testKey, fallback = '') => {
  const prodVal = process.env[prodKey];
  const testVal = process.env[testKey];
  if (isProd) return prodVal ?? fallback;
  return testVal ?? prodVal ?? fallback;
};

/**
 * Variables Stripe según entorno
 * - En producción: STRIPE_SECRET_KEY
 * - En no-producción: STRIPE_SECRET_KEY_TEST (y si falta, cae a STRIPE_SECRET_KEY)
 */
const STRIPE_SECRET = envPick('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST');

// Cupones por plan y entorno
const COUPON_PLAN_IL = envPick(
  'STRIPE_COUPON_IL_FIRST_MONTH',
  'STRIPE_COUPON_IL_FIRST_MONTH_TEST',
);
const COUPON_PLAN_IC = envPick(
  'STRIPE_COUPON_PLAN2_FIRST_MONTH',
  'STRIPE_COUPON_PLAN2_FIRST_MONTH_TEST',
);
const COUPON_PLAN_PRO = envPick(
  'STRIPE_COUPON_PLAN3_FIRST_MONTH',
  'STRIPE_COUPON_PLAN3_FIRST_MONTH_TEST',
);
const COUPON_PLAN_ADV = envPick(
  'STRIPE_COUPON_PLAN4_FIRST_MONTH',
  'STRIPE_COUPON_PLAN4_FIRST_MONTH_TEST',
);

// URLs
const FRONT_SUCCESS_URL = envPick(
  'FRONT_SUCCESS_URL',
  'FRONT_SUCCESS_URL_TEST',
);
const FRONT_CANCEL_URL = envPick('FRONT_CANCEL_URL', 'FRONT_CANCEL_URL_TEST');

// IDs de planes por entorno
const PLAN_IL_ID = Number(
  envPick('STRIPE_PLAN_IL_ID', 'STRIPE_PLAN_IL_ID_TEST', '6'),
);
const PLAN_IC_ID = Number(
  envPick('STRIPE_PLAN_CONEXION_ID', 'STRIPE_PLAN_CONEXION_ID_TEST', '2'),
);

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

// ─────────────────────────────────────────────────────────────
// Configuración de planes (ecosistema)
// ─────────────────────────────────────────────────────────────

// Trial por días: solo ImporChat (7 días)
const TRIAL_DAYS = 7;

// Trial por uso: solo Insta Landing (10 imágenes gratis, sin tarjeta)
const IL_TRIAL_IMAGES = 10;

// Promo $5 primer mes: todos los planes pagos (IL, IC, Pro, Avanzado)
const PROMO_FIRST_MONTH_PRICE = 5;

// Mapeo plan_id → cupón Stripe
const getCouponByPlan = (idPlan) => {
  const num = Number(idPlan);
  const map = {
    [PLAN_IL_ID]: COUPON_PLAN_IL,
    [PLAN_IC_ID]: COUPON_PLAN_IC,
  };

  // Para planes Pro y Avanzado, usar IDs fijos (prod: 3/4, test: 17/18)
  if (isProd) {
    map[3] = COUPON_PLAN_PRO;
    map[4] = COUPON_PLAN_ADV;
  } else {
    map[17] = COUPON_PLAN_PRO;
    map[18] = COUPON_PLAN_ADV;
  }

  return map[num] || null;
};

// Set de planes que aplican promo $5 primer mes
const getPromoPlans = () => {
  if (isProd) return new Set([PLAN_IL_ID, PLAN_IC_ID, 3, 4]);
  return new Set([PLAN_IL_ID, PLAN_IC_ID, 17, 18]);
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const getUserById = async (id_usuario) => {
  const [[u]] = await db.query(
    `SELECT
        id_usuario,
        email_propietario,
        free_trial_used,
        promo_plan2_used,
        il_trial_used,
        il_imagenes_usadas,
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
    `SELECT id_plan, nombre_plan, descripcion_plan, id_price, duracion_plan, precio_plan,
            tools_access, trial_type, trial_value,
            max_banners_mes, max_angulos_ia, max_imagenes_ia,
            max_secciones_landing, max_estilos_visuales, max_productos_dropi,
            max_agentes_whatsapp, landing_whatsapp_link, ab_testing, bot_entrenado,
            analytics_nivel, max_subcuentas, soporte_nivel,
            multi_numero_whatsapp, bulk_gen_productos, estilos_custom, secciones_custom,
            sort_order
     FROM planes_chat_center
     WHERE id_plan = ?
     LIMIT 1`,
    { replacements: [id_plan] },
  );
  return p || null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// NUEVO: Activar Trial por Uso (Insta Landing)
// ─────────────────────────────────────────────────────────────
// El usuario NO paga. Se le asigna el plan IL con estado 'trial_usage'.
// Puede generar hasta IL_TRIAL_IMAGES imágenes gratis.
// Cuando se le acaban → frontend lo lleva a checkout.
// ─────────────────────────────────────────────────────────────
exports.activarTrialUsage = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  // Si ya tiene plan activo, no puede activar trial
  const estadoActual = (user.estado || '').toLowerCase();
  const tieneActivo =
    estadoActual.includes('activo') || estadoActual.includes('trial');
  if (user.id_plan && tieneActivo) {
    return res.status(400).json({
      success: false,
      message: 'Ya tiene un plan activo. No puede activar la prueba gratuita.',
    });
  }

  // Si ya usó el trial de IL, no puede de nuevo
  if (Number(user.il_trial_used) === 1) {
    return res.status(400).json({
      success: false,
      message: 'Ya utilizó su prueba gratuita de Insta Landing.',
      il_trial_used: true,
    });
  }

  // Activar trial: asignar plan IL con estado trial_usage
  await db.query(
    `UPDATE usuarios_chat_center
     SET id_plan = ?,
         estado = 'trial_usage',
         il_trial_used = 1,
         il_imagenes_usadas = 0
     WHERE id_usuario = ?`,
    { replacements: [PLAN_IL_ID, id_usuario] },
  );

  return res.status(200).json({
    success: true,
    message: `Prueba gratuita activada. Puede generar hasta ${IL_TRIAL_IMAGES} imágenes.`,
    plan_id: PLAN_IL_ID,
    imagenes_disponibles: IL_TRIAL_IMAGES,
  });
});

// ─────────────────────────────────────────────────────────────
// NUEVO: Verificar/Incrementar uso de trial IL
// ─────────────────────────────────────────────────────────────
// Llamar desde el endpoint de generación de imágenes ANTES de generar.
// Retorna { allowed: true/false, remaining: N }
// ─────────────────────────────────────────────────────────────
exports.verificarTrialUsage = catchAsync(async (req, res, next) => {
  const { id_usuario, incrementar = false } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const estado = (user.estado || '').toLowerCase();

  // Si no está en trial_usage, no aplica este endpoint
  if (estado !== 'trial_usage') {
    return res.status(200).json({
      success: true,
      allowed: true,
      is_trial: false,
      message: 'Usuario no está en trial por uso.',
    });
  }

  const usadas = Number(user.il_imagenes_usadas || 0);
  const limite = IL_TRIAL_IMAGES;
  const remaining = Math.max(0, limite - usadas);

  if (remaining <= 0) {
    return res.status(200).json({
      success: true,
      allowed: false,
      is_trial: true,
      remaining: 0,
      message: 'Prueba gratuita agotada. Debe suscribirse para continuar.',
      redirect_to_checkout: true,
    });
  }

  // Si pide incrementar (cuando efectivamente se genera una imagen)
  if (incrementar) {
    await db.query(
      `UPDATE usuarios_chat_center
       SET il_imagenes_usadas = il_imagenes_usadas + 1
       WHERE id_usuario = ?`,
      { replacements: [id_usuario] },
    );

    const newRemaining = remaining - 1;
    return res.status(200).json({
      success: true,
      allowed: true,
      is_trial: true,
      remaining: newRemaining,
      message:
        newRemaining > 0
          ? `Imagen generada. Le quedan ${newRemaining} de ${limite}.`
          : 'Última imagen gratuita generada. Debe suscribirse para continuar.',
      redirect_to_checkout: newRemaining <= 0,
    });
  }

  return res.status(200).json({
    success: true,
    allowed: true,
    is_trial: true,
    remaining,
  });
});

// ─────────────────────────────────────────────────────────────
// Checkout Session (subscription)
// ─────────────────────────────────────────────────────────────
// - IL ($29): NO trial Stripe (trial es por uso en app). Promo $5.
// - IC ($29): Trial 7 días + Promo $5 primer cobro.
// - Pro ($59): Promo $5 primer mes.
// - Avanzado ($99): Promo $5 primer mes.
// ─────────────────────────────────────────────────────────────
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

  // =========================
  // 1) TRIAL por días: solo ImporChat, solo si no ha usado trial
  // =========================
  const isICPlan = Number(id_plan) === PLAN_IC_ID;
  const eligibleTrial = Number(user.free_trial_used || 0) === 0;
  const shouldApplyTrial = eligibleTrial && isICPlan;
  const trialDays = shouldApplyTrial ? TRIAL_DAYS : undefined;

  // =========================
  // 2) PROMO $5 PRIMER MES (todos los planes) — 1 sola vez global
  // =========================
  const PROMO_PLANS = getPromoPlans();
  const isPromoPlan = PROMO_PLANS.has(Number(id_plan));
  const couponId = getCouponByPlan(id_plan);
  const promoNotUsedYet = Number(user.promo_plan2_used || 0) === 0;
  const canApplyPromo = isPromoPlan && promoNotUsedYet && Boolean(couponId);

  // =========================
  // URLs + customer
  // =========================
  const successUrl = FRONT_SUCCESS_URL;
  const cancelUrl = FRONT_CANCEL_URL;

  const customerParam = user.id_costumer
    ? { customer: user.id_costumer }
    : { customer_email: user.email_propietario || undefined };

  const customerUpdateParam = user.id_costumer
    ? { customer_update: { address: 'auto', name: 'auto' } }
    : {};

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

    // Promo $5 primer mes
    ...(canApplyPromo ? { discounts: [{ coupon: couponId }] } : {}),

    subscription_data: {
      // Trial solo si aplica (IC y elegible)
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

// ─────────────────────────────────────────────────────────────
// Obtener suscripción activa (para MiPlan / PlanesView)
// ─────────────────────────────────────────────────────────────
const pickCurrentStripeSubscription = async (customerId) => {
  if (!customerId) return null;
  const list = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
  });
  const subs = list?.data || [];
  if (!subs.length) return null;

  const preferredStatuses = ['active', 'trialing', 'past_due'];
  for (const st of preferredStatuses) {
    const found = subs
      .filter((s) => s.status === st)
      .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    if (found) return found;
  }
  return subs.sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;
};

exports.obtenerSuscripcionActiva = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  // Flags comunes
  const userFlags = {
    trial_eligible: Number(user.free_trial_used || 0) === 0,
    promo_plan2_used: Number(user.promo_plan2_used || 0),
    promo_plan2_eligible: Number(user.promo_plan2_used || 0) === 0,
    il_trial_used: Number(user.il_trial_used || 0) === 1,
    il_imagenes_usadas: Number(user.il_imagenes_usadas || 0),
    il_imagenes_limite: IL_TRIAL_IMAGES,
  };

  // Sin plan asignado
  if (!user.id_plan) {
    return res.status(200).json({
      success: true,
      plan: null,
      user_flags: userFlags,
    });
  }

  const planDb = await getPlanById(user.id_plan);

  let estadoFinal = (user.estado || 'inactivo').toLowerCase();
  let fechaRenovacion = user.fecha_renovacion || null;
  let stripeStatus = user.stripe_subscription_status || null;
  let cancelAtPeriodEnd = user.cancel_at_period_end ? 1 : 0;
  let cancelAt = user.cancel_at || null;
  let canceledAt = user.canceled_at || null;

  // Si estado es trial_usage (IL), no hay suscripción Stripe
  if (estadoFinal === 'trial_usage') {
    return res.status(200).json({
      success: true,
      plan: {
        id_plan: user.id_plan,
        nombre_plan: planDb?.nombre_plan || 'Insta Landing',
        descripcion_plan: planDb?.descripcion_plan || '',
        estado: 'trial_usage',
        fecha_renovacion: null,
        stripe_subscription_status: null,
        cancel_at_period_end: 0,
        cancel_at: null,
        canceled_at: null,
        tipo_plan: user.tipo_plan,
        permanente: user.permanente,
        free_trial_used: Number(user.free_trial_used || 0),
        trial_eligible: Number(user.free_trial_used || 0) === 0,
        promo_plan2_used: Number(user.promo_plan2_used || 0),
        promo_plan2_eligible: Number(user.promo_plan2_used || 0) === 0,
        // Info trial usage
        trial_type: 'usage',
        il_imagenes_usadas: Number(user.il_imagenes_usadas || 0),
        il_imagenes_limite: IL_TRIAL_IMAGES,
        il_imagenes_restantes: Math.max(
          0,
          IL_TRIAL_IMAGES - Number(user.il_imagenes_usadas || 0),
        ),
        // Datos del plan
        tools_access: planDb?.tools_access || 'insta_landing',
        ...(planDb || {}),
      },
      user_flags: userFlags,
    });
  }

  // ─── Stripe Resolution (mismo flujo que antes) ───
  let sub = null;

  if (user.stripe_subscription_id) {
    try {
      sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
    } catch (e) {
      console.warn('Stripe sub retrieve fail:', e?.message);
      sub = null;
    }
  }

  const statusBad =
    !sub ||
    ['canceled', 'unpaid'].includes(String(sub.status || '').toLowerCase());

  if (statusBad && user.id_costumer) {
    try {
      const picked = await pickCurrentStripeSubscription(user.id_costumer);
      if (picked) {
        sub = picked;
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
            console.warn('DB sync fail:', e?.message);
          }
        }
      }
    } catch (e) {
      console.warn('Stripe pick current subscription fail:', e?.message);
    }
  }

  if (sub?.status) {
    stripeStatus = sub.status;

    if (sub.status === 'trialing' || sub.status === 'active')
      estadoFinal = 'activo';
    else if (sub.status === 'canceled') estadoFinal = 'cancelado';
    else if (sub.status === 'past_due' || sub.status === 'unpaid')
      estadoFinal = 'suspendido';
    else estadoFinal = (user.estado || 'inactivo').toLowerCase();

    cancelAtPeriodEnd = sub?.cancel_at_period_end ? 1 : 0;
    cancelAt = sub?.cancel_at ? new Date(sub.cancel_at * 1000) : null;
    canceledAt = sub?.canceled_at ? new Date(sub.canceled_at * 1000) : null;

    if (sub?.current_period_end)
      fechaRenovacion = new Date(sub.current_period_end * 1000);
    else if (sub?.trial_end) fechaRenovacion = new Date(sub.trial_end * 1000);

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
      estado: estadoFinal,
      fecha_renovacion: fechaRenovacion,
      stripe_subscription_status: stripeStatus,
      cancel_at_period_end: cancelAtPeriodEnd,
      cancel_at: cancelAt,
      canceled_at: canceledAt,
      tipo_plan: user.tipo_plan,
      permanente: user.permanente,
      free_trial_used: Number(user.free_trial_used || 0),
      trial_eligible: Number(user.free_trial_used || 0) === 0,
      promo_plan2_used: Number(user.promo_plan2_used || 0),
      promo_plan2_eligible: Number(user.promo_plan2_used || 0) === 0,
      // Datos del plan
      tools_access: planDb?.tools_access || 'both',
      ...(planDb || {}),
    },
    user_flags: userFlags,
  });
});

// ─────────────────────────────────────────────────────────────
// Facturas del usuario
// ─────────────────────────────────────────────────────────────
exports.facturasUsuario = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const customer = user.id_costumer;
  if (!customer) {
    return res.status(200).json({ success: true, data: [] });
  }

  const invoices = await stripe.invoices.list({ customer, limit: 20 });

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

// ─────────────────────────────────────────────────────────────
// Portal Cliente
// ─────────────────────────────────────────────────────────────
exports.portalCliente = catchAsync(async (req, res, next) => {
  const { id_usuario, return_url } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const customer = user.id_costumer;
  if (!customer) {
    return next(new AppError('Usuario sin id_costumer.', 400));
  }

  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: return_url || FRONT_SUCCESS_URL,
  });

  return res.status(200).json({ success: true, url: session.url });
});

// ─────────────────────────────────────────────────────────────
// Cancelar suscripción
// ─────────────────────────────────────────────────────────────
exports.cancelarSuscripcion = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  // Si está en trial_usage de IL, simplemente desactivar
  if ((user.estado || '').toLowerCase() === 'trial_usage') {
    await db.query(
      `UPDATE usuarios_chat_center
       SET estado = 'inactivo', id_plan = NULL
       WHERE id_usuario = ?`,
      { replacements: [id_usuario] },
    );
    return res.status(200).json({
      success: true,
      message: 'Prueba gratuita cancelada.',
    });
  }

  if (!user.stripe_subscription_id) {
    return next(new AppError('Usuario no tiene stripe_subscription_id.', 400));
  }

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

// ─────────────────────────────────────────────────────────────
// Portal métodos
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Cambiar Plan (upgrade / downgrade)
// ─────────────────────────────────────────────────────────────
exports.cambiarPlan = catchAsync(async (req, res, next) => {
  const { id_usuario, id_plan_nuevo } = req.body;

  if (!id_usuario || !id_plan_nuevo) {
    return next(new AppError('Faltan id_usuario o id_plan_nuevo.', 400));
  }

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  // Si viene de trial_usage (IL sin suscripción Stripe), redirigir a checkout
  if ((user.estado || '').toLowerCase() === 'trial_usage') {
    return res.status(200).json({
      success: false,
      redirect_to_checkout: true,
      message: 'Debe completar la suscripción primero. Use crearSesionPago.',
    });
  }

  if (!user.stripe_subscription_id) {
    return next(new AppError('Usuario no tiene stripe_subscription_id.', 400));
  }

  const planActual = user.id_plan ? await getPlanById(user.id_plan) : null;
  const planNuevo = await getPlanById(id_plan_nuevo);

  if (!planNuevo?.id_price) {
    return next(new AppError('Plan nuevo inválido o sin id_price.', 400));
  }

  if (Number(user.id_plan) === Number(id_plan_nuevo)) {
    return res
      .status(200)
      .json({ success: true, message: 'Ya está en ese plan.' });
  }

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

  // Si es upgrade y existe schedule previo, liberarlo
  if (esUpgrade && sub.schedule) {
    try {
      await stripe.subscriptionSchedules.release(sub.schedule);
      sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id, {
        expand: ['items.data.price'],
      });
    } catch (e) {
      console.log('[cambiarPlan] schedule release failed:', e?.message);
    }
  }

  // ─── MISMO PRECIO ───
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

  // Guardar pending
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

  // ─── UPGRADE ───
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

    const latestInvoice = updated.latest_invoice;
    if (!latestInvoice || !latestInvoice.id) {
      return res.status(400).json({
        success: false,
        message: 'No se pudo generar la factura de prorrateo.',
      });
    }

    const invFresh = await stripe.invoices.retrieve(latestInvoice.id, {
      expand: ['payment_intent'],
    });

    const totalFresh = Number(invFresh.total || 0);
    const dueFresh = Number(invFresh.amount_due || 0);

    if (totalFresh <= 0 || dueFresh <= 0) {
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
         SET pending_plan_id = NULL, pending_change = NULL, pending_effective_at = NULL
         WHERE id_usuario = ?`,
        { replacements: [id_usuario] },
      );

      return res.status(400).json({
        success: false,
        message:
          'No se pudo generar cobro inmediato ($0). Revise saldo/créditos.',
      });
    }

    try {
      await stripe.subscriptions.update(updated.id, {
        metadata: {
          ...(updated.metadata || {}),
          pending_invoice_id: invFresh.id,
        },
      });
    } catch (e) {
      console.log('[cambiarPlan] metadata fail:', e?.message);
    }

    let paid = null;
    try {
      paid = await stripe.invoices.pay(invFresh.id, {
        expand: ['payment_intent'],
      });
    } catch (e) {
      // requiere SCA
    }

    const pi = paid?.payment_intent || invFresh?.payment_intent || null;

    if (paid && paid.status === 'paid') {
      return res.status(200).json({
        success: true,
        actionRequired: false,
        subscription_id: updated.id,
        invoice_id: paid.id,
        message: 'Upgrade cobrado y aplicado.',
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
        message: 'Requiere confirmación bancaria (3DS).',
      });
    }

    const invForUrl = await stripe.invoices.retrieve(invFresh.id);
    return res.status(200).json({
      success: true,
      actionRequired: true,
      subscription_id: updated.id,
      invoice_id: invFresh.id,
      hosted_invoice_url: invForUrl.hosted_invoice_url,
      message: 'Complete el pago para finalizar el upgrade.',
    });
  }

  // ─── DOWNGRADE ───
  if (esDowngrade) {
    const periodEnd = sub.current_period_end;
    const currentPriceId = subItem.price?.id;

    let scheduleId = sub.schedule;
    if (!scheduleId) {
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.id,
      });
      scheduleId = schedule.id;
    }

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
      message: 'Downgrade programado para el próximo corte.',
      effective_at: new Date(periodEnd * 1000),
    });
  }

  return res.status(200).json({ success: true, message: 'Cambio solicitado.' });
});
