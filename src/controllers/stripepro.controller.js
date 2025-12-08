const catchAsync = require('../utils/catchAsync');
const planes_chat_center = require('../models/planes_chat_center.model');
const stripe = require('stripe')(process.env.STRIPE_V2_SECRET_KEY);

exports.crearProducto = catchAsync(async (req, res, next) => {
  const {
    nombre,
    descripcion,
    precio,
    tipo_membresia,
    moneda = 'usd',
    n_conversaciones,
    n_conexiones,
    max_subusuarios,
    max_conexiones,
    ahorro = 0,
  } = req.body;

  const intervalMapping = {
    diario: { interval: 'day', interval_count: 1, dias: 1 },
    semanal: { interval: 'week', interval_count: 1, dias: 7 },
    mensual: { interval: 'month', interval_count: 1, dias: 30 },
    anual: { interval: 'year', interval_count: 1, dias: 365 },
    cada_3_meses: { interval: 'month', interval_count: 3, dias: 90 },
    cada_6_meses: { interval: 'month', interval_count: 6, dias: 180 },
    personalizado_14_dias: { interval: 'day', interval_count: 14, dias: 14 },
    personalizado_2_semanas: { interval: 'week', interval_count: 2, dias: 14 },
  };

  const selected = intervalMapping[tipo_membresia];

  // Crear producto
  const producto = await stripe.products.create({
    name: nombre,
    description:
      descripcion ?? 'Producto creado desde la integración de Stripe Pro',
  });

  // Crear precio para el producto
  const price = await stripe.prices.create({
    unit_amount: precio * 100, // Stripe usa centavos
    currency: moneda,
    product: producto.id,
    recurring: {
      interval: selected.interval,
      interval_count: selected.interval_count,
    },
  });

  const nuevoPlan = await planes_chat_center.create({
    nombre_plan: nombre,
    descripcion_plan: descripcion,
    precio_plan: precio,
    n_conversaciones,
    n_conexiones,
    max_subusuarios,
    max_conexiones,
    duracion_plan: selected.dias,
    ahorro,
    id_product_stripe: producto.id,
  });

  res.json({
    status: true,
    data: {
      producto: {
        id: producto.id,
        name: producto.name,
        description: producto.description,
      },
      precio: {
        id: price.id,
        amount: price.unit_amount / 100,
        currency: price.currency,
        interval: price.recurring.interval,
      },
      plan_db: nuevoPlan,
    },
    message: 'Producto creado exitosamente',
  });
});
