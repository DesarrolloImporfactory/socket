const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/user.model');
const UsuarioPlataforma = require('../models/usuario_plataforma.model');
const Plataforma = require('../models/plataforma.model');
require('dotenv').config();

const generateJWT = async (id) => {
  const user = await User.findOne({ where: { id_users: id } });
  if (!user) return new Error('User not found');

  const platform = await UsuarioPlataforma.findOne({
    where: { id_usuario: id },
  });
  if (!platform) return new Error('Platform not found');

  const matriz = await Plataforma.findOne({
    where: { id_plataforma: platform.id_plataforma },
    attributes: ['id_matriz'],
  });
  if (!matriz) return new Error('Matriz not found');

  const issuedAt = Math.floor(Date.now() / 1000);
  const jwtId = uuidv4();

  return new Promise((resolve, reject) => {
    const payload = {
      iss: process.env.SERVER_NAME,
      aud: process.env.SERVER_NAME,
      iat: issuedAt,
      nbf: issuedAt,
      jti: jwtId,
      sub: user.email_users,
      data: {
        id: Number(user.id_users),
        nombre: user.nombre_users || '',
        cargo: user.cargo_users || '',
        correo: user.email_users,
        id_plataforma: platform.id_plataforma,
        validar_config_chat: true,
        sistema: user.sistema || '',
        id_matriz: matriz.id_matriz,
      },
    };

    jwt.sign(
      payload,
      process.env.SECRET_JWT_SEED,
      {
        expiresIn: process.env.JWT_EXPIRE_IN, // Debe ser '7d' en el .env
      },
      (err, token) => {
        if (err) {
          reject(err);
        } else {
          resolve(token);
        }
      }
    );
  });
};

module.exports = generateJWT;
