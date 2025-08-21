// ✅ REFACTORIZADO: planes.controller.js
const Planes_chat_center = require('../models/planes_chat_center.model');
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const { db } = require('../database/config');
/**
 * ✅ Asigna un plan al usuario sin activarlo
 * Este paso solo marca la intención de pago, no cambia el estado.
 */
exports.seleccionarPlan = async (req, res) => {
  try {
    const { id_plan } = req.body;
    const id_usuario = req.user?.id || req.body.id_usuario || req.body.id_users;

    if (!id_plan || !id_usuario) {
      return res.status(400).json({ status: 'fail', message: 'Faltan datos necesarios (id_plan, id_usuario)' });
    }

    // Validar que el plan exista
    const plan = await Planes_chat_center.findByPk(id_plan);
    if (!plan) {
      return res.status(404).json({ status: 'fail', message: 'El plan no existe' });
    }

    // Validar que el usuario exista
    const usuario = await Usuarios_chat_center.findByPk(id_usuario);
    if (!usuario) {
      return res.status(404).json({ status: 'fail', message: 'El usuario no existe' });
    }

    // ✅ Activar directamente el Plan Free (id_plan === 1)
    if (parseInt(id_plan) === 1) {
      const hoy = new Date();
      const nuevaFechaRenovacion = new Date(hoy);
      nuevaFechaRenovacion.setDate(hoy.getDate() + 15);

      await usuario.update({
        id_plan: 1,
        fecha_inicio: hoy,
        fecha_renovacion: nuevaFechaRenovacion,
        estado: 'activo',
      });


      return res.status(200).json({ status: 'success', message: 'Plan gratuito activado correctamente' });
    }

    // 🟣 Otros planes: solo actualizar intención
    await usuario.update({ id_plan });

    return res.status(200).json({ status: 'success', message: 'Plan seleccionado correctamente, pendiente de pago' });

  } catch (error) {
    console.error('Error al seleccionar plan:', error);
    return res.status(500).json({ status: 'fail', message: 'Error interno al seleccionar plan' });
  }
};



/**
 * ✅ Lista todos los planes disponibles
 */
exports.obtenerPlanes = async (req, res) => {
  try {
    const planes = await Planes_chat_center.findAll();

    return res.status(200).json({
      status: 'success',
      data: planes,
    });
  } catch (error) {
    console.error('Error al obtener planes:', error);
    return res.status(500).json({
      status: 'fail',
      message: 'Error interno al obtener los planes',
    });
  }
};

