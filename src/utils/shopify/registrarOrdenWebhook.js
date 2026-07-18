'use strict';

const { db } = require('../../database/config');

/* ═══════════════════════════════════════════════════════════
   Registro persistente de órdenes recibidas por el webhook
   orders/create de Shopify (tabla shopify_ordenes_webhook,
   ver shopify_ordenes_webhook_migration.sql).

   Esta tabla es la FUENTE DE VERDAD de "pedidos que entraron
   por Shopify": el shop_type de Dropi no es confiable (marca
   SHOPIFY órdenes que en realidad entraron por WhatsApp).
   Los dashboards cruzan dropi_orders_cache contra esta tabla
   (teléfono + total + ventana de tiempo) para clasificar canal.
   ═══════════════════════════════════════════════════════════ */

/**
 * Inserta (idempotente) una orden del webhook orders/create.
 * Nunca lanza: un fallo aquí no debe romper el flujo del webhook.
 */
async function registrarOrdenWebhook({ id_configuracion, order, phone_normalizado }) {
  try {
    if (!id_configuracion || !order?.id) return false;

    // Snapshot de datos para recrear la orden en Dropi si nunca sincronizó
    // (el order del webhook es transitorio; aquí lo persistimos).
    const datosOrden = extraerDatosOrden(order);

    await db.query(
      `INSERT IGNORE INTO shopify_ordenes_webhook
         (id_configuracion, shopify_order_id, order_number, phone_normalizado,
          total_price, currency, financial_status, datos_orden, shopify_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          order.id,
          order.order_number != null ? String(order.order_number) : null,
          phone_normalizado || null,
          Number(order.total_price || 0),
          order.currency || null,
          order.financial_status || null,
          JSON.stringify(datosOrden),
          order.created_at ? new Date(order.created_at) : null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    return true;
  } catch (err) {
    console.error('[Shopify] Error registrando orden webhook:', err.message);
    return false;
  }
}

// Extrae del order del webhook los campos para recrear la orden en Dropi.
function extraerDatosOrden(order) {
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || {};
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  const nombre =
    customer.first_name || shipping.first_name || billing.first_name || '';
  const apellido =
    customer.last_name || shipping.last_name || billing.last_name || '';
  const direccion = [shipping.address1, shipping.address2]
    .filter(Boolean)
    .join(' ')
    .trim();

  const productos = lineItems.map((li) => ({
    nombre: li.title || li.name || '',
    cantidad: Number(li.quantity) || 1,
  }));

  return {
    nombre,
    apellido,
    telefono: phoneDigits(
      order.phone || customer.phone || shipping.phone || billing.phone,
    ),
    direccion,
    ciudad: shipping.city || billing.city || '',
    provincia: shipping.province || billing.province || '',
    productos,
    producto: productos[0]?.nombre || '',
    cantidad: String(productos[0]?.cantidad || 1),
    total: String(order.total_price || ''),
  };
}

function phoneDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

module.exports = { registrarOrdenWebhook };
