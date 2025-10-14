const AppError = require('../utils/appError');
const Productos = require('../models/productos.model');
const Detalle_fact_cot = require('../models/detalle_fact_cot.model');
const catchAsync = require('../utils/catchAsync');
const { db_2 } = require('../database/config');

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

//   const datos = await db_2.query(datosQuery, {
//     replacements: { id_producto, sku },
//     type: db_2.QueryTypes.SELECT,
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

//   const totalProductos = await db_2.query(totalProductosQuery, {
//     replacements,
//     type: db_2.QueryTypes.SELECT,
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

//   const productos = await db_2.query(productosQuery, {
//     replacements,
//     type: db_2.QueryTypes.SELECT,
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
  const baseRows = await db_2.query(baseQuery, {
    replacements: { id_producto, sku },
    type: db_2.QueryTypes.SELECT,
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
  const privadoRows = await db_2.query(privadoQuery, {
    replacements: { id_producto, id_plataforma_usuario },
    type: db_2.QueryTypes.SELECT,
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
  const totalRows = await db_2.query(totalQuery, {
    replacements: replacementsBase,
    type: db_2.QueryTypes.SELECT,
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
  const productos = await db_2.query(productosQuery, {
    replacements: { ...replacementsBase, limit: limitNum, offset: offsetNum },
    type: db_2.QueryTypes.SELECT,
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
    const [factura] = await db_2.query(
      'SELECT * FROM facturas_cot WHERE id_factura = ? LIMIT 1',
      {
        replacements: [id_factura],
        type: db_2.QueryTypes.SELECT,
      }
    );

    if (!factura) {
      return res.status(400).json({
        status: 400,
        message: 'Factura no encontrada',
      });
    }

    const { numero_factura, id_plataforma } = factura;

    const created = await Detalle_fact_cot.create({
      id_inventario,
      id_producto,
      sku,
      precio_venta: precio,
      cantidad,
      id_factura,
      numero_factura,
      id_plataforma
    });

    res.status(200).json({
      status: 200,
      title: 'Éxito',
      message: 'Producto agregado correctamente',
      id_detalle: created.id_detalle 
    });
  } catch (error) {
    console.error('Error real al agregar producto:', error); // 👈 Muestra el error real
    return next(new AppError('Error al agregar producto a la factura', 500));
  }
});

exports.eliminarProducto = catchAsync(async (req, res, next) => {
  const { id_detalle } = req.body;

  try {
    const result = await db_2.query(
      'DELETE FROM detalle_fact_cot WHERE id_detalle = ?',
      {
        replacements: [id_detalle],
        type: db_2.QueryTypes.BULKDELETE,
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

async function obtenerFull(producto, plataformaSolicitada) {
  // 1) inventario_bodegas (LIMIT 1)
  const [inv] = await db_2.query(
    'SELECT * FROM inventario_bodegas WHERE id_producto = ? LIMIT 1',
    {
      replacements: [producto.id_producto],
      type: db_2.QueryTypes.SELECT,
    }
  );
  if (!inv) return 0;

  // 2) bodega (LIMIT 1)
  const [bodega] = await db_2.query('SELECT * FROM bodega WHERE id = ? LIMIT 1', {
    replacements: [inv.bodega],
    type: db_2.QueryTypes.SELECT,
  });
  if (!bodega) return 0;

  const id_bodega = Number(bodega.id_plataforma) || 0;
  let full = Number(bodega.full_filme) || 0;
  const prodPlat = Number(producto.id_plataforma) || 0;
  const paramPlat = Number(plataformaSolicitada) || 0;

  // 🔹 Lógica exacta del PHP
  if (prodPlat === id_bodega) {
    full = 0;
  } else if (id_bodega === prodPlat) {
    full = 0; // redundante pero mantenido por fidelidad
  } else if (paramPlat === prodPlat) {
    full = full; // se queda igual
  } else {
    full = 0;
  }

  return full;
}

exports.calcularGuiaDirecta = catchAsync(async (req, res, next) => {
  const { id_producto, total, tarifa, id_plataforma, costo } = req.body || {};

  // 1) Validaciones mínimas
  if (!id_producto || id_plataforma === undefined || id_plataforma === null) {
    return next(
      new AppError(
        'Faltan campos obligatorios: id_producto o id_plataforma',
        400
      )
    );
  }

  // 2) Normalización numérica
  let totalNum = Number(total) || 0;
  let tarifaNum = Number(tarifa) || 0;
  let costoNum = Number(costo) || 0;
  const idPlat = Number(id_plataforma) || 0;

  // 3) Buscar producto
  const [producto] = await db_2.query(
    'SELECT * FROM productos WHERE id_producto = ? LIMIT 1',
    {
      replacements: [id_producto],
      type: db_2.QueryTypes.SELECT,
    }
  );
  if (!producto) {
    return next(new AppError('Producto no encontrado', 404));
  }

  // 4) Calcular FULL (como en PHP)
  const fullNum = await obtenerFull(producto, idPlat);

  // 5) Si plataforma del request == plataforma del producto → costo = 0
  const plataformaProducto = Number(producto.id_plataforma) || 0;
  if (idPlat === plataformaProducto) {
    costoNum = 0;
  }

  // 6) Cálculo resultante y flag generar
  let resultante = totalNum - costoNum - tarifaNum - fullNum;
  const generar = resultante > 0;

  // 7) Respuesta
  return res.status(200).json({
    status: 200,
    title: 'Éxito',
    message: 'Cálculo realizado correctamente',
    data: {
      total: totalNum.toFixed(2),
      tarifa: tarifaNum.toFixed(2),
      costo: costoNum.toFixed(2),
      resultante: resultante.toFixed(2),
      generar,
      full: fullNum.toFixed(2),
    },
  });
});
