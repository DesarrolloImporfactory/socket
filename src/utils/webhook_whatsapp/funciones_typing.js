const axios = require('axios');

// Función para simular el "escribiendo..." en WhatsApp (sin enviar mensaje)
async function enviarEscribiendoWhatsapp(
  phone_whatsapp_from,
  business_phone_id,
  accessToken
) {
  try {
    const url = `https://graph.facebook.com/v13.0/${business_phone_id}/messages`;
    const data = {
      messaging_product: 'whatsapp',
      to: phone_whatsapp_from,
      type: 'typing_on',
    };

    await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    console.error('Error al enviar el estado "escribiendo":', error);
  }
}

// Función para desactivar el "escribiendo..." en WhatsApp
const detenerEscribiendoWhatsapp = async (
  phone_whatsapp_to,
  business_phone_id,
  accessToken
) => {
  const url = `https://graph.facebook.com/v14.0/${business_phone_id}/messages`;
  const body = {
    recipient_type: 'individual',
    to: phone_whatsapp_to,
    type: 'typing',
    typing: { status: 'inactive' }, // Detener el "escribiendo"
  };

  try {
    await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error("Error al detener 'escribiendo' en WhatsApp:", error);
  }
};

module.exports = {
  enviarEscribiendoWhatsapp,
  detenerEscribiendoWhatsapp,
};
