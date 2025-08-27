const axios = require('axios');
const MensajesClientes = require('../models/mensaje_cliente.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');

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
  });
};
