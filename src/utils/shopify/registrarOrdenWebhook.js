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

    await db.query(
      `INSERT IGNORE INTO shopify_ordenes_webhook
         (id_configuracion, shopify_order_id, order_number, phone_normalizado,
          total_price, currency, financial_status, shopify_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          order.id,
          order.order_number != null ? String(order.order_number) : null,
          phone_normalizado || null,
          Number(order.total_price || 0),
          order.currency || null,
          order.financial_status || null,
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

module.exports = { registrarOrdenWebhook };
