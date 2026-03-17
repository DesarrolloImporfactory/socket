const cron = require('node-cron');
const { db } = require('../database/config');
const { Op } = require('sequelize');

const ProductosChatCenter = require('../models/productos_chat_center.model');
const DropiIntegrations = require('../models/dropi_integrations.model');
const { decryptToken } = require('../utils/cryptoToken');
const dropiService = require('../services/dropi.service');

// ─── helpers ───
const DROPI_SOURCE = 'DROPI';

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) {
      console.log(' [syncDropiStock] Lock ocupado, saltando ejecución');
      return;
    }
    try {
      await fn();
    } finally {
      await db.query(`DO RELEASE_LOCK(?)`, {
        replacements: [lockName],
        type: db.QueryTypes.RAW,
      });
    }
  } finally {
    db.connectionManager.releaseConnection(conn);
  }
}

function calcTotalStock(product) {
  if (!Array.isArray(product?.warehouse_product)) return 0;
  return product.warehouse_product.reduce(
    (acc, wp) => acc + (Number(wp?.stock) || 0),
    0,
  );
}

async function getActiveIntegration(id_configuracion) {
  return DropiIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
}

// ─── lógica principal ───
async function syncAllDropiStock() {
  console.log('[syncDropiStock] Iniciando sincronización de stock Dropi…');

  // 1) Traer todos los productos vinculados a Dropi que no estén eliminados
  const productos = await ProductosChatCenter.findAll({
    where: {
      external_source: DROPI_SOURCE,
      external_id: { [Op.ne]: null },
      eliminado: 0,
    },
  });

  if (!productos.length) {
    console.log('ℹ [syncDropiStock] No hay productos Dropi para sincronizar');
    return;
  }

  console.log(
    `📦 [syncDropiStock] Productos a sincronizar: ${productos.length}`,
  );

  // 2) Agrupar por id_configuracion para reutilizar la misma integración
  const porConfig = {};
  for (const p of productos) {
    const key = p.id_configuracion;
    if (!porConfig[key]) porConfig[key] = [];
    porConfig[key].push(p);
  }

  let actualizados = 0;
  let errores = 0;

  // 3) Iterar por cada configuración
  for (const [idConfig, prods] of Object.entries(porConfig)) {
    const integration = await getActiveIntegration(Number(idConfig));
    if (!integration) {
      console.warn(
        `⚠️  [syncDropiStock] Config ${idConfig}: sin integración activa, saltando ${prods.length} productos`,
      );
      continue;
    }

    const integrationKey = decryptToken(integration.integration_key_enc);
    if (!integrationKey) {
      console.warn(`⚠️  [syncDropiStock] Config ${idConfig}: key inválida`);
      continue;
    }

    const { sync_stock, sync_sale_price, sync_suggested_price } = integration;

    // Si ninguno está activo, saltar toda la config
    if (!sync_stock && !sync_sale_price && !sync_suggested_price) {
      console.log(`[syncDropi] Config ${idConfig}: sin sync activo, saltando`);
      continue;
    }

    // 4) Por cada producto, consultar detalle en Dropi y actualizar stock

    for (const producto of prods) {
      try {
        const dropiDetail = await dropiService.getProductDetail({
          integrationKey,
          productId: producto.external_id,
          country_code: integration.country_code,
        });

        const prod = dropiDetail?.objects;
        if (!prod) {
          console.warn(
            ` [syncDropi] Producto Dropi #${producto.external_id} no encontrado`,
          );
          continue;
        }

        const updateFields = {};

        if (sync_stock) {
          const nuevoStock = calcTotalStock(prod);
          if (nuevoStock !== producto.stock) {
            updateFields.stock = nuevoStock;
          }
        }

        if (sync_sale_price && prod.sale_price != null) {
          const nuevo = parseFloat(prod.sale_price);
          if (nuevo !== parseFloat(producto.precio_proveedor || 0)) {
            updateFields.precio_proveedor = nuevo;
          }
        }

        if (sync_suggested_price && prod.suggested_price != null) {
          const nuevo = parseFloat(prod.suggested_price);
          if (nuevo !== parseFloat(producto.precio || 0)) {
            updateFields.precio = nuevo;
          }
        }

        if (Object.keys(updateFields).length > 0) {
          updateFields.fecha_actualizacion = new Date();
          await ProductosChatCenter.update(updateFields, {
            where: { id: producto.id },
          });
          console.log(
            `✅ [syncDropi] #${producto.id}: ${JSON.stringify(updateFields)}`,
          );
        }

        actualizados++;
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        errores++;
        console.error(`❌ [syncDropi] #${producto.id}: ${err.message}`);
      }
    }
  }

  console.log(
    ` [syncDropiStock] Finalizado — actualizados: ${actualizados}, errores: ${errores}`,
  );
}

let isRunning = false;

// ─── schedule: todos los días a las 4:00 AM (hora del servidor) ───
// cron.schedule('0 4 * * *', async () => {
cron.schedule('* * * * *', async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    await withLock('sync_dropi_stock_lock', syncAllDropiStock);
  } finally {
    isRunning = false;
  }
});

// Exportar por si en algun momento se llame desde un endpoint de admin
module.exports = { syncAllDropiStock };
