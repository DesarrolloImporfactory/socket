const ig = require('../utils/instagramGraph');
const { db } = require('../database/config');
const Store = require('./instagram_store.service');

let IO = null;
const roomConv = (conversation_id) => `ig:conv:${conversation_id}`;
const roomCfg = (id_configuracion) => `ig:cfg:${id_configuracion}`;

/* =============================
   Helpers de acceso a página
============================= */
async function getPageTokenByPageId(page_id) {
  const [row] = await db.query(
    `SELECT page_access_token
       FROM instagram_pages
      WHERE page_id=? AND status='active'
      LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.page_access_token || null;
}

async function getConfigIdByPageId(page_id) {
  const [row] = await db.query(
    `SELECT id_configuracion
       FROM instagram_pages
      WHERE page_id=? AND status='active'
      LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.id_configuracion || null;
}

/** Resuelve por IG Business ID (lo que llega como sender/recipient en IG) */
async function getPageRowByIgId(ig_id) {
  const [row] = await db.query(
    `SELECT id_configuracion, page_id, page_access_token
       FROM instagram_pages
      WHERE ig_id = ?
        AND status = 'active'
      LIMIT 1`,
    { replacements: [ig_id], type: db.QueryTypes.SELECT }
  );
  return row || null;
}

/* =============================
   Normalizadores / utilidades
============================= */
const safeMsgId = (dbId, mid) =>
  dbId || mid || `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function normalizeAttachments(msg) {
  const atts = msg?.attachments;
  if (!Array.isArray(atts) || !atts.length) return null;
  return atts.map((a) => ({
    type: a.type || null,
    payload: a.payload
      ? {
          url: a.payload.url || null,
          sticker_id: a.payload.sticker_id || null,
          title: a.payload.title || null,
        }
      : null,
  }));
}

/* =============================
   Servicio principal
============================= */
class InstagramService {
  static setIO(io) {
    IO = io;
  }

  /**
   * Router de eventos Instagram (webhook object='instagram' via Page)
   * - Resuelve contexto por IG Business ID (no por page_id del evento)
   * - Persiste entrantes (in) y ecos como salientes (out)
   */
  static async routeEvent(event) {
    const mp = event.messaging_product; // 'instagram'
    if (mp !== 'instagram') {
      console.warn('[IG ROUTE_EVENT] messaging_product distinto/ausente:', mp);
      // return; // si quieres ser estricto
    }

    // Heurística correcta de IDs en IG:
    // - Entrante (usuario -> negocio): sender.id = IGSID usuario | recipient.id = IG Business ID (negocio)
    // - Eco (negocio -> usuario):      sender.id = IG Business ID (negocio) | recipient.id = IGSID usuario
    const isEcho = event.message?.is_echo === true;
    const businessId = isEcho ? event.sender?.id : event.recipient?.id; // IG Business ID de tu cuenta
    const userIgsid = isEcho ? event.recipient?.id : event.sender?.id; // IGSID del usuario (cliente)

    if (!businessId) {
      console.warn(
        '[IG ROUTE_EVENT] IG Business ID ausente (sender/recipient)'
      );
      return;
    }

    // Resuelve contexto por IG Business ID
    const pageRow = await getPageRowByIgId(businessId);
    if (!pageRow) {
      console.warn(
        '[IG ROUTE_EVENT] IG Business no registrado en BD:',
        businessId
      );
      return;
    }
    const {
      id_configuracion,
      page_id: pageId,
      page_access_token: pageAccessToken,
    } = pageRow;

    const mid = event.message?.mid || event.postback?.mid || null;
    const text = event.message?.text || null;

    console.log('[IG ROUTE_EVENT][IN]', {
      businessId,
      pageId,
      igsid: userIgsid,
      mid,
      text: text || '(no-text)',
      hasDelivery: !!event.delivery,
      hasRead: !!event.read,
      hasPostback: !!event.postback,
      isEcho,
    });

    // 1) ECO → guardar como MENSAJE SALIENTE (out)
    if (isEcho && event.message) {
      await this.handleEchoAsOutgoing({
        id_configuracion,
        pageId,
        userIgsid,
        message: event.message,
      });
      return;
    }

    // 2) Mensaje entrante (usuario -> negocio)
    if (event.message) {
      if (!userIgsid) {
        console.warn(
          '[IG ROUTE_EVENT] message sin igsid de usuario; se ignora'
        );
        return;
      }
      if (!pageAccessToken) {
        console.warn('[IG] No page_access_token para pageId', pageId);
        return;
      }

      await this.handleMessage(
        userIgsid,
        event.message,
        pageAccessToken,
        pageId,
        id_configuracion
      );
      return;
    }

    // 3) Postbacks (si decides usarlos desde IG)
    if (event.postback) {
      if (!pageAccessToken) return;
      await this.handlePostback(
        userIgsid,
        event.postback,
        pageAccessToken,
        pageId,
        id_configuracion
      );
      return;
    }

    // 4) Lecturas
    if (event.read) {
      try {
        await Store.markRead({
          id_configuracion,
          page_id: pageId,
          igsid: userIgsid,
        });
        if (IO)
          IO.to(roomCfg(id_configuracion)).emit('IG_READ', {
            page_id: pageId,
            igsid: userIgsid,
          });
      } catch (e) {
        console.warn('[IG READ][WARN]', e.message);
      }
      return;
    }

    // 5) Delivery (placeholder)
    if (event.delivery) {
      // Implementa markDelivered si lo necesitas
      return;
    }
  }

  /** Guarda mensaje ENTRANTE (usuario -> negocio) como direction='in' */
  static async handleMessage(
    igsid,
    message,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    const createdAtNow = new Date().toISOString();
    const normalizedAttachments = normalizeAttachments(message);
    const text = message.text || null;
    const mid = message.mid || null;

    let savedIn = null;
    try {
      savedIn = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        igsid,
        text,
        attachments: normalizedAttachments,
        mid,
        meta: { raw: message },
      });

      if (IO && savedIn?.conversation_id) {
        IO.to(roomConv(savedIn.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: savedIn.conversation_id,
          message: {
            id: safeMsgId(savedIn.message_id, mid),
            direction: 'in',
            mid,
            text,
            attachments: normalizedAttachments,
            status: 'received',
            created_at: createdAtNow,
          },
        });

        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: savedIn.conversation_id,
          last_message_at: createdAtNow,
          last_incoming_at: createdAtNow,
          preview: text || '(adjunto)',
        });
      }
    } catch (e) {
      console.error('[IG STORE][INCOMING][ERROR]', e.message);
    }

    // Feedback UX (silencioso)
    try {
      await ig.sendSenderAction(igsid, 'mark_seen', pageAccessToken);
      await ig.sendSenderAction(igsid, 'typing_off', pageAccessToken);
    } catch (e) {
      console.warn('[IG SENDER_ACTION][WARN]', e.response?.data || e.message);
    }
  }

  /** Guarda ECO (negocio -> usuario) como direction='out' */
  static async handleEchoAsOutgoing({
    id_configuracion,
    pageId,
    userIgsid,
    message,
  }) {
    const createdAtNow = new Date().toISOString();
    const normalizedAttachments = normalizeAttachments(message);
    const text = message.text || null;
    const mid = message.mid || null;

    try {
      const outSave = await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        igsid: userIgsid, // IGSID del cliente
        text,
        attachments: normalizedAttachments,
        mid,
        status: 'sent',
        meta: { raw: message, via: 'echo' },
      });

      if (IO && outSave?.conversation_id) {
        IO.to(roomConv(outSave.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: outSave.conversation_id,
          message: {
            id: safeMsgId(outSave?.message_id, mid),
            direction: 'out',
            mid,
            text,
            attachments: normalizedAttachments,
            status: 'sent',
            created_at: createdAtNow,
          },
        });

        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: outSave.conversation_id,
          last_message_at: createdAtNow,
          last_outgoing_at: createdAtNow,
          preview: text || '(adjunto)',
          unread_count: 0,
        });
      }
    } catch (e) {
      console.error('[IG STORE][OUTGOING_ECHO][ERROR]', e.message);
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

    // (Opcional) auto-responder al postback
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
module.exports.getPageRowByIgId = getPageRowByIgId;
