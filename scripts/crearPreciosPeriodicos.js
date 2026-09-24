/**
 * Crea los precios semestral y anual de los planes públicos en Stripe, sobre
 * los MISMOS productos que ya tienen el precio mensual.
 *
 *   node scripts/crearPreciosPeriodicos.js            → solo muestra qué haría
 *   node scripts/crearPreciosPeriodicos.js --crear    → crea en TEST y en LIVE
 *
 * Regla comercial (2026-09-24): semestral = paga 5 meses y usa 6; anual =
 * paga 10 y usa 12. El plan de $29 (cursos) no entra: ya es un beneficio.
 * Es idempotente: si ya existe un precio activo con el mismo producto, monto
 * e intervalo, lo reutiliza y solo imprime el id.
 */
require('dotenv').config();
const Stripe = require('stripe');

const CREAR = process.argv.includes('--crear');

// id_plan → { mensual, producto por entorno }
const PLANES = {
  2: {
    nombre: 'ImporChat',
    mensual: 39,
    live: 'prod_SlolZjBX5tjL2j',
    test: 'prod_Tyl126Kw6TA0OJ',
  },
  3: {
    nombre: 'Pro Ecosistema',
    mensual: 49,
    live: 'prod_SlomnF2yHuppZs',
    test: 'prod_Tyl2kfdofnVEeo',
  },
  4: {
    nombre: 'Avanzado',
    mensual: 99,
    live: 'prod_SlopTsQkFeopji',
    test: 'prod_Tyl5tIKtLYAJil',
  },
  // Comunidad ($29, alumnos de cursos): mismo beneficio, pedido el 24-09.
  22: {
    nombre: 'Plan Comunidad',
    mensual: 29,
    live: 'prod_UD7tUjmWHos0Fg',
    test: 'prod_UFKFhRb95o253N',
  },
  // Planes TEST (16/17/18/23): filas de planes_chat_center que apuntan a los
  // productos de Stripe TEST y se usan para probar en local (se desbloquean
  // por usuario con unlocked_plans). Solo existen en test; `live: null`.
  16: {
    nombre: 'ImporChat TEST',
    mensual: 29,
    live: null,
    test: 'prod_Tyl126Kw6TA0OJ',
  },
  17: {
    nombre: 'Pro Ecosistema TEST',
    mensual: 49,
    live: null,
    test: 'prod_Tyl2kfdofnVEeo',
  },
  18: {
    nombre: 'Avanzado TEST',
    mensual: 99,
    live: null,
    test: 'prod_Tyl5tIKtLYAJil',
  },
  23: {
    nombre: 'Plan Comunidad TEST',
    mensual: 29,
    live: null,
    test: 'prod_UFKFhRb95o253N',
  },
};

const PERIODOS = {
  semestral: {
    meses: 6,
    pagados: 5,
    recurring: { interval: 'month', interval_count: 6 },
  },
  anual: {
    meses: 12,
    pagados: 10,
    recurring: { interval: 'year', interval_count: 1 },
  },
};

async function buscarExistente(stripe, product, unit_amount, recurring) {
  const list = await stripe.prices.list({ product, active: true, limit: 100 });
  return list.data.find(
    (p) =>
      p.unit_amount === unit_amount &&
      p.currency === 'usd' &&
      p.recurring?.interval === recurring.interval &&
      (p.recurring?.interval_count || 1) === recurring.interval_count,
  );
}

async function correr(entorno, key) {
  if (!key) {
    console.log(`\n[${entorno}] sin llave en .env, se omite`);
    return;
  }
  const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  console.log(`\n═══ ${entorno.toUpperCase()} ═══`);
  for (const [id_plan, plan] of Object.entries(PLANES)) {
    for (const [periodo, def] of Object.entries(PERIODOS)) {
      const unit_amount = plan.mensual * def.pagados * 100;
      const product = plan[entorno];
      if (!product) continue; // plan que no existe en este entorno
      const existente = await buscarExistente(
        stripe,
        product,
        unit_amount,
        def.recurring,
      );
      const etiqueta = `plan ${id_plan} ${plan.nombre} ${periodo} $${unit_amount / 100}`;
      if (existente) {
        console.log(`  = ${etiqueta} ya existe → ${existente.id}`);
        continue;
      }
      if (!CREAR) {
        console.log(`  + ${etiqueta} (se crearía sobre ${product})`);
        continue;
      }
      const price = await stripe.prices.create({
        product,
        currency: 'usd',
        unit_amount,
        recurring: def.recurring,
        nickname: `${plan.nombre} ${periodo} (${def.pagados} de ${def.meses} meses)`,
        metadata: {
          id_plan: String(id_plan),
          periodo,
          meses: String(def.meses),
        },
      });
      console.log(`  ✓ ${etiqueta} creado → ${price.id}`);
    }
  }
}

(async () => {
  console.log(
    CREAR ? 'Creando precios…' : 'Dry-run (sin --crear no se crea nada)',
  );
  await correr('test', process.env.STRIPE_SECRET_KEY_TEST);
  await correr('live', process.env.STRIPE_SECRET_KEY);
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
