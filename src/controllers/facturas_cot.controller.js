const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const FacturasCot = require('../models/facturas_cot.model');

// controllers/detalle_fact_cotController.js
exports.validarDevolucion = catchAsync(async (req, res, next) => {
  const { telefono } = req.body;

  try {
    const sql = `SELECT * FROM facturas_cot 
    WHERE telefono = '${telefono}'
    AND (
      (estado_guia_sistema BETWEEN 500 AND 502 AND id_transporte = 2)
      OR (estado_guia_sistema IN (9) AND id_transporte = 2)
      OR (estado_guia_sistema IN (9) AND id_transporte = 4)
      OR (estado_guia_sistema IN (8, 9, 13) AND id_transporte = 3)
    )
    LIMIT 1`;

    const rows = await db.query(sql, { type: db.QueryTypes.SELECT });

    const existe = rows.length > 0;

    res.status(200).json({
      status: '200',
      success: existe,
    });
  } catch (error) {
    console.error('Error en validarDevolucion:', error);
    return next(new AppError('Error al consultar devoluciones', 500));
  }
});
