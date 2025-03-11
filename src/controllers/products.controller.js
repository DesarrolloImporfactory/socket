const Productos = require("../models/productos.model");
const catchAsync = require("../utils/catchAsync");
const { db } = require("../database/config");

exports.findAllAditionalProducts = catchAsync(async (req, res, next) => {
  const { bodega } = req.params;
  const { page = 1, limit = 5, searchTerm } = req.body; // Se extrae `searchTerm` correctamente y se asignan valores por defecto

  // Verificar si se está buscando un producto
  const hasSearchTerm = searchTerm && searchTerm.trim() !== "";

  // Consulta para contar el total de productos con o sin filtro
  const totalProductosQuery = `
    SELECT COUNT(*) as total 
    FROM vista_productos_adicionales 
    WHERE bodega = :bodega 
    ${hasSearchTerm ? "AND nombre_producto LIKE :search" : ""}
  `;

  // Parámetros de la consulta
  const replacements = {
    bodega,
  };

  // Agregar `searchTerm` solo si se envía
  if (hasSearchTerm) {
    replacements.search = `%${searchTerm}%`;
  }

  // Obtener el total de productos
  const totalProductos = await db.query(totalProductosQuery, {
    replacements,
    type: db.QueryTypes.SELECT,
  });

  const total = totalProductos[0].total;

  // Consulta para obtener los productos paginados con o sin filtro
  const productsQuery = `
    SELECT * FROM vista_productos_adicionales 
    WHERE bodega = :bodega 
    ${hasSearchTerm ? "AND nombre_producto LIKE :search" : ""} 
    LIMIT :limit OFFSET :offset
  `;

  // Agregar `limit` y `offset` a `replacements`
  replacements.limit = parseInt(limit, 10);
  replacements.offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  // Obtener los productos con la paginación
  const products = await db.query(productsQuery, {
    replacements,
    type: db.QueryTypes.SELECT,
  });

  // Calcular el total de páginas
  const totalPages = Math.ceil(total / limit);

  res.status(200).json({
    status: "success",
    results: products.length,
    page,
    totalPages,
    products,
  });
});
