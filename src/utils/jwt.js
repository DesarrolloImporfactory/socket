const jwt = require('jsonwebtoken');
const User = require('../models/user.model');
const UsuarioPlataforma = require('../models/usuario_plataforma.model');
require('dotenv').config();

const generateJWT = async (id) => {
  //buscar correo en la base de datos
  const user = await User.findOne({
    where: {
      id_users: id,
    },
  });
  if (!user) {
    return new Error('User not found');
  }
  //buscar plataforma que corresponda al usuario
  const platform = await UsuarioPlataforma.findOne({
    where: {
      id_usuario: id,
    },
  });
  if (!platform) {
    return new Error('Platform not found');
  }

  console.log(platform);

  return new Promise((resolve, reject) => {
    const payload = {
      id,
      plataforma: platform.id_plataforma,
      nombre: user.nombre_users,
      correo: user.email_users,
      cargo: user.cargo_users,
    };
    jwt.sign(
      payload,
      process.env.SECRET_JWT_SEED,
      {
        expiresIn: process.env.JWT_EXPIRE_IN,
      },
      (err, token) => {
        if (err) {
          reject(err);
        }

        resolve(token);
      }
    );
  });
};

module.exports = generateJWT;
