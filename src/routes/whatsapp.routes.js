// whatsapp.routes.js
const express = require('express');
const axios = require('axios');
const { db } = require('../database/config');

const router = express.Router();

/**
 * POST /api/v1/whatsapp_managment/ObtenerNumeros
 *  - Recibe: id_plataforma
 *  - Retorna: los phone_numbers desde la Cloud API (según la config en DB).
 */
router.post('/ObtenerNumeros', async (req, res) => {
  try {
    const { id_plataforma } = req.body;

    const wabaConfig = await getConfigFromDB(id_plataforma);
    if (!wabaConfig) {
      return res.status(404).json({
        error: 'No se encontraron registros para la plataforma dada.',
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
 * - Recibe: id_plataforma y datos de la plantilla (name, language, category, components)
 * - Envía una solicitud a la Cloud API para crear una plantilla.
 */
router.post('/CrearPlantilla', async (req, res) => {
  try {
    const { id_plataforma, name, language, category, components } = req.body;

    if (!id_plataforma || !name || !language || !category || !components) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    const wabaConfig = await getConfigFromDB(id_plataforma);
    if (!wabaConfig) {
      return res
        .status(404)
        .json({ error: 'No se encontró configuración para esta plataforma.' });
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
  const { id_plataforma } = req.body;

  if (!id_plataforma) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_plataforma.',
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM templates_chat_center WHERE id_plataforma = ${id_plataforma}`
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
 * @param {int} id_plataforma - Plataforma a la que pertenece la plantilla
 * @return {object} status 200 | 500
 */
router.post('/crearPlantillaRapida', async (req, res) => {
  const { atajo, mensaje, id_plataforma } = req.body;

  try {
    if ((!id_plataforma, !atajo, !mensaje)) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos.',
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
 * @param {number} id_plataforma - ID de la plataforma (opcional si se extrae de token/session)
 *
 * @returns {object} status 200 | 500
 *
 * @example Body JSON:
 * {
 *   "id_template_whatsapp": "greeting_template_01",
 *   "id_plataforma": 12
 * }
 */
router.put('/editarConfiguracion', async (req, res) => {
  const { id_template_whatsapp, id_plataforma } = req.body;

  if (!id_template_whatsapp || !id_plataforma) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos requeridos.',
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET template_generar_guia = ? WHERE id_plataforma = ?`,
      {
        replacements: [id_template_whatsapp, id_plataforma],
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
  const { id_plataforma } = req.body;

  /* 1. Validación mínima */
  if (!id_plataforma) {
    return res.status(400).json({
      error: true,
      message: 'Falta el id_plataforma.',
    });
  }

  try {
    /* 2. Configuración de la plataforma */
    const [rows] = await db.query(
      'SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN \
       FROM configuraciones \
       WHERE id_plataforma = ?',
      { replacements: [id_plataforma] }
    );

    if (!rows.length) {
      return res.status(404).json({
        error: true,
        message: 'No se encontró configuración para esta plataforma.',
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
 * de la tabla `configuraciones` según el id_plataforma.
 *
 * @param {number} id_plataforma - ID de la plataforma
 * @returns {object} { success, config: { template_generar_guia } }
 */
router.post('/obtenerConfiguracion', async (req, res) => {
  const { id_plataforma } = req.body;

  if (!id_plataforma) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_plataforma.',
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT COALESCE(template_generar_guia, '') AS template_generar_guia 
       FROM configuraciones 
       WHERE id_plataforma = ?`,
      { replacements: [id_plataforma] }
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
  const { id_plataforma } = req.body;

  if (!id_plataforma) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_plataforma',
    });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM configuraciones WHERE id_plataforma =?`,
      { replacements: [id_plataforma] }
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

/**
 * POST /api/v1/whatsapp_managment/agregarConfiguracion
 *
 * Insertar en `configuraciones`,
 * actualizar `webhook_url` y luego insertar en `clientes_chat_center`.
 *
 * @param {string} nombre_configuracion
 * @param {string} telefono
 * @param {string} id_telefono
 * @param {string} id_whatsapp
 * @param {string} token
 * @param {number} id_plataforma
 *
 * @return {object} {status: 200|500, message: string}
 */
router.post('/agregarConfiguracion', async (req, res) => {
  const {
    nombre_configuracion,
    telefono,
    id_telefono,
    id_whatsapp,
    token,
    id_plataforma,
  } = req.body;

  // Validaciones básicas
  if (
    !nombre_configuracion ||
    !telefono ||
    !id_telefono ||
    !id_whatsapp ||
    !token ||
    !id_plataforma
  ) {
    return res.status(400).json({
      status: 400,
      message: 'Faltan campos obligatorios para agregar configuración.',
    });
  }

  try {
    // 1. Generamos la clave única key_imporsuit
    const key_imporsuit = generarClaveUnica();

    // 2. Insertamos en `configuraciones`
    const insertSql = `
      INSERT INTO configuraciones
        (id_plataforma, nombre_configuracion, telefono, id_telefono, id_whatsapp, token, key_imporsuit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const [insertResult] = await db.query(insertSql, {
      replacements: [
        id_plataforma,
        nombre_configuracion,
        telefono,
        id_telefono,
        id_whatsapp,
        token,
        key_imporsuit,
      ],
    });

    const webhook_url =
      'https://new.imporsuitpro.com/public/webhook_whatsapp/webhook_2.php?webhook=wh_czcv54';

    const updateSql = `
      UPDATE configuraciones
      SET webhook_url = ?
      WHERE key_imporsuit = ?
    `;
    const [updateResult] = await db.query(updateSql, {
      replacements: [webhook_url, key_imporsuit],
    });

    if (updateResult.affectedRows !== 1) {
      return res.status(500).json({
        status: 500,
        title: 'Error en actualización',
        message: 'Hubo un problema al actualizar la configuración.',
      });
    }

    // 4. Insertamos un registro en `clientes_chat_center`
    //    con el uid_cliente = id_telefono
    const insertClienteSql = `
      INSERT INTO clientes_chat_center
        (id_plataforma, uid_cliente, nombre_cliente, celular_cliente)
      VALUES (?, ?, ?, ?)
    `;
    const [insertClienteRes] = await db.query(insertClienteSql, {
      replacements: [
        id_plataforma,
        id_telefono,
        nombre_configuracion,
        telefono,
      ],
    });

    return res.status(200).json({
      status: 200,
      title: 'Petición exitosa',
      message: 'Configuración agregada y actualizada correctamente.',
    });
  } catch (error) {
    console.error('Error al agregar configuración:', error);
    return res.status(500).json({
      title: 'Error interno',
      message: 'Hubo un problema al agregar la configuración.',
      error: error.message,
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
    console.error('Error en getConfigFromDB:', error);
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
  const { code, id_plataforma } = req.body;
  if (!code || !id_plataforma) {
    return res.status(400).json({
      success: false,
      message: 'Faltan parámetros requeridos (code o id_plataforma).',
    });
  }

  try {
    // 1. Intercambiar code por token temporal del cliente
    const { data: tokenResp } = await axios.get('https://graph.facebook.com/v22.0/oauth/access_token', {
      params: {
        client_id: process.env.FB_APP_ID,
        client_secret: process.env.FB_APP_SECRET,
        code,
      },
    });

    const clientToken = tokenResp.access_token;

    // 2. Obtener todos los WABA que tiene vinculados este proveedor
    const wabas = await axios.get(
      `https://graph.facebook.com/v22.0/${process.env.FB_BUSINESS_ID}/client_whatsapp_business_accounts`,
      { headers: { Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}` } }
    ).then(r => r.data.data);

    if (!wabas?.length) {
      throw new Error('No se encontraron cuentas de WhatsApp Business.');
    }

    const wabaSeleccionado = wabas[0]; // El más reciente por comportamiento real de Meta
    const wabaId = wabaSeleccionado.id;

    // 3. Obtener el número de teléfono vinculado a ese WABA
    const numero = await axios.get(`https://graph.facebook.com/v22.0/${wabaId}/phone_numbers?fields=id,display_phone_number`, {
      headers: { Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}` },
    }).then(r => r.data.data?.[0]);

    const phoneNumberId = numero?.id;
    const telefono = numero?.display_phone_number?.replace(/\s+/g, '');

    if (!phoneNumberId || !telefono) {
      throw new Error('No se pudo obtener el número de teléfono asociado al WABA.');
    }

    // 4. Activar (register)
    await axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/register`, {
      messaging_product: 'whatsapp',
    }, {
      headers: {
        Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}`,
      },
    });

    // 5. Subscribir la app (subscribed_apps)
    await axios.post(`https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`, {
      messaging_product: 'whatsapp',
      pin: "123456"
    }, {
      headers: {
        Authorization: `Bearer ${process.env.FB_PROVIDER_TOKEN}`,
      },
    });

    // 6. Guardar en base de datos
    const key_imporsuit = generarClaveUnica();
    const nombre_configuracion = `WhatsApp - ${telefono}`;

    await db.query(`
      INSERT INTO configuraciones
        (id_plataforma, nombre_configuracion, telefono, id_telefono, id_whatsapp, token, key_imporsuit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, {
      replacements: [
        id_plataforma,
        nombre_configuracion,
        telefono,
        phoneNumberId,
        wabaId,
        process.env.FB_PROVIDER_TOKEN,
        key_imporsuit,
      ],
    });

    await db.query(`
      UPDATE configuraciones
      SET webhook_url = ?
      WHERE key_imporsuit = ?
    `, {
      replacements: [
        'https://new.imporsuitpro.com/public/webhook_whatsapp/webhook_2.php?webhook=wh_czcv54',
        key_imporsuit,
      ],
    });

    await db.query(`
      INSERT INTO clientes_chat_center
        (id_plataforma, uid_cliente, nombre_cliente, celular_cliente)
      VALUES (?, ?, ?, ?)
    `, {
      replacements: [id_plataforma, phoneNumberId, nombre_configuracion, telefono],
    });

    return res.json({ success: true });

  } catch (err) {
    console.error('❌ Error en activación automática:', err.response?.data || err.message);
    return res.status(400).json({
      success: false,
      message: 'Ocurrió un error al activar tu número de WhatsApp automáticamente. Por favor comunícate con nosotros vía WhatsApp para completar la activación manualmente.',
      contacto: 'https://wa.me/593962803007',
      error: err.response?.data || err.message,
    });
  }
});



module.exports = router;
