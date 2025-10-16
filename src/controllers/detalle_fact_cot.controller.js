const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db_2 } = require('../database/config');
const DetalleFactCot = require('../models/detalle_fact_cot.model');

// controllers/detalle_fact_cotController.js
exports.actualizarDetallePedido = catchAsync(async (req, res, next) => {
  const { id_detalle, id_pedido, cantidad, precio, total } = req.body;

  try { 
    const [result] = await db_2.query(
      `UPDATE detalle_fact_cot SET cantidad = ?, precio_venta = ? WHERE id_detalle = ?`,
      {
        replacements: [cantidad, precio, id_detalle],
        type: db_2.QueryTypes.UPDATE,
      }
    );

    const [result2] = await db_2.query(
      `UPDATE facturas_cot SET monto_factura = ? WHERE id_factura = ?`,
      {
        replacements: [total, id_pedido],
        type: db_2.QueryTypes.UPDATE,
      }
    );

    // result en UPDATE devuelve un array (dependiendo de la DB puede ser el número de filas afectadas)
    res.status(200).json({
      status: '200',
      title: 'Petición exitosa',
      message: 'Detalle actualizado correctamente',
    });
  } catch (error) {
    return next(new AppError('Error al actualizar el detalle', 500));
  }
});
