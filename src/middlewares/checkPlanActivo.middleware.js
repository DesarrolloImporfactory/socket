const Usuarios_chat_center = require('../models/usuarios_chat_center.model');

const checkPlanActivo = async (req, res, next) => {
  const subUsuario = req.sessionUser;

  const usuario = await Usuarios_chat_center.findByPk(subUsuario.id_usuario);
  if (!usuario) {
    return res.status(404).json({
      status: '404',
      message: 'Usuario no encontrado',
    });
  }

  const ahora = new Date();

  /* if (usuario.permanente == 0) {
    // Verificar si el plan está vencido
    if (usuario.fecha_renovacion && ahora > usuario.fecha_renovacion) {
      if (usuario.estado !== 'vencido') {
        await usuario.update({ estado: 'vencido' });
      }

      return res.status(402).json({
        status: 'fail',
        message: 'Tu plan ha caducado',
      });
    }

    // Verificar si está activo
    if (usuario.estado !== 'activo') {
      return res.status(403).json({
        status: 'fail',
        message: 'El plan del usuario está inactivo',
      });
    }
  } */

  next();
};

module.exports = checkPlanActivo;
