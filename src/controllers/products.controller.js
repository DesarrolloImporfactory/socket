const AppError = require('../utils/appError');
const Productos = require('../models/productos.model');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');

// exports.findAllAditionalProducts = catchAsync(async (req, res, next) => {
//   const { page = 1, limit = 5, searchTerm, id_producto, sku } = req.body;

//   if (!id_producto || !sku) {
//     return res.status(400).json({
//       status: 'fail',
//       message: 'Se requieren el id_producto y el sku.',
//     });
//   }

//   // 🔍 Paso 1: Obtener bodega e id_plataforma
//   const datosQuery = `
//     SELECT bodega, id_plataforma
//     FROM inventario_bodegas
//     WHERE id_producto = :id_producto AND sku = :sku
//     LIMIT 1
//   `;

//   const datos = await db.query(datosQuery, {
//     replacements: { id_producto, sku },
//     type: db.QueryTypes.SELECT,
//   });

//   if (!datos.length) {
//     return res.status(404).json({
//       status: 'fail',
//       message: 'No se encontró información con ese id_producto y sku.',
//     });
//   }

//   const { bodega, id_plataforma } = datos[0];

//   // 👇 Ahora sí filtramos los productos relacionados
//   const hasSearchTerm = searchTerm && searchTerm.trim() !== '';

//   const replacements = {
//     bodega,
//     id_plataforma,
//     limit: parseInt(limit, 10),
//     offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
//   };

//   if (hasSearchTerm) {
//     replacements.search = `%${searchTerm}%`;
//   }

//   // Consulta total
//   const totalProductosQuery = `
//     SELECT COUNT(*) as total
//     FROM inventario_bodegas ib
//     INNER JOIN productos p ON p.id_producto = ib.id_producto
//     WHERE ib.bodega = :bodega AND p.id_plataforma = :id_plataforma
//     ${hasSearchTerm ? 'AND p.nombre_producto LIKE :search' : ''}
//   `;

//   const totalProductos = await db.query(totalProductosQuery, {
//     replacements,
//     type: db.QueryTypes.SELECT,
//   });

//   const total = totalProductos[0].total;

//   // Consulta con paginación
//   const productosQuery = `
//     SELECT ib.*, p.*
//     FROM inventario_bodegas ib
//     INNER JOIN productos p ON p.id_producto = ib.id_producto
//     WHERE ib.bodega = :bodega AND p.id_plataforma = :id_plataforma
//     ${hasSearchTerm ? 'AND p.nombre_producto LIKE :search' : ''}
//     LIMIT :limit OFFSET :offset
//   `;

//   const productos = await db.query(productosQuery, {
//     replacements,
//     type: db.QueryTypes.SELECT,
//   });

//   const totalPages = Math.ceil(total / limit);

//   // 📤 Enviar respuesta
//   res.status(200).json({
//     status: 'success',
//     results: productos.length,
//     page,
//     totalPages,
//     products: productos, // <-- ✅ nombre correcto esperado por el frontend
//   });
// });

exports.findAllAditionalProducts = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 5,
    searchTerm,
    id_producto,
    sku,
    id_plataforma_usuario, // ← viene del localStorage (front)
  } = req.body;

  if (!id_producto || !sku || !id_plataforma_usuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'Se requieren id_producto, sku e id_plataforma_usuario.',
    });
  }

  // 1) Obtener bodega + id_plataforma del producto consultado
  const baseQuery = `
    SELECT bodega, id_plataforma
    FROM inventario_bodegas
    WHERE id_producto = :id_producto AND sku = :sku
    LIMIT 1
  `;
  const baseRows = await db.query(baseQuery, {
    replacements: { id_producto, sku },
    type: db.QueryTypes.SELECT,
  });

  if (!baseRows.length) {
    return res.status(404).json({
      status: 'fail',
      message: 'No se encontró información con ese id_producto y sku.',
    });
  }

  const { bodega, id_plataforma: id_plataforma_producto } = baseRows[0];

  // 2) ¿Privado para la plataforma actual?
  const privadoQuery = `
    SELECT 1
    FROM producto_privado
    WHERE id_producto = :id_producto AND id_plataforma = :id_plataforma_usuario
    LIMIT 1
  `;
  const privadoRows = await db.query(privadoQuery, {
    replacements: { id_producto, id_plataforma_usuario },
    type: db.QueryTypes.SELECT,
  });
  const es_privado = privadoRows.length > 0;

  // 3) Condición drogshipin (solo si NO es dueño y NO es privado)
  const exigirDrogshipin =
    Number(id_plataforma_producto) !== Number(id_plataforma_usuario) &&
    !es_privado;

  // 4) WHERE común (total y página)
  const hasSearchTerm = !!(searchTerm && searchTerm.trim() !== '');
  const whereParts = [
    'ib.bodega = :bodega',
    'p.id_plataforma = :id_plataforma_producto',
    'ib.saldo_stock > 0',
    'p.eliminado = 0',
  ];
  if (exigirDrogshipin) whereParts.push('p.drogshipin = 1');
  if (hasSearchTerm) whereParts.push('p.nombre_producto LIKE :search');

  const whereClause = whereParts.join(' AND ');
  const replacementsBase = {
    bodega,
    id_plataforma_producto,
    ...(hasSearchTerm ? { search: `%${searchTerm}%` } : {}),
  };

  // 5) Total
  const totalQuery = `
    SELECT COUNT(*) AS total
    FROM inventario_bodegas ib
    INNER JOIN productos p ON p.id_producto = ib.id_producto
    WHERE ${whereClause}
  `;
  const totalRows = await db.query(totalQuery, {
    replacements: replacementsBase,
    type: db.QueryTypes.SELECT,
  });
  const total = Number(totalRows?.[0]?.total || 0);

  // 6) Página
  const limitNum = parseInt(limit, 10);
  const pageNum = parseInt(page, 10);
  const offsetNum = (pageNum - 1) * limitNum;

  const productosQuery = `
    SELECT ib.*, p.*
    FROM inventario_bodegas ib
    INNER JOIN productos p ON p.id_producto = ib.id_producto
    WHERE ${whereClause}
    ORDER BY p.nombre_producto ASC
    LIMIT :limit OFFSET :offset
  `;
  const productos = await db.query(productosQuery, {
    replacements: { ...replacementsBase, limit: limitNum, offset: offsetNum },
    type: db.QueryTypes.SELECT,
  });

  return res.status(200).json({
    status: 'success',
    results: productos.length,
    page: pageNum,
    totalPages: Math.ceil(total / limitNum),
    products: productos,
    meta: {
      id_plataforma_usuario: Number(id_plataforma_usuario),
      id_plataforma_producto,
      bodega,
      es_privado,
      exigirDrogshipin,
      total,
    },
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

    if (result == 0) {
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
