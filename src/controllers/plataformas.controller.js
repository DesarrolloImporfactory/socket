const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db_2 } = require('../database/config');
const Plataforma = require('../models/plataforma.model');
const Usuario_plataforma = require('../models/usuario_plataforma.model');

exports.getAllPlataformas = catchAsync(async (req, res, next) => {
  const plataformas = await db_2.query(`
      SELECT *
      FROM plataformas
  `);

  res.status(200).json({
    status: 'success',
    data: {
      plataformas,
    },
  });
});

exports.getPlataformaById = catchAsync(async (req, res, next) => {
  const { id_plataforma } = req.params;
  console.log(id_plataforma);
  /*
    const {id_plataforma} = req.body;
  */

  const plataforma = await db_2.query(
    'SELECT * FROM plataformas where id_plataforma = ?',
    {
      replacements: [id_plataforma],
      type: db_2.QueryTypes.SELECT,
    }
  );
  if (plataforma.length === 0) {
    return next(
      new AppError('No se encontro una plataforma con dicho ID_PLATAFORMA', 404)
    );
  }

  res.status(200).json({
    status: 'success',
    data: {
      plataforma,
    },
  });
});

exports.obtener_usuario_plataforma = catchAsync(async (req, res, next) => {
  try {
    const { id_plataforma } = req.body;

    /* validar si existe una configuracion con ese id_plataforma */
    const usuarios_plataforma = await Usuario_plataforma.findOne({
      where: { id_plataforma },
    });
    if (!usuarios_plataforma) {
      return res.status(400).json({
        status: 'fail',
        message: 'No existe ningun usuario con ese id_plataforma',
      });
    }

    let id_usuario = usuarios_plataforma.id_usuario;

    res.status(200).json({
      status: 'success',
      message: 'Usuario obtenido',
      data: { id_usuario: id_usuario },
    });
  } catch (err) {
    console.error('❌ Error al obtener el usuario:', err);
    return res.status(500).json({
      status: 'fail',
      message: 'Ocurrió un error inesperado durante la busqueda.',
    });
  }
});
