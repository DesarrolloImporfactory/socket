const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const { db } = require('../database/config');
/**
 * Lista los planes permitidos de Stripe (filtrados por priceId)
 */
exports.listarPlanesStripe = async (req, res) => {
  try {
    const planesDB = await Planes_chat_center.findAll({
      attributes: ['id_plan', 'nombre_plan', 'id_product_stripe', 'descripcion_plan', 'precio_plan']
    });

    if (!planesDB || planesDB.length === 0) {
      return res.status(404).json({ status: 'fail', message: 'No hay planes configurados en la base de datos' });
    }

    const prices = await stripe.prices.list({
      expand: ['data.product'],
      active: true,
      limit: 100,
    });

    const stripePriceIds = planesDB.map(p => p.id_product_stripe);
    const filteredStripePlans = prices.data.filter(p => stripePriceIds.includes(p.id));

    const resultado = planesDB.map(plan => {
      const stripeInfo = filteredStripePlans.find(s => s.id === plan.id_product_stripe);
      return {
        id_plan: plan.id_plan,
        nombre_plan: plan.nombre_plan,
        descripcion: plan.descripcion_plan,
        precio_local: plan.precio_plan,
        stripe_price_id: plan.id_product_stripe,
        stripe_price: stripeInfo?.unit_amount,
        stripe_interval: stripeInfo?.recurring?.interval,
        stripe_product_name: stripeInfo?.product?.name,
      };
    });

    res.status(200).json({ status: 'success', data: resultado });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'fail', message: 'Error al listar los planes' });
  }
};

/**
 * Crea una sesión de Stripe Checkout para un usuario y plan específico
 */
exports.crearSesionPago = async (req, res) => {
  try {
    const { id_plan, success_url, cancel_url, id_usuario, id_users } = req.body;
    const userId = id_usuario || id_users;

    if (!id_plan || !userId || !success_url || !cancel_url) {
      return res.status(400).json({
        status: "fail",
        message: "Faltan datos necesarios (id_plan, id_usuario, success_url o cancel_url)",
      });
    }

    const usuario = await Usuarios_chat_center.findByPk(userId);
    if (!usuario) {
      return res.status(404).json({
        status: "fail",
        message: "Usuario no encontrado",
      });
    }

    if (usuario.estado === 'activo' && usuario.fecha_renovacion > new Date()) {
      return res.status(400).json({
        status: "fail",
        message: "Ya tienes un plan activo. No puedes crear una nueva sesión de pago hasta que expire.",
      });
    }

    const plan = await Planes_chat_center.findOne({ where: { id_plan } });

    if (!plan || !plan.id_product_stripe) {
      return res.status(404).json({
        status: "fail",
        message: "Plan no encontrado o no tiene ID de producto Stripe configurado",
      });
    }

    //  Aquí va la corrección clave
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: plan.id_product_stripe, quantity: 1 }],
      success_url,
      cancel_url,
      subscription_data: {
        metadata: {
          id_usuario: userId.toString(),
          id_plan: id_plan.toString(),
        }
      }
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error("Error al crear sesión de Stripe:", error);
    return res.status(500).json({ status: "fail", message: error.message });
  }
};

