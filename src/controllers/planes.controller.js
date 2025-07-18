const Planes_chat_center = require('../models/Planes_chat_center');
const Usuarios_chat_center = require('../models/Usuarios_chat_center');
const catchAsync = require('../utils/catchAsync');

exports.seleccionarPlan = catchAsync(async (req, res, next) => {
  const id_usuario = req.usuario?.id_usuario;
  const { id_plan } = req.body;

  if (!id_usuario) {
    return res.status(401).json({
      status: 'fail',
      message: 'No autenticado',
    });
  }

  // Verificar existencia del plan
  const plan = await Planes_chat_center.findByPk(id_plan);
  if (!plan) {
    return res.status(404).json({
      status: 'fail',
      message: 'El plan seleccionado no existe',
    });
  }

  // Calcular fechas
  const hoy = new Date();
  const fechaRenovacion = new Date(hoy);
  fechaRenovacion.setDate(hoy.getDate() + plan.duracion_plan);

  // Buscar usuario
  const usuario = await Usuarios_chat_center.findByPk(id_usuario);
  if (!usuario) {
    return res.status(404).json({
      status: 'fail',
      message: 'Usuario no encontrado',
    });
  }

  // Actualizar datos del plan en el usuario
  await usuario.update({
    id_plan,
    fecha_inicio: hoy,
    fecha_renovacion: fechaRenovacion,
    estado: 'activo',
  });

  res.status(200).json({
    status: 'success',
    message: 'Plan seleccionado correctamente',
    data: {
      id_plan: usuario.id_plan,
      fecha_inicio: usuario.fecha_inicio,
      fecha_renovacion: usuario.fecha_renovacion,
      estado: usuario.estado,
    },
  });
});
