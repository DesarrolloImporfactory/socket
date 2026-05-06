const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const catchAsync = require('../utils/catchAsync');
const ShopifyCarritosAbandonados = require('../models/shopify_carritos_abandonados.model');
const Configuraciones = require('../models/configuraciones.model');
const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');
const { normalizarTelefono } = require('../utils/shopify/normalizarTelefono');

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_) {}
}

const logsDir = path.join(process.cwd(), './src/logs/logs_shopify');

/* Helper de logging para no repetir el appendFile */
const logShopify = async (mensaje) => {
  try {
    console.log("SHOPIFY"+mensaje);
    await fsp.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${mensaje}\n`,
    );
  } catch (_) {}
};

/* Helper: extraer datos del checkout y guardar/actualizar carrito */
const upsertCarrito = async (req, checkout) => {
  const shopifyConfig = req.shopifyConfig; // viene del middleware
  const id_configuracion = shopifyConfig.id_configuracion;
  const shop_domain = shopifyConfig.shop_domain;
  const checkout_token = checkout?.token;
  const checkout_id = checkout?.id;

  /* 1️⃣ Validaciones tempranas: sin token no podemos hacer nada */
  if (!checkout_token || !checkout_id) {
    await logShopify(`⏭️ Carrito sin token/id, ignorado`);
    return {
      registro: null,
      creado: false,
      id_cliente: null,
      motivo: 'sin_token',
    };
  }

  /* 2️⃣ Extraer datos de contacto */
  const customer = checkout.customer || {};
  const shippingAddress = checkout.shipping_address || {};

  const phone_raw =
    checkout.phone || customer.phone || shippingAddress.phone || null;
  const email = checkout.email || customer.email || null;

  /* 3️⃣ FILTRO ANTI-BASURA: si no tiene email NI teléfono, descartar */
  if (!phone_raw && !email) {
    await logShopify(`⏭️ Carrito ignorado (sin contacto): ${checkout_token}`);
    return {
      registro: null,
      creado: false,
      id_cliente: null,
      motivo: 'sin_contacto',
    };
  }

  /* 4️⃣ Validar que tenga productos (carrito vacío no sirve) */
  const lineItems = Array.isArray(checkout.line_items)
    ? checkout.line_items
    : [];
  if (!lineItems.length) {
    await logShopify(`⏭️ Carrito ignorado (sin productos): ${checkout_token}`);
    return {
      registro: null,
      creado: false,
      id_cliente: null,
      motivo: 'sin_productos',
    };
  }

  /* 5️⃣ Normalizar teléfono y validar longitud mínima */
  const phone_normalizado_raw = phone_raw
    ? normalizarTelefono(phone_raw, shopifyConfig.prefijo_pais)
    : null;

  // Un teléfono válido debe tener al menos 10 dígitos (ej: 593991234567 = 12)
  const phone_normalizado =
    phone_normalizado_raw && phone_normalizado_raw.length >= 10
      ? phone_normalizado_raw
      : null;

  const nombre_cliente = (
    customer.first_name ||
    shippingAddress.first_name ||
    ''
  ).trim();
  const apellido_cliente = (
    customer.last_name ||
    shippingAddress.last_name ||
    ''
  ).trim();

  /* 6️⃣ Buscar carrito existente (para evitar reactivar recuperados) */
  const existente = await ShopifyCarritosAbandonados.findOne({
    where: { id_configuracion, checkout_token },
    attributes: ['id', 'id_cliente', 'recuperado', 'mensaje_enviado'],
  });

  /* 🛑 Race condition: si llega un update DESPUÉS de orders/create, no resucitar */
  if (existente?.recuperado === 1) {
    await logShopify(
      `⏭️ Carrito ya recuperado, ignorando update: ${checkout_token}`,
    );
    return {
      registro: existente,
      creado: false,
      id_cliente: existente.id_cliente,
      motivo: 'ya_recuperado',
    };
  }

  /* 7️⃣ Reusar id_cliente si ya estaba ligado (evita re-llamar ensureUnifiedClient) */
  let id_cliente = existente?.id_cliente || null;

  /* Solo crear/asociar cliente si hay teléfono válido Y aún no está ligado */
  if (phone_normalizado && !id_cliente) {
    try {
      const configuracion = await Configuraciones.findOne({
        where: { id: id_configuracion, suspendido: 0 },
      });

      if (configuracion) {
        const cliente = await ensureUnifiedClient({
          id_configuracion,
          id_usuario_dueno: configuracion.id_usuario,
          source: 'wa',
          business_phone_id: configuracion.id_telefono,
          phone: phone_normalizado,
          nombre_cliente,
          apellido_cliente,
          motivo: 'shopify_abandoned_cart',
          permiso_round_robin: configuracion.permiso_round_robin,
        });
        id_cliente = cliente?.id || null;

        if (id_cliente) {
          await logShopify(
            `✅ Cliente unificado: id_cliente=${id_cliente} phone=${phone_normalizado}`,
          );
        }
      } else {
        await logShopify(
          `⚠️ Configuración no encontrada o suspendida: id_configuracion=${id_configuracion}`,
        );
      }
    } catch (err) {
      await logShopify(`⚠️ Error creando cliente unificado: ${err.message}`);
    }
  }

  /* 8️⃣ Upsert del carrito con manejo de errores */
  try {
    const [registro, creado] = await ShopifyCarritosAbandonados.upsert({
      id_configuracion,
      id_cliente,
      shop_domain,
      checkout_token,
      checkout_id,
      email,
      phone_raw,
      phone_normalizado,
      nombre_cliente,
      apellido_cliente,
      total_price: parseFloat(checkout.total_price || 0),
      currency: checkout.currency || 'USD',
      abandoned_checkout_url: checkout.abandoned_checkout_url || null,
      line_items: lineItems,
      shipping_address: shippingAddress,
      shopify_created_at: checkout.created_at
        ? new Date(checkout.created_at)
        : null,
      shopify_updated_at: checkout.updated_at
        ? new Date(checkout.updated_at)
        : null,
    });

    await logShopify(
      `✅ Carrito ${creado ? 'creado' : 'actualizado'}: ${checkout_token} ` +
        `(id_cliente=${id_cliente}, total=${checkout.total_price})`,
    );

    return { registro, creado, id_cliente, motivo: 'ok' };
  } catch (err) {
    await logShopify(
      `❌ Error en upsert del carrito ${checkout_token}: ${err.message}`,
    );
    throw err; // que lo capture el setImmediate del controller
  }
};

/* ========= Webhook: checkouts/create ========= */
exports.handleCheckoutCreate = catchAsync(async (req, res) => {
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      await ensureDir(logsDir);
      const checkout = req.body || {};

      await logShopify(
        `🛒 checkouts/create token=${checkout.token || 'sin_token'}`,
      );

      const resultado = await upsertCarrito(req, checkout);

      // Solo loguear "guardado" si realmente fue ok
      if (resultado.motivo === 'ok') {
        await logShopify(
          `   └─ ${resultado.creado ? 'NUEVO' : 'actualizado'} (id_cliente=${resultado.id_cliente})`,
        );
      }
      // Si fue ignorado por filtro, ya se logueó dentro de upsertCarrito
    } catch (err) {
      try {
        await ensureDir(logsDir);
        await logShopify(
          `❌ Error checkouts/create: ${err.message}\n${err.stack}`,
        );
      } catch (_) {}
    }
  });
});

/* ========= Webhook: checkouts/update ========= */
exports.handleCheckoutUpdate = catchAsync(async (req, res) => {
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      await ensureDir(logsDir);
      const checkout = req.body || {};

      await logShopify(
        `🔄 checkouts/update token=${checkout.token || 'sin_token'}`,
      );

      const resultado = await upsertCarrito(req, checkout);

      if (resultado.motivo === 'ok') {
        await logShopify(
          `   └─ ${resultado.creado ? 'NUEVO' : 'actualizado'} (id_cliente=${resultado.id_cliente})`,
        );
      }
    } catch (err) {
      try {
        await ensureDir(logsDir);
        await logShopify(
          `❌ Error checkouts/update: ${err.message}\n${err.stack}`,
        );
      } catch (_) {}
    }
  });
});

/* ========= Webhook: checkouts/delete ========= */
exports.handleCheckoutDelete = catchAsync(async (req, res) => {
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      await ensureDir(logsDir);

      const checkout = req.body || {};
      const id_configuracion = req.shopifyConfig?.id_configuracion;
      const checkout_token = checkout.token;

      if (!id_configuracion || !checkout_token) {
        await logShopify(`⚠️ checkouts/delete sin datos suficientes`);
        return;
      }

      const eliminados = await ShopifyCarritosAbandonados.destroy({
        where: { id_configuracion, checkout_token },
      });

      await logShopify(
        `🗑️ checkouts/delete token=${checkout_token} (eliminados=${eliminados})`,
      );
    } catch (err) {
      try {
        await ensureDir(logsDir);
        await logShopify(`❌ Error checkouts/delete: ${err.message}`);
      } catch (_) {}
    }
  });
});

/* ========= Webhook: orders/create → marcar carrito como recuperado ========= */
exports.handleOrderCreate = catchAsync(async (req, res) => {
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      await ensureDir(logsDir);

      const order = req.body || {};
      const id_configuracion = req.shopifyConfig?.id_configuracion;
      const checkout_token = order.checkout_token;
      const order_id = order.id;

      if (!id_configuracion || !checkout_token) {
        await logShopify(
          `⚠️ orders/create sin checkout_token (order_id=${order_id || 'N/A'}) - posible orden manual`,
        );
        return;
      }

      const [filasActualizadas] = await ShopifyCarritosAbandonados.update(
        { recuperado: 1 },
        { where: { id_configuracion, checkout_token } },
      );

      if (filasActualizadas > 0) {
        await logShopify(
          `🎉 Carrito RECUPERADO: ${checkout_token} (order_id=${order_id})`,
        );
      } else {
        // Pasa cuando la orden no tuvo checkout previo trackeado
        // (ej: orden creada manualmente, draft order, o checkout sin email/phone que se filtró)
        await logShopify(
          `ℹ️ orders/create sin carrito previo: ${checkout_token} (order_id=${order_id})`,
        );
      }
    } catch (err) {
      try {
        await ensureDir(logsDir);
        await logShopify(`❌ Error orders/create: ${err.message}`);
      } catch (_) {}
    }
  });
});
