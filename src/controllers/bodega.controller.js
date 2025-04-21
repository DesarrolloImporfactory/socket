const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const Bodega = require('../models/bodega.model');

// controllers/bodegaController.js
exports.obtener_nombre_bodega = catchAsync(async (req, res, next) => {
  const { id_bodega } = req.body;

  try {
    const [resultado] = await db.query(
      'SELECT nombre FROM bodega WHERE id = ?',
      {
        replacements: [id_bodega],
        type: db.QueryTypes.SELECT,
      }
    );

    if (!resultado) {
      return res.status(400).json({
        status: 400,
        message: 'No se encontró configuración para la plataforma',
      });
    }

    const nombre = resultado.nombre;

    res.status(200).json({
      status: 200,
      data: {
        nombre_bodega: nombre,
      },
    });
  } catch (error) {
    console.error('Error al obtener nombre de bodega:', error);
    return res.status(500).json({
      status: 500,
      message: 'Error al obtener el nombre de la bodega',
    });
  }
});
