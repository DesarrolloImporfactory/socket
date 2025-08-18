const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

const restrictToPlanes = (planesPermitidos = []) => {
  return async (req, res, next) => {
    const subUsuario = req.sessionUser;

    if (!subUsuario) {
      return res.status(401).json({
        status: 'fail',
        message: 'No estás autenticado como subusuario',
      });
    }

    const id_plan = subUsuario.id_plan;

    if (!planesPermitidos.includes(id_plan)) {
      return res.status(403).json({
        status: 'fail',
        message: `Tu plan actual no tiene permisos para realizar esta acción.`,
      });
    }

    req.user = subUsuario;
    next();
  };
};

module.exports = restrictToPlanes;
