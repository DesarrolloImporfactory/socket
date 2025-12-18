const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const stripe = require('stripe')(process.env.STRIPE_V2_SECRET_KEY);

const { getPlanById } = require('../services/planes_chat_center.service');

function appendSessionId(url) {
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}session_id={CHECKOUT_SESSION_ID}`;
}

exports.crearSesionPago = catchAsync(async (req, res, next) => {
  const { id_plan, id_usuario, id_costumer, success_url, cancel_url, email } =
    req.body;

  if (!id_plan || !id_usuario || !success_url || !cancel_url) {
    return next(
      new AppError(
        'Faltan campos requeridos: id_plan, id_usuario, success_url, cancel_url.',
        400
      )
    );
  }

  // 1) Buscar plan en DB
  const plan = await getPlanById(id_plan);

  if (!plan) {
    return next(new AppError('No se encontró el plan solicitado.', 404));
  }

  if (!plan.id_price) {
    return next(
      new AppError(
        'El plan no tiene id_price configurado en planes_chat_center.',
        500
      )
    );
  }

  // 2) Determinar mode según Price
  const price = await stripe.prices.retrieve(plan.id_price);
  const mode = price.type === 'recurring' ? 'subscription' : 'payment';

  // 3) Crear Checkout Session
  const session = await stripe.checkout.sessions.create({
    mode,

    customer: id_costumer || undefined,
    customer_email: !id_costumer ? email || undefined : undefined,

    line_items: [{ price: plan.id_price, quantity: 1 }],

    success_url: appendSessionId(success_url),
    cancel_url,

    client_reference_id: String(id_usuario),

    metadata: {
      id_plan: String(id_plan),
      id_usuario: String(id_usuario),
      id_costumer: id_costumer ? String(id_costumer) : '',
    },

    subscription_data:
      mode === 'subscription'
        ? {
            metadata: {
              id_plan: String(id_plan),
              id_usuario: String(id_usuario),
            },
          }
        : undefined,

    billing_address_collection: 'auto',
    allow_promotion_codes: true,
  });

  return res.status(200).json({
    status: 200,
    url: session.url,
    session_id: session.id,
    mode,
  });
});
