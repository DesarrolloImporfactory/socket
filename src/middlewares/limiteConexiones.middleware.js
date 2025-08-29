const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Usuarios_chat_centerModel = require('../models/usuarios_chat_center.model');
const Planes_chat_centerModel = require('../models/planes_chat_center.model');
const ConfiguracionesModel = require('../models/configuraciones.model');

const limiteConexiones = async (req, res, next) => {
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

    // Con el subusuario, obtener el usuario propietario e incluir su plan
    //    Ajuste "as: 'plan'" si su asociación usa otro alias.
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

    // Cálculo de límites (plan + adicionales)
    const maxPorPlan = Number(usuario.plan.max_conexiones || 0);
    const adicionales = Number(usuario.conexiones_adicionales || 0);
    const totalPermitido = maxPorPlan + adicionales;

    // Conteo actual de conexiones del usuario
    // middlewares/limiteConexiones.middleware.js
const totalActual = await ConfiguracionesModel.count({
  where: { id_usuario: usuario.id_usuario, suspendido: 0 }, 
});


    // Validación contra el tope
    if (totalActual >= totalPermitido) {
      return res.status(403).json({
        status: 'fail',
        code: 'QUOTA_EXCEEDED',
        message: `Has alcanzado el límite de conexiones permitidas (${totalPermitido}).`,
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
    console.error('Error en limiteConexiones:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Error interno del servidor',
    });
  }
};

module.exports = limiteConexiones;
