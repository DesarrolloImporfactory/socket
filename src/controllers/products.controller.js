const AppError = require('../utils/appError');
const Productos = require('../models/productos.model');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');

exports.findAllAditionalProducts = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 5, searchTerm, id_producto, sku } = req.body;

  if (!id_producto || !sku) {
    return res.status(400).json({
      status: 'fail',
      message: 'Se requieren el id_producto y el sku.',
    });
  }

  // 🔍 Paso 1: Obtener bodega e id_plataforma
  const datosQuery = `
    SELECT bodega, id_plataforma 
    FROM inventario_bodegas 
    WHERE id_producto = :id_producto AND sku = :sku
    LIMIT 1
  `;

  const datos = await db.query(datosQuery, {
    replacements: { id_producto, sku },
    type: db.QueryTypes.SELECT,
  });

  if (!datos.length) {
    return res.status(404).json({
      status: 'fail',
      message: 'No se encontró información con ese id_producto y sku.',
    });
  }

  const { bodega, id_plataforma } = datos[0];

  // 👇 Ahora sí filtramos los productos relacionados
  const hasSearchTerm = searchTerm && searchTerm.trim() !== '';

  const replacements = {
    bodega,
    id_plataforma,
    limit: parseInt(limit, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
  };

  if (hasSearchTerm) {
    replacements.search = `%${searchTerm}%`;
  }

  // Consulta total
  const totalProductosQuery = `
    SELECT COUNT(*) as total
    FROM inventario_bodegas ib
    INNER JOIN productos p ON p.id_producto = ib.id_producto
    WHERE ib.bodega = :bodega AND p.id_plataforma = :id_plataforma
    ${hasSearchTerm ? 'AND p.nombre_producto LIKE :search' : ''}
  `;

  const totalProductos = await db.query(totalProductosQuery, {
    replacements,
    type: db.QueryTypes.SELECT,
  });

  const total = totalProductos[0].total;

  // Consulta con paginación
  const productosQuery = `
    SELECT ib.*, p.*
    FROM inventario_bodegas ib
    INNER JOIN productos p ON p.id_producto = ib.id_producto
    WHERE ib.bodega = :bodega AND p.id_plataforma = :id_plataforma
    ${hasSearchTerm ? 'AND p.nombre_producto LIKE :search' : ''}
    LIMIT :limit OFFSET :offset
  `;

  const productos = await db.query(productosQuery, {
    replacements,
    type: db.QueryTypes.SELECT,
  });

  const totalPages = Math.ceil(total / limit);

  // 📤 Enviar respuesta
  res.status(200).json({
    status: 'success',
    results: productos.length,
    page,
    totalPages,
    products: productos, // <-- ✅ nombre correcto esperado por el frontend
  });
});

exports.agregarProducto = catchAsync(async (req, res, next) => {
  const { id_factura, id_producto, id_inventario, sku, cantidad, precio } =
    req.body;

  try {
    // 1. Verificamos si existe la factura
    const [factura] = await db.query(
      'SELECT * FROM facturas_cot WHERE id_factura = ? LIMIT 1',
      {
        replacements: [id_factura],
        type: db.QueryTypes.SELECT,
      }
    );

    if (!factura) {
      return res.status(400).json({
        status: 400,
        message: 'Factura no encontrada',
      });
    }

    const { numero_factura, id_plataforma } = factura;

    // 2. Insertamos el producto
    const [insertResult] = await db.query(
      `INSERT INTO detalle_fact_cot 
        (id_inventario, id_producto, sku, precio_venta, cantidad, id_factura, numero_factura, id_plataforma)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_inventario,
          id_producto,
          sku,
          precio,
          cantidad,
          id_factura,
          numero_factura,
          id_plataforma,
        ],
        type: db.QueryTypes.INSERT,
      }
    );

    res.status(200).json({
      status: 200,
      title: 'Éxito',
      message: 'Producto agregado correctamente',
    });
  } catch (error) {
    console.error('Error real al agregar producto:', error); // 👈 Muestra el error real
    return next(new AppError('Error al agregar producto a la factura', 500));
  }
});

exports.eliminarProducto = catchAsync(async (req, res, next) => {
  const { id_detalle } = req.body;

  try {
    const result = await db.query(
      'DELETE FROM detalle_fact_cot WHERE id_detalle = ?',
      {
        replacements: [id_detalle],
        type: db.QueryTypes.BULKDELETE,
      }
    );

    if (result == 0){
      return next(new AppError('Error al borrar el producto', 400));
    }

    return res.status(200).json({
      status: 200,
      title: 'Éxito',
      message: 'Producto eliminado correctamente',
    });
  } catch (error) {
    console.error('Error al eliminar producto:', error.message);
    return res.status(400).json({
      status: 400,
      message: error.message || 'Error al eliminar producto',
    });
  }
});
