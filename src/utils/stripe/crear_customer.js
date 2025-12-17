import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

export async function crearStripeCustomer({ nombre, email, id_usuario }) {
  if (!email) {
    return {
      ok: false,
      code: 'EMAIL_REQUIRED',
      message: 'El email es requerido',
    };
  }

  // Buscar si ya existe customer con ese email
  const existentes = await stripe.customers.list({ email, limit: 1 });

  if (existentes.data.length > 0) {
    return {
      ok: false,
      code: 'STRIPE_CUSTOMER_EMAIL_EXISTS',
      message: `Ya existe un cliente en Stripe con el email: ${email}`,
    };
  }

  // Crear si no existe
  const customer = await stripe.customers.create({
    name: nombre,
    email,
    metadata: { id_usuario: String(id_usuario) },
  });

  return { ok: true, id_customer: customer.id };
}

export async function obtenerOCrearStripeCustomer({
  nombre,
  email,
  id_usuario,
}) {
  if (!email) throw new Error('email es requerido');

  // 1) Buscar customers por email
  const existentes = await stripe.customers.list({
    email,
    limit: 1, // trae el más reciente primero (por defecto suele venir ordenado desc por creación)
  });

  const customerExistente = existentes.data?.[0];

  if (customerExistente) {
    // (Opcional) Si quieres asegurar metadata/id_usuario cuando ya existe:
    // await stripe.customers.update(customerExistente.id, {
    //   name: customerExistente.name ?? nombre,
    //   metadata: {
    //     ...customerExistente.metadata,
    //     id_usuario: String(id_usuario),
    //   },
    // });

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
