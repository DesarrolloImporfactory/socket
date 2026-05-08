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
    await ensureDir(logsDir); // 👈 AGREGADO: garantiza que la carpeta exista
    console.log('[SHOPIFY]', mensaje);
    await fsp.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${mensaje}\n`,
    );
  } catch (e) {
    console.error('[Shopify] Falló log:', e.message); // 👈 ya no es silencioso
  }
};

/* ============================================================
   Webhook: orders/create
   Marca carritos abandonados como recuperados (busca por teléfono)
   ============================================================ */
exports.handleOrderCreate = catchAsync(async (req, res) => {
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      await ensureDir(logsDir);

      const order = req.body || {};
      const id_configuracion = req.shopifyConfig?.id_configuracion;
      const order_id = order.id;

      if (!id_configuracion) {
        await logShopify(`⚠️ orders/create sin id_configuracion`);
        return;
      }

      /* Extraer teléfono del cliente que completó la compra */
      const customer = order.customer || {};
      const shippingAddress = order.shipping_address || {};
      const billingAddress = order.billing_address || {};

      const phone_raw =
        order.phone ||
        customer.phone ||
        shippingAddress.phone ||
        billingAddress.phone ||
        null;

      if (!phone_raw) {
        await logShopify(
          `ℹ️ orders/create sin teléfono (order_id=${order_id})`,
        );
        return;
      }

      const phone_normalizado = normalizarTelefono(
        phone_raw,
        req.shopifyConfig.prefijo_pais,
      );

      if (!phone_normalizado || phone_normalizado.length < 10) {
        await logShopify(
          `ℹ️ orders/create teléfono inválido (order_id=${order_id})`,
        );
        return;
      }

      /* Marcar como recuperado el carrito abandonado más reciente del mismo teléfono */
      const [filasActualizadas] = await ShopifyCarritosAbandonados.update(
        { recuperado: 1 },
        {
          where: {
            id_configuracion,
            phone_normalizado,
            recuperado: 0,
          },
        },
      );

      if (filasActualizadas > 0) {
        await logShopify(
          `🎉 Carrito(s) RECUPERADO(s): ${filasActualizadas} ` +
            `phone=${phone_normalizado} (order_id=${order_id})`,
        );
      } else {
        await logShopify(
          `ℹ️ orders/create sin carrito previo: phone=${phone_normalizado} (order_id=${order_id})`,
        );
      }
    } catch (err) {
      await logShopify(`❌ Error orders/create: ${err.message}`);
    }
  });
});

/* ============================================================
   Webhook: draft_orders/create
   Captura abandonos de Releasit COD Form (filtrados por etiqueta)
   ============================================================ */
exports.handleAbandonedDraft = catchAsync(async (req, res) => {
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      await ensureDir(logsDir);

      const draft = req.body || {};
      const draft_id = draft.id;
      const tags = draft.tags || '';

      await logShopify(`📝 draft_orders/create id=${draft_id} tags="${tags}"`);

      /* 🔑 Filtrar SOLO los drafts que vienen de Releasit como abandono */
      const RELEASIT_TAG = 'abandoned_checkout_releasit_cod_form';
      const tagsArray = tags.split(',').map((t) => t.trim());

      if (!tagsArray.includes(RELEASIT_TAG)) {
        await logShopify(
          `⏭️ Draft ignorado (no es abandono de Releasit): id=${draft_id}`,
        );
        return;
      }

      const shopifyConfig = req.shopifyConfig;
      const id_configuracion = shopifyConfig.id_configuracion;
      const shop_domain = shopifyConfig.shop_domain;

      /* Extraer datos */
      const customer = draft.customer || {};
      const shippingAddress = draft.shipping_address || {};
      const billingAddress = draft.billing_address || {};

      const email = draft.email || customer.email || null;
      const phone_raw =
        customer.phone || shippingAddress.phone || billingAddress.phone || null;

      if (!email && !phone_raw) {
        await logShopify(`⏭️ Draft sin contacto: id=${draft_id}`);
        return;
      }

      /* Normalizar teléfono */
      const phone_normalizado_raw = phone_raw
        ? normalizarTelefono(phone_raw, shopifyConfig.prefijo_pais)
        : null;
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

      /* Identificador único: usamos el draft_id prefijado para distinguirlo */
      const checkout_token = `draft_${draft_id}`;

      /* Verificar duplicado / ya recuperado */
      const existente = await ShopifyCarritosAbandonados.findOne({
        where: { id_configuracion, checkout_token },
        attributes: ['id', 'id_cliente', 'recuperado'],
      });

      if (existente?.recuperado === 1) {
        await logShopify(`⏭️ Draft ya recuperado: id=${draft_id}`);
        return;
      }

      /* Asociar cliente unificado */
      let id_cliente = existente?.id_cliente || null;

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
              motivo: 'releasit_abandoned_draft',
              permiso_round_robin: configuracion.permiso_round_robin,
            });
            id_cliente = cliente?.id || null;

            if (id_cliente) {
              await logShopify(
                `✅ Cliente unificado: id=${id_cliente} phone=${phone_normalizado}`,
              );
            }
          }
        } catch (err) {
          await logShopify(`⚠️ Error cliente unificado: ${err.message}`);
        }
      }

      /* Resumir line_items */
      const lineItems = (draft.line_items || []).map((item) => ({
        id: item.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        title: item.title,
        sku: item.sku,
        quantity: item.quantity,
        price: item.price,
        vendor: item.vendor,
      }));

      /* 💎 Extraer Recovery URL (lo más valioso para el WhatsApp) */
      const noteAttrs = Array.isArray(draft.note_attributes)
        ? draft.note_attributes
        : [];
      const getNoteAttr = (name) => {
        const found = noteAttrs.find((a) => a?.name === name);
        return found?.value || null;
      };
      const recoveryUrl = getNoteAttr('Recovery URL');

      /* Upsert */
      const [registro, creado] = await ShopifyCarritosAbandonados.upsert({
        id_configuracion,
        id_cliente,
        shop_domain,
        source: 'releasit_form',
        checkout_token,
        checkout_id: draft_id,
        email,
        phone_raw,
        phone_normalizado,
        nombre_cliente,
        apellido_cliente,
        total_price: parseFloat(draft.total_price || 0),
        currency: draft.currency || 'USD',
        abandoned_checkout_url: recoveryUrl || draft.invoice_url || null,
        line_items: lineItems,
        shipping_address: shippingAddress,
        shopify_created_at: draft.created_at
          ? new Date(draft.created_at)
          : null,
        shopify_updated_at: draft.updated_at
          ? new Date(draft.updated_at)
          : null,
      });

      await logShopify(
        `🎯 RELEASIT ABANDONO ${creado ? 'NUEVO' : 'actualizado'}: ` +
          `draft=${draft_id} phone=${phone_normalizado} ` +
          `total=${draft.total_price} (id_cliente=${id_cliente})`,
      );
    } catch (err) {
      await logShopify(
        `❌ Error abandoned-draft: ${err.message}\n${err.stack}`,
      );
    }
  });
});

/* ========= Endpoint DEBUG: detectar qué webhooks dispara Shopify ========= */
exports.handleDebugWebhook = catchAsync(async (req, res) => {
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      await ensureDir(logsDir);

      const topic = req.get('X-Shopify-Topic') || 'sin_topic';
      const shop = req.get('X-Shopify-Shop-Domain') || 'sin_shop';
      const apiVersion = req.get('X-Shopify-API-Version') || 'sin_version';
      const triggeredAt = req.get('X-Shopify-Triggered-At') || 'sin_timestamp';
      const webhookId = req.get('X-Shopify-Webhook-Id') || 'sin_id';

      const body = req.body || {};
      const bodyPreview = JSON.stringify(body).substring(0, 500);

      const logLine = `
═══════════════════════════════════════════════════════════════
🔬 WEBHOOK DEBUG RECIBIDO
═══════════════════════════════════════════════════════════════
📅 Fecha:           ${new Date().toISOString()}
🎯 Topic:           ${topic}
🏪 Shop:            ${shop}
📦 API Version:     ${apiVersion}
⏰ Triggered At:    ${triggeredAt}
🆔 Webhook ID:      ${webhookId}
📊 Body keys:       ${Object.keys(body).join(', ')}
📝 Body preview:    ${bodyPreview}...
═══════════════════════════════════════════════════════════════
`;

      console.log(logLine);

      // Guardar log con TODO el contexto
      await fsp.appendFile(path.join(logsDir, 'debug_webhooks.txt'), logLine);

      // También guardar el body completo en un archivo separado por topic
      /* const safeTopic = topic.replace(/[^a-z0-9]/gi, '_');
      await fsp.appendFile(
        path.join(logsDir, `payload_${safeTopic}.json`),
        JSON.stringify(body, null, 2) + '\n\n---\n\n',
      ); */
    } catch (err) {
      console.error('[Shopify DEBUG] Error:', err.message);
    }
  });
});
