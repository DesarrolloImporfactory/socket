const Productos = require("../models/productos.model");
const catchAsync = require("../utils/catchAsync");
const { db } = require("../database/config");

exports.findAllAditionalProducts = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 5, searchTerm, id_producto, sku } = req.body;

  if (!id_producto || !sku) {
    return res.status(400).json({
      status: "fail",
      message: "Se requieren el id_producto y el sku.",
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
      status: "fail",
      message: "No se encontró información con ese id_producto y sku.",
    });
  }

  const { bodega, id_plataforma } = datos[0];

  // 👇 Ahora sí filtramos los productos relacionados
  const hasSearchTerm = searchTerm && searchTerm.trim() !== "";

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
    ${hasSearchTerm ? "AND p.nombre_producto LIKE :search" : ""}
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
    ${hasSearchTerm ? "AND p.nombre_producto LIKE :search" : ""}
    LIMIT :limit OFFSET :offset
  `;

  const productos = await db.query(productosQuery, {
    replacements,
    type: db.QueryTypes.SELECT,
  });

  const totalPages = Math.ceil(total / limit);

  // 📤 Enviar respuesta
  res.status(200).json({
    status: "success",
    results: productos.length,
    page,
    totalPages,
    products: productos, // <-- ✅ nombre correcto esperado por el frontend
  });
});
