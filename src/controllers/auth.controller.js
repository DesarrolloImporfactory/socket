const User = require('../models/user.model');
const catchAsync = require('../utils/catchAsync');
const bcrypt = require('bcrypt');
const generateJWT = require('./../utils/jwt');
const AppError = require('../utils/appError');

const { ref, uploadBytes, getDownloadURL } = require('firebase/storage');
const { storage } = require('../utils/firebase');

exports.signup = catchAsync(async (req, res, next) => {
  const { nombre, usuario, con, email } = req.body;
  const salt = await bcrypt.genSalt(12);
  const encryptedPassword = await bcrypt.hash(con, salt);

  const user = await User.create({
    nombre_users: nombre,
    usuario_users: usuario,
    con_users: encryptedPassword,
    email_users: email,
    date_added: new Date(),
  });
  const token = await generateJWT(user.id);

  res.status(200).json({
    status: 'success',
    message: 'User created successfully!🎉',
    token,
    user: {
      id: user.id_users,
      nombre: user.nombre_users,
      usuario: user.usuario_users,
      email: user.email_users,
    },
  });
});

exports.login = catchAsync(async (req, res, next) => {
  const { email, con } = req.body;

  const user = await User.findOne({
    where: {
      email_users: email,
    },
  });

  if (!user) {
    return next(new AppError('User with that email not found!', 404));
  }
  if (!(await bcrypt.compare(con, user.password))) {
    return next(new AppError('Incorrect email/password!', 401));
  }

  const token = await generateJWT(user.id_users);

  res.status(200).json({
    status: 'success',
    token,
    user: {
      id: user.id_users,
      nombre: user.nombre_users,
      usuario: user.usuario_users,
      email: user.email_users,
    },
  });
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  const { user } = req;
  const { currentPassword, newPassword } = req.body;

  if (!(await bcrypt.compare(currentPassword, user.password))) {
    return next(new AppError('Current password is incorrect!', 401));
  }

  const salt = await bcrypt.genSalt(12);
  const encryptedPassword = await bcrypt.hash(newPassword, salt);

  await user.update({
    con_users: encryptedPassword,
  });

  res.status(200).json({
    status: 'success',
    message: 'Password updated successfully!🎉',
  });
});

exports.renew = catchAsync(async (req, res, next) => {
  const { id } = req.sessionUser;
  const user = await User.findOne({
    where: {
      id_users: id,
    },
  });
  if (!user) {
    return next(new AppError('User not found! 🧨', 404));
  }
  const token = await generateJWT(id);

  res.status(200).json({
    status: 'success',
    token,
    user: {
      id: user.id_users,
      nombre: user.nombre_users,
      usuario: user.usuario_users,
      email: user.email_users,
    },
  });
});
