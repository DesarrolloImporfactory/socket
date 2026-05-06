const Comunidad_chat_center = require('../models/comunidad_chat_center.model');
const catchAsync = require('../utils/catchAsync');
const { Op } = require('sequelize');

// GET /api/comunidades?q=...  — público, solo lectura
exports.listarComunidades = catchAsync(async (req, res) => {
  const { q } = req.query;

  const where = { activo: 1 };
  if (q && q.trim()) {
    where.nombre = { [Op.like]: `%${q.trim()}%` };
  }

  const comunidades = await Comunidad_chat_center.findAll({
    where,
    attributes: ['id_comunidad', 'nombre', 'slug'],
    order: [['nombre', 'ASC']],
    limit: 100,
  });

  return res.status(200).json({
    status: 'success',
    data: comunidades,
  });
});
