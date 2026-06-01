require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

(async () => {
  console.log('🔍 DIAGNÓSTICO STRIPE ↔ BD\n');

  // 1) Trae TODAS las subs activas de Stripe (paginado)
  console.log('Cargando suscripciones de Stripe...');
  const stripeSubs = [];
  for await (const sub of stripe.subscriptions.list({
    status: 'all',
    limit: 100,
    expand: ['data.customer'],
  })) {
    stripeSubs.push(sub);
  }
  console.log(`Total subs en Stripe (todos los estados): ${stripeSubs.length}`);

  const stripeActivas = stripeSubs.filter((s) =>
    ['active', 'trialing', 'past_due'].includes(s.status),
  );
  console.log(
    `Subs ACTIVAS/TRIALING/PAST_DUE en Stripe: ${stripeActivas.length}\n`,
  );

  // 2) Trae todos los usuarios de BD con stripe_subscription_id
  const usuariosBD = await db.query(
    `SELECT u.id_usuario, u.email_propietario, u.nombre, u.estado, u.id_plan,
            u.stripe_subscription_id, u.stripe_subscription_status, u.permanente,
            p.nombre_plan, p.precio_plan
       FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.stripe_subscription_id IS NOT NULL`,
    { type: db.QueryTypes.SELECT },
  );

  // Crear maps para cruce
  const bdPorSubId = new Map();
  usuariosBD.forEach((u) => bdPorSubId.set(u.stripe_subscription_id, u));

  const stripePorSubId = new Map();
  stripeSubs.forEach((s) => stripePorSubId.set(s.id, s));

  // ════════ ANÁLISIS A: Stripe → BD ════════
  console.log('═══════════════════════════════════════════════');
  console.log('A) SUBS ACTIVAS EN STRIPE');
  console.log('═══════════════════════════════════════════════\n');

  let mrrStripeReal = 0;
  const mismatch = [];
  const noEnBD = [];

  for (const sub of stripeActivas) {
    const customer = sub.customer;
    const email = customer?.email || '(sin email)';
    const mensual = sub.items.data.reduce(
      (acc, it) => acc + (it.price.unit_amount || 0) / 100,
      0,
    );

    if (sub.status === 'active') mrrStripeReal += mensual;

    const bdUser = bdPorSubId.get(sub.id);

    if (!bdUser) {
      noEnBD.push({ email, sub_id: sub.id, status: sub.status, mensual });
    } else if (bdUser.stripe_subscription_status !== sub.status) {
      mismatch.push({
        email,
        nombre: bdUser.nombre,
        id_usuario: bdUser.id_usuario,
        sub_id: sub.id,
        bd_status: bdUser.stripe_subscription_status,
        stripe_status: sub.status,
        bd_plan: bdUser.nombre_plan || 'SIN PLAN',
        mensual,
      });
    }
  }

  console.log(
    `MRR real Stripe (sumando active): $${mrrStripeReal.toFixed(2)}\n`,
  );

  if (noEnBD.length > 0) {
    console.log(`⚠️  ${noEnBD.length} SUBS EN STRIPE PERO NO EN BD:\n`);
    noEnBD.forEach((x) => {
      console.log(
        `   - ${x.email} | sub: ${x.sub_id} | $${x.mensual} ${x.status}`,
      );
    });
    console.log('');
  }

  if (mismatch.length > 0) {
    console.log(
      `⚠️  ${mismatch.length} SUBS CON ESTADO DIFERENTE ENTRE STRIPE Y BD:\n`,
    );
    mismatch.forEach((x) => {
      console.log(
        `   - #${x.id_usuario} ${x.email} | ${x.bd_plan} | BD: ${x.bd_status} → Stripe: ${x.stripe_status} | $${x.mensual}`,
      );
    });
    console.log('');
  }

  // ════════ ANÁLISIS B: BD → Stripe ════════
  console.log('═══════════════════════════════════════════════');
  console.log('B) USUARIOS BD CON stripe_subscription_status="active"');
  console.log('═══════════════════════════════════════════════\n');

  const bdActivos = usuariosBD.filter(
    (u) => u.stripe_subscription_status === 'active' && u.permanente === 0,
  );

  const huerfanos = [];
  const realmenteCanceladosEnStripe = [];
  let mrrBD = 0;

  for (const u of bdActivos) {
    mrrBD += Number(u.precio_plan || 0);
    const sub = stripePorSubId.get(u.stripe_subscription_id);
    if (!sub) {
      huerfanos.push(u);
    } else if (sub.status !== 'active') {
      realmenteCanceladosEnStripe.push({ ...u, real_status: sub.status });
    }
  }

  console.log(
    `MRR según BD (sumando precio_plan de activos no-permanente): $${mrrBD.toFixed(2)}`,
  );
  console.log(
    `Diferencia BD vs Stripe: $${(mrrBD - mrrStripeReal).toFixed(2)}\n`,
  );

  if (huerfanos.length > 0) {
    console.log(
      `❌ ${huerfanos.length} USUARIOS BD CON SUB QUE NO EXISTE EN STRIPE (cancelar):\n`,
    );
    huerfanos.forEach((u) => {
      console.log(
        `   - #${u.id_usuario} ${u.email_propietario} | ${u.nombre_plan} $${u.precio_plan} | sub: ${u.stripe_subscription_id}`,
      );
    });
    console.log('');
  }

  if (realmenteCanceladosEnStripe.length > 0) {
    console.log(
      `❌ ${realmenteCanceladosEnStripe.length} USUARIOS BD ACTIVOS PERO REALMENTE ${'<algo distinto>'} EN STRIPE:\n`,
    );
    realmenteCanceladosEnStripe.forEach((u) => {
      console.log(
        `   - #${u.id_usuario} ${u.email_propietario} | ${u.nombre_plan} $${u.precio_plan} | BD:active → Stripe:${u.real_status}`,
      );
    });
    console.log('');
  }

  // ════════ ANÁLISIS C: Sin plan asignado ════════
  const sinPlan = bdActivos.filter((u) => !u.id_plan);
  if (sinPlan.length > 0) {
    console.log('═══════════════════════════════════════════════');
    console.log('C) USUARIOS BD CON STRIPE ACTIVE PERO SIN PLAN ASIGNADO');
    console.log('═══════════════════════════════════════════════\n');
    sinPlan.forEach((u) => {
      const sub = stripePorSubId.get(u.stripe_subscription_id);
      const priceId = sub?.items.data[0]?.price?.id || 'N/A';
      console.log(
        `   - #${u.id_usuario} ${u.email_propietario} | sub: ${u.stripe_subscription_id} | price_id Stripe: ${priceId}`,
      );
    });
    console.log('\nAcción: asignar id_plan según price_id Stripe.\n');
  }

  // ════════ RESUMEN ════════
  console.log('═══════════════════════════════════════════════');
  console.log('RESUMEN');
  console.log('═══════════════════════════════════════════════');
  console.log(
    `Stripe activas:           ${stripeActivas.filter((s) => s.status === 'active').length}`,
  );
  console.log(
    `Stripe trialing:          ${stripeActivas.filter((s) => s.status === 'trialing').length}`,
  );
  console.log(`BD active no-permanente:  ${bdActivos.length}`);
  console.log(`Huérfanos (BD sin Stripe): ${huerfanos.length}`);
  console.log(`Estado distinto:           ${mismatch.length}`);
  console.log(`Sin plan asignado:         ${sinPlan.length}`);
  console.log(`MRR Stripe real:           $${mrrStripeReal.toFixed(2)}`);
  console.log(`MRR BD:                    $${mrrBD.toFixed(2)}`);
  console.log('═══════════════════════════════════════════════');

  process.exit(0);
})();
