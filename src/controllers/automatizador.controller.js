const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const { db, db_2 } = require('../database/config');

const fs = require('fs');
const path = require('path');

const ProductosChatCenter = require('../models/productos_chat_center.model');

exports.obtenerProductosAutomatizador = catchAsync(async (req, res, next) => {
  // ✅ Manejar tanto query params (GET) como body (POST)
  const { id_configuracion } = req.method === 'GET' ? req.query : req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      status: 'error',
      message: 'El parámetro id_configuracion es requerido.',
    });
  }

  console.log('🔍 Obteniendo productos para configuración:', id_configuracion);

  const plataforma = await db_2.query(
    `
    SELECT id_plataforma 
    FROM configuraciones 
    WHERE id = ?
    `,
    {
      replacements: [id_configuracion],
      type: db_2.QueryTypes.SELECT,
    }
  );

  // Verificar que la plataforma existe
  if (!plataforma || plataforma.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'No se encontró la plataforma para esta configuración.',
    });
  }

  const id_plataforma = plataforma[0].id_plataforma;
  console.log('🏷️ ID Plataforma encontrada:', id_plataforma);

  if (id_plataforma === 1206 /* || id_plataforma === 2293 */) {
    // Consulta para la plataforma específica (1206)
    const productos = await db_2.query(
      `
      SELECT 
        st.id_inventario,
        st.id_plataforma,
        p.nombre_producto AS nombre_producto_tienda
      FROM shopify_tienda st
      INNER JOIN inventario_bodegas ib ON ib.id_inventario = st.id_inventario
      INNER JOIN productos p ON p.id_producto = ib.id_producto
      WHERE st.id_plataforma = ?
      `,
      {
        replacements: [id_plataforma],
        type: db_2.QueryTypes.SELECT,
      }
    );

    console.log('📦 Productos encontrados:', productos.length);

    if (!productos || productos.length === 0) {
      return res.status(200).json({
        status: 'success',
        data: [],
        message: 'No existen productos para esta plataforma.',
      });
    }

    return res.status(200).json({
      status: 'success',
      data: productos,
    });
  } else {
    // Si la plataforma no es 1206, hacer consultas a Shopify, Tiendas y Funnelish
    const sqlShopify = `
      SELECT 
        st.id_inventario, 
        CONCAT(p.nombre_producto, '- SHOPIFY') AS nombre
      FROM shopify_tienda st
      INNER JOIN inventario_bodegas ib ON ib.id_inventario = st.id_inventario
      INNER JOIN productos p ON ib.id_producto = p.id_producto
      WHERE st.id_plataforma = ?
    `;
    const sqlTiendas = `
      SELECT 
        pt.id_inventario, 
        CONCAT(p.nombre_producto, '- TIENDA') AS nombre
      FROM productos_tienda pt
      INNER JOIN inventario_bodegas ib ON ib.id_inventario = pt.id_inventario
      INNER JOIN productos p ON ib.id_producto = p.id_producto
      WHERE pt.id_plataforma = ?
    `;
    const sqlFunnel = `
      SELECT 
        pf.id_producto, 
        CONCAT(p.nombre_producto, '- FUNNELISH') AS nombre
      FROM productos_funnel pf
      INNER JOIN inventario_bodegas ib ON ib.id_inventario = pf.id_producto
      INNER JOIN productos p ON ib.id_producto = p.id_producto
      WHERE pf.id_plataforma = ?
    `;

    // Ejecutar las consultas
    const [dataShopify, dataTiendas, dataFunnel] = await Promise.all([
      db_2.query(sqlShopify, {
        replacements: [id_plataforma],
        type: db_2.QueryTypes.SELECT,
      }),
      db_2.query(sqlTiendas, {
        replacements: [id_plataforma],
        type: db_2.QueryTypes.SELECT,
      }),
      db_2.query(sqlFunnel, {
        replacements: [id_plataforma],
        type: db_2.QueryTypes.SELECT,
      }),
    ]);

    // Unir los resultados de las tres fuentes de datos
    const response = [...dataShopify, ...dataTiendas, ...dataFunnel];

    console.log('📦 Total productos encontrados:', response.length);

    if (!response || response.length === 0) {
      return res.status(200).json({
        status: 'success',
        data: [],
        message: 'No existen productos para esta plataforma.',
      });
    }

    return res.status(200).json({
      status: 'success',
      data: response,
    });
  }
});

exports.obtenerCategoriasAutomatizador = catchAsync(async (req, res, next) => {
  // ✅ Manejar tanto query params (GET) como body (POST)
  const { id_configuracion } = req.method === 'GET' ? req.query : req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      status: 'error',
      message: 'El parámetro id_configuracion es requerido.',
    });
  }

  console.log('🔍 Obteniendo categorías para configuración:', id_configuracion);

  const plataforma = await db_2.query(
    `
    SELECT id_plataforma 
    FROM configuraciones 
    WHERE id = ?
    `,
    {
      replacements: [id_configuracion],
      type: db_2.QueryTypes.SELECT,
    }
  );

  // Verificar que la plataforma existe
  if (!plataforma || plataforma.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'No se encontró la plataforma para esta configuración.',
    });
  }

  const id_plataforma = plataforma[0].id_plataforma;
  console.log('🏷️ ID Plataforma encontrada:', id_plataforma);

  // Consulta para obtener categorías que pertenecen a la plataforma o son globales
  const categorias = await db_2.query(
    `
    SELECT * 
    FROM lineas 
    WHERE id_plataforma = ? OR global = 1
    `,
    {
      replacements: [id_plataforma],
      type: db_2.QueryTypes.SELECT,
    }
  );

  console.log('📂 Categorías encontradas:', categorias.length);

  if (!categorias || categorias.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen categorías para esta plataforma.',
    });
  }

  return res.status(200).json({
    status: 'success',
    data: categorias,
  });
});

exports.obtenerTemplatesAutomatizador = catchAsync(async (req, res, next) => {
  // ✅ Manejar tanto query params (GET) como body (POST)
  const { id_configuracion } = req.method === 'GET' ? req.query : req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      status: 'error',
      message: 'El parámetro id_configuracion es requerido.',
    });
  }

  console.log('🔍 Obteniendo templates para configuración:', id_configuracion);

  // Consulta para obtener los templates según el id_configuracion
  const templates = await db_2.query(
    `
    SELECT * 
    FROM templates_chat_center 
    WHERE id_configuracion = ?
    `,
    {
      replacements: [id_configuracion],
      type: db_2.QueryTypes.SELECT,
    }
  );

  if (!templates || templates.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen templates para esta configuración.',
    });
  }

  console.log('✅ Templates obtenidos:', templates.length);

  return res.status(200).json({
    status: 'success',
    data: templates,
  });
});

exports.obtenerEtiquetasAutomatizador = catchAsync(async (req, res, next) => {
  // ✅ Manejar tanto query params (GET) como body (POST)
  const { id_configuracion } = req.method === 'GET' ? req.query : req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      status: 'error',
      message: 'El parámetro id_configuracion es requerido.',
    });
  }

  console.log('🔍 Obteniendo etiquetas para configuración:', id_configuracion);

  // Consulta para obtener las etiquetas según el id_plataforma
  const etiquetas = await db_2.query(
    `
    SELECT * 
    FROM etiquetas_chat_center 
    WHERE id_configuracion = ?
    `,
    {
      replacements: [id_configuracion],
      type: db_2.QueryTypes.SELECT,
    }
  );

  if (!etiquetas || etiquetas.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen etiquetas para esta plataforma.',
    });
  }

  console.log('✅ Etiquetas obtenidas:', etiquetas.length);

  return res.status(200).json({
    status: 'success',
    data: etiquetas,
  });
});
