const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../database/config');
const { DateTime } = require('luxon');
const FormData = require('form-data');
const catchAsync = require('../utils/catchAsync');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const logger = require('../utils/logger');

const {
  getConfigFromDB,
  onlyDigits,
  parseMaybeJSON,
  parseArrayField,
  extractGraphBodyFromRequest,
  prepareHeaderAssetForScheduling,
  inferHeaderFormatFromMime,
  validateMetaMediaOrThrow,
  convertVideoForWhatsApp,
  uploadToUploader,
  uploadVideoToVideoAPI,
  uploadMediaToMeta,
  injectHeaderMediaId,
  extractBearerToken,
  uploadResumableAndGetHandle,
  generarClaveUnica,
  upsertOwnerByConfig,
} = require('../utils/whatsappTemplate.helpers');

exports.obtener_numeros = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta id_configuracion' });
  }

  const [rows] = await db.query(
    `SELECT id_whatsapp AS WABA_ID, token AS ACCESS_TOKEN
     FROM configuraciones
     WHERE id = ? AND suspendido = 0`,
    { replacements: [id_configuracion] },
  );

  if (!rows.length) {
    return res.json({
      success: true,
      data: [],
      waba_info: null,
      portfolio_owner: null,
      on_behalf_of: null,
    });
  }

  const { WABA_ID, ACCESS_TOKEN } = rows[0];

  const ax = axios.create({
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    timeout: 15000,
    validateStatus: () => true,
  });

  // 0) Info WABA + dueño
  const wabaInfoResp = await ax.get(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}`,
    {
      params: {
        fields: 'id,name,owner_business_info,on_behalf_of_business_info',
      },
    },
  );

  let wabaInfo = null;
  let portfolioOwner = null;
  let onBehalfOf = null;

  if (wabaInfoResp.status >= 200 && wabaInfoResp.status < 300) {
    wabaInfo = wabaInfoResp.data || null;

    portfolioOwner = wabaInfo?.owner_business_info
      ? {
          id: wabaInfo.owner_business_info.id || null,
          name: wabaInfo.owner_business_info.name || null,
          marketing_messages_onboarding_status:
            wabaInfo.owner_business_info.marketing_messages_onboarding_status
              ?.status || null,
        }
      : null;

    if (portfolioOwner?.id) {
      await db.query(
        `UPDATE configuraciones
          SET meta_business_id = ?,
              meta_business_name = ?
          WHERE id = ?`,
        {
          replacements: [
            portfolioOwner.id,
            portfolioOwner.name || null,
            id_configuracion,
          ],
        },
      );
    }

    onBehalfOf = wabaInfo?.on_behalf_of_business_info
      ? {
          id: wabaInfo.on_behalf_of_business_info.id || null,
          name: wabaInfo.on_behalf_of_business_info.name || null,
          status: wabaInfo.on_behalf_of_business_info.status || null,
          type: wabaInfo.on_behalf_of_business_info.type || null,
        }
      : null;
  }

  // 1) Números
  const numbersResp = await ax.get(
    `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}/phone_numbers`,
    {
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
    },
  );

  if (numbersResp.status === 401 || numbersResp.status === 403) {
    return res.json({
      success: true,
      data: [],
      hint: 'meta_unauthorized',
      waba_info: wabaInfo,
      portfolio_owner: portfolioOwner,
      on_behalf_of: onBehalfOf,
    });
  }

  if (numbersResp.status < 200 || numbersResp.status >= 300) {
    const metaErr = numbersResp.data?.error || null;
    const isRateLimit = metaErr?.code === 80008;

    return res.status(200).json({
      success: true,
      data: [],
      hint: isRateLimit
        ? 'meta_rate_limited'
        : `meta_error_${numbersResp.status}`,
      waba_info: wabaInfo,
      portfolio_owner: portfolioOwner,
      on_behalf_of: onBehalfOf,
      meta_error: metaErr
        ? {
            http_status: numbersResp.status,
            code: metaErr.code,
            type: metaErr.type,
            message: metaErr.message,
            fbtrace_id: metaErr.fbtrace_id,
            error_subcode: metaErr.error_subcode,
            error_user_title: metaErr.error_user_title,
            error_user_msg: metaErr.error_user_msg,
          }
        : {
            http_status: numbersResp.status,
            message: 'Meta devolvió un error sin cuerpo estándar',
          },
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
    return res.json({
      success: true,
      data: [],
      waba_info: wabaInfo,
      portfolio_owner: portfolioOwner,
      on_behalf_of: onBehalfOf,
    });
  }

  // 2) Perfiles por número
  const merged = await Promise.all(
    numbers.map(async (n) => {
      const profileResp = await ax.get(
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${n.id}/whatsapp_business_profile`,
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
        profile = profileResp.data?.data ?? profileResp.data ?? null;
      }

      return {
        ...n,
        profile,
        portfolio_owner_id: portfolioOwner?.id || null,
        portfolio_owner_name: portfolioOwner?.name || null,
      };
    }),
  );

  // 3) ★ NUEVO: sincronizar wa_status en DB con el status real del número activo
  //    Usamos el primer número como referencia (normalmente solo hay uno por config)
  const primaryNumber = merged[0];
  if (primaryNumber?.status) {
    await db.query(
      `UPDATE configuraciones 
       SET wa_status = ?, wa_status_at = NOW() 
       WHERE id = ?`,
      {
        replacements: [primaryNumber.status.toUpperCase(), id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
  }

  return res.json({
    success: true,
    data: merged,
    waba_info: wabaInfo
      ? { id: wabaInfo.id || WABA_ID, name: wabaInfo.name || null }
      : { id: WABA_ID, name: null },
    portfolio_owner: portfolioOwner,
    on_behalf_of: onBehalfOf,
  });
});

/* ─────────────────────────────────────────────
   2) HELPERS LOCALES (uso único: coexistencia/sync)
   No se mueven a helpers porque solo viven aquí.
   ───────────────────────────────────────────── */
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

  // 135000: excedió las 24 horas para realizar la sincronización
  if (code === 135000 || message.includes('(#135000)')) {
    return {
      http: 400,
      status: 'not_coexistence_number',
      mensaje:
        'La sincronización solo se puede realizar dentro de las primeras 24 horas después de haber conectado el número con Imporchat. Si necesitas completar este paso, te recomendamos desvincular y volver a vincular el número.',
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

  // Rate limit / "Application request limit reached"
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

/* ══════════════════════════════════════════════════════════════════
   3) FUNCIONES DEL CONTROLLER
   ══════════════════════════════════════════════════════════════════ */

/* ─────────── CONEXIÓN ─────────── */

exports.estadoConexion = async (req, res) => {
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
};

/* ─────────── PLANTILLAS META ─────────── */

exports.crearPlantilla = async (req, res) => {
  try {
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

      // Inyectar example.header_handle en el HEADER de media
      components = components.map((c) => {
        if (
          c?.type === 'HEADER' &&
          ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c?.format)
        ) {
          return { ...c, example: { header_handle: [handle] } };
        }
        return c;
      });
    }

    const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}/message_templates`;
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
    return res
      .status(500)
      .json({ success: false, error: error?.message || 'Error interno' });
  }
};

exports.obtenerTemplatesWhatsapp = async (req, res) => {
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
      return res.status(200).json({
        success: true,
        data: [],
        meta: { state: 'NO_CREDENTIALS' },
      });
    }

    const { WABA_ID, ACCESS_TOKEN } = rows[0];
    const { after, before, limit: limitRaw } = req.body || {};
    const limit = Math.min(Math.max(parseInt(limitRaw || 50, 10), 1), 100);

    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set('after', after);
    if (before) params.set('before', before);

    const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}/message_templates?${params.toString()}`;

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
    const metaError = error?.response?.data?.error;
    const code = metaError?.code;

    if (code === 190) {
      return res
        .status(200)
        .json({ success: true, data: [], meta: { state: 'INVALID_TOKEN' } });
    }

    if (code === 80008) {
      return res
        .status(200)
        .json({ success: true, data: [], meta: { state: 'RATE_LIMITED' } });
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
};

exports.crearPlantillasAutomaticas = async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({ error: 'Falta el id_configuracion.' });
  }

  const plantillasBase = [
    {
      name: 'zona_entrega',
      language: 'es',
      category: 'UTILITY',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Llego el día de entrega' },
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
        { type: 'HEADER', format: 'TEXT', text: '¡Tu pedido está en camino!' },
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
        { type: 'HEADER', format: 'TEXT', text: 'Información Importante' },
        {
          type: 'BODY',
          text: 'Hola {{1}} intentamos entregar 🚚 tu pedido {{2}} pero al parecer tuvimos un inconveniente, me podrías confirmar si tuviste algún problema para recibirlo?',
          example: { body_text: [['Carlos', 'Laptop HP']] },
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
          example: { body_text: [['Reloj inteligente Xiaomi']] },
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
          example: { body_text: [['Sebastian', '1234567890']] },
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
          example: { body_text: [['Contiene']] },
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
    const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}/message_templates?access_token=${ACCESS_TOKEN}&limit=100`;

    const { data } = await axios.get(url);
    const existentes = data.data.map((p) => p.name);

    const results = [];

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
        const crearUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${WABA_ID}/message_templates`;
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

    return res.json({
      success: true,
      mensaje: 'Proceso finalizado. Revisa los estados por cada plantilla.',
      resultados: results,
    });
  } catch (error) {
    console.error(
      'Error general al crear plantillas:',
      error?.response?.data || error.message,
    );
    return res.status(500).json({ error: error.message });
  }
};

/* ─────────── PLANTILLAS RÁPIDAS ─────────── */

exports.obtenerRespuestasRapidas = async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta el id_configuracion.' });
  }

  try {
    const rows = await db.query(
      `SELECT *
       FROM templates_chat_center
       WHERE id_configuracion = ?
       ORDER BY id_template DESC`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error al obtener plantillas rápidas:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno al consultar la base de datos.',
      error: error.message,
    });
  }
};

exports.crearPlantillaRapida = async (req, res) => {
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
      return res
        .status(400)
        .json({ success: false, message: 'Faltan datos requeridos.' });
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

    if (tipo !== 'text' && (!ruta_archivo || !String(ruta_archivo).trim())) {
      return res.status(400).json({
        success: false,
        message: 'ruta_archivo es obligatorio cuando tipo_mensaje no es text.',
      });
    }

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
};

exports.cambiarEstado = async (req, res) => {
  const { estado, id_template } = req.body;

  if (estado === undefined || !id_template) {
    return res
      .status(400)
      .json({ success: false, message: 'Faltan datos requeridos.' });
  }

  try {
    const [result] = await db.query(
      `UPDATE templates_chat_center SET principal = ? WHERE id_template = ?`,
      { replacements: [estado, id_template] },
    );

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
};

exports.eliminarPlantilla = async (req, res) => {
  const { id_template } = req.body;

  if (!id_template) {
    return res
      .status(400)
      .json({ success: false, message: 'Faltan datos requeridos.' });
  }

  try {
    const [result] = await db.query(
      `DELETE FROM templates_chat_center WHERE id_template = ?`,
      { replacements: [id_template] },
    );

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
};

exports.editarPlantilla = async (req, res) => {
  const {
    id_template,
    atajo,
    mensaje,
    tipo_mensaje,
    ruta_archivo,
    mime_type,
    file_name,
  } = req.body;

  if (!id_template) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta id_template.' });
  }

  try {
    const tieneMediaFields = tipo_mensaje !== undefined;

    if (tieneMediaFields) {
      const tipo = String(tipo_mensaje || 'text')
        .toLowerCase()
        .trim();
      const tiposOk = ['text', 'audio', 'image', 'video', 'document'];

      if (!tiposOk.includes(tipo)) {
        return res.status(400).json({
          success: false,
          message:
            'tipo_mensaje inválido. Use: text|audio|image|video|document',
        });
      }

      if (tipo !== 'text' && (!ruta_archivo || !String(ruta_archivo).trim())) {
        return res.status(400).json({
          success: false,
          message:
            'ruta_archivo es obligatorio cuando tipo_mensaje no es text.',
        });
      }

      const rutaFinal = tipo === 'text' ? null : String(ruta_archivo).trim();
      const mimeFinal = tipo === 'text' ? null : mime_type || null;
      const nameFinal = tipo === 'text' ? null : file_name || null;

      const [result] = await db.query(
        `UPDATE templates_chat_center
            SET atajo         = ?,
                mensaje       = ?,
                tipo_mensaje  = ?,
                ruta_archivo  = ?,
                mime_type     = ?,
                file_name     = ?
          WHERE id_template   = ?`,
        {
          replacements: [
            atajo,
            mensaje ?? '',
            tipo,
            rutaFinal,
            mimeFinal,
            nameFinal,
            id_template,
          ],
        },
      );

      return res.json({
        status: 200,
        success: true,
        modificado: result.changedRows > 0,
        message:
          result.changedRows > 0
            ? 'Plantilla editada correctamente.'
            : 'Los datos enviados son iguales a los actuales.',
      });
    } else {
      // Edición legacy (solo atajo + mensaje)
      const [result] = await db.query(
        `UPDATE templates_chat_center SET atajo = ?, mensaje = ? WHERE id_template = ?`,
        { replacements: [atajo, mensaje, id_template] },
      );

      return res.json({
        status: 200,
        success: true,
        modificado: result.changedRows > 0,
        message:
          result.changedRows > 0
            ? 'Plantilla editada correctamente.'
            : 'Los datos enviados son iguales a los actuales.',
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
};

exports.uploadVideoPlantillaRapida = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No se recibió ningún archivo de video.',
      });
    }

    const mime = String(req.file.mimetype || '').toLowerCase();
    if (!mime.startsWith('video/')) {
      return res.status(400).json({
        success: false,
        message: `El archivo no es un video. MIME recibido: ${req.file.mimetype}`,
      });
    }

    const jwtToken = extractBearerToken(req);
    if (!jwtToken) {
      return res.status(401).json({
        success: false,
        message:
          'Se requiere JWT (Authorization: Bearer ...) para subir video.',
      });
    }

    let processedBuffer = req.file.buffer;
    let processedMimetype = req.file.mimetype;
    let processedFilename = req.file.originalname;

    const videoOriginalSizeMB = req.file.buffer.length / (1024 * 1024);
    console.log(
      `[PLANTILLA_VIDEO] Tamaño original: ${videoOriginalSizeMB.toFixed(2)} MB`,
    );

    try {
      processedBuffer = await convertVideoForWhatsApp(
        req.file.buffer,
        req.file.originalname,
      );
      processedMimetype = 'video/mp4';
      processedFilename = req.file.originalname.replace(/\.[^.]+$/, '.mp4');

      console.log(
        '[PLANTILLA_VIDEO] Conversión OK:',
        (processedBuffer.length / (1024 * 1024)).toFixed(2),
        'MB',
      );
    } catch (convErr) {
      if (convErr.isOversized || videoOriginalSizeMB > 15) {
        const msg = convErr.isOversized
          ? convErr.message
          : `El video pesa ${videoOriginalSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB. Enviá un video más corto o de menor resolución.`;
        return res.status(400).json({ success: false, message: msg });
      }
      console.warn(
        '[PLANTILLA_VIDEO] Conversión falló, usando original:',
        convErr.message,
      );
    }

    let videoApiResult;
    try {
      videoApiResult = await uploadVideoToVideoAPI({
        buffer: processedBuffer,
        originalname: processedFilename,
        mimetype: processedMimetype,
        jwtToken,
      });
      console.log(
        '[PLANTILLA_VIDEO] Video API OK:',
        videoApiResult.video_id,
        videoApiResult.stream_url,
      );
    } catch (err) {
      return res.status(err.statusCode || 502).json({
        success: false,
        message: err.message || 'No se pudo subir video a la Video API',
      });
    }

    return res.json({
      success: true,
      data: {
        url: videoApiResult.stream_url || videoApiResult.fileUrl,
        fileName: processedFilename,
        mimeType: processedMimetype,
        size: processedBuffer.length,
        video_id: videoApiResult.video_id,
        stream_url: videoApiResult.stream_url || videoApiResult.fileUrl,
      },
    });
  } catch (err) {
    console.error('[PLANTILLA_VIDEO] Error:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Error subiendo video.',
    });
  }
};

/* ─────────── CONFIGURACIÓN ─────────── */

exports.editarConfiguracion = async (req, res) => {
  const { id_template_whatsapp, id_configuracion } = req.body;

  if (!id_template_whatsapp || !id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Faltan datos requeridos.' });
  }

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET template_generar_guia = ? WHERE id = ?`,
      { replacements: [id_template_whatsapp, id_configuracion] },
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
};

exports.editarConfiguracionCalendario = async (req, res) => {
  const { id_template_whatsapp, id_configuracion } = req.body;

  if (!id_template_whatsapp || !id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Faltan datos requeridos.' });
  }

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET template_notificar_calendario = ? WHERE id = ?`,
      { replacements: [id_template_whatsapp, id_configuracion] },
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
};

exports.actualizarMetodoPago = async (req, res) => {
  const { metodo_pago, id } = req.body;

  if (metodo_pago === undefined || !id) {
    return res
      .status(400)
      .json({ success: false, message: 'Faltan datos requeridos' });
  }

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET metodo_pago = ? WHERE id = ?`,
      { replacements: [metodo_pago, id] },
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
};

exports.obtenerConfiguracion = async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta el id_configuracion.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT COALESCE(template_generar_guia, '') AS template_generar_guia,
              COALESCE(template_notificar_calendario, '') AS template_notificar_calendario
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

    return res.json({ success: true, config: rows[0] });
  } catch (error) {
    console.error('Error al obtener configuración:', error);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar configuración.',
      error: error.message,
    });
  }
};

exports.configuracionesAutomatizador = async (req, res) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return res
      .status(400)
      .json({ success: false, message: 'Falta el id_plataforma' });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM configuraciones WHERE id = ? AND suspendido = 0`,
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
    // FIX: antes referenciaba 'error' (no definido) -> ahora 'err'
    console.error('Error al obtener configuración:', err);
    return res.status(500).json({
      success: false,
      message: 'Error al consultar configuración.',
      error: err.message,
    });
  }
};

exports.actualizarConfiguracionMeta = async (req, res) => {
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

    const ownerId = await upsertOwnerByConfig({
      id_configuracion,
      uid_cliente: id_telefono,
      nombre_cliente: nombre_configuracion,
      celular_cliente: telefono,
      source: 'owner',
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
};

/* ─────────── ONBOARDING / COEXISTENCIA ─────────── */

exports.embeddedSignupComplete = async (req, res) => {
  const {
    code,
    id_usuario,
    redirect_uri,
    id_configuracion,
    display_number_onboarding,
  } = req.body;

  if (!code || !id_usuario || !display_number_onboarding) {
    return res.status(400).json({
      success: false,
      message:
        'Faltan parámetros requeridos: code, id_usuario y display_number_onboarding son obligatorios.',
    });
  }

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
  const SYS_TOKEN = process.env.FB_PROVIDER_TOKEN;
  const BUSINESS_ID = process.env.FB_BUSINESS_ID;

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
    display_number_onboarding: display_number_onboarding || '(none)',
  });

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

  // 1) Intercambiar code → access token
  let clientToken;
  try {
    console.log('[OAUTH] exchange WITH redirect_uri');
    const r = await axios.get(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/oauth/access_token`,
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
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/oauth/access_token`,
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

    // 2) Obtener WABAs visibles
    console.log('[WABA][FETCH] Obteniendo WABAs (client/owned)…');
    const wabas = [];

    try {
      const clientResp = await safeGet(
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${BUSINESS_ID}/client_whatsapp_business_accounts`,
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
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${BUSINESS_ID}/owned_whatsapp_business_accounts`,
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

    // 3) Selección del número (por display_number_onboarding)
    let wabaPicked = null;
    let phoneNumberId = null;
    let displayNumber = null;
    let matchedPhone = null;

    const displayWanted = norm(display_number_onboarding || '');

    async function fetchPhonesOf(wabaId) {
      const r = await safeGet(
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${wabaId}/phone_numbers`,
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

    // 4) Registrar el número (REGISTER)
    const regUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${phoneNumberId}/register`;
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

    // 5) Suscribir app al WABA
    const subUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${wabaId}/subscribed_apps`;
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

    // 6) Verificar estado del número
    let info = {};
    try {
      const r1 = await safeGet(
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${phoneNumberId}`,
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
        `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${phoneNumberId}`,
        {
          fields:
            'id,display_phone_number,status,code_verification_status,quality_rating,verified_name',
        },
        bearer(clientToken),
      );
      info = r2.data || {};
      console.log('[PN-INFO][OK] con clientToken');
    }

    const nombre_configuracion = `${info?.verified_name || 'WhatsApp'} - Imporsuit`;
    const webhook_url =
      'https://chat.imporfactory.app/api/v1/webhook_meta/webhook_whatsapp?webhook=wh_clfgshu99';
    const permanentPartnerTok = SYS_TOKEN;
    const key_imporsuit = generarClaveUnica();

    // 7) Persistencia
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

    const ownerId = await upsertOwnerByConfig({
      id_configuracion: idConfigToUse,
      uid_cliente: phoneNumberId,
      nombre_cliente: nombre_configuracion,
      celular_cliente: displayNumber,
      source: 'owner',
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
};

exports.coexistenciaSync = async (req, res) => {
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

    const endpoint = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${phoneNumberId}/smb_app_data`;

    const ax = axios.create({
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      timeout: 15000,
      validateStatus: () => true,
    });

    const callSync = async (sync_type) =>
      ax.post(endpoint, { messaging_product: 'whatsapp', sync_type });

    const isCode4 = (data) => data?.error?.code === 4;

    // 1) smb_app_state_sync
    const resp1 = await callSync('smb_app_state_sync');

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

    await updateConfigSyncFlag(id_configuracion, 1);

    return res.json({
      success: true,
      status: 'synced',
      mensaje: 'Sincronización realizada correctamente.',
      meta: { smb_app_state_sync: resp1.data, history: resp2.data },
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
};

/* ─────────── AUDIO ─────────── */

exports.enviarAudio = async (req, res) => {
  try {
    const { id_configuracion, to } = req.body;

    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta id_configuracion' });
    }
    if (!to) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta el campo to (destinatario)' });
    }
    if (!req.file?.buffer) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta el archivo audio' });
    }

    const cfg = await getConfigFromDB(id_configuracion);
    if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID) {
      return res
        .status(404)
        .json({ success: false, message: 'Config no encontrada o incompleta' });
    }

    const { ACCESS_TOKEN, PHONE_NUMBER_ID } = cfg;

    // 1) Subir media a Meta
    const mediaUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${PHONE_NUMBER_ID}/media`;
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

    // 2) Enviar mensaje por id
    const msgUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
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
      meta: { upload: mediaResp.data, send: msgResp.data },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error interno enviando audio',
      error: error?.message,
    });
  }
};

exports.enviarAudioCompleto = async (req, res) => {
  try {
    const { id_configuracion, to } = req.body;

    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta id_configuracion' });
    }
    if (!to) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta el campo to (destinatario)' });
    }
    if (!req.file?.buffer) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta el archivo audio' });
    }

    const cfg = await getConfigFromDB(id_configuracion);
    if (!cfg?.ACCESS_TOKEN || !cfg?.PHONE_NUMBER_ID) {
      return res
        .status(404)
        .json({ success: false, message: 'Config no encontrada o incompleta' });
    }

    const { ACCESS_TOKEN, PHONE_NUMBER_ID } = cfg;

    // PASO 1: Convertir audio
    console.log('🎵 Paso 1: Convirtiendo audio a OGG OPUS...');

    const inputStream = new PassThrough();
    inputStream.end(req.file.buffer);

    const outputStream = new PassThrough();
    const chunks = [];

    const conversionPromise = new Promise((resolve, reject) => {
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

      const ffmpegProcess = ffmpeg(inputStream)
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .audioFrequency(44100)
        .audioChannels(1)
        .format('mp3')
        .on('start', (cmdline) => console.log('🔧 FFmpeg command:', cmdline))
        .on('error', (err) => {
          if (!resolved) {
            resolved = true;
            console.error('❌ Error en conversión ffmpeg:', err);
            reject(err);
          }
        })
        .on('end', () => console.log('🎵 FFmpeg finalizó la conversión'));

      ffmpegProcess.pipe(outputStream, { end: true });
    });

    const convertedAudioBuffer = await conversionPromise;

    // PASO 2: Subir a Meta
    console.log('📤 Paso 2: Subiendo audio a Meta...');

    const mediaUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${PHONE_NUMBER_ID}/media`;
    const mimeType = 'audio/mpeg';
    const fileName = `AUD-${Date.now()}.mp3`;

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
      params: { debug: 'all' },
      timeout: 30000,
      validateStatus: () => true,
    });

    if (mediaResp.data?.__debug) {
      console.log('📊 Debug info de Meta:', mediaResp.data.__debug);
      logger.info('Meta debug info (upload media)', {
        meta_debug: mediaResp.data.__debug,
        step: 'upload_media',
        id_configuracion,
      });
    }

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

    // PASO 3: Enviar mensaje de audio
    console.log('💬 Paso 3: Enviando mensaje de audio...');

    const msgUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
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
      params: { debug: 'all' },
      timeout: 30000,
      validateStatus: () => true,
    });
    console.log('Respuesta de Meta al enviar mensaje:', msgResp.data);

    if (msgResp.data?.__debug) {
      console.log(
        '📊 Debug info de Meta (send message):',
        msgResp.data.__debug,
      );
      logger.info('Meta debug info (send message)', {
        meta_debug: msgResp.data.__debug,
        step: 'send_message',
        id_configuracion,
      });
    }

    if (msgResp.status < 200 || msgResp.status >= 300 || msgResp.data?.error) {
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

    // PASO 4: Guardar en AWS (Uploader)
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

    return res.json({
      success: true,
      message: 'Audio procesado, enviado y guardado correctamente',
      data: { mediaId, wamid, awsUrl },
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
      stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
    });
  }
};
/**
 * ENVÍO INMEDIATO DE TEMPLATE MASIVO (1 destinatario por request)
 * Soporta:
 * - JSON normal
 * - multipart/form-data (header_file)
 * - header_default_asset
 *
 * Para VIDEO → sube a Video API (/Videos/*) en vez de S3.
 *         Para IMAGE / DOCUMENT → sigue usando S3 (uploadToUploader).
 */
exports.enviarTemplateMasivo = async (req, res) => {
  try {
    // 1) id_configuracion
    const id_configuracion = req.body?.id_configuracion;

    // 2) graphBody puede venir:
    // - JSON normal: req.body.body (cuando no hay archivo)
    // - multipart: req.body.body_json (string)
    let graphBody = null;

    try {
      graphBody = extractGraphBodyFromRequest(req);
    } catch (e) {
      return res.status(e.statusCode || 400).json({
        success: false,
        message: e.message || 'body_json inválido (JSON mal formado)',
      });
    }

    // Fallbacks
    const to = req.body?.to ?? graphBody?.to;
    const template_name = req.body?.template_name ?? graphBody?.template?.name;
    const language_code =
      req.body?.language_code ?? graphBody?.template?.language?.code ?? 'es';
    const componentsFromReq =
      req.body?.components ?? graphBody?.template?.components;

    const faltan = [];
    if (!id_configuracion) faltan.push('id_configuracion');
    if (!to) faltan.push('to');
    if (!template_name) faltan.push('template_name');

    if (faltan.length) {
      return res.status(400).json({
        success: false,
        message: `Faltan campos: ${faltan.join(', ')}`,
      });
    }

    const cfg = await getConfigFromDB(Number(id_configuracion));
    if (!cfg) {
      return res.status(200).json({
        success: false,
        message: 'Configuración inválida o sin token/phone_number_id',
      });
    }

    const toClean = onlyDigits(to);
    if (!toClean || toClean.length < 8) {
      return res
        .status(200)
        .json({ success: false, message: 'Número destino inválido' });
    }

    // ===== construir payload base =====
    let payload;

    if (graphBody) {
      payload = {
        messaging_product: graphBody.messaging_product || 'whatsapp',
        to: toClean,
        type: graphBody.type || 'template',
        template: {
          ...(graphBody.template || {}),
          name: template_name,
          language: { code: language_code || 'es' },
        },
      };

      // si no hay components, deje el body estándar
      if (
        !Array.isArray(payload.template.components) ||
        !payload.template.components.length
      ) {
        payload.template.components = [{ type: 'body', parameters: [] }];
      }
    } else {
      payload = {
        messaging_product: 'whatsapp',
        to: toClean,
        type: 'template',
        template: {
          name: template_name,
          language: { code: language_code || 'es' },
          components: Array.isArray(componentsFromReq)
            ? componentsFromReq
            : [{ type: 'body', parameters: [] }],
        },
      };
    }

    // ===== 2) Si vino archivo, validar + subir histórico + subir a Meta + inject header =====
    let header_format = req.body?.header_format ?? null;

    let fileUrl = null; // URL histórico (S3 o Video API stream_url)
    let meta_media_id = null; // mediaId de Meta
    let processedBuffer = null;
    let processedMimetype = null;
    let processedFilename = null;
    let fmt = null;
    let videoApiResult = null; // datos de Video API si aplica

    const headerDefaultAssetRaw = req.body?.header_default_asset;

    let header_default_asset = null;
    if (headerDefaultAssetRaw) {
      if (typeof headerDefaultAssetRaw === 'object') {
        header_default_asset = headerDefaultAssetRaw;
      } else if (typeof headerDefaultAssetRaw === 'string') {
        try {
          header_default_asset = JSON.parse(headerDefaultAssetRaw);
        } catch (_) {
          header_default_asset = null;
        }
      }
    }

    if (req.file) {
      if (!header_format) {
        header_format = inferHeaderFormatFromMime(req.file.mimetype);
      }

      fmt = String(header_format || '').toUpperCase();

      if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(fmt)) {
        return res.status(400).json({
          success: false,
          message:
            'Vino header_file pero header_format no es válido para HEADER (IMAGE|VIDEO|DOCUMENT)',
        });
      }

      // 2.1) Validar límites Meta
      try {
        validateMetaMediaOrThrow({ file: req.file, format: fmt });
      } catch (err) {
        return res.status(err.statusCode || 400).json({
          success: false,
          step: 'validate_media',
          code: err.code || null,
          message: err.message || 'Archivo inválido',
        });
      }

      // 2.1.1) Convertir video si aplica
      processedBuffer = req.file.buffer;
      processedMimetype = req.file.mimetype;
      processedFilename = req.file.originalname;

      if (fmt === 'VIDEO') {
        const videoOriginalSizeMB = req.file.buffer.length / (1024 * 1024);
        console.log(
          `[VIDEO] Iniciando conversión. Tamaño original: ${videoOriginalSizeMB.toFixed(2)} MB`,
        );
        try {
          processedBuffer = await convertVideoForWhatsApp(
            req.file.buffer,
            req.file.originalname,
          );
          processedMimetype = 'video/mp4';
          processedFilename = req.file.originalname.replace(/\.[^.]+$/, '.mp4');

          console.log(
            '[VIDEO] Conversión exitosa. Nuevo tamaño:',
            (processedBuffer.length / (1024 * 1024)).toFixed(2),
            'MB',
          );
        } catch (convErr) {
          if (convErr.isOversized || videoOriginalSizeMB > 15) {
            const msg = convErr.isOversized
              ? convErr.message
              : `El video pesa ${videoOriginalSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB. Enviá un video más corto o de menor resolución.`;
            console.error('[VIDEO] Video demasiado pesado:', msg);
            return res
              .status(400)
              .json({ success: false, step: 'convert_video', message: msg });
          }
          console.warn(
            '[VIDEO] No se pudo convertir. Usando original:',
            convErr.message,
          );
        }
      }

      // 2.2) Subir histórico: VIDEO → Video API | IMAGE/DOCUMENT → S3
      if (fmt === 'VIDEO') {
        // ── VIDEO → Video API chunked ──
        const jwtToken = extractBearerToken(req);

        if (!jwtToken) {
          return res.status(401).json({
            success: false,
            step: 'upload_video_api',
            message: 'Se requiere JWT para subir video a la Video API.',
          });
        }

        try {
          videoApiResult = await uploadVideoToVideoAPI({
            buffer: processedBuffer,
            originalname: processedFilename,
            mimetype: processedMimetype,
            jwtToken,
          });

          fileUrl = videoApiResult.fileUrl; // stream_url
        } catch (err) {
          return res.status(err.statusCode || 502).json({
            success: false,
            step: 'upload_video_api',
            code: err.code || null,
            message: err.message || 'No se pudo subir video a la Video API',
          });
        }
      } else {
        // ── IMAGE / DOCUMENT → S3 como antes ──
        const folder =
          fmt === 'IMAGE'
            ? 'whatsapp/templates/header/images'
            : 'whatsapp/templates/header/documents';

        try {
          const upHist = await uploadToUploader({
            buffer: processedBuffer,
            originalname: processedFilename,
            mimetype: processedMimetype,
            folder,
          });

          fileUrl = upHist?.fileUrl || null;
        } catch (err) {
          return res.status(err.statusCode || 502).json({
            success: false,
            step: 'upload_history_s3',
            message: err.message || 'No se pudo subir a histórico (S3)',
            raw: err.raw || null,
          });
        }
      }

      // 2.3) Subir a Meta para obtener media_id (esto NO cambia — Meta siempre necesita su propio upload)
      const upMeta = await uploadMediaToMeta(
        {
          ACCESS_TOKEN: cfg.ACCESS_TOKEN,
          PHONE_NUMBER_ID: cfg.PHONE_NUMBER_ID,
        },
        {
          buffer: processedBuffer,
          mimetype: processedMimetype,
          originalname: processedFilename,
        },
      );

      if (!upMeta.ok) {
        return res.status(200).json({
          success: false,
          step: 'upload_media_meta',
          meta_status: upMeta.meta_status,
          error: upMeta.error,
          fileUrl,
        });
      }

      meta_media_id = upMeta.mediaId;

      // 2.3.1) Para videos: dar tiempo y verificar estado
      if (fmt === 'VIDEO') {
        console.log(
          '[VIDEO] Esperando procesamiento de Meta (mediaId:',
          meta_media_id,
          ')...',
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));

        try {
          const mediaCheckUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${meta_media_id}`;
          const mediaCheck = await axios.get(mediaCheckUrl, {
            headers: { Authorization: `Bearer ${cfg.ACCESS_TOKEN}` },
            timeout: 10000,
            validateStatus: () => true,
          });

          console.log('[VIDEO] Estado del media:', {
            status: mediaCheck.status,
            data: mediaCheck.data,
          });

          if (mediaCheck.status !== 200) {
            console.warn(
              '[VIDEO] Advertencia: No se pudo verificar el estado del media',
            );
          }
        } catch (checkErr) {
          console.warn(
            '[VIDEO] Advertencia al verificar media:',
            checkErr.message,
          );
        }
      }

      // 2.4) Inyectar mediaId en HEADER
      const comps = Array.isArray(payload.template.components)
        ? payload.template.components
        : [];

      payload.template.components = injectHeaderMediaId(
        comps,
        fmt,
        meta_media_id,
      );
    } else if (
      header_default_asset?.enabled === true &&
      header_default_asset?.url &&
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
        String(header_default_asset?.format || '').toUpperCase(),
      )
    ) {
      const fmtDefault = String(
        header_default_asset.format || '',
      ).toUpperCase();

      try {
        // 1) Descargar archivo desde URL predeterminada
        const rawDefaultUrl = String(header_default_asset.url || '').trim();
        const decodedDefaultUrl = rawDefaultUrl
          .replace(/&amp;/g, '&')
          .replace(/&#38;/g, '&');

        console.log('[DEFAULT_HEADER] raw URL:', rawDefaultUrl);
        console.log('[DEFAULT_HEADER] decoded URL:', decodedDefaultUrl);

        const dl = await axios.get(decodedDefaultUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          validateStatus: () => true,
        });

        if (dl.status < 200 || dl.status >= 300 || !dl.data) {
          return res.status(200).json({
            success: false,
            step: 'download_default_header_asset',
            message:
              'No se pudo descargar el adjunto predeterminado del template',
            http_status: dl.status,
            url: decodedDefaultUrl,
            raw_url: rawDefaultUrl,
          });
        }

        const downloadedBuffer = Buffer.from(dl.data);

        const responseMime = String(dl.headers?.['content-type'] || '')
          .split(';')[0]
          .trim();

        let defaultMime = responseMime;
        if (!defaultMime) {
          if (fmtDefault === 'IMAGE') defaultMime = 'image/jpeg';
          if (fmtDefault === 'VIDEO') defaultMime = 'video/mp4';
          if (fmtDefault === 'DOCUMENT') defaultMime = 'application/pdf';
        }

        const extByFmt =
          fmtDefault === 'IMAGE'
            ? 'jpg'
            : fmtDefault === 'VIDEO'
              ? 'mp4'
              : 'pdf';

        const defaultFilename =
          (header_default_asset?.name &&
            String(header_default_asset.name).trim()) ||
          `template_header_default.${extByFmt}`;

        // 2) Validar límites
        try {
          validateMetaMediaOrThrow({
            file: {
              buffer: downloadedBuffer,
              mimetype: defaultMime,
              originalname: defaultFilename,
              size: downloadedBuffer.length,
            },
            format: fmtDefault,
          });
        } catch (err) {
          return res.status(err.statusCode || 400).json({
            success: false,
            step: 'validate_default_header_asset',
            code: err.code || null,
            message: err.message || 'Adjunto predeterminado inválido',
          });
        }

        // 3) Guardar histórico: VIDEO → Video API | IMAGE/DOCUMENT → S3
        if (fmtDefault === 'VIDEO') {
          // ── VIDEO → Video API chunked ──
          const jwtToken = extractBearerToken(req);

          if (!jwtToken) {
            return res.status(401).json({
              success: false,
              step: 'upload_video_api_default_asset',
              message: 'Se requiere JWT para subir video a la Video API.',
            });
          }

          try {
            videoApiResult = await uploadVideoToVideoAPI({
              buffer: downloadedBuffer,
              originalname: defaultFilename,
              mimetype: defaultMime,
              jwtToken,
            });

            fileUrl = videoApiResult.fileUrl;
          } catch (err) {
            return res.status(err.statusCode || 502).json({
              success: false,
              step: 'upload_video_api_default_asset',
              code: err.code || null,
              message:
                err.message ||
                'No se pudo subir video del default asset a la Video API',
            });
          }
        } else {
          // ── IMAGE / DOCUMENT → S3 como antes ──
          const folder =
            fmtDefault === 'IMAGE'
              ? 'whatsapp/templates/header/images'
              : 'whatsapp/templates/header/documents';

          try {
            const upHist = await uploadToUploader({
              buffer: downloadedBuffer,
              originalname: defaultFilename,
              mimetype: defaultMime,
              folder,
            });

            fileUrl = upHist?.fileUrl || decodedDefaultUrl || null;
          } catch (err) {
            return res.status(err.statusCode || 502).json({
              success: false,
              step: 'upload_history_s3_default_asset',
              message:
                err.message ||
                'No se pudo subir a histórico (S3) el asset predeterminado',
              raw: err.raw || null,
            });
          }
        }

        // 4) Subir a Meta y obtener media_id
        const upMeta = await uploadMediaToMeta(
          {
            ACCESS_TOKEN: cfg.ACCESS_TOKEN,
            PHONE_NUMBER_ID: cfg.PHONE_NUMBER_ID,
          },
          {
            buffer: downloadedBuffer,
            mimetype: defaultMime,
            originalname: defaultFilename,
          },
        );

        if (!upMeta.ok) {
          return res.status(200).json({
            success: false,
            step: 'upload_media_meta_default_asset',
            meta_status: upMeta.meta_status,
            error: upMeta.error,
            fileUrl,
          });
        }

        meta_media_id = upMeta.mediaId;
        fmt = fmtDefault;

        // 5) Inyectar HEADER media
        const comps = Array.isArray(payload.template.components)
          ? payload.template.components
          : [];

        payload.template.components = injectHeaderMediaId(
          comps,
          fmtDefault,
          meta_media_id,
        );
      } catch (err) {
        return res.status(500).json({
          success: false,
          step: 'process_default_header_asset',
          message: 'Error procesando adjunto predeterminado del template',
          error: err.message,
        });
      }
    }

    // ===== 3) Enviar template a Meta =====
    console.log(
      '[SEND_TEMPLATE] Enviando a:',
      to,
      'Template:',
      template_name,
      'MediaId:',
      meta_media_id || 'N/A',
    );

    const ax = axios.create({
      headers: {
        Authorization: `Bearer ${cfg.ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.PHONE_NUMBER_ID}/messages`;
    const resp = await ax.post(url, payload);

    console.log('[SEND_TEMPLATE] Respuesta de Meta:', {
      status: resp.status,
      data: resp.data,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(200).json({
        success: false,
        meta_status: resp.status,
        error: resp.data,
        message: 'Meta rechazó el envío',
        sent_payload: payload,
        fileUrl,
        meta_media_id,
      });
    }

    const wamid = resp.data?.messages?.[0]?.id || null;
    console.log('[SEND_TEMPLATE] Enviado exitosamente. WAMID:', wamid);

    return res.json({
      success: true,
      wamid,
      data: resp.data,
      fileUrl,
      meta_media_id,
      video_api: videoApiResult
        ? {
            video_id: videoApiResult.video_id,
            stream_url: videoApiResult.stream_url,
          }
        : null,
      file_info: req.file
        ? {
            name: processedFilename || req.file.originalname,
            mime: processedMimetype || req.file.mimetype,
            size: processedBuffer ? processedBuffer.length : req.file.size,
            header_format: String(header_format || '').toUpperCase(),
            converted: fmt === 'VIDEO' && processedBuffer !== req.file.buffer,
          }
        : null,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Error interno enviando template',
      error: e.message,
    });
  }
};

exports.programarTemplateMasivo = async (req, res) => {
  const t = await db.transaction();

  try {
    // ==========================================
    // 1) Parseo flexible (JSON o multipart)
    // ==========================================
    const graphBody = extractGraphBodyFromRequest(req);

    let selected = req.body?.selected ?? [];
    if (!Array.isArray(selected)) {
      const parsedSelected = parseMaybeJSON(selected, []);
      selected = Array.isArray(parsedSelected) ? parsedSelected : [];
    }

    const id_configuracion = Number(req.body?.id_configuracion || 0) || null;
    const id_usuario =
      req.body?.id_usuario != null && req.body?.id_usuario !== ''
        ? Number(req.body.id_usuario)
        : null;

    let telefono_configuracion = req.body?.telefono_configuracion || null;
    let business_phone_id = req.body?.business_phone_id || null;
    let waba_id = req.body?.waba_id || null;

    let nombre_template =
      req.body?.nombre_template ??
      req.body?.template_name ??
      graphBody?.template?.name ??
      null;

    let language_code =
      req.body?.language_code ?? graphBody?.template?.language?.code ?? 'es';

    let template_parameters = parseArrayField(
      req.body?.template_parameters,
      [],
    );
    let header_parameters = parseArrayField(req.body?.header_parameters, null);

    let header_format = req.body?.header_format || null;
    let header_media_url = req.body?.header_media_url || null;
    let header_media_name = req.body?.header_media_name || null;

    const fecha_programada = req.body?.fecha_programada || null;
    const timezone = req.body?.timezone || 'America/Guayaquil';

    const meta = parseMaybeJSON(req.body?.meta, null);

    // ==========================================
    // 2) Validaciones mínimas
    // ==========================================
    if (!Array.isArray(selected) || !selected.length) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Debe seleccionar al menos un cliente.',
      });
    }

    if (!id_configuracion) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Falta id_configuracion.',
      });
    }

    if (!nombre_template) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Debe indicar el nombre del template.',
      });
    }

    if (!fecha_programada) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Debe indicar fecha y hora programada.',
      });
    }

    // ==========================================
    // 2.1) Validar timezone + convertir fecha local => UTC (Luxon)
    // ==========================================
    const tz = String(timezone || 'America/Guayaquil').trim();

    const dtLocal = DateTime.fromSQL(String(fecha_programada), { zone: tz });

    if (!dtLocal.isValid) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'fecha_programada o timezone no es válido.',
        error: dtLocal.invalidExplanation || dtLocal.invalidReason || null,
      });
    }

    const fecha_programada_utc = dtLocal
      .toUTC()
      .toFormat('yyyy-LL-dd HH:mm:ss');

    // ==========================================
    // 3) Obtener config real desde BD (preferido)
    // ==========================================
    const cfg = await getConfigFromDB(id_configuracion);
    if (!cfg) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Configuración inválida o suspendida.',
      });
    }

    waba_id = cfg.WABA_ID || waba_id;
    business_phone_id = cfg.PHONE_NUMBER_ID || business_phone_id;

    if (!business_phone_id || !waba_id || !cfg.ACCESS_TOKEN) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'La configuración no tiene credenciales completas (WABA / token / phone_number_id).',
      });
    }

    // ==========================================
    // 4) Extraer placeholders automáticamente desde graphBody
    // ==========================================
    if (
      graphBody?.template?.components &&
      Array.isArray(graphBody.template.components)
    ) {
      const comps = graphBody.template.components;

      if (!template_parameters.length) {
        const bodyComp = comps.find((c) => c?.type === 'body');
        if (bodyComp?.parameters && Array.isArray(bodyComp.parameters)) {
          template_parameters = bodyComp.parameters.map((p) => {
            if (p?.type === 'text') return p.text ?? '';
            return p?.text ?? p?.value ?? '';
          });
        }
      }

      if (header_parameters == null) {
        const headerComp = comps.find((c) => c?.type === 'header');
        if (headerComp?.parameters && Array.isArray(headerComp.parameters)) {
          const first = headerComp.parameters[0];
          if (first?.type === 'text') {
            header_parameters = headerComp.parameters.map((p) => p?.text ?? '');
          }
        }
      }
    }

    if (!Array.isArray(template_parameters)) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'template_parameters debe ser un array.',
      });
    }

    if (header_parameters != null && !Array.isArray(header_parameters)) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'header_parameters debe ser array o null.',
      });
    }

    // ==========================================
    // 5) Procesar header media para PROGRAMACIÓN
    //    VIDEO → Video API | IMAGE/DOCUMENT → S3
    // ==========================================
    let scheduledHeaderInfo = {
      header_format: header_format || null,
      header_media_url: header_media_url || null,
      header_media_name: header_media_name || null,
      file_info: null,
    };

    if (req.file || req.body?.header_default_asset) {
      try {
        const prepared = await prepareHeaderAssetForScheduling({
          req,
          preferVideoConversion: true,
          jwtToken: extractBearerToken(req), // ← pasa el JWT para Video API
        });

        scheduledHeaderInfo = {
          header_format: prepared.header_format ?? header_format ?? null,
          header_media_url:
            prepared.header_media_url ?? header_media_url ?? null,
          header_media_name:
            prepared.header_media_name ?? header_media_name ?? null,
          file_info: prepared.file_info ?? null,
        };
      } catch (err) {
        await t.rollback();
        return res.status(err.statusCode || 400).json({
          ok: false,
          msg: 'Error procesando el header del template para programación.',
          step: err.code || 'prepare_header_for_schedule',
          error: err.message,
          extra: err.extra || null,
        });
      }
    } else {
      if (header_format) {
        scheduledHeaderInfo.header_format = String(header_format).toUpperCase();
      }
    }

    if (scheduledHeaderInfo.header_format) {
      scheduledHeaderInfo.header_format = String(
        scheduledHeaderInfo.header_format,
      ).toUpperCase();
    }

    if (
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(
        String(scheduledHeaderInfo.header_format || '').toUpperCase(),
      ) &&
      !scheduledHeaderInfo.header_media_url
    ) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Header media requiere header_media_url (archivo/manual/default asset).',
      });
    }

    if (
      String(scheduledHeaderInfo.header_format || '').toUpperCase() ===
        'TEXT' &&
      (!Array.isArray(header_parameters) || !header_parameters.length)
    ) {
      header_parameters = Array.isArray(header_parameters)
        ? header_parameters
        : [];
    }

    // ==========================================
    // 6) Obtener clientes seleccionados válidos
    // ==========================================
    const selectedIds = selected
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x > 0);

    if (!selectedIds.length) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'La selección de clientes no contiene IDs válidos.',
      });
    }

    const placeholders = selectedIds.map(() => '?').join(',');

    const clientes = await db.query(
      `
      SELECT 
        id,
        celular_cliente
      FROM clientes_chat_center
      WHERE id_configuracion = ?
        AND id IN (${placeholders})
      `,
      {
        replacements: [id_configuracion, ...selectedIds],
        type: db.QueryTypes.SELECT,
        transaction: t,
      },
    );

    if (!clientes.length) {
      await t.rollback();
      return res.status(404).json({
        ok: false,
        msg: 'No se encontraron clientes válidos para programar.',
      });
    }

    const clientesValidos = clientes
      .map((c) => ({
        id: c.id,
        telefono: onlyDigits(c.celular_cliente || ''),
      }))
      .filter((c) => c.telefono && c.telefono.length >= 8);

    if (!clientesValidos.length) {
      await t.rollback();
      return res.status(400).json({
        ok: false,
        msg: 'Los clientes seleccionados no tienen teléfonos válidos.',
      });
    }

    // ==========================================
    // 7) Generar lote e insertar programados
    // ==========================================
    const uuid_lote = crypto.randomUUID
      ? crypto.randomUUID()
      : `lote_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const rows = clientesValidos.map((c) => ({
      uuid_lote,
      id_configuracion,
      id_usuario,
      id_cliente_chat_center: c.id,
      telefono: c.telefono,
      telefono_configuracion: telefono_configuracion || null,
      business_phone_id: business_phone_id || null,
      waba_id: waba_id || null,
      nombre_template: nombre_template,
      language_code: language_code || 'es',
      template_parameters_json: JSON.stringify(template_parameters || []),
      header_format: scheduledHeaderInfo.header_format || null,
      header_parameters_json: Array.isArray(header_parameters)
        ? JSON.stringify(header_parameters)
        : null,
      header_media_url: scheduledHeaderInfo.header_media_url || null,
      header_media_name: scheduledHeaderInfo.header_media_name || null,
      fecha_programada: dtLocal.toFormat('yyyy-LL-dd HH:mm:ss'),
      fecha_programada_utc,
      timezone: tz,
      meta_json: meta ? JSON.stringify(meta) : null,
    }));

    const insertColumns = [
      'uuid_lote',
      'id_configuracion',
      'id_usuario',
      'id_cliente_chat_center',
      'telefono',
      'telefono_configuracion',
      'business_phone_id',
      'waba_id',
      'nombre_template',
      'language_code',
      'template_parameters_json',
      'header_format',
      'header_parameters_json',
      'header_media_url',
      'header_media_name',
      'fecha_programada',
      'fecha_programada_utc',
      'timezone',
      'meta_json',
    ];

    const valuesSql = rows
      .map(() => `(${insertColumns.map(() => '?').join(',')})`)
      .join(',');

    const flatValues = rows.flatMap((r) => [
      r.uuid_lote,
      r.id_configuracion,
      r.id_usuario,
      r.id_cliente_chat_center,
      r.telefono,
      r.telefono_configuracion,
      r.business_phone_id,
      r.waba_id,
      r.nombre_template,
      r.language_code,
      r.template_parameters_json,
      r.header_format,
      r.header_parameters_json,
      r.header_media_url,
      r.header_media_name,
      r.fecha_programada,
      r.fecha_programada_utc,
      r.timezone,
      r.meta_json,
    ]);

    await db.query(
      `
      INSERT INTO template_envios_programados (
        ${insertColumns.join(', ')}
      ) VALUES ${valuesSql}
      `,
      {
        replacements: flatValues,
        type: db.QueryTypes.INSERT,
        transaction: t,
      },
    );

    await t.commit();

    // ==========================================
    // 8) Emitir evento socket en tiempo real
    // ==========================================
    try {
      const io = global.io;

      if (io) {
        const nowIso = new Date().toISOString();

        for (const r of rows) {
          const room = `chat_programados:${Number(r.id_configuracion)}:${Number(r.id_cliente_chat_center)}`;

          io.to(room).emit('PROGRAMADO_ESTADO', {
            id: null,
            ui_key: `${r.uuid_lote}:${r.id_cliente_chat_center}:${r.telefono}:${r.fecha_programada}`,
            uuid_lote: r.uuid_lote,

            id_configuracion: Number(r.id_configuracion),
            id_usuario: r.id_usuario != null ? Number(r.id_usuario) : null,
            id_cliente_chat_center: Number(r.id_cliente_chat_center),

            telefono: r.telefono,
            telefono_configuracion: r.telefono_configuracion,
            business_phone_id: r.business_phone_id,
            waba_id: r.waba_id,

            nombre_template: r.nombre_template,
            language_code: r.language_code,

            template_parameters_json: (() => {
              try {
                return JSON.parse(r.template_parameters_json || '[]');
              } catch {
                return [];
              }
            })(),

            header_format: r.header_format || null,

            header_parameters_json: (() => {
              try {
                return r.header_parameters_json
                  ? JSON.parse(r.header_parameters_json)
                  : null;
              } catch {
                return null;
              }
            })(),

            header_media_url: r.header_media_url || null,
            header_media_name: r.header_media_name || null,

            fecha_programada: r.fecha_programada,
            fecha_programada_utc: r.fecha_programada_utc,
            timezone: r.timezone,

            estado: 'pendiente',
            intentos: 0,
            max_intentos: 3,
            error_message: null,

            meta_json: (() => {
              try {
                return r.meta_json ? JSON.parse(r.meta_json) : null;
              } catch {
                return null;
              }
            })(),

            id_wamid_mensaje: null,
            enviado_en: null,

            creado_en: nowIso,
            actualizado_en: nowIso,

            source: 'programacion_creada',
          });
        }
      }
    } catch (emitErr) {
      console.warn('⚠️ Error emitiendo PROGRAMADO_ESTADO:', emitErr.message);
    }

    return res.json({
      ok: true,
      msg: 'Envío programado correctamente.',
      data: {
        uuid_lote,
        total_solicitados: selectedIds.length,
        total_programados: rows.length,
        total_descartados: selectedIds.length - rows.length,
        nombre_template,
        language_code,
        fecha_programada: dtLocal.toFormat('yyyy-LL-dd HH:mm:ss'),
        fecha_programada_utc,
        timezone: tz,
        header: {
          header_format: scheduledHeaderInfo.header_format || null,
          header_media_url: scheduledHeaderInfo.header_media_url || null,
          header_media_name: scheduledHeaderInfo.header_media_name || null,
          file_info: scheduledHeaderInfo.file_info || null,
        },
      },
    });
  } catch (error) {
    await t.rollback();
    console.error('❌ programarTemplateMasivo:', error);

    return res.status(500).json({
      ok: false,
      msg: 'Error al programar el envío masivo.',
      error: error.message,
    });
  }
};

exports.listarProgramadosPorChat = async (req, res) => {
  try {
    const id_configuracion = Number(req.query?.id_configuracion || 0) || null;
    const id_cliente_chat_center =
      Number(req.query?.id_cliente_chat_center || 0) || null;

    const limit = Math.min(Number(req.query?.limit || 50) || 50, 200);

    if (!id_configuracion || !id_cliente_chat_center) {
      return res.status(400).json({
        ok: false,
        msg: 'Faltan parámetros: id_configuracion, id_cliente_chat_center',
      });
    }

    const rows = await db.query(
      `
      SELECT
        id,
        uuid_lote,
        id_configuracion,
        id_usuario,
        id_cliente_chat_center,
        telefono,
        telefono_configuracion,
        business_phone_id,
        waba_id,
        nombre_template,
        language_code,
        template_parameters_json,
        header_format,
        header_parameters_json,
        header_media_url,
        header_media_name,
        fecha_programada,
        fecha_programada_utc,
        timezone,
        estado,
        intentos,
        max_intentos,
        error_message,
        meta_json,
        id_wamid_mensaje,
        enviado_en,
        creado_en,
        actualizado_en
      FROM template_envios_programados
      WHERE id_configuracion = ?
        AND id_cliente_chat_center = ?
      ORDER BY creado_en DESC
      LIMIT ?
      `,
      {
        replacements: [id_configuracion, id_cliente_chat_center, limit],
        type: db.QueryTypes.SELECT,
      },
    );

    const data = rows.map((r) => ({
      ...r,
      template_parameters_json: parseMaybeJSON(r.template_parameters_json, []),
      header_parameters_json: parseMaybeJSON(r.header_parameters_json, null),
      meta_json: parseMaybeJSON(r.meta_json, null),
    }));

    return res.json({
      ok: true,
      data: data.reverse(), // opcional: dejar ascendente para render timeline
    });
  } catch (error) {
    console.error('❌ listarProgramadosPorChat:', error);
    return res.status(500).json({
      ok: false,
      msg: 'Error al listar mensajes programados del chat.',
      error: error.message,
    });
  }
};

/* ────────────────────────────────────────────────
   1) Listar programados agrupados por lote (SSR)
   ──────────────────────────────────────────────── */

exports.programados_por_config = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.query.id_configuracion ?? 0);
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ ok: false, msg: 'id_configuracion es requerido' });
  }

  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 10)));
  const offset = (page - 1) * limit;

  const q = String(req.query.q ?? '').trim();
  const nombreTemplate = String(req.query.nombre_template ?? '').trim();
  const estado = String(req.query.estado ?? '')
    .trim()
    .toLowerCase();
  const fechaDesde = String(req.query.fecha_desde ?? '').trim();
  const fechaHasta = String(req.query.fecha_hasta ?? '').trim();

  // ── 1) Obtener UUIDs de lotes que coincidan con los filtros ──
  const loteWhere = ['t.id_configuracion = ?'];
  const loteParams = [id_configuracion];

  if (q) {
    const like = `%${q}%`;
    loteWhere.push(
      `(t.uuid_lote LIKE ? OR t.telefono LIKE ? OR t.nombre_template LIKE ?)`,
    );
    loteParams.push(like, like, like);
  }

  if (nombreTemplate) {
    loteWhere.push('t.nombre_template = ?');
    loteParams.push(nombreTemplate);
  }

  if (
    estado &&
    ['pendiente', 'enviado', 'error', 'procesando'].includes(estado)
  ) {
    loteWhere.push('t.estado = ?');
    loteParams.push(estado);
  }

  if (fechaDesde) {
    loteWhere.push('t.fecha_programada >= ?');
    loteParams.push(fechaDesde);
  }

  if (fechaHasta) {
    // Incluir todo el día
    loteWhere.push('t.fecha_programada <= ?');
    loteParams.push(`${fechaHasta} 23:59:59`);
  }

  const whereClause = loteWhere.join(' AND ');

  // Contar lotes únicos que coinciden
  const countSql = `
    SELECT COUNT(DISTINCT t.uuid_lote) AS totalLotes
    FROM template_envios_programados t
    WHERE ${whereClause}
  `;

  const [countRow] = await db.query(countSql, {
    replacements: loteParams,
    type: db.QueryTypes.SELECT,
  });

  const totalLotes = Number(countRow?.totalLotes ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalLotes / limit));

  if (totalLotes === 0) {
    return res.status(200).json({
      ok: true,
      data: [],
      pagination: { page, limit, totalLotes: 0, totalPages: 1 },
    });
  }

  // ── 2) Obtener UUIDs paginados (ordenados por creación más reciente) ──
  const uuidsSql = `
    SELECT uuid_lote, MAX(creado_en) AS max_creado
    FROM template_envios_programados t
    WHERE ${whereClause}
    GROUP BY uuid_lote
    ORDER BY max_creado DESC
    LIMIT ? OFFSET ?
  `;

  const uuidRows = await db.query(uuidsSql, {
    replacements: [...loteParams, limit, offset],
    type: db.QueryTypes.SELECT,
  });

  if (!uuidRows.length) {
    return res.status(200).json({
      ok: true,
      data: [],
      pagination: { page, limit, totalLotes, totalPages },
    });
  }

  const uuids = uuidRows.map((r) => r.uuid_lote);

  // ── 3) Traer todos los items de esos lotes ──
  // LEFT JOIN con clientes para traer nombre/apellido/email
  const dataSql = `
    SELECT
      t.*,
      c.nombre_cliente,
      c.apellido_cliente,
      c.email_cliente
    FROM template_envios_programados t
    LEFT JOIN clientes_chat_center c
      ON c.id = t.id_cliente_chat_center
      AND c.id_configuracion = t.id_configuracion
    WHERE t.uuid_lote IN (${uuids.map(() => '?').join(',')})
    ORDER BY t.fecha_programada ASC, t.id ASC
  `;

  const items = await db.query(dataSql, {
    replacements: uuids,
    type: db.QueryTypes.SELECT,
  });

  return res.status(200).json({
    ok: true,
    data: items,
    pagination: { page, limit, totalLotes, totalPages },
  });
});

/* ────────────────────────────────────────────────
   2) Templates disponibles (nombres únicos usados
      en envíos programados de esta configuración)
   ──────────────────────────────────────────────── */

exports.templates_programados = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.query.id_configuracion ?? 0);
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ ok: false, msg: 'id_configuracion es requerido' });
  }

  const rows = await db.query(
    `
    SELECT DISTINCT nombre_template
    FROM template_envios_programados
    WHERE id_configuracion = ?
      AND nombre_template IS NOT NULL
      AND nombre_template != ''
    ORDER BY nombre_template ASC
    `,
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  return res.status(200).json({
    ok: true,
    templates: rows.map((r) => r.nombre_template),
  });
});

exports.enviarVideoWhatsappFile = async (req, res) => {
  const { jwt_servidor, wa_token, phone_number_id } = req.body;

  if (!req.file || !wa_token || !phone_number_id) {
    return res.status(400).json({
      status: 400,
      message: 'Faltan campos: file, wa_token, phone_number_id',
    });
  }

  try {
    console.log(
      '[WA_VIDEO] Recibido file:',
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
    );

    // Buffer del archivo recibido
    const videoBuffer = req.file.buffer;

    // Convertir a H.264/AAC compatible con WhatsApp
    const videoOriginalSizeMB = videoBuffer.length / (1024 * 1024);
    console.log(
      `[WA_VIDEO] Tamaño original: ${videoOriginalSizeMB.toFixed(2)} MB`,
    );
    let convertedBuffer = videoBuffer;
    try {
      console.log('[WA_VIDEO] Convirtiendo video...');
      convertedBuffer = await convertVideoForWhatsApp(
        videoBuffer,
        req.file.originalname,
      );
      console.log(
        '[WA_VIDEO] Conversión OK. Tamaño:',
        (convertedBuffer.length / (1024 * 1024)).toFixed(2),
        'MB',
      );
    } catch (convErr) {
      if (convErr.isOversized || videoOriginalSizeMB > 15) {
        const msg = convErr.isOversized
          ? convErr.message
          : `El video pesa ${videoOriginalSizeMB.toFixed(2)}MB y no se pudo comprimir por debajo de 15MB. Enviá un video más corto o de menor resolución.`;
        console.error('[WA_VIDEO] Video demasiado pesado:', msg);
        return res.status(400).json({ status: 400, message: msg });
      }
      console.warn(
        '[WA_VIDEO] Conversión fallida, usando original:',
        convErr.message,
      );
    }

    // Subir a WhatsApp
    console.log('[WA_VIDEO] Subiendo a WhatsApp...');
    const uploadForm = new FormData();
    uploadForm.append('file', convertedBuffer, {
      filename: 'video.mp4',
      contentType: 'video/mp4',
    });
    uploadForm.append('type', 'video/mp4');
    uploadForm.append('messaging_product', 'whatsapp');

    const uploadResponse = await axios.post(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${phone_number_id}/media`,
      uploadForm,
      {
        headers: {
          Authorization: `Bearer ${wa_token}`,
          ...uploadForm.getHeaders(),
        },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    );

    const media_id = uploadResponse.data?.id;
    if (!media_id) throw new Error('WhatsApp no retornó media_id');

    console.log('[WA_VIDEO] ✅ media_id:', media_id);
    return res.json({ status: 200, media_id });
  } catch (err) {
    console.error('[WA_VIDEO] Error:', err?.response?.data || err.message);
    return res.status(500).json({
      status: 500,
      message: err?.response?.data?.error?.message || err.message,
    });
  }
};

exports.eliminarTemplateMeta = async (req, res) => {
  try {
    const { id_configuracion, template_name, hsm_id } = req.body;

    if (!id_configuracion || !template_name) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos: id_configuracion y/o template_name',
      });
    }

    const cfg = await getConfigFromDB(Number(id_configuracion));
    if (!cfg) {
      return res.status(200).json({
        success: false,
        message: 'Configuración inválida o sin token/WABA_ID',
      });
    }

    if (!cfg.WABA_ID) {
      return res.status(200).json({
        success: false,
        message: 'No se encontró WABA_ID (id_whatsapp) en la configuración',
      });
    }

    const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.WABA_ID}/message_templates`;

    // Params: siempre name, y hsm_id si viene
    const params = { name: template_name };
    if (hsm_id) params.hsm_id = hsm_id;

    const resp = await axios.delete(url, {
      params,
      headers: { Authorization: `Bearer ${cfg.ACCESS_TOKEN}` },
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log('[DELETE_TEMPLATE]', {
      template_name,
      hsm_id: hsm_id || 'N/A',
      waba_id: cfg.WABA_ID,
      meta_status: resp.status,
      meta_data: resp.data,
    });

    if (resp.status >= 200 && resp.status < 300 && resp.data?.success) {
      return res.json({
        success: true,
        message: `Plantilla "${template_name}" eliminada de Meta.`,
      });
    }

    return res.status(200).json({
      success: false,
      meta_status: resp.status,
      error: resp.data,
      message:
        resp.data?.error?.error_user_msg ||
        resp.data?.error?.message ||
        'Meta no pudo eliminar la plantilla',
    });
  } catch (e) {
    console.error('[DELETE_TEMPLATE] Error:', e.message);
    return res.status(500).json({
      success: false,
      message: 'Error interno al eliminar plantilla',
      error: e.message,
    });
  }
};

/* ────────────────────────────────────────────────
   3) Editar fecha/hora de un lote programado
      Solo afecta items pendientes (no toca los ya enviados ni los en proceso)
   ──────────────────────────────────────────────── */
exports.editarFechaLote = catchAsync(async (req, res) => {
  const {
    uuid_lote,
    id_configuracion,
    fecha_programada, // 'YYYY-MM-DD HH:mm:ss' en hora local
    timezone = 'America/Guayaquil',
  } = req.body || {};

  if (!uuid_lote || !id_configuracion || !fecha_programada) {
    return res.status(400).json({
      ok: false,
      msg: 'Faltan campos: uuid_lote, id_configuracion, fecha_programada',
    });
  }

  // Validar timezone + parsear
  const tz = String(timezone).trim();
  const dtLocal = DateTime.fromSQL(String(fecha_programada), { zone: tz });

  if (!dtLocal.isValid) {
    return res.status(400).json({
      ok: false,
      msg: 'fecha_programada o timezone inválidos.',
      error: dtLocal.invalidExplanation || dtLocal.invalidReason,
    });
  }

  // Validar que sea a futuro (con 1 min de tolerancia)
  const ahora = DateTime.utc();
  if (dtLocal.toUTC() <= ahora.plus({ minutes: 1 })) {
    return res.status(400).json({
      ok: false,
      msg: 'La nueva fecha debe ser al menos 1 minuto en el futuro.',
    });
  }

  const fechaLocalSql = dtLocal.toFormat('yyyy-LL-dd HH:mm:ss');
  const fechaUtcSql = dtLocal.toUTC().toFormat('yyyy-LL-dd HH:mm:ss');

  // Solo reprogramamos los pendientes del lote
  const [result] = await db.query(
    `
    UPDATE template_envios_programados
       SET fecha_programada = ?,
           fecha_programada_utc = ?,
           timezone = ?,
           actualizado_en = NOW()
     WHERE uuid_lote = ?
       AND id_configuracion = ?
       AND estado = 'pendiente'
    `,
    {
      replacements: [
        fechaLocalSql,
        fechaUtcSql,
        tz,
        uuid_lote,
        Number(id_configuracion),
      ],
    },
  );

  const afectados = result?.affectedRows ?? result ?? 0;

  if (!afectados) {
    return res.status(200).json({
      ok: false,
      msg: 'No hay mensajes pendientes que reprogramar en este lote (pueden estar enviados, en proceso o cancelados).',
    });
  }

  return res.json({
    ok: true,
    msg: `Se reprogramaron ${afectados} mensaje(s) pendiente(s).`,
    data: {
      uuid_lote,
      afectados,
      nueva_fecha_local: fechaLocalSql,
      nueva_fecha_utc: fechaUtcSql,
      timezone: tz,
    },
  });
});

/* ────────────────────────────────────────────────
   4) Cancelar lote
      - Solo marca como 'cancelado' los pendientes
      - Devuelve cuántos se cancelaron, cuántos ya se enviaron, cuántos fallaron
   ──────────────────────────────────────────────── */
exports.cancelarLote = catchAsync(async (req, res) => {
  const { uuid_lote, id_configuracion } = req.body || {};

  if (!uuid_lote || !id_configuracion) {
    return res.status(400).json({
      ok: false,
      msg: 'Faltan campos: uuid_lote, id_configuracion',
    });
  }

  // 1) Resumen previo
  const resumen = await db.query(
    `
    SELECT estado, COUNT(*) AS total
      FROM template_envios_programados
     WHERE uuid_lote = ?
       AND id_configuracion = ?
     GROUP BY estado
    `,
    {
      replacements: [uuid_lote, Number(id_configuracion)],
      type: db.QueryTypes.SELECT,
    },
  );

  const conteo = resumen.reduce((acc, r) => {
    acc[r.estado] = Number(r.total);
    return acc;
  }, {});

  const pendientes = conteo.pendiente || 0;
  const procesando = conteo.procesando || 0;
  const enviados = conteo.enviado || 0;
  const errores = conteo.error || 0;
  const cancelados_previos = conteo.cancelado || 0;

  if (pendientes + procesando + enviados + errores + cancelados_previos === 0) {
    return res.status(404).json({
      ok: false,
      msg: 'El lote no existe o no pertenece a esta configuración.',
    });
  }

  // 2) Si ya no hay nada pendiente, no hay qué cancelar
  if (pendientes === 0) {
    return res.status(200).json({
      ok: false,
      msg:
        procesando > 0
          ? 'El lote ya se está procesando. No se puede cancelar en este momento.'
          : 'El lote ya no tiene mensajes pendientes que cancelar.',
      data: {
        enviados,
        errores,
        procesando,
        cancelados_previos,
        pendientes: 0,
      },
    });
  }

  // 3) Cancelar solo los pendientes
  const [result] = await db.query(
    `
    UPDATE template_envios_programados
       SET estado = 'cancelado',
           actualizado_en = NOW()
     WHERE uuid_lote = ?
       AND id_configuracion = ?
       AND estado = 'pendiente'
    `,
    {
      replacements: [uuid_lote, Number(id_configuracion)],
    },
  );

  const cancelados = result?.affectedRows ?? result ?? 0;

  // 4) Mensaje adaptado al contexto
  let msg = `Lote cancelado. Se cancelaron ${cancelados} mensaje(s) pendiente(s).`;
  if (procesando > 0) {
    msg += ` ⚠️ Ya se estaban procesando ${procesando} mensaje(s), esos pueden haberse enviado igual.`;
  }
  if (enviados > 0) {
    msg += ` ${enviados} ya fueron enviados previamente y no se pueden deshacer.`;
  }

  return res.json({
    ok: true,
    msg,
    data: {
      uuid_lote,
      cancelados,
      enviados,
      errores,
      procesando,
    },
  });
});

/* ────────────────────────────────────────────────
   5) Reintentar fallidos + pendientes atascados del lote
      - estado = 'error'
      - estado = 'pendiente' AND intentos >= max_intentos  (stuck)
      Los vuelve a 'pendiente', intentos=0, error_message=null
      y opcionalmente mueve fecha_programada_utc = NOW() para que salgan ya.
   ──────────────────────────────────────────────── */
exports.reintentarLote = catchAsync(async (req, res) => {
  const {
    uuid_lote,
    id_configuracion,
    reenviar_ahora = true, // si true, reprograma a NOW()
  } = req.body || {};

  if (!uuid_lote || !id_configuracion) {
    return res.status(400).json({
      ok: false,
      msg: 'Faltan campos: uuid_lote, id_configuracion',
    });
  }

  const setFechaSql = reenviar_ahora
    ? `, fecha_programada = NOW()
       , fecha_programada_utc = UTC_TIMESTAMP()`
    : '';

  const [result] = await db.query(
    `
    UPDATE template_envios_programados
       SET estado = 'pendiente',
           intentos = 0,
           error_message = NULL,
           actualizado_en = NOW()
           ${setFechaSql}
     WHERE uuid_lote = ?
       AND id_configuracion = ?
       AND (
            estado = 'error'
            OR (estado = 'pendiente' AND intentos >= max_intentos)
       )
    `,
    {
      replacements: [uuid_lote, Number(id_configuracion)],
    },
  );

  const afectados = result?.affectedRows ?? result ?? 0;

  if (!afectados) {
    return res.status(200).json({
      ok: false,
      msg: 'No hay mensajes para reintentar en este lote (ningún error ni pendiente atascado).',
    });
  }

  return res.json({
    ok: true,
    msg: `Se reencolaron ${afectados} mensaje(s) para reintento${
      reenviar_ahora ? ' inmediato' : ''
    }.`,
    data: { uuid_lote, afectados, reenviar_ahora },
  });
});

// GET /whatsapp_managment/numero_status
exports.numero_status = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.query;
  if (!id_configuracion) return res.json({ status: 'CONNECTED' });

  const [cfg] = await db.query(
    `SELECT token, id_telefono, wa_status, wa_status_at
     FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!cfg) return res.json({ status: 'CONNECTED' });

  if (!cfg.token || !cfg.id_telefono) {
    await db.query(
      `UPDATE configuraciones SET wa_status = 'CONNECTED', wa_status_at = NOW() WHERE id = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
    );
    return res.json({ status: 'CONNECTED', cleaned: true });
  }

  // Si el último check fue hace menos de 1 hora, devolver caché
  const unaHora = 60 * 60 * 1000;
  const ahora = Date.now();
  const ultimoCheck = cfg.wa_status_at
    ? new Date(cfg.wa_status_at).getTime()
    : 0;

  if (cfg.wa_status && ahora - ultimoCheck < unaHora) {
    return res.json({
      status: cfg.wa_status,
      cached: true,
      next_check: new Date(ultimoCheck + unaHora).toISOString(),
    });
  }

  // Llamar a Meta
  try {
    const response = await axios.get(
      `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${cfg.id_telefono}`,
      {
        params: {
          // ★ AGREGADO: status (campo oficial de Meta)
          fields:
            'status,display_phone_number,verified_name,quality_rating,platform_type,throughput,webhook_configuration',
          access_token: cfg.token,
        },
        timeout: 8000,
      },
    );

    const data = response.data;
    let status = 'CONNECTED';

    // PRIORIDAD 1: campo status oficial de Meta
    if (data?.status && data.status.toUpperCase() !== 'CONNECTED') {
      status = data.status.toUpperCase(); // DISCONNECTED, PENDING, MIGRATED, etc.
    }
    // PRIORIDAD 2: throughput bloqueado = baneado
    else if (data?.throughput?.level === 'NOT_ALLOWED') {
      status = 'BANNED';
    }
    // PRIORIDAD 3: calidad roja = flagged
    else if (data?.quality_rating === 'RED') {
      status = 'FLAGGED';
    }

    await db.query(
      `UPDATE configuraciones SET wa_status = ?, wa_status_at = NOW() WHERE id = ?`,
      { replacements: [status, id_configuracion], type: db.QueryTypes.UPDATE },
    );

    return res.json({ status, cached: false });
  } catch (err) {
    const code = err?.response?.data?.error?.code;
    const msg = err?.response?.data?.error?.message || '';

    let status = 'UNKNOWN';
    if (code === 190 || msg.includes('Invalid OAuth')) status = 'TOKEN_EXPIRED';
    if (code === 100 || msg.includes('suspended')) status = 'SUSPENDED';
    if (code === 80007) status = 'RATE_LIMITED';

    await db.query(
      `UPDATE configuraciones SET wa_status = ?, wa_status_at = NOW() WHERE id = ?`,
      { replacements: [status, id_configuracion], type: db.QueryTypes.UPDATE },
    );

    return res.json({ status, cached: false });
  }
});

// POST /whatsapp_managment/limpiar_credenciales_whatsapp
// Limpia las credenciales de WhatsApp para permitir reconexión desde /conexiones
exports.limpiar_credenciales_whatsapp = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;
  if (!id_configuracion) {
    return res
      .status(400)
      .json({ ok: false, message: 'id_configuracion requerido' });
  }

  await db.query(
    `UPDATE configuraciones
     SET id_whatsapp = NULL,
         id_telefono = NULL,
         token = NULL,
         webhook_url = NULL,
         wa_status = NULL,
         wa_status_at = NULL
     WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.UPDATE },
  );

  return res.json({ ok: true, message: 'Credenciales limpiadas' });
});
