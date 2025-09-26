// middlewares/limiteConexiones.middleware.js
const Sub_usuarios_chat_center   = require('../models/sub_usuarios_chat_center.model');
const Usuarios_chat_centerModel  = require('../models/usuarios_chat_center.model');
const Planes_chat_centerModel    = require('../models/planes_chat_center.model');
const ConfiguracionesModel       = require('../models/configuraciones.model');
const PlanesPersonalizadosStripe = require('../models/planes_personalizados_stripe.model');

/**
 * Middleware para validar límite de conexiones.
 * Regla de tope:
 *   - SIEMPRE: plan.(n_conexiones|max_conexiones) + usuario.conexiones_adicionales
 *   - Opcional: si existe Plan Personalizado, SOLO se usa si su max_conexiones es MAYOR
 *               que el resultado anterior (nunca reduce).
 *
 * No se modifica el criterio de conteo de conexiones activas (suspendido = 0)
 * ni el delta al crear (POST suma 1), para no afectar la lógica actual.
 */
const limiteConexiones = async (req, res, next) => {
  try {
    // 1) Verificar sesión
    const subUsuarioSession = req.sessionUser;
    if (!subUsuarioSession) {
      return res.status(401).json({
        status: 'fail',
        message: 'No estás autenticado como subusuario'
      });
    }

    // 2) Cargar subusuario
    const subUsuarioDB = await Sub_usuarios_chat_center.findByPk(subUsuarioSession.id_sub_usuario);
    if (!subUsuarioDB) {
      return res.status(401).json({
        status: 'fail',
        message: 'No se encontró el subusuario en la base de datos'
      });
    }

    // 3) Cargar usuario + plan
    const usuario = await Usuarios_chat_centerModel.findByPk(subUsuarioDB.id_usuario, {
      include: [{ model: Planes_chat_centerModel, as: 'plan' }],
    });

    if (!usuario) {
      return res.status(404).json({
        status: 'fail',
        message: 'Usuario no encontrado'
      });
    }

    if (!usuario.plan) {
      return res.status(403).json({
        status: 'fail',
        message: 'El usuario no tiene plan asignado'
      });
    }

    // 4) Calcular tope base: plan + extras
    const maxPlanBase = Number(
      (usuario.plan?.n_conexiones ?? usuario.plan?.max_conexiones) || 0
    );

    const extrasHist = Number(usuario.conexiones_adicionales || 0);

    let totalPermitido = maxPlanBase + extrasHist;
    let fuenteTope = 'plan.(n_conexiones|max_conexiones) + usuario.conexiones_adicionales';

    // 5) Plan personalizado: solo aplica si AMPLÍA el cupo
    const personalizado = await PlanesPersonalizadosStripe.findOne({
      where: { id_usuario: usuario.id_usuario },
    });

    const personalizadoMax = (personalizado && personalizado.max_conexiones != null)
      ? Number(personalizado.max_conexiones)
      : null;

    if (personalizadoMax != null && personalizadoMax > totalPermitido) {
      totalPermitido = personalizadoMax;
      fuenteTope = 'personalizado.max_conexiones (mayor que plan+extras)';
    }

    // 6) Conexiones activas actuales (se mantiene tu criterio: suspendido = 0)
    const totalActual = await ConfiguracionesModel.count({
      where: {
        id_usuario: usuario.id_usuario,
        suspendido: 0,
      },
    });

    // 7) Delta por creación (se mantiene como estaba)
    const isCreate = req.method === 'POST';
    const delta = isCreate ? 1 : 0;

    // 8) Validación de cupo
    if (totalActual + delta > totalPermitido) {
      return res.status(403).json({
        status: 'fail',
        code: 'QUOTA_EXCEEDED',
        message: `Has alcanzado el límite de conexiones permitidas (${totalPermitido}).`,
        details: {
          fuenteTope,
          maxPlanBase,
          extrasHist,
          personalizadoMax,
          totalPermitido,
          totalActual,
          intentoCrear: delta,
        },
      });
    }

    // 9) Exponer en req para siguientes capas
    req.user = usuario;
    req.subUsuario = subUsuarioDB;

    return next();
  } catch (err) {
    console.error('Error en limiteConexiones:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Error interno del servidor'
    });
  }
};

module.exports = limiteConexiones;
