/**
 * Crea el complemento «ImporKiller» ($10/mes) como se venden las conexiones y
 * subusuarios adicionales: producto + price recurrente en Stripe (TEST y LIVE,
 * según las llaves que haya en el .env) y la fila en addons_chat_center con
 * target_columna = imporkiller (usuarios_chat_center.imporkiller, ver
 * espia_mercado_migration.sql sección 04-11-2026 b).
 *
 *   node scripts/crearAddonImporKiller.js          → solo muestra qué haría
 *   node scripts/crearAddonImporKiller.js --crear  → crea en Stripe y guarda la fila
 *
 * Idempotente: si ya existe un producto activo llamado «ImporKiller» con un
 * price mensual de $10 lo reutiliza; si la fila ya existe, solo completa los
 * ids que falten. No toca nada de los otros complementos.
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');

const CREAR = process.argv.includes('--crear');

const ADDON = {
  clave: 'imporkiller',
  nombre: 'ImporKiller',
  descripcion:
    'Extensión de Chrome con ventas estimadas dentro de Dropi y descargador de anuncios de Meta ($10/mes recurrente).',
  precio: 10,
  target_columna: 'imporkiller',
};

const ENTORNOS = [
  { nombre: 'LIVE', key: process.env.STRIPE_SECRET_KEY, prodCol: 'id_product_stripe_prod', priceCol: 'id_price_prod' },
  { nombre: 'TEST', key: process.env.STRIPE_SECRET_KEY_TEST, prodCol: 'id_product_stripe_test', priceCol: 'id_price_test' },
];

async function asegurarEnStripe(entorno, fila) {
  const stripe = new Stripe(entorno.key, { apiVersion: '2024-06-20' });
  let productId = fila?.[entorno.prodCol] || null;

  if (!productId) {
    const { data } = await stripe.products.search({ query: `active:'true' AND name:'${ADDON.nombre}'` });
    productId = data[0]?.id || null;
    if (productId) console.log(`  [${entorno.nombre}] producto existente ${productId}`);
  }
  if (!productId) {
    if (!CREAR) {
      console.log(`  [${entorno.nombre}] crearía el producto «${ADDON.nombre}»`);
      return { productId: null, priceId: null };
    }
    const p = await stripe.products.create({
      name: ADDON.nombre,
      description: ADDON.descripcion,
      metadata: { addon_clave: ADDON.clave, origen: 'imporchat' },
    });
    productId = p.id;
    console.log(`  [${entorno.nombre}] producto creado ${productId}`);
  }

  let priceId = fila?.[entorno.priceCol] || null;
  if (!priceId) {
    const { data } = await stripe.prices.list({ product: productId, active: true, limit: 20 });
    const existente = data.find(
      (pr) => pr.recurring?.interval === 'month' && pr.unit_amount === ADDON.precio * 100 && pr.currency === 'usd',
    );
    priceId = existente?.id || null;
    if (priceId) console.log(`  [${entorno.nombre}] price existente ${priceId}`);
  }
  if (!priceId) {
    if (!CREAR) {
      console.log(`  [${entorno.nombre}] crearía el price $${ADDON.precio}/mes`);
      return { productId, priceId: null };
    }
    const pr = await stripe.prices.create({
      product: productId,
      unit_amount: ADDON.precio * 100,
      currency: 'usd',
      recurring: { interval: 'month' },
      nickname: `${ADDON.nombre} mensual`,
      metadata: { addon_clave: ADDON.clave },
    });
    priceId = pr.id;
    console.log(`  [${entorno.nombre}] price creado ${priceId}`);
  }
  return { productId, priceId };
}

(async () => {
  const [[fila]] = await db.query(`SELECT * FROM addons_chat_center WHERE clave = ? LIMIT 1`, {
    replacements: [ADDON.clave],
  });
  console.log(fila ? `Fila addons_chat_center.${ADDON.clave} existe (id ${fila.id_addon})` : `Fila addons_chat_center.${ADDON.clave} no existe`);
  if (!CREAR) console.log('Modo vista previa: agrega --crear para ejecutar.\n');

  const ids = {};
  for (const entorno of ENTORNOS) {
    if (!entorno.key) {
      console.log(`  [${entorno.nombre}] sin llave en .env: se salta`);
      continue;
    }
    const r = await asegurarEnStripe(entorno, fila);
    ids[entorno.prodCol] = r.productId;
    ids[entorno.priceCol] = r.priceId;
  }

  if (!CREAR) {
    await db.close();
    return;
  }

  if (fila) {
    await db.query(
      `UPDATE addons_chat_center
          SET activo = 1, nombre = ?, descripcion = ?, precio = ?, target_columna = ?,
              id_product_stripe_prod = COALESCE(id_product_stripe_prod, ?),
              id_price_prod = COALESCE(id_price_prod, ?),
              id_product_stripe_test = COALESCE(id_product_stripe_test, ?),
              id_price_test = COALESCE(id_price_test, ?)
        WHERE clave = ?`,
      {
        replacements: [
          ADDON.nombre, ADDON.descripcion, ADDON.precio, ADDON.target_columna,
          ids.id_product_stripe_prod || null, ids.id_price_prod || null,
          ids.id_product_stripe_test || null, ids.id_price_test || null,
          ADDON.clave,
        ],
      },
    );
    console.log('Fila actualizada.');
  } else {
    await db.query(
      `INSERT INTO addons_chat_center
         (clave, activo, nombre, descripcion, precio, id_product_stripe_prod, id_price_prod, id_product_stripe_test, id_price_test, target_columna)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          ADDON.clave, ADDON.nombre, ADDON.descripcion, ADDON.precio,
          ids.id_product_stripe_prod || null, ids.id_price_prod || null,
          ids.id_product_stripe_test || null, ids.id_price_test || null,
          ADDON.target_columna,
        ],
      },
    );
    console.log('Fila creada.');
  }
  const [[final]] = await db.query(`SELECT clave, activo, precio, id_price_prod, id_price_test, target_columna FROM addons_chat_center WHERE clave = ?`, {
    replacements: [ADDON.clave],
  });
  console.log(final);
  await db.close();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  try { await db.close(); } catch (_) { /* nada */ }
  process.exit(1);
});
