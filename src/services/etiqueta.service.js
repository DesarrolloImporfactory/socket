const { response } = require('express');
const { db } = require('../database/config');
const EtiquetasChatCenter = require('../models/etiquetas_chat_center.model');
const EtiquetasAsignadas = require('../models/etiquetas_asignadas.model');

class EtiquetaService {
  static async guardar(etiqueta) {
    const [result] = await db.query(
      `INSERT INTO etiquetas_chat_center (nombre_etiqueta, color_etiqueta, id_configuracion) VALUES (?, ?, ?)`,
      {
        replacements: [
          etiqueta.nombre_etiqueta,
          etiqueta.color_etiqueta,
          etiqueta.id_configuracion,
        ],
        type: db.QueryTypes.INSERT,
      }
    );

    return result;
  }

  static async eliminar(id_etiqueta) {
    const etiqueta = await EtiquetasChatCenter.findByPk(id_etiqueta);

    if (!etiqueta) {
      throw new Error('Etiqueta no encontrada');
    }

    await etiqueta.destroy();
    return true;
  }

  static async toggleAsignacion(
    id_cliente_chat_center,
    id_etiqueta,
    id_configuracion
  ) {
    const response = {
      status: 500,
      title: 'Error',
      message: 'Ocurrió un error',
      asignado: null,
    };

    const [asignada] = await db.query(
      `SELECT id FROM etiquetas_asignadas WHERE id_cliente_chat_center = ? AND id_etiqueta = ?`,
      {
        replacements: [id_cliente_chat_center, id_etiqueta, id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    if (asignada) {
      //Ya existe => eliminar
      const result = await db.query(
        `DELETE FROM etiquetas_asignadas WHERE id = ?`,
        {
          replacements: [asignada.id],
          type: db.QueryTypes.DELETE,
        }
      );

      response.status = 200;
      response.title = 'Petición exitosa';
      response.message = 'Etiqueta desasignada correctamente';
      response.asignado = false;
    } else {
      //No existe => insertar
      const result = await db.query(
        `INSERT INTO etiquetas_asignadas (id_cliente_chat_center, id_etiqueta, id_configuracion) VALUES (?, ?, ?)`,
        {
          replacements: [id_cliente_chat_center, id_etiqueta, id_configuracion],
          type: db.QueryTypes.INSERT,
        }
      );

      response.status = 200;
      response.title = 'Petición exitosa';
      response.message = 'Etiqueta asignada correctamente';
      response.asignado = true;
    }

    return response;
  }

  static async obtenerEtiquetas(id_configuracion) {
    // Validación defensiva
    if (!id_configuracion) {
      throw new Error('id_configuracion es obligatorio');
    }

    try {
      // Intentamos realizar la consulta a la base de datos
      return await EtiquetasChatCenter.findAll({ where: { id_configuracion } });
    } catch (error) {
      // Si ocurre un error en la consulta o en cualquier parte del código, lo capturamos aquí
      throw new Error(`Error al obtener las etiquetas: ${error.message}`);
    }
  }

  static async obtenerEtiquetasAsignadas(id_cliente_chat_center) {
    if (!id_cliente_chat_center) {
      throw new Error('id_cliente_chat_center es obligatorio');
    }

    return await EtiquetasAsignadas.findAll({
      where: { id_cliente_chat_center },
    });
  }
}

module.exports = EtiquetaService;
