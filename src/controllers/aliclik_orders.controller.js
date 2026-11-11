const { Op, fn, literal } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const AliclikOrdersCache = require('../models/aliclik_orders_cache.model');
const aliclikService = require('../services/aliclik.service');
const { decryptToken } = require('../utils/cryptoToken');
const {
  normalizarOrden,
  upsertOrders,
  ESTADOS_ALICLIK,
} = require('../services/aliclik_notifier.service');
const {
  enrichOrdersWithChatAndAgent,
} = require('./dropi_integrations.controller');
const { getShopifyActivo } = require('./shopify_pedidos.controller');

/* Transportadora del pedido. No tiene columna propia: vive dentro de
   order_data (ver upsertOrders en aliclik_notifier.service, que la conserva
   entre sincronizaciones). JSON_VALUE devuelve NULL cuando la clave viene en
   null, a diferencia de JSON_UNQUOTE(JSON_EXTRACT()), que devuelve el texto
   'null'. La consulta siempre va acotada por id_configuracion + fecha, que es
   lo que usa el índice. */
const SQL_TRANSPORTADORA = "JSON_VALUE(order_data, '$.shipping_company')";

/* ═══════════════════════════════════════════════════════════
   Vista Pedidos — pestaña Aliclik

   Espeja a dropi_integrations.listOrdersFromCache: mismo sobre de respuesta
   ({ rows, total, page, page_size, total_pages, sync, productos_disponibles })
   para que la tabla del front no tenga que cambiar de forma según la
   plataforma.

   Lo que NO tiene y el de Dropi sí, porque no aplica:
     · guía y transportadora — Aliclik no las expone en ningún endpoint;
     · recuperación de teléfonos mochos — Aliclik devuelve el teléfono completo
       y con código de país, validado antes de guardarlo;
     · cruce con shopify_ordenes_webhook y órdenes REEMPLAZADAS — conceptos
       propios de Dropi.
   ═══════════════════════════════════════════════════════════ */

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const strOrNull = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// Cada cuánto se considera viejo el cache y se dispara un sync en background.
const CACHE_STALE_MIN = 10;

async function getIntegracionActiva(id_configuracion) {
  const [row] = await db.query(
    `SELECT id, id_configuracion, store_name, token_enc
       FROM aliclik_integrations
      WHERE id_configuracion = ? AND is_active = 1 AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/**
 * Trae de Aliclik los pedidos del rango y refresca el cache. Best-effort: si
 * su API falla se sigue sirviendo lo cacheado.
 */
async function syncDesdeAliclik({ integracion, from, until }) {
  const token = decryptToken(integracion.token_enc);
  if (!token?.trim()) return;

  const todas = [];
  for (let page = 1; page <= 20; page++) {
    const data = await aliclikService.listOrders({
      token,
      params: { page, limit: 100, startDate: from, endDate: until },
    });
    const filas = Array.isArray(data?.data) ? data.data : [];
    todas.push(...filas.map(normalizarOrden));
    const totalPages = Number(data?.pagination?.totalPages || 0);
    if (!filas.length || page >= totalPages) break;
  }

  if (todas.length) {
    await upsertOrders(integracion.id_configuracion, todas);
  }
}

exports.listOrdersFromCache = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const page = Math.max(1, toInt(req.body?.page) || 1);
  const pageSize = Math.min(100, Math.max(1, toInt(req.body?.page_size) || 10));

  const integracion = await getIntegracionActiva(id_configuracion);
  if (!integracion) {
    // Sin Aliclik vinculado NO es error: el front muestra el CTA para vincular.
    return res.json({
      isSuccess: true,
      data: {
        rows: [],
        total: 0,
        page: 1,
        page_size: pageSize,
        total_pages: 1,
        sync: null,
        productos_disponibles: [],
        sin_integracion: true,
      },
    });
  }

  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);
  const estado = strOrNull(req.body?.status); // estado canónico
  const texto = strOrNull(req.body?.textToSearch);
  const transportadora = strOrNull(req.body?.transportadora);
  const producto = strOrNull(req.body?.producto); // product_detail exacto
  const forceSync = req.body?.force_sync === true;

  const where = { id_configuracion };
  if (from && until) {
    where.order_created_at = {
      [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
    };
  }
  if (estado) where.estado_config = estado;
  if (texto) {
    const like = { [Op.like]: `%${texto}%` };
    where[Op.or] = [
      { name: like },
      { surname: like },
      { phone: like },
      { order_number: like },
      { product_detail: like },
      { city: like },
    ];
  }

  /* Producto y transportadora. Las opciones de cada desplegable se calculan
     con todos los filtros MENOS el propio (si no, al elegir una opción la
     lista se quedaría con esa sola), así que se arman tres where: el del
     listado y uno por desplegable. El spread copia también las claves Symbol
     (Op.or).
     El filtro de producto llegaba en el body y no se aplicaba: el desplegable
     mostraba las opciones pero elegir una no cambiaba la lista. Su valor es el
     product_detail completo, que es lo que se ofrece como opción. */
  const filtroTransportadora = transportadora
    ? {
        [Op.and]: [
          literal(`${SQL_TRANSPORTADORA} = ${db.escape(transportadora)}`),
        ],
      }
    : {};
  const filtroProducto = producto ? { product_detail: producto } : {};
  const whereSinProducto = { ...where, ...filtroTransportadora };
  const whereSinTransportadora = { ...where, ...filtroProducto };
  Object.assign(where, filtroProducto, filtroTransportadora);

  // ── Sync si el cache está viejo ──
  let syncInfo = { syncedAt: null, ageMinutes: null, syncing: false };
  if (from && until) {
    const ultimo = await AliclikOrdersCache.findOne({
      where: {
        id_configuracion,
        order_created_at: {
          [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
        },
      },
      order: [['synced_at', 'DESC']],
      attributes: ['synced_at'],
      raw: true,
    });
    const syncedAt = ultimo?.synced_at || null;
    const ageMin = syncedAt
      ? (Date.now() - new Date(syncedAt).getTime()) / 60000
      : null;
    syncInfo = {
      syncedAt,
      ageMinutes: ageMin != null ? Math.round(ageMin) : null,
      syncing: false,
    };

    const stale = ageMin == null || ageMin >= CACHE_STALE_MIN;
    if (forceSync && stale) {
      // El botón "Actualizar" sí espera el resultado.
      await syncDesdeAliclik({ integracion, from, until }).catch((e) =>
        console.error('[pedidos-aliclik] force sync:', e?.message),
      );
      syncInfo.ageMinutes = 0;
    } else if (stale) {
      syncInfo.syncing = true;
      setImmediate(() =>
        syncDesdeAliclik({ integracion, from, until }).catch((e) =>
          console.error('[pedidos-aliclik] bg sync:', e?.message),
        ),
      );
    }
  }

  const { rows, count } = await AliclikOrdersCache.findAndCountAll({
    where,
    order: [['order_created_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    raw: true,
  });

  const parsed = rows.map((r) => {
    let od = null;
    try {
      od = JSON.parse(r.order_data || 'null');
    } catch (_) {}

    return {
      // El id de Aliclik es un string ("ALC000123456789"), no un entero como
      // el de Dropi. El front lo usa solo como clave y para mostrarlo.
      id: r.order_number,
      order_number: r.order_number,
      plataforma: 'aliclik',
      name: r.name || '',
      surname: r.surname || '',
      phone: r.phone || '',
      email: od?.email || '',
      city: r.city || '',
      state: r.state || '',
      // `status` es lo que la tabla muestra como estado del pedido: se manda el
      // canónico para que la columna se lea igual que en Dropi.
      status: r.estado_config || '',
      classified_status: r.estado_config || '',
      // Los tres ejes crudos, por si el front quiere el detalle fino.
      call_status: r.call_status || '',
      delivery_status: r.status || '',
      dispatch_status: r.dispatch_status || '',
      total_order: Number(r.total || 0),
      // Aliclik no devuelve guía ni transportadora en sus pedidos. La
      // transportadora que sí conocemos es la que se eligió al crear el pedido
      // desde el chat (se guarda en order_data); la guía sigue vacía hasta
      // que la expongan. Se leen del cache y no se fuerzan a '' para que se
      // llenen solas el día que lleguen.
      shipping_guide: od?.shipping_guide || '',
      shipping_company: od?.shipping_company || '',
      order_created_at: r.order_created_at,
      shop_type: null,
      shop_name: integracion.store_name || 'Aliclik',
      direccion: od?.dir || '',
      // El listado de Aliclik no trae el nombre por item (solo skuId), sino un
      // resumen textual. Se expone como un único producto para que la columna
      // muestre algo útil en vez de quedar vacía.
      productos: r.product_detail
        ? [
            {
              product_id: null,
              name: r.product_detail,
              sku: '',
              quantity: null,
              image: null,
              imagen_catalogo: null,
            },
          ]
        : [],
      // Campos que la tabla de Dropi usa y acá no aplican: se mandan en falso
      // para que el front no tenga que preguntar por la plataforma.
      telefono_incompleto: false,
      telefono_sugerido: null,
      es_shopify: false,
      creado_por_bot: false,
    };
  });

  const enriched = await enrichOrdersWithChatAndAgent({
    id_configuracion,
    objects: parsed,
  });

  // ── Opciones del filtro por producto ──
  // Se calcula sobre las mismas órdenes que devuelve el listado (mismos
  // filtros, menos el de producto), igual que en la vista de Dropi.
  let productosDisponibles = [];
  try {
    const paraFiltro = await AliclikOrdersCache.findAll({
      where: whereSinProducto,
      attributes: ['product_detail'],
      raw: true,
    });
    const conteo = new Map();
    for (const r of paraFiltro) {
      const n = String(r.product_detail || '').trim();
      if (n) conteo.set(n, (conteo.get(n) || 0) + 1);
    }
    productosDisponibles = [...conteo.entries()]
      .map(([nombre, pedidos]) => ({ nombre, pedidos }))
      .sort((a, b) => b.pedidos - a.pedidos);
  } catch (e) {
    console.error('[pedidos-aliclik] productos filtro:', e?.message);
  }

  // ── Opciones del filtro por transportadora (con cuántos pedidos cada una) ──
  let transportadorasDisponibles = [];
  try {
    const porTransp = await AliclikOrdersCache.findAll({
      where: whereSinTransportadora,
      attributes: [
        [literal(SQL_TRANSPORTADORA), 'transportadora'],
        [fn('COUNT', literal('*')), 'pedidos'],
      ],
      group: [literal(SQL_TRANSPORTADORA)],
      raw: true,
    });
    transportadorasDisponibles = porTransp
      .map((r) => ({
        nombre: String(r.transportadora || '').trim(),
        pedidos: Number(r.pedidos || 0),
      }))
      .filter((t) => t.nombre && t.nombre.toLowerCase() !== 'null')
      .sort((a, b) => b.pedidos - a.pedidos);
  } catch (e) {
    console.error('[pedidos-aliclik] transportadoras filtro:', e?.message);
  }

  return res.json({
    isSuccess: true,
    data: {
      rows: enriched,
      total: count,
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(count / pageSize)),
      sync: syncInfo,
      productos_disponibles: productosDisponibles,
      transportadoras_disponibles: transportadorasDisponibles,
      estados_disponibles: ESTADOS_ALICLIK,
    },
  });
});

/**
 * Qué plataformas de pedidos tiene conectada esta configuración.
 *
 * Lo usa la vista de Pedidos para decidir si muestra el selector de plataforma
 * (solo tiene sentido con las dos conectadas) y a cuál pegarle por defecto.
 */
exports.plataformasConectadas = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(
    req.body?.id_configuracion || req.query?.id_configuracion,
  );
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const [dropi] = await db.query(
    `SELECT id FROM dropi_integrations
      WHERE id_configuracion = ? AND is_active = 1 AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const aliclik = await getIntegracionActiva(id_configuracion);

  const plataformas = [];
  if (dropi) plataformas.push({ key: 'dropi', label: 'Dropi' });
  if (aliclik)
    plataformas.push({
      key: 'aliclik',
      label: 'Aliclik',
      store_name: aliclik.store_name,
    });

  /* Shopify como fuente de pedidos SOLO cuando no hay Dropi ni Aliclik. Sin
     esto, una cuenta que solo tiene la tienda conectada veía "Conecta tu
     plataforma de pedidos" con sus pedidos entrando por el webhook (cfg 1565).
     Con Dropi conectado no se ofrece: esos mismos pedidos ya salen en la
     lista de Dropi con origen Shopify (y los que no llegaron, en "Faltan por
     subir"), así que una pestaña aparte los mostraría dos veces. */
  if (!plataformas.length) {
    try {
      const shopify = await getShopifyActivo(id_configuracion);
      if (shopify)
        plataformas.push({
          key: 'shopify',
          label: 'Shopify',
          store_name: shopify.shop_domain,
        });
    } catch (e) {
      console.error('[pedidos] plataformas (shopify):', e?.message);
    }
  }

  return res.json({
    isSuccess: true,
    data: {
      plataformas,
      // Con una sola conectada el front no muestra el selector.
      multiples: plataformas.length > 1,
      por_defecto: plataformas[0]?.key || null,
    },
  });
});
