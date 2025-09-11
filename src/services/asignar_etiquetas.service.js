const Etiquetas_asignadas = require('../models/etiquetas_asignadas.model');

async function asignar_etiqueta_automatizador({
  id_cliente_chat_center,
  id_etiqueta,
  id_configuracion,
}) {
  let response = {
    status: 200,
    title: 'Petición exitosa',
    message: '',
    asignado: false,
  };

  try {
    // Verificar si ya existe la asignación
    const existe = await Etiquetas_asignadas.findOne({
      where: {
        id_cliente_chat_center,
        id_etiqueta,
      },
    });

    if (!existe) {
      // Crear nueva asignación
      const nuevaAsignacion = await Etiquetas_asignadas.create({
        id_cliente_chat_center,
        id_etiqueta,
        id_configuracion,
      });

      if (nuevaAsignacion) {
        response.status = 200;
        response.message = 'Etiqueta asignada correctamente';
        response.asignado = true;
      } else {
        response.status = 500;
        response.title = 'Error al asignar';
        response.message = 'Error al asignar la etiqueta';
      }
    } else {
      response.message = 'La etiqueta ya estaba asignada previamente';
    }
  } catch (error) {
    response.status = 500;
    response.title = 'Error inesperado';
    response.message = error.message;
  }

  return response;
}

module.exports = {
  asignar_etiqueta_automatizador,
};
