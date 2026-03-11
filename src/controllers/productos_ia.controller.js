const { Op } = require('sequelize');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const axios = require('axios');
const FormDataLib = require('form-data');

const ProductosIA = require('../models/productos_ia.model');
const GeneracionesIA = require('../models/generaciones_ia.model');
const EtapasLanding = require('../models/etapas_landing.model');

async function uploadPortadaToS3(fileBuffer, originalName) {
  try {
    const ext = originalName.split('.').pop() || 'png';
    const fileName = `productos-portada/portada-${Date.now()}.${ext}`;

    const FormDataLib = require('form-data');
    const axios = require('axios');

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

  // Conteo de generaciones por producto
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
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { nombre, descripcion, marca, moneda, precio_unitario, combos } =
    req.body;

  if (!nombre || !String(nombre).trim()) {
    return next(new AppError('El nombre del producto es requerido', 400));
  }

  const producto = await ProductosIA.create({
    id_usuario,
    id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    nombre: String(nombre).trim(),
    descripcion: descripcion ? String(descripcion).trim() : null,
    marca: marca ? String(marca).trim() : null,
    moneda: moneda || 'USD',
    precio_unitario: precio_unitario || null,
    combos: combos || null,
  });

  return res.status(201).json({ isSuccess: true, data: producto });
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTUALIZAR PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════

exports.actualizar_producto = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;

  const producto = await ProductosIA.findOne({ where: { id, id_usuario } });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  const updates = {};
  if (req.body.nombre !== undefined)
    updates.nombre = String(req.body.nombre).trim();
  if (req.body.descripcion !== undefined)
    updates.descripcion = req.body.descripcion;
  if (req.body.marca !== undefined) updates.marca = req.body.marca;
  if (req.body.moneda !== undefined) updates.moneda = req.body.moneda;
  if (req.body.precio_unitario !== undefined)
    updates.precio_unitario = req.body.precio_unitario;
  if (req.body.combos !== undefined) updates.combos = req.body.combos;
  if (req.body.imagen_portada !== undefined)
    updates.imagen_portada = req.body.imagen_portada;
  if (req.body.estado !== undefined) updates.estado = req.body.estado;

  await producto.update(updates);

  return res.json({ isSuccess: true, data: producto });
});

// ═══════════════════════════════════════════════════════════════════════════
// ELIMINAR PRODUCTO
// ═══════════════════════════════════════════════════════════════════════════

exports.eliminar_producto = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario)
    return next(new AppError('No se pudo identificar al usuario', 401));

  const { id } = req.params;

  const producto = await ProductosIA.findOne({ where: { id, id_usuario } });
  if (!producto) return next(new AppError('Producto no encontrado', 404));

  await producto.destroy();

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

  if (!image_url) return next(new AppError('image_url es requerido', 400));

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

  // Auto-set portada si no tiene
  if (!producto.imagen_portada && image_urls.length > 0) {
    await producto.update({ imagen_portada: image_urls[0] });
  }

  return res.json({
    isSuccess: true,
    message: `${updated} imagen${updated !== 1 ? 'es' : ''} asignada${updated !== 1 ? 's' : ''}`,
    updated_count: updated,
  });
});
