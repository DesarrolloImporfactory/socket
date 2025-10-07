const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const fsSync = require('fs'); // Para `fs.createReadStream`

const {
  cancelRemarketingWithResponse,
} = require('../../services/remarketing.service');

const {
  procesarAsistenteMensaje,
} = require('../../services/mensaje_assistant.service');

const {
  obtenerOCrearThreadId,
} = require('../../services/obtener_thread.service');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function cancelarRemarketingEnNode(telefono, id_configuracion) {
  try {
    const response = await cancelRemarketingWithResponse({
      telefono,
      id_configuracion,
    });

    await log(`[Cancelar Remarketing] ${JSON.stringify(response)}`);
  } catch (error) {
    await log(`❌ Error en cancelarRemarketingEnNode: ${error.message}`);
  }
}

async function transcribirAudioConWhisperDesdeArchivo(
  rutaArchivo,
  apiKeyOpenAI
) {
  console.log('transcripcion de audio');
  try {
    const form = new FormData();
    form.append('file', fsSync.createReadStream(rutaArchivo));
    form.append('model', 'whisper-1');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${apiKeyOpenAI}`,
          ...form.getHeaders(),
        },
      }
    );

    // Verifica la respuesta completa para ver cómo está estructurada
    console.log('Respuesta completa:', response.data);

    return response.data?.text || null; // Asegúrate de que 'text' esté en la respuesta
  } catch (err) {
    console.log(
      `❌ Error en transcribirAudioConWhisperDesdeArchivo: ${err.message}`
    );
    await log(
      `❌ Error en transcribirAudioConWhisperDesdeArchivo: ${err.message}`
    );
    return null;
  }
}

async function enviarAsistenteGpt({
  mensaje,
  id_plataforma,
  id_configuracion,
  telefono,
  api_key_openai,
  id_thread,
  business_phone_id,
  accessToken,
}) {
  try {
    const data = await procesarAsistenteMensaje({
      mensaje,
      id_plataforma,
      id_configuracion,
      telefono,
      api_key_openai,
      id_thread,
      business_phone_id,
      accessToken,
    });

    if (data?.status === 200) {
      await log(`✅ Respuesta asistente: ${JSON.stringify(data.respuesta)}`);
    } else {
      await log(`⚠️ Error en respuesta del asistente: ${JSON.stringify(data)}`);
    }
    /* console.log('respuesta asistente: ' + JSON.stringify(data)); */

    return data;
  } catch (err) {
    await log(`❌ Error en enviarAsistenteGpt: ${err.message}`);
    return false;
  }
}

async function obtenerThreadId(id_cliente_chat_center, apiKeyOpenAI) {
  try {
    const thread_id = await obtenerOCrearThreadId(
      id_cliente_chat_center,
      apiKeyOpenAI
    );

    if (thread_id) {
      await log(`✅ thread_id: ${thread_id}`);
      return thread_id;
    } else {
      await log(`⚠️ No se pudo obtener el thread_id.`);
      return false;
    }
  } catch (err) {
    await log(`❌ Error en obtenerThreadId: ${err.message}`);
    return false;
  }
}

async function log(msg) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

module.exports = {
  cancelarRemarketingEnNode,
  transcribirAudioConWhisperDesdeArchivo,
  enviarAsistenteGpt,
  obtenerThreadId,
};
