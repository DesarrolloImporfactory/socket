const express = require('express');
const axios = require('axios');
const { db } = require('../database/config');
const { error } = require('winston');

const router = express.Router();

/**
 * POST /api/v1/whatsapp_managment/ObtenerNumeros
 *  - Retorna: los phone_numbers desde la Cloud API y  toda su información  relacionada (según la config en DB).
 */
router.post('/ObtenerNumeros', async (req, res) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta id_configuracion' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN
       FROM configuraciones
       WHERE id = ?`,
      { replacements: [id_configuracion] }
    );

    // si no hay registro de configuración, no es error
    if (!rows.length) {
      return res.json({ success: true, data: [] });
    }

    const { WABA_ID, ACCESS_TOKEN } = rows[0];

    // helper para NO lanzar excepción en 401 y manejarlo nosotros
    const ax = axios.create({
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 15000,
      validateStatus: () => true, // <- importantísimo: no lance throw por 4xx/5xx
    });

    // 1) Números
    const numbersUrl = `https://graph.facebook.com/v22.0/${WABA_ID}/phone_numbers`;
    const numbersResp = await ax.get(numbersUrl, {
      params: {
        fields: [
          'id',
          'display_phone_number',
          'verified_name',
          'quality_rating',
          'messaging_limit_tier',
          'status',
        ].join(','),
      },
    });

    // si Meta dice 401/403 (token inválido / sin permisos) -> NO es “cerrar sesión”
    if (numbersResp.status === 401 || numbersResp.status === 403) {
      return res.json({
        success: true,
        data: [],
        hint: 'meta_unauthorized', // opcional por si quieres mostrar algo suave en UI
      });
    }

    // otros 4xx/5xx de Meta: lo tratamos como “sin números”, no como error fatal
    if (numbersResp.status < 200 || numbersResp.status >= 300) {
      return res.json({
        success: true,
        data: [],
        hint: 'meta_error_' + numbersResp.status,
      });
    }

    const numbers = Array.isArray(numbersResp.data?.data)
      ? numbersResp.data.data
      : [];
    if (numbers.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // 2) Perfiles por número en paralelo (cada 401/403 se ignora y se deja profile:null)
    const merged = await Promise.all(
      numbers.map(async (n) => {
        const profileResp = await ax.get(
          `https://graph.facebook.com/v22.0/${n.id}/whatsapp_business_profile`,
          {
            params: {
              fields: [
                'about',
                'description',
                'address',
                'email',
                'vertical',
                'websites',
                'profile_picture_url',
              ].join(','),
            },
          }
        );

        let profile = null;
        if (profileResp.status >= 200 && profileResp.status < 300) {
          // algunos endpoints devuelven { data: [...] } y otros el objeto directo; cubrimos ambos
          profile = profileResp.data?.data ?? profileResp.data ?? null;
        }
        // si 401/403/otros -> dejamos profile=null y seguimos
        return { ...n, profile };
      })
    );

    return res.json({ success: true, data: merged });
  } catch (error) {
    // errores de red/DNS/timeout de nuestro servidor
    return res.status(200).json({
      success: true,
      data: [],
      hint: 'network_error',
      message: 'No se pudo consultar Meta en este momento',
    });
  }
});

//Verificar si existe una conexion de whatsap para un numero directamente en la bd.
router.post('/estadoConexion', async (req, res) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta id_configuracion' });
  }
  try {
    const [rows] = await db.query(
      `SELECT COALESCE(id_telefono,'') id_telefono,
              COALESCE(id_whatsapp,'') id_whatsapp,
              COALESCE(token,'') token,
              COALESCE(telefono,'') telefono
         FROM configuraciones
        WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion] }
    );
    if (!rows.length)
      return res
        .status(404)
        .json({ success: false, message: 'Config no encontrada' });

    const r = rows[0];
    const connectedLike = !!(r.id_telefono && r.id_whatsapp && r.token);
    return res.json({
      success: true,
      connectedLike,
      telefono: r.telefono || null,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Error al consultar config',
      error: e.message,
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

router.put('/editarConfiguracionCalendario', async (req, res) => {
  const { id_template_whatsapp, id_configuracion } = req.body;

  if (!id_template_whatsapp || !id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'Faltan datos requeridos.',
    });
  }

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET template_notificar_calendario = ? WHERE id = ?`,
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
    return res
      .status(400)
      .json({ success: false, message: 'Falta el id_configuracion' });
  }

  try {
    const [rows] = await db.query(
      `SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN
         FROM configuraciones
        WHERE id = ?`,
      { replacements: [id_configuracion] }
    );

    if (!rows.length || !rows[0].WABA_ID || !rows[0].ACCESS_TOKEN) {
      // Sin credenciales: responde 200 y UI entiende “no conectado”
      return res.status(200).json({
        success: true,
        data: [],
        meta: { state: 'NO_CREDENTIALS' },
      });
    }

    const { WABA_ID, ACCESS_TOKEN } = rows[0];
    const url = `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates`;

    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 15000,
    });

    return res.json({ success: true, ...data, meta: { state: 'OK' } });
  } catch (error) {
    const code = error?.response?.data?.error?.code;
    if (code === 190) {
      // Token inválido → tratar como no conectado, no forzar logout
      return res.status(200).json({
        success: true,
        data: [],
        meta: { state: 'INVALID_TOKEN' },
      });
    }
    const http = error.response?.status || 500;
    return res.status(http).json({
      success: false,
      error: true,
      message:
        http === 401 ? 'No autorizado por Meta' : 'Error de la API de WhatsApp',
      response: error.response?.data || null,
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
      'https://chat.imporfactory.app/api/v1/webhook_meta/webhook_whatsapp?webhook=wh_clfgshu99';
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
//   const { code, id_usuario, redirect_uri, id_configuracion } = req.body;

//   if (!code || !id_usuario) {
//     return res.status(400).json({
//       success: false,
//       message: 'Faltan parámetros requeridos (code o id_usuario).',
//     });
//   }

//   // ====== CONSTANTES/ENV OBLIGATORIOS ======
//   const EXACT_REDIRECT_URI =
//     (typeof redirect_uri === 'string' && redirect_uri.trim()) ||
//     process.env.FB_LOGIN_REDIRECT_URI ||
//     'https://chatcenter.imporfactory.app/conexiones';

//   const DEFAULT_TWOFA_PIN = '123456';
//   const SYS_TOKEN = process.env.FB_PROVIDER_TOKEN; // System User con permisos WA sobre el Business/WABA
//   const APP_TOKEN = `${process.env.FB_APP_ID}|${process.env.FB_APP_SECRET}`;
//   const BUSINESS_ID = process.env.FB_BUSINESS_ID; // <<--- EL MISMO QUE USAS A MANO

//   if (!SYS_TOKEN || !BUSINESS_ID) {
//     return res.status(400).json({
//       success: false,
//       message: 'Faltan FB_PROVIDER_TOKEN o FB_BUSINESS_ID en el entorno.',
//     });
//   }

//   console.log('[EMB][IN]', {
//     id_usuario,
//     id_configuracion: id_configuracion || '(none)',
//     redirect_uri: EXACT_REDIRECT_URI,
//     code_len: (code || '').length,
//     BUSINESS_ID,
//   });

//   // ====== HELPERS ======
//   const bearer = (tk) => ({ Authorization: `Bearer ${tk}` });
//   const norm = (s) =>
//     String(s || '')
//       .replace(/\s+/g, '')
//       .replace(/^\+/, '');

//   async function safeGet(url, params = {}, headers = {}) {
//     try {
//       return await axios.get(url, { params, headers });
//     } catch (e) {
//       console.log(
//         '[GET][ERR]',
//         url,
//         e?.response?.status,
//         e?.response?.data || e.message
//       );
//       throw e;
//     }
//   }
//   async function safePost(url, body = {}, headers = {}) {
//     try {
//       return await axios.post(url, body, { headers });
//     } catch (e) {
//       console.log(
//         '[POST][ERR]',
//         url,
//         e?.response?.status,
//         e?.response?.data || e.message
//       );
//       throw e;
//     }
//   }

//   // ====== 1) Intercambiar code → access token (formalidad) ======
//   let clientToken;
//   try {
//     console.log('[OAUTH] exchange WITH redirect_uri');
//     const r = await axios.get(
//       'https://graph.facebook.com/v22.0/oauth/access_token',
//       {
//         params: {
//           client_id: process.env.FB_APP_ID,
//           client_secret: process.env.FB_APP_SECRET,
//           code,
//           redirect_uri: EXACT_REDIRECT_URI,
//         },
//       }
//     );
//     clientToken = r.data?.access_token;
//   } catch (eWith) {
//     console.log(
//       '[OAUTH][ERR with redirect_uri]',
//       eWith?.response?.data || eWith.message
//     );
//     try {
//       console.log('[OAUTH] exchange WITHOUT redirect_uri (fallback)');
//       const r2 = await axios.get(
//         'https://graph.facebook.com/v22.0/oauth/access_token',
//         {
//           params: {
//             client_id: process.env.FB_APP_ID,
//             client_secret: process.env.FB_APP_SECRET,
//             code,
//           },
//         }
//       );
//       clientToken = r2.data?.access_token;
//     } catch (eNo) {
//       return res.status(400).json({
//         success: false,
//         message: 'No se pudo activar el número (intercambio de code).',
//         error: eNo?.response?.data || eNo.message,
//       });
//     }
//   }

//   try {
//     if (!clientToken)
//       throw new Error('No se obtuvo access token a partir del code');

//     // ====== 2) Obtener WABA exactamente como tu “manual” ======
//     // Manual: GET /{BUSINESS_ID}/client_whatsapp_business_accounts con SYS_TOKEN → tomar PRIMERO
//     const wabasResp = await safeGet(
//       `https://graph.facebook.com/v22.0/${BUSINESS_ID}/client_whatsapp_business_accounts`,
//       {},
//       bearer(SYS_TOKEN)
//     );
//     const wabas = wabasResp.data?.data || [];
//     if (!wabas.length) {
//       // Por si el WABA fuera "owned" en este business en lugar de "client"
//       const ownedResp = await safeGet(
//         `https://graph.facebook.com/v22.0/${BUSINESS_ID}/owned_whatsapp_business_accounts`,
//         {},
//         bearer(SYS_TOKEN)
//       ).catch(() => ({ data: { data: [] } }));
//       const owned = ownedResp?.data?.data || [];
//       wabas.push(...owned);
//     }
//     if (!wabas.length)
//       throw new Error(
//         `El Business ${BUSINESS_ID} no tiene WABAs visibles para el SYS_TOKEN`
//       );

//     const wabaPicked = wabas[0]; // EXACTO: el primero, como haces a mano (ej: guiaspro)
//     const wabaId = String(wabaPicked.id);
//     console.log('[WABA][PICK]', { wabaId, wabaName: wabaPicked.name });

//     // ====== 3) Listar números del WABA y elegir uno ======
//     // Manual: GET /{wabaId}/phone_numbers → tomar el primero (o no-CONNECTED)
//     let numbers = [];
//     try {
//       const pn = await safeGet(
//         `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
//         { fields: 'id,display_phone_number,status,code_verification_status' },
//         bearer(SYS_TOKEN)
//       );
//       numbers = pn.data?.data || [];
//     } catch (e1) {
//       console.log('[NUMBERS][WARN] SYS_TOKEN falló; reintento con clientToken');
//       const pn2 = await safeGet(
//         `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
//         { fields: 'id,display_phone_number,status,code_verification_status' },
//         bearer(clientToken)
//       );
//       numbers = pn2.data?.data || [];
//     }

//     if (!numbers.length)
//       throw new Error('El WABA no tiene números cargados todavía');

//     let candidate =
//       numbers.find((n) => (n.status || '').toUpperCase() !== 'CONNECTED') ||
//       numbers[0];

//     const phoneNumberId = candidate?.id || null;
//     const displayNumber = norm(candidate?.display_phone_number);
//     console.log('[PHONE][PICK]', {
//       phoneNumberId,
//       displayNumber,
//       status: candidate?.status,
//       cvs: candidate?.code_verification_status,
//     });
//     if (!phoneNumberId)
//       throw new Error('phoneNumberId indefinido luego de /phone_numbers');

//     // ====== 4) Registrar el número (REGISTER) ======
//     const regUrl = `https://graph.facebook.com/v22.0/${phoneNumberId}/register`;
//     console.log('[POST][REGISTER] ->', regUrl);
//     try {
//       await safePost(
//         regUrl,
//         { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
//         bearer(SYS_TOKEN)
//       );
//     } catch (e1) {
//       // reintento con clientToken
//       console.log(
//         '[POST][REGISTER][WARN] SYS_TOKEN falló; retry con clientToken'
//       );
//       try {
//         await safePost(
//           regUrl,
//           { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
//           bearer(clientToken)
//         );
//       } catch (e2) {
//         const codeErr = e2?.response?.data?.error?.code;
//         if (codeErr === 131070) {
//           console.log('[REGISTER] ya estaba registrado (131070)');
//         } else if (codeErr === 131071 || codeErr === 131047) {
//           await safePost(
//             regUrl,
//             { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
//             bearer(clientToken)
//           );
//         } else {
//           throw e2;
//         }
//       }
//     }

//     // ====== 5) Suscribir app al WABA ======
//     const subUrl = `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`;
//     console.log('[POST][SUBSCRIBE] ->', subUrl);
//     try {
//       await safePost(
//         subUrl,
//         { messaging_product: 'whatsapp' },
//         bearer(SYS_TOKEN)
//       );
//     } catch (e1) {
//       console.log(
//         '[POST][SUBSCRIBE][WARN] SYS_TOKEN falló; retry con clientToken'
//       );
//       await safePost(
//         subUrl,
//         { messaging_product: 'whatsapp' },
//         bearer(clientToken)
//       );
//     }

//     // ====== 6) Verificar estado del número ======
//     let info = {};
//     try {
//       const r1 = await safeGet(
//         `https://graph.facebook.com/v22.0/${phoneNumberId}`,
//         {
//           fields:
//             'id,display_phone_number,status,code_verification_status,quality_rating,verified_name',
//         },
//         bearer(SYS_TOKEN)
//       );
//       info = r1.data || {};
//     } catch (e1) {
//       console.log('[PN-INFO][WARN] SYS_TOKEN falló; retry con clientToken');
//       const r2 = await safeGet(
//         `https://graph.facebook.com/v22.0/${phoneNumberId}`,
//         {
//           fields:
//             'id,display_phone_number,status,code_verification_status,quality_rating,verified_name',
//         },
//         bearer(clientToken)
//       );
//       info = r2.data || {};
//     }

//     const nombre_configuracion = `${
//       info?.verified_name || 'WhatsApp'
//     } - Imporsuit`;
//     const webhook_url =
//       'https://chat.imporfactory.app/api/v1/webhook_meta/webhook_whatsapp?webhook=wh_clfgshu99';
//     const permanentPartnerTok = SYS_TOKEN;
//     const key_imporsuit = generarClaveUnica();

//     // ====== 7) Persistir (igual que tu lógica) ======
//     let idConfigToUse = id_configuracion || null;

//     if (!idConfigToUse) {
//       const [preRows] = await db.query(
//         `SELECT id
//            FROM configuraciones
//           WHERE id_usuario = ?
//             AND (id_telefono IS NULL OR id_telefono = '')
//             AND (telefono = ? OR telefono IS NULL OR telefono = '')
//           ORDER BY id DESC
//           LIMIT 1`,
//         { replacements: [id_usuario, displayNumber] }
//       );
//       if (Array.isArray(preRows) && preRows.length) {
//         idConfigToUse = preRows[0].id;
//         console.log('[DB] Usando config pre-creada id=', idConfigToUse);
//       }
//     }

//     if (!idConfigToUse) {
//       const [matchRows] = await db.query(
//         `SELECT id
//            FROM configuraciones
//           WHERE id_usuario = ?
//             AND id_telefono = ?
//           LIMIT 1`,
//         { replacements: [id_usuario, phoneNumberId] }
//       );
//       if (Array.isArray(matchRows) && matchRows.length) {
//         idConfigToUse = matchRows[0].id;
//         console.log(
//           '[DB] Usando config existente por id_usuario+id_telefono id=',
//           idConfigToUse
//         );
//       }
//     }

//     if (idConfigToUse) {
//       await db.query(
//         `UPDATE configuraciones SET
//            key_imporsuit        = IFNULL(key_imporsuit, ?),
//            telefono             = ?,
//            id_telefono          = ?,
//            id_whatsapp          = ?,
//            token                = ?,
//            webhook_url          = ?,
//            updated_at           = NOW()
//          WHERE id = ?`,
//         {
//           replacements: [
//             key_imporsuit,
//             displayNumber,
//             phoneNumberId, // PHONE_NUMBER_ID
//             wabaId, // WABA_ID
//             permanentPartnerTok,
//             webhook_url,
//             idConfigToUse,
//           ],
//         }
//       );
//     } else {
//       const [ins] = await db.query(
//         `INSERT INTO configuraciones
//            (id_usuario, key_imporsuit, nombre_configuracion,
//             telefono, id_telefono, id_whatsapp, token, webhook_url,
//             created_at, updated_at)
//          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
//         {
//           replacements: [
//             id_usuario,
//             key_imporsuit,
//             nombre_configuracion,
//             displayNumber,
//             phoneNumberId,
//             wabaId,
//             permanentPartnerTok,
//             webhook_url,
//           ],
//         }
//       );
//       idConfigToUse = ins?.insertId || ins;
//       console.log('[DB] Insertada nueva config id=', idConfigToUse);
//     }

//     await db.query(
//       `INSERT IGNORE INTO clientes_chat_center
//          (id_configuracion, uid_cliente, nombre_cliente, celular_cliente)
//        VALUES (?, ?, ?, ?)`,
//       {
//         replacements: [
//           idConfigToUse,
//           phoneNumberId,
//           nombre_configuracion,
//           displayNumber,
//         ],
//       }
//     );

//     return res.json({
//       success: true,
//       id_configuracion: idConfigToUse,
//       waba_id: wabaId,
//       phone_number_id: phoneNumberId,
//       telefono: displayNumber,
//       status: info?.status || null,
//     });
//   } catch (err) {
//     console.error(
//       '❌ embeddedSignupComplete:',
//       err?.response?.data || err.message
//     );
//     return res.status(400).json({
//       success: false,
//       message: 'No se pudo activar el número automáticamente.',
//       error: err?.response?.data || err.message,
//     });
//   }
// });

router.post('/embeddedSignupComplete', async (req, res) => {
  const { code, id_usuario, redirect_uri, id_configuracion } = req.body;

  if (!code || !id_usuario) {
    return res.status(400).json({
      success: false,
      message: 'Faltan parámetros requeridos (code o id_usuario).',
    });
  }

  // ====== CONSTANTES/ENV OBLIGATORIOS ======
  // 1) Declarar lista blanca EXACTA (debe coincidir con lo configurado en Meta)
  const ALLOWED_REDIRECTS = new Set([
    'https://chatcenter.imporfactory.app/conexiones',
    'https://chatcenter.imporfactory.app/administrador-canales',
  ]);

  // 2) Normalizador básico: origin + pathname, sin barra final
  const normalize = (url) => {
    try {
      const u = new URL(String(url));
      return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return null;
    }
  };

  // 3) Elegir redirect_uri seguro: si viene del frontend y está en whitelist, úselo;
  //    si no, caiga al ENV o al default '/conexiones'.
  const pickRedirect = (input) => {
    const envDefault = (
      process.env.FB_LOGIN_REDIRECT_URI ||
      'https://chatcenter.imporfactory.app/conexiones'
    ).trim();

    const candidate = normalize(input) || normalize(envDefault);
    const fallback =
      normalize(envDefault) || 'https://chatcenter.imporfactory.app/conexiones';

    return ALLOWED_REDIRECTS.has(candidate) ? candidate : fallback;
  };

  const EXACT_REDIRECT_URI = pickRedirect(redirect_uri);

  const DEFAULT_TWOFA_PIN = '123456';
  const SYS_TOKEN = process.env.FB_PROVIDER_TOKEN; // System User con permisos WA sobre el Business/WABA
  const APP_TOKEN = `${process.env.FB_APP_ID}|${process.env.FB_APP_SECRET}`;
  const BUSINESS_ID = process.env.FB_BUSINESS_ID; // <<--- EL MISMO QUE USAS A MANO

  if (!SYS_TOKEN || !BUSINESS_ID) {
    return res.status(400).json({
      success: false,
      message: 'Faltan FB_PROVIDER_TOKEN o FB_BUSINESS_ID en el entorno.',
    });
  }

  console.log('[EMB][IN]', {
    id_usuario,
    id_configuracion: id_configuracion || '(none)',
    redirect_uri_in: redirect_uri || '(none)',
    redirect_uri_picked: EXACT_REDIRECT_URI,
    code_len: (code || '').length,
    BUSINESS_ID,
  });

  // ====== HELPERS ======
  const bearer = (tk) => ({ Authorization: `Bearer ${tk}` });
  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, '')
      .replace(/^\+/, '');

  async function safeGet(url, params = {}, headers = {}) {
    try {
      return await axios.get(url, { params, headers });
    } catch (e) {
      console.log(
        '[GET][ERR]',
        url,
        e?.response?.status,
        e?.response?.data || e.message
      );
      throw e;
    }
  }
  async function safePost(url, body = {}, headers = {}) {
    try {
      return await axios.post(url, body, { headers });
    } catch (e) {
      console.log(
        '[POST][ERR]',
        url,
        e?.response?.status,
        e?.response?.data || e.message
      );
      throw e;
    }
  }

  // ====== 1) Intercambiar code → access token (formalidad) ======
  let clientToken;
  try {
    console.log('[OAUTH] exchange WITH redirect_uri');
    const r = await axios.get(
      'https://graph.facebook.com/v22.0/oauth/access_token',
      {
        params: {
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          code,
          redirect_uri: EXACT_REDIRECT_URI, // ← usamos el elegido y validado
        },
      }
    );
    clientToken = r.data?.access_token;
  } catch (eWith) {
    console.log(
      '[OAUTH][ERR with redirect_uri]',
      eWith?.response?.data || eWith.message
    );
    try {
      console.log('[OAUTH] exchange WITHOUT redirect_uri (fallback)');
      const r2 = await axios.get(
        'https://graph.facebook.com/v22.0/oauth/access_token',
        {
          params: {
            client_id: process.env.FB_APP_ID,
            client_secret: process.env.FB_APP_SECRET,
            code,
          },
        }
      );
      clientToken = r2.data?.access_token;
    } catch (eNo) {
      return res.status(400).json({
        success: false,
        message: 'No se pudo activar el número (intercambio de code).',
        error: eNo?.response?.data || eNo.message,
      });
    }
  }

  try {
    if (!clientToken)
      throw new Error('No se obtuvo access token a partir del code');

    // ====== 2) Obtener WABA exactamente como tu “manual” ======
    const wabasResp = await safeGet(
      `https://graph.facebook.com/v22.0/${BUSINESS_ID}/client_whatsapp_business_accounts`,
      {},
      bearer(SYS_TOKEN)
    );
    const wabas = wabasResp.data?.data || [];
    if (!wabas.length) {
      const ownedResp = await safeGet(
        `https://graph.facebook.com/v22.0/${BUSINESS_ID}/owned_whatsapp_business_accounts`,
        {},
        bearer(SYS_TOKEN)
      ).catch(() => ({ data: { data: [] } }));
      const owned = ownedResp?.data?.data || [];
      wabas.push(...owned);
    }
    if (!wabas.length)
      throw new Error(
        `El Business ${BUSINESS_ID} no tiene WABAs visibles para el SYS_TOKEN`
      );

    const wabaPicked = wabas[0];
    const wabaId = String(wabaPicked.id);
    console.log('[WABA][PICK]', { wabaId, wabaName: wabaPicked.name });

    // ====== 3) Listar números del WABA y elegir uno ======
    let numbers = [];
    try {
      const pn = await safeGet(
        `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
        { fields: 'id,display_phone_number,status,code_verification_status' },
        bearer(SYS_TOKEN)
      );
      numbers = pn.data?.data || [];
    } catch (e1) {
      console.log('[NUMBERS][WARN] SYS_TOKEN falló; reintento con clientToken');
      const pn2 = await safeGet(
        `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
        { fields: 'id,display_phone_number,status,code_verification_status' },
        bearer(clientToken)
      );
      numbers = pn2.data?.data || [];
    }

    if (!numbers.length)
      throw new Error('El WABA no tiene números cargados todavía');

    let candidate =
      numbers.find((n) => (n.status || '').toUpperCase() !== 'CONNECTED') ||
      numbers[0];

    const phoneNumberId = candidate?.id || null;
    const displayNumber = norm(candidate?.display_phone_number);
    console.log('[PHONE][PICK]', {
      phoneNumberId,
      displayNumber,
      status: candidate?.status,
      cvs: candidate?.code_verification_status,
    });
    if (!phoneNumberId)
      throw new Error('phoneNumberId indefinido luego de /phone_numbers');

    // ====== 4) Registrar el número (REGISTER) ======
    const regUrl = `https://graph.facebook.com/v22.0/${phoneNumberId}/register`;
    console.log('[POST][REGISTER] ->', regUrl);
    try {
      await safePost(
        regUrl,
        { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
        bearer(SYS_TOKEN)
      );
    } catch (e1) {
      console.log(
        '[POST][REGISTER][WARN] SYS_TOKEN falló; retry con clientToken'
      );
      try {
        await safePost(
          regUrl,
          { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
          bearer(clientToken)
        );
      } catch (e2) {
        const codeErr = e2?.response?.data?.error?.code;
        if (codeErr === 131070) {
          console.log('[REGISTER] ya estaba registrado (131070)');
        } else if (codeErr === 131071 || codeErr === 131047) {
          await safePost(
            regUrl,
            { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
            bearer(clientToken)
          );
        } else {
          throw e2;
        }
      }
    }

    // ====== 5) Suscribir app al WABA ======
    const subUrl = `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`;
    console.log('[POST][SUBSCRIBE] ->', subUrl);
    try {
      await safePost(
        subUrl,
        { messaging_product: 'whatsapp' },
        bearer(SYS_TOKEN)
      );
    } catch (e1) {
      console.log(
        '[POST][SUBSCRIBE][WARN] SYS_TOKEN falló; retry con clientToken'
      );
      await safePost(
        subUrl,
        { messaging_product: 'whatsapp' },
        bearer(clientToken)
      );
    }

    // ====== 6) Verificar estado del número ======
    let info = {};
    try {
      const r1 = await safeGet(
        `https://graph.facebook.com/v22.0/${phoneNumberId}`,
        {
          fields:
            'id,display_phone_number,status,code_verification_status,quality_rating,verified_name',
        },
        bearer(SYS_TOKEN)
      );
      info = r1.data || {};
    } catch (e1) {
      console.log('[PN-INFO][WARN] SYS_TOKEN falló; retry con clientToken');
      const r2 = await safeGet(
        `https://graph.facebook.com/v22.0/${phoneNumberId}`,
        {
          fields:
            'id,display_phone_number,status,code_verification_status,quality_rating,verified_name',
        },
        bearer(clientToken)
      );
      info = r2.data || {};
    }

    const nombre_configuracion = `${
      info?.verified_name || 'WhatsApp'
    } - Imporsuit`;
    const webhook_url =
      'https://chat.imporfactory.app/api/v1/webhook_meta/webhook_whatsapp?webhook=wh_clfgshu99';
    const permanentPartnerTok = SYS_TOKEN;
    const key_imporsuit = generarClaveUnica();

    // ====== 7) Persistir (igual que tu lógica) ======
    let idConfigToUse = id_configuracion || null;

    if (!idConfigToUse) {
      const [preRows] = await db.query(
        `SELECT id
           FROM configuraciones
          WHERE id_usuario = ?
            AND (id_telefono IS NULL OR id_telefono = '')
            AND (telefono = ? OR telefono IS NULL OR telefono = '')
          ORDER BY id DESC
          LIMIT 1`,
        { replacements: [id_usuario, displayNumber] }
      );
      if (Array.isArray(preRows) && preRows.length) {
        idConfigToUse = preRows[0].id;
        console.log('[DB] Usando config pre-creada id=', idConfigToUse);
      }
    }

    if (!idConfigToUse) {
      const [matchRows] = await db.query(
        `SELECT id
           FROM configuraciones
          WHERE id_usuario = ?
            AND id_telefono = ?
          LIMIT 1`,
        { replacements: [id_usuario, phoneNumberId] }
      );
      if (Array.isArray(matchRows) && matchRows.length) {
        idConfigToUse = matchRows[0].id;
        console.log(
          '[DB] Usando config existente por id_usuario+id_telefono id=',
          idConfigToUse
        );
      }
    }

    if (idConfigToUse) {
      await db.query(
        `UPDATE configuraciones SET
           key_imporsuit        = IFNULL(key_imporsuit, ?),
           telefono             = ?,
           id_telefono          = ?,
           id_whatsapp          = ?,
           token                = ?,
           webhook_url          = ?,
           updated_at           = NOW()
         WHERE id = ?`,
        {
          replacements: [
            key_imporsuit,
            displayNumber,
            phoneNumberId, // PHONE_NUMBER_ID
            wabaId, // WABA_ID
            permanentPartnerTok,
            webhook_url,
            idConfigToUse,
          ],
        }
      );
    } else {
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
            displayNumber,
            phoneNumberId,
            wabaId,
            permanentPartnerTok,
            webhook_url,
          ],
        }
      );
      idConfigToUse = ins?.insertId || ins;
      console.log('[DB] Insertada nueva config id=', idConfigToUse);
    }

    await db.query(
      `INSERT IGNORE INTO clientes_chat_center
         (id_configuracion, uid_cliente, nombre_cliente, celular_cliente)
       VALUES (?, ?, ?, ?)`,
      {
        replacements: [
          idConfigToUse,
          phoneNumberId,
          nombre_configuracion,
          displayNumber,
        ],
      }
    );

    return res.json({
      success: true,
      id_configuracion: idConfigToUse,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      telefono: displayNumber,
      status: info?.status || null,
    });
  } catch (err) {
    console.error(
      '❌ embeddedSignupComplete:',
      err?.response?.data || err.message
    );
    return res.status(400).json({
      success: false,
      message: 'No se pudo activar el número automáticamente.',
      error: err?.response?.data || err.message,
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
          text: 'Hoy tu pedido ha llegado 📦✅ a {{1}} y está próximo a ser entregado en {{2}}, en el horario de 9 am a 6 pm. ¡Te recordamos tener el valor total de {{3}} en efectivo! Agradecemos estar atento a las llamadas del courier 🚚 Revisa el estado de tu guía aquí {{4}} 😊.',
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
