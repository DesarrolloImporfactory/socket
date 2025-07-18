const jwt = require('jsonwebtoken');
require('dotenv').config();

// Generar JWT con id_usuario
const generarToken = (id_usuario) => {
  return jwt.sign({ id_usuario }, process.env.SECRET_JWT_SEED, {
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
