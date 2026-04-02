const axios = require('axios');
const crypto = require('crypto');

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { encryptToken, decryptToken } = require('../utils/cryptoToken');

const ShopifyConnections = require('../models/shopify_connections.model');

// ─── Config (variables de entorno) ──────────────────────────────────────────
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_REDIRECT_URI =
  process.env.SHOPIFY_REDIRECT_URI ||
  'https://chat.imporfactory.app/api/v1/shopify/callback';
const SHOPIFY_SCOPES = 'read_products,write_products,write_files,read_files';
const SHOPIFY_API_VERSION = '2026-01';

// Frontend base URL (sin trailing slash)
const FRONTEND_URL =
  process.env.FRONTEND_URL || 'https://chatcenter.imporfactory.app';

// Ruta del frontend donde redirigir post-conexión
const FRONTEND_LANDING_PATH = '/insta_landing';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function verifyShopifyHmac(query) {
  const { hmac, ...params } = query;
  if (!hmac) return false;

  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  const generated = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(sortedParams)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(generated, 'hex'),
      Buffer.from(hmac, 'hex'),
    );
  } catch {
    return false;
  }
}

async function shopifyGraphQL(shopDomain, accessToken, query, variables = {}) {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const resp = await axios.post(
    url,
    { query, variables },
    {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    },
  );
  return resp.data;
}

async function getActiveConnection(id_usuario, next) {
  const conn = await ShopifyConnections.findOne({
    where: { id_usuario, estado: 'activo' },
  });
  if (!conn) {
    next(
      new AppError(
        'No tienes una tienda Shopify conectada. Conéctala primero.',
        404,
      ),
    );
    return null;
  }
  try {
    const token = decryptToken(conn.access_token);
    return { connection: conn, accessToken: token };
  } catch {
    next(new AppError('Token de Shopify inválido. Reconecta tu tienda.', 401));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OAUTH: INICIAR CONEXIÓN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/shopify/auth
 * body: { shop_domain: "mi-tienda.myshopify.com" }
 */
exports.iniciar_auth = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  let shop = String(req.body?.shop_domain || '')
    .trim()
    .toLowerCase();
  if (!shop) return next(new AppError('shop_domain es requerido', 400));

  // Normalizar: aceptar "mi-tienda" o "mi-tienda.myshopify.com" o URL completa
  shop = shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!shop.includes('.myshopify.com')) {
    shop = `${shop}.myshopify.com`;
  }

  // Validar formato básico
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return next(
      new AppError(
        'Dominio inválido. Usa el formato: mi-tienda.myshopify.com',
        400,
      ),
    );
  }

  // Generar nonce para CSRF protection
  const nonce = crypto.randomBytes(16).toString('hex');

  // state = JSON con id_usuario + nonce, codificado en base64url
  const state = Buffer.from(JSON.stringify({ nonce, id_usuario })).toString(
    'base64url',
  );

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(SHOPIFY_REDIRECT_URI)}` +
    `&state=${state}`;

  return res.json({
    isSuccess: true,
    auth_url: authUrl,
    shop_domain: shop,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OAUTH: CALLBACK (Shopify redirige aquí)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/shopify/callback?code=xxx&hmac=xxx&shop=xxx&state=xxx
 *
 * Shopify redirige aquí después de que el merchant autoriza.
 * Intercambiamos el code por un access_token permanente y
 * redirigimos al frontend de InstaLanding.
 */
exports.callback = catchAsync(async (req, res, next) => {
  const { code, shop, state } = req.query;

  if (!code || !shop || !state) {
    // Redirigir al frontend con error en vez de devolver JSON
    return res.redirect(
      `${FRONTEND_URL}${FRONTEND_LANDING_PATH}?shopify_status=error&shopify_error=params_invalidos`,
    );
  }

  // 1. Verificar HMAC
  if (!verifyShopifyHmac(req.query)) {
    return res.redirect(
      `${FRONTEND_URL}${FRONTEND_LANDING_PATH}?shopify_status=error&shopify_error=hmac_invalido`,
    );
  }

  // 2. Decodificar state para obtener id_usuario
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch {
    return res.redirect(
      `${FRONTEND_URL}${FRONTEND_LANDING_PATH}?shopify_status=error&shopify_error=state_invalido`,
    );
  }
  const { id_usuario } = stateData;
  if (!id_usuario) {
    return res.redirect(
      `${FRONTEND_URL}${FRONTEND_LANDING_PATH}?shopify_status=error&shopify_error=usuario_no_identificado`,
    );
  }

  // 3. Intercambiar code por access_token
  let tokenResp;
  try {
    tokenResp = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      },
      { timeout: 15000 },
    );
  } catch (err) {
    console.error(
      '[Shopify] Token exchange error:',
      err?.response?.data || err.message,
    );
    return res.redirect(
      `${FRONTEND_URL}${FRONTEND_LANDING_PATH}?shopify_status=error&shopify_error=token_exchange_failed`,
    );
  }

  const accessToken = tokenResp.data?.access_token;
  const scopes = tokenResp.data?.scope || '';
  if (!accessToken) {
    return res.redirect(
      `${FRONTEND_URL}${FRONTEND_LANDING_PATH}?shopify_status=error&shopify_error=no_access_token`,
    );
  }

  // 4. Obtener info básica de la tienda
  let shopInfo = {};
  try {
    const shopQuery = `{ shop { name email myshopifyDomain } }`;
    const shopResp = await shopifyGraphQL(shop, accessToken, shopQuery);
    shopInfo = shopResp?.data?.shop || {};
  } catch (e) {
    console.error('[Shopify] Shop info error:', e.message);
  }

  // 5. Guardar o actualizar conexión
  const existing = await ShopifyConnections.findOne({
    where: { id_usuario, shop_domain: shop },
  });

  if (existing) {
    await existing.update({
      access_token: encryptToken(accessToken),
      scopes,
      shop_name: shopInfo.name || existing.shop_name,
      shop_email: shopInfo.email || existing.shop_email,
      estado: 'activo',
      ultima_sincronizacion: new Date(),
    });
  } else {
    // Desactivar conexiones previas (1 tienda activa a la vez)
    await ShopifyConnections.update(
      { estado: 'desconectado' },
      { where: { id_usuario, estado: 'activo' } },
    );

    await ShopifyConnections.create({
      id_usuario,
      shop_domain: shop,
      access_token: encryptToken(accessToken),
      scopes,
      shop_name: shopInfo.name || null,
      shop_email: shopInfo.email || null,
      estado: 'activo',
      ultima_sincronizacion: new Date(),
    });
  }

  // 6. Redirigir al frontend de InstaLanding con éxito
  const shopName = encodeURIComponent(shopInfo.name || shop);
  return res.redirect(
    `${FRONTEND_URL}${FRONTEND_LANDING_PATH}?shopify_status=success&shopify_shop=${shopName}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ESTADO DE CONEXIÓN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/shopify/status
 */
exports.status = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const conn = await ShopifyConnections.findOne({
    where: { id_usuario, estado: 'activo' },
    attributes: [
      'id',
      'shop_domain',
      'shop_name',
      'shop_email',
      'scopes',
      'estado',
      'ultima_sincronizacion',
      'created_at',
    ],
  });

  return res.json({
    isSuccess: true,
    connected: !!conn,
    data: conn || null,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DESCONECTAR TIENDA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/shopify/disconnect
 */
exports.disconnect = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const conn = await ShopifyConnections.findOne({
    where: { id_usuario, estado: 'activo' },
  });
  if (!conn) return next(new AppError('No tienes una tienda conectada', 404));

  await conn.update({ estado: 'desconectado' });

  return res.json({
    isSuccess: true,
    message: 'Tienda Shopify desconectada exitosamente',
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LISTAR PRODUCTOS DE LA TIENDA CONECTADA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/shopify/products?search=xxx&cursor=xxx&limit=20
 */
exports.listar_productos = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const connData = await getActiveConnection(id_usuario, next);
  if (!connData) return;
  const { connection, accessToken } = connData;

  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const cursor = req.query.cursor || null;
  const search = (req.query.search || '').trim();

  const afterClause = cursor ? `, after: "${cursor}"` : '';
  const queryFilter = search ? `query: "title:*${search}*"` : '';

  const gqlQuery = `{
    products(first: ${limit}${afterClause}${queryFilter ? `, ${queryFilter}` : ''}) {
      edges {
        cursor
        node {
          id
          title
          handle
          status
          featuredImage {
            url
            altText
          }
          totalInventory
          variants(first: 1) {
            edges {
              node {
                price
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

  let data;
  try {
    data = await shopifyGraphQL(connection.shop_domain, accessToken, gqlQuery);
  } catch (err) {
    console.error(
      '[Shopify] Products query error:',
      err?.response?.data || err.message,
    );
    if (err?.response?.status === 401) {
      await connection.update({ estado: 'error' });
      return next(
        new AppError(
          'Tu conexión con Shopify ha expirado. Reconecta tu tienda.',
          401,
        ),
      );
    }
    return next(new AppError('Error al consultar productos de Shopify', 500));
  }

  const edges = data?.data?.products?.edges || [];
  const pageInfo = data?.data?.products?.pageInfo || {};

  const products = edges.map((e) => ({
    id: e.node.id,
    title: e.node.title,
    handle: e.node.handle,
    status: e.node.status,
    image_url: e.node.featuredImage?.url || null,
    price: e.node.variants?.edges?.[0]?.node?.price || null,
    inventory: e.node.totalInventory,
    cursor: e.cursor,
  }));

  return res.json({
    isSuccess: true,
    data: products,
    pagination: {
      has_next: pageInfo.hasNextPage || false,
      next_cursor: pageInfo.endCursor || null,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUBIR IMAGEN COMO PRODUCT MEDIA (carrusel del producto)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/shopify/upload-product-image
 * body: {
 *   product_id: "gid://shopify/Product/123456",
 *   image_url:  "https://uploader.imporfactory.app/.../imagen.png",
 *   alt_text:   "Descripción de la imagen" (opcional)
 * }
 */
exports.subir_imagen_producto = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const product_id = String(req.body?.product_id || '').trim();
  const image_url = String(req.body?.image_url || '').trim();
  const alt_text = String(
    req.body?.alt_text || 'Imagen generada con IA',
  ).trim();

  if (!product_id) return next(new AppError('product_id es requerido', 400));
  if (!image_url) return next(new AppError('image_url es requerido', 400));

  const connData = await getActiveConnection(id_usuario, next);
  if (!connData) return;
  const { connection, accessToken } = connData;

  // Subir y asociar media al producto en un solo paso con productCreateMedia
  // (Shopify descarga la imagen de la URL, la procesa y la asocia)
  const attachMediaMutation = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          ... on MediaImage {
            id
            image {
              url
            }
          }
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  let attachData;
  try {
    attachData = await shopifyGraphQL(
      connection.shop_domain,
      accessToken,
      attachMediaMutation,
      {
        productId: product_id,
        media: [
          {
            alt: alt_text,
            mediaContentType: 'IMAGE',
            originalSource: image_url,
          },
        ],
      },
    );
  } catch (err) {
    console.error(
      '[Shopify] productCreateMedia error:',
      err?.response?.data || err.message,
    );
    if (err?.response?.status === 401) {
      await connection.update({ estado: 'error' });
      return next(
        new AppError('Tu conexión con Shopify ha expirado. Reconecta.', 401),
      );
    }
    return next(new AppError('Error al subir imagen a Shopify', 500));
  }

  const mediaErrors =
    attachData?.data?.productCreateMedia?.mediaUserErrors || [];
  if (mediaErrors.length > 0) {
    console.error('[Shopify] productCreateMedia errors:', mediaErrors);
    return next(
      new AppError(`Shopify rechazó la imagen: ${mediaErrors[0].message}`, 422),
    );
  }

  const attachedMedia = attachData?.data?.productCreateMedia?.media?.[0];

  await connection.update({ ultima_sincronizacion: new Date() });

  return res.json({
    isSuccess: true,
    message: 'Imagen subida al producto exitosamente',
    data: {
      media_id: attachedMedia?.id || null,
      shopify_image_url: attachedMedia?.image?.url || null,
      product_id,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INSERTAR IMAGEN EN LA DESCRIPCIÓN (body_html)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/shopify/upload-description-image
 * body: {
 *   product_id: "gid://shopify/Product/123456",
 *   image_url:  "https://uploader.imporfactory.app/.../imagen.png",
 *   position:   "prepend" | "append" | "replace" (default: append),
 *   alt_text:   "Descripción" (opcional)
 * }
 */
exports.insertar_imagen_descripcion = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const product_id = String(req.body?.product_id || '').trim();
  const image_url = String(req.body?.image_url || '').trim();
  const position = String(req.body?.position || 'append').trim();
  const alt_text = String(
    req.body?.alt_text || 'Imagen generada con IA',
  ).trim();

  if (!product_id) return next(new AppError('product_id es requerido', 400));
  if (!image_url) return next(new AppError('image_url es requerido', 400));

  const connData = await getActiveConnection(id_usuario, next);
  if (!connData) return;
  const { connection, accessToken } = connData;

  // Paso 1: Obtener body_html actual
  const getProductQuery = `{
    product(id: "${product_id}") {
      id
      title
      descriptionHtml
    }
  }`;

  let productData;
  try {
    productData = await shopifyGraphQL(
      connection.shop_domain,
      accessToken,
      getProductQuery,
    );
  } catch (err) {
    console.error(
      '[Shopify] Get product error:',
      err?.response?.data || err.message,
    );
    return next(new AppError('Error al obtener producto de Shopify', 500));
  }

  const product = productData?.data?.product;
  if (!product)
    return next(new AppError('Producto no encontrado en Shopify', 404));

  const currentHtml = product.descriptionHtml || '';
  const imgTag = `<img src="${image_url}" alt="${alt_text}" style="max-width:100%;height:auto;display:block;margin:16px auto;" />`;

  let newHtml;
  if (position === 'prepend') {
    newHtml = imgTag + '\n' + currentHtml;
  } else if (position === 'replace') {
    newHtml = imgTag;
  } else {
    newHtml = currentHtml + '\n' + imgTag;
  }

  // Paso 2: Actualizar body_html
  const updateMutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          title
          descriptionHtml
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  let updateData;
  try {
    updateData = await shopifyGraphQL(
      connection.shop_domain,
      accessToken,
      updateMutation,
      { input: { id: product_id, descriptionHtml: newHtml } },
    );
  } catch (err) {
    console.error(
      '[Shopify] productUpdate error:',
      err?.response?.data || err.message,
    );
    return next(
      new AppError('Error al actualizar descripción del producto', 500),
    );
  }

  const updateErrors = updateData?.data?.productUpdate?.userErrors || [];
  if (updateErrors.length > 0) {
    return next(
      new AppError(
        `Error al actualizar producto: ${updateErrors[0].message}`,
        422,
      ),
    );
  }

  await connection.update({ ultima_sincronizacion: new Date() });

  return res.json({
    isSuccess: true,
    message: 'Imagen insertada en la descripción del producto',
    data: {
      product_id,
      product_title: product.title,
      position,
      image_url,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUBIDA MASIVA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/shopify/upload-batch
 * body: {
 *   product_id: "gid://shopify/Product/123456",
 *   images: [
 *     { url: "https://...", alt: "Hero", type: "product_media" },
 *     { url: "https://...", alt: "Oferta", type: "description" }
 *   ]
 * }
 */
exports.subir_batch = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const product_id = String(req.body?.product_id || '').trim();
  const images = req.body?.images;

  if (!product_id) return next(new AppError('product_id es requerido', 400));
  if (!Array.isArray(images) || images.length === 0)
    return next(new AppError('images es requerido (array)', 400));
  if (images.length > 10)
    return next(new AppError('Máximo 10 imágenes por batch', 400));

  const connData = await getActiveConnection(id_usuario, next);
  if (!connData) return;
  const { connection, accessToken } = connData;

  const results = [];

  // ── Product media (carrusel) ──
  const mediaImages = images.filter((img) => img.type === 'product_media');
  if (mediaImages.length > 0) {
    const mutation = `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            ... on MediaImage { id image { url } }
          }
          mediaUserErrors { field message }
        }
      }
    `;

    try {
      const mediaInputs = mediaImages.map((img) => ({
        alt: img.alt || 'Imagen generada con IA',
        mediaContentType: 'IMAGE',
        originalSource: img.url,
      }));

      const resp = await shopifyGraphQL(
        connection.shop_domain,
        accessToken,
        mutation,
        { productId: product_id, media: mediaInputs },
      );

      const errors = resp?.data?.productCreateMedia?.mediaUserErrors || [];
      const created = resp?.data?.productCreateMedia?.media || [];

      mediaImages.forEach((img, i) => {
        results.push({
          url: img.url,
          type: 'product_media',
          success: errors.length === 0,
          shopify_id: created[i]?.id || null,
          error: errors[i]?.message || null,
        });
      });
    } catch (err) {
      console.error('[Shopify] Batch media error:', err.message);
      mediaImages.forEach((img) => {
        results.push({
          url: img.url,
          type: 'product_media',
          success: false,
          error: 'Error al subir a Shopify',
        });
      });
    }
  }

  // ── Description images (body_html) ──
  const descImages = images.filter((img) => img.type === 'description');
  if (descImages.length > 0) {
    try {
      const getQuery = `{ product(id: "${product_id}") { descriptionHtml } }`;
      const prodData = await shopifyGraphQL(
        connection.shop_domain,
        accessToken,
        getQuery,
      );
      let html = prodData?.data?.product?.descriptionHtml || '';

      descImages.forEach((img) => {
        const alt = img.alt || 'Imagen generada con IA';
        html += `\n<img src="${img.url}" alt="${alt}" style="max-width:100%;height:auto;display:block;margin:16px auto;" />`;
      });

      const updateMutation = `
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id }
            userErrors { field message }
          }
        }
      `;

      const updateResp = await shopifyGraphQL(
        connection.shop_domain,
        accessToken,
        updateMutation,
        { input: { id: product_id, descriptionHtml: html } },
      );

      const updateErrors = updateResp?.data?.productUpdate?.userErrors || [];
      const success = updateErrors.length === 0;

      descImages.forEach((img) => {
        results.push({
          url: img.url,
          type: 'description',
          success,
          error: updateErrors[0]?.message || null,
        });
      });
    } catch (err) {
      console.error('[Shopify] Batch description error:', err.message);
      descImages.forEach((img) => {
        results.push({
          url: img.url,
          type: 'description',
          success: false,
          error: 'Error al actualizar descripción',
        });
      });
    }
  }

  await connection.update({ ultima_sincronizacion: new Date() });

  const allSuccess = results.every((r) => r.success);

  return res.json({
    isSuccess: true,
    message: allSuccess
      ? 'Todas las imágenes subidas exitosamente'
      : 'Algunas imágenes tuvieron errores',
    data: {
      product_id,
      total: results.length,
      success_count: results.filter((r) => r.success).length,
      results,
    },
  });
});

exports.listar_ordenes = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const connData = await getActiveConnection(id_usuario, next);
  if (!connData) return;
  const { connection, accessToken } = connData;

  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const cursor = req.query.cursor || null;
  const status = req.query.status || null; // "unfulfilled", "fulfilled", etc.

  const afterClause = cursor ? `, after: "${cursor}"` : '';
  const queryParts = [];
  if (status) queryParts.push(`fulfillment_status:${status}`);
  const queryFilter = queryParts.length
    ? `, query: "${queryParts.join(' AND ')}"`
    : '';

  const gqlQuery = `{
    orders(first: ${limit}${afterClause}${queryFilter}, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName email }
          lineItems(first: 5) {
            edges {
              node {
                title
                quantity
                originalTotalSet { shopMoney { amount currencyCode } }
                image { url }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

  let data;
  try {
    data = await shopifyGraphQL(connection.shop_domain, accessToken, gqlQuery);
  } catch (err) {
    console.error(
      '[Shopify] Orders query error:',
      err?.response?.data || err.message,
    );
    if (err?.response?.status === 401) {
      await connection.update({ estado: 'error' });
      return next(
        new AppError(
          'Tu conexión con Shopify ha expirado. Reconecta tu tienda.',
          401,
        ),
      );
    }
    return next(new AppError('Error al consultar órdenes de Shopify', 500));
  }

  const edges = data?.data?.orders?.edges || [];
  const pageInfo = data?.data?.orders?.pageInfo || {};

  const orders = edges.map((e) => ({
    id: e.node.id,
    name: e.node.name,
    created_at: e.node.createdAt,
    financial_status: e.node.displayFinancialStatus,
    fulfillment_status: e.node.displayFulfillmentStatus,
    total: e.node.totalPriceSet?.shopMoney?.amount || '0',
    currency: e.node.totalPriceSet?.shopMoney?.currencyCode || 'USD',
    customer: e.node.customer
      ? {
          name: `${e.node.customer.firstName || ''} ${e.node.customer.lastName || ''}`.trim(),
          email: e.node.customer.email,
        }
      : null,
    line_items: (e.node.lineItems?.edges || []).map((li) => ({
      title: li.node.title,
      quantity: li.node.quantity,
      total: li.node.originalTotalSet?.shopMoney?.amount || '0',
      image_url: li.node.image?.url || null,
    })),
    cursor: e.cursor,
  }));

  return res.json({
    isSuccess: true,
    data: orders,
    pagination: {
      has_next: pageInfo.hasNextPage || false,
      next_cursor: pageInfo.endCursor || null,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GDPR COMPLIANCE WEBHOOK UNIFICADO (obligatorio para app pública)
// ═══════════════════════════════════════════════════════════════════════════

exports.handleComplianceWebhook = async (req, res) => {
  const topic = req.get('X-Shopify-Topic');
  console.log(`[Shopify Webhook] Topic: ${topic}`, JSON.stringify(req.body));

  if (topic === 'shop/redact') {
    try {
      const shopDomain = req.body?.shop_domain;
      if (shopDomain) {
        await ShopifyConnections.update(
          { estado: 'eliminado', access_token: null },
          { where: { shop_domain: shopDomain } },
        );
        console.log(`[Shopify Webhook] Conexión eliminada para ${shopDomain}`);
      }
    } catch (err) {
      console.error('[Shopify Webhook] Error:', err.message);
    }
  }

  // customers/data_request y customers/redact → 200 OK
  // (no almacenamos datos de clientes directamente)
  return res.status(200).json({ received: true });
};
