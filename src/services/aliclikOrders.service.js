'use strict';

/**
 * services/aliclikOrders.service.js
 *
 * Creación y consulta de pedidos de Aliclik DESDE el chat (panel del asesor).
 * Es el equivalente de dropiOrders.service.js, y espeja su forma de respuesta
 * ({ isSuccess, status, objects }) para que el panel del front no tenga que
 * cambiar de estructura según la plataforma.
 *
 * ── Diferencias de flujo con Dropi, que son las que mandan en el diseño ─────
 *
 *   Dropi                              Aliclik
 *   ─────────────────────────────      ──────────────────────────────────────
 *   provincia → ciudad (IDs)           lat / lng (coordenadas)
 *   cotiza por cod_dane origen+destino cotiza por warehouseId + lat + lng
 *   producto por `id`                  producto por `ean` del SKU
 *   distributionCompany {id, name}     bloque `courier` completo de la cotización
 *
 * O sea: Aliclik NO tiene catálogo de ciudades. Resuelve el ubigeo del lado de
 * ellos a partir de las coordenadas, así que lat/lng son obligatorias y no hay
 * forma de crear el pedido sin ellas.
 *
 * ── Lo que NO hace (y por qué) ──────────────────────────────────────────────
 *  · No enlaza contacto-origen ↔ orden: dropi_orden_contacto_origen tiene
 *    `dropi_order_id BIGINT` y el identificador de Aliclik es un string
 *    ("ALC000123456789"). Queda pendiente para cuando se generalice esa tabla.
 *  · No genera guía: Aliclik no expone número de guía ni PDF en ningún
 *    endpoint. El `orderNumber` es la única referencia de seguimiento.
 */

const { Op } = require('sequelize');

const AppError = require('../utils/appError');
const { db } = require('../database/config');
const { decryptToken } = require('../utils/cryptoToken');
const { toE164Multipais } = require('../utils/phoneFactor');

const AliclikIntegrations = require('../models/aliclik_integrations.model');
const AliclikOrdersCache = require('../models/aliclik_orders_cache.model');
const aliclikService = require('./aliclik.service');
const {
  COUNTRY_CODE,
  normalizarOrden,
  upsertOrders,
} = require('./aliclik_notifier.service');
const {
  enrichOrdersWithChatAndAgent,
} = require('../controllers/dropi_integrations.controller');

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim().length ? s.trim() : null;
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

/** Últimos 9/10 dígitos: match agnóstico al código de país. */
function phoneKeys(v) {
  const d = digitsOnly(v);
  if (!d) return [];
  const keys = [];
  if (d.length >= 9) keys.push(d.slice(-9));
  if (d.length >= 10) keys.push(d.slice(-10));
  return Array.from(new Set(keys));
}

/**
 * Coordenada válida y dentro de rango. Aliclik las espera como STRING decimal
 * ("-12.04318"), y un 0 accidental mandaría el pedido al golfo de Guinea, así
 * que el cero se trata como ausente.
 */
function toCoord(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  if (Math.abs(n) > 180) return null;
  return String(n);
}

async function getActiveIntegration(id_configuracion) {
  return AliclikIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
}

/**
 * Devuelve el token descifrado de la integración activa. Centralizado porque
 * los cinco puntos de entrada de este archivo necesitan exactamente lo mismo.
 */
async function getIntegrationWithToken(id_configuracion) {
  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    throw new AppError(
      'No existe una integración Aliclik activa para esta configuración',
      404,
    );
  }
  const token = decryptToken(integration.token_enc);
  if (!token || !String(token).trim()) {
    throw new AppError('Token de Aliclik inválido o no disponible', 400);
  }
  return { integration, token };
}

/* ═══════════════════════════════════════════════════════════
   Catálogo y cotización (pasos previos a crear)
   ═══════════════════════════════════════════════════════════ */

/**
 * Catálogo público con stock virtual por almacén.
 *
 * Se aplana `result[].skus[]` a una fila por SKU porque el panel elige un SKU
 * concreto (es el que tiene el `ean`, el precio y el almacén), no un producto:
 * dos SKUs del mismo producto pueden estar en almacenes distintos, y Aliclik
 * exige que todos los productos del pedido salgan del MISMO almacén.
 */
async function listProductsForPanel({ id_configuracion, params = {} }) {
  const { token } = await getIntegrationWithToken(id_configuracion);

  const page = Math.max(1, toInt(params.page) || 1);
  const limit = Math.min(100, Math.max(1, toInt(params.limit) || 20));
  const search = strOrNull(params.search);

  const data = await aliclikService.listProducts({
    token,
    params: {
      page,
      limit,
      ...(search ? { search } : {}),
      ...(toInt(params.categoryId) ? { categoryId: toInt(params.categoryId) } : {}),
    },
  });

  const productos = Array.isArray(data?.result) ? data.result : [];

  const skus = [];
  for (const p of productos) {
    for (const s of Array.isArray(p?.skus) ? p.skus : []) {
      if (!s?.ean) continue; // sin EAN no se puede pedir: Aliclik lo exige

      // `skus[].name` es la VARIANTE ("MARCA NIB / KILO 400"), no el producto
      // ("multi collageno"): dos SKUs del mismo producto traen el mismo
      // `p.name` y variantes distintas. Mostrar uno solo pierde información en
      // los dos sentidos, así que se arma acá el nombre completo y el panel
      // usa siempre este.
      const producto = p.name || '';
      const variante = s.name || '';
      const display_name =
        variante && variante !== producto
          ? `${producto} — ${variante}`
          : producto || variante;

      skus.push({
        product_id: p.id ?? null,
        product_name: producto,
        short_description: p.shortDescription || '',
        image: p.urlImage || null,
        category: p.category || null,

        ean: String(s.ean),
        // Aliclik devuelve `sku` vacío en su catálogo público; el identificador
        // que sirve para pedir es el EAN.
        sku: s.sku || '',
        sku_name: variante,
        display_name,
        regular_price: Number(s.regularPrice || 0),
        drop_price: Number(s.dropPrice || 0),
        stock: Number(s.stockVirtual || 0),
        warehouse_id: toInt(s.warehouseId),
        warehouse_name: s.warehouseName || '',
      });
    }
  }

  return {
    isSuccess: true,
    status: 200,
    objects: skus,
    count: Number(data?.count || skus.length),
    page: Number(data?.page || page),
  };
}

/**
 * Couriers y costos disponibles para un destino.
 *
 * El objeto `couriers[i]` se devuelve tal cual porque al crear el pedido se
 * reusa como bloque `courier` sin recomponerlo — cualquier campo que
 * inventemos acá terminaría en un 400 de Aliclik.
 */
async function getShippingCostForPanel({ id_configuracion, warehouseId, lat, lng }) {
  const { token } = await getIntegrationWithToken(id_configuracion);

  const wh = toInt(warehouseId);
  const latS = toCoord(lat);
  const lngS = toCoord(lng);

  if (!wh) throw new AppError('warehouseId es requerido', 400);
  if (!latS || !lngS) {
    throw new AppError(
      'Faltan las coordenadas del destino. Pide la ubicación al cliente por WhatsApp o márcala en el mapa.',
      400,
    );
  }

  const data = await aliclikService.getShippingCost({
    token,
    warehouseId: wh,
    lat: latS,
    lng: lngS,
  });

  const couriers = Array.isArray(data?.couriers) ? data.couriers : [];

  return {
    isSuccess: true,
    status: 200,
    ubigeo: data?.ubigeo || null,
    objects: couriers,
  };
}

/* ═══════════════════════════════════════════════════════════
   Construcción del payload de creación
   ═══════════════════════════════════════════════════════════ */

/**
 * Arma el body de POST /integration/order a partir de lo que manda el panel.
 *
 * Valida acá y no en el socket porque el mismo payload lo va a necesitar el
 * bot cuando cierre ventas de Perú: las reglas de negocio tienen que vivir en
 * un solo lado.
 */
function buildAliclikCreateOrderPayload(body = {}) {
  const name = strOrNull(body.name);
  const lastName = strOrNull(body.surname) || '';
  const phone = strOrNull(body.phone);

  if (!name) throw new AppError('El nombre del cliente es requerido', 400);
  if (!phone) throw new AppError('El teléfono del cliente es requerido', 400);

  // Guard anti-teléfono-mocho, igual que en Dropi: un número incompleto genera
  // un pedido que el courier no puede entregar y ensucia la cuenta.
  //
  // NO se exige que sea peruano. Lo que decide si el pedido es entregable son
  // las coordenadas —Aliclik resuelve el ubigeo con ellas y no cotiza fuera de
  // Perú—, no el teléfono. El número solo sirve para que su call center llame
  // y para nuestras notificaciones de WhatsApp, y las dos cosas funcionan con
  // cualquier país: es normal que alguien haga el seguimiento desde un número
  // extranjero.
  const phoneE164 = toE164Multipais(phone, COUNTRY_CODE);
  if (!phoneE164) {
    throw new AppError(
      'El teléfono del cliente no es válido o está incompleto. Si no es peruano, ' +
        'escríbelo con el código de país (ej. 987654321 para Perú, ' +
        '593980709288 para Ecuador).',
      400,
    );
  }

  const address1 = strOrNull(body.dir);
  if (!address1) throw new AppError('La dirección de entrega es requerida', 400);

  const lat = toCoord(body.lat);
  const lng = toCoord(body.lng);
  if (!lat || !lng) {
    throw new AppError(
      'Faltan las coordenadas del destino. Pide la ubicación al cliente por WhatsApp o márcala en el mapa.',
      400,
    );
  }

  // ── Productos: van por EAN, no por id ──
  const productosRaw = Array.isArray(body.products) ? body.products : [];
  if (!productosRaw.length) {
    throw new AppError('El pedido no tiene productos', 400);
  }

  const products = productosRaw.map((p) => {
    const ean = strOrNull(p.ean);
    const quantity = Math.max(1, toInt(p.quantity) || 1);
    const price = Number(p.price);

    if (!ean) {
      throw new AppError(
        'Producto inválido: falta el EAN del SKU seleccionado',
        400,
      );
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new AppError(
        `Producto inválido: el precio de ${ean} debe ser un número >= 0`,
        400,
      );
    }
    return { ean, quantity, price };
  });

  // Aliclik exige que todos los productos salgan del mismo almacén. Se valida
  // acá con el warehouse_id que el panel adjunta a cada línea, para dar un
  // mensaje entendible en vez del 400 genérico de ellos.
  const almacenes = new Set(
    productosRaw.map((p) => toInt(p.warehouse_id)).filter(Boolean),
  );
  if (almacenes.size > 1) {
    throw new AppError(
      'Todos los productos del pedido deben salir del mismo almacén de Aliclik. Quita los que sean de otro almacén.',
      400,
    );
  }

  // ── Courier: se reusa tal cual el objeto que devolvió la cotización ──
  const c = body.courier || {};
  const transportId = toInt(c.transportId);
  if (!transportId) {
    throw new AppError(
      'Selecciona una transportadora antes de crear el pedido',
      400,
    );
  }

  const courier = {
    addDays: toInt(c.addDays) ?? 0,
    deliveryCost: Number(c.deliveryCost || 0),
    returnCost: Number(c.returnCost || 0),
    transportId,
    schedule: c.schedule ?? null,
    scheduleExpressStart: c.scheduleExpressStart ?? null,
    scheduleExpressEnd: c.scheduleExpressEnd ?? null,
    flagDeliveryExpress: c.flagDeliveryExpress === true,
  };

  // `delivery` es lo que el cliente paga por el envío. El panel puede cobrar
  // algo distinto al costo del courier (envío gratis, flete subsidiado), así
  // que se toma del body y solo se cae al costo del courier si no vino.
  const delivery =
    body.delivery === undefined || body.delivery === null || body.delivery === ''
      ? courier.deliveryCost
      : Number(body.delivery);

  if (!Number.isFinite(delivery) || delivery < 0) {
    throw new AppError('El valor del envío (delivery) es inválido', 400);
  }

  return {
    note: strOrNull(body.notes) || '',
    channel: strOrNull(body.channel) || 'chatcenter',
    delivery,
    customer: {
      name,
      lastName,
      // Aliclik devuelve y espera el teléfono con código de país ("51918993266")
      phone: phoneE164,
      email: strOrNull(body.client_email) || '',
      address: address1,
    },
    shipping: {
      address1,
      address2: strOrNull(body.dir2) || '',
      lat,
      lng,
      reference: strOrNull(body.reference) || '',
    },
    products,
    courier,
  };
}

/* ═══════════════════════════════════════════════════════════
   Bloqueo de la confirmación en frío
   ═══════════════════════════════════════════════════════════ */

/**
 * Deja una fila de BLOQUEO en aliclik_plantillas_enviadas.
 *
 * El pedido recién creado entra a Aliclik como TO_PREPARE + sin confirmar, que
 * mapea a 'PENDIENTE CONFIRMACION'. Sin este candado, el webhook o el cron le
 * mandarían al cliente una plantilla de "recibimos tu pedido" segundos después
 * de que el asesor lo cerró a mano en la conversación.
 *
 * Lo que bloquea es la EXISTENCIA de la fila: yaFueEnviado() y el UNIQUE de
 * reclamarEnvio() solo miran (order_number, id_configuracion, estado). El
 * template_name '[SKIP] …' es únicamente para que se entienda al mirar la tabla
 * — a diferencia de dropi_plantillas_enviadas, acá no hay columna `source`.
 *
 * Best-effort: si falla, el pedido igual se creó.
 */
async function bloquearConfirmacionEnFrio({
  id_configuracion,
  order_number,
  phone,
}) {
  if (!id_configuracion || !order_number) return false;
  try {
    await db.query(
      `INSERT IGNORE INTO aliclik_plantillas_enviadas
         (order_number, id_configuracion, estado, phone, template_name)
       VALUES (?, ?, 'PENDIENTE CONFIRMACION', ?, '[SKIP] creada en sistema')`,
      {
        replacements: [
          order_number,
          id_configuracion,
          toE164Multipais(phone, COUNTRY_CODE) || strOrNull(phone),
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    return true;
  } catch (e) {
    console.log('[Aliclik] error registrando bloqueo de plantilla:', e?.message);
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════
   Imágenes de producto
   ═══════════════════════════════════════════════════════════ */

/**
 * Caché en memoria del catálogo, por configuración: { nombre → urlImage }.
 *
 * Hace falta porque los pedidos NO traen imagen: `products[]` da
 * {skuId, product, quantity, price, subtotal} y nada más. Y el `skuId` no
 * sirve para cruzar — el catálogo público no expone ningún id de SKU
 * (comprobado: sus SKUs son {ean, name, regularPrice, dropPrice,
 * stockVirtual, warehouseId, warehouseName}). Lo único común entre las dos
 * respuestas es el NOMBRE del producto.
 *
 * Se cachea porque el listado de pedidos se pide cada vez que el asesor abre
 * un chat, y sin esto cada apertura dispararía una llamada al catálogo.
 */
const catalogoImgCache = new Map(); // id_configuracion → { at, mapa }
const CATALOGO_TTL_MS = 10 * 60 * 1000;

async function getMapaImagenes(id_configuracion, token) {
  const cacheado = catalogoImgCache.get(id_configuracion);
  if (cacheado && Date.now() - cacheado.at < CATALOGO_TTL_MS) {
    return cacheado.mapa;
  }

  const mapa = new Map();
  try {
    // limit=100 es el máximo que acepta Aliclik. Con catálogos más grandes
    // quedarían productos sin imagen, que degrada bien (se ve el placeholder).
    const data = await aliclikService.listProducts({
      token,
      params: { page: 1, limit: 100 },
    });
    for (const p of Array.isArray(data?.result) ? data.result : []) {
      const nombre = String(p?.name || '').trim().toLowerCase();
      if (nombre && p?.urlImage && !mapa.has(nombre)) {
        mapa.set(nombre, p.urlImage);
      }
    }
  } catch (err) {
    // Si el catálogo falla, el listado igual se muestra: sin imagen, no roto.
    console.log(
      `[Aliclik] no se pudo cargar el catálogo para imágenes (cfg ${id_configuracion}): ${err?.message || err}`,
    );
  }

  catalogoImgCache.set(id_configuracion, { at: Date.now(), mapa });
  return mapa;
}

/**
 * Deja un nombre en forma comparable: sin acentos, en minúsculas, sin la
 * cantidad que Aliclik antepone en el resumen ("1 Mouse…"), sin el código de
 * tienda entre paréntesis del final ("… (TEC97X)") y con los espacios
 * colapsados. Se aplica a los dos lados del cruce para que un acento o un
 * espacio doble no rompan la coincidencia.
 */
function normalizarNombreProducto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\s*\d+\s+/, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convierte el resumen de texto del pedido en ítems.
 *
 * Los pedidos cacheados antes de que se guardara `productos` solo tienen
 * `product_detail`, el string que arma Aliclik:
 *   "1 Mouse Vertical Recargable Ergonómico (TEC97X)"
 * Guardarlo tal cual como nombre dejaba la cantidad pegada al texto y, sobre
 * todo, impedía cruzarlo con el catálogo (ningún producto se llama
 * "1 Mouse…"), que es por lo que no aparecía la foto.
 *
 * Se corta antes de cada "N " que abre un ítem nuevo, para no partir nombres
 * que lleven comas dentro.
 */
function parseProductDetail(texto) {
  const crudo = String(texto || '').trim();
  if (!crudo) return [];

  return crudo
    .split(/\s*[\n,]\s*(?=\d+\s+\S)/)
    .map((parte) => {
      const m = parte.trim().match(/^(\d+)\s+(.*)$/);
      const cantidad = m ? Number(m[1]) : null;
      // El código entre paréntesis del final es de la tienda, no del
      // producto: no le dice nada al asesor y estorba en la tarjeta.
      const nombre = (m ? m[2] : parte)
        .replace(/\s*\([^()]*\)\s*$/, '')
        .trim();
      return nombre ? { name: nombre, quantity: cantidad, image: null } : null;
    })
    .filter(Boolean);
}

/** Rellena `image` en cada producto de cada pedido, cruzando por nombre. */
async function adjuntarImagenesDeCatalogo({ id_configuracion, token, ordenes }) {
  const necesita = ordenes.some((o) =>
    (o.productos || []).some((p) => p?.name && !p.image),
  );
  if (!necesita) return;

  const mapa = await getMapaImagenes(id_configuracion, token);
  if (!mapa.size) return;

  // El mapa se indexa por el nombre ya normalizado, y se guardan los nombres
  // del más largo al más corto para el segundo intento: se prefiere la
  // coincidencia más específica y así un nombre corto y genérico no le gana a
  // uno que describe mejor el producto.
  const mapaNorm = new Map();
  for (const [nombre, url] of mapa) {
    const clave = normalizarNombreProducto(nombre);
    if (clave && !mapaNorm.has(clave)) mapaNorm.set(clave, url);
  }
  const nombresCatalogo = [...mapaNorm.keys()].sort((a, b) => b.length - a.length);

  for (const orden of ordenes) {
    for (const prod of orden.productos || []) {
      if (prod.image || !prod.name) continue;
      const nombre = normalizarNombreProducto(prod.name);

      // 1) Coincidencia exacta, que es el caso normal.
      let url = mapaNorm.get(nombre);

      // 2) El pedido suele traer el nombre CON la variante
      //    ("Gorra azul- rojo") mientras que el catálogo guarda solo el
      //    producto ("Gorra"). Se busca el nombre de catálogo más largo con el
      //    que empiece.
      if (!url) {
        const base = nombresCatalogo.find((n) => nombre.startsWith(n));
        if (base) url = mapaNorm.get(base);
      }

      prod.image = url || null;
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   Puntos de entrada
   ═══════════════════════════════════════════════════════════ */

/**
 * Pedidos de este cliente, leídos del cache local (aliclik_orders_cache).
 *
 * Se lee del cache y no de la API por lo mismo que en Dropi: el filtro
 * `orderNumber` de Aliclik es por número de pedido, no por teléfono, así que no
 * hay forma de preguntarle "los pedidos de este cliente" sin traer el rango
 * completo de fechas y filtrar acá.
 */
async function listOrdersForClient({ id_configuracion, phone, body = {} }) {
  // Solo valida que la integración exista: la consulta no toca la API.
  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    throw new AppError(
      'No existe una integración Aliclik activa para esta configuración',
      404,
    );
  }

  const keys = phoneKeys(phone);
  if (!keys.length) {
    throw new AppError('Teléfono inválido para buscar pedidos', 400);
  }

  const resultNumber = Math.min(100, Math.max(1, toInt(body?.result_number) || 20));
  const estado = strOrNull(body?.status);

  const where = {
    id_configuracion: Number(id_configuracion),
    [Op.or]: keys.map((k) => ({ phone: { [Op.like]: `%${k}%` } })),
  };
  if (estado) where.estado_config = estado;

  const rows = await AliclikOrdersCache.findAll({
    where,
    order: [['order_created_at', 'DESC']],
    limit: resultNumber,
    raw: true,
  });

  // Se reconstruye la misma forma de objeto que expone
  // aliclik_orders.controller.listOrdersFromCache, para que el panel y la
  // vista de Pedidos lean idéntico.
  const objects = rows.map((r) => {
    let od = null;
    try {
      od = JSON.parse(r.order_data || 'null');
    } catch (_) {}

    return {
      id: r.order_number,
      order_number: r.order_number,
      plataforma: 'aliclik',
      name: r.name || '',
      surname: r.surname || '',
      phone: r.phone || '',
      email: od?.email || '',
      dir: od?.dir || '',
      city: r.city || '',
      state: r.state || '',
      status: r.estado_config || '',
      call_status: r.call_status || '',
      delivery_status: r.status || '',
      dispatch_status: r.dispatch_status || '',
      total_order: Number(r.total || 0),
      // Aliclik no expone guía ni transportadora en ningún endpoint: el
      // orderNumber es toda la referencia de seguimiento que hay.
      shipping_guide: '',
      shipping_company: '',
      order_created_at: r.order_created_at,
      shop_name: integration.store_name || 'Aliclik',

      // Detalle real por ítem cuando el pedido se cacheó con la versión nueva
      // de normalizarOrden. Los cacheados antes solo tienen el resumen de
      // texto (product_detail), así que se cae a eso para no dejar la columna
      // vacía hasta que el cron los refresque.
      productos:
        Array.isArray(od?.productos) && od.productos.length
          ? od.productos.map((p) => ({
              name: p.name || '',
              quantity: p.quantity ?? null,
              price: Number(p.price || 0),
              subtotal: Number(p.subtotal || 0),
              sku_id: p.sku_id ?? null,
              image: null, // se rellena abajo con el catálogo
            }))
          : parseProductDetail(r.product_detail),
    };
  });

  // Imágenes: una sola pasada para todo el lote, con caché de 10 min.
  // Best-effort — si el catálogo falla, la lista se muestra igual sin fotos.
  try {
    const token = decryptToken(integration.token_enc);
    if (token?.trim()) {
      await adjuntarImagenesDeCatalogo({
        id_configuracion,
        token,
        ordenes: objects,
      });
    }
  } catch (err) {
    console.log(`[Aliclik] imágenes de catálogo: ${err?.message || err}`);
  }

  const enriched = await enrichOrdersWithChatAndAgent({
    id_configuracion,
    objects,
  });

  return { isSuccess: true, status: 200, objects: enriched };
}

/**
 * Crea el pedido contraentrega en Aliclik y lo deja cacheado.
 */
async function createOrderForClient({ id_configuracion, body = {} }) {
  const { integration, token } = await getIntegrationWithToken(id_configuracion);

  const payload = buildAliclikCreateOrderPayload(body);

  const data = await aliclikService.createOrder({ token, payload });

  const orderNumber = strOrNull(data?.orderNumber || data?.data?.orderNumber);
  if (!orderNumber) {
    // Aliclik contestó 2xx pero sin número: no hay forma de seguirle la pista
    // al pedido, así que se trata como fallo en vez de dar un falso OK.
    console.log(
      '[Aliclik] ⚠ respuesta de create sin orderNumber:',
      JSON.stringify(data)?.slice(0, 600),
    );
    throw new AppError(
      'Aliclik no devolvió el número de pedido. Revísalo en su panel antes de volver a intentarlo para no duplicarlo.',
      502,
    );
  }

  console.log(
    `[Aliclik] pedido creado → ${orderNumber} (cfg ${id_configuracion}, tienda "${integration.store_name}")`,
  );

  // El candado va ANTES de cachear: si el webhook de Aliclik llega mientras
  // seguimos acá (pasa: notifican en segundos), tiene que encontrarlo puesto.
  await bloquearConfirmacionEnFrio({
    id_configuracion,
    order_number: orderNumber,
    phone: body.phone,
  });

  // Cachear de una. El webhook llega sin teléfono y sin productos, así que si
  // el pedido no está en cache el procesador tiene que salir a la API por cada
  // evento. Best-effort: si falla, el cron lo recoge en la corrida siguiente.
  let orden = null;
  try {
    const remoto = await aliclikService.getOrderByNumber({ token, orderNumber });
    if (remoto) {
      orden = normalizarOrden(remoto);
      await upsertOrders(id_configuracion, [orden]);
    }
  } catch (err) {
    console.log(
      `[Aliclik] no se pudo cachear el pedido ${orderNumber} recién creado: ${err?.message || err}`,
    );
  }

  return {
    isSuccess: true,
    status: 201,
    orderNumber,
    data,
    orden,
  };
}

/**
 * Cancela un pedido contraentrega.
 *
 * Aliclik responde 201 en dos situaciones distintas: si el pedido todavía no
 * está confirmado NO lo cancela, solo le agrega una nota. aliclik.service ya
 * distingue los dos casos en `cancelado`, y acá se propaga para que el panel
 * no muestre "cancelado" cuando no lo está.
 */
async function cancelOrderForClient({ id_configuracion, orderNumber }) {
  const { token } = await getIntegrationWithToken(id_configuracion);

  const num = strOrNull(orderNumber);
  if (!num) throw new AppError('orderNumber es requerido', 400);

  const data = await aliclikService.cancelOrder({ token, orderNumber: num });

  // Refrescar el cache con el estado real, no con el que asumimos: el front
  // lee de ahí y si no, seguiría mostrando el estado anterior.
  try {
    const remoto = await aliclikService.getOrderByNumber({
      token,
      orderNumber: num,
    });
    if (remoto) await upsertOrders(id_configuracion, [normalizarOrden(remoto)]);
  } catch (_) {}

  return {
    isSuccess: true,
    status: 200,
    cancelado: data?.cancelado === true,
    message: data?.message || null,
    orderNumber: num,
  };
}

module.exports = {
  getActiveIntegration,
  listProductsForPanel,
  getShippingCostForPanel,
  listOrdersForClient,
  createOrderForClient,
  cancelOrderForClient,
  buildAliclikCreateOrderPayload,
};
