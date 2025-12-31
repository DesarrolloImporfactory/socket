// middlewares/limiteConversaciones.middleware.js
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Usuarios_chat_centerModel = require('../models/usuarios_chat_center.model');
const Planes_chat_centerModel = require('../models/planes_chat_center.model');
const ConfiguracionesModel = require('../models/configuraciones.model');
const Clientes_chat_centerModel = require('../models/clientes_chat_center.model');
const PlanesPersonalizadosStripe = require('../models/planes_personalizados_stripe.model');
const { Op, fn, col, where } = require('sequelize');

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
const limiteConversaciones = async (req, res, next) => {
  try {
    // 1) Verificar sesión
    const subUsuarioSession = req.sessionUser;
    if (!subUsuarioSession) {
      return res.status(401).json({
        status: 'fail',
        message: 'No estás autenticado como subusuario',
      });
    }

    // 2) Cargar subusuario
    const subUsuarioDB = await Sub_usuarios_chat_center.findByPk(
      subUsuarioSession.id_sub_usuario
    );
    if (!subUsuarioDB) {
      return res.status(401).json({
        status: 'fail',
        message: 'No se encontró el subusuario en la base de datos',
      });
    }

    // 3) Cargar usuario + plan
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

    //calcular el limite de conversaciones por plan
    const maxPlanConversaciones = Number(usuario.plan?.n_conversaciones || 0);

    const configuraciones = await ConfiguracionesModel.findAll({
      where: { id_usuario: usuario.id_usuario },
      attributes: ['id'],
    });

    const configIds = configuraciones.map((c) => c.id);

    // Conversaciones actuales

    // Obtener mes y año actual
    const ahora = new Date();
    const año = ahora.getFullYear();
    const mes = ahora.getMonth(); // 0 = enero, 11 = diciembre

    // Rango: inicio y fin del mes actual
    const inicio = new Date(año, mes, 1);
    const fin = new Date(año, mes + 1, 1);

    const totalActualConversaciones = configIds.length
      ? await Clientes_chat_centerModel.count({
          where: {
            id_configuracion: { [Op.in]: configIds },
            created_at: { [Op.gte]: inicio, [Op.lt]: fin },
          },
        })
      : 0;

    console.log('inicio: ' + inicio);
    console.log('fin: ' + fin);

    console.log('totalActualConversaciones: ' + totalActualConversaciones);
    console.log('maxPlanConversaciones: ' + maxPlanConversaciones);

    // 8) Validación de cupo
    if (totalActualConversaciones > maxPlanConversaciones) {
      return res.status(403).json({
        status: 'fail',
        code: 'QUOTA_EXCEEDED',
        message: `Has alcanzado el límite de conversaciones permitidas en tu plan(${maxPlanConversaciones}).`,
        details: {
          maxPlanConversaciones,
          totalActualConversaciones,
        },
      });
    }

    // 9) Exponer en req para siguientes capas
    req.user = usuario;
    req.subUsuario = subUsuarioDB;

    return next();
  } catch (err) {
    console.error('Error en limiteConversaciones:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Error interno del servidor',
    });
  }
};

module.exports = limiteConversaciones;
