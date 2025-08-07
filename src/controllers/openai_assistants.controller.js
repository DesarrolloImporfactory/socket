const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const axios = require('axios');
const OpenaiAssistants = require('../models/openai_assistants.model');
const {
  obtenerDatosClienteParaAssistant,
  informacionProductos,
} = require('../utils/datosClienteAssistant');

exports.datosCliente = catchAsync(async (req, res, next) => {
  const { id_plataforma, telefono } = req.body;

  try {
    const datosCliente = await obtenerDatosClienteParaAssistant(
      id_plataforma,
      telefono
    );

    res.status(200).json({
      status: '200',
      data: datosCliente,
    });
  } catch (error) {
    return next(
      new AppError('Error al obtener datos del cliente para el assistant', 500)
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
  } = req.body;

  const assistants = await db.query(
    `SELECT assistant_id, tipo, productos FROM openai_assistants WHERE id_configuracion = ? AND activo = 1`,
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    }
  );

  if (!assistants || assistants.length === 0) {
    res.status(400).json({
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    });
  }

  let bloqueInfo = '';
  let tipoInfo = null;

  if (id_plataforma !== null) {
    const datosCliente = await obtenerDatosClienteParaAssistant(
      id_plataforma,
      telefono
    );
    bloqueInfo = datosCliente.bloque || '';
    tipoInfo = datosCliente.tipo || null;
  }

  let assistant_id = null;
  if (tipoInfo === 'datos_guia') {
    const logistic = assistants.find(
      (a) => a.tipo.toLowerCase() === 'logistico'
    );
    assistant_id = logistic?.assistant_id;
  } else if (tipoInfo === 'datos_pedido') {
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
    assistant_id = sales?.assistant_id;

    if (sales?.productos && Array.isArray(sales.productos)) {
      console.log('productos: ' + sales.productos);
      bloqueInfo += await informacionProductos(sales.productos);
    }
  } else {
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
    assistant_id = sales?.assistant_id;

    if (sales?.productos && Array.isArray(sales.productos)) {
      console.log('productos: ' + sales.productos);
      bloqueInfo += await informacionProductos(sales.productos);
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
      { headers }
    );
  }

  // Enviar mensaje del usuario
  await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    {
      role: 'user',
      content: mensaje,
    },
    { headers }
  );

  // Ejecutar assistant
  const run = await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/runs`,
    {
      assistant_id,
      max_completion_tokens: 200,
    },
    { headers }
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
      { headers }
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
    { headers }
  );

  const mensajes = messagesRes.data.data || [];
  const respuesta = mensajes
    .reverse()
    .find((msg) => msg.role === 'assistant' && msg.run_id === run_id)
    ?.content[0]?.text?.value;

  res.status(200).json({
    status: 200,
    respuesta: respuesta || 'No se obtuvo respuesta del assistant.',
    /* bloqueInfo: bloqueInfo, */
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
      }
    );

    let api_key_openai = null;

    if (!configuracion) {
      return next(
        new AppError('No se encontró configuración para la plataforma', 400)
      );
    }

    api_key_openai = configuracion.api_key_openai;

    // Traer ambos tipos de asistentes
    const asistentes = await db.query(
      'SELECT * FROM openai_assistants WHERE id_configuracion = ? AND tipo IN ("logistico", "ventas")',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
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
        };
      }
    });

    if (!logistico || !ventas) {
      return next(
        new AppError(
          'No se encontraron ambos asistentes (logistico y ventas)',
          400
        )
      );
    }

    return res.status(200).json({
      status: 200,
      data: {
        api_key_openai,
        logistico,
        ventas,
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

exports.actualizar_api_key_openai = catchAsync(async (req, res, next) => {
  const { id_configuracion, api_key } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE configuraciones SET api_key_openai = ? WHERE id_configuracion = ?`,
      {
        replacements: [api_key, id_configuracion],
        type: db.QueryTypes.UPDATE,
      }
    );

    res.status(200).json({
      status: '200',
      message: 'api key actualizado correctamente',
    });
  } catch (error) {
    return next(new AppError('Error al actualizar api_key_openai', 500));
  }
});

exports.actualizar_ia_logisctica = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre_bot, assistant_id, activo } = req.body;

  try {
    const [existe] = await db.query(
      `SELECT id FROM openai_assistants WHERE id_configuracion = ? AND tipo = "logistico"`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    if (existe) {
      // Ya existe, entonces actualiza
      await db.query(
        `UPDATE openai_assistants SET nombre_bot = ?, assistant_id = ?, activo = ? 
         WHERE id_configuracion = ? AND tipo = "logistico"`,
        {
          replacements: [nombre_bot, assistant_id, activo, id_configuracion],
          type: db.QueryTypes.UPDATE,
        }
      );
    } else {
      // No existe, entonces inserta
      await db.query(
        `INSERT INTO openai_assistants (id_configuracion, tipo, nombre_bot, assistant_id, activo) 
         VALUES (?, "logistico", ?, ?, ?)`,
        {
          replacements: [id_configuracion, nombre_bot, assistant_id, activo],
          type: db.QueryTypes.INSERT,
        }
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
  const { id_configuracion, nombre_bot, assistant_id, activo, productos } =
    req.body;

  try {
    const [existe] = await db.query(
      `SELECT id FROM openai_assistants WHERE id_configuracion = ? AND tipo = "ventas"`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    if (existe) {
      // Ya existe, entonces actualiza
      await db.query(
        `UPDATE openai_assistants SET nombre_bot = ?, assistant_id = ?, activo = ? 
         WHERE id_configuracion = ? AND tipo = "ventas"`,
        {
          replacements: [nombre_bot, assistant_id, activo, id_configuracion],
          type: db.QueryTypes.UPDATE,
        }
      );
    } else {
      // No existe, entonces inserta
      await db.query(
        `INSERT INTO openai_assistants (id_configuracion, tipo, nombre_bot, assistant_id, activo) 
         VALUES (?, "ventas", ?, ?, ?)`,
        {
          replacements: [id_configuracion, nombre_bot, assistant_id, activo],
          type: db.QueryTypes.INSERT,
        }
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
