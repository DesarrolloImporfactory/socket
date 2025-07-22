const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const Configuraciones = require('../models/configuraciones.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

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
      new AppError('No se encontro una plataforma con dicho ID_PLATAFORMA', 400)
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

exports.listarConexiones = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;

  const configuraciones = await db.query(
    'SELECT id, nombre_configuracion, telefono, webhook_url, metodo_pago FROM configuraciones WHERE id_usuario = ?',
    {
      replacements: [id_usuario],
      type: db.QueryTypes.SELECT,
    }
  );
  if (!configuraciones || configuraciones.length === 0) {
    return next(
      new AppError('No se encontro una plataforma con dicho ID_PLATAFORMA', 400)
    );
  }

  res.status(200).json({
    status: 'success',
    data: configuraciones,
  });
});
