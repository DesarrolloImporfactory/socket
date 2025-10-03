const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const PlanesPersonalizadosStripe = require('../models/planes_personalizados_stripe.model');
const { db } = require('../database/config');

// Price del addon de conexión y subusuario(fijo, según me diste)

const ADDON_PRICE_ID = 'price_1Ryc0gClsPjxVwZwQQwt7YM0';
const PRICE_ID_ADDON_SUBUSUARIO = 'price_1Ryc5EClsPjxVwZwyApbVKbr';
/* conexion y subusuario para plan personalizado */
const ADDON_PRICE_ID_PERS = 'price_1S30HtClsPjxVwZw8OJlhpyE';
const PRICE_ID_ADDON_SUBUSUARIO_PERS = 'price_1S30IQClsPjxVwZwRHact8Zd';

// ─── Lite Free (oculto a catálogo) ────────────────────────────────────────────
const LITE_PLAN_ID = 6;
const LITE_PRICE_ID = 'price_1S6cVNRwAlJ5h5wg7O1lhdu8';




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
// controllers/stripe.controller.js
exports.obtenerSuscripcionActiva = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body.id_usuario || req.body.id_users;
    if (!id_usuario) {
      return res.status(400).json({ message: "Falta id_usuario" });
    }

    // 1) Datos del plan guardados en tu BD (como ya lo haces)
    const [planRow] = await db.query(
      `
      SELECT 
        u.id_plan,
        u.estado                  AS estado_local,
        u.fecha_renovacion        AS fecha_renovacion_bd,
        p.nombre_plan,
        p.descripcion_plan,
        p.precio_plan,
        p.ahorro
      FROM usuarios_chat_center u
      LEFT JOIN planes_chat_center p ON u.id_plan = p.id_plan
      WHERE u.id_usuario = ?
      LIMIT 1
      `,
      { replacements: [id_usuario] }
    );

    // Si no hay registro de plan en BD, devolvemos nulo
    if (!planRow?.[0]) {
      return res.status(200).json({ plan: null });
    }
    const base = planRow[0];

    // 2) Intentar obtener customer/subscription vinculados
    const [txRow] = await db.query(
      `
      SELECT id_suscripcion, customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
      ORDER BY fecha DESC
      LIMIT 1
      `,
      { replacements: [id_usuario] }
    );

    let subId = txRow?.[0]?.id_suscripcion || null;
    let customerId = txRow?.[0]?.customer_id || null;

    // 3) Leer el estado real desde Stripe
    let sub = null;

    // a) si tengo subId, intento traerla
    if (subId) {
      try {
        sub = await stripe.subscriptions.retrieve(subId);
      } catch (_) {
        sub = null;
      }
    }

    // b) si no hay sub válida, busco por customer y priorizo estados útiles
    if (!sub && customerId) {
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
      });
      const prefer = ["trialing", "active", "past_due", "incomplete", "incomplete_expired"];
      subs.data.sort((a, b) => prefer.indexOf(a.status) - prefer.indexOf(b.status));
      sub = subs.data.find((s) => prefer.includes(s.status)) || null;

      // opcional: persistir subId si lo encontramos
      if (sub?.id && !subId) {
        await db.query(
          `UPDATE transacciones_stripe_chat SET id_suscripcion = ? WHERE customer_id = ?`,
          { replacements: [sub.id, customerId] }
        );
        subId = sub.id;
      }
    }

    // --- Ocultar suscripción si es el plan LITE-FREE especial ---
    if (sub) {
      const firstItem = sub.items?.data?.[0] || null;
      const priceId = firstItem?.price?.id || null;
      const hideUiMeta = (sub.metadata && (sub.metadata.hidden_ui === 'true' || sub.metadata.special_plan === 'lite_free'));
      if (hideUiMeta || priceId === 'price_1SAb5GRwAlJ5h5wg3dEb69Zs') {
        // Como si no hubiera suscripción relevante para la UI
        sub = null;
      }
    }


    // 4) Armar metadatos Stripe para el front
    const estado_suscripcion = sub?.status || null;                    // p.ej. 'trialing' | 'active' | ...
    const cancel_at_period_end = Boolean(sub?.cancel_at_period_end);    // true si ya está programada la cancelación
    const current_period_end_unix = sub?.current_period_end || null;    // UNIX ts (seg)
    const current_period_end_iso =
      current_period_end_unix ? new Date(current_period_end_unix * 1000).toISOString() : null;

    // 5) Decidir fecha_renovacion a devolver:
    //    preferimos la de Stripe si existe; si no, la de BD
    const fechaRenovacionISO =
      current_period_end_iso ||
      (base.fecha_renovacion_bd ? new Date(base.fecha_renovacion_bd).toISOString() : null);

    // Derivados para conveniencia del front
    const hoy = new Date();
    const fechaRenovacionDate = fechaRenovacionISO ? new Date(fechaRenovacionISO) : null;
    const vencido = fechaRenovacionDate ? fechaRenovacionDate < hoy : false;
    const dias_restantes = fechaRenovacionDate
      ? Math.ceil((fechaRenovacionDate - hoy) / (1000 * 60 * 60 * 24))
      : null;

    // 6) Respuesta unificada
    return res.status(200).json({
      plan: {
        id_plan: base.id_plan,
        nombre_plan: base.nombre_plan,
        descripcion_plan: base.descripcion_plan,
        precio_plan: base.precio_plan,
        ahorro: base.ahorro,
        estado: base.estado_local, // estado que tú guardas en BD
        // Fechas (normalizadas)
        fecha_renovacion: fechaRenovacionISO, // ISO string
        dias_restantes,
        vencido,
        // === Metadatos REALES de Stripe (para UI) ===
        estado_suscripcion,         // 'trialing' | 'active' | ...
        cancel_at_period_end,       // true si la cancelación está programada
        current_period_end: current_period_end_iso, // ISO
        stripe_subscription_id: subId || null,
        stripe_customer_id: customerId || null,
      },
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

// controllers/stripe.controller.js

exports.cancelarSuscripcion = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body.id_usuario || req.body.id_users;
    if (!id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });
    }

    // 1) Buscar en tu tabla SIN limitar a 'active' (puede estar 'trialing')
    const [result] = await db.query(`
      SELECT id_suscripcion, customer_id, estado_suscripcion
      FROM transacciones_stripe_chat 
      WHERE id_usuario = ?
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [id_usuario] });

    let idSuscripcion = result?.[0]?.id_suscripcion || null;
    let customerId    = result?.[0]?.customer_id    || null;

    // 2) Fallback: si no hay idSuscripcion, resolver por customer y buscar en Stripe
    if (!idSuscripcion) {
      if (!customerId) {
        const [r2] = await db.query(`
          SELECT customer_id
          FROM transacciones_stripe_chat
          WHERE id_usuario = ? AND customer_id IS NOT NULL
          ORDER BY fecha DESC LIMIT 1
        `, { replacements: [id_usuario] });
        customerId = r2?.[0]?.customer_id || null;
      }

      if (customerId) {
        const subs = await stripe.subscriptions.list({
          customer: customerId,
          status: 'all',
          limit: 10,
        });

        // Prioriza trialing (prueba), luego active y luego estados aún "vivos"
        const prefer = ['trialing', 'active', 'past_due', 'incomplete', 'incomplete_expired'];
        subs.data.sort((a, b) => prefer.indexOf(a.status) - prefer.indexOf(b.status));
        const candidate = subs.data.find(s => prefer.includes(s.status));
        idSuscripcion = candidate?.id || null;
      }
    }

    if (!idSuscripcion) {
      return res.status(404).json({ status: 'fail', message: 'No se encontró suscripción para cancelar' });
    }

    // 3) Programar cancelación al final del período (en trial = al finalizar la prueba, sin cobro)
    const updated = await stripe.subscriptions.update(idSuscripcion, {
      cancel_at_period_end: true,
    });

    // 4) Reflejar estado en tu BD
    await db.query(`
      UPDATE transacciones_stripe_chat 
      SET estado_suscripcion = ?, fecha = NOW()
      WHERE id_suscripcion = ?
    `, { replacements: [updated.status || 'cancelando', idSuscripcion] });

    return res.status(200).json({
      status: 'success',
      message:
        updated.status === 'trialing'
          ? 'La prueba gratuita se cancelará al finalizar el periodo. No se realizará ningún cobro.'
          : 'La suscripción se cancelará al finalizar el periodo actual.',
      stripe: {
        id: updated.id,
        status: updated.status,
        cancel_at_period_end: updated.cancel_at_period_end,
        current_period_end: updated.current_period_end, // UNIX ts
      },
    });
  } catch (error) {
    console.error("Error al cancelar suscripción:", error);
    return res.status(500).json({
      status: 'fail',
      message: error?.raw?.message || 'Error al cancelar la suscripción',
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
      success_url: `${baseUrl}/miplan?setup=ok`,
      cancel_url: `${baseUrl}/planes_view?setup=cancel`,
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error("❌ Error en crearSesionFreeSetup:", error);
    return res.status(500).json({ message: "No se pudo crear la sesión de setup para el plan gratuito" });
  }
};



// ========== NUEVO: Crear sesión de Checkout para plan personalizado ==========
// ========== NUEVO: Crear sesión de Checkout para plan personalizado ==========
// controllers/stripe.controller.js
exports.crearSesionPlanPersonalizado = async (req, res) => {
  try {
    const {
      id_usuario,
      id_users, // compat
      n_conexiones = 0,
      max_subusuarios = 0,
      success_url,
      cancel_url,
    } = req.body;

    const userId = id_usuario || id_users || req.user?.id;

    if (!userId) {
      return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });
    }
    if (!success_url || !cancel_url) {
      return res.status(400).json({ status: 'fail', message: 'Faltan success_url y cancel_url' });
    }

    const nConn = Number.isFinite(+n_conexiones) ? Math.max(0, Math.min(10, Math.floor(+n_conexiones))) : 0;
    const nSubs = Number.isFinite(+max_subusuarios) ? Math.max(0, Math.min(10, Math.floor(+max_subusuarios))) : 0;

    if (nConn === 0 && nSubs === 0) {
      return res.status(400).json({ status: 'fail', message: 'Selecciona al menos 1 conexión o 1 subusuario' });
    }

    // Plan base personalizado (id 5) desde tu BD
    const planBase = await Planes_chat_center.findOne({
      where: { id_plan: 5 },
      attributes: ['id_plan', 'id_product_stripe', 'nombre_plan'],
    });
    if (!planBase?.id_product_stripe) {
      return res.status(404).json({
        status: 'fail',
        message: 'Plan base personalizado (id 5) no configurado con price de Stripe (id_product_stripe)',
      });
    }

    // Items de la suscripción (base + addons)
    const line_items = [{ price: planBase.id_product_stripe, quantity: 1 }];
    if (nConn > 0) line_items.push({ price: ADDON_PRICE_ID_PERS, quantity: nConn });
    if (nSubs > 0) line_items.push({ price: PRICE_ID_ADDON_SUBUSUARIO_PERS, quantity: nSubs });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      line_items,
      success_url,
      cancel_url,
      subscription_data: {
        metadata: {
          tipo: 'personalizado',
          id_usuario: String(userId),
          id_plan: '5',
          n_conexiones: String(nConn),
          max_subusuarios: String(nSubs),
        },
      },
      metadata: {
        tipo: 'personalizado',
        id_usuario: String(userId),
        id_plan: '5',
      },
    });

    // 👇 IMPORTANTE: aquí NO escribimos en planes_personalizados_stripe
    return res.status(200).json({ status: 'success', url: session.url });
  } catch (error) {
    console.error('crearSesionPlanPersonalizado:', error);
    return res.status(500).json({
      status: 'fail',
      message: error?.raw?.message || error.message || 'Error creando la sesión de Stripe',
    });
  }
};



// ========== OPCIONAL: obtener configuración personalizada actual del usuario ==========
exports.obtenerPlanPersonalizadoUsuario = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body.id_usuario || req.body.id_users;
    if (!id_usuario) return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });

    const row = await PlanesPersonalizadosStripe.findOne({ where: { id_usuario } });
    return res.status(200).json({ status: 'success', data: row || null });
  } catch (e) {
    console.error('obtenerPlanPersonalizadoUsuario:', e);
    return res.status(500).json({ status: 'fail', message: e.message });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// ADD: devolver unit_amount de addons (conexión y subusuario) y el plan base 5
// ─────────────────────────────────────────────────────────────────────────────
// ========== NUEVO: Exponer precios de addons para calcular total en el front ==========
exports.obtenerPreciosAddons = async (req, res) => {
  try {
    // Devuelve unit_amount (centavos) y el price del plan base id 5
    const [conn, sub] = await Promise.all([
      stripe.prices.retrieve(ADDON_PRICE_ID_PERS, { expand: ['product'] }),
      stripe.prices.retrieve(PRICE_ID_ADDON_SUBUSUARIO_PERS, { expand: ['product'] }),
    ]);

    const basePlan = await Planes_chat_center.findOne({ where: { id_plan: 5 } });

    return res.status(200).json({
      status: 'success',
      data: {
        base: {
          id_plan: 5,
          stripe_price_id: basePlan?.id_product_stripe || null,
        },
        addons: {
          conexion: {
            id: conn.id,
            unit_amount: conn.unit_amount || 0,
            currency: conn.currency,
            interval: conn.recurring?.interval || 'month',
            name: conn.product?.name || 'Conexión adicional',
          },
          subusuario: {
            id: sub.id,
            unit_amount: sub.unit_amount || 0,
            currency: sub.currency,
            interval: sub.recurring?.interval || 'month',
            name: sub.product?.name || 'Subusuario adicional',
          },
        },
      },
    });
  } catch (e) {
    console.error('obtenerPreciosAddons:', e);
    return res.status(500).json({ status: 'fail', message: e?.raw?.message || e.message });
  }
};


// controllers/stripe.controller.js
exports.miPlanPersonalizado = async (req, res) => {
  try {
    const id_usuario = req.user?.id || req.body?.id_usuario || req.body?.id_users;
    if (!id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });
    }

    // 1) Config per-user (si existe)
    const [rows] = await db.query(`
      SELECT id_usuario, id_plan_base, n_conexiones, max_subusuarios
      FROM planes_personalizados_stripe
      WHERE id_usuario = ?
      LIMIT 1
    `, { replacements: [id_usuario] });

    const per = rows?.[0] || null;

    // 2) Datos del plan base (nombre/priceId/descripcion/precio_local)
    let basePlan = null;
    if (per?.id_plan_base) {
      const p = await Planes_chat_center.findByPk(per.id_plan_base);
      if (p) {
        basePlan = {
          id_plan: p.id_plan,
          nombre_plan: p.nombre_plan,
          descripcion_plan: p.descripcion_plan,
          precio_plan: Number(p.precio_plan || 0),      // precio local como fallback
          id_product_stripe: p.id_product_stripe || null
        };
      }
    }

    // 3) Precio base desde Stripe (si existe) + intervalo
    let base_cents = Math.round(Number(basePlan?.precio_plan || 0) * 100);
    let intervalo = 'month';
    if (basePlan?.id_product_stripe) {
      try {
        const price = await stripe.prices.retrieve(basePlan.id_product_stripe, { expand: ['product'] });
        base_cents = typeof price?.unit_amount === 'number' ? price.unit_amount : base_cents;
        intervalo = price?.recurring?.interval || intervalo;
      } catch (e) {
        // si falla Stripe, usamos precio local
      }
    }

    // 4) Addons (conexión y subusuario)
    let conn_addon_cents = 0;
    let sub_addon_cents  = 0;
    try {
      const a1 = await stripe.prices.retrieve(ADDON_PRICE_ID);
      const a2 = await stripe.prices.retrieve(PRICE_ID_ADDON_SUBUSUARIO);
      conn_addon_cents = Number(a1?.unit_amount || 0);
      sub_addon_cents  = Number(a2?.unit_amount || 0);
    } catch (e) {
      // si falla Stripe, deja en 0 (o podrías leerlos de otro sitio)
    }

    // 5) Total calculado
    const nConn = Number(per?.n_conexiones || 0);
    const nSubs = Number(per?.max_subusuarios || 0);
    const total_cents = base_cents + nConn * conn_addon_cents + nSubs * sub_addon_cents;

    // 6) ¿Esa card es la actual?
    let es_actual = false;
    if (per?.id_plan_base) {
      const [urow] = await db.query(
        `SELECT id_plan FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
        { replacements: [id_usuario] }
      );
      const id_plan_usuario = urow?.[0]?.id_plan || null;
      es_actual = Number(id_plan_usuario) === Number(per.id_plan_base);
    }

    return res.status(200).json({
      status: 'success',
      data: {
        personalizado: per,            // { id_plan_base, n_conexiones, max_subusuarios }
        base_plan: basePlan,           // { id_plan, nombre_plan, id_product_stripe, ... }
        stripe: {
          base_cents,
          conn_addon_cents,
          sub_addon_cents,
          total_cents,
          intervalo
        },
        es_actual                      // true si esta card debe mostrar “Tienes este plan actualmente”
      }
    });
  } catch (e) {
    console.error('miPlanPersonalizado:', e);
    return res.status(500).json({ status: 'fail', message: 'Error al obtener tu plan personalizado' });
  }
};

/**
 * Checkout para el plan LITE con 12 meses de prueba.
 * - Usa price fijo (LITE_PRICE_ID).
 * - Marca en metadata el id_usuario y el id del plan (6).
 * - Respeta la misma validación de elegibilidad que crearFreeTrial.
 */
exports.crearSesionLiteFree = async (req, res) => {
  try {
    const { id_usuario, success_url, cancel_url, trial_days } = req.body;
    if (!id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Falta id_usuario' });
    }

    // 0) Bloqueo por “ya usó free trial” (misma validación que crearFreeTrial)
    const [rowsUser] = await db.query(
      `SELECT COALESCE(free_trial_used,0) AS used
       FROM usuarios_chat_center
       WHERE id_usuario = ? LIMIT 1`,
      { replacements: [id_usuario] }
    );
    if (Boolean(rowsUser?.[0]?.used)) {
      return res.status(400).json({ status: 'fail', message: 'Ya usaste tu plan gratuito.' });
    }

    // 1) Customer Stripe (reusar si existe)
    let customerId = null;
    const [txRow] = await db.query(
      `SELECT customer_id
         FROM transacciones_stripe_chat
        WHERE id_usuario = ?
        ORDER BY fecha DESC
        LIMIT 1`,
      { replacements: [id_usuario] }
    );
    customerId = txRow?.[0]?.customer_id || null;

    if (!customerId) {
      const c = await stripe.customers.create({ metadata: { id_usuario: String(id_usuario) } });
      customerId = c.id;
      await db.query(
        `INSERT INTO transacciones_stripe_chat (id_usuario, customer_id, fecha)
         VALUES (?, ?, NOW())`,
        { replacements: [id_usuario, customerId] }
      );
    }

    // 2) Datos del plan LITE desde tu BD (solo para id_product_stripe “oficial”)
    const planLite = await Planes_chat_center.findByPk(LITE_PLAN_ID, {
      attributes: ['id_plan', 'id_product_stripe', 'nombre_plan']
    });
    if (!planLite?.id_product_stripe) {
      return res.status(404).json({
        status: 'fail',
        message: 'Plan Lite (id 6) no configurado con price de Stripe (id_product_stripe)'
      });
    }

    // 3) Trial
    const trialDays = Number.isInteger(trial_days) ? trial_days : 365; // 12 meses aprox
    const requireCard = true; // igual que crearFreeTrial (puedes cambiar a if_required si quieres)

    // 4) Crear sesión de Checkout (mode: subscription)
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      payment_method_collection: requireCard ? 'always' : 'if_required',
      allow_promotion_codes: true,

      line_items: [{ price: LITE_PRICE_ID || planLite.id_product_stripe, quantity: 1 }],

      subscription_data: {
        trial_period_days: trialDays,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata: {
          tipo: 'lite_free',
          id_usuario: String(id_usuario),
          id_plan: String(LITE_PLAN_ID) // ← importante para el webhook
        }
      },

      // metadata de la sesión (tu webhook también la revisa)
      metadata: {
        tipo: 'lite_free',
        id_usuario: String(id_usuario),
        plan_final_id: String(LITE_PLAN_ID)
      },

      success_url: success_url || `${req.headers.origin || ''}/miplan?trial=ok`,
      cancel_url: cancel_url || `${req.headers.origin || ''}/landing?trial=cancel`,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('crearSesionLiteFree:', e);
    return res.status(500).json({ status: 'fail', message: e?.raw?.message || e.message });
  }
};


// === NUEVO === Cambio completo a LITE al cancelar (pago completo sin prorrateo)
exports.crearSesionCambioLiteCompleto = async (req, res) => {
  try {
    const { success_url, cancel_url, id_usuario, id_users } = req.body;
    const userId = id_usuario || id_users;

    if (!userId || !success_url || !cancel_url) {
      return res.status(400).json({
        status: "fail",
        message: "Faltan datos (id_usuario, success_url, cancel_url)",
      });
    }

    // 1) Usuario
    const usuario = await Usuarios_chat_center.findByPk(userId);
    if (!usuario) {
      return res.status(404).json({ status: "fail", message: "Usuario no encontrado" });
    }

    // 2) Resolver customerId e id de suscripción actual desde tu tabla
    let subscriptionId = null;
    let customerId = null;

    const [rows] = await db.query(`
      SELECT id_suscripcion, customer_id
      FROM transacciones_stripe_chat
      WHERE id_usuario = ?
      ORDER BY fecha DESC
      LIMIT 1
    `, { replacements: [userId] });

    subscriptionId = rows?.[0]?.id_suscripcion || null;
    customerId    = rows?.[0]?.customer_id    || null;

    // Si no tienes sub en tu tabla, búscala en Stripe por el customer
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
      const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
      const prefer = ["trialing", "active", "past_due", "incomplete", "incomplete_expired"];
      subs.data.sort((a, b) => prefer.indexOf(a.status) - prefer.indexOf(b.status));
      subscriptionId = subs.data.find(s => prefer.includes(s.status))?.id || null;
    }

    if (!subscriptionId) {
      return res.status(404).json({ status: "fail", message: "No se encontró una suscripción para cambiar a LITE" });
    }

    // 3) Leer el price del LITE para cobrar el monto completo (moneda y unit_amount)
    const targetPrice = await stripe.prices.retrieve(LITE_PRICE_ID);
    const unitAmount  = Number(targetPrice?.unit_amount || 0);
    const currency    = targetPrice?.currency || "usd";
    if (unitAmount <= 0) {
      return res.status(400).json({ status: "fail", message: "Price del LITE inválido" });
    }

    const detalle = `Cambio total a ${targetPrice?.nickname || 'Plan LITE'} (pago completo)`;

    // 4) Checkout Session en modo PAYMENT (pago único por el monto completo del LITE)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer: customerId,
      line_items: [{
        price_data: {
          currency,
          product_data: { name: detalle },
          unit_amount: unitAmount,
        },
        quantity: 1,
      }],
      // Creamos invoice de ese pago (la usaremos en el webhook)
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: detalle,
          metadata: {
            tipo: "downgrade_fullswitch",
            id_usuario: String(userId),
            id_plan: String(LITE_PLAN_ID),
            subscription_id: subscriptionId,
            to_price_id: targetPrice.id
          }
        }
      },
      success_url,
      cancel_url,
      payment_intent_data: {
        description: detalle,
        metadata: {
          tipo: "downgrade_fullswitch",
          id_usuario: String(userId),
          id_plan: String(LITE_PLAN_ID),
          subscription_id: subscriptionId,
          to_price_id: targetPrice.id
        }
      },
      metadata: {
        tipo: "downgrade_fullswitch",
        id_usuario: String(userId),
        id_plan: String(LITE_PLAN_ID),
        subscription_id: subscriptionId,
        to_price_id: targetPrice.id
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Error en crearSesionCambioLiteCompleto:", error);
    return res.status(500).json({ status: "fail", message: error?.raw?.message || error.message });
  }
};

