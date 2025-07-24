const fb = require('../utils/facebookGraph');

class MessengerService {
  static async routeEvent(event) {
    const senderPsid = event.sender && event.sender.id;

    if (!senderPsid) return;

    if (event.message) {
      return this.handleMessage(senderPsid, event.message);
    }

    if (event.postback) {
      return this.handlePostback(senderPsid, event.postback);
    }

    if (event.read) {
      // evento de read
      return;
    }

    if (event.delivery) {
      // evento de delivery
      return;
    }

    // Otros tipos...
    console.log('Evento no manejado:', Object.keys(event));
  }

  static async handleMessage(senderPsid, message) {
    // Marca visto y escribiendo (opcional)
    await fb.sendSenderAction(senderPsid, 'mark_seen');
    await fb.sendSenderAction(senderPsid, 'typing_on');

    const text = message.text || '';
    const attachments = message.attachments || [];

    // Aquí conectas con tu CRM: busca/crea cliente, guarda mensaje, etiqueta, etc.
    // await ChatService.saveIncomingMessage({ channel: 'messenger', senderPsid, text, attachments })

    if (text) {
      // Simple echo
      await fb.sendText(senderPsid, `👋 Recibí tu mensaje: ${text}`);
    } else if (attachments.length) {
      await fb.sendText(senderPsid, 'Recibí tu adjunto ✅');
    }

    await fb.sendSenderAction(senderPsid, 'typing_off');
  }

  static async handlePostback(senderPsid, postback) {
    const payload = postback.payload || '';

    // Maneja tu flujo de botones aquí
    switch (payload) {
      case 'GET_STARTED':
        await fb.sendText(senderPsid, '¡Bienvenido! ¿En qué puedo ayudarle?');
        break;
      default:
        await fb.sendText(senderPsid, `Postback recibido: ${payload}`);
        break;
    }
  }
}

module.exports = MessengerService;
