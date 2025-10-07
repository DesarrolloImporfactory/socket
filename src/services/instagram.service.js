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
  // FB/IG pueden mandar attachments con structure distinta; guarda tipos y payload
  // Devuelve null si no hay
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
   * Router de eventos Instagram (desde webhook Page, con messaging_product='instagram')
   * Filtra y enruta a handlers específicos.
   */
  static async routeEvent(event) {
    const mp = event.messaging_product; // 'instagram'
    if (mp !== 'instagram') {
      console.warn('[IG ROUTE_EVENT] messaging_product distinto/ausente:', mp);
      // puedes retornar si quieres ser estricto:
      // return;
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

    // Mensajes entrantes
    if (event.message) {
      // Gate de seguridad adicional (el gate de rutas ya filtró echo/edits)
      if (event.message.is_echo) return;

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

    // Postbacks (si decides usarlos desde IG)
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

    // Lecturas (opcional)
    if (event.read) {
      try {
        await Store.markRead({ id_configuracion, page_id: pageId, igsid });
        if (IO)
          IO.to(roomCfg(id_configuracion)).emit('IG_READ', {
            page_id: pageId,
            igsid,
          });
      } catch (e) {
        console.warn('[IG READ][WARN]', e.message);
      }
      return;
    }

    // Delivery (si IG lo enviara para tu app; placeholder)
    if (event.delivery) {
      // Puedes implementar Store.markDelivered si más adelante lo necesitas
      // await Store.markDelivered(...);
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
        // Emitir el mensaje entrante a la sala de la conversación
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

        // Upsert para lista de conversaciones (sidebar, etc.)
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

    // Opcional: feedback UX (siempre silencioso)
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
      } catch (_) {
        /* noop */
      }
    }
  }
}

module.exports = InstagramService;
module.exports.getPageTokenByPageId = getPageTokenByPageId;
module.exports.getConfigIdByPageId = getConfigIdByPageId;
module.exports.getPageRowByIgId = getPageRowByIgId;
