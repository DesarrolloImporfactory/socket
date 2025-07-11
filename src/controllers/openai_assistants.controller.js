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
  const { mensaje, id_thread, id_plataforma, telefono, api_key_openai } =
    req.body;

  const assistants = await db.query(
    `SELECT assistant_id, tipo, productos FROM openai_assistants WHERE id_plataforma = ? AND activo = 1`,
    {
      replacements: [id_plataforma],
      type: db.QueryTypes.SELECT,
    }
  );

  if (!assistants || assistants.length === 0) {
    res.status(400).json({
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    });
  }

  const datosCliente = await obtenerDatosClienteParaAssistant(
    id_plataforma,
    telefono
  );
  let bloqueInfo = datosCliente.bloque || null;
  const tipoInfo = datosCliente.tipo || null;

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
