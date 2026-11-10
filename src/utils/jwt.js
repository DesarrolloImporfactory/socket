const jwt = require('jsonwebtoken');
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
require('dotenv').config();

// Generar JWT con id_usuario
// opciones.expiresIn (por defecto 7 días) y opciones.extra (campos que se suman
// al payload, p. ej. origen) los usa la sesión larga de la extensión ImporKiller.
const generarToken = async (id_sub_usuario, opciones = {}) => {
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
    nombre_encargado: subUsuario.nombre_encargado,
    activar_cotizacion: subUsuario.activar_cotizacion,
    estado: usuario.estado,
    email_propietario: usuario.email_propietario,
    id_costumer: usuario.id_costumer,
    ...(opciones.extra || {}),
  };

  console.log('Payload del token:', payload);

  return jwt.sign(payload, process.env.SECRET_JWT_SEED, {
    expiresIn: opciones.expiresIn || '7d',
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
