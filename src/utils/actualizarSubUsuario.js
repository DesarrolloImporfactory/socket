const bcrypt = require('bcrypt');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

const actualizarSubUsuario = async ({
  id_sub_usuario,
  usuario,
  password,
  email,
  nombre_encargado,
  rol,
}) => {
  if (!id_sub_usuario) {
    throw new Error('ID del subusuario es obligatorio');
  }

  const camposActualizar = {
    usuario,
    email,
    nombre_encargado,
    rol,
  };

  if (password && password.trim() !== '') {
    const hashPassword = await bcrypt.hash(password, 12);
    camposActualizar.password = hashPassword;
  }

  // Actualizar el registro
  await Sub_usuarios_chat_center.update(camposActualizar, {
    where: { id_sub_usuario },
  });

  // Obtener el registro actualizado
  const subUsuarioActualizado = await Sub_usuarios_chat_center.findByPk(
    id_sub_usuario
  );

  if (!subUsuarioActualizado) {
    throw new Error('Subusuario no encontrado luego de la actualización');
  }

  const {
    password: _,
    admin_pass,
    ...subUsuarioSinPassword
  } = subUsuarioActualizado.toJSON();

  return subUsuarioSinPassword;
};

module.exports = {
  actualizarSubUsuario,
};
