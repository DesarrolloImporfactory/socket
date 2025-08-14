const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const { db } = require('../database/config');



// ⚠️ CORREGIDO: sin "active" en list() ni en create()
async function ensurePortalConfigurationId() {
  // 1) Usa env si lo definiste
  if (process.env.STRIPE_PORTAL_CONFIGURATION_ID) {
    return process.env.STRIPE_PORTAL_CONFIGURATION_ID;
  }

  // 2) Busca cualquier configuración existente (la primera vale)
  const existing = await stripe.billingPortal.configurations.list({ limit: 1 });
  if (existing.data?.length) return existing.data[0].id;

  // 3) Crea una configuración mínima con "Manage payment methods" habilitado
  const created = await stripe.billingPortal.configurations.create({
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      // agrega más si quieres:
      // subscription_cancel: { enabled: false },
      // subscription_update: { enabled: false },
      // customer_update: { enabled: false },
    }
    // business_profile: { privacy_policy_url: '...', terms_of_service_url: '...' } // opcional
  });
  return created.id;
}

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
// controllers/stripe.controller.js
exports.obtenerFacturasUsuario = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body.id_usuario;
    if (!id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Falta el id_usuario' });
    }

    // Trae los últimos customers usados por el usuario (más recientes primero)
    const [rows] = await db.query(`
      SELECT DISTINCT customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
        AND customer_id IS NOT NULL
      ORDER BY fecha DESC
      LIMIT 5
    `, { replacements: [id_usuario] });

    const customerIds = [...new Set((rows || []).map(r => r.customer_id).filter(Boolean))];
    if (customerIds.length === 0) {
      // No rompas el front: devuelve lista vacía con 200
      return res.status(200).json({ status: 'success', data: [] });
    }

    const allInvoices = [];

    for (const customerId of customerIds) {
      try {
        // (Opcional) valida que el customer exista en el modo actual
        await stripe.customers.retrieve(customerId);

        const invoices = await stripe.invoices.list({
          customer: customerId,
          limit: 100,
          // status: 'paid', // si solo quieres pagadas
        });
        allInvoices.push(...invoices.data);
      } catch (e) {
        // Si el customer no existe en este modo (o fue borrado), lo saltamos
        const code = e?.raw?.code || e?.code;
        const msg = e?.raw?.message || e?.message;
        if (code === 'resource_missing' || /No such customer/i.test(msg)) {
          console.warn(`[facturasUsuario] customer inválido u obsoleto: ${customerId} -> ${msg}`);
          continue;
        }
        // Otros errores sí deben propagarse
        throw e;
      }
    }

    // Ordena por fecha DESC y responde OK (aunque sea vacío)
    allInvoices.sort((a, b) => b.created - a.created);
    return res.status(200).json({ status: 'success', data: allInvoices });
  } catch (error) {
    console.error("❌ Error al obtener facturas:", error?.raw?.message || error.message);
    return res.status(500).json({
      status: 'fail',
      message: error?.raw?.message || 'Error al obtener facturas'
    });
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


// stripe.controller.js
exports.crearSesionSetupPM = async (req, res) => {
  try {
    const { id_usuario } = req.body;
    if (!id_usuario) return res.status(400).json({ message: 'Falta id_usuario' });

    // 1) Resuelve el customer de Stripe del usuario (último que tengas en tu tabla)
    const [rows] = await db.query(`
      SELECT customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
        AND customer_id IS NOT NULL
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [id_usuario] });

    let customerId = rows?.[0]?.customer_id;

    // Si aún no tuviera customer, créalo
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { id_usuario: String(id_usuario) }
      });
      customerId = customer.id;

      // Guarda una fila mínima para poder referenciarlo después
      await db.query(`
        INSERT INTO transacciones_stripe_chat (id_usuario, customer_id, fecha)
        VALUES (?, ?, NOW())
      `, { replacements: [id_usuario, customerId] });
    }

    // 2) Crea la sesión de Checkout en modo setup (tarjeta para uso futuro/off_session)
    const baseUrl = req.headers.origin || req.headers.referer?.split('/').slice(0, 3).join('/');
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      payment_method_types: ['card'],
      customer: customerId,
      success_url: `${baseUrl}/miplan?setup=ok`,
      cancel_url: `${baseUrl}/miplan?setup=cancel`,
      setup_intent_data: {
        usage: 'off_session', // importante para cobros automáticos
        metadata: { id_usuario: String(id_usuario) }
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Error crearSesionSetupPM:', err);
    return res.status(500).json({ message: 'No se pudo crear la sesión de setup' });
  }
};


/* Guardar metodo de pago */
exports.portalAddPaymentMethod = async (req, res) => {
  try {
    const { id_usuario, id_users } = req.body;
    const userId = id_usuario || id_users;
    if (!userId) return res.status(400).json({ message: 'Falta id_usuario' });

    const baseUrl =
      req.headers.origin ||
      req.headers.referer?.split('/').slice(0, 3).join('/'); // tu front en dev; en prod puedes omitir este fallback

    // 1) Resolver customer
    const [rows] = await db.query(`
      SELECT customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
        AND customer_id IS NOT NULL
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [userId] });

    const customerId = rows?.[0]?.customer_id;
    if (!customerId) return res.status(404).json({ message: 'No hay customer para este usuario' });

    // 2) Asegura una configuración del portal (test o live según tu secret key)
    const configurationId = await ensurePortalConfigurationId();

    // 3) Crea la sesión del portal directamente en el flujo de “agregar/actualizar método”
    let session;
    try {
      session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        configuration: configurationId,     // <- clave
        return_url: `${baseUrl}/miplan`,
        flow_data: {
          type: 'payment_method_update',
          after_completion: {
            type: 'redirect',
            redirect: { return_url: `${baseUrl}/miplan?pm_saved=1` }
          }
        }
      });
    } catch (e) {
      // Si tu cuenta/API no soporta flow_data, cae al portal “genérico”
      console.warn('Portal flow_data no disponible. Fallback al portal básico:', e?.raw?.message || e.message);
      session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        configuration: configurationId,
        return_url: `${baseUrl}/miplan`
      });
    }

    return res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe error (portalAddPaymentMethod):', error);
    return res.status(500).json({
      status: 'fail',
      message: error?.raw?.message || error.message || 'No se pudo crear la sesión del portal'
    });
  }
};

/* mostrar metodos de pago */
exports.portalGestionMetodos = async (req, res) => {
  try {
    const { id_usuario, id_users } = req.body;
    const userId = id_usuario || id_users;
    if (!userId) return res.status(400).json({ message: 'Falta id_usuario' });

    const baseUrl =
      req.headers.origin ||
      req.headers.referer?.split('/').slice(0, 3).join('/');

    const [rows] = await db.query(`
      SELECT customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
        AND customer_id IS NOT NULL
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [userId] });
    const customerId = rows?.[0]?.customer_id;
    if (!customerId) return res.status(404).json({ message: 'No hay customer' });

    // Usa la misma ensurePortalConfigurationId() que ya hicimos antes
    const configurationId = await ensurePortalConfigurationId();

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: configurationId,
      return_url: `${baseUrl}/miplan`
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('portalGestionMetodos:', e);
    res.status(500).json({ message: e?.raw?.message || e.message });
  }
};


