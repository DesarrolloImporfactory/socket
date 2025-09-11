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

    return response.data?.text || null;
  } catch (err) {
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
      await log(`✅ Respuesta asistente: ${data.respuesta}`);
    } else {
      await log(`⚠️ Error en respuesta del asistente: ${JSON.stringify(data)}`);
    }

    return data;
  } catch (err) {
    await log(`❌ Error en enviarAsistenteGpt: ${err.message}`);
    return false;
  }
}

async function obtenerThreadId(celular_recibe, apiKeyOpenAI) {
  try {
    const form = new FormData();
    form.append('id_cliente_chat_center', celular_recibe);
    form.append('api_key', apiKeyOpenAI);

    const response = await axios.post(
      'https://new.imporsuitpro.com/Pedidos/obtener_thread_id',
      form,
      { headers: form.getHeaders() }
    );

    const data = response.data;
    if (data?.thread_id) {
      await log(`✅ thread_id: ${data.thread_id}`);
      return data.thread_id;
    } else {
      await log(`⚠️ Respuesta inesperada: ${JSON.stringify(data)}`);
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
