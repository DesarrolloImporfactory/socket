const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const Templates_chat_center = require('../../models/templates_chat_center.model');
const Configuraciones = require('../../models/configuraciones.model');
const { procesarMensajeTexto } = require('./procesarMensajeTexto');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function enviarMensajeTextoWhatsApp(
  accessToken,
  business_phone_id,
  phone_whatsapp_to,
  id_configuracion,
  id_template,
  responsable = ''
) {
  try {
    await fs.mkdir(logsDir, { recursive: true });

    // Obtener mensaje del template
    const template = await Templates_chat_center.findOne({
      where: {
        id_configuracion,
        id_template,
      },
    });

    if (!template || !template.mensaje) {
      await logError(`❌ No se encontró template con ID ${id_template}`);
      return;
    }

    const texto_mensaje = template.mensaje;

    // Enviar mensaje a WhatsApp
    const url = `https://graph.facebook.com/v20.0/${business_phone_id}/messages`;
    const data = {
      messaging_product: 'whatsapp',
      to: phone_whatsapp_to,
      type: 'text',
      text: { body: texto_mensaje },
    };

    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    await logInfo(
      `✅ Enviado a ${phone_whatsapp_to} - Respuesta: ${JSON.stringify(
        response.data
      )}`
    );

    // Acceder al ID del mensaje (no wamid)
    const mensajeId = response.data?.messages?.[0]?.id;
    if (!mensajeId) {
      await logError(`❌ No se recibió ID del mensaje`);
      return;
    }

    // Obtener configuración para registrar mensaje
    const config = await Configuraciones.findByPk(id_configuracion);
    if (!config) {
      await logError(
        `❌ No se encontró configuración con ID ${id_configuracion}`
      );
      return;
    }

    // Registrar mensaje en la base de datos
    await procesarMensajeTexto({
      id_configuracion,
      business_phone_id,
      nombre_cliente: config.nombre_configuracion || '',
      apellido_cliente: '',
      telefono_configuracion: config.telefono,
      phone_whatsapp_to,
      tipo_mensaje: 'text',
      texto_mensaje,
      ruta_archivo: null,
      responsable,
      wamid: mensajeId,
    });

    await logInfo(`💾 Mensaje guardado en DB para ${phone_whatsapp_to}`);
  } catch (err) {
    await logError(`❌ Error en enviarMensajeTextoWhatsApp: ${err.message}`);
  }
}

async function enviarMensajeWhatsapp({
  phone_whatsapp_to,
  texto_mensaje,
  business_phone_id,
  accessToken,
  id_configuracion,
  responsable = '',
}) {
  await fs.mkdir(logsDir, { recursive: true });

  const url = `https://graph.facebook.com/v20.0/${business_phone_id}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to: phone_whatsapp_to,
    type: 'text',
    text: { body: texto_mensaje },
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

    await logInfo(`HTTP ${status} - Respuesta: ${JSON.stringify(respData)}`);

    const mensajeId = respData?.messages?.[0]?.id;
    if (status >= 200 && status < 300 && mensajeId) {
      await logInfo(`✅ Mensaje enviado. ID: ${mensajeId}`);

      // Obtener configuración para procesar el mensaje
      const config = await Configuraciones.findByPk(id_configuracion);
      if (!config) {
        return;
      }

      // Registrar mensaje
      await procesarMensajeTexto({
        id_configuracion,
        business_phone_id,
        nombre_cliente: config.nombre_configuracion, // reutiliza nombre_configuración como nombre
        apellido_cliente: '',
        telefono_configuracion: config.telefono,
        phone_whatsapp_to,
        tipo_mensaje: 'text',
        texto_mensaje,
        ruta_archivo: null,
        responsable,
        wamid: mensajeId,
      });
    } else {
      const errorMsg = respData.error
        ? JSON.stringify(respData.error)
        : 'Respuesta inesperada';
      await logError(`❌ Error al enviar: ${errorMsg}`);
    }
  } catch (err) {
    await logError(`❌ Error en enviarMensajeWhatsapp: ${err.message}`);
  }
}

async function logInfo(msg) {
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

async function logError(msg) {
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

module.exports = { enviarMensajeTextoWhatsApp, enviarMensajeWhatsapp };
