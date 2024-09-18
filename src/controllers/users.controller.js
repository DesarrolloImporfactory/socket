const User = require('../models/user.model');
const catchAsync = require('../utils/catchAsync');
exports.findAllUsers = catchAsync(async (req, res, next) => {
  const users = await User.findAll();

  res.status(200).json({
    status: 'success',
    results: users.length,
    users,
  });
});

exports.findOneUser = catchAsync(async (req, res, next) => {
  const { user } = req;

  res.status(200).json({
    status: 'success',
    user: {
      nombre: user.nombre_users,
      usuario: user.usuario_users,
      email: user.email_users,
    },
  });
});
