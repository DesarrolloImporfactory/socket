const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const EtiquetasAsignadas = require('../models/etiquetas_asignadas.model');
const EtiquetaService = require('../services/etiqueta.service');

exports.obtenerEtiquetasAsignadas = catchAsync(async (req, res, next) => {
  const id_cliente_chat_center = parseInt(req.body.id_cliente_chat_center, 10);

  if (!id_cliente_chat_center) {
    return next(new AppError('id_cliente_chat_center es requerido', 400));
  }

  const etiquetasAsignadas = await EtiquetaService.obtenerEtiquetasAsignadas(
    id_cliente_chat_center
  );

  res.status(200).json({
    status: '200',
    title: 'Petición exitosa',
    message: 'Etiquetas asignadas obtenidas correctamente',
    etiquetasAsignadas,
  });
});

exports.obtenerMultiples = catchAsync(async (req, res, next) => {
  const ids = req.body.ids;

  if (!Array.isArray(ids) || ids.length === 0) {
    return next(new AppError('ids es requerido y debe ser un array', 400));
  }

  // ====================================================
  // 1) OBTENER ASIGNACIONES LIGERAS (RÁPIDO POR ÍNDICES)
  // ====================================================
  const asignaciones = await EtiquetasAsignadas.findAll({
    where: {
      id_cliente_chat_center: { [Op.in]: ids },
    },
    attributes: ['id_cliente_chat_center', 'id_etiqueta'],
    raw: true,
  });

  // Crear estructura vacía para cada id solicitado
  const result = {};
  for (const id of ids) {
    result[id] = [];
  }

  // Si no hay asignaciones, retornar vacío
  if (asignaciones.length === 0) {
    return res.status(200).json({
      status: '200',
      message: 'Etiquetas cargadas correctamente',
      etiquetas: result,
    });
  }

  // ====================================================
  // 2) OBTENER SOLO LOS IDs ÚNICOS DE ETIQUETAS
  // ====================================================
  const uniqueEtiquetaIds = [
    ...new Set(asignaciones.map((a) => a.id_etiqueta)),
  ];

  // ====================================================
  // 3) CONSULTA DE ETIQUETAS UNA SOLA VEZ
  // ====================================================
  const etiquetas = await EtiquetasChatCenter.findAll({
    where: {
      id_etiqueta: { [Op.in]: uniqueEtiquetaIds },
    },
    attributes: ['id_etiqueta', 'nombre_etiqueta', 'color_etiqueta'],
    raw: true,
  });

  // Crear diccionario de etiquetas para acceso instantáneo
  const dictEtiquetas = Object.fromEntries(
    etiquetas.map((e) => [e.id_etiqueta, e])
  );

  // ====================================================
  // 4) ARMAR RESULTADO FINAL
  // ====================================================
  for (const row of asignaciones) {
    const etq = dictEtiquetas[row.id_etiqueta];
    if (etq) {
      result[row.id_cliente_chat_center].push({
        id_etiqueta: etq.id_etiqueta,
        nombre: etq.nombre_etiqueta,
        color: etq.color_etiqueta,
      });
    }
  }

  // ====================================================
  // RESPUESTA
  // ====================================================
  res.status(200).json({
    status: '200',
    message: 'Etiquetas cargadas correctamente',
    etiquetas: result,
  });
});
