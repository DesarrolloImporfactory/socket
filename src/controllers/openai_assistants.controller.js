const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db, db_2 } = require('../database/config');
const axios = require('axios');
const { QueryTypes } = require('sequelize');
const OpenaiAssistants = require('../models/openai_assistants.model');
const {
  obtenerDatosClienteParaAssistant,
  informacionProductos,
  informacionProductosVinculado,
  procesarCombosParaIA,
} = require('../utils/datosClienteAssistant');

exports.datosCliente = catchAsync(async (req, res, next) => {
  const { id_plataforma, telefono } = req.body;

  try {
    const datosCliente = await obtenerDatosClienteParaAssistant(
      id_plataforma,
      telefono,
    );

    res.status(200).json({
      status: '200',
      data: datosCliente,
    });
  } catch (error) {
    return next(
      new AppError('Error al obtener datos del cliente para el assistant', 500),
    );
  }
});

exports.mensaje_assistant = catchAsync(async (req, res, next) => {
  const {
    mensaje,
    id_thread,
    id_plataforma,
    id_configuracion,
    telefono,
    api_key_openai,
    business_phone_id,
    accessToken,
  } = req.body;

  const assistants = await db.query(
    `SELECT assistant_id, tipo, productos, tiempo_remarketing, tomar_productos FROM openai_assistants WHERE id_configuracion = ? AND activo = 1`,
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!assistants || assistants.length === 0) {
    res.status(400).json({
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    });
  }

  let bloqueInfo = '';
  let tipoInfo = null;

  if (id_plataforma) {
    const datosCliente = await obtenerDatosClienteParaAssistant(
      id_plataforma,
      telefono,
    );
    bloqueInfo = datosCliente.bloque || '';
    tipoInfo = datosCliente.tipo || null;
  }

  let assistant_id = null;
  let tipo_asistente = '';
  let tiempo_remarketing = null;

  if (tipoInfo === 'datos_guia') {
    const logistic = assistants.find(
      (a) => a.tipo.toLowerCase() === 'logistico',
    );
    assistant_id = logistic?.assistant_id;
    tipo_asistente = 'IA_logistica';
  } else if (tipoInfo === 'datos_pedido') {
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
    assistant_id = sales?.assistant_id;

    tiempo_remarketing = sales?.tiempo_remarketing;
    tipo_asistente = 'IA_ventas';

    if (sales?.productos && Array.isArray(sales.productos)) {
      /* console.log('productos: ' + sales.productos); */

      if (sales?.tomar_productos == 'imporsuit') {
        bloqueInfo += await informacionProductosVinculado(sales.productos);
      } else {
        bloqueInfo += await informacionProductos(sales.productos);
      }
    }
  } else {
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
    assistant_id = sales?.assistant_id;

    tiempo_remarketing = sales?.tiempo_remarketing;
    tipo_asistente = 'IA_ventas';

    if (sales?.productos && Array.isArray(sales.productos)) {
      /* console.log('productos: ' + sales.productos); */

      if (sales?.tomar_productos == 'imporsuit') {
        bloqueInfo += await informacionProductosVinculado(sales.productos);
      } else {
        bloqueInfo += await informacionProductos(sales.productos);
      }
    }
  }

  if (!assistant_id) {
    res.status(400).json({
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    });
  }

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  // Enviar contexto
  if (bloqueInfo) {
    await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      {
        role: 'user',
        content: `🧾 Información del cliente para usar como contexto:\n\n${bloqueInfo}`,
      },
      { headers },
    );
  }

  // Enviar mensaje del usuario
  await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    {
      role: 'user',
      content: mensaje,
    },
    { headers },
  );

  // Ejecutar assistant
  const run = await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/runs`,
    {
      assistant_id,
      max_completion_tokens: 200,
    },
    { headers },
  );

  const run_id = run.data.id;
  if (!run_id) {
    res.status(400).json({
      status: 400,
      error: 'No se pudo ejecutar el assistant.',
    });
  }

  // Esperar respuesta
  let status = 'queued';
  let intentos = 0;

  while (status !== 'completed' && status !== 'failed' && intentos < 20) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    intentos++;

    const statusRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
      { headers },
    );

    status = statusRes.data.status;
  }

  if (status === 'failed') {
    return res.status(400).json({
      status: 400,
      error: 'Falló la ejecución del assistant.',
    });
  }

  // Obtener respuesta final
  const messagesRes = await axios.get(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    { headers },
  );

  const mensajes = messagesRes.data.data || [];
  const respuesta = mensajes
    .reverse()
    .find((msg) => msg.role === 'assistant' && msg.run_id === run_id)
    ?.content[0]?.text?.value;

  if (tiempo_remarketing && tiempo_remarketing > 0) {
    const tiempoDisparo = new Date(
      Date.now() + tiempo_remarketing * 60 * 60 * 1000,
    );

    let existe = false;

    // 1. Buscar si ya existe un registro con mismo telefono, id_configuracion y mismo día de tiempo_disparo
    const rows = await db.query(
      `
    SELECT tiempo_disparo 
    FROM remarketing_pendientes 
    WHERE telefono = ? 
      AND id_configuracion = ?
      AND DATE(tiempo_disparo) = DATE(?)
    LIMIT 1
    `,
      {
        replacements: [telefono, id_configuracion, tiempoDisparo],
        type: db.QueryTypes.SELECT,
      },
    );

    // 2. Si ya existe, no insertamos
    if (rows.length > 0) {
      /* console.log(
        'Ya existe un remarketing para este día, no se inserta nada.'
      ); */
      existe = true;
    }

    // 3. Insertar si no existe
    if (!existe) {
      // 3. Insertar si no existe
      await db.query(
        `INSERT INTO remarketing_pendientes 
    (telefono, id_configuracion, business_phone_id, access_token, openai_token, assistant_id, mensaje, tipo_asistente, tiempo_disparo, id_thread) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            telefono,
            id_configuracion,
            business_phone_id,
            accessToken,
            api_key_openai,
            assistant_id,
            respuesta,
            tipo_asistente,
            tiempoDisparo,
            id_thread,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }
  }

  res.status(200).json({
    status: 200,
    respuesta: respuesta || 'No se obtuvo respuesta del assistant.',
    tipo_asistente: tipo_asistente,
    bloqueInfo: bloqueInfo,
  });
});

/* Informacion de asistentes */
exports.info_asistentes = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;

  try {
    const [configuracion] = await db.query(
      'SELECT api_key_openai FROM configuraciones WHERE id = ?',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    let api_key_openai = null;

    if (!configuracion) {
      return next(
        new AppError('No se encontró configuración para la plataforma', 400),
      );
    }

    api_key_openai = configuracion.api_key_openai;

    // Traer ambos tipos de asistentes
    const asistentes = await db.query(
      'SELECT * FROM openai_assistants WHERE id_configuracion = ? AND tipo IN ("logistico", "ventas")',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    let logistico = null;
    let ventas = null;

    asistentes.forEach((asistente) => {
      if (asistente.tipo === 'logistico') {
        logistico = {
          id: asistente.id,
          nombre_bot: asistente.nombre_bot,
          assistant_id: asistente.assistant_id,
          activo: asistente.activo,
          prompt: asistente.prompt,
        };
      } else if (asistente.tipo === 'ventas') {
        ventas = {
          id: asistente.id,
          nombre_bot: asistente.nombre_bot,
          assistant_id: asistente.assistant_id,
          activo: asistente.activo,
          prompt: asistente.prompt,
          productos: asistente.productos,
          tomar_productos: asistente.tomar_productos,
          tiempo_remarketing: asistente.tiempo_remarketing,
        };
      }
    });

    return res.status(200).json({
      status: 200,
      data: {
        api_key_openai,
        logistico: logistico || {},
        ventas: ventas || {},
      },
    });
  } catch (error) {
    console.error('Error al buscar info_asistentes:', error);
    return res.status(500).json({
      status: 500,
      title: 'Error',
      message: 'Ocurrió un error al al buscar info_asistentes',
    });
  }
});

// ============== Helpers OpenAI ==============
function getClientHeaders(api_key) {
  return {
    Authorization: `Bearer ${api_key}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}

function toNumberOrUndefined(v) {
  if (v === null || v === undefined) return undefined;
  // si viene como string "1" o "0.7"
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  // si ya viene number
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

// Valida que la API key funcione (llamada barata)
async function validarApiKeyOpenAI(api_key) {
  const headers = getClientHeaders(api_key);
  // Un GET simple a /models suele funcionar para validar credenciales
  // (también puede usar /v1/me si existiera, pero /models es común)
  await axios.get('https://api.openai.com/v1/models', { headers });
  return true;
}

// Crea assistant en la cuenta del cliente según la plantilla
async function crearAssistantEnCuentaCliente(templateRow, api_key) {
  const headers = getClientHeaders(api_key);

  const temperature = toNumberOrUndefined(templateRow.temperature);
  const top_p = toNumberOrUndefined(templateRow.top_p);

  let tools = [];
  try {
    tools = templateRow.tools_json ? JSON.parse(templateRow.tools_json) : [];
  } catch {
    tools = [];
  }

  let metadata = undefined;
  try {
    metadata = templateRow.metadata_json
      ? JSON.parse(templateRow.metadata_json)
      : undefined;
  } catch {
    metadata = undefined;
  }

  let response_format = undefined;
  try {
    response_format = templateRow.response_format_json
      ? JSON.parse(templateRow.response_format_json)
      : undefined;
  } catch {
    response_format = undefined;
  }

  const payload = {
    name: templateRow.nombre,
    model: templateRow.model || 'gpt-4.1-mini',
    instructions: templateRow.instructions || '',
    tools,
    metadata,
    temperature, // ✅ number o undefined (NO string)
    top_p, // ✅ number o undefined (NO string)
    response_format,
  };

  // limpiar undefined
  Object.keys(payload).forEach(
    (k) => payload[k] === undefined && delete payload[k],
  );

  const res = await axios.post(
    'https://api.openai.com/v1/assistants',
    payload,
    { headers },
  );
  return res.data;
}

// Bootstrap idempotente
async function bootstrapAssistantsForClient(
  id_configuracion,
  api_key,
  tipo_configuracion,
) {
  const permitidos = templatesPermitidosPorTipo(tipo_configuracion);

  // 1) Traer templates activos SOLO de esos keys
  const placeholders = permitidos.map(() => '?').join(',');
  const templates = await db.query(
    `SELECT template_key, nombre, model, instructions, tools_json, metadata_json, temperature, top_p, response_format_json
     FROM oia_assistant_templates
     WHERE activo = 1 AND template_key IN (${placeholders})`,
    { replacements: permitidos, type: db.QueryTypes.SELECT },
  );

  const results = { created: [], skipped: [], failed: [] };

  for (const t of templates) {
    const template_key = t.template_key;

    const existing = await db.query(
      `SELECT assistant_id FROM oia_assistants_cliente
       WHERE id_configuracion = ? AND template_key = ?
       LIMIT 1`,
      {
        replacements: [id_configuracion, template_key],
        type: db.QueryTypes.SELECT,
      },
    );

    if (existing && existing.length > 0 && existing[0].assistant_id) {
      results.skipped.push({
        template_key,
        assistant_id: existing[0].assistant_id,
      });
      continue;
    }

    try {
      const created = await crearAssistantEnCuentaCliente(t, api_key);

      await db.query(
        `INSERT INTO oia_assistants_cliente (id_configuracion, template_key, assistant_id, model)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE assistant_id = VALUES(assistant_id), model = VALUES(model)`,
        {
          replacements: [
            id_configuracion,
            template_key,
            created.id,
            created.model || t.model || 'gpt-4.1-mini',
          ],
          type: db.QueryTypes.INSERT,
        },
      );

      results.created.push({
        template_key,
        assistant_id: created.id,
        model: created.model,
      });
    } catch (err) {
      results.failed.push({
        template_key,
        error: err?.response?.data?.error?.message || err.message,
      });
    }
  }

  // (Opcional) si faltan templates permitidos porque no están en templates table
  const encontrados = new Set(templates.map((x) => x.template_key));
  const faltantes = permitidos.filter((k) => !encontrados.has(k));
  if (faltantes.length) results.missing_templates = faltantes;

  return results;
}

function templatesPermitidosPorTipo(tipo_configuracion) {
  const t = (tipo_configuracion || '').toLowerCase().trim();

  const map = {
    imporshop: [
      'contacto_inicial_ventas',
      'ventas_productos_imporshop',
      'separador_productos',
    ],
    ventas: [
      'contacto_inicial_ventas',
      'ventas_productos',
      'ventas_servicios',
      'separador_productos',
    ],
    imporfactory: [
      'contacto_inicial',
      'plataformas_clases',
      'productos_proveedores',
      'ventas_imporfactory',
      'cotizaciones_imporfactory',
      'separador_productos',
    ],
    eventos: [
      'contacto_inicial_eventos',
      'ventas_eventos',
      'separador_productos',
    ],
  };

  // Si el tipo no existe, por defecto "ventas"
  return map[t] || map.ventas;
}

// ============== Controller ==============
exports.actualizar_api_key_openai = catchAsync(async (req, res, next) => {
  const { id_configuracion, api_key, tipo_configuracion } = req.body;

  if (!id_configuracion || !api_key || !tipo_configuracion) {
    return next(
      new AppError(
        'Faltan campos: id_configuracion, api_key, tipo_configuracion',
        400,
      ),
    );
  }

  // 1) Validar key antes de guardar (recomendado)
  try {
    await validarApiKeyOpenAI(api_key);
  } catch (e) {
    return next(
      new AppError('API Key de OpenAI inválida o sin permisos.', 400),
    );
  }

  // 2) Guardar key
  await db.query(`UPDATE configuraciones SET api_key_openai = ? WHERE id = ?`, {
    replacements: [api_key, id_configuracion],
    type: db.QueryTypes.UPDATE,
  });

  // 3) Bootstrap assistants (crear clones en la cuenta del cliente)
  const bootstrap = await bootstrapAssistantsForClient(
    id_configuracion,
    api_key,
    tipo_configuracion,
  );

  return res.status(200).json({
    status: '200',
    message:
      'API key actualizada y assistants creados/asegurados correctamente',
    bootstrap, // created / skipped / failed
  });
});

exports.actualizar_ia_logisctica = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre_bot, assistant_id, activo } = req.body;

  try {
    const [existe] = await db.query(
      `SELECT id FROM openai_assistants WHERE id_configuracion = ? AND tipo = "logistico"`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (existe) {
      // Ya existe, entonces actualiza
      await db.query(
        `UPDATE openai_assistants SET nombre_bot = ?, assistant_id = ?, activo = ? 
         WHERE id_configuracion = ? AND tipo = "logistico"`,
        {
          replacements: [nombre_bot, assistant_id, activo, id_configuracion],
          type: db.QueryTypes.UPDATE,
        },
      );
    } else {
      // No existe, entonces inserta
      await db.query(
        `INSERT INTO openai_assistants (id_configuracion, tipo, nombre_bot, assistant_id, activo) 
         VALUES (?, "logistico", ?, ?, ?)`,
        {
          replacements: [id_configuracion, nombre_bot, assistant_id, activo],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    res.status(200).json({
      status: '200',
      message: 'Asistente logístico actualizado correctamente',
    });
  } catch (error) {
    console.error(error);
    return next(new AppError('Error al actualizar asistente logístico', 500));
  }
});

exports.actualizar_ia_ventas = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    nombre_bot,
    activo,
    tiempo_remarketing,
    tipo_venta,
  } = req.body;

  try {
    const [existe] = await db.query(
      `SELECT id FROM openai_assistants WHERE id_configuracion = ? AND tipo = "ventas"`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (existe) {
      // Ya existe, entonces actualiza
      await db.query(
        `UPDATE openai_assistants SET nombre_bot = ?, activo = ?, ofrecer = ?, tiempo_remarketing = ?
         WHERE id_configuracion = ? AND tipo = "ventas"`,
        {
          replacements: [
            nombre_bot,
            activo,
            tipo_venta,
            tiempo_remarketing,
            id_configuracion,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
    } else {
      // No existe, entonces inserta
      await db.query(
        `INSERT INTO openai_assistants 
(id_configuracion, tipo, nombre_bot, activo, ofrecer, tiempo_remarketing) 
VALUES (?, "ventas", ?, ?, ?, ?)`,
        {
          replacements: [
            id_configuracion,
            nombre_bot,
            activo,
            tipo_venta,
            tiempo_remarketing,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    res.status(200).json({
      status: '200',
      message: 'Asistente ventas actualizado correctamente',
    });
  } catch (error) {
    console.error(error);
    return next(new AppError('Error al actualizar asistente ventas', 500));
  }
});

const obtenerURLImagen = (imagePath, serverURL) => {
  // Verificar si el imagePath no es null
  if (imagePath) {
    // Verificar si el imagePath ya es una URL completa
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      // Si ya es una URL completa, retornar solo el imagePath
      return imagePath;
    } else {
      // Si no es una URL completa, agregar el serverURL al inicio
      return `${serverURL}${imagePath}`;
    }
  } else {
    // Manejar el caso cuando imagePath es null
    console.error('imagePath es null o undefined');

    return null; // o un valor por defecto si prefieres
  }
};

exports.enviar_mensaje_gpt = async (req, res) => {
  const { mensaje, id_chat, id_thread_chat, id_plataforma, pais } = req.body;

  if (!mensaje || !id_chat || !id_thread_chat) {
    return res.status(400).json({
      status: 400,
      title: 'Error',
      message: 'Faltan parámetros',
    });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('Missing OPENAI_API_KEY env var');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    let assistantId = 'asst_UVA7p8j7JINZi7M0BkrKMUSF';

    if (pais == 'EC') {
      assistantId = 'asst_UVA7p8j7JINZi7M0BkrKMUSF';
    } else if (pais == 'MX') {
      assistantId = 'asst_shnGt8Pr5raINBP5oDktNhuT';
    }

    // Insertar mensaje del usuario (rol_mensaje = 1)
    await db_2.query(
      `INSERT INTO mensajes_gpt_imporsuit (id_thread, texto_mensaje, rol_mensaje, fecha_creacion)
       VALUES (?, ?, 1, NOW())`,
      {
        replacements: [id_chat, mensaje],
        type: QueryTypes.INSERT,
      },
    );

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };

    // Enviar mensaje del usuario
    await axios.post(
      `https://api.openai.com/v1/threads/${id_thread_chat}/messages`,
      {
        role: 'user',
        content: mensaje,
      },
      { headers },
    );

    // Ejecutar assistant
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${id_thread_chat}/runs`,
      {
        assistant_id: assistantId,
        max_completion_tokens: 800,
      },
      { headers },
    );

    const run_id = run.data.id;

    if (!run_id) {
      return res.status(400).json({
        status: 400,
        error: 'No se pudo ejecutar el assistant.',
      });
    }

    // Esperar respuesta
    let status = 'queued';
    let intentos = 0;

    while (status !== 'completed' && status !== 'failed' && intentos < 20) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      intentos++;

      const statusRes = await axios.get(
        `https://api.openai.com/v1/threads/${id_thread_chat}/runs/${run_id}`,
        { headers },
      );

      status = statusRes.data.status;
    }

    if (status === 'failed') {
      return res.status(400).json({
        status: 400,
        error: 'Falló la ejecución del assistant.',
      });
    }

    // Obtener respuesta final
    const messagesRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread_chat}/messages`,
      { headers },
    );

    const mensajes = messagesRes.data.data || [];
    const respuesta = mensajes
      .reverse()
      .find((msg) => msg.role === 'assistant' && msg.run_id === run_id)
      ?.content?.[0]?.text?.value;

    if (!respuesta) {
      return res.status(500).json({
        status: 500,
        message: 'No se obtuvo respuesta del assistant.',
      });
    }

    // Guardar respuesta del assistant (rol_mensaje = 0)
    await db_2.query(
      `INSERT INTO mensajes_gpt_imporsuit (id_thread, texto_mensaje, rol_mensaje, fecha_creacion)
       VALUES (?, ?, 0, NOW())`,
      {
        replacements: [id_chat, respuesta],
        type: QueryTypes.INSERT,
      },
    );

    res.status(200).json({
      status: 200,
      message: 'Mensaje enviado correctamente',
      assistant_message: respuesta,
    });
  } catch (error) {
    console.error('Error en enviar_mensaje_gpt:', error.message);
    res.status(500).json({
      status: 500,
      message: 'Error interno del servidor',
      error: error.message,
    });
  }
};

/* sicronizacion de plantillas */
// ✅ API key QUEMADA solo para uso puntual (una vez)
const MASTER_OPENAI_KEY = 'PON_AQUI_TU_API_KEY_MAESTRA';

// Helper: headers para Assistants v2
function getOpenAIHeaders() {
  return {
    Authorization: `Bearer ${MASTER_OPENAI_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
}

// GET assistant desde su cuenta (maestra)
async function fetchAssistant(assistant_id) {
  const headers = getOpenAIHeaders();
  const url = `https://api.openai.com/v1/assistants/${assistant_id}`;
  const res = await axios.get(url, { headers });
  return res.data;
}

// UPSERT a oia_assistant_templates
async function upsertTemplate({
  template_key,
  nombre,
  assistantData,
  force = true,
}) {
  const model = assistantData.model || 'gpt-4.1-mini';
  const instructions = assistantData.instructions || '';
  const tools = Array.isArray(assistantData.tools) ? assistantData.tools : [];
  const metadata = assistantData.metadata || null;

  const temperature = assistantData.temperature ?? null;
  const top_p = assistantData.top_p ?? null;
  const response_format = assistantData.response_format ?? null;

  // Si force=false y ya hay instructions, no las pisa
  let finalInstructions = instructions;

  if (!force) {
    const existing = await db.query(
      `SELECT instructions FROM oia_assistant_templates WHERE template_key = ? LIMIT 1`,
      { replacements: [template_key], type: db.QueryTypes.SELECT },
    );
    const existingInstructions = existing?.[0]?.instructions || '';
    if (existingInstructions.trim().length > 0) {
      finalInstructions = existingInstructions;
    }
  }

  // ✅ Guardar JSON como string. Si es null => null
  const toolsJson = tools ? JSON.stringify(tools) : null;
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  // response_format puede venir como string "auto" o como objeto; guardémoslo siempre como JSON válido.
  // - si es string, lo convertimos a JSON string (incluye comillas)
  // - si es objeto, JSON.stringify normal
  const responseFormatJson =
    response_format == null
      ? null
      : typeof response_format === 'string'
        ? JSON.stringify(response_format)
        : JSON.stringify(response_format);

  await db.query(
    `
    INSERT INTO oia_assistant_templates
      (template_key, nombre, model, instructions, tools_json, metadata_json, temperature, top_p, response_format_json, activo)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON DUPLICATE KEY UPDATE
      nombre = VALUES(nombre),
      model = VALUES(model),
      instructions = VALUES(instructions),
      tools_json = VALUES(tools_json),
      metadata_json = VALUES(metadata_json),
      temperature = VALUES(temperature),
      top_p = VALUES(top_p),
      response_format_json = VALUES(response_format_json),
      activo = 1
    `,
    {
      replacements: [
        template_key,
        nombre,
        model,
        finalInstructions,
        toolsJson,
        metadataJson,
        temperature,
        top_p,
        responseFormatJson,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
}

/**
 * POST /openai_assistants/sync_templates_from_oia_asistentes
 * Body opcional:
 * {
 *   "solo_tipo": "ventas_productos",
 *   "force": true
 * }
 */
exports.sync_templates_from_oia_asistentes = async (req, res) => {
  try {
    if (!MASTER_OPENAI_KEY || MASTER_OPENAI_KEY.includes('PON_AQUI')) {
      return res.status(500).json({
        status: 'fail',
        message: 'Falta configurar MASTER_OPENAI_KEY en el controller.',
      });
    }

    const { solo_tipo = null, force = true } = req.body || {};

    // 1) Leer tabla vieja
    const where = solo_tipo ? 'WHERE tipo = ?' : '';
    const asistRows = await db.query(
      `SELECT tipo, nombre_bot, assistant_id FROM oia_asistentes ${where}`,
      {
        replacements: solo_tipo ? [solo_tipo] : [],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!asistRows || asistRows.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No se encontraron registros en oia_asistentes.',
      });
    }

    const results = [];
    for (const row of asistRows) {
      const template_key = row.tipo; // mapeo directo
      const nombre = row.nombre_bot || row.tipo;
      const assistant_id = row.assistant_id;

      try {
        // 2) Traer assistant real desde OpenAI
        const assistantData = await fetchAssistant(assistant_id);

        // 3) Upsert template
        await upsertTemplate({
          template_key,
          nombre,
          assistantData,
          force: !!force,
        });

        results.push({
          template_key,
          ok: true,
          model: assistantData.model || null,
          tools_count: Array.isArray(assistantData.tools)
            ? assistantData.tools.length
            : 0,
        });
      } catch (err) {
        results.push({
          template_key,
          ok: false,
          error:
            err?.response?.data?.error?.message ||
            err?.response?.data ||
            err.message,
        });
      }
    }

    return res.json({
      status: 'success',
      total: results.length,
      ok: results.filter((x) => x.ok).length,
      fail: results.filter((x) => !x.ok).length,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      status: 'fail',
      message: 'Error interno.',
      error: err.message,
    });
  }
};
/* sicronizacion de plantillas */
