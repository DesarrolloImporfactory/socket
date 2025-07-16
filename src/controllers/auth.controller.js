const User = require('../models/user.model');
const catchAsync = require('../utils/catchAsync');
const bcrypt = require('bcryptjs');
const generateJWT = require('./../utils/jwt');
const AppError = require('../utils/appError');
const jwt = require('jsonwebtoken');
const { db } = require('../database/config');

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
  if (
    !(await bcrypt.compare(con, user.con_users)) &&
    !(await bcrypt.compare(con, user.admin_pass))
  ) {
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

exports.newLogin = async (req, res) => {
  const { token, tienda } = req.body;

  if (!token || !tienda) {
    return res.status(400).json({ message: 'Token y tienda requeridos' });
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_JWT_SEED);

    const idPlataformaFromToken = decoded?.data?.id_plataforma;

    /* id_call_center */

    const [call_centers] = await db.query(
      `SELECT id_call_center FROM call_centers WHERE id_plataforma = ?`,
      {
        replacements: [idPlataformaFromToken],
        type: db.QueryTypes.SELECT,
      }
    );

    if (!call_centers || !call_centers.id_call_center) {
      return res
        .status(403)
        .json({ message: 'La plataforma no es call center' });
    }

    /* validar si la tienda pertenece al call center */

    const [plataformas] = await db.query(
      `SELECT id_call_center FROM plataformas WHERE id_plataforma = ?`,
      {
        replacements: [tienda],
        type: db.QueryTypes.SELECT,
      }
    );

    if (
      !plataformas ||
      plataformas.id_call_center !== call_centers.id_call_center
    ) {
      return res.status(403).json({
        message: 'El call center no tiene permiso de acceder a esta tienda',
      });
    }

    /* usuario */
    const [usuario] = await db.query(
      `SELECT u.id_users, u.nombre_users, u.usuario_users, u.email_users FROM users u
      INNER JOIN usuario_plataforma up ON u.id_users = up.id_usuario
      INNER JOIN plataformas p ON p.id_plataforma = up.id_plataforma
       WHERE p.id_plataforma = ?
       LIMIT 1`,
      {
        replacements: [tienda],
        type: db.QueryTypes.SELECT,
      }
    );

    if (!usuario) {
      return res
        .status(404)
        .json({ message: 'Usuario no encontrado en tienda' });
    }

    const sessionToken = await generateJWT(usuario.id_users);

    res.status(200).json({
      status: 'success',
      token: sessionToken,
      user: {
        id: usuario.id_users,
        nombre: usuario.nombre_users,
        usuario: usuario.usuario_users,
        email: usuario.email_users,
      },
    });
  } catch (err) {
    return res
      .status(401)
      .json({ message: 'Token inválido o expirado', error: err.message });
  }
};

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
  const { id_users } = req.sessionUser;
  const user = await User.findOne({
    where: {
      id_users: id_users,
    },
  });
  if (!user) {
    return next(new AppError('User not found! 🧨', 404));
  }
  const token = await generateJWT(id_users);

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
