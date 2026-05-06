const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ShopifyConfiguraciones = require('../models/shopify_configuraciones.model');

const logsDir = path.join(process.cwd(), './src/logs/logs_shopify');

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    console.error('[Shopify] No se pudo crear logsDir:', e.message);
  }
}

const logDebug = async (mensaje) => {
  try {
    await ensureDir(logsDir);
    console.log('[SHOPIFY-MW]', mensaje);
    await fsp.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${mensaje}\n`,
    );
  } catch (e) {
    console.error('[Shopify] Falló log:', e.message);
  }
};

const verifyShopifyWebhook = async (req, res, next) => {
  /* 🔍 Loguear TODO request entrante ANTES de validar */
  await logDebug(
    `📥 REQUEST | URL=${req.originalUrl} | Método=${req.method} | ` +
      `Shop=${req.get('X-Shopify-Shop-Domain') || 'NO HEADER'} | ` +
      `HMAC=${req.get('X-Shopify-Hmac-Sha256') ? 'PRESENTE' : 'AUSENTE'} | ` +
      `RawBody=${req.rawBody ? 'PRESENTE (' + req.rawBody.length + ' chars)' : 'AUSENTE'}`,
  );

  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const shopDomain = req.get('X-Shopify-Shop-Domain');

    if (!hmacHeader) {
      await logDebug(`❌ Falta header HMAC`);
      return res.status(401).send('Unauthorized: missing HMAC');
    }
    if (!shopDomain) {
      await logDebug(`❌ Falta header Shop-Domain`);
      return res.status(401).send('Unauthorized: missing Shop-Domain');
    }
    if (!req.rawBody) {
      await logDebug(`❌ Falta rawBody (revisa orden de express.json verify)`);
      return res.status(401).send('Unauthorized: missing rawBody');
    }

    const config = await ShopifyConfiguraciones.findOne({
      where: { shop_domain: shopDomain, activo: 1 },
    });

    if (!config) {
      await logDebug(`❌ Shop no configurada en BD: ${shopDomain}`);
      return res.status(401).send('Shop no configurada');
    }

    const generatedHash = crypto
      .createHmac('sha256', config.webhook_secret)
      .update(req.rawBody, 'utf8')
      .digest('base64');

    /* 👇 Evitar crash si los buffers tienen distinta longitud (HMAC fake) */
    if (Buffer.byteLength(generatedHash) !== Buffer.byteLength(hmacHeader)) {
      await logDebug(
        `❌ HMAC longitud diferente | Recibido=${hmacHeader.substring(0, 20)}... | Generado=${generatedHash.substring(0, 20)}...`,
      );
      return res.status(401).send('HMAC inválido (longitud)');
    }

    const isValid = crypto.timingSafeEqual(
      Buffer.from(generatedHash),
      Buffer.from(hmacHeader),
    );

    if (!isValid) {
      await logDebug(
        `❌ HMAC inválido | Recibido=${hmacHeader.substring(0, 20)}... | Generado=${generatedHash.substring(0, 20)}...`,
      );
      return res.status(401).send('HMAC inválido');
    }

    await logDebug(`✅ HMAC válido para ${shopDomain}`);
    req.shopifyConfig = config;
    next();
  } catch (err) {
    await logDebug(`❌ Excepción en middleware: ${err.message}`);
    return res.status(401).send('Unauthorized');
  }
};

module.exports = verifyShopifyWebhook;
