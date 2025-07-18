const bcrypt = require('bcrypt');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

const crearSubUsuario = async ({
  id_usuario,
  usuario,
  password,
  email,
  nombre_encargado,
  rol,
}) => {
  const hashPassword = await bcrypt.hash(password, 12);

  const nuevoSubUsuario = await Sub_usuarios_chat_center.create({
    id_usuario,
    usuario,
    password: hashPassword,
    email,
    nombre_encargado,
    rol,
  });

  // Excluir password y admin_pass del resultado
  const {
    password: _,
    admin_pass,
    ...subUsuarioSinPassword
  } = nuevoSubUsuario.toJSON();

  return subUsuarioSinPassword;
};

module.exports = {
  crearSubUsuario,
};
