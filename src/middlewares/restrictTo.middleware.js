const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

const restrictToRoles = (...rolesPermitidos) => {
  return async (req, res, next) => {
    const subUsuario = req.sessionUser;

    if (!subUsuario) {
      return res.status(401).json({
        status: 'fail',
        message: 'No estás autenticado como subusuario',
      });
    }

    const usuarioDB = await Sub_usuarios_chat_center.findByPk(
      subUsuario.id_sub_usuario
    );

    if (!usuarioDB || !rolesPermitidos.includes(usuarioDB.rol)) {
      return res.status(403).json({
        status: 'fail',
        message: 'No tienes permisos para realizar esta acción',
      });
    }

    req.user = usuarioDB; // Guardamos el usuario con rol para reutilizar si hace falta

    next();
  };
};

module.exports = restrictToRoles;
