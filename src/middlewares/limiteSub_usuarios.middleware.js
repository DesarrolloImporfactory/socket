const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Usuarios_chat_centerModel = require('../models/usuarios_chat_center.model');
const Planes_chat_centerModel = require('../models/planes_chat_center.model');

// Middleware para limitar el número de subusuarios adicionales
const limiteSub_usuarios = async (req, res, next) => {
  try {
    const subUsuarioSession = req.sessionUser;
    if (!subUsuarioSession) {
      return res.status(401).json({
        status: 'fail',
        message: 'No estás autenticado como subusuario',
      });
    }

    const subUsuarioDB = await Sub_usuarios_chat_center.findByPk(
      subUsuarioSession.id_sub_usuario
    );

    if (!subUsuarioDB) {
      return res.status(401).json({
        status: 'fail',
        message: 'No se encontró el subusuario en la base de datos',
      });
    }

    // Obtener el usuario propietario e incluir su plan
    const usuario = await Usuarios_chat_centerModel.findByPk(
      subUsuarioDB.id_usuario,
      {
        include: [{ model: Planes_chat_centerModel, as: 'plan' }],
      }
    );

    if (!usuario) {
      return res.status(404).json({
        status: 'fail',
        message: 'Usuario no encontrado',
      });
    }

    if (!usuario.plan) {
      return res.status(403).json({
        status: 'fail',
        message: 'El usuario no tiene plan asignado',
      });
    }

    // Cálculo de límites de subusuarios (max_subusuarios del plan + subusuarios_adicionales)
    const maxPorPlan = Number(usuario.plan.max_subusuarios || 0);
    const adicionales = Number(usuario.subusuarios_adicionales || 0);
    const totalPermitido = maxPorPlan + adicionales;

    // Conteo actual de subusuarios asociados al usuario
    const totalActual = await Sub_usuarios_chat_center.count({
      where: { id_usuario: usuario.id_usuario },
    });

    // Validación contra el límite de subusuarios
    if (totalActual >= totalPermitido) {
      return res.status(403).json({
        status: 'fail',
        code: 'QUOTA_EXCEEDED',
        message: `Has alcanzado el límite de subusuarios permitidos (${totalPermitido}).`,
        details: {
          maxPorPlan,
          adicionales,
          totalPermitido,
          totalActual,
        },
      });
    }

    // (Opcional) Dejar a mano datos útiles para el siguiente handler
    req.user = usuario;
    req.subUsuario = subUsuarioDB;

    return next();
  } catch (err) {
    console.error('Error en limiteSub_usuarios:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Error interno del servidor',
    });
  }
};

module.exports = limiteSub_usuarios;
