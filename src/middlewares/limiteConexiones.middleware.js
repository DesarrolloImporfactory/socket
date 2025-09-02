// middlewares/limiteConexiones.middleware.js
const Sub_usuarios_chat_center   = require('../models/sub_usuarios_chat_center.model');
const Usuarios_chat_centerModel  = require('../models/usuarios_chat_center.model');
const Planes_chat_centerModel    = require('../models/planes_chat_center.model');
const ConfiguracionesModel       = require('../models/configuraciones.model');
const PlanesPersonalizadosStripe = require('../models/planes_personalizados_stripe.model');

const limiteConexiones = async (req, res, next) => {
  try {
    // 1) Sesión
    const subUsuarioSession = req.sessionUser;
    if (!subUsuarioSession) {
      return res.status(401).json({ status: 'fail', message: 'No estás autenticado como subusuario' });
    }

    const subUsuarioDB = await Sub_usuarios_chat_center.findByPk(subUsuarioSession.id_sub_usuario);
    if (!subUsuarioDB) {
      return res.status(401).json({ status: 'fail', message: 'No se encontró el subusuario en la base de datos' });
    }

    // 2) Usuario + plan
    const usuario = await Usuarios_chat_centerModel.findByPk(subUsuarioDB.id_usuario, {
      include: [{ model: Planes_chat_centerModel, as: 'plan' }],
    });
    if (!usuario) {
      return res.status(404).json({ status: 'fail', message: 'Usuario no encontrado' });
    }
    if (!usuario.plan) {
      return res.status(403).json({ status: 'fail', message: 'El usuario no tiene plan asignado' });
    }

    // 3) Tope permitido
    const maxPlanBase = Number(usuario.plan.max_conexiones || 0);
    const extrasHist  = Number(usuario.conexiones_adicionales || 0);

    const personalizado = await PlanesPersonalizadosStripe.findOne({
      where: { id_usuario: usuario.id_usuario },
    });

    let totalPermitido;
    if (personalizado) {
      // OVERRIDE: usa exactamente el tope personalizado
      totalPermitido = Number(personalizado.max_conexiones || 0);
    } else {
      // Fallback histórico: plan + extras del usuario
      totalPermitido = maxPlanBase + extrasHist;
    }

    // 4) Conexiones activas actuales
    const totalActual = await ConfiguracionesModel.count({
      where: { id_usuario: usuario.id_usuario, suspendido: 0 },
    });

    // 5) Si esta ruta agrega una conexión, cuenta la que está por crearse
    const isCreate = req.method === 'POST'; // en /configuraciones/agregarConfiguracion es POST
    const delta    = isCreate ? 1 : 0;

    // 6) Validación
    if (totalActual + delta > totalPermitido) {
      return res.status(403).json({
        status: 'fail',
        code: 'QUOTA_EXCEEDED',
        message: `Has alcanzado el límite de conexiones permitidas (${totalPermitido}).`,
        details: {
          fuenteTope: personalizado ? 'personalizado.max_conexiones' : 'plan.max_conexiones + usuario.conexiones_adicionales',
          maxPlanBase,
          extrasHist,
          personalizadoMax: personalizado ? Number(personalizado.max_conexiones || 0) : null,
          totalPermitido,
          totalActual,
          intentoCrear: delta,
        },
      });
    }

    // 7) Contexto útil
    req.user = usuario;
    req.subUsuario = subUsuarioDB;

    return next();
  } catch (err) {
    console.error('Error en limiteConexiones:', err);
    return res.status(500).json({ status: 'error', message: 'Error interno del servidor' });
  }
};

module.exports = limiteConexiones;
