const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const Configuraciones = require('../models/configuraciones.model');
const CategoriasChatCenter = require('../models/categorias_chat_center.model');

exports.listarCategorias = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;

  const categorias_chat_center = await CategoriasChatCenter.findAll({
    where: { id_configuracion: id_configuracion },
  });

  if (!categorias_chat_center || categorias_chat_center.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen categorías para esta configuración.',
    });
  }

  res.status(200).json({
    status: 'success',
    data: categorias_chat_center,
  });
});

exports.agregarCategoria = catchAsync(async (req, res, next) => {
  const { id_configuracion, descripcion } = req.body;
  const nombre = String(req.body?.nombre || '').trim();

  // Ahora este endpoint se consume desde dos lados (la vista de Categorías y
  // el modal de producto), así que valida acá y no en cada formulario.
  if (!id_configuracion)
    return next(new AppError('Falta id_configuracion', 400));
  if (!nombre) return next(new AppError('El nombre es obligatorio', 400));

  /* Duplicados: la categoría alimenta el catálogo del asistente, y dos filas
     con el mismo nombre lo dejan eligiendo entre categorías idénticas. Si ya
     existe se devuelve la que hay en vez de crear otra. */
  const existente = await CategoriasChatCenter.findOne({
    where: { id_configuracion, nombre },
  });
  if (existente) {
    return res.status(200).json({
      status: 'success',
      data: existente,
      yaExistia: true,
    });
  }

  const nuevaCategoria = await CategoriasChatCenter.create({
    id_configuracion,
    nombre,
    descripcion,
  });

  res.status(201).json({
    status: 'success',
    data: nuevaCategoria,
  });
});

exports.actualizarCategoria = catchAsync(async (req, res, next) => {
  const { id_categoria, nombre, descripcion } = req.body;

  const categoria = await CategoriasChatCenter.findOne({
    where: { id: id_categoria },
  });

  if (!categoria) {
    return res.status(404).json({
      status: 'fail',
      message: 'Categoría no encontrada.',
    });
  }

  categoria.nombre = nombre || categoria.nombre;
  categoria.descripcion = descripcion || categoria.descripcion;
  categoria.fecha_actualizacion = new Date();

  await categoria.save();

  res.status(200).json({
    status: 'success',
    data: categoria,
  });
});

exports.eliminarCategoria = catchAsync(async (req, res, next) => {
  const { id_categoria } = req.body;

  const categoria = await CategoriasChatCenter.findOne({
    where: { id: id_categoria },
  });

  if (!categoria) {
    return res.status(404).json({
      status: 'fail',
      message: 'Categoría no encontrada.',
    });
  }

  await categoria.destroy();

  res.status(200).json({
    status: 'success',
    message: 'Categoría eliminada correctamente.',
  });
});
