const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const { db } = require('../database/config');

// Price del addon de conexión y subusuario(fijo, según me diste)
const ADDON_PRICE_ID = 'price_1Ryc0gClsPjxVwZwQQwt7YM0';
const PRICE_ID_ADDON_SUBUSUARIO = 'price_1Ryc5EClsPjxVwZwyApbVKbr';


// CORREGIDO: sin "active" en list() ni en create()
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
// controllers/stripe.controller.js
exports.crearSesionPago = async (req, res) => {
  try {
    const { id_plan, success_url, cancel_url, id_usuario, id_users } = req.body;
    const userId = id_usuario || id_users;

    if (!id_plan || !userId) {
      return res.status(400).json({
        status: "fail",
        message: "Faltan datos necesarios (id_plan, id_usuario)",
      });
    }

    // Usuario + plan destino (DB)
    const usuario = await Usuarios_chat_center.findByPk(userId);
    if (!usuario) {
      return res.status(404).json({ status: "fail", message: "Usuario no encontrado" });
    }

    const nuevoPlan = await Planes_chat_center.findOne({ where: { id_plan } });
    if (!nuevoPlan || !nuevoPlan.id_product_stripe) {
      return res.status(404).json({
        status: "fail",
        message: "Plan no encontrado o sin priceId de Stripe (id_product_stripe)",
      });
    }

    if (!success_url || !cancel_url) {
      return res.status(400).json({
        status: "fail",
        message: "Faltan success_url y cancel_url para crear la sesión de pago",
      });
    }

    const hoy = new Date();

    // ─────────────────────────────────────────────────────────────
    // A) Tiene plan ACTIVO → cobrar diferencia via Checkout (mode: 'payment')
    // ─────────────────────────────────────────────────────────────
    if (usuario.estado === "activo" && usuario.fecha_renovacion > hoy) {
      // Resolver suscripción y customer
      let subscriptionId = null;
      let customerId = null;

      const [rows] = await db.query(`
        SELECT id_suscripcion, customer_id
        FROM transacciones_stripe_chat
        WHERE id_usuario = ? AND estado_suscripcion = 'active'
        ORDER BY fecha DESC LIMIT 1
      `, { replacements: [userId] });

      subscriptionId = rows?.[0]?.id_suscripcion || null;
      customerId = rows?.[0]?.customer_id || null;

      if (!subscriptionId) {
        if (!customerId) {
          const [r2] = await db.query(`
            SELECT customer_id
            FROM transacciones_stripe_chat
            WHERE id_usuario = ? AND customer_id IS NOT NULL
            ORDER BY fecha DESC LIMIT 1
          `, { replacements: [userId] });
          customerId = r2?.[0]?.customer_id || null;
        }
        if (!customerId) {
          return res.status(400).json({ status: "fail", message: "No se pudo resolver el customer del usuario" });
        }
        const subs = await stripe.subscriptions.list({ customer: customerId, status: "active", limit: 1 });
        subscriptionId = subs.data?.[0]?.id || null;
      }

      if (!subscriptionId) {
        return res.status(400).json({
          status: "fail",
          message: "No se encontró una suscripción activa para aplicar el upgrade",
        });
      }

      // Traer sub + price actual (y producto) para armar el detalle
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price", "items.data.price.product"],
      });

      const currentItem = subscription.items.data[0];
      const currentPrice = currentItem?.price;
      if (!currentItem?.id || !currentPrice?.id) {
        return res.status(400).json({
          status: "fail",
          message: "No se pudo identificar el item/price actual de la suscripción",
        });
      }

      // Price destino desde Stripe
      const targetPrice = await stripe.prices.retrieve(nuevoPlan.id_product_stripe);

      // Validaciones (intervalo/moneda iguales)
      const currentInterval = currentPrice?.recurring?.interval;
      const targetInterval  = targetPrice?.recurring?.interval;
      const currentCurrency = currentPrice?.currency;
      const targetCurrency  = targetPrice?.currency;

      if (currentInterval !== targetInterval) {
        return res.status(400).json({
          status: "fail",
          message: `El intervalo actual (${currentInterval}) y el nuevo (${targetInterval}) no coincide.`,
        });
      }
      if (currentCurrency !== targetCurrency) {
        return res.status(400).json({
          status: "fail",
          message: `La moneda actual (${currentCurrency}) y la nueva (${targetCurrency}) no coincide.`,
        });
      }

      // Preview de prorrateo (delta real)
      let delta = 0;
      let preview = null;
      try {
        preview = await stripe.invoices.retrieveUpcoming({
          customer: subscription.customer,
          subscription: subscriptionId,
          subscription_items: [{ id: currentItem.id, price: targetPrice.id }],
        });
        delta = Math.max(0, Number(preview?.amount_due || 0));
      } catch (e) {
        console.warn("No se pudo obtener preview de prorrateo:", e?.raw?.message || e.message);
      }

      // Fallback: diferencia fija del price
      const currentAmount = Number(currentPrice.unit_amount || 0); // centavos
      const targetAmount  = Number(targetPrice.unit_amount || 0);  // centavos
      const flatDelta = Math.max(0, targetAmount - currentAmount);

      // Elegir monto a cobrar (delta > 0 ? delta : diferencia fija)
      const amountToCharge = delta > 0 ? delta : flatDelta;

      if (amountToCharge <= 0) {
        return res.status(400).json({
          status: "fail",
          message: "Solo puedes hacer upgrade a un plan de mayor valor.",
          debug: {
            currentPriceId: currentPrice.id,
            targetPriceId: targetPrice.id,
            currentAmount,
            targetAmount,
            deltaPreview: delta
          }
        });
      }

      // 📌 Construir DETALLE bonito para factura
      // Nombre del plan actual (desde Stripe o desde tu DB como fallback)
      let nombrePlanActual = currentPrice?.product?.name;
      if (!nombrePlanActual && usuario.id_plan) {
        const planActualDB = await Planes_chat_center.findByPk(usuario.id_plan);
        if (planActualDB?.nombre_plan) nombrePlanActual = planActualDB.nombre_plan;
      }
      const detalle = `Actualización de ${nombrePlanActual || "Actual"} → ${nuevoPlan.nombre_plan}`;

      // Crear Checkout Session (payment) por la DIFERENCIA
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer: subscription.customer,

        line_items: [{
          price_data: {
            currency: targetPrice.currency,
            product_data: {
              // 🔹 Esto se verá como el concepto del ítem en la factura
              name: detalle
            },
            unit_amount: amountToCharge, // centavos: lo que falta
          },
          quantity: 1,
        }],

        // 🔹 Crear factura para este pago y dejar el detalle ahí también
        invoice_creation: {
          enabled: true,
          invoice_data: {
            description: detalle,
            // Opcional: campos personalizados visibles en la factura
            custom_fields: [
              { name: "Operación", value: "Upgrade" },
              { name: "Detalle", value: `De ${nombrePlanActual || "Actual"} a ${nuevoPlan.nombre_plan}` }
            ],
            // Metadata util para tus procesos
            metadata: {
              tipo: "upgrade_delta",
              id_usuario: String(userId),
              id_plan: String(id_plan),
              subscription_id: subscriptionId,
              from_price_id: currentPrice.id,
              to_price_id: targetPrice.id
            }
          }
        },

        success_url,
        cancel_url,

        // 🔹 También en el PaymentIntent (aparece en recibos/charge)
        payment_intent_data: {
          description: detalle,
          metadata: {
            tipo: "upgrade_delta",
            id_usuario: String(userId),
            id_plan: String(id_plan),
            subscription_id: subscriptionId,
            to_price_id: targetPrice.id
          }
        },

        // Metadata al nivel de sesión (por si lees checkout.session.completed)
        metadata: {
          tipo: "upgrade_delta",
          id_usuario: String(userId),
          id_plan: String(id_plan),
          subscription_id: subscriptionId,
          to_price_id: targetPrice.id
        }
      });

      return res.status(200).json({ url: session.url });
    }

    // ─────────────────────────────────────────────────────────────
    // B) NO tiene plan activo → Checkout de suscripción (flujo normal)
    // ─────────────────────────────────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: nuevoPlan.id_product_stripe, quantity: 1 }],
      success_url,
      cancel_url,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          id_usuario: String(userId),
          id_plan: String(id_plan),
        },
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Error al crear sesión de Stripe:", error);
    return res.status(500).json({
      status: "fail",
      message: error?.raw?.message || error.message
    });
  }
};











// controllers/stripe.controller.js
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

    // ✅ Solo-calculo en memoria (sin mutar DB)
    const hoy = new Date();
    const fechaRenovacion = result.fecha_renovacion ? new Date(result.fecha_renovacion) : null;
    const vencido = fechaRenovacion ? fechaRenovacion < hoy : false;

    return res.status(200).json({
      plan: {
        ...result,
        vencido,               // flag de conveniencia para el front
        dias_restantes: fechaRenovacion
          ? Math.ceil((fechaRenovacion - hoy) / (1000 * 60 * 60 * 24))
          : null,
      }
    });
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


/**
 * Crear sesión de Checkout para comprar 1 conexión adicional (pago único).
 * Body: { id_usuario, success_url?, cancel_url? }
 */
exports.crearSesionAddonConexion = async (req, res) => {
  try {
    const { id_usuario, success_url, cancel_url } = req.body;
    if (!id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });
    }

    // 1) Resolver (o crear) el customer de Stripe para este usuario
    let customerId = null;

    const [rows] = await db.query(`
      SELECT customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
        AND customer_id IS NOT NULL
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [id_usuario] });

    customerId = rows?.[0]?.customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { id_usuario: String(id_usuario) },
      });
      customerId = customer.id;

      await db.query(`
        INSERT INTO transacciones_stripe_chat (id_usuario, customer_id, fecha)
        VALUES (?, ?, NOW())
      `, { replacements: [id_usuario, customerId] });
    }

    // 2) Crear la sesión de Checkout usando DIRECTAMENTE tu price
    const baseUrl =
      req.body.base_url ||
      req.headers.origin ||
      (req.headers.referer ? req.headers.referer.split('/').slice(0, 3).join('/') : null);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: ADDON_PRICE_ID, quantity: 1 }],
      success_url: success_url || `${baseUrl}/conexiones?addon=ok`,
      cancel_url: cancel_url || `${baseUrl}/conexiones?addon=cancel`,
      // Metadatos para identificarnos en el webhook
      metadata: { tipo: 'addon_conexion', id_usuario: String(id_usuario), price_id: ADDON_PRICE_ID },
      payment_intent_data: {
        metadata: { tipo: 'addon_conexion', id_usuario: String(id_usuario), price_id: ADDON_PRICE_ID },
      },
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: 'Conexión adicional',
          metadata: { tipo: 'addon_conexion', id_usuario: String(id_usuario), price_id: ADDON_PRICE_ID },
        },
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Error en crearSesionAddonConexion:', error);
    return res.status(500).json({ status: 'fail', message: error?.raw?.message || error.message });
  }
};

exports.crearSesionAddonSubusuario = async (req, res) => {
  try {
    const { id_usuario, success_url, cancel_url } = req.body;

    if (!id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });
    }

    // 🔹 1) Obtener o crear el customer de Stripe
    let customerId = null;

    const [rows] = await db.query(`
      SELECT customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
        AND customer_id IS NOT NULL
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [id_usuario] });

    customerId = rows?.[0]?.customer_id || null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { id_usuario: String(id_usuario) },
      });
      customerId = customer.id;

      await db.query(`
        INSERT INTO transacciones_stripe_chat (id_usuario, customer_id, fecha)
        VALUES (?, ?, NOW())
      `, { replacements: [id_usuario, customerId] });
    }

    // 🔹 2) Crear sesión con checkout
    const baseUrl =
      req.body.base_url ||
      req.headers.origin ||
      (req.headers.referer ? req.headers.referer.split('/').slice(0, 3).join('/') : null);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [
        {
          price: PRICE_ID_ADDON_SUBUSUARIO,
          quantity: 1,
        },
      ],
      success_url: success_url || `${baseUrl}/usuarios?addon_subusuario=ok`,
      cancel_url: cancel_url || `${baseUrl}/usuarios?addon_subusuario=cancel`,
      metadata: {
        tipo: 'addon_subusuario',
        id_usuario: String(id_usuario),
        price_id: PRICE_ID_ADDON_SUBUSUARIO,
      },
      payment_intent_data: {
        metadata: {
          tipo: 'addon_subusuario',
          id_usuario: String(id_usuario),
          price_id: PRICE_ID_ADDON_SUBUSUARIO,
        },
      },
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: 'Subusuario adicional',
          metadata: {
            tipo: 'addon_subusuario',
            id_usuario: String(id_usuario),
            price_id: PRICE_ID_ADDON_SUBUSUARIO,
          },
        },
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('❌ Error en crearSesionAddonSubusuario:', error);
    return res.status(500).json({ status: 'fail', message: error?.raw?.message || error.message });
  }
};


/**
 * Devuelve si el usuario es elegible para prueba gratuita (no la usó antes)
 */

exports.trialElegibilidad = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body.id_usuario || req.body.id_users;
    if (!id_usuario) return res.status(400).json({ elegible: false, message: 'Falta id_usuario' });

    const [rows] = await db.query(
      `SELECT COALESCE(free_trial_used, 0) AS used
       FROM usuarios_chat_center
       WHERE id_usuario = ? LIMIT 1`,
      { replacements: [id_usuario] }
    );

    const elegible = !Boolean(rows?.[0]?.used);
    return res.json({ elegible });
  } catch (e) {
    console.error('trialElegibilidad:', e);
    // Si algo falla, sé permisivo o responde 500 según tu preferencia
    return res.status(500).json({ elegible: false, message: 'Error verificando elegibilidad' });
  }
};

/**
 * Crea una sesión de Checkout (subscription) con TRIAL para el plan Conexión.
 * - No cobra ahora (trial).
 * - Obliga tarjeta (Stripe la guarda; tu webhook la inserta en user_payment_methods).
 * - Al finalizar el trial, Stripe cobra y tu webhook pasa al plan Conexión.
 */
exports.crearFreeTrial = async (req, res) => {
  try {
    const { id_usuario, success_url, cancel_url, trial_days } = req.body;
    if (!id_usuario) return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });

    // Bloqueo por BD
    const [rowsUser] = await db.query(
      `SELECT COALESCE(free_trial_used,0) AS used
       FROM usuarios_chat_center
       WHERE id_usuario = ? LIMIT 1`,
      { replacements: [id_usuario] }
    );
    if (Boolean(rowsUser?.[0]?.used)) {
      return res.status(400).json({ status: 'fail', message: 'Ya usaste tu plan gratuito.' });
    }

    // 2) Resolver el plan "Conexión" (o el más barato > FREE)
    let planConexion = await Planes_chat_center.findOne({
      where: db.where(db.fn('LOWER', db.col('nombre_plan')), 'like', '%conexion%')
    });
    if (!planConexion) {
      // fallback: el más barato distinto de FREE (id_plan <> 1)
      const [minRows] = await db.query(`
        SELECT * FROM planes_chat_center
        WHERE id_plan <> 1
        ORDER BY precio_plan ASC
        LIMIT 1
      `);
      planConexion = minRows?.[0];
    }
    if (!planConexion?.id_plan || !planConexion?.id_product_stripe) {
      return res.status(404).json({ status: 'fail', message: 'No se pudo resolver el plan Conexión.' });
    }

    // 3) Resolver/crear customer de Stripe
    let customerId = null;
    const [rCust] = await db.query(`
      SELECT customer_id FROM transacciones_stripe_chat
      WHERE id_usuario = ? AND customer_id IS NOT NULL
      ORDER BY fecha DESC LIMIT 1
    `, { replacements: [id_usuario] });
    customerId = rCust?.[0]?.customer_id || null;


    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { id_usuario: String(id_usuario) } });
      customerId = customer.id;
      // 👇 No insertamos en transacciones aquí. El único alta la hará el webhook al completar Checkout.
    }


    // 4) Crear Checkout Session (subscription) con trial al plan Conexión
    // 4) Crear Checkout Session (subscription) con trial al plan Conexión
    const baseUrl =
      req.body.base_url ||
      req.headers.origin ||
      (req.headers.referer ? req.headers.referer.split('/').slice(0, 3).join('/') : null);
      
    // Configurables por .env
    const requireCard = String(process.env.FREE_TRIAL_REQUIRE_CARD || 'true').toLowerCase() !== 'false';
    const missingPmBehavior = (process.env.FREE_TRIAL_MISSING_PM_BEHAVIOR || 'cancel').toLowerCase();
    const trialDays = Number.isInteger(trial_days) ? trial_days : Number(process.env.FREE_TRIAL_DAYS || 15);
      
    // Construimos el payload para Checkout
    const sessionPayload = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: planConexion.id_product_stripe, quantity: 1 }],
      success_url: success_url || `${baseUrl}/miplan?trial=ok`,
      cancel_url:  cancel_url  || `${baseUrl}/planes_view?trial=cancel`,
      // IMPORTANTE: el trial va en subscription_data según docs
      subscription_data: {
        trial_period_days: trialDays,
        // Solo aplica si decides NO pedir tarjeta en el trial
        trial_settings: {
          end_behavior: { missing_payment_method: missingPmBehavior }
        },
        // metadata de la SUSCRIPCIÓN (se propaga a eventos customer.subscription.* e invoice.*)
        metadata: {
          tipo: 'free_trial_autorenew',
          id_usuario: String(id_usuario),
          id_plan: String(planConexion.id_plan)
        }
      },
      // metadata de la SESIÓN (tu webhook ya lo lee para marcar FREE al completar)
      metadata: {
        tipo: 'free_trial',
        id_usuario: String(id_usuario),
        plan_final_id: String(planConexion.id_plan)
      }
    };
    
    // Si NO quieres pedir tarjeta durante el trial, díselo a Checkout:
    if (!requireCard) {
      // Según docs de Checkout para trials sin método de pago
      sessionPayload.payment_method_collection = 'if_required'; // no pide tarjeta durante el trial
    }
    
    const session = await stripe.checkout.sessions.create(sessionPayload);
    
    return res.status(200).json({ url: session.url });

  } catch (e) {
    console.error('crearFreeTrial:', e);
    return res.status(500).json({ status: 'fail', message: e?.raw?.message || e.message });
  }
};


exports.crearSesionFreeSetup = async (req, res) => {
  try {
    const { id_usuario } = req.body;

    if (!id_usuario) {
      return res.status(400).json({ message: "Falta el id_usuario" });
    }

    // Buscar customer
    const [row] = await db.query(`
      SELECT customer_id FROM transacciones_stripe_chat
      WHERE id_usuario = ? AND estado_suscripcion = 'active'
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [id_usuario] });

    let customerId = row?.[0]?.customer_id;

    if (!customerId) {
      const usuario = await Usuarios_chat_center.findByPk(id_usuario);
      if (!usuario) return res.status(404).json({ message: "Usuario no encontrado" });

      const customer = await stripe.customers.create({
        name: usuario.nombre,
        email: usuario.correo,
        metadata: { id_usuario },
      });

      customerId = customer.id;

      await db.query(`
        INSERT INTO transacciones_stripe_chat (id_usuario, customer_id, fecha)
        VALUES (?, ?, NOW())
      `, { replacements: [id_usuario, customerId] });
    }

    // Crear sesión de setup
    const baseUrl = req.headers.origin || req.headers.referer?.split('/').slice(0, 3).join('/');
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      payment_method_types: ["card"],
      customer: customerId,
      metadata: {
        id_usuario,
        motivo: "activar_plan_free"
      },
      success_url: `${baseUrl}/planes_view?setup=ok`,
      cancel_url: `${baseUrl}/planes_view?setup=cancel`,
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error("❌ Error en crearSesionFreeSetup:", error);
    return res.status(500).json({ message: "No se pudo crear la sesión de setup para el plan gratuito" });
  }
};
