const { Op, literal, fn, col, where } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const ShopifyCarritosAbandonados = require('../models/shopify_carritos_abandonados.model');

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

  return res.json({
    isSuccess: true,
    data: rows,
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

  const carrito = await ShopifyCarritosAbandonados.findByPk(id);
  if (!carrito) {
    return res.status(404).json({
      isSuccess: false,
      message: 'Carrito no encontrado',
    });
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