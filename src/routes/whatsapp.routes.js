const express = require('express');
const axios = require('axios');
const { db } = require('../database/config');
const { error } = require('winston');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const FormData = require('form-data');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const whatsappCtrl = require('../controllers/whatsapp.controller');

// Detectar ffmpeg automáticamente (funciona en Windows/Linux/Mac)
// Si ffmpeg está en el PATH del sistema, lo usará automáticamente

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 110 * 1024 * 1024 }, // 110MB para margen (doc 100MB)
});

const FB_APP_ID = process.env.FB_APP_ID;

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
       WHERE id = ? AND suspendido = 0`,
      { replacements: [id_configuracion] },
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
      const metaErr = numbersResp.data?.error || null;

      // si es rate limit específico de WhatsApp (80008), lo marcamos
      const isRateLimit = metaErr?.code === 80008;

      return res.status(200).json({
        success: true,
        data: [],
        hint: isRateLimit
          ? 'meta_rate_limited'
          : `meta_error_${numbersResp.status}`,

        // motivo
        meta_error: metaErr
          ? {
              http_status: numbersResp.status,
              code: metaErr.code,
              type: metaErr.type,
              message: metaErr.message,
              fbtrace_id: metaErr.fbtrace_id,

              // opcional: ayuda mucho para debugging (si existen)
              error_subcode: metaErr.error_subcode,
              error_user_title: metaErr.error_user_title,
              error_user_msg: metaErr.error_user_msg,
            }
          : {
              http_status: numbersResp.status,
              message: 'Meta devolvió un error sin cuerpo estándar',
            },

        // opcional: headers útiles para rate limit / diagnóstico
        meta_headers: {
          'x-app-usage': numbersResp.headers?.['x-app-usage'],
          'x-business-use-case-usage':
            numbersResp.headers?.['x-business-use-case-usage'],
          'retry-after': numbersResp.headers?.['retry-after'],
        },
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
          },
        );

        let profile = null;
        if (profileResp.status >= 200 && profileResp.status < 300) {
          // algunos endpoints devuelven { data: [...] } y otros el objeto directo; cubrimos ambos
          profile = profileResp.data?.data ?? profileResp.data ?? null;
        }
        // si 401/403/otros -> dejamos profile=null y seguimos
        return { ...n, profile };
      }),
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
        WHERE id = ? AND suspendido = 0 LIMIT 1`,
      { replacements: [id_configuracion] },
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
 * Flujo basado en ejemplos públicos donde la respuesta devuelve "h" y eso se usa en header_handle. :contentReference[oaicite:5]{index=5}
 */
async function uploadResumableAndGetHandle({
  accessToken,
  fileBuffer,
  mimeType,
  fileName,
}) {
  if (!FB_APP_ID) {
    throw new Error('Falta FB_APP_ID');
  }

  const ax = axios.create({
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 30000,
    validateStatus: () => true,
  });

  // 1) Crear sesión de subida (upload session)
  const startUrl = `https://graph.facebook.com/v22.0/${FB_APP_ID}/uploads`;
  const startResp = await ax.post(startUrl, null, {
    params: {
      file_length: fileBuffer.length,
      file_type: mimeType,
      file_name: fileName,
    },
  });

  if (startResp.status < 200 || startResp.status >= 300) {
    throw new Error(
      `No se pudo iniciar upload session: ${startResp.status} ${JSON.stringify(startResp.data)}`,
    );
  }

  const uploadSessionId = startResp.data?.id;
  if (!uploadSessionId) {
    throw new Error(`Upload session sin id: ${JSON.stringify(startResp.data)}`);
  }

  // 2) Subir binario
  const uploadUrl = `https://graph.facebook.com/v22.0/${uploadSessionId}`;
  const uploadResp = await axios.post(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      file_offset: '0',
    },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (uploadResp.status < 200 || uploadResp.status >= 300) {
    throw new Error(
      `No se pudo subir archivo: ${uploadResp.status} ${JSON.stringify(uploadResp.data)}`,
    );
  }

  // En ejemplos, se usa "h" como handle para header_handle. :contentReference[oaicite:6]{index=6}
  const handle = uploadResp.data?.h;
  if (!handle) {
    throw new Error(
      `Respuesta sin handle (h): ${JSON.stringify(uploadResp.data)}`,
    );
  }

  return handle;
}

/**
 * POST /api/v1/whatsapp_managment/CrearPlantilla
 * Acepta:
 * - JSON normal (sin archivo)
 * - multipart/form-data (con headerFile)
 */
router.post(
  '/CrearPlantilla',
  upload.single('headerFile'),
  async (req, res) => {
    try {
      // multipart => todo viene como string
      const id_configuracion = req.body.id_configuracion;
      const name = req.body.name;
      const language = req.body.language;
      const category = req.body.category;

      let components = req.body.components;
      if (typeof components === 'string') {
        components = JSON.parse(components);
      }

      if (!id_configuracion || !name || !language || !category || !components) {
        return res
          .status(400)
          .json({ success: false, error: 'Faltan campos obligatorios.' });
      }

      const wabaConfig = await getConfigFromDB(id_configuracion);
      if (!wabaConfig) {
        return res
          .status(404)
          .json({ success: false, error: 'No se encontró configuración.' });
      }

      const { WABA_ID, ACCESS_TOKEN } = wabaConfig;

      // Si viene archivo, subimos y lo convertimos en header_handle
      if (req.file) {
        const mimeType = req.file.mimetype || 'application/octet-stream';
        const fileName =
          req.file.originalname ||
          `header${path.extname(req.file.originalname || '')}`;

        const handle = await uploadResumableAndGetHandle({
          accessToken: ACCESS_TOKEN,
          fileBuffer: req.file.buffer,
          mimeType,
          fileName,
        });

        // Injectar example.header_handle en el HEADER de media
        components = components.map((c) => {
          if (
            c?.type === 'HEADER' &&
            ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c?.format)
          ) {
            return {
              ...c,
              example: { header_handle: [handle] },
            };
          }
          return c;
        });
      }

      const url = `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates`;

      const payload = { name, language, category, components };

      const response = await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        return res.status(200).json({
          success: false,
          meta_status: response.status,
          error: response.data,
        });
      }

      return res.json({ success: true, data: response.data });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || 'Error interno',
      });
    }
  },
);

/**
 * Ruta: POST /api/v1/whatsapp_managment/obtenerRespuestasRapidas
 * @param {number} req.body.id_configuracion
 */
router.post('/obtenerRespuestasRapidas', async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      success: false,
      message: 'Falta el id_configuracion.',
    });
  }

  try {
    const rows = await db.query(
      `SELECT *
       FROM templates_chat_center
       WHERE id_configuracion = ?
       ORDER BY id_template DESC`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    // rows YA ES UN ARRAY
    return res.json({
      success: true,
      data: rows,
    });
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
 * Permite registrar una plantilla de respuesta rápida
 * @param {string} atajo
 * @param {string} mensaje
 * @param {int} id_configuracion
 * @param {string} tipo_mensaje  (text|audio|image|video|document)  [opcional]
 * @param {string} ruta_archivo  [opcional - obligatorio si tipo != text]
 * @param {string} mime_type     [opcional]
 * @param {string} file_name     [opcional]
 */
router.post('/crearPlantillaRapida', async (req, res) => {
  const {
    atajo,
    mensaje,
    id_configuracion,
    tipo_mensaje = 'text',
    ruta_archivo = null,
    mime_type = null,
    file_name = null,
  } = req.body;

  try {
    if (!id_configuracion || !atajo) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos.',
      });
    }

    const tipo = String(tipo_mensaje || 'text')
      .toLowerCase()
      .trim();
    const tiposOk = ['text', 'audio', 'image', 'video', 'document'];

    if (!tiposOk.includes(tipo)) {
      return res.status(400).json({
        success: false,
        message: 'tipo_mensaje inválido. Use: text|audio|image|video|document',
      });
    }

    // Si NO es texto, debe venir ruta_archivo
    if (tipo !== 'text' && (!ruta_archivo || !String(ruta_archivo).trim())) {
      return res.status(400).json({
        success: false,
        message: 'ruta_archivo es obligatorio cuando tipo_mensaje no es text.',
      });
    }

    // Si es texto, asegure ruta_archivo null (limpieza)
    const rutaFinal = tipo === 'text' ? null : String(ruta_archivo).trim();

    const [result] = await db.query(
      `INSERT INTO templates_chat_center
        (atajo, mensaje, id_configuracion, tipo_mensaje, ruta_archivo, mime_type, file_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          atajo,
          mensaje ?? '',
          id_configuracion,
          tipo,
          rutaFinal,
          mime_type,
          file_name,
        ],
        type: db.QueryTypes.INSERT,
      },
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
      },
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
      },
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
      },
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
      },
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
      },
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
      },
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
        WHERE id = ? AND suspendido = 0`,
      { replacements: [id_configuracion] },
    );

    if (!rows.length || !rows[0].WABA_ID || !rows[0].ACCESS_TOKEN) {
      // Sin credenciales: responde 200 y UI entiende “no conectado”
      return res.status(200).json({
        success: true,
        data: [],
        meta: { state: 'NO_CREDENTIALS' },
      });
    }

    //Leer cursores y limite del body
    const { WABA_ID, ACCESS_TOKEN } = rows[0];
    const { after, before, limit: limitRaw } = req.body || {};
    const limit = Math.min(Math.max(parseInt(limitRaw || 50, 10), 1), 100);

    //construir querystring con after/before/limit
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set('after', after);
    if (before) params.set('before', before);

    const url = `https://graph.facebook.com/v22.0/${WABA_ID}/message_templates?${params.toString()}`;

    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 15000,
    });

    return res.json({
      success: true,
      ...data,
      meta: { state: 'OK', page_limit: limit },
    });
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
       WHERE id = ? AND suspendido = 0`,
      { replacements: [id_configuracion] },
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
      `SELECT * FROM configuraciones WHERE id =? AND suspendido = 0`,
      { replacements: [id_configuracion] },
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

async function upsertOwnerByConfig({
  id_configuracion,
  uid_cliente = null,
  nombre_cliente = null,
  celular_cliente = null,
  source = 'owner',
  page_id = null,
  external_id = null,
  id_plataforma = null,
}) {
  // 1) Buscar propietario existente (único por config)
  const [owner] = await db.query(
    `SELECT id
       FROM clientes_chat_center
      WHERE id_configuracion = ?
        AND propietario = 1
        AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  // 2) Si existe -> actualizar
  if (owner?.id) {
    await db.query(
      `UPDATE clientes_chat_center
          SET uid_cliente     = COALESCE(?, uid_cliente),
              nombre_cliente  = COALESCE(?, nombre_cliente),
              celular_cliente = COALESCE(?, celular_cliente),
              source          = COALESCE(?, source),
              page_id         = COALESCE(?, page_id),
              external_id     = COALESCE(?, external_id),
              id_plataforma   = COALESCE(?, id_plataforma),
              updated_at      = NOW()
        WHERE id = ?`,
      {
        replacements: [
          uid_cliente,
          nombre_cliente,
          celular_cliente,
          source,
          page_id,
          external_id,
          id_plataforma,
          owner.id,
        ],
      },
    );

    return owner.id;
  }

  // 3) Si no existe -> crear
  const [ins] = await db.query(
    `INSERT INTO clientes_chat_center
      (id_configuracion, id_plataforma, uid_cliente, nombre_cliente, celular_cliente,
       propietario, source, page_id, external_id, created_at, updated_at)
     VALUES
      (?, ?, ?, ?, ?, 1, ?, ?, ?, NOW(), NOW())`,
    {
      replacements: [
        id_configuracion,
        id_plataforma,
        uid_cliente,
        nombre_cliente,
        celular_cliente,
        source,
        page_id,
        external_id,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  return ins?.insertId ?? ins;
}

//Segundo paso si el caso es manualmente.
router.post('/actualizarConfiguracionMeta', async (req, res) => {
  const {
    id_configuracion,
    id_telefono,
    id_whatsapp,
    token,
    nombre_configuracion,
    telefono,
  } = req.body;

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

    // ✅ PROPIETARIO ÚNICO POR CONFIG: si existe -> UPDATE, si no -> INSERT
    const ownerId = await upsertOwnerByConfig({
      id_configuracion,
      uid_cliente: id_telefono, // WA phone_number_id
      nombre_cliente: nombre_configuracion,
      celular_cliente: telefono, // display
      source: 'owner', // o 'wa_owner' si quiere
      page_id: null,
      external_id: null,
      id_plataforma: null,
    });

    return res.status(200).json({
      status: 200,
      owner_id: ownerId,
      message:
        'Configuración actualizada y cliente propietario insertado/actualizado correctamente.',
    });
  } catch (error) {
    console.error('Error al actualizar configuración Meta:', error);
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
      SELECT 
            id_whatsapp AS WABA_ID, 
            token AS ACCESS_TOKEN,
            id_telefono AS PHONE_NUMBER_ID
      FROM configuraciones
      WHERE suspendido = 0 AND id = :id
      LIMIT 1
    `,
      {
        replacements: { id: idNum },
        type: db.QueryTypes.SELECT, // devuelve array de filas
      },
    );

    return rows[0] || null;
  } catch (error) {
    console.error('Error en getConfigById:', error);
    throw error;
  }
}

router.post('/embeddedSignupComplete', async (req, res) => {
  const {
    code,
    id_usuario,
    redirect_uri,
    id_configuracion,
    display_number_onboarding,
  } = req.body;

  // ==== Validación requerida
  if (!code || !id_usuario || !display_number_onboarding) {
    return res.status(400).json({
      success: false,
      message:
        'Faltan parámetros requeridos: code, id_usuario y display_number_onboarding son obligatorios.',
    });
  }

  // ====== CONSTANTES/ENV OBLIGATORIOS ======
  const ALLOWED_REDIRECTS = new Set([
    'https://chatcenter.imporfactory.app/conexiones',
    'https://chatcenter.imporfactory.app/administrador-canales',
  ]);

  const normalize = (url) => {
    try {
      const u = new URL(String(url));
      return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return null;
    }
  };

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
  const SYS_TOKEN = process.env.FB_PROVIDER_TOKEN; // System User
  const BUSINESS_ID = process.env.FB_BUSINESS_ID;

  if (!SYS_TOKEN || !BUSINESS_ID) {
    return res.status(400).json({
      success: false,
      message: 'Faltan FB_PROVIDER_TOKEN o FB_BUSINESS_ID en el entorno.',
    });
  }

  // Log limpio
  console.log('[EMB][IN]', {
    id_usuario,
    id_configuracion: id_configuracion || '(none)',
    redirect_uri_in: redirect_uri || '(none)',
    redirect_uri_picked: EXACT_REDIRECT_URI,
    code_len: (code || '').length,
    BUSINESS_ID,
    display_number_onboarding: display_number_onboarding || '(none)',
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
        e?.response?.data || e.message,
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
        e?.response?.data || e.message,
      );
      throw e;
    }
  }

  // ====== 1) Intercambiar code → access token ======
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
          redirect_uri: EXACT_REDIRECT_URI,
        },
      },
    );
    clientToken = r.data?.access_token;
  } catch (eWith) {
    console.log(
      '[OAUTH][ERR with redirect_uri]',
      eWith?.response?.data || eWith.message,
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
        },
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

    // ====== 2) Obtener WABAs visibles ======
    console.log('[WABA][FETCH] Obteniendo WABAs (client/owned)…');

    const wabas = [];

    try {
      const clientResp = await safeGet(
        `https://graph.facebook.com/v22.0/${BUSINESS_ID}/client_whatsapp_business_accounts`,
        {},
        bearer(SYS_TOKEN),
      );
      wabas.push(...(clientResp.data?.data || []));
    } catch (e) {
      console.log(
        '[WABA][WARN] No se pudieron obtener client_wabas:',
        e?.response?.data || e.message,
      );
    }

    try {
      const ownedResp = await safeGet(
        `https://graph.facebook.com/v22.0/${BUSINESS_ID}/owned_whatsapp_business_accounts`,
        {},
        bearer(SYS_TOKEN),
      );
      wabas.push(...(ownedResp.data?.data || []));
    } catch (e) {
      console.log(
        '[WABA][WARN] No se pudieron obtener owned_wabas:',
        e?.response?.data || e.message,
      );
    }

    if (!wabas.length) {
      throw new Error(
        `❌ No se encontraron WABAs visibles para el BUSINESS_ID: ${BUSINESS_ID}`,
      );
    }

    // ====== 3) Selección del número (SOLO por display_number_onboarding) ======
    let wabaPicked = null;
    let phoneNumberId = null;
    let displayNumber = null;
    let matchedPhone = null;

    const displayWanted = norm(display_number_onboarding || '');

    async function fetchPhonesOf(wabaId) {
      const r = await safeGet(
        `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
        { fields: 'id,display_phone_number,status,code_verification_status' },
        bearer(SYS_TOKEN),
      );
      return r?.data?.data || [];
    }

    console.log('[SELECT][TRY] display_number_onboarding:', displayWanted);
    for (const waba of wabas) {
      try {
        const phones = await fetchPhonesOf(waba.id);
        const match = phones.find(
          (p) => norm(p.display_phone_number) === displayWanted,
        );
        if (match) {
          matchedPhone = match;
          wabaPicked = waba;
          phoneNumberId = String(match.id);
          displayNumber = norm(match.display_phone_number);
          console.log('[SELECT][MATCH][DISPLAY]', {
            wabaId: waba.id,
            wabaName: waba.name,
            phoneNumberId,
            displayNumber,
            status: match.status,
          });
          break;
        }
      } catch (e) {
        console.log(
          `[SELECT][WARN] WABA ${waba.id} phones:`,
          e?.response?.data || e.message,
        );
      }
    }

    if (!wabaPicked || !phoneNumberId) {
      throw new Error(
        `No se encontró el display_number_onboarding=${displayWanted} en los WABAs visibles.`,
      );
    }

    const wabaId = String(wabaPicked.id);

    // ====== 4) Registrar el número (REGISTER) ======
    // ✅ REGLA: Si el número ya está CONNECTED (coexistencia), NO hacemos register y seguimos.
    const regUrl = `https://graph.facebook.com/v22.0/${phoneNumberId}/register`;
    const matchedStatus = String(matchedPhone?.status || '').toUpperCase();

    if (matchedStatus === 'CONNECTED') {
      console.log(
        '[REGISTER][SKIP] Número ya CONNECTED. No se ejecuta /register.',
      );
    } else {
      console.log('[POST][REGISTER] ->', regUrl, 'pin:', DEFAULT_TWOFA_PIN);
      try {
        await safePost(
          regUrl,
          { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
          bearer(SYS_TOKEN),
        );
        console.log('[REGISTER][OK] con SYS_TOKEN');
      } catch (e1) {
        console.log(
          '[POST][REGISTER][WARN] SYS_TOKEN falló; retry con clientToken',
        );
        try {
          await safePost(
            regUrl,
            { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
            bearer(clientToken),
          );
          console.log('[REGISTER][OK] con clientToken');
        } catch (e2) {
          const codeErr = e2?.response?.data?.error?.code;
          if (codeErr === 131070) {
            console.log('[REGISTER] ya estaba registrado (131070)');
          } else if (codeErr === 131071 || codeErr === 131047) {
            await safePost(
              regUrl,
              { messaging_product: 'whatsapp', pin: DEFAULT_TWOFA_PIN },
              bearer(clientToken),
            );
            console.log('[REGISTER][RETRY_OK] por estado intermedio');
          } else {
            throw e2;
          }
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
        bearer(SYS_TOKEN),
      );
      console.log('[SUBSCRIBE][OK] con SYS_TOKEN');
    } catch (e1) {
      console.log(
        '[POST][SUBSCRIBE][WARN] SYS_TOKEN falló; retry con clientToken',
      );
      await safePost(
        subUrl,
        { messaging_product: 'whatsapp' },
        bearer(clientToken),
      );
      console.log('[SUBSCRIBE][OK] con clientToken');
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
        bearer(SYS_TOKEN),
      );
      info = r1.data || {};
      console.log('[PN-INFO][OK] con SYS_TOKEN');
    } catch (e1) {
      console.log('[PN-INFO][WARN] SYS_TOKEN falló; retry con clientToken');
      const r2 = await safeGet(
        `https://graph.facebook.com/v22.0/${phoneNumberId}`,
        {
          fields:
            'id,display_phone_number,status,code_verification_status,quality_rating,verified_name',
        },
        bearer(clientToken),
      );
      info = r2.data || {};
      console.log('[PN-INFO][OK] con clientToken');
    }

    const nombre_configuracion = `${
      info?.verified_name || 'WhatsApp'
    } - Imporsuit`;
    const webhook_url =
      'https://chat.imporfactory.app/api/v1/webhook_meta/webhook_whatsapp?webhook=wh_clfgshu99';
    const permanentPartnerTok = SYS_TOKEN;
    const key_imporsuit = generarClaveUnica();

    // ====== 7) Persistencia ======
    let idConfigToUse = id_configuracion || null;

    if (!idConfigToUse) {
      const [preRows] = await db.query(
        `SELECT id
           FROM configuraciones
          WHERE suspendido = 0 AND id_usuario = ?
            AND (id_telefono IS NULL OR id_telefono = '')
            AND (telefono = ? OR telefono IS NULL OR telefono = '')
          ORDER BY id DESC
          LIMIT 1`,
        { replacements: [id_usuario, displayNumber] },
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
            AND suspendido = 0
          LIMIT 1`,
        { replacements: [id_usuario, phoneNumberId] },
      );
      if (Array.isArray(matchRows) && matchRows.length) {
        idConfigToUse = matchRows[0].id;
        console.log(
          '[DB] Usando config existente por id_usuario+id_telefono id=',
          idConfigToUse,
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
            phoneNumberId,
            wabaId,
            permanentPartnerTok,
            webhook_url,
            idConfigToUse,
          ],
        },
      );
      console.log('[DB] UPDATE configuraciones OK');
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
        },
      );
      idConfigToUse = ins?.insertId || ins;
      console.log('[DB] INSERT configuraciones OK id=', idConfigToUse);
    }

    // ✅ CAMBIO: UPSERT en vez de INSERT IGNORE
    // ✅ PROPIETARIO ÚNICO POR CONFIG: si existe -> UPDATE, si no -> INSERT
    const ownerId = await upsertOwnerByConfig({
      id_configuracion: idConfigToUse,
      uid_cliente: phoneNumberId, // phone_number_id
      nombre_cliente: nombre_configuracion,
      celular_cliente: displayNumber, // display_phone_number
      source: 'owner', // o 'wa_owner'
      page_id: null,
      external_id: null,
      id_plataforma: null,
    });

    console.log('[DB] OWNER UPSERT (by config) OK. ownerId=', ownerId);

    return res.json({
      success: true,
      id_configuracion: idConfigToUse,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      telefono: displayNumber,
      status: info?.status || null,
      matched_by: 'display_number_onboarding',
    });
  } catch (err) {
    console.error(
      '❌ embeddedSignupComplete:',
      err?.response?.data || err.message,
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
      name: 'confirmacion_de_pedido_rapido',
      language: 'es',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Hola {{1}}, Acabo de recibir tu pedido de compra por el valor de ${{2}}\nQuiero confirmar tus datos de envío:\n\n✅Producto: {{3}}\n👤Nombre: {{4}}\n📱Teléfono: {{5}}\n📍Dirección: {{6}}\n\n Por favor, selecciona *CONFIRMAR PEDIDO* si tus datos son correctos ✅, o *ACTUALIZAR INFORMACIÓN* para corregirlos antes de proceder con el envío de tu producto.🚚',
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
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'CONFIRMAR PEDIDO' },
            { type: 'QUICK_REPLY', text: 'ACTUALIZAR INFORMACIÓN' },
          ],
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
          text: '¡Hola {{1}}, tu envío ha sido procesado con éxito! 👍\nLa entrega se realizará dentro de 3 a 4 días, el transportista se comunicará contigo para realizar la entrega. Cualquier duda que tengas estoy aquí para ayudarte ✅\nAdicional, tu número de guía es {{2}} y puedes revisar el tracking o descargar tu guía dándole a los botones de aquí abajo. 👇👇',
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
      error?.response?.data || error.message,
    );
    res.status(500).json({ error: error.message });
  }
});

async function getConfigForCoex(id_configuracion) {
  const [rows] = await db.query(
    `SELECT 
        id AS id_configuracion,
        id_telefono,
        token,
        sincronizo_coexistencia
     FROM configuraciones
     WHERE id = ? AND suspendido = 0
     LIMIT 1`,
    { replacements: [id_configuracion] },
  );

  return rows?.[0] || null;
}

async function updateConfigSyncFlag(id_configuracion, value) {
  const v = value ? 1 : 0;

  const [result] = await db.query(
    `UPDATE configuraciones
     SET sincronizo_coexistencia = ?, updated_at = NOW()
     WHERE id = ?
     LIMIT 1`,
    { replacements: [v, id_configuracion] },
  );

  return result;
}

function parseMetaError(metaData) {
  const err = metaData?.error;
  if (!err) return null;

  const code = err?.code;
  const subcode = err?.error_subcode;
  const message = String(err?.message || '');

  // 131000: no es número de WhatsApp Business App (coexistencia)
  if (code === 131000 || message.includes('(#131000)')) {
    return {
      http: 400,
      status: 'not_coexistence_number',
      mensaje:
        'Este número no es compatible con Coexistencia. La sincronización solo aplica a números vinculados desde WhatsApp Business App.',
    };
  }

  // Token inválido / expirado
  if (code === 190) {
    return {
      http: 401,
      status: 'token_invalid',
      mensaje:
        'La sesión con Meta expiró o el token es inválido. Vuelva a vincular el número e intente nuevamente.',
    };
  }

  // Permisos / app no autorizada
  if (
    code === 10 ||
    code === 200 ||
    message.toLowerCase().includes('permission')
  ) {
    return {
      http: 403,
      status: 'permission_denied',
      mensaje:
        'Meta rechazó la solicitud por permisos. Verifique que el número esté correctamente vinculado y que la app tenga permisos de WhatsApp.',
    };
  }

  // Rate limit / “Application request limit reached”
  if (code === 4 || message.toLowerCase().includes('rate')) {
    return {
      http: 429,
      status: 'rate_limited',
      mensaje:
        'Meta está limitando solicitudes en este momento. Intente nuevamente en unos minutos.',
    };
  }

  // Fallback genérico
  return {
    http: 400,
    status: 'cannot_sync',
    mensaje:
      'No fue posible realizar la sincronización en este momento. Por favor, vuelva a vincular el número e intente nuevamente.',
  };
}

router.post('/coexistencia/sync', async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({ error: 'Falta el id_configuracion.' });
  }

  try {
    const cfg = await getConfigForCoex(id_configuracion);

    if (!cfg) {
      return res
        .status(404)
        .json({ error: 'Configuración no encontrada o suspendida.' });
    }

    // ✅ Si ya está marcado, NO llamar a Meta
    if (Number(cfg.sincronizo_coexistencia) === 1) {
      return res.json({
        success: true,
        status: 'already_synced',
        mensaje:
          'La sincronización ya fue realizada previamente para este número.',
      });
    }

    const phoneNumberId = cfg.id_telefono;
    const ACCESS_TOKEN = cfg.token;

    if (!phoneNumberId || !ACCESS_TOKEN) {
      return res.status(400).json({
        success: false,
        status: 'missing_data',
        mensaje: 'Falta id_telefono o token en la configuración.',
      });
    }

    const endpoint = `https://graph.facebook.com/v22.0/${phoneNumberId}/smb_app_data`;

    const ax = axios.create({
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 15000,
      validateStatus: () => true,
    });

    const callSync = async (sync_type) => {
      const resp = await ax.post(endpoint, {
        messaging_product: 'whatsapp',
        sync_type,
      });

      // resp.data puede ser success o error
      return resp;
    };

    // Helper para detectar el code 4 en cualquier respuesta
    const isCode4 = (data) => data?.error?.code === 4;

    // 1) smb_app_state_sync
    const resp1 = await callSync('smb_app_state_sync');

    // Si Meta dice "ya lo hiciste" -> marcar 1 y responder sutil
    if (isCode4(resp1.data)) {
      await updateConfigSyncFlag(id_configuracion, 1);

      return res.status(200).json({
        success: true,
        status: 'already_done_by_meta',
        mensaje:
          'Este número ya realizó la sincronización. No es necesario repetir el proceso.',
        meta: resp1.data,
      });
    }

    // Si falla por cualquier motivo (resp1)
    if (
      !(resp1.status >= 200 && resp1.status < 300) ||
      resp1.data?.success !== true
    ) {
      const mapped = parseMetaError(resp1.data);

      return res.status(mapped?.http || 400).json({
        success: false,
        status: mapped?.status || 'cannot_sync',
        mensaje:
          mapped?.mensaje || 'No fue posible realizar la sincronización.',
        meta: resp1.data,
      });
    }

    // 2) history
    const resp2 = await callSync('history');

    if (isCode4(resp2.data)) {
      await updateConfigSyncFlag(id_configuracion, 1);

      return res.status(200).json({
        success: true,
        status: 'already_done_by_meta',
        mensaje:
          'Este número ya realizó la sincronización. No es necesario repetir el proceso.',
        meta: resp2.data,
      });
    }

    if (
      !(resp2.status >= 200 && resp2.status < 300) ||
      resp2.data?.success !== true
    ) {
      const mapped = parseMetaError(resp2.data);

      return res.status(mapped?.http || 400).json({
        success: false,
        status: mapped?.status || 'cannot_sync',
        mensaje:
          mapped?.mensaje || 'No fue posible completar la sincronización.',
        meta: resp2.data,
      });
    }

    // ✅ Si ambas OK -> marcar 1
    await updateConfigSyncFlag(id_configuracion, 1);

    return res.json({
      success: true,
      status: 'synced',
      mensaje: 'Sincronización realizada correctamente.',
      meta: {
        smb_app_state_sync: resp1.data,
        history: resp2.data,
      },
    });
  } catch (error) {
    console.error(
      'Error en coexistencia/sync:',
      error?.response?.data || error.message,
    );

    return res.status(500).json({
      success: false,
      status: 'server_error',
      mensaje: 'Error interno al procesar la sincronización.',
      error: error.message,
    });
  }
});

router.post('/enviarAudio', upload.single('audio'), async (req, res) => {
  try {
    const { id_configuracion, to } = req.body;

    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta id_configuracion' });
    }
    if (!to) {
      return res.status(400).json({
        success: false,
        message: 'Falta el campo to (destinatario)',
      });
    }
    if (!req.file?.buffer) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta el archivo audio' });
    }

    const cfg = await getConfigFromDB(id_configuracion);
    if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID) {
      return res.status(404).json({
        success: false,
        message: 'Config no encontrada o incompleta',
      });
    }

    const { ACCESS_TOKEN, PHONE_NUMBER_ID } = cfg;

    // ========= 1) Subir media a Meta =========
    const mediaUrl = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/media`;

    const mimeType = req.file.mimetype || 'audio/ogg';
    const fileName = req.file.originalname || `audio-${Date.now()}.ogg`;

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', req.file.buffer, {
      filename: fileName,
      contentType: mimeType,
    });

    const mediaResp = await axios.post(mediaUrl, form, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...form.getHeaders(),
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    if (
      mediaResp.status < 200 ||
      mediaResp.status >= 300 ||
      mediaResp.data?.error
    ) {
      return res.status(200).json({
        success: false,
        step: 'upload_media',
        meta_status: mediaResp.status,
        error: mediaResp.data?.error || mediaResp.data,
      });
    }

    const mediaId = mediaResp.data?.id;
    if (!mediaId) {
      return res.status(200).json({
        success: false,
        step: 'upload_media',
        meta_status: mediaResp.status,
        error: 'Meta no devolvió media_id',
        raw: mediaResp.data,
      });
    }

    // ========= 2) Enviar mensaje por id =========
    const msgUrl = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'audio',
      audio: { id: mediaId },
    };

    const msgResp = await axios.post(msgUrl, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    if (msgResp.status < 200 || msgResp.status >= 300 || msgResp.data?.error) {
      return res.status(200).json({
        success: false,
        step: 'send_message',
        meta_status: msgResp.status,
        mediaId,
        error: msgResp.data?.error || msgResp.data,
      });
    }

    const wamid = msgResp.data?.messages?.[0]?.id || null;

    return res.json({
      success: true,
      mediaId,
      wamid,
      meta: {
        upload: mediaResp.data,
        send: msgResp.data,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error interno enviando audio',
      error: error?.message,
    });
  }
});

/**
 * POST /enviarAudioCompleto
 *
 * Endpoint unificado que:
 * 1. Recibe audio en cualquier formato desde el front
 * 2. Convierte a OGG OPUS (formato WhatsApp)
 * 3. Sube a Meta y obtiene media_id
 * 4. Envía el mensaje de audio por WhatsApp
 * 5. Guarda en AWS (uploader) y retorna la URL
 *
 * Body:
 *  - id_configuracion: ID de configuración WhatsApp
 *  - to: destinatario del mensaje
 * Form-data:
 *  - audio: archivo de audio (cualquier formato)
 */
router.post(
  '/enviarAudioCompleto',
  upload.single('audio'),
  async (req, res) => {
    try {
      const { id_configuracion, to } = req.body;

      // Validaciones
      if (!id_configuracion) {
        return res.status(400).json({
          success: false,
          message: 'Falta id_configuracion',
        });
      }
      if (!to) {
        return res.status(400).json({
          success: false,
          message: 'Falta el campo to (destinatario)',
        });
      }
      if (!req.file?.buffer) {
        return res.status(400).json({
          success: false,
          message: 'Falta el archivo audio',
        });
      }

      // Obtener config de WhatsApp
      const cfg = await getConfigFromDB(id_configuracion);
      if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID) {
        return res.status(404).json({
          success: false,
          message: 'Config no encontrada o incompleta',
        });
      }

      const { ACCESS_TOKEN, PHONE_NUMBER_ID } = cfg;

      // ========= PASO 1: Convertir audio a OGG OPUS =========
      console.log('🎵 Paso 1: Convirtiendo audio a OGG OPUS...');

      const inputStream = new PassThrough();
      inputStream.end(req.file.buffer);

      const outputStream = new PassThrough();
      const chunks = [];

      const conversionPromise = new Promise((resolve, reject) => {
        let ffmpegProcess;
        let resolved = false;

        outputStream.on('data', (chunk) => chunks.push(chunk));

        outputStream.on('end', () => {
          if (!resolved) {
            resolved = true;
            const convertedBuffer = Buffer.concat(chunks);
            console.log(
              `✅ Audio convertido: ${(convertedBuffer.length / 1024).toFixed(2)} KB`,
            );
            resolve(convertedBuffer);
          }
        });

        outputStream.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });

        ffmpegProcess = ffmpeg(inputStream)
          .audioCodec('libopus')
          .audioBitrate('128k') // Bitrate estable y compatible
          .audioFrequency(48000) // 48kHz es óptimo para Opus
          .audioChannels(1) // Mono
          .format('ogg')
          .outputOptions([
            '-vbr on', // Variable bitrate
            '-compression_level 10', // Máxima calidad
          ])
          .on('start', (cmdline) => {
            console.log('🔧 FFmpeg command:', cmdline);
          })
          .on('error', (err) => {
            if (!resolved) {
              resolved = true;
              console.error('❌ Error en conversión ffmpeg:', err);
              reject(err);
            }
          })
          .on('end', () => {
            console.log('🎵 FFmpeg finalizó la conversión');
          });

        ffmpegProcess.pipe(outputStream, { end: true });
      });

      const convertedAudioBuffer = await conversionPromise;

      // ========= PASO 2: Subir a Meta =========
      console.log('📤 Paso 2: Subiendo audio a Meta...');

      const mediaUrl = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/media`;
      const mimeType = 'audio/ogg';
      const fileName = `audio-${Date.now()}.ogg`;

      const metaForm = new FormData();
      metaForm.append('messaging_product', 'whatsapp');
      metaForm.append('type', mimeType);
      metaForm.append('file', convertedAudioBuffer, {
        filename: fileName,
        contentType: mimeType,
      });

      const mediaResp = await axios.post(mediaUrl, metaForm, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          ...metaForm.getHeaders(),
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      if (
        mediaResp.status < 200 ||
        mediaResp.status >= 300 ||
        mediaResp.data?.error
      ) {
        console.error('❌ Error subiendo a Meta:', mediaResp.data);
        return res.status(200).json({
          success: false,
          step: 'upload_media_to_meta',
          meta_status: mediaResp.status,
          error: mediaResp.data?.error || mediaResp.data,
        });
      }

      const mediaId = mediaResp.data?.id;
      if (!mediaId) {
        return res.status(200).json({
          success: false,
          step: 'upload_media_to_meta',
          error: 'Meta no devolvió media_id',
          raw: mediaResp.data,
        });
      }

      console.log(`✅ Audio subido a Meta. Media ID: ${mediaId}`);

      // ========= PASO 3: Enviar mensaje de audio =========
      console.log('💬 Paso 3: Enviando mensaje de audio...');

      const msgUrl = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'audio',
        audio: { id: mediaId },
      };

      const msgResp = await axios.post(msgUrl, payload, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      if (
        msgResp.status < 200 ||
        msgResp.status >= 300 ||
        msgResp.data?.error
      ) {
        console.error('❌ Error enviando mensaje:', msgResp.data);
        return res.status(200).json({
          success: false,
          step: 'send_message',
          meta_status: msgResp.status,
          mediaId,
          error: msgResp.data?.error || msgResp.data,
        });
      }

      const wamid = msgResp.data?.messages?.[0]?.id || null;
      console.log(`✅ Mensaje enviado. WAMID: ${wamid}`);

      // ========= PASO 4: Guardar en AWS (Uploader) =========
      console.log('☁️  Paso 4: Guardando en AWS...');

      const awsForm = new FormData();
      awsForm.append('file', convertedAudioBuffer, {
        filename: fileName,
        contentType: mimeType,
      });

      const uploaderResp = await axios.post(
        'https://uploader.imporfactory.app/api/files/upload',
        awsForm,
        {
          headers: awsForm.getHeaders(),
          timeout: 30000,
          validateStatus: () => true,
        },
      );

      let awsUrl = null;
      if (
        uploaderResp.status >= 200 &&
        uploaderResp.status < 300 &&
        uploaderResp.data?.success
      ) {
        awsUrl = uploaderResp.data.data?.url || null;
        console.log(`✅ Audio guardado en AWS: ${awsUrl}`);
      } else {
        console.warn('⚠️  No se pudo guardar en AWS:', uploaderResp.data);
      }

      // ========= Respuesta final =========
      return res.json({
        success: true,
        message: 'Audio procesado, enviado y guardado correctamente',
        data: {
          mediaId,
          wamid,
          awsUrl,
        },
        details: {
          meta_upload: mediaResp.data,
          meta_send: msgResp.data,
          aws_upload: uploaderResp.data,
        },
      });
    } catch (error) {
      console.error('❌ Error en /enviarAudioCompleto:', error);
      return res.status(500).json({
        success: false,
        message: 'Error interno procesando el audio',
        error: error?.message,
        stack:
          process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      });
    }
  },
);

router.post(
  '/enviar_template_masivo',
  upload.single('header_file'),
  whatsappCtrl.enviarTemplateMasivo,
);

router.post(
  '/programar_template_masivo',
  upload.single('header_file'),
  whatsappCtrl.programarTemplateMasivo,
);

module.exports = router;
