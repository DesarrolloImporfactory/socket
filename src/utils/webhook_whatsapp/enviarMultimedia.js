const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const Configuraciones = require('../../models/configuraciones.model');
const { procesarMensajeTexto } = require('./procesarMensajeTexto');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

// Función genérica para enviar medios (imagen/video)
async function enviarMedioWhatsapp({
  tipo, // "image" o "video"
  url_archivo,
  phone_whatsapp_to,
  business_phone_id,
  accessToken,
  id_configuracion = null,
  responsable = '',
}) {
  await fs.mkdir(logsDir, { recursive: true });

  const url = `https://graph.facebook.com/v20.0/${business_phone_id}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to: phone_whatsapp_to,
    type: tipo,
    [tipo]: {
      link: url_archivo,
    },
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const status = response.status;
    const respData = response.data;

    // Registro detallado en el log
    await logToFile(
      `[${new Date().toISOString()}] 📎 Envío ${tipo} - HTTP ${status}\n${JSON.stringify(
        respData
      )}\n`
    );

    // Obtener el ID del mensaje
    const mensajeId = respData?.messages?.[0]?.id;
    if (status >= 200 && status < 300 && mensajeId) {
      await logToFile(
        `[${new Date().toISOString()}] ✅ ${tipo} enviado correctamente. ID: ${mensajeId}\n`
      );

      // Si hay id_configuracion, procesamos el mensaje en la base de datos
      if (id_configuracion) {
        const config = await Configuraciones.findOne({
          where: {
            id: id_configuracion,
            suspendido: 0,
          },
        });
        if (config) {
          await procesarMensajeTexto({
            id_configuracion,
            business_phone_id,
            nombre_cliente: config.nombre_configuracion,
            apellido_cliente: '',
            telefono_configuracion: config.telefono,
            phone_whatsapp_to,
            tipo_mensaje: tipo,
            texto_mensaje: null,
            ruta_archivo: url_archivo,
            responsable,
            wamid: mensajeId,
          });
        }
      }
    } else {
      const errorMsg = respData?.error
        ? JSON.stringify(respData.error)
        : 'Respuesta inesperada';
      await logToFile(
        `[${new Date().toISOString()}] ❌ Error al enviar ${tipo}: ${errorMsg}\n`
      );
    }
  } catch (err) {
    await logToFile(
      `[${new Date().toISOString()}] ❌ Error axios al enviar ${tipo}: ${
        err.message
      }\n`
    );
  }
}

// Función para registrar los logs en el archivo
async function logToFile(message) {
  await fs.appendFile(path.join(logsDir, 'debug_log.txt'), message);
}

module.exports = { enviarMedioWhatsapp };
