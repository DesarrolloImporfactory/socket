const Etiquetas_asignadas = require('../models/etiquetas_asignadas.model');
const { db } = require('../database/config');

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
        // Obtener todas las etiquetas asignadas al cliente
        const etiquetas_asignadas = await db.query(
          `SELECT ec.id_etiqueta, ec.nombre_etiqueta, ec.color_etiqueta
           FROM etiquetas_asignadas ea
           INNER JOIN etiquetas_chat_center ec ON ea.id_etiqueta = ec.id_etiqueta
           WHERE ea.id_cliente_chat_center = ?`,
          {
            replacements: [id_cliente_chat_center],
            type: db.QueryTypes.SELECT,
          }
        );

        // Si no se encontraron etiquetas, inicializamos con el valor por defecto
        let lista_etiquetas =
          etiquetas_asignadas.length > 0
            ? etiquetas_asignadas.map((etiqueta) => ({
                id: etiqueta.id_etiqueta,
                color: etiqueta.color_etiqueta,
                nombre: etiqueta.nombre_etiqueta,
              }))
            : [{ id: null, color: null, nombre: null }];

        // Actualizar la columna 'etiquetas' en clientes_chat_center
        await db.query(
          `UPDATE clientes_chat_center
           SET etiquetas = ?
           WHERE id = ?`,
          {
            replacements: [
              JSON.stringify(lista_etiquetas),
              id_cliente_chat_center,
            ],
            type: db.QueryTypes.UPDATE,
          }
        );

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
