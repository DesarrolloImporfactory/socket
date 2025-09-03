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
    const pageId = event.recipient?.id;
    const mid = event.message?.mid;
    const text = event.message?.text;

    console.log('[ROUTE_EVENT][IN]', {
      pageId,
      senderPsid,
      mid,
      text: text || '(no-text)',
    });

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

    console.log('[ROUTE_EVENT][DONE]', { pageId, senderPsid });
  }

  static async handleMessage(senderPsid, message, pageAccessToken, pageId) {
    console.log('[HANDLE_MESSAGE][START]', { pageId, senderPsid });

    await fb.sendSenderAction(senderPsid, 'mark_seen', pageAccessToken);
    await fb.sendSenderAction(senderPsid, 'typing_on', pageAccessToken);

    const text = message.text || '';
    let sendRes;
    if (text) {
      sendRes = await fb.sendText(
        senderPsid,
        `👋 Recibí tu mensaje: ${text}`,
        pageAccessToken
      );
    } else {
      sendRes = await fb.sendText(
        senderPsid,
        `Recibí tu adjunto ✅`,
        pageAccessToken
      );
    }

    await fb.sendSenderAction(senderPsid, 'typing_off', pageAccessToken);
    console.log('[HANDLE_MESSAGE][SENT]', {
      pageId,
      senderPsid,
      reply_message_id: sendRes?.message_id,
      recipient_id: sendRes?.recipient_id,
    });
    console.log('[HANDLE_MESSAGE][DONE]', { pageId, senderPsid });
  }

  static async handlePostback(senderPsid, postback, pageAccessToken, pageId) {
    const payload = postback.payload || '';
    console.log('[HANDLE_POSTBACK]', { pageId, senderPsid, payload });

    const text =
      payload === 'GET_STARTED'
        ? '¡Bienvenido! ¿En qué puedo ayudarle?'
        : `Postback: ${payload}`;

    const res = await fb.sendText(senderPsid, text, pageAccessToken);
    console.log('[HANDLE_POSTBACK][SENT]', {
      pageId,
      senderPsid,
      reply_message_id: res?.message_id,
    });
  }
}

module.exports = MessengerService;
