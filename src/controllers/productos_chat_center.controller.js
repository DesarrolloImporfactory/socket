const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const fs = require('fs');
const path = require('path');

const ProductosChatCenter = require('../models/productos_chat_center.model');

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

exports.agregarProducto = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, descripcion, tipo, precio, id_categoria } =
    req.body;

  // Define la URL base
  const dominio = 'https://chat.imporfactory.app';

  let imagen_url = null;
  if (req.file) {
    imagen_url = `${dominio}/uploads/productos/${req.file.filename}`;
  }

  // Validaciones mínimas
  if (!id_configuracion || !nombre || !tipo || !precio) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_configuracion, nombre, tipo y precio son obligatorios.',
    });
  }

  const nuevoProducto = await ProductosChatCenter.create({
    id_configuracion,
    nombre,
    descripcion,
    tipo,
    precio,
    imagen_url,
    id_categoria,
  });

  res.status(201).json({
    status: 'success',
    data: nuevoProducto,
  });
});

exports.actualizarProducto = catchAsync(async (req, res, next) => {
  const { id_producto, nombre, descripcion, tipo, precio, id_categoria } =
    req.body;

  const producto = await ProductosChatCenter.findByPk(id_producto);

  if (!producto) {
    return res.status(404).json({
      status: 'fail',
      message: 'Producto no encontrado.',
    });
  }

  // URL base del servidor
  const dominio = 'https://chat.imporfactory.app';

  let nuevaImagen = producto.imagen_url;

  if (req.file) {
    // Borrar imagen anterior si existe
    if (producto.imagen_url) {
      const rutaAnterior = path.join(
        __dirname,
        '..',
        'uploads',
        'productos',
        path.basename(producto.imagen_url)
      );
      if (fs.existsSync(rutaAnterior)) {
        fs.unlinkSync(rutaAnterior);
      }
    }

    // Construir URL completa
    nuevaImagen = `${dominio}/uploads/productos/${req.file.filename}`;
  }

  // Actualizar datos
  producto.nombre = nombre || producto.nombre;
  producto.descripcion = descripcion || producto.descripcion;
  producto.tipo = tipo || producto.tipo;
  producto.precio = precio || producto.precio;
  producto.id_categoria = id_categoria ?? producto.id_categoria;
  producto.imagen_url = nuevaImagen;
  producto.fecha_actualizacion = new Date();

  await producto.save();

  res.status(200).json({
    status: 'success',
    data: producto,
  });
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
