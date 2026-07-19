const { Op, literal, fn, col, where } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const ShopifyCarritosAbandonados = require('../models/shopify_carritos_abandonados.model');

/* Normaliza un nombre para emparejar título del carrito ↔ catálogo */
function normNombre(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function primerTitulo(carrito) {
  try {
    const items =
      typeof carrito.line_items === 'string'
        ? JSON.parse(carrito.line_items)
        : carrito.line_items;
    return Array.isArray(items) ? items[0]?.title || '' : '';
  } catch (_) {
    return '';
  }
}

/* Enriquece cada carrito con la imagen del producto emparejando el primer
   producto del carrito contra el catálogo local (productos_chat_center). Es
   best-effort: si no hay match, el front muestra un placeholder. */
async function adjuntarImagenProducto(id_configuracion, carritos) {
  const titulos = carritos.map(primerTitulo).filter(Boolean);
  if (!titulos.length) return carritos;

  const productos = await db.query(
    `SELECT nombre, imagen_url FROM productos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0
        AND imagen_url IS NOT NULL AND imagen_url <> ''`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!productos.length) return carritos;

  const mapa = new Map(); // nombre normalizado → imagen
  for (const p of productos) {
    const k = normNombre(p.nombre);
    if (k && !mapa.has(k)) mapa.set(k, p.imagen_url);
  }

  return carritos.map((c) => {
    const plain = c.toJSON ? c.toJSON() : c;
    const t = normNombre(primerTitulo(c));
    let img = t ? mapa.get(t) : null;
    if (!img && t) {
      // match laxo: el catálogo contiene el título o viceversa
      for (const [k, v] of mapa) {
        if (k.includes(t) || t.includes(k)) {
          img = v;
          break;
        }
      }
    }
    return { ...plain, producto_imagen: img || null };
  });
}

/* ============================================================
   GET / — listar carritos con filtros y paginación
   Query params:
     - id_configuracion (required)
     - recuperado (opcional: 0 | 1 | "all")
     - source (opcional: shopify_checkout | releasit_form | custom_landing)
     - search (opcional: busca en phone, email, nombre)
     - page (default 1)
     - limit (default 20, max 100)
   ============================================================ */
exports.listar = catchAsync(async (req, res) => {
  const {
    id_configuracion,
    recuperado,
    source,
    search,
    page = 1,
    limit = 20,
  } = req.query;

  if (!id_configuracion) {
    return res.status(400).json({
      isSuccess: false,
      message: 'id_configuracion es requerido',
    });
  }

  const idConf = parseInt(id_configuracion, 10);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const offset = (pageNum - 1) * limitNum;

  /* Construir filtros */
  const whereClause = { id_configuracion: idConf };

  if (recuperado !== undefined && recuperado !== 'all' && recuperado !== '') {
    whereClause.recuperado = parseInt(recuperado, 10);
  }

  if (source && ['shopify_checkout', 'releasit_form', 'custom_landing'].includes(source)) {
    whereClause.source = source;
  }

  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    whereClause[Op.or] = [
      { phone_raw: { [Op.like]: term } },
      { phone_normalizado: { [Op.like]: term } },
      { email: { [Op.like]: term } },
      { nombre_cliente: { [Op.like]: term } },
      { apellido_cliente: { [Op.like]: term } },
    ];
  }

  /* Listar con paginación */
  const { count, rows } = await ShopifyCarritosAbandonados.findAndCountAll({
    where: whereClause,
    order: [['created_at', 'DESC']],
    limit: limitNum,
    offset,
  });

  const data = await adjuntarImagenProducto(idConf, rows);

  return res.json({
    isSuccess: true,
    data,
    pagination: {
      total: count,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(count / limitNum),
    },
  });
});

/* ============================================================
   GET /estadisticas — métricas agregadas
   ============================================================ */
exports.estadisticas = catchAsync(async (req, res) => {
  const { id_configuracion } = req.query;

  if (!id_configuracion) {
    return res.status(400).json({
      isSuccess: false,
      message: 'id_configuracion es requerido',
    });
  }

  const idConf = parseInt(id_configuracion, 10);

  /* Una sola query con agregaciones */
  const stats = await ShopifyCarritosAbandonados.findAll({
    where: { id_configuracion: idConf },
    attributes: [
      [fn('COUNT', col('id')), 'total'],
      [fn('SUM', literal('CASE WHEN recuperado = 1 THEN 1 ELSE 0 END')), 'recuperados'],
      [fn('SUM', literal('CASE WHEN recuperado = 0 THEN 1 ELSE 0 END')), 'pendientes'],
      [fn('SUM', col('total_price')), 'valor_total'],
      [fn('SUM', literal('CASE WHEN recuperado = 1 THEN total_price ELSE 0 END')), 'valor_recuperado'],
      [fn('SUM', literal('CASE WHEN recuperado = 0 THEN total_price ELSE 0 END')), 'valor_pendiente'],
    ],
    raw: true,
  });

  const s = stats[0] || {};
  const total = parseInt(s.total, 10) || 0;
  const recuperados = parseInt(s.recuperados, 10) || 0;
  const pendientes = parseInt(s.pendientes, 10) || 0;
  const valorTotal = parseFloat(s.valor_total) || 0;
  const valorRecuperado = parseFloat(s.valor_recuperado) || 0;
  const valorPendiente = parseFloat(s.valor_pendiente) || 0;
  const tasaRecuperacion = total > 0 ? (recuperados / total) * 100 : 0;

  return res.json({
    isSuccess: true,
    data: {
      total,
      recuperados,
      pendientes,
      valor_total: parseFloat(valorTotal.toFixed(2)),
      valor_recuperado: parseFloat(valorRecuperado.toFixed(2)),
      valor_pendiente: parseFloat(valorPendiente.toFixed(2)),
      tasa_recuperacion: parseFloat(tasaRecuperacion.toFixed(2)),
    },
  });
});

/* ============================================================
   PATCH /:id/marcar-mensaje-enviado
   (para registrar manualmente cuando el usuario envía WhatsApp)
   ============================================================ */
exports.marcarMensajeEnviado = catchAsync(async (req, res) => {
  const { id } = req.params;
  const id_configuracion = parseInt(
    req.body?.id_configuracion ?? req.query?.id_configuracion,
    10,
  );

  const carrito = await ShopifyCarritosAbandonados.findByPk(id);
  if (!carrito) {
    return res.status(404).json({
      isSuccess: false,
      message: 'Carrito no encontrado',
    });
  }

  // Ownership: el carrito debe pertenecer a la config que hace la petición.
  if (id_configuracion && carrito.id_configuracion !== id_configuracion) {
    return res.status(403).json({ isSuccess: false, message: 'No autorizado' });
  }

  await carrito.update({
    mensaje_enviado: 1,
    fecha_envio_mensaje: new Date(),
  });

  return res.json({
    isSuccess: true,
    data: carrito,
    message: 'Mensaje registrado',
  });
});