const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const {
  enrichOrdersWithChatAndAgent,
} = require('./dropi_integrations.controller');

/* ═══════════════════════════════════════════════════════════
   Vista Pedidos — cuentas que SOLO tienen Shopify

   La vista de Pedidos nació sobre el cache de Dropi y después sumó Aliclik.
   Una cuenta con Shopify conectado pero sin ninguna de las dos (cfg 1565,
   11-11-2026) veía "Conecta tu plataforma de pedidos" aunque sus pedidos sí
   estaban entrando por el webhook orders/create y quedando guardados en
   shopify_ordenes_webhook. Este listado los muestra desde ahí.

   Mismo sobre de respuesta que dropi_integrations.listOrdersFromCache
   ({ rows, total, page, page_size, total_pages, sync, productos_disponibles })
   para que la tabla del front no cambie de forma según la plataforma.

   Lo que NO hay, y por qué:
     · guía, transportadora y estado del envío — Shopify solo nos avisa cuando
       el pedido se crea; el despacho lo hace quien lo envía (Dropi, Aliclik o
       el propio comercio). El único estado que conocemos es el de pago, y es
       el que tenía el pedido AL ENTRAR (no escuchamos orders/updated);
     · sync — no hay nada que traer: la tabla se llena sola con el webhook.
   ═══════════════════════════════════════════════════════════ */

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const strOrNull = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// Tope de filas que se leen por consulta. El filtro de producto y el conteo
// del desplegable se resuelven en memoria (los productos viven dentro del JSON
// datos_orden), así que se trae el rango completo y se pagina acá.
const MAX_FILAS = 5000;

// financial_status de Shopify → texto para la tabla y el filtro.
const ESTADOS_PAGO = {
  pending: 'Pago pendiente',
  authorized: 'Pago autorizado',
  partially_paid: 'Pago parcial',
  paid: 'Pagado',
  partially_refunded: 'Reembolso parcial',
  refunded: 'Reembolsado',
  voided: 'Anulado',
};
const etiquetaPago = (fs) => {
  const k = String(fs || '').trim().toLowerCase();
  if (!k) return 'Sin estado';
  return ESTADOS_PAGO[k] || k.charAt(0).toUpperCase() + k.slice(1);
};

// Shopify manda algunos títulos con entidades HTML ("Reparador &amp;
// Antiarrugas"). React escapa el texto, así que sin esto se verían literales.
const decodificar = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

/** Tienda Shopify activa de la configuración (la del webhook), o null. */
async function getShopifyActivo(id_configuracion) {
  const [row] = await db.query(
    `SELECT id, shop_domain FROM shopify_configuraciones
      WHERE id_configuracion = ? AND activo = 1
      ORDER BY id DESC LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

function parsearDatos(crudo) {
  if (!crudo) return {};
  try {
    return (typeof crudo === 'string' ? JSON.parse(crudo) : crudo) || {};
  } catch (_) {
    return {};
  }
}

exports.listOrders = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const page = Math.max(1, toInt(req.body?.page) || 1);
  const pageSize = Math.min(100, Math.max(1, toInt(req.body?.page_size) || 10));

  const tienda = await getShopifyActivo(id_configuracion);
  if (!tienda) {
    // Sin Shopify conectado NO es error: el front muestra la invitación.
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
  const estado = strOrNull(req.body?.status); // financial_status crudo
  const producto = strOrNull(req.body?.producto); // nombre exacto
  const texto = strOrNull(req.body?.textToSearch);

  // La fecha del pedido es la de Shopify; created_at (cuándo llegó el webhook)
  // solo cubre el caso raro de que Shopify no la mande.
  const condiciones = ['id_configuracion = :cfg'];
  const repl = { cfg: id_configuracion, tope: MAX_FILAS };
  if (from && until) {
    condiciones.push(
      'COALESCE(shopify_created_at, created_at) BETWEEN :desde AND :hasta',
    );
    repl.desde = `${from} 00:00:00`;
    repl.hasta = `${until} 23:59:59`;
  }
  if (estado) {
    condiciones.push('financial_status = :estado');
    repl.estado = estado;
  }
  if (texto) {
    // Nombre, ciudad y productos viven dentro de datos_orden (JSON como
    // texto); número de pedido y teléfono tienen columna propia.
    condiciones.push(
      '(order_number LIKE :txt OR phone_normalizado LIKE :txt OR datos_orden LIKE :txt)',
    );
    repl.txt = `%${texto}%`;
  }

  const filas = await db.query(
    `SELECT id, shopify_order_id, order_number, phone_normalizado, total_price,
            currency, financial_status, datos_orden,
            COALESCE(shopify_created_at, created_at) AS fecha
       FROM shopify_ordenes_webhook
      WHERE ${condiciones.join(' AND ')}
      ORDER BY fecha DESC, id DESC
      LIMIT :tope`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  const todas = filas.map((r) => {
    const d = parsearDatos(r.datos_orden);
    const lista = Array.isArray(d.productos) ? d.productos : [];
    const productos = lista
      .map((p) => ({
        product_id: null,
        name: decodificar(p?.nombre),
        variedad: decodificar(p?.variedad),
        sku: '',
        quantity: Number(p?.cantidad || 1),
        image: null,
        imagen_catalogo: null, // se llena abajo con el catálogo propio
      }))
      .filter((p) => p.name);

    return {
      // El número visible de Shopify (#1077). El id largo queda aparte.
      id: r.order_number || String(r.shopify_order_id),
      order_number: r.order_number || '',
      shopify_order_id: String(r.shopify_order_id),
      plataforma: 'shopify',
      name: decodificar(d.nombre),
      surname: decodificar(d.apellido),
      phone: r.phone_normalizado || d.telefono || '',
      email: '',
      city: decodificar(d.ciudad),
      state: decodificar(d.provincia),
      direccion: decodificar(d.direccion),
      // `status` es lo que la tabla pinta en la columna de estado. Acá es el
      // estado de PAGO que traía el pedido al entrar (ver nota de arriba).
      status: etiquetaPago(r.financial_status),
      classified_status: r.financial_status || '',
      financial_status: r.financial_status || '',
      total_order: Number(r.total_price || 0),
      currency: r.currency || '',
      shipping_guide: '',
      shipping_company: '',
      order_created_at: r.fecha,
      shop_type: 'SHOPIFY',
      shop_name: tienda.shop_domain || 'Shopify',
      productos,
      // Campos que la tabla de Dropi usa y acá no aplican.
      estado_pedido: null,
      telefono_incompleto: false,
      telefono_sugerido: null,
      es_shopify: true,
      creado_por_bot: false,
      otras_ordenes_activas: [],
    };
  });

  /* Opciones del filtro por producto: sobre las órdenes que quedan con los
     demás filtros (sin el de producto, o al elegir uno la lista se quedaría
     con esa sola opción). 1 orden cuenta 1 vez por producto. */
  const conteo = new Map();
  for (const o of todas) {
    for (const n of new Set(o.productos.map((p) => p.name))) {
      conteo.set(n, (conteo.get(n) || 0) + 1);
    }
  }
  const productosDisponibles = [...conteo.entries()]
    .map(([nombre, pedidos]) => ({ nombre, pedidos }))
    .sort((a, b) => b.pedidos - a.pedidos);

  const filtradas = producto
    ? todas.filter((o) => o.productos.some((p) => p.name === producto))
    : todas;

  const total = filtradas.length;
  const pagina = filtradas.slice((page - 1) * pageSize, page * pageSize);

  // ── Imagen del catálogo propio, cruzando por nombre ──
  // El webhook no guarda la imagen ni un id de producto: lo único común con
  // productos_chat_center es el nombre. Best-effort: sin match, placeholder.
  const nombres = [
    ...new Set(pagina.flatMap((o) => o.productos.map((p) => p.name))),
  ];
  if (nombres.length) {
    try {
      const cat = await db.query(
        `SELECT nombre, imagen_url FROM productos_chat_center
          WHERE id_configuracion = :cfg AND eliminado = 0
            AND imagen_url IS NOT NULL AND imagen_url <> ''
            AND nombre IN (:nombres)`,
        {
          replacements: { cfg: id_configuracion, nombres },
          type: db.QueryTypes.SELECT,
        },
      );
      const imgPorNombre = new Map(
        cat.map((c) => [String(c.nombre).trim().toLowerCase(), c.imagen_url]),
      );
      for (const o of pagina) {
        for (const p of o.productos) {
          p.imagen_catalogo = imgPorNombre.get(p.name.toLowerCase()) || null;
        }
      }
    } catch (e) {
      console.error('[pedidos-shopify] catálogo imgs:', e?.message);
    }
  }

  // ── Chat + agente (mismo enricher que Dropi y Aliclik) ──
  const enriched = await enrichOrdersWithChatAndAgent({
    id_configuracion,
    objects: pagina,
  });

  return res.json({
    isSuccess: true,
    data: {
      rows: enriched,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
      // Sin sync: la tabla la llena el webhook, no hay nada que actualizar.
      sync: null,
      productos_disponibles: productosDisponibles,
      estados_disponibles: Object.entries(ESTADOS_PAGO).map(
        ([value, label]) => ({ value, label }),
      ),
      transportadoras_disponibles: [],
    },
  });
});

exports.getShopifyActivo = getShopifyActivo;
