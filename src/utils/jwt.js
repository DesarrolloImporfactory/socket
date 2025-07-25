const jwt = require('jsonwebtoken');
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
require('dotenv').config();

// Generar JWT con id_usuario
const generarToken = async (id_sub_usuario) => {
  const subUsuario = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);

  if (!subUsuario) {
    throw new Error('Subusuario no encontrado');
  }

  // Buscar el usuario principal asociado
  const usuario = await Usuarios_chat_center.findByPk(subUsuario.id_usuario);

  if (!usuario) {
    throw new Error('Usuario principal no encontrado');
  }

  const payload = {
    id_sub_usuario,
    id_usuario: subUsuario.id_usuario,
    nombre: usuario.nombre,
    subusuarios_adicionales: usuario.subusuarios_adicionales,
    conexiones_adicionales: usuario.conexiones_adicionales,
    id_plan: usuario.id_plan,
    rol: subUsuario.rol,
    estado: usuario.estado,
  };

  console.log('Payload del token:', payload);

  return jwt.sign(payload, process.env.SECRET_JWT_SEED, {
    expiresIn: '7d',
  });
};

// Verificar token
const verificarToken = (token) => {
  try {
    return jwt.verify(token, process.env.SECRET_JWT_SEED);
  } catch (error) {
    return null;
  }
};

// Extraer token del header Authorization: Bearer token
const extraerTokenDeCabecera = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  return null;
};

module.exports = {
  generarToken,
  verificarToken,
  extraerTokenDeCabecera,
};
