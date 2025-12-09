const catchAsync = require('../utils/catchAsync');
const planes_chat_center = require('../models/planes_chat_center.model');
const AppError = require('../utils/appError');
const stripe = require('stripe')(process.env.STRIPE_V2_SECRET_KEY);
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
    id_price: price.id,
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

exports.editarProducto = catchAsync(async (req, res, next) => {
  const {
    nombre,
    descripcion,
    n_conversaciones,
    n_conexiones,
    max_subusuarios,
    max_conexiones,
    id_producto,
  } = req.body;

  const producto = await stripe.products.update(id_producto, {
    name: nombre,
    description: descripcion,
  });

  const planABuscar = await planes_chat_center.findOne({
    where: {
      id_product_stripe: id_producto,
    },
  });

  if (!planABuscar) {
    return next(new AppError('Plan not found', 404));
  }

  const planActualizado = await planes_chat_center.update(
    {
      nombre_plan: nombre,
      descripcion_plan: descripcion,
      n_conversaciones,
      n_conexiones,
      max_subusuarios,
      max_conexiones,
    },
    {
      where: { id_product_stripe: id_producto },
      returning: true,
    }
  );

  res.json({
    status: true,
    data: {
      producto,
      plan_db: planActualizado,
    },
    message: 'Producto actualizado exitosamente',
  });
});

exports.eliminarProducto = catchAsync(async (req, res, next) => {
  const { id_producto } = req.body;

  // Archivar el producto en Stripe
  const productoArchivado = await stripe.products.update(id_producto, {
    active: false,
  });

  // Desactivar el plan en la base de datos
  await planes_chat_center.update(
    { activo: false },
    { where: { id_product_stripe: id_producto } }
  );

  res.json({
    status: true,
    data: productoArchivado,
    message: 'Producto eliminado exitosamente',
  });
});

exports.activarProducto = catchAsync(async (req, res, next) => {
  const { id_producto } = req.body;

  // Activar el producto en Stripe
  const productoActivado = await stripe.products.update(id_producto, {
    active: true,
  });
  // Activar el plan en la base de datos
  await planes_chat_center.update(
    { activo: true },
    { where: { id_product_stripe: id_producto } }
  );
  res.json({
    status: true,
    data: productoActivado,
    message: 'Producto activado exitosamente',
  });
});

exports.listarProductos = catchAsync(async (req, res, next) => {
  const productos = await planes_chat_center.findAll();

  res.json({
    status: true,
    data: productos,
    message: 'Productos obtenidos exitosamente',
  });
});

exports.eliminarPrecio = catchAsync(async (req, res, next) => {
  const { id_price, id_producto, new_amount, tipo_membresia } = req.body;

  // ✅ Convertir a número y validar
  const precioNumerico = parseFloat(new_amount);

  if (isNaN(precioNumerico) || precioNumerico <= 0) {
    return next(
      new AppError('El precio debe ser un número válido mayor a 0', 400)
    );
  }

  const oldPrice = await stripe.prices.update(id_price, {
    active: false,
  });

  const selected = intervalMapping[tipo_membresia];

  if (!selected) {
    return next(new AppError('Tipo de membresía inválido', 400));
  }

  const newPrice = await stripe.prices.create({
    unit_amount: Math.round(precioNumerico * 100), // ✅ Redondear para evitar decimales
    currency: oldPrice.currency,
    product: id_producto,
    recurring: {
      interval: selected.interval,
      interval_count: selected.interval_count,
    },
  });

  await planes_chat_center.update(
    {
      precio_plan: precioNumerico, // ✅ Usar número parseado
      id_price: newPrice.id,
      duracion_plan: selected.dias, // ✅ Actualizar duración en días
    },
    {
      where: { id_product_stripe: id_producto },
      returning: true,
    }
  );

  const newPriceForProduct = await stripe.products.update(id_producto, {
    default_price: newPrice.id,
  });

  res.json({
    status: true,
    data: {
      oldPrice: {
        id: oldPrice.id,
        amount: oldPrice.unit_amount / 100,
        active: oldPrice.active,
      },
      newPrice: {
        id: newPrice.id,
        amount: newPrice.unit_amount / 100,
        currency: newPrice.currency,
        interval: newPrice.recurring.interval,
        interval_count: newPrice.recurring.interval_count,
      },
      duracion_dias: selected.dias,
    },
    message: 'Precio actualizado exitosamente',
  });
});
