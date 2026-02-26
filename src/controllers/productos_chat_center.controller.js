const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const { db, db_2 } = require('../database/config');

const fs = require('fs');
const path = require('path');
const { htmlToText } = require('html-to-text');

const ProductosChatCenter = require('../models/productos_chat_center.model');
const CategoriasChatCenter = require('../models/categorias_chat_center.model');

const DropiIntegrations = require('../models/dropi_integrations.model');
const { encryptToken, last4, decryptToken } = require('../utils/cryptoToken');
const {
  syncCatalogoAsistentesPorConfiguracion,
} = require('../utils/openia/carga_file_productos');
const dropiService = require('../services/dropi.service');

async function getActiveIntegration(id_configuracion) {
  return DropiIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
}

exports.listarProductos = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;

  const productos = await ProductosChatCenter.findAll({
    where: { id_configuracion },
  });

  if (!productos || productos.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen productos para esta configuración.',
    });
  }

  res.status(200).json({
    status: 'success',
    data: productos,
  });
});

exports.listarProductosImporsuit = catchAsync(async (req, res, next) => {
  const { id_plataforma } = req.body;

  const productos = await db_2.query(
    `
    SELECT 
      p.nombre_producto AS nombre,
      ib.id_inventario AS id
    FROM inventario_bodegas ib
    INNER JOIN productos p ON ib.id_producto = p.id_producto
    WHERE p.id_plataforma = ?
    `,
    {
      replacements: [id_plataforma],
      type: db_2.QueryTypes.SELECT,
    },
  );

  if (!productos || productos.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen productos para esta plataforma.',
    });
  }

  res.status(200).json({
    status: 'success',
    data: productos,
  });
});

// URL base pública donde sirve /uploads
const dominio = 'https://chat.imporfactory.app';

// ========== AGREGAR ==========
exports.agregarProducto = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    nombre,
    descripcion,
    tipo,
    precio,
    duracion,
    id_categoria,
    nombre_upsell,
    descripcion_upsell,
    precio_upsell,
    combos_producto,
  } = req.body;

  if (!id_configuracion || !nombre || !tipo || !precio) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_configuracion, nombre, tipo y precio son obligatorios.',
    });
  }

  // Archivos (con .fields())
  const imagenFile = req.files?.imagen?.[0] || null;
  const videoFile = req.files?.video?.[0] || null;
  const imagen_upsellFile = req.files?.imagen_upsell?.[0] || null;

  const imagen_url = imagenFile
    ? `${dominio}/uploads/productos/imagen/${imagenFile.filename}`
    : null;

  const video_url = videoFile
    ? `${dominio}/uploads/productos/video/${videoFile.filename}`
    : null;

  const imagen_upsell_url = imagen_upsellFile
    ? `${dominio}/uploads/productos/imagen_upsell/${imagen_upsellFile.filename}`
    : null;

  const nuevoProducto = await ProductosChatCenter.create({
    id_configuracion,
    nombre,
    descripcion,
    tipo,
    precio,
    duracion,
    id_categoria,
    imagen_url,
    video_url,
    nombre_upsell,
    descripcion_upsell,
    precio_upsell,
    imagen_upsell_url,
    combos_producto,
  });

  syncCatalogoAsistentesPorConfiguracion(id_configuracion).catch((e) => {
    console.error(`⚠️ Error sync catálogo: ${e.message}`);
  });

  return res.status(201).json({ status: 'success', data: nuevoProducto });
});

// ========== ACTUALIZAR ==========
exports.actualizarProducto = catchAsync(async (req, res, next) => {
  const {
    id_producto,
    nombre,
    descripcion,
    tipo,
    precio,
    duracion,
    id_categoria,
    nombre_upsell,
    descripcion_upsell,
    precio_upsell,
    combos_producto,
  } = req.body;

  const producto = await ProductosChatCenter.findByPk(id_producto);
  if (!producto) {
    return res
      .status(404)
      .json({ status: 'fail', message: 'Producto no encontrado.' });
  }

  const imagenFile = req.files?.imagen?.[0] || null;
  const videoFile = req.files?.video?.[0] || null;
  const imagen_upsellFile = req.files?.imagen_upsell?.[0] || null;

  // Si llega NUEVA IMAGEN: borrar anterior y setear nueva URL
  if (imagenFile) {
    try {
      if (producto.imagen_url) {
        const filename = path.basename(producto.imagen_url);
        const absPath = path.join(
          __dirname,
          '..',
          'uploads',
          'productos',
          'imagen',
          filename,
        );
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      }
    } catch (_) {}
    producto.imagen_url = `${dominio}/uploads/productos/imagen/${imagenFile.filename}`;
  }

  // Si llega NUEVO VIDEO: borrar anterior y setear nueva URL
  if (videoFile) {
    try {
      if (producto.video_url) {
        const filename = path.basename(producto.video_url);
        const absPath = path.join(
          __dirname,
          '..',
          'uploads',
          'productos',
          'video',
          filename,
        );
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      }
    } catch (_) {}
    producto.video_url = `${dominio}/uploads/productos/video/${videoFile.filename}`;
  }

  if (imagen_upsellFile) {
    try {
      if (producto.imagen_upsell_url) {
        const filename = path.basename(producto.imagen_upsell_url);
        const absPath = path.join(
          __dirname,
          '..',
          'uploads',
          'productos',
          'imagen',
          filename,
        );
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      }
    } catch (_) {}
    producto.imagen_upsell_url = `${dominio}/uploads/productos/imagen_upsell/${imagen_upsellFile.filename}`;
  }

  // Actualizar campos básicos (si vienen)
  if (typeof nombre !== 'undefined') producto.nombre = nombre;
  if (typeof descripcion !== 'undefined') producto.descripcion = descripcion;
  if (typeof tipo !== 'undefined') producto.tipo = tipo;
  if (typeof precio !== 'undefined') producto.precio = precio;
  if (typeof duracion !== 'undefined') producto.duracion = duracion;
  if (typeof id_categoria !== 'undefined') producto.id_categoria = id_categoria;
  if (typeof nombre_upsell !== 'undefined')
    producto.nombre_upsell = nombre_upsell;
  if (typeof descripcion_upsell !== 'undefined')
    producto.descripcion_upsell = descripcion_upsell;
  if (typeof precio_upsell !== 'undefined')
    producto.precio_upsell = precio_upsell;

  if (typeof combos_producto !== 'undefined')
    producto.combos_producto = combos_producto;
  producto.fecha_actualizacion = new Date();

  const idConfigSync = producto.id_configuracion;

  await producto.save();

  syncCatalogoAsistentesPorConfiguracion(idConfigSync).catch((e) => {
    console.error(`⚠️ Error sync catálogo: ${e.message}`);
  });

  return res.status(200).json({ status: 'success', data: producto });
});

exports.eliminarProducto = catchAsync(async (req, res, next) => {
  const { id_producto } = req.body;

  const producto = await ProductosChatCenter.findByPk(id_producto);

  if (!producto) {
    return res.status(404).json({
      status: 'fail',
      message: 'Producto no encontrado.',
    });
  }

  await producto.destroy();

  res.status(200).json({
    status: 'success',
    message: 'Producto eliminado correctamente.',
  });
});

const xlsx = require('xlsx');
const mysql = require('mysql2/promise');

exports.cargaMasivaProductos = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      status: 'fail',
      message: 'Debe subir un archivo Excel (.xlsx o .xls)',
    });
  }

  const { id_configuracion } = req.body;

  // Leer el archivo directamente desde memoria (buffer)
  const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

  if (!data.length) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'El archivo Excel está vacío.' });
  }

  const resultados = [];

  // Usar la instancia db ya configurada
  for (const [index, row] of data.entries()) {
    try {
      const { nombre, descripcion, tipo, precio, duracion, stock } = row;

      if (!id_configuracion || !nombre || !tipo || !precio) {
        resultados.push({ index, error: 'Faltan campos obligatorios' });
        continue;
      }

      // Usamos db.query para hacer la inserción de los productos
      await db.query(
        `
        INSERT INTO productos_chat_center (
          id_configuracion, nombre, descripcion, tipo, precio, duracion, imagen_url,
          video_url, stock, eliminado, id_categoria, fecha_creacion, fecha_actualizacion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `,
        {
          replacements: [
            id_configuracion,
            nombre,
            descripcion || null,
            tipo,
            precio,
            duracion || 0,
            null, // Sin imagen_url
            null, // Sin video_url
            stock || 0,
            0, // Valor por defecto de eliminado
            null,
          ],
        },
      );

      resultados.push({ index, status: 'insertado' });
    } catch (error) {
      // Si hay error, lo agregamos al resultado
      resultados.push({ index, error: error.message });
    }
  }

  res.status(200).json({
    status: 'success',
    message: 'Carga masiva finalizada',
    resultados,
  });
});

// helpers
const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null ? '' : String(v));

exports.listarProductosDropi = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const payload = {
    pageSize: toInt(req.body?.pageSize) || 50,
    startData: toInt(req.body?.startData) ?? 0,
    no_count: req.body?.no_count === false ? false : true,
    order_by: str(req.body?.order_by || 'id'),
    order_type: str(req.body?.order_type || 'asc'),
    keywords: str(req.body?.keywords || ''),
  };

  const dropiResponse = await dropiService.listProductsIndex({
    integrationKey,
    payload,
    country_code: integration.country_code,
  });
  return res.json({ isSuccess: true, data: dropiResponse });
});

const DROPI_SOURCE = 'DROPI';

const buildDropiImageUrl = (galleryItem) => {
  if (!galleryItem) return null;

  // Si Dropi trae url absoluto
  if (galleryItem.url) return galleryItem.url;

  // Si trae urlS3 (ruta relativa)
  if (galleryItem.urlS3) {
    const base = process.env.DROPI_MEDIA_BASE_URL || '';
    if (base)
      return `${base.replace(/\/$/, '')}/${galleryItem.urlS3.replace(/^\//, '')}`;
    // fallback: guardar urlS3 tal cual
    return galleryItem.urlS3;
  }

  return null;
};

const sanitizeText = (html) => {
  if (!html) return '';
  const text = htmlToText(String(html), {
    wordwrap: false,
    // evita basura de links e imágenes
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  });

  // normalizar espacios/saltos
  return text
    .replace(/\u00A0/g, ' ') // nbsp
    .replace(/[ \t]+\n/g, '\n') // espacios antes de salto
    .replace(/\n{3,}/g, '\n\n') // demasiados saltos
    .trim();
};

async function getOrCreateCategoria({
  id_configuracion,
  nombre,
  descripcion = null,
}) {
  if (!nombre) return null;

  // 1) Buscar si existe
  let cat = await CategoriasChatCenter.findOne({
    where: { id_configuracion, nombre: String(nombre).trim() },
  });

  // 2) Crear si no existe
  if (!cat) {
    cat = await CategoriasChatCenter.create({
      id_configuracion,
      nombre: String(nombre).trim(),
      descripcion: descripcion || null,
    });
  }

  return cat;
}

exports.importarProductoDropi = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const dropi_product_id = toInt(req.body?.dropi_product_id);

  //por defecto = suggested_price
  const precio_override =
    req.body?.precio != null ? Number(req.body.precio) : null;

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!dropi_product_id)
    return next(new AppError('dropi_product_id es requerido', 400));

  // 1) evitar duplicado
  const existente = await ProductosChatCenter.findOne({
    where: {
      id_configuracion,
      external_source: DROPI_SOURCE,
      external_id: dropi_product_id,
      eliminado: 0,
    },
  });

  if (existente) {
    return res.status(200).json({
      status: 'success',
      alreadyImported: true,
      data: existente,
      message: 'Este producto de Dropi ya fue importado anteriormente.',
    });
  }

  // 2) obtener integración Dropi
  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  // 3) traer detalle del producto (FUENTE OFICIAL)
  const dropiDetail = await dropiService.getProductDetail({
    integrationKey,
    productId: dropi_product_id,
    country_code: integration.country_code,
  });

  const prod = dropiDetail?.objects;
  if (!prod)
    return next(
      new AppError('No se encontró el detalle del producto en Dropi', 404),
    );

  // 4) imágenes: en detalle viene como photos (según su ejemplo), pero en otros puede venir gallery.
  const photos = Array.isArray(prod.photos) ? prod.photos : [];
  const gallery = Array.isArray(prod.gallery) ? prod.gallery : [];
  const imgs = photos.length ? photos : gallery;

  const mainImg = imgs.find((g) => g.main) || imgs[0] || null;

  const imagen_url = buildDropiImageUrl(mainImg);

  // 5) precio: SIEMPRE suggested_price (salvo override)
  const precio_sugerido = Number(prod.suggested_price || 0);
  const precio_final = Number.isFinite(precio_override)
    ? precio_override
    : precio_sugerido;

  // 6) descripción: usar la del detalle
  const descripcion_final = sanitizeText(prod.description);

  // 7) categorías: crear si no existen y asignar una principal al producto
  const categoriasDropi = Array.isArray(prod.categories) ? prod.categories : [];

  let id_categoria_asignada = null;

  if (categoriasDropi.length) {
    // Si Dropi manda varias, tomamos la primera como principal.
    // (Luego usted puede extender su tabla productos para guardar múltiples si lo desea)
    const principal = categoriasDropi[0];
    const catCreada = await getOrCreateCategoria({
      id_configuracion,
      nombre: principal?.name,
      descripcion: null,
    });
    id_categoria_asignada = catCreada?.id || null;

    // Opcional: crear también las demás categorías aunque no se asignen
    for (let i = 1; i < categoriasDropi.length; i++) {
      await getOrCreateCategoria({
        id_configuracion,
        nombre: categoriasDropi[i]?.name,
        descripcion: null,
      });
    }
  }

  // 8) crear producto en su tabla
  const nuevo = await ProductosChatCenter.create({
    id_configuracion,
    nombre: prod.name || 'Producto Dropi',
    descripcion: descripcion_final,
    tipo: 'producto',
    precio: precio_final,
    duracion: 0,
    id_categoria: id_categoria_asignada,
    imagen_url,
    video_url: null,
    nombre_upsell: null,
    descripcion_upsell: null,
    precio_upsell: null,
    imagen_upsell_url: null,
    combos_producto: null,
    stock: 0,

    external_source: DROPI_SOURCE,
    external_id: dropi_product_id,
  });

  return res.status(201).json({
    status: 'success',
    data: nuevo,
    message:
      'Producto importado desde Dropi correctamente (detalle + categorías sincronizadas).',
  });
});
