const fb = require('../utils/facebookGraph');
const { db } = require('../database/config');
const Store = require('./messenger_store.service');
const FB_APP_ID = process.env.FB_APP_ID;

async function getPageTokenByPageId(page_id) {
  const [row] = await db.query(
    `SELECT page_access_token FROM messenger_pages WHERE page_id = ? AND status='active' LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.page_access_token || null;
}

async function getConfigIdByPageId(page_id) {
  const [row] = await db.query(
    `SELECT id_configuracion FROM messenger_pages WHERE page_id = ? AND status='active' LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.id_configuracion || null;
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
      hasDelivery: !!event.delivery,
      hasRead: !!event.read,
      hasPostback: !!event.postback,
    });

    if (!senderPsid || !pageId) return;

    // ---- 1) Primero: manejar ECHOS (para no pedir token con el PSID del usuario) ----
    if (event.message?.is_echo) {
      const appId = event.message?.app_id || null;

      // En echos: sender.id = PAGE, recipient.id = USUARIO
      const pageIdEcho = event.sender?.id;
      const psidEcho = event.recipient?.id;

      // Si el echo es de *tu propia app*, ya lo guardaste al enviar -> ignora
      if (String(appId || '') === String(FB_APP_ID)) {
        console.log('[SKIP][ECHO][OWN]', { mid: event.message?.mid, appId });
        return;
      }

      // Echo humano (Page Inbox/otra herramienta) -> persiste como OUT
      const id_cfg_echo = await getConfigIdByPageId(pageIdEcho);
      if (!id_cfg_echo) {
        console.warn(
          '[ECHO][WARN] No id_configuracion para pageId',
          pageIdEcho
        );
        return;
      }

      await this.handleEcho({
        pageId: pageIdEcho,
        psid: psidEcho,
        message: event.message,
        id_configuracion: id_cfg_echo,
      });
      return;
    }

    // ---- 2) Luego: token/ids para mensajes normales, postbacks y estados ----
    const pageAccessToken = await getPageTokenByPageId(pageId);
    if (!pageAccessToken) {
      console.warn('No hay page_access_token para pageId', pageId);
      return;
    }

    const id_configuracion = await getConfigIdByPageId(pageId);
    if (!id_configuracion) {
      console.warn('[STORE][WARN] No id_configuracion para pageId', pageId);
    }

    if (event.message) {
      await this.handleMessage(
        senderPsid,
        event.message,
        pageAccessToken,
        pageId,
        id_configuracion
      );
    } else if (event.postback) {
      await this.handlePostback(
        senderPsid,
        event.postback,
        pageAccessToken,
        pageId,
        id_configuracion
      );
    } else if (event.delivery) {
      const watermark = event.delivery.watermark;
      const mids = event.delivery.mids || [];
      console.log('[DELIVERY][IN]', {
        pageId,
        watermark,
        midsCount: mids.length,
      });
      await Store.markDelivered({ page_id: pageId, watermark, mids });
    } else if (event.read) {
      const watermark = event.read.watermark;
      console.log('[READ][IN]', { pageId, watermark });
      await Store.markRead({ page_id: pageId, watermark });
    }

    console.log('[ROUTE_EVENT][DONE]', { pageId, senderPsid });
  }

  static async handleMessage(
    senderPsid,
    message,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    console.log('[HANDLE_MESSAGE][START]', { pageId, senderPsid });

    // 1) Persistir ENTRANTE
    try {
      const incomingSave = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        psid: senderPsid,
        text: message.text || null,
        attachments: message.attachments || null,
        quick_reply_payload: message.quick_reply?.payload || null,
        sticker_id: message.sticker_id || null,
        mid: message.mid || null,
        meta: { raw: message },
      });
      console.log('[STORE][INCOMING][OK]', incomingSave);
    } catch (e) {
      console.error('[STORE][INCOMING][ERROR]', e.message);
    }

    // 2) Feedback UX
    await fb.sendSenderAction(senderPsid, 'mark_seen', pageAccessToken);
    await fb.sendSenderAction(senderPsid, 'typing_on', pageAccessToken);

    // 3) Enviar respuesta (SALIENTE) + persistir
    const replyText = message.text
      ? `👋 Recibí tu mensaje: ${message.text}`
      : 'Recibí tu adjunto ✅';

    let sendRes;
    try {
      sendRes = await fb.sendText(senderPsid, replyText, pageAccessToken);
      console.log('[HANDLE_MESSAGE][SENT]', {
        pageId,
        senderPsid,
        reply_message_id: sendRes?.message_id,
        recipient_id: sendRes?.recipient_id,
      });

      await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        psid: senderPsid,
        text: replyText,
        mid: sendRes?.message_id || null,
        status: 'sent',
        meta: { response: sendRes },
      });
      console.log('[STORE][OUTGOING][OK]', { mid: sendRes?.message_id });
    } catch (e) {
      console.error(
        '[SEND/STORE][OUTGOING][ERROR]',
        e.response?.data || e.message
      );
      // Opcional: guardar como failed
      try {
        await Store.saveOutgoingMessage({
          id_configuracion,
          page_id: pageId,
          psid: senderPsid,
          text: replyText,
          status: 'failed',
          meta: { error: e.response?.data || e.message },
        });
      } catch (_) {}
    }

    await fb.sendSenderAction(senderPsid, 'typing_off', pageAccessToken);
    console.log('[HANDLE_MESSAGE][DONE]', { pageId, senderPsid });
  }

  static async handlePostback(
    senderPsid,
    postback,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    const payload = postback.payload || '';
    console.log('[HANDLE_POSTBACK]', { pageId, senderPsid, payload });

    // 1) Persistir ENTRANTE (postback)
    try {
      const incomingSave = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        psid: senderPsid,
        postback_payload: payload,
        mid: postback.mid || null,
        meta: { raw: postback },
      });
      console.log('[STORE][INCOMING_POSTBACK][OK]', incomingSave);
    } catch (e) {
      console.error('[STORE][INCOMING_POSTBACK][ERROR]', e.message);
    }

    // 2) Responder + persistir SALIENTE
    const text =
      payload === 'GET_STARTED'
        ? '¡Bienvenido! ¿En qué puedo ayudarle?'
        : `Postback: ${payload}`;

    try {
      const res = await fb.sendText(senderPsid, text, pageAccessToken);
      console.log('[HANDLE_POSTBACK][SENT]', {
        pageId,
        senderPsid,
        reply_message_id: res?.message_id,
      });

      await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        psid: senderPsid,
        text,
        mid: res?.message_id || null,
        status: 'sent',
        meta: { response: res },
      });
      console.log('[STORE][OUTGOING_POSTBACK][OK]', { mid: res?.message_id });
    } catch (e) {
      console.error(
        '[SEND/STORE][OUTGOING_POSTBACK][ERROR]',
        e.response?.data || e.message
      );
      try {
        await Store.saveOutgoingMessage({
          id_configuracion,
          page_id: pageId,
          psid: senderPsid,
          text,
          status: 'failed',
          meta: { error: e.response?.data || e.message },
        });
      } catch (_) {}
    }
  }

  static async handleEcho({ pageId, psid, message, id_configuracion }) {
    // Importante: los echos pueden venir con texto o adjuntos
    const text = message.text || null;
    const attachments = message.attachments || null;

    try {
      const saved = await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        psid,
        text,
        attachments,
        mid: message.mid || null,
        status: 'sent',
        meta: {
          echo: true,
          app_id: message.app_id || null,
          raw: message,
        },
      });
      console.log('[STORE][OUTGOING][ECHO_HUMAN][OK]', {
        mid: message.mid,
        saved,
      });
    } catch (e) {
      console.error('[STORE][OUTGOING][ECHO_HUMAN][ERROR]', e.message);
    }
  }
}

module.exports = MessengerService;
