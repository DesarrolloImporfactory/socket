const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const Configuraciones = require('../models/configuraciones.model');

exports.obtener_template_transportadora = catchAsync(async (req, res, next) => {
  const { id_plataforma } = req.body;

  const [configuraciones] = await db.query(
    'SELECT template_generar_guia FROM configuraciones WHERE id_plataforma = ?',
    {
      replacements: [id_plataforma],
      type: db.QueryTypes.SELECT,
    }
  );
  if (configuraciones.length === 0) {
    return next(
      new AppError('No se encontro una plataforma con dicho ID_PLATAFORMA', 404)
    );
  }

  const template_generar_guia = configuraciones.template_generar_guia;

  res.status(200).json({
    status: 'success',
    data: {
      template: template_generar_guia,
    },
  });
});
