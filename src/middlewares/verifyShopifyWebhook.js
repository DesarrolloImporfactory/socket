const crypto = require('crypto');
const ShopifyConfiguraciones = require('../models/shopify_configuraciones.model');

/**
 * Multi-tenant: busca el secret de la tienda según X-Shopify-Shop-Domain
 * y valida HMAC. Adjunta req.shopifyConfig para usar después.
 */
const verifyShopifyWebhook = async (req, res, next) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const shopDomain = req.get('X-Shopify-Shop-Domain');

    if (!hmacHeader || !shopDomain || !req.rawBody) {
      return res.status(401).send('Unauthorized');
    }

    const config = await ShopifyConfiguraciones.findOne({
      where: { shop_domain: shopDomain, activo: 1 },
    });

    if (!config) {
      return res.status(401).send('Shop no configurada');
    }

    const generatedHash = crypto
      .createHmac('sha256', config.webhook_secret)
      .update(req.rawBody, 'utf8')
      .digest('base64');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(generatedHash),
      Buffer.from(hmacHeader),
    );

    if (!isValid) {
      return res.status(401).send('HMAC inválido');
    }

    req.shopifyConfig = config; // disponible en el controller
    next();
  } catch (err) {
    console.error('[Shopify HMAC] Error:', err);
    return res.status(401).send('Unauthorized');
  }
};

module.exports = verifyShopifyWebhook;