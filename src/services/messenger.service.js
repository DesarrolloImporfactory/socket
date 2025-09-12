const fb = require('../utils/facebookGraph');
const { db } = require('../database/config');
const Store = require('./messenger_store.service');

const FB_APP_ID = process.env.FB_APP_ID;

// Socket.IO (inyectado desde server.js)
let IO = null;

// helpers de rooms
const roomConv = (conversation_id) => `ms:conv:${conversation_id}`;
const roomCfg = (id_configuracion) => `ms:cfg:${id_configuracion}`;

// id “seguro” para no romper el front si insertId viene undefined
const safeMsgId = (dbId, mid) =>
  dbId || mid || `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
  static setIO(io) {
    IO = io;
  }

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

    if (!pageId) return;

    // --- 1) ECHOS ---
    if (event.message?.is_echo) {
      const appId = event.message?.app_id || null;
      const pageIdEcho = event.sender?.id; // en echos: sender.id = PAGE
      const psidEcho = event.recipient?.id; // recipient.id = USER

      if (String(appId || '') === String(FB_APP_ID)) {
        console.log('[SKIP][ECHO][OWN]', { mid: event.message?.mid, appId });
        return;
      }

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

    // --- 2) Mensajes / Postbacks ---
    // (delivery/read se manejan abajo y NO requieren senderPsid)
    const id_configuracion = await getConfigIdByPageId(pageId);
    if (!id_configuracion) {
      console.warn('[STORE][WARN] No id_configuracion para pageId', pageId);
    }

    // Mensaje normal
    if (event.message) {
      if (!senderPsid) {
        console.warn('[ROUTE_EVENT] message sin senderPsid; se ignora');
        return;
      }
      const pageAccessToken = await getPageTokenByPageId(pageId);
      if (!pageAccessToken) {
        console.warn('No hay page_access_token para pageId', pageId);
        return;
      }
      await this.handleMessage(
        senderPsid,
        event.message,
        pageAccessToken,
        pageId,
        id_configuracion
      );

      return;
    }

    // Postback
    if (event.postback) {
      if (!senderPsid) {
        console.warn('[ROUTE_EVENT] postback sin senderPsid; se ignora');
        return;
      }
      const pageAccessToken = await getPageTokenByPageId(pageId);
      if (!pageAccessToken) {
        console.warn('No hay page_access_token para pageId', pageId);
        return;
      }
      await this.handlePostback(
        senderPsid,
        event.postback,
        pageAccessToken,
        pageId,
        id_configuracion
      );

      return;
    }

    // --- 3) Estados (delivery/read) ---
    if (event.delivery) {
      const watermark = event.delivery.watermark;
      const mids = event.delivery.mids || [];
      console.log('[DELIVERY][IN]', {
        pageId,
        watermark,
        midsCount: mids.length,
      });

      await Store.markDelivered({ page_id: pageId, watermark, mids });

      const cfg = await getConfigIdByPageId(pageId);
      if (IO && cfg) {
        IO.to(roomCfg(cfg)).emit('MS_DELIVERED', {
          page_id: pageId,
          watermark,
          mids,
        });
      }

      return;
    }

    if (event.read) {
      const watermark = event.read.watermark;

      await Store.markRead({ page_id: pageId, watermark });

      const cfg = await getConfigIdByPageId(pageId);
      if (IO && cfg) {
        IO.to(roomCfg(cfg)).emit('MS_READ', { page_id: pageId, watermark });
      }

      return;
    }
  }

  static async handleMessage(
    senderPsid,
    message,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    // 1) Persistir ENTRANTE
    let incomingSave = null;
    try {
      incomingSave = await Store.saveIncomingMessage({
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

      // Notificar a la conversación y a la lista
      if (IO && incomingSave?.conversation_id) {
        IO.to(roomConv(incomingSave.conversation_id)).emit('MS_MESSAGE', {
          conversation_id: incomingSave.conversation_id,
          message: {
            id: safeMsgId(incomingSave.message_id, message.mid),
            direction: 'in',
            mid: message.mid || null,
            text: message.text || null,
            attachments: message.attachments || null,
            status: 'received',
            created_at: new Date().toISOString(),
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('MS_CONV_UPSERT', {
          id: incomingSave.conversation_id,
          last_message_at: new Date().toISOString(),
          last_incoming_at: new Date().toISOString(),
          preview: message.text || '(adjunto)',
          // unread_count: lo recalculas en front o ajustas acá si quieres
        });
      }
    } catch (e) {
      console.error('[STORE][INCOMING][ERROR]', e.message);
    }

    // 2) Feedback UX
    await fb.sendSenderAction(senderPsid, 'mark_seen', pageAccessToken);
    await fb.sendSenderAction(senderPsid, 'typing_on', pageAccessToken);

    try {
      const sendRes = await fb.sendText(senderPsid, replyText, pageAccessToken);
      const outSave = await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        psid: senderPsid,
        text: replyText,
        mid: sendRes?.message_id || null,
        status: 'sent',
        meta: { response: sendRes },
      });

      if (IO && incomingSave?.conversation_id) {
        IO.to(roomConv(incomingSave.conversation_id)).emit('MS_MESSAGE', {
          conversation_id: incomingSave.conversation_id,
          message: {
            id: safeMsgId(outSave?.message_id, sendRes?.message_id),
            direction: 'out',
            mid: sendRes?.message_id || null,
            text: replyText,
            status: 'sent',
            created_at: new Date().toISOString(),
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('MS_CONV_UPSERT', {
          id: incomingSave.conversation_id,
          last_message_at: new Date().toISOString(),
          last_outgoing_at: new Date().toISOString(),
          preview: replyText,
          unread_count: 0,
        });
      }
    } catch (e) {
      console.error(
        '[SEND/STORE][OUTGOING][ERROR]',
        e.response?.data || e.message
      );
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
  }

  static async handlePostback(
    senderPsid,
    postback,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    const payload = postback.payload || '';

    let incomingSave = null;
    try {
      incomingSave = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        psid: senderPsid,
        postback_payload: payload,
        mid: postback.mid || null,
        meta: { raw: postback },
      });

      if (IO && incomingSave?.conversation_id) {
        IO.to(roomConv(incomingSave.conversation_id)).emit('MS_MESSAGE', {
          conversation_id: incomingSave.conversation_id,
          message: {
            id: safeMsgId(incomingSave.message_id, postback.mid),
            direction: 'in',
            mid: postback.mid || null,
            text: null,
            postback_payload: payload,
            status: 'received',
            created_at: new Date().toISOString(),
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('MS_CONV_UPSERT', {
          id: incomingSave.conversation_id,
          last_message_at: new Date().toISOString(),
          last_incoming_at: new Date().toISOString(),
          preview: `Postback: ${payload}`,
        });
      }
    } catch (e) {
      console.error('[STORE][INCOMING_POSTBACK][ERROR]', e.message);
    }

    const text =
      payload === 'GET_STARTED'
        ? '¡Bienvenido! ¿En qué puedo ayudarle?'
        : `Postback: ${payload}`;

    try {
      const res = await fb.sendText(senderPsid, text, pageAccessToken);

      const outSave = await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        psid: senderPsid,
        text,
        mid: res?.message_id || null,
        status: 'sent',
        meta: { response: res },
      });

      if (IO && incomingSave?.conversation_id) {
        IO.to(roomConv(incomingSave.conversation_id)).emit('MS_MESSAGE', {
          conversation_id: incomingSave.conversation_id,
          message: {
            id: safeMsgId(outSave?.message_id, res?.message_id),
            direction: 'out',
            mid: res?.message_id || null,
            text,
            status: 'sent',
            created_at: new Date().toISOString(),
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('MS_CONV_UPSERT', {
          id: incomingSave.conversation_id,
          last_message_at: new Date().toISOString(),
          last_outgoing_at: new Date().toISOString(),
          preview: text,
          unread_count: 0,
        });
      }
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
        meta: { echo: true, app_id: message.app_id || null, raw: message },
      });

      const [conv] = await db.query(
        `SELECT id FROM messenger_conversations
          WHERE id_configuracion=? AND page_id=? AND psid=? LIMIT 1`,
        {
          replacements: [id_configuracion, pageId, psid],
          type: db.QueryTypes.SELECT,
        }
      );

      if (IO && conv?.id) {
        IO.to(roomConv(conv.id)).emit('MS_MESSAGE', {
          conversation_id: conv.id,
          message: {
            id: safeMsgId(saved?.message_id, message.mid),
            direction: 'out',
            mid: message.mid || null,
            text,
            attachments,
            status: 'sent',
            created_at: new Date().toISOString(),
            echo: true,
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('MS_CONV_UPSERT', {
          id: conv.id,
          last_message_at: new Date().toISOString(),
          last_outgoing_at: new Date().toISOString(),
          preview: text || '(adjunto)',
          unread_count: 0,
        });
      }
    } catch (e) {
      console.error('[STORE][OUTGOING][ECHO_HUMAN][ERROR]', e.message);
    }
  }
}

module.exports = MessengerService;
