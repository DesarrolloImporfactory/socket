const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const fsSync = require('fs'); // Para `fs.createReadStream`

const {
  cancelRemarketingWithResponse,
} = require('../../services/remarketing.service');

const {
  procesarAsistenteMensajeVentas,
  procesarAsistenteMensajeImporfactory,
  separadorProductos,
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
  try {
    // Elimina la parte de la URL base (https://chat.imporfactory.app) de la rutaArchivo
    const rutaLocalRelativa = rutaArchivo.replace(
      'https://chat.imporfactory.app',
      ''
    );

    /* console.log('__dirname: ' + __dirname); */
    // Aquí usamos path.join() para asegurar que la ruta esté bien construida
    const rutaLocalAbsoluta = path.join(
      __dirname,
      '..',
      '..',
      rutaLocalRelativa
    );

    // Asegúrate de que la ruta sea válida y corresponde al archivo en tu servidor
    /* console.log('Ruta local ajustada:', rutaLocalAbsoluta); */

    const form = new FormData();
    form.append('file', fsSync.createReadStream(rutaLocalAbsoluta)); // Usa la ruta local absoluta
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

    /* console.log('Respuesta completa:', response.data); */

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

async function enviarAsistenteGptVentas({
  mensaje,
  id_plataforma,
  id_configuracion,
  telefono,
  api_key_openai,
  id_thread,
  business_phone_id,
  accessToken,
  estado_contacto,
  id_cliente,
  lista_productos = null
}) {
  try {
    const data = await procesarAsistenteMensajeVentas({
      mensaje,
      id_plataforma,
      id_configuracion,
      telefono,
      api_key_openai,
      id_thread,
      business_phone_id,
      accessToken,
      estado_contacto,
      id_cliente,
      lista_productos,
    });

    if (data?.status === 200) {
      await log(`✅ Respuesta asistente: ${JSON.stringify(data.respuesta)}`);
    } else {
      await log(`⚠️ Error en respuesta del asistente: ${JSON.stringify(data)}`);
    }
    /* console.log('respuesta asistente: ' + JSON.stringify(data)); */

    return data;
  } catch (err) {
    console.log(`❌ Error en enviarAsistenteGptVentas: ${err.message}`);
    await log(`❌ Error en enviarAsistenteGptVentas: ${err.message}`);
    return false;
  }
}

async function enviarAsistenteGptImporfactory({
  mensaje,
  id_plataforma,
  id_configuracion,
  telefono,
  api_key_openai,
  id_thread,
  business_phone_id,
  accessToken,
  estado_contacto,
}) {
  try {
    const data = await procesarAsistenteMensajeImporfactory({
      mensaje,
      id_plataforma,
      id_configuracion,
      telefono,
      api_key_openai,
      id_thread,
      business_phone_id,
      accessToken,
      estado_contacto,
    });

    if (data?.status === 200) {
      await log(`✅ Respuesta asistente: ${JSON.stringify(data.respuesta)}`);
    } else {
      await log(`⚠️ Error en respuesta del asistente: ${JSON.stringify(data)}`);
    }
    /* console.log('respuesta asistente: ' + JSON.stringify(data)); */

    return data;
  } catch (err) {
    console.log(`❌ Error en enviarAsistenteGptImporfactory: ${err.message}`);
    await log(`❌ Error en enviarAsistenteGptImporfactory: ${err.message}`);
    return false;
  }
}

async function separador_productos({
  mensaje,
  id_plataforma,
  id_configuracion,
  telefono,
  api_key_openai,
  id_thread,
  business_phone_id,
  accessToken,
  estado_contacto,
  id_cliente,
}) {
  try {
    // Llamada a la función separadorProductos, que es la lógica principal
    const data = await separadorProductos({
      mensaje,
      id_plataforma,
      id_configuracion,
      telefono,
      api_key_openai,
      id_thread,
      business_phone_id,
      accessToken,
      estado_contacto,
      id_cliente,
    });

    if (data?.status === 200) {
      await log(
        `✅ Respuesta separador de productos: ${JSON.stringify(data.respuesta)}`
      );
      return data; // Devuelve la respuesta exitosa
    } else {
      // Si hubo un error, registramos el error con la respuesta
      await log(
        `⚠️ Error en respuesta del separador de productos: ${JSON.stringify(
          data
        )}`
      );
      return data; // Devuelve la respuesta de error (con status !== 200)
    }
  } catch (err) {
    // Captura errores en el proceso y los loguea
    console.log(`❌ Error en separador_productos: ${err.message}`);
    await log(`❌ Error en separador_productos: ${err.message}`);
    return { status: 500, error: 'Error en la función separador_productos' }; // Devuelve un error general
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
  enviarAsistenteGptVentas,
  separador_productos,
  obtenerThreadId,
  enviarAsistenteGptImporfactory,
};
