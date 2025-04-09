const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const Plataforma = require('../models/plataforma.model');

exports.getAllPlataformas = catchAsync(async (req, res, next) => {
  const plataformas = await db.query(`
      SELECT *
      FROM plataformas
  `);

  res.status(200).json({
    status: 'success',
    data: {
      plataformas
    }
  });

});

exports.getPlataformaById = catchAsync(async (req, res, next) => {
  const { id_plataforma } = req.params;
  console.log(id_plataforma)
  /*
    const {id_plataforma} = req.body;
  */

  const plataforma =await db.query("SELECT * FROM plataformas where id_plataforma = ?"
    , {
      replacements: [id_plataforma],
      type: db.QueryTypes.SELECT
    }
  );
  if (plataforma.length === 0) {
    return next(new AppError('No se encontro una plataforma con dicho ID_PLATAFORMA', 404));
  }

  res.status(200).json({
    status: 'success',
    data: {
      plataforma
    }
  });
});