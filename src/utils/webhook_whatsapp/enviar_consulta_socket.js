const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function enviarConsultaAPI(id_configuracion, celular_recibe) {
  await fs.mkdir(logsDir, { recursive: true });

  try {
    const response = await axios.post(
      'https://chat.imporfactory.app/api/v1/whatsapp/webhook',
      {
        id_configuracion,
        celular_recibe,
      },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (response.status === 200) {
      return response.data;
    } else {
      await fs.appendFile(
        path.join(logsDir, 'debug_log.txt'),
        `[${new Date().toISOString()}] ❌ Error HTTP ${
          response.status
        } - Respuesta: ${JSON.stringify(response.data)}\n`
      );
      return false;
    }
  } catch (err) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ❌ Error en enviarConsultaAPI: ${
        err.message
      }\n`
    );
    return false;
  }
}

module.exports = {
  enviarConsultaAPI,
};
