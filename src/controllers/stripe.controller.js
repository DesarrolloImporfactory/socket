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

const STRIPE_SECRET = envPick('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST');

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

const COUPON_PLAN_COMUNIDAD = envPick(
  'STRIPE_COUPON_COMUNIDAD_FIRST_MONTH',
  'STRIPE_COUPON_COMUNIDAD_FIRST_MONTH_TEST',
);

const FRONT_SUCCESS_URL = envPick(
  'FRONT_SUCCESS_URL',
  'FRONT_SUCCESS_URL_TEST',
);
const FRONT_CANCEL_URL = envPick('FRONT_CANCEL_URL', 'FRONT_CANCEL_URL_TEST');

const PLAN_IL_ID = Number(
  envPick('STRIPE_PLAN_IL_ID', 'STRIPE_PLAN_IL_ID_TEST', '6'),
);
const PLAN_IC_ID = Number(
  envPick('STRIPE_PLAN_CONEXION_ID', 'STRIPE_PLAN_CONEXION_ID_TEST', '2'),
);

// ID del Plan Comunidad por entorno
const PLAN_COMUNIDAD_ID = Number(
  envPick('STRIPE_PLAN_COMUNIDAD_ID', 'STRIPE_PLAN_COMUNIDAD_ID_TEST', '22'),
);

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

// ─────────────────────────────────────────────────────────────
// Configuración de planes (ecosistema)
// ─────────────────────────────────────────────────────────────
const TRIAL_DAYS = 7;
const TRIAL_DAYS_COMUNIDAD = 5;
const IL_TRIAL_IMAGES = 10;
const PROMO_FIRST_MONTH_PRICE = 5;

const getCouponByPlan = (idPlan) => {
  const num = Number(idPlan);
  const map = {
    [PLAN_IL_ID]: COUPON_PLAN_IL,
    [PLAN_IC_ID]: COUPON_PLAN_IC,
    [PLAN_COMUNIDAD_ID]: COUPON_PLAN_COMUNIDAD,
  };
  if (isProd) {
    map[3] = COUPON_PLAN_PRO;
    map[4] = COUPON_PLAN_ADV;
  } else {
    map[17] = COUPON_PLAN_PRO;
    map[18] = COUPON_PLAN_ADV;
  }
  return map[num] || null;
};

const getPromoPlans = () => {
  if (isProd) return new Set([PLAN_IL_ID, PLAN_IC_ID, 3, 4, PLAN_COMUNIDAD_ID]); // ✅ añadido COMUNIDAD
  return new Set([PLAN_IL_ID, PLAN_IC_ID, 17, 18, PLAN_COMUNIDAD_ID]); // ✅ añadido COMUNIDAD
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
        promo_imagenes_restantes,
        promo_angulos_restantes,
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
        canceled_at,
        unlocked_plans
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
// Activar Trial por Uso (Insta Landing)
// ─────────────────────────────────────────────────────────────
exports.activarTrialUsage = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const estadoActual = (user.estado || '').toLowerCase();
  const tieneActivo =
    estadoActual.includes('activo') || estadoActual.includes('trial');
  if (user.id_plan && tieneActivo) {
    return res.status(400).json({
      success: false,
      message: 'Ya tiene un plan activo. No puede activar la prueba gratuita.',
    });
  }

  if (Number(user.il_trial_used) === 1) {
    return res.status(400).json({
      success: false,
      message: 'Ya utilizó su prueba gratuita de Insta Landing.',
      il_trial_used: true,
    });
  }

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
// Verificar/Incrementar uso de trial IL Y promo_usage
// ─────────────────────────────────────────────────────────────
exports.verificarTrialUsage = catchAsync(async (req, res, next) => {
  const { id_usuario, incrementar = false, tipo = 'imagen' } = req.body;
  if (!id_usuario) return next(new AppError('Falta id_usuario.', 400));

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const estado = (user.estado || '').toLowerCase();

  // ─── PROMO USAGE (código promocional) ───
  if (estado === 'promo_usage') {
    const imgRestantes = Number(user.promo_imagenes_restantes || 0);
    const angRestantes = Number(user.promo_angulos_restantes || 0);

    const esAngulo = tipo === 'angulo';
    const remaining = esAngulo ? angRestantes : imgRestantes;
    const recursoLabel = esAngulo ? 'ángulos' : 'imágenes';

    if (remaining <= 0) {
      const todoAgotado = imgRestantes <= 0 && angRestantes <= 0;

      let redirectTo = null;
      if (todoAgotado) {
        const [[canje]] = await db.query(
          `SELECT cp.redirect_on_exhaust
           FROM canjes_codigo_promocional ccp
           JOIN codigos_promocionales cp ON cp.id_codigo = ccp.id_codigo
           WHERE ccp.id_usuario = ?
           ORDER BY ccp.fecha_canje DESC
           LIMIT 1`,
          { replacements: [id_usuario] },
        );
        redirectTo = canje?.redirect_on_exhaust || null;
      }

      return res.status(200).json({
        success: true,
        allowed: false,
        is_trial: false,
        is_promo: true,
        remaining: 0,
        remaining_imagenes: imgRestantes,
        remaining_angulos: angRestantes,
        message: `${recursoLabel.charAt(0).toUpperCase() + recursoLabel.slice(1)} promocionales agotados.`,
        redirect_to: redirectTo,
        redirect_to_checkout: !redirectTo,
      });
    }

    if (incrementar) {
      const campo = esAngulo
        ? 'promo_angulos_restantes'
        : 'promo_imagenes_restantes';
      await db.query(
        `UPDATE usuarios_chat_center
         SET ${campo} = GREATEST(0, ${campo} - 1)
         WHERE id_usuario = ?`,
        { replacements: [id_usuario] },
      );

      const newRemaining = remaining - 1;
      const newImg = esAngulo ? imgRestantes : Math.max(0, imgRestantes - 1);
      const newAng = esAngulo ? Math.max(0, angRestantes - 1) : angRestantes;
      const todoAgotado = newImg <= 0 && newAng <= 0;

      let redirectTo = null;
      if (todoAgotado) {
        const [[canje]] = await db.query(
          `SELECT cp.redirect_on_exhaust
           FROM canjes_codigo_promocional ccp
           JOIN codigos_promocionales cp ON cp.id_codigo = ccp.id_codigo
           WHERE ccp.id_usuario = ?
           ORDER BY ccp.fecha_canje DESC
           LIMIT 1`,
          { replacements: [id_usuario] },
        );
        redirectTo = canje?.redirect_on_exhaust || null;
      }

      return res.status(200).json({
        success: true,
        allowed: true,
        is_trial: false,
        is_promo: true,
        remaining: newRemaining,
        remaining_imagenes: newImg,
        remaining_angulos: newAng,
        message:
          newRemaining > 0
            ? `Recurso usado. Te quedan ${newRemaining} ${recursoLabel} promo.`
            : `Último ${esAngulo ? 'ángulo' : 'imagen'} promo usado.`,
        redirect_to: todoAgotado ? redirectTo : null,
        redirect_to_checkout: todoAgotado ? !redirectTo : false,
      });
    }

    return res.status(200).json({
      success: true,
      allowed: true,
      is_trial: false,
      is_promo: true,
      remaining,
      remaining_imagenes: imgRestantes,
      remaining_angulos: angRestantes,
    });
  }

  // ─── TRIAL USAGE (IL original, 10 imágenes) ───
  if (estado === 'trial_usage') {
    const usadas = Number(user.il_imagenes_usadas || 0);
    const limite = IL_TRIAL_IMAGES;
    const remaining = Math.max(0, limite - usadas);

    if (remaining <= 0) {
      return res.status(200).json({
        success: true,
        allowed: false,
        is_trial: true,
        is_promo: false,
        remaining: 0,
        message: 'Prueba gratuita agotada. Debe suscribirse para continuar.',
        redirect_to_checkout: true,
      });
    }

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
        is_promo: false,
        remaining: newRemaining,
        message:
          newRemaining > 0
            ? `Imagen generada. Le quedan ${newRemaining} de ${limite}.`
            : 'Última imagen gratuita. Debe suscribirse.',
        redirect_to_checkout: newRemaining <= 0,
      });
    }

    return res.status(200).json({
      success: true,
      allowed: true,
      is_trial: true,
      is_promo: false,
      remaining,
    });
  }

  // ─── Plan normal ───
  const promoImgRestantes = Number(user.promo_imagenes_restantes || 0);
  const promoAngRestantes = Number(user.promo_angulos_restantes || 0);

  return res.status(200).json({
    success: true,
    allowed: true,
    is_trial: false,
    is_promo: false,
    remaining: null,
    promo_bonus_imagenes: promoImgRestantes > 0 ? promoImgRestantes : undefined,
    promo_bonus_angulos: promoAngRestantes > 0 ? promoAngRestantes : undefined,
    message: 'Usuario no está en trial por uso.',
  });
});

// ─────────────────────────────────────────────────────────────
// Checkout Session (subscription)
// ✅ MODIFICADO: Soporte trial 5 días + cupón $5 para Plan Comunidad
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

  // ─── Trial Days Logic ───
  // Plan ImporChat (2/16): 7 días si no ha usado trial
  // Plan Comunidad (22): 5 días siempre (ya está gateado por código promo)
  const numPlan = Number(id_plan);
  const isICPlan = numPlan === PLAN_IC_ID;
  const isComunidadPlan = numPlan === PLAN_COMUNIDAD_ID;

  const eligibleTrial = Number(user.free_trial_used || 0) === 0;
  const shouldApplyTrialIC = eligibleTrial && isICPlan;

  let trialDays;
  if (isComunidadPlan) {
    const comunidadTrialEligible = Number(user.free_trial_used || 0) === 0;
    trialDays = comunidadTrialEligible ? TRIAL_DAYS_COMUNIDAD : undefined;
  } else if (shouldApplyTrialIC) {
    trialDays = TRIAL_DAYS;
  } else {
    trialDays = undefined;
  }

  // ─── Promo $5 primer mes ───
  const PROMO_PLANS = getPromoPlans();
  const isPromoPlan = PROMO_PLANS.has(numPlan);
  const couponId = getCouponByPlan(id_plan);
  const promoNotUsedYet = Number(user.promo_plan2_used || 0) === 0;
  const canApplyPromo = isPromoPlan && promoNotUsedYet && Boolean(couponId);

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
    ...(canApplyPromo ? { discounts: [{ coupon: couponId }] } : {}),
    subscription_data: {
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
    trialDays: trialDays || 0,
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

  const userFlags = {
    trial_eligible: Number(user.free_trial_used || 0) === 0,
    promo_plan2_used: Number(user.promo_plan2_used || 0),
    promo_plan2_eligible: Number(user.promo_plan2_used || 0) === 0,
    il_trial_used: Number(user.il_trial_used || 0) === 1,
    il_imagenes_usadas: Number(user.il_imagenes_usadas || 0),
    il_imagenes_limite: IL_TRIAL_IMAGES,
    promo_imagenes_restantes: Number(user.promo_imagenes_restantes || 0),
    promo_angulos_restantes: Number(user.promo_angulos_restantes || 0),
    unlocked_plans: (() => {
      try {
        const arr = JSON.parse(user.unlocked_plans || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    })(),
  };

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

  // ─── TRIAL USAGE (IL sin Stripe) ───
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
        trial_type: 'usage',
        il_imagenes_usadas: Number(user.il_imagenes_usadas || 0),
        il_imagenes_limite: IL_TRIAL_IMAGES,
        il_imagenes_restantes: Math.max(
          0,
          IL_TRIAL_IMAGES - Number(user.il_imagenes_usadas || 0),
        ),
        tools_access: planDb?.tools_access || 'insta_landing',
        ...(planDb || {}),
      },
      user_flags: userFlags,
    });
  }

  // ─── PROMO USAGE (código promocional, sin Stripe) ───
  if (estadoFinal === 'promo_usage') {
    return res.status(200).json({
      success: true,
      plan: {
        id_plan: user.id_plan,
        nombre_plan: planDb?.nombre_plan || 'Insta Landing',
        descripcion_plan: planDb?.descripcion_plan || '',
        estado: 'promo_usage',
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
        trial_type: 'promo',
        promo_imagenes_restantes: Number(user.promo_imagenes_restantes || 0),
        promo_angulos_restantes: Number(user.promo_angulos_restantes || 0),
        tools_access: planDb?.tools_access || 'insta_landing',
        ...(planDb || {}),
      },
      user_flags: userFlags,
    });
  }

  // ─── CORTESÍA / Acceso manual sin Stripe ───
  // Si no hay stripe_subscription_id, estado es "activo" y fecha_renovacion
  // está en el futuro → retornar directo sin consultar Stripe.
  // Útil para dar meses gratis o cortesías manuales desde la DB.
  const ahora = new Date();
  const fechaRenDb = user.fecha_renovacion
    ? new Date(user.fecha_renovacion)
    : null;
  const esAccesoManual =
    !user.stripe_subscription_id &&
    estadoFinal === 'activo' &&
    fechaRenDb &&
    fechaRenDb > ahora;

  if (esAccesoManual) {
    let effectiveToolsAccess = planDb?.tools_access || 'both';
    if (effectiveToolsAccess !== 'both') {
      const hasPromoResources =
        Number(user.promo_imagenes_restantes || 0) > 0 ||
        Number(user.promo_angulos_restantes || 0) > 0;
      if (hasPromoResources) effectiveToolsAccess = 'both';
    }

    return res.status(200).json({
      success: true,
      plan: {
        id_plan: user.id_plan,
        nombre_plan: planDb?.nombre_plan || 'Plan',
        descripcion_plan: planDb?.descripcion_plan || '',
        estado: 'activo',
        fecha_renovacion: fechaRenDb,
        stripe_subscription_status: 'courtesy',
        cancel_at_period_end: 0,
        cancel_at: null,
        canceled_at: null,
        tipo_plan: user.tipo_plan,
        permanente: user.permanente,
        free_trial_used: Number(user.free_trial_used || 0),
        trial_eligible: Number(user.free_trial_used || 0) === 0,
        promo_plan2_used: Number(user.promo_plan2_used || 0),
        promo_plan2_eligible: Number(user.promo_plan2_used || 0) === 0,
        ...(planDb || {}),
        tools_access: effectiveToolsAccess,
        stripe_subscription_id: null,
        needs_card_capture: false,
      },
      user_flags: userFlags,
    });
  }

  // ─── Stripe Resolution ───
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

  // ── Ajustar tools_access si tiene recursos promo para Insta Landing ──
  let effectiveToolsAccess = planDb?.tools_access || 'both';
  if (effectiveToolsAccess !== 'both') {
    const hasPromoResources =
      Number(user.promo_imagenes_restantes || 0) > 0 ||
      Number(user.promo_angulos_restantes || 0) > 0;
    if (hasPromoResources) {
      effectiveToolsAccess = 'both';
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
      ...(planDb || {}),
      tools_access: effectiveToolsAccess,
      stripe_subscription_id: user.stripe_subscription_id || null,
      needs_card_capture:
        Number(user.id_plan) === 21 && !user.stripe_subscription_id,
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

  if ((user.estado || '').toLowerCase() === 'promo_usage') {
    await db.query(
      `UPDATE usuarios_chat_center
       SET estado = 'inactivo',
           id_plan = NULL,
           promo_imagenes_restantes = 0,
           promo_angulos_restantes = 0
       WHERE id_usuario = ?`,
      { replacements: [id_usuario] },
    );
    return res.status(200).json({
      success: true,
      message: 'Acceso promocional cancelado.',
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

  const estadoLower = (user.estado || '').toLowerCase();
  if (estadoLower === 'trial_usage' || estadoLower === 'promo_usage') {
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

    if (invFresh.status === 'paid' || invFresh.paid === true) {
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
          'No se pudo generar la factura de prorrateo. Intente de nuevo en unos segundos.',
      });
    }

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

// ═══════════════════════════════════════════════════════════════
// CÓDIGOS PROMOCIONALES
// ═══════════════════════════════════════════════════════════════

exports.validarCodigoPromo = catchAsync(async (req, res, next) => {
  const { id_usuario, codigo } = req.body;

  if (!id_usuario || !codigo) {
    return next(new AppError('Falta id_usuario o codigo.', 400));
  }

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const codigoLimpio = codigo.trim().toUpperCase();

  const [[promo]] = await db.query(
    `SELECT id_codigo, codigo, descripcion, imagenes_regalo, angulos_regalo,
            max_usos, usos_actuales, activo, fecha_inicio, fecha_fin,
            redirect_on_exhaust, unlock_plan_id
     FROM codigos_promocionales
     WHERE codigo = ?
     LIMIT 1`,
    { replacements: [codigoLimpio] },
  );

  if (!promo) {
    return res.status(200).json({
      success: false,
      message: 'Código no encontrado. Verifica e intenta de nuevo.',
    });
  }

  if (!promo.activo) {
    return res.status(200).json({
      success: false,
      message: 'Este código ya no está disponible.',
    });
  }

  const now = new Date();
  if (promo.fecha_inicio && new Date(promo.fecha_inicio) > now) {
    return res
      .status(200)
      .json({ success: false, message: 'Este código aún no está activo.' });
  }
  if (promo.fecha_fin && new Date(promo.fecha_fin) < now) {
    return res
      .status(200)
      .json({ success: false, message: 'Este código ha expirado.' });
  }

  if (promo.max_usos > 0 && promo.usos_actuales >= promo.max_usos) {
    return res.status(200).json({
      success: false,
      message: 'Este código ha alcanzado su límite de usos.',
    });
  }

  const [[yaCanjeado]] = await db.query(
    `SELECT id_canje FROM canjes_codigo_promocional
     WHERE id_usuario = ? AND id_codigo = ?
     LIMIT 1`,
    { replacements: [id_usuario, promo.id_codigo] },
  );

  if (yaCanjeado) {
    return res.status(200).json({
      success: false,
      message: 'Ya utilizaste este código promocional.',
    });
  }
  return res.status(200).json({
    success: true,
    valid: true,
    codigo: promo.codigo,
    imagenes_regalo: Number(promo.imagenes_regalo || 0),
    angulos_regalo: Number(promo.angulos_regalo || 0),
    descripcion: promo.descripcion,
    unlock_plan_id: promo.unlock_plan_id || null,
    message: promo.unlock_plan_id
      ? 'Código válido: Desbloquea un plan exclusivo para ti.'
      : `Código válido: ${promo.imagenes_regalo} imágenes + ${promo.angulos_regalo} ángulos AI gratis.`,
  });
});

exports.canjearCodigoPromo = catchAsync(async (req, res, next) => {
  const { id_usuario, codigo } = req.body;

  if (!id_usuario || !codigo) {
    return next(new AppError('Falta id_usuario o codigo.', 400));
  }

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  const codigoLimpio = codigo.trim().toUpperCase();

  const [[promo]] = await db.query(
    `SELECT id_codigo, codigo, imagenes_regalo, angulos_regalo,
            max_usos, usos_actuales, activo, fecha_inicio, fecha_fin, unlock_plan_id
     FROM codigos_promocionales
     WHERE codigo = ?
     LIMIT 1`,
    { replacements: [codigoLimpio] },
  );

  if (!promo || !promo.activo) {
    return res
      .status(400)
      .json({ success: false, message: 'Código no válido o inactivo.' });
  }

  const now = new Date();
  if (promo.fecha_inicio && new Date(promo.fecha_inicio) > now) {
    return res
      .status(400)
      .json({ success: false, message: 'Código aún no activo.' });
  }
  if (promo.fecha_fin && new Date(promo.fecha_fin) < now) {
    return res
      .status(400)
      .json({ success: false, message: 'Código expirado.' });
  }
  if (promo.max_usos > 0 && promo.usos_actuales >= promo.max_usos) {
    return res.status(400).json({ success: false, message: 'Código agotado.' });
  }

  const [[yaCanjeado]] = await db.query(
    `SELECT id_canje FROM canjes_codigo_promocional
     WHERE id_usuario = ? AND id_codigo = ?
     LIMIT 1`,
    { replacements: [id_usuario, promo.id_codigo] },
  );

  if (yaCanjeado) {
    return res
      .status(400)
      .json({ success: false, message: 'Ya canjeaste este código.' });
  }

  const imagenesRegalo = Number(promo.imagenes_regalo || 0);
  const angulosRegalo = Number(promo.angulos_regalo || 0);

  // ✅ FIX: Si solo desbloquea plan (sin recursos), no tocar estado ni id_plan
  const isUnlockOnly =
    promo.unlock_plan_id && imagenesRegalo === 0 && angulosRegalo === 0;

  const estadoActual = (user.estado || '').toLowerCase();
  const tieneActivo =
    estadoActual.includes('activo') ||
    estadoActual.includes('trial') ||
    estadoActual === 'trial_usage' ||
    estadoActual === 'promo_usage';

  if (!isUnlockOnly) {
    if (!user.id_plan || !tieneActivo) {
      await db.query(
        `UPDATE usuarios_chat_center
         SET id_plan = ?,
             estado = 'promo_usage',
             promo_imagenes_restantes = promo_imagenes_restantes + ?,
             promo_angulos_restantes  = promo_angulos_restantes + ?
         WHERE id_usuario = ?`,
        {
          replacements: [PLAN_IL_ID, imagenesRegalo, angulosRegalo, id_usuario],
        },
      );
    } else {
      await db.query(
        `UPDATE usuarios_chat_center
         SET promo_imagenes_restantes = promo_imagenes_restantes + ?,
             promo_angulos_restantes  = promo_angulos_restantes + ?
         WHERE id_usuario = ?`,
        { replacements: [imagenesRegalo, angulosRegalo, id_usuario] },
      );
    }
  }

  await db.query(
    `INSERT INTO canjes_codigo_promocional (id_codigo, id_usuario, imagenes_otorgadas, angulos_otorgados)
     VALUES (?, ?, ?, ?)`,
    {
      replacements: [
        promo.id_codigo,
        id_usuario,
        imagenesRegalo,
        angulosRegalo,
      ],
    },
  );

  await db.query(
    `UPDATE codigos_promocionales
     SET usos_actuales = usos_actuales + 1
     WHERE id_codigo = ?`,
    { replacements: [promo.id_codigo] },
  );

  if (promo.unlock_plan_id) {
    try {
      const [[currentUser]] = await db.query(
        `SELECT unlocked_plans FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
        { replacements: [id_usuario] },
      );

      let unlocked = [];
      try {
        unlocked = JSON.parse(currentUser?.unlocked_plans || '[]');
      } catch {
        unlocked = [];
      }
      if (!Array.isArray(unlocked)) unlocked = [];

      const planToUnlock = Number(promo.unlock_plan_id);
      if (!unlocked.includes(planToUnlock)) {
        unlocked.push(planToUnlock);
        await db.query(
          `UPDATE usuarios_chat_center SET unlocked_plans = ? WHERE id_usuario = ?`,
          { replacements: [JSON.stringify(unlocked), id_usuario] },
        );
      }
    } catch (e) {
      console.warn(
        '[canjearCodigoPromo] unlock_plan_id save failed:',
        e?.message,
      );
    }
  }

  return res.status(200).json({
    success: true,
    message:
      imagenesRegalo > 0 || angulosRegalo > 0
        ? `¡Código canjeado! Tienes ${imagenesRegalo} imágenes y ${angulosRegalo} ángulos AI para usar.`
        : promo.unlock_plan_id
          ? '¡Código canjeado! Se desbloqueó un plan exclusivo para ti.'
          : '¡Código canjeado!',
    imagenes_otorgadas: imagenesRegalo,
    angulos_otorgados: angulosRegalo,
    plan_id: PLAN_IL_ID,
    unlocked_plan_id: promo.unlock_plan_id || null,
  });
});

// ═══════════════════════════════════════════════════════════════
// CRUD CÓDIGOS PROMOCIONALES (Super Admin)
// ═══════════════════════════════════════════════════════════════

exports.listarCodigosPromo = catchAsync(async (req, res, next) => {
  const [rows] = await db.query(
    `SELECT cp.*,
            (SELECT COUNT(*) FROM canjes_codigo_promocional ccp WHERE ccp.id_codigo = cp.id_codigo) AS total_canjes
     FROM codigos_promocionales cp
     ORDER BY cp.created_at DESC`,
  );

  return res.status(200).json({ success: true, data: rows || [] });
});

exports.crearCodigoPromo = catchAsync(async (req, res, next) => {
  const {
    codigo,
    descripcion = null,
    imagenes_regalo = 25,
    angulos_regalo = 10,
    max_usos = 100,
    activo = 1,
    fecha_inicio = null,
    fecha_fin = null,
    redirect_on_exhaust = null,
    unlock_plan_id = null,
  } = req.body;

  if (!codigo || !codigo.trim()) {
    return next(new AppError('El código es obligatorio.', 400));
  }

  const codigoLimpio = codigo.trim().toUpperCase();

  const [[existe]] = await db.query(
    `SELECT id_codigo FROM codigos_promocionales WHERE codigo = ? LIMIT 1`,
    { replacements: [codigoLimpio] },
  );

  if (existe) {
    return res
      .status(400)
      .json({ success: false, message: 'Ese código ya existe.' });
  }

  const [result] = await db.query(
    `INSERT INTO codigos_promocionales
       (codigo, descripcion, imagenes_regalo, angulos_regalo, max_usos, activo, fecha_inicio, fecha_fin, redirect_on_exhaust, unlock_plan_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        codigoLimpio,
        descripcion,
        imagenes_regalo,
        angulos_regalo,
        max_usos,
        activo ? 1 : 0,
        fecha_inicio || null,
        fecha_fin || null,
        redirect_on_exhaust || null,
        unlock_plan_id || null,
      ],
    },
  );

  return res.status(201).json({
    success: true,
    message: 'Código creado.',
    id_codigo: result?.insertId || null,
    codigo: codigoLimpio,
  });
});

exports.actualizarCodigoPromo = catchAsync(async (req, res, next) => {
  const { id_codigo } = req.params;
  if (!id_codigo) return next(new AppError('Falta id_codigo.', 400));

  const {
    codigo,
    descripcion,
    imagenes_regalo,
    angulos_regalo,
    max_usos,
    activo,
    fecha_inicio,
    fecha_fin,
    redirect_on_exhaust,
    unlock_plan_id,
  } = req.body;

  const [[existing]] = await db.query(
    `SELECT id_codigo FROM codigos_promocionales WHERE id_codigo = ? LIMIT 1`,
    { replacements: [id_codigo] },
  );

  if (!existing) {
    return res
      .status(404)
      .json({ success: false, message: 'Código no encontrado.' });
  }

  const updates = [];
  const values = [];

  if (codigo !== undefined) {
    const codigoLimpio = codigo.trim().toUpperCase();
    const [[dup]] = await db.query(
      `SELECT id_codigo FROM codigos_promocionales WHERE codigo = ? AND id_codigo != ? LIMIT 1`,
      { replacements: [codigoLimpio, id_codigo] },
    );
    if (dup) {
      return res
        .status(400)
        .json({ success: false, message: 'Ese código ya existe.' });
    }
    updates.push('codigo = ?');
    values.push(codigoLimpio);
  }
  if (descripcion !== undefined) {
    updates.push('descripcion = ?');
    values.push(descripcion);
  }
  if (imagenes_regalo !== undefined) {
    updates.push('imagenes_regalo = ?');
    values.push(Number(imagenes_regalo));
  }
  if (angulos_regalo !== undefined) {
    updates.push('angulos_regalo = ?');
    values.push(Number(angulos_regalo));
  }
  if (max_usos !== undefined) {
    updates.push('max_usos = ?');
    values.push(Number(max_usos));
  }
  if (activo !== undefined) {
    updates.push('activo = ?');
    values.push(activo ? 1 : 0);
  }
  if (fecha_inicio !== undefined) {
    updates.push('fecha_inicio = ?');
    values.push(fecha_inicio || null);
  }
  if (fecha_fin !== undefined) {
    updates.push('fecha_fin = ?');
    values.push(fecha_fin || null);
  }
  if (redirect_on_exhaust !== undefined) {
    updates.push('redirect_on_exhaust = ?');
    values.push(redirect_on_exhaust || null);
  }
  if (unlock_plan_id !== undefined) {
    updates.push('unlock_plan_id = ?');
    values.push(unlock_plan_id || null);
  }

  if (updates.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: 'No hay campos para actualizar.' });
  }

  values.push(id_codigo);

  await db.query(
    `UPDATE codigos_promocionales SET ${updates.join(', ')} WHERE id_codigo = ?`,
    { replacements: values },
  );

  return res
    .status(200)
    .json({ success: true, message: 'Código actualizado.' });
});

exports.eliminarCodigoPromo = catchAsync(async (req, res, next) => {
  const { id_codigo } = req.params;
  const { hard = false } = req.body;

  if (!id_codigo) return next(new AppError('Falta id_codigo.', 400));

  const [[existing]] = await db.query(
    `SELECT id_codigo, usos_actuales FROM codigos_promocionales WHERE id_codigo = ? LIMIT 1`,
    { replacements: [id_codigo] },
  );

  if (!existing) {
    return res
      .status(404)
      .json({ success: false, message: 'Código no encontrado.' });
  }

  if (hard) {
    if (Number(existing.usos_actuales) > 0) {
      return res.status(400).json({
        success: false,
        message:
          'No se puede eliminar un código con canjes. Desactívelo en su lugar.',
      });
    }
    await db.query(`DELETE FROM codigos_promocionales WHERE id_codigo = ?`, {
      replacements: [id_codigo],
    });
    return res
      .status(200)
      .json({ success: true, message: 'Código eliminado permanentemente.' });
  }

  await db.query(
    `UPDATE codigos_promocionales SET activo = 0 WHERE id_codigo = ?`,
    { replacements: [id_codigo] },
  );

  return res
    .status(200)
    .json({ success: true, message: 'Código desactivado.' });
});

exports.listarCanjesCodigo = catchAsync(async (req, res, next) => {
  const { id_codigo } = req.params;
  if (!id_codigo) return next(new AppError('Falta id_codigo.', 400));

  const [rows] = await db.query(
    `SELECT ccp.*, u.email_propietario
     FROM canjes_codigo_promocional ccp
     LEFT JOIN usuarios_chat_center u ON u.id_usuario = ccp.id_usuario
     WHERE ccp.id_codigo = ?
     ORDER BY ccp.fecha_canje DESC`,
    { replacements: [id_codigo] },
  );

  return res.status(200).json({ success: true, data: rows || [] });
});

// ─────────────────────────────────────────────────────────────
// Capturar Tarjeta Plan 21 (Method Ecommerce)
// ─────────────────────────────────────────────────────────────
exports.capturarTarjetaPlan21 = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;

  if (!id_usuario) {
    return next(new AppError('Falta id_usuario.', 400));
  }

  const user = await getUserById(id_usuario);
  if (!user) return next(new AppError('Usuario no existe.', 404));

  if (Number(user.id_plan) !== 21) {
    return next(
      new AppError(
        'Este endpoint es solo para Plan Method Ecommerce (21).',
        400,
      ),
    );
  }

  if (user.stripe_subscription_id) {
    return res.status(400).json({
      success: false,
      message: 'Ya tiene una suscripción activa en Stripe.',
    });
  }

  const plan = await getPlanById(21);
  if (!plan || !plan.id_price) {
    return next(
      new AppError('Plan 21 no tiene id_price configurado en Stripe.', 400),
    );
  }

  const ahora = new Date();
  const fechaRenovacion = user.fecha_renovacion
    ? new Date(user.fecha_renovacion)
    : null;

  let trialDays = 0;

  if (fechaRenovacion && fechaRenovacion > ahora) {
    const msRestantes = fechaRenovacion.getTime() - ahora.getTime();
    trialDays = Math.ceil(msRestantes / (1000 * 60 * 60 * 24));
    trialDays = Math.min(trialDays, 730);
  }

  const customerParam = user.id_costumer
    ? { customer: user.id_costumer }
    : { customer_email: user.email_propietario || undefined };

  const customerUpdateParam = user.id_costumer
    ? { customer_update: { address: 'auto', name: 'auto' } }
    : {};

  const meta = {
    id_usuario: String(id_usuario),
    id_plan: '21',
    capture_card_plan21: 'true',
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
    subscription_data: {
      ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
      metadata: meta,
    },
    success_url: FRONT_SUCCESS_URL,
    cancel_url: FRONT_CANCEL_URL,
  });

  return res.status(200).json({
    success: true,
    url: session.url,
    sessionId: session.id,
    trialDays,
    message:
      trialDays > 0
        ? `Checkout creado con ${trialDays} días de acceso incluido. Primer cobro de $29: ${fechaRenovacion.toISOString().split('T')[0]}.`
        : 'Checkout creado. Cobro de $29 inmediato (período expirado).',
  });
});
