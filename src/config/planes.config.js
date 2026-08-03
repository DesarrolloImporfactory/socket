'use strict';

/**
 * config/planes.config.js
 *
 * Fuente única de verdad de los IDs y constantes del catálogo de planes.
 *
 * POR QUÉ EXISTE
 * Estos números vivían duplicados en tres lugares que se desincronizaban:
 *   - stripe.controller.js  (TRIAL_DAYS, cupones, getPromoPlans…)
 *   - requireStripeSubscription.middleware.js (PLANES_REQUIRE_CARD)
 *   - PlanesView.jsx del front (PLANES_VISIBLES, SORT_ORDER, PROMO_PLANS…)
 * El front además decidía qué planes mostrar con un `Set` hardcodeado, así que
 * cada cambio de catálogo obligaba a tocar código y redesplegar el SPA. Ahora el
 * front pregunta y el back responde.
 *
 * QUÉ VIVE AQUÍ Y QUÉ NO
 * Aquí: identidad de los planes y reglas de negocio (trials, cupones, quién
 * requiere tarjeta). En la BD: precios, límites, `activo` y `visible_publico`.
 * En el front: solo la estética (colores, badges), tomando `tipo_ui` de aquí.
 */

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// En producción => PROD; en no-prod => TEST (si no existe, cae a PROD).
// Mismo criterio que stripe.controller.js y stripe_webhook.controller.js.
const envPick = (prodKey, testKey, fallback = '') => {
  const prodVal = process.env[prodKey];
  const testVal = process.env[testKey];
  if (isProd) return prodVal ?? fallback;
  return testVal ?? prodVal ?? fallback;
};

const envPickNum = (prodKey, testKey, fallback) =>
  Number(envPick(prodKey, testKey, String(fallback)));

// ─────────────────────────────────────────────────────────────
// IDs de plan por entorno
// ─────────────────────────────────────────────────────────────
const PLAN_IL_ID = envPickNum('STRIPE_PLAN_IL_ID', 'STRIPE_PLAN_IL_ID_TEST', 6);
const PLAN_IC_ID = envPickNum(
  'STRIPE_PLAN_CONEXION_ID',
  'STRIPE_PLAN_CONEXION_ID_TEST',
  2,
);
const PLAN_PRO_ID = envPickNum(
  'STRIPE_PLAN_PRO_ID',
  'STRIPE_PLAN_PRO_ID_TEST',
  3,
);
const PLAN_AVANZADO_ID = envPickNum(
  'STRIPE_PLAN_AVANZADO_ID',
  'STRIPE_PLAN_AVANZADO_ID_TEST',
  4,
);
const PLAN_COMUNIDAD_ID = envPickNum(
  'STRIPE_PLAN_COMUNIDAD_ID',
  'STRIPE_PLAN_COMUNIDAD_ID_TEST',
  22,
);
// Plan de cortesía de los cursos de Imporsuit. No tiene fila TEST: es el mismo
// en ambos entornos.
const PLAN_METHOD_ID = Number(process.env.STRIPE_PLAN_METHOD_ID || 21);

// ─────────────────────────────────────────────────────────────
// Reglas de negocio
// ─────────────────────────────────────────────────────────────
const TRIAL_DAYS = Number(process.env.PLAN_TRIAL_DAYS || 7);
const TRIAL_DAYS_COMUNIDAD = Number(process.env.PLAN_TRIAL_DAYS_COMUNIDAD || 5);
const IL_TRIAL_IMAGES = Number(process.env.PLAN_IL_TRIAL_IMAGES || 10);
const PROMO_FIRST_MONTH_PRICE = Number(
  process.env.PLAN_PROMO_FIRST_MONTH_PRICE || 5,
);

// Planes que exigen tarjeta registrada antes de usar features core, aunque el
// período incluido siga vigente (Method Ecommerce: 3 meses de cortesía).
const PLANES_REQUIERE_TARJETA = new Set([PLAN_METHOD_ID]);

// ─────────────────────────────────────────────────────────────
// Cupones de primer mes ($5)
// ─────────────────────────────────────────────────────────────
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

const CUPONES_POR_PLAN = {
  [PLAN_IL_ID]: COUPON_PLAN_IL,
  [PLAN_IC_ID]: COUPON_PLAN_IC,
  [PLAN_PRO_ID]: COUPON_PLAN_PRO,
  [PLAN_AVANZADO_ID]: COUPON_PLAN_ADV,
  [PLAN_COMUNIDAD_ID]: COUPON_PLAN_COMUNIDAD,
};

const getCouponByPlan = (idPlan) => CUPONES_POR_PLAN[Number(idPlan)] || null;

/** Planes elegibles para la promo de primer mes a $5. */
const getPromoPlans = () =>
  new Set(
    Object.keys(CUPONES_POR_PLAN)
      .filter((id) => CUPONES_POR_PLAN[id])
      .map(Number),
  );

// ─────────────────────────────────────────────────────────────
// Tipo de plan para la UI
// ─────────────────────────────────────────────────────────────
/**
 * Slug que el front usa para elegir colores/badge/tagline. Se resuelve por ID
 * cuando el plan está declarado en env; si no, se deduce del catálogo para que
 * un plan nuevo no obligue a tocar env ni código antes de poder mostrarse.
 */
const tipoPlanUI = (plan) => {
  const id = Number(plan?.id_plan || 0);

  if (id === PLAN_COMUNIDAD_ID) return 'comunidad';
  if (id === PLAN_METHOD_ID) return 'method_ecommerce';
  if (id === PLAN_IL_ID) return 'insta_landing';
  if (id === PLAN_IC_ID) return 'imporchat';
  if (id === PLAN_PRO_ID) return 'pro';
  if (id === PLAN_AVANZADO_ID) return 'avanzado';

  const nombre = String(plan?.nombre_plan || '').toLowerCase();
  if (nombre.includes('comunidad')) return 'comunidad';

  const tools = String(plan?.tools_access || '')
    .toLowerCase()
    .trim();
  if (tools === 'insta_landing') return 'insta_landing';
  if (tools === 'imporchat') return 'imporchat';
  if (tools === 'both') {
    return Number(plan?.precio_plan || 0) >= 90 ? 'avanzado' : 'pro';
  }

  return 'pro';
};

/**
 * Días de trial de Stripe que le corresponden a un plan para un usuario dado.
 * Réplica exacta de la lógica de `crearSesionPago`, extraída para que el front
 * pueda anunciar el trial correcto sin volver a implementarla.
 */
const trialDiasParaPlan = (idPlan, usuario) => {
  const num = Number(idPlan);
  const trialNoUsado = Number(usuario?.free_trial_used || 0) === 0;

  if (num === PLAN_COMUNIDAD_ID) {
    return trialNoUsado ? TRIAL_DAYS_COMUNIDAD : 0;
  }
  if (num === PLAN_IC_ID) {
    return trialNoUsado ? TRIAL_DAYS : 0;
  }
  return 0;
};

module.exports = {
  isProd,
  envPick,

  PLAN_IL_ID,
  PLAN_IC_ID,
  PLAN_PRO_ID,
  PLAN_AVANZADO_ID,
  PLAN_COMUNIDAD_ID,
  PLAN_METHOD_ID,

  TRIAL_DAYS,
  TRIAL_DAYS_COMUNIDAD,
  IL_TRIAL_IMAGES,
  PROMO_FIRST_MONTH_PRICE,
  PLANES_REQUIERE_TARJETA,

  getCouponByPlan,
  getPromoPlans,
  tipoPlanUI,
  trialDiasParaPlan,
};
