const Productos = require('../models/productos.model');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
exports.findAllAditionalProducts = catchAsync(async (req, res, next) => {
  const { bodega } = req.params;
  const { page, limit } = req.body;

  // Consulta para contar el total de productos
  const totalProductos = await db.query(
    'SELECT COUNT(*) as total FROM vista_productos_adicionales WHERE bodega = :bodega',
    {
      replacements: { bodega },
      type: db.QueryTypes.SELECT,
    }
  );

  // Total de productos
  const total = totalProductos[0].total;

  // Consulta para obtener los productos paginados
  const products = await db.query(
    'SELECT * FROM vista_productos_adicionales WHERE bodega = :bodega LIMIT :limit OFFSET :offset',
    {
      replacements: {
        bodega,
        limit,
        offset: (page - 1) * limit,
      },
      type: db.QueryTypes.SELECT,
    }
  );

  // Calcular el total de páginas
  const totalPages = Math.ceil(total / limit);

  res.status(200).json({
    status: 'success',
    results: products.length,
    page,
    totalPages,
    products,
  });
});
