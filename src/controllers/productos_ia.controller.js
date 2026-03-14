const { Op } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const axios = require('axios');
const FormDataLib = require('form-data');

const ProductosIA = require('../models/productos_ia.model');
const GeneracionesIA = require('../models/generaciones_ia.model');
const EtapasLanding = require('../models/etapas_landing.model');
const Configuraciones = require('../models/configuraciones.model');
const DropiIntegrations = require('../models/dropi_integrations.model');
const ProductosChatCenter = require('../models/productos_chat_center.model');
const dropiService = require('../services/dropi.service');
const { decryptToken } = require('../utils/cryptoToken');

async function uploadPortadaToS3(fileBuffer, originalName) {
  try {
    const ext = originalName.split('.').pop() || 'png';
    const fileName = `productos-portada/portada-${Date.now()}.${ext}`;

    const form = new FormDataLib();
    form.append('file', fileBuffer, {
      filename: fileName,
      contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    });

    const resp = await axios.post(
      'https://uploader.imporfactory.app/api/files/upload',
      form,
      {
        headers: form.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      },
    );

    if (
      resp.status >= 200 &&
      resp.status < 300 &&
      resp.data?.success &&
      resp.data?.data?.url
    ) {
      return resp.data.data.url;
    }
    return null;
  } catch (err) {
    console.error('[Productos] Portada upload error:', err.message);
    return null;
  }
}

exports.subir_portada = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;

  const producto = await ProductosIA.findOne({ where: { id, id_usuario } });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  if (!req.file) {
    return next(new AppError('Debes subir una imagen', 400));
  }

  const url = await uploadPortadaToS3(req.file.buffer, req.file.originalname);
  if (!url) {
    return next(new AppError('Error al subir la imagen', 500));
  }

  await producto.update({ imagen_portada: url });

  return res.json({ isSuccess: true, data: producto });
});

// ═══════════════════════════════════════════════════════════════════════════
// LISTAR PRODUCTOS
// ═══════════════════════════════════════════════════════════════════════════

exports.listar_productos = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const estado = req.query.estado || 'activo';

  const productos = await ProductosIA.findAll({
    where: { id_usuario, estado },
    order: [['updated_at', 'DESC']],
    attributes: [
      'id',
      'nombre',
      'descripcion',
      'imagen_portada',
      'marca',
      'moneda',
      'precio_unitario',
      'combos',
      'estado',
      'created_at',
      'updated_at',
    ],
  });

  const ids = productos.map((p) => p.id);
  let countsMap = {};

  if (ids.length > 0) {
    const counts = await GeneracionesIA.findAll({
      where: { id_producto: { [Op.in]: ids } },
      attributes: [
        'id_producto',
        [
          GeneracionesIA.sequelize.fn(
            'COUNT',
            GeneracionesIA.sequelize.col('id'),
          ),
          'total',
        ],
      ],
      group: ['id_producto'],
      raw: true,
    });
    counts.forEach((c) => {
      countsMap[c.id_producto] = parseInt(c.total, 10);
    });
  }

  const data = productos.map((p) => ({
    ...p.toJSON(),
    total_generaciones: countsMap[p.id] || 0,
  }));

  return res.json({ isSuccess: true, data });
});

// ═══════════════════════════════════════════════════════════════════════════
// OBTENER PRODUCTO + GENERACIONES
// ═══════════════════════════════════════════════════════════════════════════

exports.obtener_producto = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;

  const producto = await ProductosIA.findOne({
    where: { id, id_usuario },
  });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const { count, rows } = await GeneracionesIA.findAndCountAll({
    where: { id_usuario, id_producto: id },
    order: [['created_at', 'DESC']],
    limit,
    offset,
    attributes: [
      'id',
      'template_id',
      'id_etapa',
      'aspect_ratio',
      'description',
      'model',
      'image_url',
      'created_at',
    ],
    include: [
      {
        model: EtapasLanding,
        as: 'etapa',
        attributes: ['id', 'nombre', 'slug'],
        required: false,
      },
    ],
  });

  return res.json({
    isSuccess: true,
    producto: producto.toJSON(),
    generaciones: rows,
    pagination: { total: count, page, limit, pages: Math.ceil(count / limit) },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CREAR PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════

exports.crear_producto = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  const id_sub_usuario = req.sessionUser?.id_sub_usuario || null;

  const {
    nombre,
    descripcion,
    marca,
    moneda,
    idioma,
    precio_unitario,
    combos,
  } = req.body;

  if (!nombre || !String(nombre).trim()) {
    return next(new AppError('El nombre es requerido', 400));
  }

  // Parsear combos si viene como string
  let combosData = null;
  if (combos) {
    try {
      combosData = typeof combos === 'string' ? JSON.parse(combos) : combos;
      if (!Array.isArray(combosData)) combosData = null;
    } catch {
      combosData = null;
    }
  }

  const producto = await ProductosIA.create({
    id_usuario,
    id_sub_usuario,
    nombre: String(nombre).trim(),
    descripcion: descripcion ? String(descripcion).trim() : null,
    marca: marca ? String(marca).trim() : null,
    moneda: moneda ? String(moneda).trim() : 'USD',
    idioma: idioma ? String(idioma).trim() : 'es',
    precio_unitario: precio_unitario ? Number(precio_unitario) : null,
    combos: combosData,
    estado: 'activo',
  });

  return res.status(201).json({ isSuccess: true, data: producto });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTUALIZAR PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════

exports.actualizar_producto = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  const { id } = req.params;

  const producto = await ProductosIA.findOne({
    where: { id, id_usuario, estado: 'activo' },
  });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  const updates = {};

  if (req.body.nombre !== undefined)
    updates.nombre = String(req.body.nombre).trim();
  if (req.body.descripcion !== undefined)
    updates.descripcion = req.body.descripcion
      ? String(req.body.descripcion).trim()
      : null;
  if (req.body.marca !== undefined)
    updates.marca = req.body.marca ? String(req.body.marca).trim() : null;
  if (req.body.moneda !== undefined)
    updates.moneda = String(req.body.moneda).trim() || 'USD';
  if (req.body.idioma !== undefined)
    updates.idioma = String(req.body.idioma).trim() || 'es';
  if (req.body.precio_unitario !== undefined)
    updates.precio_unitario = req.body.precio_unitario
      ? Number(req.body.precio_unitario)
      : null;

  if (req.body.combos !== undefined) {
    let combosData = null;
    if (req.body.combos) {
      try {
        combosData =
          typeof req.body.combos === 'string'
            ? JSON.parse(req.body.combos)
            : req.body.combos;
        if (!Array.isArray(combosData)) combosData = null;
      } catch {
        combosData = null;
      }
    }
    updates.combos = combosData;
  }

  await producto.update(updates);

  return res.json({ isSuccess: true, data: producto });
});

// ═══════════════════════════════════════════════════════════════════════════
// ELIMINAR PRODUCTO — soft delete (estado = 'inactivo')
// ═══════════════════════════════════════════════════════════════════════════

exports.eliminar_producto = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;

  const producto = await ProductosIA.findOne({ where: { id, id_usuario } });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  await producto.update({ estado: 'inactivo' });

  return res.json({ isSuccess: true, message: 'Producto eliminado' });
});

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR PORTADA
// ═══════════════════════════════════════════════════════════════════════════

exports.asignar_portada = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;
  const { image_url } = req.body;

  if (!image_url && image_url !== null)
    return next(new AppError('image_url es requerido', 400));

  const producto = await ProductosIA.findOne({ where: { id, id_usuario } });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  await producto.update({ imagen_portada: image_url });

  return res.json({ isSuccess: true, data: producto });
});

// ═══════════════════════════════════════════════════════════════════════════
// ASIGNAR IMÁGENES DESDE GENERADOR PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════

exports.asignar_imagenes = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;
  const { image_urls } = req.body;

  if (!Array.isArray(image_urls) || image_urls.length === 0) {
    return next(new AppError('image_urls es requerido', 400));
  }

  const producto = await ProductosIA.findOne({ where: { id, id_usuario } });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  const [updated] = await GeneracionesIA.update(
    { id_producto: Number(id) },
    {
      where: {
        id_usuario,
        image_url: { [Op.in]: image_urls },
      },
    },
  );

  if (!producto.imagen_portada && image_urls.length > 0) {
    await producto.update({ imagen_portada: image_urls[0] });
  }

  return res.json({
    isSuccess: true,
    message: `${updated} imagen${updated !== 1 ? 'es' : ''} asignada${updated !== 1 ? 's' : ''}`,
    updated_count: updated,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LISTAR MIS NEGOCIOS (configuraciones del usuario)
// ═══════════════════════════════════════════════════════════════════════════

exports.listar_mis_negocios = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const configs = await Configuraciones.findAll({
    where: { id_usuario, suspendido: 0 },
    attributes: [
      'id',
      'nombre_configuracion',
      'telefono',
      'tipo_configuracion',
    ],
    order: [['id', 'ASC']],
  });

  return res.json({ isSuccess: true, data: configs });
});

// ═══════════════════════════════════════════════════════════════════════════
// LISTAR PRODUCTOS DROPI (para un negocio del usuario)
// ═══════════════════════════════════════════════════════════════════════════

exports.listar_dropi_productos = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const id_configuracion = Number(req.body?.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  // Verificar que la config pertenece al usuario
  const config = await Configuraciones.findOne({
    where: { id: id_configuracion, id_usuario, suspendido: 0 },
    attributes: ['id'],
  });
  if (!config)
    return next(new AppError('Negocio no encontrado o sin acceso', 404));

  const integration = await DropiIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
  if (!integration)
    return next(
      new AppError('Este negocio no tiene integración Dropi activa', 404),
    );

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const payload = {
    pageSize: Number(req.body?.pageSize) || 50,
    startData: Number(req.body?.startData) ?? 0,
    no_count: true,
    order_by: req.body?.order_by || 'id',
    order_type: req.body?.order_type || 'desc',
    keywords: req.body?.keywords || '',
  };

  const dropiResponse = await dropiService.listProductsIndex({
    integrationKey,
    payload,
    country_code: integration.country_code,
  });

  return res.json({ isSuccess: true, data: dropiResponse });
});

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTAR PRODUCTO DESDE DROPI → productos_ia
// ═══════════════════════════════════════════════════════════════════════════

const buildDropiImageUrl = (galleryItem) => {
  if (!galleryItem) return null;
  if (galleryItem.url) return galleryItem.url;
  if (galleryItem.urlS3) {
    const base = 'https://d39ru7awumhhs2.cloudfront.net';
    return `${base.replace(/\/$/, '')}/${galleryItem.urlS3.replace(/^\//, '')}`;
  }
  return null;
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: busca integración activa por config O por usuario
// ═══════════════════════════════════════════════════════════════════════════

async function findDropiIntegration({ id_configuracion, id_usuario }) {
  if (id_configuracion) {
    return DropiIntegrations.findOne({
      where: { id_configuracion, deleted_at: null, is_active: 1 },
      order: [['id', 'DESC']],
    });
  }
  if (id_usuario) {
    return DropiIntegrations.findOne({
      where: { id_usuario, deleted_at: null, is_active: 1 },
      order: [['id', 'DESC']],
    });
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// LISTAR PRODUCTOS DROPI
// ═══════════════════════════════════════════════════════════════════════════

exports.listar_dropi_productos = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const id_configuracion = Number(req.body?.id_configuracion || 0) || null;

  // Si viene id_configuracion → verificar que pertenece al usuario
  if (id_configuracion) {
    const config = await Configuraciones.findOne({
      where: { id: id_configuracion, id_usuario, suspendido: 0 },
      attributes: ['id'],
    });
    if (!config)
      return next(new AppError('Negocio no encontrado o sin acceso', 404));
  }

  // Buscar integración por config o por usuario directo
  const integration = await findDropiIntegration({
    id_configuracion,
    id_usuario,
  });
  if (!integration)
    return next(new AppError('No tienes una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const payload = {
    pageSize: Number(req.body?.pageSize) || 50,
    startData: Number(req.body?.startData) ?? 0,
    no_count: true,
    order_by: req.body?.order_by || 'id',
    order_type: req.body?.order_type || 'asc',
    keywords: req.body?.keywords || '',
  };

  const dropiResponse = await dropiService.listProductsIndex({
    integrationKey,
    payload,
    country_code: integration.country_code,
  });

  return res.json({ isSuccess: true, data: dropiResponse });
});

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTAR PRODUCTO DESDE DROPI → productos_ia
// ═══════════════════════════════════════════════════════════════════════════

exports.importar_desde_dropi = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const id_configuracion = Number(req.body?.id_configuracion || 0) || null;
  const dropi_product_id = Number(req.body?.dropi_product_id || 0);

  if (!dropi_product_id)
    return next(new AppError('dropi_product_id es requerido', 400));

  // Si viene id_configuracion → verificar que pertenece al usuario
  if (id_configuracion) {
    const config = await Configuraciones.findOne({
      where: { id: id_configuracion, id_usuario, suspendido: 0 },
      attributes: ['id'],
    });
    if (!config)
      return next(new AppError('Negocio no encontrado o sin acceso', 404));
  }

  // Buscar integración por config o por usuario directo
  const integration = await findDropiIntegration({
    id_configuracion,
    id_usuario,
  });
  if (!integration)
    return next(new AppError('No tienes una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  // Traer detalle del producto
  const dropiDetail = await dropiService.getProductDetail({
    integrationKey,
    productId: dropi_product_id,
    country_code: integration.country_code,
  });

  const prod = dropiDetail?.objects;
  if (!prod)
    return next(new AppError('No se encontró el producto en Dropi', 404));

  // Imagen principal
  const photos = Array.isArray(prod.photos) ? prod.photos : [];
  const gallery = Array.isArray(prod.gallery) ? prod.gallery : [];
  const imgs = photos.length ? photos : gallery;
  const mainImg = imgs.find((g) => g.main) || imgs[0] || null;
  const imagen_portada = buildDropiImageUrl(mainImg);

  const precio_unitario = Number(prod.suggested_price || 0) || null;
  const precio_proveedor = Number(prod.sale_price || 0) || null;

  const getDropiTotalStock = (product) => {
    if (!Array.isArray(product?.warehouse_product)) return 0;
    return product.warehouse_product.reduce(
      (acc, wp) => acc + (Number(wp?.stock) || 0),
      0,
    );
  };

  const nuevo = await ProductosIA.create({
    id_usuario,
    id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    nombre: prod.name || 'Producto Dropi',
    descripcion: prod.description
      ? String(prod.description)
          .replace(/<[^>]*>/g, '')
          .trim()
      : null,
    marca: null,
    moneda: 'USD',
    precio_unitario,
    precio_proveedor,
    imagen_portada,
    estado: 'activo',
    external_source: 'DROPI',
    external_id: dropi_product_id,
    stock: getDropiTotalStock(prod),
  });

  return res.status(201).json({
    isSuccess: true,
    data: nuevo,
    message: 'Producto importado desde Dropi correctamente',
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ALIMENTAR NEGOCIO CON IA
// Copia un producto de productos_ia → productos_chat_center
// ═══════════════════════════════════════════════════════════════════════════

exports.alimentar_negocio = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;
  const id_configuracion = Number(req.body?.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const producto = await ProductosIA.findOne({
    where: { id, id_usuario, estado: 'activo' },
  });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  const config = await Configuraciones.findOne({
    where: { id: id_configuracion, id_usuario, suspendido: 0 },
    attributes: ['id'],
  });
  if (!config)
    return next(new AppError('Negocio no encontrado o sin acceso', 404));

  const vieneDropi =
    producto.external_source === 'DROPI' && producto.external_id;

  // ── Verificar duplicado ──
  // Para Dropi: por external_source='DROPI' + external_id (el ID real de Dropi)
  // Para InstaLanding: por external_source='INSTA_LANDING' + external_id (el ID de productos_ia)
  const whereExistente = {
    id_configuracion,
    eliminado: 0,
    external_source: vieneDropi ? 'DROPI' : 'INSTA_LANDING',
    external_id: vieneDropi ? producto.external_id : Number(id),
  };

  const existente = await ProductosChatCenter.findOne({
    where: whereExistente,
  });
  if (existente) {
    return res.json({
      isSuccess: true,
      alreadyExists: true,
      data: existente,
      message: 'Este producto ya fue exportado a este negocio anteriormente.',
    });
  }

  // ── Crear en productos_chat_center ──
  const nuevo = await ProductosChatCenter.create({
    id_configuracion,
    nombre: producto.nombre,
    descripcion: producto.descripcion || null,
    tipo: 'producto',
    precio: producto.precio_unitario || 0,
    precio_proveedor: producto.precio_proveedor || 0,
    duracion: 0,
    imagen_url: producto.imagen_portada || null,
    video_url: null,
    landing_url: null,
    eliminado: 0,

    // Stock: si vino de Dropi trae el real, sino 0
    stock: vieneDropi ? producto.stock || 0 : 0,

    // Combos: si el producto tiene combos definidos
    combos_producto: producto.combos?.length
      ? JSON.stringify(producto.combos)
      : null,

    // Origen: diferenciamos Dropi puro de InstaLanding
    external_source: vieneDropi ? 'DROPI' : 'INSTA_LANDING',

    // external_id:
    // - Dropi: el ID real del producto en Dropi
    // - InstaLanding: el ID en productos_ia (para deduplicación futura)
    external_id: vieneDropi ? producto.external_id : Number(id),
  });

  return res.status(201).json({
    isSuccess: true,
    data: nuevo,
    message: `Producto exportado al negocio${vieneDropi ? ' (origen Dropi)' : ''} correctamente`,
  });
});
