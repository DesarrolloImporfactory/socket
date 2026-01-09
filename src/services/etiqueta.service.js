const { response } = require('express');
const { db } = require('../database/config');
const EtiquetasChatCenter = require('../models/etiquetas_chat_center.model');
const EtiquetasAsignadas = require('../models/etiquetas_asignadas.model');

class EtiquetaService {
  static async guardar(etiqueta) {
    const sql = `
    INSERT INTO etiquetas_chat_center
      (nombre_etiqueta, color_etiqueta, id_configuracion, created_at, updated_at)
    VALUES (?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      color_etiqueta = VALUES(color_etiqueta),
      updated_at     = NOW(),
      id_etiqueta    = LAST_INSERT_ID(id_etiqueta)
  `;

    // Ejecuta UPSERT
    await db.query(sql, {
      replacements: [
        etiqueta.nombre_etiqueta,
        etiqueta.color_etiqueta,
        etiqueta.id_configuracion,
      ],
      type: db.QueryTypes.INSERT,
    });

    // Devuelve el id (nuevo o existente)
    const [{ id_etiqueta }] = await db.query(
      'SELECT LAST_INSERT_ID() AS id_etiqueta',
      { type: db.QueryTypes.SELECT }
    );

    // Si quiere devolver la fila completa:
    const [row] = await db.query(
      `SELECT id_etiqueta, nombre_etiqueta, color_etiqueta, id_configuracion
     FROM etiquetas_chat_center
     WHERE id_etiqueta = ?`,
      {
        replacements: [id_etiqueta],
        type: db.QueryTypes.SELECT,
      }
    );

    return row; // o return { id_etiqueta }
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

    // ✅ Si db es Sequelize, esto existe:
    return await db.transaction(async (t) => {
      // 1) Bloqueo lógico de la fila (si existe) para evitar carreras
      const [asignada] = await db.query(
        `SELECT id
       FROM etiquetas_asignadas
       WHERE id_cliente_chat_center = ?
         AND id_etiqueta = ?
         AND id_configuracion = ?
       FOR UPDATE`,
        {
          replacements: [id_cliente_chat_center, id_etiqueta, id_configuracion],
          type: db.QueryTypes.SELECT,
          transaction: t,
        }
      );

      if (asignada) {
        // 2A) Existe => eliminar
        await db.query(
          `DELETE FROM etiquetas_asignadas
         WHERE id = ?`,
          {
            replacements: [asignada.id],
            type: db.QueryTypes.DELETE,
            transaction: t,
          }
        );

        response.status = 200;
        response.title = 'Petición exitosa';
        response.message = 'Etiqueta desasignada correctamente';
        response.asignado = false;
      } else {
        // 2B) No existe => insertar (con UNIQUE no duplica)
        // (Si quiere extra seguridad en escenarios raros, puede usar INSERT IGNORE aquí)
        await db.query(
          `INSERT INTO etiquetas_asignadas
           (id_cliente_chat_center, id_etiqueta, id_configuracion)
         VALUES (?, ?, ?)`,
          {
            replacements: [
              id_cliente_chat_center,
              id_etiqueta,
              id_configuracion,
            ],
            type: db.QueryTypes.INSERT,
            transaction: t,
          }
        );

        response.status = 200;
        response.title = 'Petición exitosa';
        response.message = 'Etiqueta asignada correctamente';
        response.asignado = true;
      }

      // 3) Recalcular etiquetas asignadas (IMPORTANTE: filtrar por id_configuracion)
      const etiquetas_asignadas = await db.query(
        `SELECT ec.id_etiqueta, ec.nombre_etiqueta, ec.color_etiqueta
       FROM etiquetas_asignadas ea
       INNER JOIN etiquetas_chat_center ec
         ON ea.id_etiqueta = ec.id_etiqueta
       WHERE ea.id_cliente_chat_center = ?
         AND ea.id_configuracion = ?`,
        {
          replacements: [id_cliente_chat_center, id_configuracion],
          type: db.QueryTypes.SELECT,
          transaction: t,
        }
      );

      const lista_etiquetas =
        etiquetas_asignadas.length > 0
          ? etiquetas_asignadas.map((et) => ({
              id: et.id_etiqueta,
              color: et.color_etiqueta,
              nombre: et.nombre_etiqueta,
            }))
          : [{ id: null, color: null, nombre: null }];

      // 4) Guardar JSON en clientes_chat_center
      await db.query(
        `UPDATE clientes_chat_center
       SET etiquetas = ?, updated_at = NOW()
       WHERE id = ?`,
        {
          replacements: [
            JSON.stringify(lista_etiquetas),
            id_cliente_chat_center,
          ],
          type: db.QueryTypes.UPDATE,
          transaction: t,
        }
      );

      return response;
    });
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
