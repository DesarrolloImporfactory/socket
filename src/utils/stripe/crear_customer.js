const Stripe = require('stripe');

/* =========================
   Selección automática de variables por entorno (production vs test)
========================= */
const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// En producción => PROD; en no-prod => TEST (si no existe, cae a PROD)
const envPick = (prodKey, testKey, fallback = '') => {
  const prodVal = process.env[prodKey];
  const testVal = process.env[testKey];
  if (isProd) return prodVal ?? fallback;
  return testVal ?? prodVal ?? fallback;
};

const STRIPE_SECRET = envPick('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST');

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

async function crearStripeCustomer({ nombre, email, id_usuario }) {
  if (!email) {
    return {
      ok: false,
      code: 'EMAIL_REQUIRED',
      message: 'El email es requerido',
    };
  }

  try {
    // 1) Buscar si ya existe customer con ese email en Stripe
    const existentes = await stripe.customers.list({ email, limit: 1 });
    const customerExistente = existentes.data?.[0];

    // 2) Si ya existe en Stripe → REUTILIZARLO
    //    (en este punto del flujo ya validamos que NO existe en usuarios_chat_center,
    //     entonces es seguro asociarlo al nuevo usuario que estamos creando)
    if (customerExistente) {
      // Actualizar metadata para que apunte al nuevo id_usuario de chatcenter
      try {
        await stripe.customers.update(customerExistente.id, {
          name: customerExistente.name || nombre,
          metadata: {
            ...(customerExistente.metadata || {}),
            id_usuario: String(id_usuario),
            reusado_en: new Date().toISOString(),
          },
        });
      } catch (e) {
        // Si falla el update de metadata no es bloqueante, solo lo logueamos
        console.warn(
          `crearStripeCustomer: no se pudo actualizar metadata del customer ${customerExistente.id} —`,
          e.message,
        );
      }

      return {
        ok: true,
        id_customer: customerExistente.id,
        reused: true, // bandera por si quieres loguear/auditar después
      };
    }

    // 3) Si no existe → crear nuevo
    const customer = await stripe.customers.create({
      name: nombre,
      email,
      metadata: { id_usuario: String(id_usuario) },
    });

    return { ok: true, id_customer: customer.id, reused: false };
  } catch (err) {
    console.error('crearStripeCustomer: error con Stripe —', err.message);
    return {
      ok: false,
      code: 'STRIPE_API_ERROR',
      message: err.message || 'Error al comunicarse con Stripe',
    };
  }
}

async function obtenerOCrearStripeCustomer({ nombre, email, id_usuario }) {
  if (!email) throw new Error('email es requerido');

  // 1) Buscar customers por email
  const existentes = await stripe.customers.list({
    email,
    limit: 1,
  });

  const customerExistente = existentes.data?.[0];

  if (customerExistente) {
    return customerExistente.id;
  }

  // 2) Si no existe, crear
  const nuevo = await stripe.customers.create({
    name: nombre,
    email,
    metadata: { id_usuario: String(id_usuario) },
  });

  return nuevo.id;
}

module.exports = {
  crearStripeCustomer,
  obtenerOCrearStripeCustomer,
};
