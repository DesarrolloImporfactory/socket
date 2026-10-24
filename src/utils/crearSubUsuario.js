const bcrypt = require('bcrypt');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const AppError = require('./appError');
const { ROL_EQUIPO, puedeTenerRolEquipo } = require('./rolEquipo');

// El rol «equipo» solo en las cuentas autorizadas (utils/rolEquipo.js).
function revisarRolEquipo(id_usuario, rol) {
  if (String(rol) === ROL_EQUIPO && !puedeTenerRolEquipo(id_usuario)) {
    throw new AppError('El rol «equipo» no está habilitado en esta cuenta.', 403);
  }
}

const crearSubUsuario = async (
  { id_usuario, usuario, password, email, nombre_encargado, rol },
  options = {}
) => {
  revisarRolEquipo(id_usuario, rol);
  const hashPassword = await bcrypt.hash(password, 12);

  const nuevoSubUsuario = await Sub_usuarios_chat_center.create(
    {
      id_usuario,
      usuario,
      password: hashPassword,
      email,
      nombre_encargado,
      rol,
    },
    options // <-- aquí viaja { transaction: t }
  );

  const {
    password: _,
    admin_pass,
    ...subUsuarioSinPassword
  } = nuevoSubUsuario.toJSON();

  return subUsuarioSinPassword;
};

module.exports = { crearSubUsuario };
