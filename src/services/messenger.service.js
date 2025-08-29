const fb = require('../utils/facebookGraph');
const { db } = require('../database/config');

async function getPageTokenByPageId(page_id) {
  const [row] = await db.query(
    `SELECT page_access_token FROM messenger_pages WHERE page_id = ? AND status='active' LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.page_access_token || null;
}

class MessengerService {
  static async routeEvent(event) {
    const senderPsid = event.sender?.id;
    const pageId = event.recipient?.id; // <- muy importante

    if (!senderPsid || !pageId) return;

    const pageAccessToken = await getPageTokenByPageId(pageId);
    if (!pageAccessToken) {
      console.warn('No hay page_access_token para pageId', pageId);
      return;
    }

    if (event.message) {
      await this.handleMessage(
        senderPsid,
        event.message,
        pageAccessToken,
        pageId
      );
    } else if (event.postback) {
      await this.handlePostback(
        senderPsid,
        event.postback,
        pageAccessToken,
        pageId
      );
    }
  }

  static async handleMessage(senderPsid, message, pageAccessToken) {
    await fb.sendSenderAction(senderPsid, 'mark_seen', pageAccessToken);
    await fb.sendSenderAction(senderPsid, 'typing_on', pageAccessToken);

    const text = message.text || '';
    if (text) {
      await fb.sendText(
        senderPsid,
        `👋 Recibí tu mensaje: ${text}`,
        pageAccessToken
      );
    } else {
      await fb.sendText(senderPsid, `Recibí tu adjunto ✅`, pageAccessToken);
    }
    await fb.sendSenderAction(senderPsid, 'typing_off', pageAccessToken);
  }

  static async handlePostback(senderPsid, postback, pageAccessToken) {
    const payload = postback.payload || '';
    if (payload === 'GET_STARTED') {
      await fb.sendText(
        senderPsid,
        '¡Bienvenido! ¿En qué puedo ayudarle?',
        pageAccessToken
      );
    } else {
      await fb.sendText(senderPsid, `Postback: ${payload}`, pageAccessToken);
    }
  }
}

module.exports = MessengerService;
