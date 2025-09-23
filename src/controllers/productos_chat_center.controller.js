const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const { db } = require('../database/config');

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

exports.listarProductosImporsuit = catchAsync(async (req, res, next) => {
  const { id_plataforma } = req.body;

  const productos = await db.query(
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
      type: db.QueryTypes.SELECT,
    }
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

  const imagen_url = imagenFile
    ? `${dominio}/uploads/productos/imagen/${imagenFile.filename}`
    : null;

  const video_url = videoFile
    ? `${dominio}/uploads/productos/video/${videoFile.filename}`
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
  } = req.body;

  const producto = await ProductosChatCenter.findByPk(id_producto);
  if (!producto) {
    return res
      .status(404)
      .json({ status: 'fail', message: 'Producto no encontrado.' });
  }

  const imagenFile = req.files?.imagen?.[0] || null;
  const videoFile = req.files?.video?.[0] || null;

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
          filename
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
          filename
        );
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      }
    } catch (_) {}
    producto.video_url = `${dominio}/uploads/productos/video/${videoFile.filename}`;
  }

  // Actualizar campos básicos (si vienen)
  if (typeof nombre !== 'undefined') producto.nombre = nombre;
  if (typeof descripcion !== 'undefined') producto.descripcion = descripcion;
  if (typeof tipo !== 'undefined') producto.tipo = tipo;
  if (typeof precio !== 'undefined') producto.precio = precio;
  if (typeof precio !== 'undefined') producto.duracion = duracion;
  if (typeof id_categoria !== 'undefined') producto.id_categoria = id_categoria;
  producto.fecha_actualizacion = new Date();

  await producto.save();

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
      const {
        nombre,
        descripcion,
        tipo,
        precio,
        duracion,
        stock,
      } = row;

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
        }
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
