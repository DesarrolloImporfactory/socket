const ChatService = require('../services/chat.service');
const catchAsync = require('../utils/catchAsync');

/**
 * GET /api/v1/chat/ciudad-provincia/:id
 * Devuelve { ciudad, provincia } para un id_cotizacion
 */
exports.obtenerCiudadProvincia = catchAsync(async (req, res, next) => {
    const { id } = req.params;              // id viene como string
    const data   = await ChatService.obtenerCiudadProvincia(id);
  
    if (!data) return res.status(404).json({
      success: false,
      message: 'No se encontró la ciudad/provincia solicitada.',
    });
  
    res.status(200).json({ success: true, data });
  });