const axios = require('axios');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const { db } = require('../database/config');

exports.sendWhatsappMessage = async ({
  telefono,
  mensaje,
  business_phone_id,
  accessToken,
  id_configuracion,
  responsable,
}) => {
  const url = `https://graph.facebook.com/v20.0/${business_phone_id}/messages`;

  const data = {
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'text',
    text: { body: mensaje },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const response = await axios.post(url, data, { headers });

  console.log('✅ Mensaje enviado:', response.data);

  const uid_whatsapp = telefono;

  // Extraer wamid del response
  const wamid = response.data?.messages?.[0]?.id || null;

  // Buscar cliente emisor o crearlo si no existe
  let cliente = await ClientesChatCenter.findOne({
    where: {
      celular_cliente: telefono,
      id_configuracion,
    },
  });

  if (!cliente) {
    cliente = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente: business_phone_id,
      nombre_cliente: '',
      apellido_cliente: '',
      celular_cliente: telefono,
    });
  }

  // Insertar el mensaje
  await MensajesClientes.create({
    id_configuracion,
    id_cliente: cliente.id,
    mid_mensaje: business_phone_id,
    tipo_mensaje: 'text',
    responsable,
    texto_mensaje: mensaje,
    ruta_archivo: null,
    rol_mensaje: 1,
    celular_recibe: cliente.id, // o 0 si aplica distinto
    uid_whatsapp,
    id_wamid_mensaje: wamid,
  });
};

exports.sendWhatsappMessageTemplate = async ({
  telefono,
  telefono_configuracion,
  business_phone_id,
  waba_id,
  accessToken,
  id_configuracion,
  responsable,
  nombre_template, // Nombre de la plantilla
  template_parameters, // Array con los valores para los placeholders
}) => {
  const { text: templateText, language: LANGUAGE_CODE } =
    await obtenerTextoPlantilla(nombre_template, accessToken, waba_id);

  if (!templateText) {
    console.error('No se pudo obtener el texto de la plantilla.');
    return {
      success: false,
      error: 'No se encontró el contenido de la plantilla',
    };
  }

  const url = `https://graph.facebook.com/v20.0/${business_phone_id}/messages`;

  // Verificar que template_parameters sea un array y tenga los datos necesarios
  if (!Array.isArray(template_parameters)) {
    throw new Error('template_parameters debe ser un array');
  }

  // Crear los parámetros para el template
  const components = template_parameters.map((param) => ({
    type: 'text',
    text: param,
  }));

  // Crear el objeto `ruta_archivo` con los parámetros del template
  let ruta_archivo = {};
  template_parameters.forEach((param, index) => {
    ruta_archivo[index + 1] = param; // Asigna los valores a las claves 1, 2, 3, etc.
  });

  const data = {
    messaging_product: 'whatsapp',
    to: telefono,
    type: 'template',
    template: {
      name: nombre_template, // Nombre del template de Meta
      language: {
        code: LANGUAGE_CODE, // Lengua que corresponde
      },
      components: [
        {
          type: 'body',
          parameters: components, // Aquí los placeholders serán reemplazados con los valores del array
        },
      ],
    },
  };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const response = await axios.post(url, data, { headers });

  console.log('✅ Mensaje de plantilla enviado:', response.data);

  const uid_whatsapp = telefono;

  // Extraer wamid del response
  const wamid = response.data?.messages?.[0]?.id || null;

  // Buscar cliente emisor o crearlo si no existe
  let cliente = await ClientesChatCenter.findOne({
    where: {
      celular_cliente: telefono,
      id_configuracion,
    },
  });

  if (!cliente) {
    cliente = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente: business_phone_id,
      nombre_cliente: '',
      apellido_cliente: '',
      celular_cliente: telefono,
    });
  }

  let id_cliente_configuracion = '';

  const [clienteConfiguracionExistente] = await db.query(
    'SELECT id FROM clientes_chat_center WHERE celular_cliente = ? AND id_configuracion = ?',
    {
      replacements: [telefono_configuracion, id_configuracion],
      type: db.QueryTypes.SELECT,
    }
  );

  if (!clienteConfiguracionExistente) {
    console.log('error no existe el cliente de la configuracion');
  } else {
    id_cliente_configuracion = clienteConfiguracionExistente.id;
  }

  // Insertar el mensaje
  await MensajesClientes.create({
    id_configuracion,
    id_cliente: id_cliente_configuracion,
    mid_mensaje: business_phone_id,
    tipo_mensaje: 'template',
    rol_mensaje: 1,
    celular_recibe: cliente.id,
    responsable,
    texto_mensaje: templateText, // Se mantiene el mensaje de texto
    ruta_archivo: JSON.stringify(ruta_archivo), // Convertir el objeto en string
    visto: 1,
    uid_whatsapp,
    id_wamid_mensaje: wamid,
    template_name: templateText,
    language_code: LANGUAGE_CODE,
  });
};

const obtenerTextoPlantilla = async (templateName, accessToken, waba_id) => {
  try {
    const ACCESS_TOKEN = accessToken;

    const response = await fetch(
      `https://graph.facebook.com/v17.0/${waba_id}/message_templates`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
      }
    );

    const data = await response.json();

    if (!data.data) {
      console.error('No se encontraron plantillas en la API.');
      return { text: null, language: null };
    }

    // Buscar la plantilla por nombre
    const plantilla = data.data.find((tpl) => tpl.name === templateName);

    if (!plantilla) {
      console.error(`No se encontró la plantilla con nombre: ${templateName}`);
      return { text: null, language: null };
    }

    // Extraer el texto del body de la plantilla
    const body = plantilla.components.find((comp) => comp.type === 'BODY');

    if (!body || !body.text) {
      console.error('La plantilla no tiene un cuerpo de texto.');
      return { text: null, language: null };
    }

    // Extraer el idioma de la plantilla
    const languageCode = plantilla.language || 'es'; // Si no tiene, por defecto "es"

    return { text: body.text, language: languageCode };
  } catch (error) {
    console.error('Error al obtener la plantilla:', error);
    return { text: null, language: null };
  }
};
