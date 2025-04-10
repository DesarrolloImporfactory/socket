// whatsapp.routes.js
const express = require("express");
const axios = require("axios");
const { db } = require("../database/config");

const router = express.Router();

/**
 * POST /api/v1/whatsapp_managment/ObtenerNumeros
 *  - Recibe: id_plataforma
 *  - Retorna: los phone_numbers desde la Cloud API (según la config en DB).
 */
router.post("/ObtenerNumeros", async (req, res) => {
  try {
    const { id_plataforma } = req.body;

    const wabaConfig = await getConfigFromDB(id_plataforma); 
    if (!wabaConfig) {
      return res
        .status(404)
        .json({ error: "No se encontraron registros para la plataforma dada." });
    }

    const { WABA_ID, ACCESS_TOKEN } = wabaConfig;

    // Llamada a la WhatsApp Cloud API
    const url = `https://graph.facebook.com/v17.0/${WABA_ID}/phone_numbers?` +
    `fields=id,display_phone_number,platform_type,webhook_configuration,throughput,verified_name,code_verification_status,quality_rating,messaging_limit_tier,status,account_mode` +
    `&access_token=${ACCESS_TOKEN}`;
    const response = await axios.get(url);

    return res.json({
      success: true,
      data: response.data?.data || [],
    });
  } catch (error) {
    console.error("Error al obtener phone_numbers:", error);
    return res.status(500).json({
      success: false,
      error: error?.response?.data || error.message,
    });
  }
});

/**
 * POST /api/v1/whatsapp_managment/CrearPlantilla
 * - Recibe: id_plataforma y datos de la plantilla (name, language, category, components)
 * - Envía una solicitud a la Cloud API para crear una plantilla.
 */
router.post("/CrearPlantilla", async (req, res) => {
  try {
    const { id_plataforma, name, language, category, components } = req.body;

    if (!id_plataforma || !name || !language || !category || !components) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const wabaConfig = await getConfigFromDB(id_plataforma);
    if (!wabaConfig) {
      return res.status(404).json({ error: "No se encontró configuración para esta plataforma." });
    }

    const { WABA_ID, ACCESS_TOKEN } = wabaConfig;
    const url = `https://graph.facebook.com/v17.0/${WABA_ID}/message_templates`;

    const payload = {
      name,
      language,
      category,
      components
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    return res.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error("Error al crear plantilla:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error?.response?.data || error.message,
    });
  }
});



/**
 * Ruta: POST /api/v1/whatsapp_managment/obtenerPlantillasPlataforma
 *
 * Me permite obtener todos los datos de la tabla templates_chat_center
 * relacionados a una plataforma específica.
 *
 * @param {number} req.body.id_plataforma - ID de la plataforma.
 * @return {Array<Object>} - Lista de plantillas rápidas disponibles.
 */
router.post("/obtenerPlantillasPlataforma", async (req, res) => {
  const { id_plataforma } = req.body;

  if (!id_plataforma) {
    return res.status(400).json({
      success: false,
      message: "Falta el id_plataforma.",
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM templates_chat_center WHERE id_plataforma = ${id_plataforma}`,
    );

    return res.json(rows); // o { success: true, data: rows } si deseas uniformar
  } catch (error) {
    console.error("Error al obtener plantillas rápidas:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al consultar la base de datos.",
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/whatsapp_managment/crearPlantillaRapida
 * Permite registrar una plantilla de respuesta rápida para el chat center
 * @param {string} atajo - Comando corto (atajo) para usar la plantilla
 * @param {string} mensaje - Contenido del mensaje de la plantilla
 * @param {int} id_plataforma - Plataforma a la que pertenece la plantilla
 * @return {object} status 200 | 500
 */
router.post("/crearPlantillaRapida", async (req, res) => {
  const { atajo, mensaje, id_plataforma } = req.body;

  try {
    if (!id_plataforma, !atajo, !mensaje) {
      return res.status(400).json({
        success: false,
        message: "Faltan datos requeridos.",
      });
    }

    const [result] = await db.query(
      `INSERT INTO templates_chat_center (atajo, mensaje, id_plataforma)
       VALUES (?, ?, ?)`,
      {
        replacements: [atajo, mensaje, id_plataforma],
        type: db.QueryTypes.INSERT,
      }
    );
    
    return res.json({
      success: true,
      message: "Plantilla rápida agregada correctamente.",
      insertId: result.insertId,
    });
  } catch (error) {
    console.error("Error al crear plantilla rápida:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al guardar plantilla.",
      error: error.message,
    });
  }
});

/**
 * PUT /api/v1/whatsapp_managment/cambiarEstado
 * Cambia el estado "principal" de una plantilla rápida en el chat center.
 * 
 * Este endpoint actualiza el valor del campo `principal` de una plantilla específica,
 * permitiendo marcarla (o desmarcarla) como principal para la plataforma correspondiente.
 *
 * @param {int} id_template - ID de la plantilla a modificar
 * @param {int} estado - Valor del nuevo estado (1 = principal, 0 = no principal)
 * @return {object} status 200 | 500
 *
 * @example Body JSON:
 * {
 *   "id_template": 74,
 *   "estado": 1
 * }
 *
 * @response
 * {
 *   "success": true,
 *   "modificado": true | false,
 *   "message": "Estado modificado correctamente." | "El estado ya estaba asignado."
 * }
 */

router.put("/cambiarEstado", async (req, res) => {
  const { estado, id_template } = req.body;

  if (estado === undefined || !id_template) {
    return res.status(400).json({
      success: false,
      message: "Faltan datos requeridos.",
    });
  }

  try {
    const [result, metadata] = await db.query(
      `UPDATE templates_chat_center SET principal = ? WHERE id_template = ?`,
      {
        replacements: [estado, id_template],
      }
    );
    
    //Depurando porque no se recibia un mensaje de un cambio realmente hecho.
    // console.log("Metadata:", metadata);
    // console.log("Result:", result);

    if (result.changedRows > 0) {
      return res.json({
        status: 200,
        success: true,
        modificado: true,
        message: "Estado modificado correctamente.",
      });
    } else {
      return res.json({
        status: 200,
        success: true,
        modificado: false,
        message: "El estado ya estaba asignado.",
      });
    }
  } catch (error) {
    console.error("Error al cambiar estado:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
      error: error.message,
    });
  }
});


/**
 * DELETE /api/v1/whatsapp_managment/eliminarPlantilla
 * Elimina una plantilla rápida del sistema del chat center.
 *
 * Este endpoint elimina de forma permanente una plantilla específica 
 * de la tabla `templates_chat_center`, identificada por su `id_template`.
 *
 * @param {int} id_template - ID de la plantilla a eliminar
 * @return {object} status 200 | 404 | 500
 *
 * @example Body JSON:
 * {
 *   "id_template": 74
 * }
 *
 * @response (Éxito)
 * {
 *   "status": 200,
 *   "success": true,
 *   "title": "Petición exitosa",
 *   "message": "Plantilla eliminada correctamente."
 * }
 *
 * @response (No encontrado)
 * {
 *   "status": 404,
 *   "success": false,
 *   "title": "No encontrado",
 *   "message": "No se encontró la plantilla a eliminar."
 * }
 *
 * @response (Error interno)
 * {
 *   "status": 500,
 *   "success": false,
 *   "title": "Error del servidor",
 *   "message": "No se pudo eliminar la plantilla.",
 *   "error": "Mensaje del error"
 * }
 */

router.delete("/eliminarPlantilla", async (req, res) => {
  const { id_template } = req.body;

  if (!id_template) {
    return res.status(400).json({
      success: false,
      message: "Faltan datos requeridos."
    });
  }

  try {
    const [result] = await db.query(
      `DELETE FROM templates_chat_center WHERE id_template = ?`,
      {
        replacements: [id_template],
      }
    );

    // Validamos si se eliminó al menos una fila
    if (result.affectedRows > 0) {
      return res.status(200).json({
        status: 200,
        success: true,
        title: "Petición exitosa",
        message: "Plantilla eliminada correctamente."
      });
    } else {
      return res.status(404).json({
        status: 404,
        success: false,
        title: "No encontrado",
        message: "No se encontró la plantilla a eliminar."
      });
    }
  } catch (error) {
    console.error("Error al eliminar plantilla:", error);
    return res.status(500).json({
      success: false,
      title: "Error del servidor",
      message: "No se pudo eliminar la plantilla.",
      error: error.message
    });
  }
});

/**
 * PUT /api/v1/whatsapp_managment/EditarPlantilla
 * Edita una plantilla rápida en el chat center.
 * 
 * Actualiza el contenido de una plantilla específica usando su ID.
 *
 * @param {int} id_template - ID de la plantilla a editar
 * @param {string} atajo - Nuevo valor del atajo
 * @param {string} mensaje - Nuevo contenido del mensaje
 * @return {object} status 200 | 500
 *
 * @example Body JSON:
 * {
 *   "id_template": 74,
 *   "atajo": "/gracias",
 *   "mensaje": "¡Gracias por tu compra!"
 * }
 */

router.put("/EditarPlantilla", async (req, res) => {
  const { atajo, mensaje, id_template } = req.body;
  //No validamos por completo ya que hay algunas plantillas que van vacias.
  // if (!atajo || !mensaje || !id_template) {
  //   return res.status(400).json({
  //     success: false,
  //     message: "Faltan datos requeridos.",
  //   });
  // }

  try {
    const [result] = await db.query(
      `UPDATE templates_chat_center SET atajo = ?, mensaje = ? WHERE id_template = ?`,
      {
        replacements: [atajo, mensaje, id_template],
      }
    );

    if (result.changedRows > 0) {
      return res.json({
        status: 200,
        success: true,
        modificado: true,
        message: "Plantilla editada correctamente.",
      });
    } else {
      return res.json({
        status: 200,
        success: true,
        modificado: false,
        message: "Los datos enviados son iguales a los actuales.",
      });
    }
  } catch (error) {
    console.error("Error al editar la plantilla:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
      error: error.message,
    });
  }
});



/**
 * Obtiene la config de la tabla 'configuraciones' según el id_plataforma.
 * 
 * La tabla debe tener columnas: id_plataforma, id_whatsapp, token.
 * Devuelve un objeto { WABA_ID, ACCESS_TOKEN } si encuentra registro.
 */
async function getConfigFromDB(id_plataforma) {
  try {
    // Realiza la consulta a MySQL
    const [rows] = await db.query(
      `SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN
       FROM configuraciones
       WHERE id_plataforma = ${id_plataforma}`
    );
    // Si la consulta encontró datos, retornamos la primera fila
    if (rows.length > 0) {
      return rows[0]; 
    }
    return null;
  } catch (error) {
    console.error("Error en getConfigFromDB:", error);
    throw error;
  }
}

module.exports = router;
