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
    const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${business_phone_id}/messages`;
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
    const config = await Configuraciones.findOne({
      where: {
        id: id_configuracion,
        suspendido: 0,
      },
    });
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

const { registrarErrorEnvio } = require('./erroresEnvio');

async function enviarMensajeWhatsapp({
  phone_whatsapp_to,
  texto_mensaje,
  business_phone_id,
  accessToken,
  id_configuracion,
  responsable = '',
  total_tokens = 0,
  // { modelo, input, cached, output, reasoning } de la respuesta de la IA.
  analytics = null,
}) {
  await fs.mkdir(logsDir, { recursive: true });

  const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${business_phone_id}/messages`;
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
      const config = await Configuraciones.findOne({
        where: {
          id: id_configuracion,
          suspendido: 0,
        },
      });
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
        total_tokens,
        analytics,
      });
    } else {
      const errorMsg = respData.error
        ? JSON.stringify(respData.error)
        : 'Respuesta inesperada';
      registrarErrorEnvio(phone_whatsapp_to, respData.error || errorMsg);
      await logError(`❌ Error al enviar: ${errorMsg}`);
    }
  } catch (err) {
    registrarErrorEnvio(
      phone_whatsapp_to,
      err.response?.data?.error || err.message,
    );
    await logError(`❌ Error en enviarMensajeWhatsapp: ${err.message}`);
  }
}

/* Opciones tocables: hasta 3 con títulos cortos van como botones; si no,
   como lista (título 24, descripción 72). En el chat queda el texto con las
   opciones, para que el asesor y el recap de la IA vean qué se ofreció. */
async function enviarOpcionesWhatsapp({
  phone_whatsapp_to,
  business_phone_id,
  accessToken,
  id_configuracion,
  cuerpo,
  opciones, // [{ id, titulo, descripcion? }]
  boton_lista = 'Ver opciones',
  texto_registro,
  responsable = '',
}) {
  const corto = (s, n) => {
    const t = String(s || '').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const comoBotones =
    opciones.length <= 3 && opciones.every((o) => o.titulo.length <= 20);
  const interactive = comoBotones
    ? {
        type: 'button',
        body: { text: cuerpo },
        action: {
          buttons: opciones.map((o) => ({
            type: 'reply',
            reply: { id: o.id, title: o.titulo },
          })),
        },
      }
    : {
        type: 'list',
        body: { text: cuerpo },
        action: {
          button: corto(boton_lista, 20),
          sections: [
            {
              title: 'Opciones',
              rows: opciones.slice(0, 10).map((o) => ({
                id: o.id,
                title: corto(o.titulo, 24),
                ...(o.descripcion
                  ? { description: corto(o.descripcion, 72) }
                  : {}),
              })),
            },
          ],
        },
      };

  const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${business_phone_id}/messages`;
  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: phone_whatsapp_to,
        type: 'interactive',
        interactive,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const mensajeId = response.data?.messages?.[0]?.id;
    if (!mensajeId) return { ok: false, error: 'sin id de mensaje' };

    const config = await Configuraciones.findOne({
      where: { id: id_configuracion, suspendido: 0 },
    });
    if (config) {
      await procesarMensajeTexto({
        id_configuracion,
        business_phone_id,
        nombre_cliente: config.nombre_configuracion,
        apellido_cliente: '',
        telefono_configuracion: config.telefono,
        phone_whatsapp_to,
        tipo_mensaje: 'text',
        texto_mensaje: texto_registro || cuerpo,
        ruta_archivo: null,
        responsable,
        wamid: mensajeId,
        total_tokens: 0,
      });
    }
    return { ok: true, formato: comoBotones ? 'botones' : 'lista' };
  } catch (err) {
    const e = err.response?.data?.error || err.message;
    registrarErrorEnvio(phone_whatsapp_to, e);
    await logError(`❌ Error en enviarOpcionesWhatsapp: ${JSON.stringify(e)}`);
    return { ok: false, error: e };
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

module.exports = {
  enviarMensajeTextoWhatsApp,
  enviarMensajeWhatsapp,
  enviarOpcionesWhatsapp,
};
