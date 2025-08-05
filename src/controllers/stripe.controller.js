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
      allow_promotion_codes: true,
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

exports.obtenerSuscripcionActiva = async (req, res) => {
  try {
    const { id_usuario } = req.body;

    const [result] = await db.query(`
      SELECT 
        u.id_plan, 
        u.estado, 
        u.fecha_renovacion, 
        p.nombre_plan, 
        p.descripcion_plan, 
        p.precio_plan, 
        p.ahorro
      FROM usuarios_chat_center u
      JOIN planes_chat_center p ON u.id_plan = p.id_plan
      WHERE u.id_usuario = :id_usuario
      LIMIT 1
    `, {
      replacements: { id_usuario },
      type: db.QueryTypes.SELECT
    });

    if (!result) {
      return res.status(200).json({ plan: null });
    }

    const hoy = new Date();
    const fechaRenovacion = new Date(result.fecha_renovacion);

    // Verifica si ya caducó y actualiza estado si es necesario
    if (fechaRenovacion < hoy && result.estado === 'activo') {
      await db.query(`
        UPDATE usuarios_chat_center SET estado = 'inactivo' WHERE id_usuario = :id_usuario
      `, {
        replacements: { id_usuario }
      });

      result.estado = 'inactivo';
    }

    return res.status(200).json({ plan: result });
  } catch (err) {
    console.error("Error al obtener suscripción activa:", err);
    return res.status(500).json({ message: "Error interno al obtener la suscripción activa" });
  }
};






/* ver factura stripe */
exports.obtenerFacturasUsuario = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body.id_usuario;

    if (!id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Falta el id_usuario' });
    }

    const [results] = await db.query(`
      SELECT DISTINCT customer_id 
      FROM transacciones_stripe_chat 
      WHERE 
        id_usuario = ?
        AND customer_id IS NOT NULL
        AND id_pago IS NOT NULL
        AND estado_suscripcion IS NOT NULL
    `, { replacements: [id_usuario] });

    const customerIds = results?.map(r => r.customer_id).filter(Boolean);

    if (!customerIds || customerIds.length === 0) {
      return res.status(404).json({ status: 'fail', message: 'No se encontraron clientes válidos para este usuario' });
    }

    const allInvoices = [];

    for (const customerId of customerIds) {
      const invoices = await stripe.invoices.list({
        customer: customerId,
        limit: 100,
      });

      allInvoices.push(...invoices.data);
    }

    // Ordenamos por fecha descendente
    allInvoices.sort((a, b) => b.created - a.created);

    res.status(200).json({ status: 'success', data: allInvoices });
  } catch (error) {
    console.error("❌ Error al obtener facturas:", error);
    res.status(500).json({ status: 'fail', message: 'Error al obtener facturas' });
  }
};





/* cancelar suscripcion / cancelar pago automatico stripe */
exports.cancelarSuscripcion = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body.id_usuario;

    // 1. Buscar la suscripción activa más reciente del usuario
    const [result] = await db.query(`
      SELECT id_suscripcion FROM transacciones_stripe_chat 
      WHERE id_usuario = ? AND estado_suscripcion = 'active'
      ORDER BY fecha DESC LIMIT 1
    `, { replacements: [id_usuario] });


    const idSuscripcion = result?.[0]?.id_suscripcion;

    if (!idSuscripcion) {
      return res.status(404).json({ status: 'fail', message: 'No hay suscripción activa' });
    }

    // 2. Cancelar en Stripe al finalizar el período actual
    await stripe.subscriptions.update(idSuscripcion, {
      cancel_at_period_end: true,
    });

    // 3. Opcional: registrar en tu base de datos que está pendiente de cancelación
    await db.query(`
      UPDATE transacciones_stripe_chat 
      SET estado_suscripcion = 'cancelando' 
      WHERE id_suscripcion = ?
    `, { replacements: [idSuscripcion] });

    res.status(200).json({
      status: 'success',
      message: 'La suscripción se cancelará al finalizar el periodo actual.',
    });
  } catch (error) {
    console.error("Error al cancelar suscripción:", error);
    res.status(500).json({
      status: 'fail',
      message: 'Error al cancelar la suscripción',
    });
  }
};



