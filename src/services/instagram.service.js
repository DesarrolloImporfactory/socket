const ig = require('../utils/instagramGraph');
const { db } = require('../database/config');
const Store = require('./instagram_store.service');

let IO = null;
const roomConv = (conversation_id) => `ig:conv:${conversation_id}`;
const roomCfg = (id_configuracion) => `ig:cfg:${id_configuracion}`;

async function getPageTokenByPageId(page_id) {
  const [row] = await db.query(
    `SELECT page_access_token FROM instagram_pages WHERE page_id=? AND status='active' LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.page_access_token || null;
}

async function getConfigIdByPageId(page_id) {
  const [row] = await db.query(
    `SELECT id_configuracion FROM instagram_pages WHERE page_id=? AND status='active' LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.id_configuracion || null;
}

const safeMsgId = (dbId, mid) =>
  dbId || mid || `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

class InstagramService {
  static setIO(io) {
    IO = io;
  }

  /**
   * Router de eventos Instagram (desde webhook Page, con messaging_product='instagram')
   */
  static async routeEvent(event) {
    // En IG, el evento llega en entry.messaging[*]
    // Diferencia clave: el user id es el "IGSID" (page-scoped para IG)
    const mp = event.messaging_product;
    if (mp !== 'instagram') {
      console.warn(
        '[IG ROUTE_EVENT] messaging_product distinto o ausente:',
        mp
      );
      // NO return;  // <-- durante pruebas, permite seguir (o mantén el guard si ya ves que llega correcto)
    }

    const pageId = event.recipient?.id; // Page ID
    const igsid = event.sender?.id; // Instagram Scoped User ID
    if (!pageId) console.warn('[IG ROUTE_EVENT] recipient.id ausente');
    if (!igsid) console.warn('[IG ROUTE_EVENT] sender.id (IGSID) ausente');

    const mid = event.message?.mid;
    const text = event.message?.text;

    console.log('[IG ROUTE_EVENT][IN]', {
      pageId,
      igsid,
      mid,
      text: text || '(no-text)',
      hasDelivery: !!event.delivery,
      hasRead: !!event.read,
      hasPostback: !!event.postback,
      isEcho: !!event.message?.is_echo,
    });

    const id_configuracion = await getConfigIdByPageId(pageId);
    if (!id_configuracion) {
      console.warn('[IG][WARN] No id_configuracion para pageId', pageId);
      return;
    }

    // IG no emite “is_echo” desde la Inbox como Messenger (si llegara, se podría manejar)
    if (event.message) {
      if (!igsid) {
        console.warn('[IG ROUTE_EVENT] message sin igsid; se ignora');
        return;
      }
      const pageAccessToken = await getPageTokenByPageId(pageId);
      if (!pageAccessToken) {
        console.warn('[IG] No page_access_token para pageId', pageId);
        return;
      }
      await this.handleMessage(
        igsid,
        event.message,
        pageAccessToken,
        pageId,
        id_configuracion
      );
      return;
    }

    // Si quieres soportar postbacks/quick_replies en IG:
    if (event.postback) {
      const pageAccessToken = await getPageTokenByPageId(pageId);
      if (!pageAccessToken) return;
      await this.handlePostback(
        igsid,
        event.postback,
        pageAccessToken,
        pageId,
        id_configuracion
      );
      return;
    }

    // (Opcional) delivery/read si tu app los recibe en IG
    if (event.read) {
      await Store.markRead({ id_configuracion, page_id: pageId, igsid });
      if (IO)
        IO.to(roomCfg(id_configuracion)).emit('IG_READ', { page_id: pageId });
      return;
    }
  }

  static async handleMessage(
    igsid,
    message,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    const createdAtNow = new Date().toISOString();
    let savedIn = null;
    try {
      savedIn = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        igsid,
        text: message.text || null,
        attachments: message.attachments || null,
        mid: message.mid || null,
        meta: { raw: message },
      });

      if (IO && savedIn?.conversation_id) {
        IO.to(roomConv(savedIn.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: savedIn.conversation_id,
          message: {
            id: safeMsgId(savedIn.message_id, message.mid),
            direction: 'in',
            mid: message.mid || null,
            text: message.text || null,
            attachments: message.attachments || null,
            status: 'received',
            created_at: createdAtNow,
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: savedIn.conversation_id,
          last_message_at: createdAtNow,
          last_incoming_at: createdAtNow,
          preview: message.text || '(adjunto)',
        });
      }
    } catch (e) {
      console.error('[IG STORE][INCOMING][ERROR]', e.message);
    }

    // UX feedback: opcional (no siempre soportado en IG)
    try {
      await ig.sendSenderAction(igsid, 'mark_seen', pageAccessToken);
      await ig.sendSenderAction(igsid, 'typing_off', pageAccessToken);
    } catch (e) {
      console.warn('[IG SENDER_ACTION][WARN]', e.response?.data || e.message);
    }
  }

  static async handlePostback(
    igsid,
    postback,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    const payload = postback.payload || '';
    const createdAtNow = new Date().toISOString();

    let savedIn = null;
    try {
      savedIn = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        igsid,
        text: null,
        attachments: null,
        mid: postback.mid || null,
        meta: { raw: postback, postback_payload: payload },
      });

      if (IO && savedIn?.conversation_id) {
        IO.to(roomConv(savedIn.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: savedIn.conversation_id,
          message: {
            id: safeMsgId(savedIn.message_id, postback.mid),
            direction: 'in',
            mid: postback.mid || null,
            text: `Postback: ${payload}`,
            status: 'received',
            created_at: createdAtNow,
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: savedIn.conversation_id,
          last_message_at: createdAtNow,
          last_incoming_at: createdAtNow,
          preview: `Postback: ${payload}`,
        });
      }
    } catch (e) {
      console.error('[IG STORE][INCOMING_POSTBACK][ERROR]', e.message);
    }

    // (Opcional) auto-reply simple:
    try {
      const res = await ig.sendText(
        igsid,
        `Postback: ${payload}`,
        pageAccessToken
      );
      const outSave = await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        igsid,
        text: `Postback: ${payload}`,
        mid: res?.message_id || null,
        status: 'sent',
        meta: { response: res },
      });
      if (IO && savedIn?.conversation_id) {
        IO.to(roomConv(savedIn.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: savedIn.conversation_id,
          message: {
            id: safeMsgId(outSave?.message_id, res?.message_id),
            direction: 'out',
            mid: res?.message_id || null,
            text: `Postback: ${payload}`,
            status: 'sent',
            created_at: new Date().toISOString(),
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: savedIn.conversation_id,
          last_message_at: new Date().toISOString(),
          last_outgoing_at: new Date().toISOString(),
          preview: `Postback: ${payload}`,
          unread_count: 0,
        });
      }
    } catch (e) {
      console.error(
        '[IG SEND/STORE][OUTGOING_POSTBACK][ERROR]',
        e.response?.data || e.message
      );
      try {
        await Store.saveOutgoingMessage({
          id_configuracion,
          page_id: pageId,
          igsid,
          text: `Postback: ${payload}`,
          status: 'failed',
          meta: { error: e.response?.data || e.message },
        });
      } catch (_) {}
    }
  }
}

module.exports = InstagramService;
module.exports.getPageTokenByPageId = getPageTokenByPageId;
module.exports.getConfigIdByPageId = getConfigIdByPageId;
