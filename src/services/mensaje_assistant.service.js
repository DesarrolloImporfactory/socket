const axios = require('axios');
const { db } = require('../database/config');
const {
  obtenerDatosClienteParaAssistant,
  informacionProductos,
  informacionProductosVinculado,
} = require('../utils/datosClienteAssistant'); // Ajustar según organización
const { logInfo, logError } = require('../utils/logger'); // Helpers de log

async function procesarAsistenteMensaje(body) {
  const {
    mensaje,
    id_thread,
    id_plataforma,
    id_configuracion,
    telefono,
    api_key_openai,
    business_phone_id,
    accessToken,
  } = body;

  /* buscar informacion del thread */
  const openai_threads = await db.query(
    `SELECT numero_factura, numero_guia, bloque_productos
     FROM openai_threads 
     WHERE thread_id = ?`,
    {
      replacements: [id_thread],
      type: db.QueryTypes.SELECT,
    }
  );
  const openai_thread = openai_threads[0];

  // 1. Obtener assistants activos
  const assistants = await db.query(
    `SELECT assistant_id, tipo, productos, tiempo_remarketing, tomar_productos, bloque_productos 
     FROM openai_assistants 
     WHERE id_configuracion = ? AND activo = 1`,
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    }
  );

  if (!assistants || assistants.length === 0) {
    return {
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    };
  }

  let bloqueInfo = '';
  let tipoInfo = null;

  if (id_plataforma) {
    const datosCliente = await obtenerDatosClienteParaAssistant(
      id_plataforma,
      telefono,
      id_thread
    );
    bloqueInfo = datosCliente.bloque || '';
    tipoInfo = datosCliente.tipo || null;
  }

  let assistant_id = null;
  let tipo_asistente = '';
  let tiempo_remarketing = null;

  if (tipoInfo === 'datos_guia') {
    const logistic = assistants.find(
      (a) => a.tipo.toLowerCase() === 'logistico'
    );
    assistant_id = logistic?.assistant_id;
    tipo_asistente = 'IA_logistica';
  } else {
    const sales = assistants.find((a) => a.tipo.toLowerCase() === 'ventas');
    assistant_id = sales?.assistant_id;
    tipo_asistente = 'IA_ventas';
    tiempo_remarketing = sales?.tiempo_remarketing;

    if (sales.bloque_productos) {
      if (openai_thread.bloque_productos != sales.bloque_productos) {
        bloqueInfo +=
          '📦 Información de todos los productos que ofrecemos pero que no necesariamente estan en el pedido. Olvidearse de los productos anteriores a este mensaje:\n\n';
        bloqueInfo += sales.bloque_productos;

        // Actualizar tabla openai_threads con numero_factura y numero_guia
        const updateSql = `
          UPDATE openai_threads
          SET bloque_productos = ?
          WHERE thread_id = ?
        `;
        /* console.log('thread_id: ' + id_thread); */
        await db.query(updateSql, {
          replacements: [sales.bloque_productos, id_thread],
          type: db.QueryTypes.UPDATE,
        });
      }
    }
  }

  if (!assistant_id) {
    return {
      status: 400,
      error: 'No se encontró un assistant válido para este contexto',
    };
  }

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  // 2. Enviar contexto y mensaje del usuario
  if (bloqueInfo) {
    await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { role: 'user', content: `🧾 Información del cliente:\n\n${bloqueInfo}` },
      { headers }
    );
  }

  await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    { role: 'user', content: mensaje },
    { headers }
  );

  // 3. Ejecutar assistant
  const runRes = await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/runs`,
    { assistant_id, max_completion_tokens: 200 },
    { headers }
  );

  const run_id = runRes.data.id;
  if (!run_id) {
    return {
      status: 400,
      error: 'No se pudo ejecutar el assistant.',
    };
  }

  // 4. Esperar respuesta con polling
  let statusRun = 'queued',
    attempts = 0;
  while (statusRun !== 'completed' && statusRun !== 'failed' && attempts < 20) {
    await new Promise((r) => setTimeout(r, 1000));
    attempts++;
    const statusRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
      { headers }
    );
    statusRun = statusRes.data.status;
  }

  if (statusRun === 'failed') {
    return {
      status: 400,
      error: 'Falló la ejecución del assistant.',
    };
  }

  const messagesRes = await axios.get(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    { headers }
  );

  const mensajes = messagesRes.data.data || [];
  const respuesta = mensajes
    .reverse()
    .find((m) => m.role === 'assistant' && m.run_id === run_id)?.content?.[0]
    ?.text?.value;

  // 5. Guardar remarketing si aplica
  if (tiempo_remarketing > 0) {
    const tiempoDisparo = new Date(Date.now() + tiempo_remarketing * 3600000);

    const existing = await db.query(
      `SELECT tiempo_disparo FROM remarketing_pendientes
       WHERE telefono = ? AND id_configuracion = ? AND DATE(tiempo_disparo) = DATE(?)
       LIMIT 1`,
      {
        replacements: [telefono, id_configuracion, tiempoDisparo],
        type: db.QueryTypes.SELECT,
      }
    );

    if (existing.length === 0) {
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
        }
      );
    }
  }

  console.log('bloqueInfo: ' + bloqueInfo);

  return {
    status: 200,
    respuesta: respuesta || 'No se obtuvo respuesta del assistant.',
    tipo_asistente,
    bloqueInfo,
  };
}

module.exports = {
  procesarAsistenteMensaje,
};
