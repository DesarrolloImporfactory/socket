const User = require('../models/user.model');
const catchAsync = require('../utils/catchAsync');
const bcrypt = require('bcryptjs');
const { generarToken } = require('./../utils/jwt');
const { crearSubUsuario } = require('./../utils/crearSubUsuario');
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const { Op } = require('sequelize');
const AppError = require('../utils/appError');
const jwt = require('jsonwebtoken');
const { db } = require('../database/config');

exports.registrarUsuario = catchAsync(async (req, res, next) => {
  const { nombre, usuario, password, email, nombre_encargado } = req.body;

  // Validar campos obligatorios
  if (!nombre || !usuario || !password || !email || !nombre_encargado) {
    return res.status(400).json({
      status: 'fail',
      message: 'Todos los campos son obligatorios',
    });
  }

  // Validar existencia de nombre de usuario principal
  const existeUsuario = await Usuarios_chat_center.findOne({
    where: { nombre },
  });
  if (existeUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'Ya existe un usuario con ese nombre',
    });
  }

  // Validar usuario o email de subusuario
  const existeSubUsuario = await Sub_usuarios_chat_center.findOne({
    where: {
      [Op.or]: [{ usuario }, { email }],
    },
  });
  if (existeSubUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El usuario o el email ya están en uso',
    });
  }

  // Crear usuario principal
  const nuevoUsuario = await Usuarios_chat_center.create({ nombre });

  // Crear subusuario administrador
  const nuevoSubUsuario = await crearSubUsuario({
    id_usuario: nuevoUsuario.id_usuario,
    usuario,
    password: password,
    email,
    nombre_encargado,
    rol: 'administrador',
  });

  // Generar token JWT
  const token = await generarToken(nuevoSubUsuario.id_sub_usuario);

  res.status(201).json({
    status: 'success',
    message: 'Cuenta y usuario administrador creados correctamente 🎉',
    token,
    user: {
      id_usuario: nuevoUsuario.id_usuario,
      nombre: nuevoUsuario.nombre,
      administrador: nuevoSubUsuario,
    },
  });
});

exports.login = catchAsync(async (req, res, next) => {
  const { usuario, password } = req.body;

  // Buscar por usuario o email
  const usuarioEncontrado = await Sub_usuarios_chat_center.findOne({
    where: {
      [Op.or]: [{ usuario }, { email: usuario }],
    },
  });

  if (!usuarioEncontrado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  // Verificar password principal o admin_pass
  let autenticado = await bcrypt.compare(password, usuarioEncontrado.password);

  if (!autenticado && usuarioEncontrado.admin_pass) {
    autenticado = await bcrypt.compare(password, usuarioEncontrado.admin_pass);
  }

  if (!autenticado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  // Generar token
  const token = await generarToken(usuarioEncontrado.id_sub_usuario);

  // Eliminar campos sensibles
  const usuarioPlano = usuarioEncontrado.toJSON();
  const { password: _, admin_pass, ...usuarioSinPassword } = usuarioPlano;

  res.status(200).json({
    status: 'success',
    message: 'Login exitoso',
    token,
    data: usuarioSinPassword,
  });
});

exports.validar_usuario_imporsuit = catchAsync(async (req, res, next) => {
  const { usuario, password, id_configuracion } = req.body;

  // Buscar por usuario o email
  const [usuarioEncontrado] = await db.query(
    `SELECT p.id_plataforma, u.id_users, u.nombre_users, u.usuario_users, u.email_users, u.con_users, u.admin_pass FROM users u
      INNER JOIN usuario_plataforma up ON u.id_users = up.id_usuario
      INNER JOIN plataformas p ON p.id_plataforma = up.id_plataforma
       WHERE u.usuario_users = ?
       LIMIT 1`,
    {
      replacements: [usuario],
      type: db.QueryTypes.SELECT,
    }
  );

  if (!usuarioEncontrado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  // Verificar password principal o admin_pass
  let autenticado = await bcrypt.compare(password, usuarioEncontrado.con_users);

  if (!autenticado && usuarioEncontrado.admin_pass) {
    autenticado = await bcrypt.compare(password, usuarioEncontrado.admin_pass);
  }

  if (!autenticado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  await Configuraciones.update(
    {
      id_plataforma: usuarioEncontrado.id_plataforma,
    },
    {
      where: {
        id: id_configuracion,
      },
    }
  );

  res.status(200).json({
    status: 'success',
    message: 'Vinculacion exitosa',
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
    // Buscar configuración para obtener el id_usuario (dueño de la tienda)
    const configuracion = await Configuraciones.findOne({
      where: { id_plataforma: tienda },
    });

    if (!configuracion || !configuracion.id_usuario) {
      return res.status(404).json({
        message: 'Configuración no encontrada para esta tienda',
      });
    }

    // Buscar subusuario administrador asociado al id_usuario
    const usuarioEncontrado = await Sub_usuarios_chat_center.findOne({
      where: {
        id_usuario: configuracion.id_usuario,
        rol: 'administrador', // Asegúrate de que este valor exista así en tu BD
      },
    });

    if (!usuarioEncontrado) {
      return res.status(404).json({
        message: 'Usuario administrador no encontrado para esta tienda',
      });
    }

    // Generar token de sesión
    const sessionToken = await generarToken(usuarioEncontrado.id_sub_usuario);

    // Eliminar campos sensibles
    const usuarioPlano = usuarioEncontrado.toJSON();
    const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

    // Respuesta
    res.status(200).json({
      status: 'success',
      token: sessionToken,
      user: usuarioSinPassword,
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
  const token = await generarToken(id_users);

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
