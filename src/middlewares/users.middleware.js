const User = require('../models/user.model');
const AppError = require('../utils/appError');

const catchAsync = require('../utils/catchAsync');

exports.validUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const user = await User.findOne({
    where: {
      id_users: id,
    },
  });
  if (!user) {
    return next(new AppError('User not found! 🧨', 404));
  }
  req.user = user;
  next();
});
