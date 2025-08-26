// whatsapp.routes.js
const express = require('express');
const axios = require('axios');
const { db } = require('../database/config');
const { error } = require('winston');

const router = express.Router();

/**
 * POST /api/v1/whatsapp_managment/ObtenerNumeros
 *  - Recibe: id_plataforma
 *  - Retorna: los phone_numbers desde la Cloud API (según la config en DB).
 */
router.post('/ObtenerNumeros', async (req, res) => {
  try {
    const { id_configuracion } = req.body;

    if (id_configuracion == null) {
      return res.status(400).json({
        success: false,
        error: 'Falta el id (configuraciones.id) en el body.',
      });
    }

    const wabaConfig = await getConfigFromDB(id_configuracion);
    if (!wabaConfig) {
      return res.status(404).json({
        success: false,
        error: `No se encontró configuración para id=${id_configuracion}.`,
      });
    }

    const { WABA_ID, ACCESS_TOKEN } = wabaConfig;

    // Llamada a la WhatsApp Cloud API
    const url =
      `https://graph.facebook.com/v17.0/${WABA_ID}/phone_numbers?` +
      `fields=id,display_phone_number,platform_type,webhook_configuration,throughput,verified_name,code_verification_status,quality_rating,messaging_limit_tier,status,account_mode` +
      `&access_token=${ACCESS_TOKEN}`;
    const response = await axios.get(url);

    return res.json({
      success: true,
      data: response.data?.data || [],
    });
  } catch (error) {
    console.error('Error al obtener phone_numbers:', error);
    return res.status(500).json({
      success: false,
      error: error?.response?.data || error.message,
    });
  }
});

/**
 * POST /api/v1/whatsapp_managment/CrearPlantilla
 * - Recibe: id_configuracion y datos de la plantilla (name, language, category, components)
 * - Envía una solicitud a la Cloud API para crear una plantilla.
 */
router.post('/CrearPlantilla', async (req, res) => {
  try {
    const { id_configuracion, name, language, category, components } = req.body;

    if (!id_configuracion || !name || !language || !category || !components) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    const wabaConfig = await getConfigFromDB(id_configuracion);
    if (!wabaConfig) {
      return res.status(404).json({ error: 'No se encontró configuración.' });
    }

    const { WABA_ID, ACCESS_TOKEN } = wabaConfig;
    const url = `https://graph.facebook.com/v17.0/${WABA_ID}/message_templates`;

    const payload = {
      name,
      language,
      category,
      components,
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    return res.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error(
      'Error al crear plantilla:',
      error?.response?.data || error.message
    );
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
router.post('/obtenerPlantillasPlataforma', async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_configuracion.',
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM templates_chat_center WHERE id_configuracion = ${id_configuracion}`
    );

    return res.json(rows); // o { success: true, data: rows } si deseas uniformar
  } catch (error) {
    console.error('Error al obtener plantillas rápidas:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno al consultar la base de datos.',
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/whatsapp_managment/crearPlantillaRapida
 * Permite registrar una plantilla de respuesta rápida para el chat center
 * @param {string} atajo - Comando corto (atajo) para usar la plantilla
 * @param {string} mensaje - Contenido del mensaje de la plantilla
 * @param {int} id_configuracion - id_configuracion a la que pertenece la plantilla
 * @param {int} id_plataforma - id_plataforma en caso de que la tienda realize dropshiping, caso contrario null
 * @return {object} status 200 | 500
 */
router.post('/crearPlantillaRapida', async (req, res) => {
  const { atajo, mensaje, id_configuracion } = req.body;

  try {
    if ((!id_configuracion, !atajo)) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos.',
      });
    }

    const [result] = await db.query(
      `INSERT INTO templates_chat_center (atajo, mensaje, id_configuracion)
       VALUES (?, ?, ?)`,
      {
        replacements: [atajo, mensaje, id_configuracion],
        type: db.QueryTypes.INSERT,
      }
    );

    return res.json({
      success: true,
      message: 'Plantilla rápida agregada correctamente.',
      insertId: result.insertId,
    });
  } catch (error) {
    console.error('Error al crear plantilla rápida:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno al guardar plantilla.',
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

router.put('/cambiarEstado', async (req, res) => {
  const { estado, id_template } = req.body;

  if (estado === undefined || !id_template) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos requeridos.',
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
        message: 'Estado modificado correctamente.',
      });
    } else {
      return res.json({
        status: 200,
        success: true,
        modificado: false,
        message: 'El estado ya estaba asignado.',
      });
    }
  } catch (error) {
    console.error('Error al cambiar estado:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor.',
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

router.delete('/eliminarPlantilla', async (req, res) => {
  const { id_template } = req.body;

  if (!id_template) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos requeridos.',
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
        title: 'Petición exitosa',
        message: 'Plantilla eliminada correctamente.',
      });
    } else {
      return res.status(404).json({
        status: 404,
        success: false,
        title: 'No encontrado',
        message: 'No se encontró la plantilla a eliminar.',
      });
    }
  } catch (error) {
    console.error('Error al eliminar plantilla:', error);
    return res.status(500).json({
      success: false,
      title: 'Error del servidor',
      message: 'No se pudo eliminar la plantilla.',
      error: error.message,
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

router.put('/EditarPlantilla', async (req, res) => {
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
        message: 'Plantilla editada correctamente.',
      });
    } else {
      return res.json({
        status: 200,
        success: true,
        modificado: false,
        message: 'Los datos enviados son iguales a los actuales.',
      });
    }
  } catch (error) {
    console.error('Error al editar la plantilla:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor.',
      error: error.message,
    });
  }
});

/**
 * PUT /api/v1/whatsapp_managment/editarConfiguración
 *
 * Actualiza la configuración de una plataforma relacionada con WhatsApp,
 * guardando el ID de la plantilla que se debe usar para generar guías.
 *
 * @param {string} id_template_whatsapp - ID de la plantilla seleccionada
 * @param {number} id_configuracion - ID configuracion
 *
 * @returns {object} status 200 | 500
 *
 * @example Body JSON:
 * {
 *   "id_template_whatsapp": "greeting_template_01",
 *   "id_configuracion": 12
 * }
 */
router.put('/editarConfiguracion', async (req, res) => {
  const { id_template_whatsapp, id_configuracion } = req.body;

  if (!id_template_whatsapp || !id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos requeridos.',
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET template_generar_guia = ? WHERE id = ?`,
      {
        replacements: [id_template_whatsapp, id_configuracion],
      }
    );

    if (result.affectedRows > 0) {
      return res.status(200).json({
        success: true,
        status: 200,
        message: 'Configuración editada correctamente.',
      });
    } else {
      return res.json({
        status: 200,
        success: true,
        modificado: false,
        message: 'El estado ya estaba asignado.',
      });
    }
  } catch (error) {
    console.error('Error al editar configuración:', error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: 'Error interno al editar configuración.',
      error: error.message,
    });
  }
});

/**
 * PUT /api/v1/whatsapp_managment/actualizarMetodoPago
 * Cambia el metodo de pago de la configuracion de una cuenta.
 *
 *
 * @param {int} id_configuracion - ID de la configuracion a modificar
 * @param {int} metodo_pago - Valor del nmetodo de pago (1 = activo, 0 = no activo)
 * @return {object} status 200 | 500
 *
 * @example Body JSON:
 * {
 *   "id_template": 74,
 *   "metodo_pago": 1
 * }
 *
 * @response
 * {
 *   "success": true,
 *   "modificado": true | false,
 *   "message": "Metodo de pago actualizado correctamente." | "El método ya estaba asignado."
 * }
 */
router.put('/actualizarMetodoPago', async (req, res) => {
  const { metodo_pago, id } = req.body;

  if (metodo_pago === undefined || !id) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos requeridos',
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET metodo_pago = ? WHERE id = ?`,
      {
        replacements: [metodo_pago, id],
      }
    );

    if (result.changedRows > 0) {
      return res.json({
        status: 200,
        success: true,
        modificado: true,
        message: 'Método de pago actualizado correctamente.',
      });
    } else {
      return res.json({
        status: 200,
        success: true,
        modificado: false,
        message: 'El método ya estaba asignado',
      });
    }
  } catch (error) {
    console.error('Error al actualizar el método de pago', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor.',
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/whatsapp_managment/obtenerTemplatesWhatsapp
 * Body: { id_plataforma: number }
 *  ‑ Devuelve TODO el JSON que entrega Meta.
 */
router.post('/obtenerTemplatesWhatsapp', async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_configuracion',
    });
  }

  try {
    /* 2. Configuración de la plataforma */
    const [rows] = await db.query(
      `SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN
      FROM configuraciones
      WHERE id = ?`,
      { replacements: [id_configuracion] }
    );

    if (!rows.length) {
      return res.status(404).json({
        error: true,
        message: 'No se encontró configuración.',
      });
    }

    const { WABA_ID, ACCESS_TOKEN } = rows[0];

    /* 3. Petición a la Graph API (v22.0) */
    const url = `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates`;

    const { data } = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000, // evita que se congele si Meta no responde
    });

    /* 4. Éxito ➜ devolver la respuesta tal cual */
    return res.json(data); // ≈ echo json_encode($dataApi) en PHP
  } catch (error) {
    /* 5. Errores: red/DNS o respuesta 4xx‑5xx de Meta */
    if (error.response) {
      // La API de WhatsApp devolvió un error con código HTTP
      return res.status(error.response.status).json({
        error: true,
        message: 'Error de la API de WhatsApp',
        response: error.response.data, // mismo campo que usaste en PHP
      });
    }

    // Error de red, DNS, timeout, etc.
    return res.status(500).json({
      error: true,
      message: 'Error de conexión: ' + error.message,
    });
  }
});

/**
 * POST /api/v1/whatsapp_managment/obtenerConfiguracion
 *
 * Consulta la plantilla actualmente seleccionada para generar guías
 * de la tabla `configuraciones` según el id_configuracion.
 *
 * @param {number} id_configuracion - ID de la plataforma
 * @returns {object} { success, config: { template_generar_guia } }
 */
router.post('/obtenerConfiguracion', async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_configuracion.',
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT COALESCE(template_generar_guia, '') AS template_generar_guia 
       FROM configuraciones 
       WHERE id = ?`,
      { replacements: [id_configuracion] }
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No se encontró configuración para esta plataforma.',
      });
    }

    return res.json({
      success: true,
      config: rows[0],
    });
  } catch (error) {
    console.error('Error al obtener configuración:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar configuración.',
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/whatsapp_managment/configuracionesAutomatizador
 *
 * Consulta si la plataforma existente contiene alguna configuración automatizada.
 *
 * @param {number} id_plataforma - ID de la plataforma
 * @returns {object} { success, config: {configuraciones} }
 */
router.post('/configuracionesAutomatizador', async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_plataforma',
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM configuraciones WHERE id_configuracion =?`,
      { replacements: [id_configuracion] }
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          'No se encontró configuración automatizada para esta plataforma ',
      });
    }

    return res.json(rows);
  } catch (err) {
    console.error('Error al obtener configuración:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar configuración.',
      error: error.message,
    });
  }
});

//Segundo paso
router.post('/actualizarConfiguracionMeta', async (req, res) => {
  const {
    id_configuracion,
    id_telefono,
    id_whatsapp,
    token,
    nombre_configuracion,
    telefono,
  } = req.body;

  // Validar que los datos existen y son correctos
  if (
    !id_configuracion ||
    !id_telefono ||
    !id_whatsapp ||
    !token ||
    !nombre_configuracion ||
    !telefono
  ) {
    return res.status(400).json({
      status: 400,
      message: 'Faltan campos obligatorios para actualizar la configuración.',
    });
  }

  try {
    // Actualizar webhook_url en la tabla configuraciones
    const webhook_url =
      'https://new.imporsuitpro.com/public/webhook_whatsapp/webhook_2.php?webhook=wh_czcv54';
    const updateSql = `
    UPDATE configuraciones
    SET 
      id_telefono = ?,
      id_whatsapp = ?,
      webhook_url = ?,
      token = ?,
      updated_at = NOW()
    WHERE id = ? 
  `;
    const [updateResult] = await db.query(updateSql, {
      replacements: [
        id_telefono,
        id_whatsapp,
        webhook_url,
        token,
        id_configuracion,
      ],
    });

    if (updateResult.affectedRows !== 1) {
      return res.status(500).json({
        status: 500,
        message: 'Error al actualizar la configuración.',
      });
    }

    // Insertar cliente en clientes_chat_center
    const insertClienteSql = `
    INSERT INTO clientes_chat_center
      (id_configuracion, uid_cliente, nombre_cliente, celular_cliente)
    VALUES (?, ?, ?, ?)
  `;
    const [insertClienteRes] = await db.query(insertClienteSql, {
      replacements: [
        id_configuracion,
        id_telefono,
        nombre_configuracion,
        telefono,
      ],
    });

    console.log('Resultado de la inserción del cliente:', insertClienteRes); // Verifica el resultado de la inserción

    return res.status(200).json({
      status: 200,
      message: 'Configuración actualizada y cliente insertado correctamente.',
    });
  } catch (error) {
    console.error('Error al actualizar configuración Meta:', error); // Agregar el error completo en los logs
    return res.status(500).json({
      status: 500,
      message: 'Hubo un problema al actualizar la configuración.',
    });
  }
});

/**
 * Función para generar una clave única (similar a la que usabas en PHP).
 * Puede ser con random bytes, un uuid, etc.
 */
function generarClaveUnica() {
  // Aquí un ejemplo con currentTime + random:
  const randomStr = Math.random().toString(36).substring(2, 8);
  return `key_${Date.now()}_${randomStr}`;
}

/**
 * Obtiene la config de la tabla 'configuraciones' según el id.
 *
 * La tabla debe tener columnas: id_plataforma, id_whatsapp, token.
 * Devuelve un objeto { WABA_ID, ACCESS_TOKEN } si encuentra registro.
 */
async function getConfigFromDB(id) {
  try {
    if (id == null) return null; // evita null/undefined
    const idNum = Number(id);
    if (!Number.isInteger(idNum)) return null; // evita valores no numéricos

    const rows = await db.query(
      `
      SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN
      FROM configuraciones
      WHERE id = :id
      LIMIT 1
    `,
      {
        replacements: { id: idNum },
        type: db.QueryTypes.SELECT, // devuelve array de filas
      }
    );

    return rows[0] || null;
  } catch (error) {
    console.error('Error en getConfigById:', error);
    throw error;
  }
}

// router.post('/embeddedSignupComplete', async (req, res) => {
//   const { code, id_plataforma } = req.body;
//   if (!code || !id_plataforma) {
//     return res.status(400).json({ success: false, message: 'Faltan code o id_plataforma.' });
//   }

//   try {
//     /* 1) code → token de System‑User */
//     const t1 = await axios
//       .get('https://graph.facebook.com/v22.0/oauth/access_token', {
//         params: {
//           client_id: process.env.FB_APP_ID,
//           client_secret: process.env.FB_APP_SECRET,
//           code,
//         },
//       })
//       .then(r => r.data);

//     const businessToken = t1.access_token;

//     /* 2) Obtener systemUserId */
//     const systemUserId = await axios
//       .get('https://graph.facebook.com/v22.0/me', {
//         params : { fields: 'id' },
//         headers: { Authorization: `Bearer ${businessToken}` },
//       })
//       .then(r => r.data.id);

//     /* 3) WABA via /system_user_id/whatsapp_business_accounts */
//     const wabaId = await axios
//       .get(`https://graph.facebook.com/v22.0/${systemUserId}/whatsapp_business_accounts`, {
//         headers: { Authorization: `Bearer ${businessToken}` },
//       })
//       .then(r => r.data.data?.[0]?.id);

//     if (!wabaId) {
//       return res.status(400).json({
//         success: false,
//         message: 'El System‑User no posee cuentas de WhatsApp Business.',
//       });
//     }

//     /* 4) Token permanente */
//     const permanentToken = await axios
//       .post(`https://graph.facebook.com/v22.0/${systemUserId}/access_tokens`,
//         null,
//         {
//           params: {
//             app_id: process.env.FB_APP_ID,
//             scope : 'whatsapp_business_management,whatsapp_business_messaging',
//           },
//           headers: { Authorization: `Bearer ${businessToken}` },
//         }
//       )
//       .then(r => r.data.access_token);

//     /* 5) phone_number_id + teléfono */
//     const nums = await axios
//       .get(`https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`, {
//         params : { fields: 'id,display_phone_number' },
//         headers: { Authorization: `Bearer ${permanentToken}` },
//       })
//       .then(r => r.data);

//     const phoneNumberId = nums.data?.[0]?.id;
//     const telefono      = nums.data?.[0]?.display_phone_number;

//     if (!phoneNumberId) {
//       return res.status(400).json({
//         success: false,
//         message: 'No se encontró ningún número dentro del WABA.',
//       });
//     }

//     /* 6) /register + /subscribed_apps */
//     await axios.post(
//       `https://graph.facebook.com/v22.0/${phoneNumberId}/register`,
//       { messaging_product: 'whatsapp' },
//       { headers: { Authorization: `Bearer ${permanentToken}` } }
//     );
//     await axios.post(
//       `https://graph.facebook.com/v22.0/${phoneNumberId}/subscribed_apps`,
//       { messaging_product: 'whatsapp' },
//       { headers: { Authorization: `Bearer ${permanentToken}` } }
//     );

//     /* 7) Guardar en la tabla configuraciones (igual que antes) */
//     const [rows] = await db.query(
//       'SELECT id FROM configuraciones WHERE id_plataforma = ?',
//       { replacements: [id_plataforma] }
//     );

//     if (rows.length) {
//       await db.query(
//         `UPDATE configuraciones SET
//            telefono    = ?,
//            id_telefono = ?,
//            id_whatsapp = ?,
//            token       = ?,
//            updated_at  = NOW()
//          WHERE id_plataforma = ?`,
//         {
//           replacements: [
//             telefono,
//             phoneNumberId,
//             wabaId,
//             permanentToken,
//             id_plataforma,
//           ],
//         }
//       );
//     } else {
//       await db.query(
//         `INSERT INTO configuraciones
//           (id_plataforma, key_imporsuit, nombre_configuracion,
//            telefono, id_telefono, id_whatsapp, token,
//            created_at, updated_at)
//          VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
//         {
//           replacements: [
//             id_plataforma,
//             generarClaveUnica(),
//             'WhatsApp Cloud',
//             telefono,
//             phoneNumberId,
//             wabaId,
//             permanentToken,
//           ],
//         }
//       );
//     }

//     return res.json({ success: true });
//   } catch (err) {
//     console.error(err.response?.data || err);
//     return res.status(400).json({
//       success: false,
//       message: 'Error en la activación.',
//       error  : err.response?.data || err.message,
//     });
//   }
// });

router.post('/embeddedSignupComplete', async (req, res) => {
  const { code, id_usuario } = req.body;

  /* 0. Validación básica */
  if (!code || !id_usuario) {
    return res.status(400).json({
      success: false,
      message: 'Faltan parámetros requeridos (code o id_usuario).',
    });
  }

  /* 1. Intercambiar `code` por token temporal (15 min) */
  let clientToken;
  try {
    const { data } = await axios.get(
      'https://graph.facebook.com/v22.0/oauth/access_token',
      {
        params: {
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          code,
        },
      }
    );
    clientToken = data.access_token; // ← token de 15 min
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: 'Code inválido o expirado.',
      error: err.response?.data || err.message,
    });
  }

  try {
    /* 2. WABA más reciente de tu Business Manager (partner) */
    const waba = await axios(
      'https://graph.facebook.com/v22.0/me/whatsapp_business_accounts',
      { headers: { Authorization: `Bearer ${clientToken}` } }
    ).then((r) => r.data.data?.[0]);

    if (!waba) throw new Error('No se encontró ningún WABA.');
    const wabaId = waba.id;
    const nombreNegocio = waba.name || 'WhatsApp';

    /* 3. Primer teléfono dentro del WABA */
    const num = await axios
      .get(
        `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers?fields=id,display_phone_number,code_verification_status`,
        { headers: { Authorization: `Bearer ${clientToken}` } }
      )
      .then((r) => r.data.data?.[0]);

    const phoneNumberId = num?.id;

    const telefono = num?.display_phone_number
      ?.replace(/\s+/g, '')
      ?.replace('+', '');

    if (!phoneNumberId || !telefono) {
      throw new Error('El WABA no tiene ningún número.');
    }

    /* 4. Registrar (register) – coexistencia QR */
    try {
      await axios.post(
        `https://graph.facebook.com/v22.0/${phoneNumberId}/register`,
        { messaging_product: 'whatsapp' },
        { headers: { Authorization: `Bearer ${clientToken}` } }
      );
    } catch (e) {
      const c = e?.response?.data?.error?.code;
      if (c === 131070) {
        /* ya estaba registrado */
      } else if (c === 131071 || c === 131047) {
        await axios.post(
          `https://graph.facebook.com/v22.0/${phoneNumberId}/register`,
          {
            messaging_product: 'whatsapp',
            pin: '123456',
          },
          { headers: { Authorization: `Bearer ${clientToken}` } }
        );
      } else {
        throw e;
      }
    }

    /* 5. Suscribir tu App */
    await axios.post(
      `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`,
      { messaging_product: 'whatsapp' },
      { headers: { Authorization: `Bearer ${clientToken}` } }
    );

    /* 6. Guardar / actualizar en BD —— (mismo efecto que agregarConfiguracion + actualizarConfiguracionMeta) */
    const key_imporsuit = generarClaveUnica();
    const nombre_configuracion = `${nombreNegocio} - Imporsuit`;
    const permanentPartnerTok = process.env.FB_PROVIDER_TOKEN;
    const webhook_url =
      'https://new.imporsuitpro.com/public/webhook_whatsapp/webhook_2.php?webhook=wh_czcv54';

    /* 6-A · ¿Ya existe config para este usuario + número? */
    const [cfg] = await db.query(
      `SELECT id FROM configuraciones
       WHERE id_usuario = ? AND id_telefono = ?
       LIMIT 1`,
      { replacements: [id_usuario, phoneNumberId] }
    );

    let id_configuracion;
    if (cfg.length) {
      /* UPDATE */
      id_configuracion = cfg[0].id;
      await db.query(
        `UPDATE configuraciones SET
           nombre_configuracion = ?,
           telefono            = ?,
           id_whatsapp         = ?,
           token               = ?,
           webhook_url         = ?,
           updated_at          = NOW()
         WHERE id = ?`,
        {
          replacements: [
            nombre_configuracion,
            telefono,
            wabaId,
            permanentPartnerTok,
            webhook_url,
            id_configuracion,
          ],
        }
      );
    } else {
      /* INSERT */
      const [ins] = await db.query(
        `INSERT INTO configuraciones
           (id_usuario, key_imporsuit, nombre_configuracion,
            telefono, id_telefono, id_whatsapp, token, webhook_url,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        {
          replacements: [
            id_usuario,
            key_imporsuit,
            nombre_configuracion,
            telefono,
            phoneNumberId,
            wabaId,
            permanentPartnerTok,
            webhook_url,
          ],
        }
      );
      id_configuracion = ins.insertId;
    }

    /* 6-B · Asegurar cliente en clientes_chat_center */
    await db.query(
      `INSERT IGNORE INTO clientes_chat_center
         (id_configuracion, uid_cliente, nombre_cliente, celular_cliente)
       VALUES (?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          phoneNumberId,
          nombre_configuracion,
          telefono,
        ],
      }
    );

    /* 7. Éxito */
    return res.json({
      success: true,
      id_configuracion,
      mensaje: 'Cuenta Meta activada y vinculada correctamente.',
    });
  } catch (err) {
    console.error(
      '❌ Error en embedSignupComplete:',
      err.response?.data || err.message
    );
    return res.status(400).json({
      success: false,
      message: 'No se pudo activar el número automáticamente.',
      contacto: 'https://wa.me/593962803007',
      error: err.response?.data || err.message,
    });
  }
});

router.post('/crearPlantillasAutomaticas', async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({ error: 'Falta el id_configuracion.' });
  }

  // Base de plantillas que quieres crear
  const plantillasBase = [
    {
      name: 'zona_entrega',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'HEADER',
          format: 'TEXT',
          text: 'Llego el día de entrega',
        },
        {
          type: 'BODY',
          text: 'Hoy tu pedido ha llegado 📦✅ a {{1}} y está próximo a ser entregado en {{2}}, en el horario de 9 am a 6 pm. ¡Te recordamos tener el valor total de {{3}} en efectivo! Agradecemos estar atento a las llamadas del courier 🚚 Revisa el estado de tu guía aquí {{4}}',
          example: {
            body_text: [
              [
                'Quito',
                'Av. Amazonas 123',
                '$20.00',
                'https://tracking.com/12345',
              ],
            ],
          },
        },
      ],
    },
    {
      name: 'retiro_oficina_servientrega',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: '¡Hola {{1}}! 😊💙\n\nTe cuento que tu pedido de {{2}} está para entrega en la oficina principal de {{3}} en la ciudad de {{4}}.\n\nEl valor a pagar es de: $ {{5}}\nLa guia de transporte es: {{6}}\n\nDebes acercarte a la oficina, recuerda llevar la cédula y este número de guía para que puedan entregarte, si tienes algún inconveniente nos puedes escribir. 😊',
          example: {
            body_text: [
              [
                'Daniel',
                'Zapatos Nike',
                'Servientrega',
                'Guayaquil',
                '50',
                '123456789',
              ],
            ],
          },
        },
      ],
    },
    {
      name: 'en_transito',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'HEADER',
          format: 'TEXT',
          text: '¡Tu pedido está en camino!',
        },
        {
          type: 'BODY',
          text: 'Tu producto, {{1}}, está próximo a ser entregado en {{2}}. El horario estimado de entrega es de 9:00 AM a 6:00 PM.\nTe recordamos tener listo el valor total de {{3}} en efectivo para facilitar la entrega. Además, por favor, mantente atento a las llamadas del courier para cualquier actualización. 🚚📞\n¡Gracias por elegirnos! 😊',
          example: {
            body_text: [
              ['Audífonos Bluetooth', 'Av. Eloy Alfaro 456', '$35.00'],
            ],
          },
        },
      ],
    },
    {
      name: 'novedad',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'HEADER',
          format: 'TEXT',
          text: 'Información Importante',
        },
        {
          type: 'BODY',
          text: 'Hola {{1}} intentamos entregar 🚚 tu pedido {{2}} pero al parecer tuvimos un inconveniente, me podrías confirmar si tuviste algún problema para recibirlo?',
          example: {
            body_text: [['Carlos', 'Laptop HP']],
          },
        },
      ],
    },
    {
      name: 'remarketing_1',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Hola, estamos por enviar los últimos pedidos. 🚛\n\nSolo queremos avisarte que el {{1}} está casi agotado.\n\n Si aún deseas tu pedido, ayúdame con tu ubicación por Google Maps para llegar con mayor facilidad. 📍\n\nRecuerda que es pago contra entrega para tu seguridad.',
          example: {
            body_text: [['Reloj inteligente Xiaomi']],
          },
        },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'QUICK_REPLY', text: 'Confirmar Pedido' }],
        },
      ],
    },
    {
      name: 'confirmacion_de_pedido',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: '😃 Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero Confirmar tus Datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n\n✅ Por favor enviame tu ubicación actual para tener una entrega exitosa.',
          example: {
            body_text: [
              [
                'Daniel',
                'Precio',
                'Corrector',
                'Daniel',
                '098765473',
                'Av. Simón Bolívar y Mariscal Sucre',
              ],
            ],
          },
        },
      ],
    },
    {
      name: 'contacto_inicial',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Hola, estamos enviando los últimos pedidos. 🚛\nNecesito confirmar unos detalles de tu orden.\n\nResponde este mensaje para continuar la conversación.',
        },
      ],
    },
    {
      name: 'generada_chat_center',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: '¡Hola {{1}}, tu envío ha sido procesado con éxito! 👍\nLa entrega se realizará dentro de 24 a 48 horas, el transportista se comunicará contigo para realizar la entrega. Cualquier duda que tengas estoy aquí para ayudarte ✅\nAdicional, tu número de guía es {{2}} y puedes revisar el tracking o descargar tu guía dándole a los botones de aquí abajo. 👇👇',
          example: {
            body_text: [['Sebastian', '1234567890']],
          },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'Descargar guía aquí',
              url: 'https://new.imporsuitpro.com/Pedidos/imprimir_guia/{{1}}',
              example: [
                'https://new.imporsuitpro.com/Pedidos/imprimir_guia/numero_guia',
              ],
            },
            {
              type: 'URL',
              text: 'Ver tracking de guía',
              url: 'https://new.imporsuitpro.com/Pedidos/tracking_guia/{{1}}',
              example: [
                'https://new.imporsuitpro.com/Pedidos/tracking_guia/numero_guia',
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'carritos_abandonados',
      language: 'es',
      category: 'MARKETING',
      components: [
        {
          type: 'BODY',
          text: '🛒 ¡Aún tienes tu pedido de {{1}} pendiente! No dejes que se agote. Completa tu compra ahora y recibe un descuento especial. 👇',
          example: {
            body_text: [['Contiene']],
          },
        },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'QUICK_REPLY', text: 'Completar Compra' }],
        },
      ],
    },
  ];

  try {
    const wabaConfig = await getConfigFromDB(id_configuracion);
    if (!wabaConfig) {
      return res.status(404).json({ error: 'Configuración no encontrada.' });
    }

    const { WABA_ID, ACCESS_TOKEN } = wabaConfig;
    const url = `https://graph.facebook.com/v17.0/${WABA_ID}/message_templates?access_token=${ACCESS_TOKEN}&limit=100`;

    // 1. Obtener plantillas existentes
    const { data } = await axios.get(url);
    const existentes = data.data.map((p) => p.name);

    const results = [];

    // 2. Crear solo las que no existen
    for (const plantilla of plantillasBase) {
      if (existentes.includes(plantilla.name)) {
        results.push({
          nombre: plantilla.name,
          status: 'omitido',
          mensaje: 'La plantilla ya existe en Meta. No fue recreada.',
        });
        continue;
      }

      try {
        const crearUrl = `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates`;
        const response = await axios.post(crearUrl, plantilla, {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        });

        results.push({
          nombre: plantilla.name,
          status: 'success',
          response: response.data,
        });
      } catch (err) {
        results.push({
          nombre: plantilla.name,
          status: 'error',
          error: err.response?.data || err.message,
        });
      }
    }

    res.json({
      success: true,
      mensaje: 'Proceso finalizado. Revisa los estados por cada plantilla.',
      resultados: results,
    });
  } catch (error) {
    console.error(
      'Error general al crear plantillas:',
      error?.response?.data || error.message
    );
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
