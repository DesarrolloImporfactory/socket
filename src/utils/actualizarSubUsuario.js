const bcrypt = require('bcrypt');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const AppError = require('./appError');
const { ROL_EQUIPO, normalizarRol, puedeTenerRolEquipo } = require('./rolEquipo');

// El rol «equipo» solo en las cuentas autorizadas (utils/rolEquipo.js).
function revisarRolEquipo(id_usuario, rol) {
  if (normalizarRol(rol) === ROL_EQUIPO && !puedeTenerRolEquipo(id_usuario)) {
    throw new AppError('El rol «equipo» no está habilitado en esta cuenta.', 403);
  }
}

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

  if (normalizarRol(rol) === ROL_EQUIPO) {
    const actual = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);
    revisarRolEquipo(actual?.id_usuario, rol);
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
