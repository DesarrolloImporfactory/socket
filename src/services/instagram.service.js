/**
 * Instagram Service (UNIFICADO)
 * ----------------------------
 * Guarda TODO en:
 *  - clientes_chat_center  (source='ig', page_id, external_id)
 *  - mensajes_clientes     (source='ig')
 * Usa Round Robin PRINCIPAL (crearClienteConRoundRobinUnDepto) via ensureUnifiedConversation.
 */

const ig = require('../utils/instagramGraph');
const { db } = require('../database/config');
const Store = require('./messenger_store.service'); // ✅ STORE UNIFICADO

let IO = null;

const roomConv = (id_cliente) => `ig:conv:${id_cliente}`;
const roomCfg = (id_configuracion) => `ig:cfg:${id_configuracion}`;

/** Busca conexión IG activa por IG Business ID */
async function getPageRowByIgId(ig_id) {
  const [row] = await db.query(
    `SELECT id_configuracion, page_id, page_access_token
       FROM instagram_pages
      WHERE ig_id = ?
        AND status = 'active'
      LIMIT 1`,
    { replacements: [ig_id], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/** Para sockets (mark seen/typing) necesitamos datos de la conversación unificada */
async function getUnifiedConversationById(id_cliente) {
  const [row] = await db.query(
    `SELECT id AS id_cliente, id_configuracion, page_id, external_id, source
       FROM clientes_chat_center
      WHERE id = ?
      LIMIT 1`,
    { replacements: [id_cliente], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

const safeMsgId = (dbId, mid) =>
  dbId || mid || `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function normalizeAttachments(msg) {
  const atts = msg?.attachments;
  if (!Array.isArray(atts) || !atts.length) return null;

  return atts.map((a) => {
    const p = a?.payload || {};
    return {
      type: a?.type || null,
      name: a?.name || p?.file_name || p?.title || null,
      size: a?.size || p?.size || null,
      mimeType: a?.mimeType || p?.mime_type || null,
      payload: {
        url: p?.url || null,
        preview_url: p?.preview_url || null,
        sticker_id: p?.sticker_id || null,
        title: p?.title || null,
        latitude: p?.latitude || p?.lat || null,
        longitude: p?.longitude || p?.lng || null,
        file_name: p?.file_name || null,
        size: p?.size || null,
        mime_type: p?.mime_type || null,
      },
    };
  });
}

class InstagramService {
  static setIO(io) {
    IO = io;

    io.on('connection', (socket) => {
      // ✅ Escribiendo...
      socket.on('IG_TYPING', async ({ id_cliente, on }) => {
        try {
          const conv = await getUnifiedConversationById(id_cliente);
          if (!conv || conv.source !== 'ig') return;

          const [pageRow] = await db.query(
            `SELECT page_access_token
               FROM instagram_pages
              WHERE page_id=? AND status='active'
              LIMIT 1`,
            { replacements: [conv.page_id], type: db.QueryTypes.SELECT },
          );
          const pat = pageRow?.page_access_token;
          if (!pat) return;

          // external_id = IGSID del cliente
          await ig.sendSenderAction(
            conv.external_id,
            on ? 'typing_on' : 'typing_off',
            pat,
          );
        } catch (e) {
          console.warn('[IG_TYPING][WARN]', e.response?.data || e.message);
        }
      });

      // ✅ Marcar visto SOLO cuando el asesor abre el chat
      socket.on('IG_MARK_SEEN', async ({ id_cliente }) => {
        try {
          const conv = await getUnifiedConversationById(id_cliente);
          if (!conv || conv.source !== 'ig') return;

          const [pageRow] = await db.query(
            `SELECT page_access_token
               FROM instagram_pages
              WHERE page_id=? AND status='active'
              LIMIT 1`,
            { replacements: [conv.page_id], type: db.QueryTypes.SELECT },
          );
          const pat = pageRow?.page_access_token;
          if (!pat) return;

          await ig.sendSenderAction(conv.external_id, 'mark_seen', pat);

          // ✅ marcar IN como visto en mensajes_clientes (unificado)
          await Store.markReadUnified({
            id_configuracion: conv.id_configuracion,
            source: 'ig',
            page_id: conv.page_id,
            external_id: conv.external_id,
            watermark: Date.now(),
            id_cliente: conv.id_cliente,
          });

          IO.to(roomCfg(conv.id_configuracion)).emit('IG_READ', {
            page_id: conv.page_id,
            external_id: conv.external_id,
            id_cliente: conv.id_cliente,
          });
        } catch (e) {
          console.warn('[IG_MARK_SEEN][WARN]', e.response?.data || e.message);
        }
      });
    });
  }

  /**
   * Router de eventos Instagram (webhook object='instagram' via Page)
   * Heurística IG:
   *  - Entrante: sender.id = IGSID usuario | recipient.id = IG Business ID
   *  - Echo:     sender.id = IG Business ID | recipient.id = IGSID usuario
   */
  static async routeEvent(event) {
    const isEcho = event.message?.is_echo === true;

    const businessId = isEcho ? event.sender?.id : event.recipient?.id; // IG Business ID
    const userIgsid = isEcho ? event.recipient?.id : event.sender?.id; // IGSID cliente

    if (!businessId) {
      console.warn('[IG] businessId ausente');
      return;
    }

    const pageRow = await getPageRowByIgId(businessId);
    if (!pageRow) {
      console.warn('[IG] IG Business no registrado en BD:', businessId);
      return;
    }

    const {
      id_configuracion,
      page_id: pageId,
      page_access_token: pageAccessToken,
    } = pageRow;

    const mid = event.message?.mid || event.postback?.mid || null;
    const text = event.message?.text || null;

    console.log('[IG][ROUTE_EVENT]', {
      businessId,
      pageId,
      userIgsid,
      mid,
      text: text || '(no-text)',
      isEcho,
      hasMessage: !!event.message,
      hasPostback: !!event.postback,
    });

    // 1) ECO (saliente)
    if (isEcho && event.message) {
      await this.handleEchoAsOutgoing({
        id_configuracion,
        pageId,
        userIgsid,
        message: event.message,
      });
      return;
    }

    // 2) ENTRANTE
    if (event.message) {
      if (!userIgsid) return;
      if (!pageAccessToken) {
        console.warn('[IG] No page_access_token para pageId', pageId);
        return;
      }

      await this.handleMessage(
        userIgsid,
        event.message,
        pageId,
        id_configuracion,
      );
      return;
    }

    // 3) Postbacks (si aplica)
    if (event.postback) {
      await this.handlePostback(
        userIgsid,
        event.postback,
        pageId,
        id_configuracion,
      );
      return;
    }

    // (read/delivery: en IG suelen ser inconsistentes; si luego los quiere, los conectamos a markDeliveredUnified/markReadUnified)
  }

  static async handleMessage(userIgsid, message, pageId, id_configuracion) {
    const createdAtNow = new Date().toISOString();
    const normalizedAttachments = normalizeAttachments(message);

    // ✅ 1) asegurar conversación UNIFICADA (clientes_chat_center) + RR principal
    const uni = await Store.ensureUnifiedConversation({
      id_configuracion,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,
      customer_name: '',
    });

    if (!uni?.id_cliente) return;

    // ✅ 2) guardar mensaje entrante en mensajes_clientes (unificado)
    const saved = await Store.saveIncomingMessageUnified({
      id_configuracion,
      id_plataforma: null,
      id_cliente: uni.id_cliente,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,

      mid: message.mid || null,
      text: message.text || null,
      attachments: normalizedAttachments || null,
      quick_reply_payload: message.quick_reply?.payload || null,
      sticker_id: message.sticker_id || null,
      meta: { raw: message },
    });

    // ✅ 3) emitir a sockets
    if (IO) {
      IO.to(roomConv(uni.id_cliente)).emit('IG_MESSAGE', {
        id_cliente: uni.id_cliente,
        message: {
          id: safeMsgId(saved?.message_id, message.mid),
          direction: 'in',
          mid: message.mid || null,
          text: message.text || null,
          attachments: normalizedAttachments || null,
          status: 'received',
          created_at: createdAtNow,
        },
      });

      IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
        id: uni.id_cliente,
        last_message_at: createdAtNow,
        last_incoming_at: createdAtNow,
        preview: message.text || '(adjunto)',
      });
    }

    // ✅ NO hacemos mark_seen aquí (como usted ya lo tiene: lo hace el asesor cuando abre el chat)
  }

  static async handleEchoAsOutgoing({
    id_configuracion,
    pageId,
    userIgsid,
    message,
  }) {
    const createdAtNow = new Date().toISOString();
    const normalizedAttachments = normalizeAttachments(message);

    const uni = await Store.ensureUnifiedConversation({
      id_configuracion,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,
      customer_name: '',
    });

    if (!uni?.id_cliente) return;

    const saved = await Store.saveOutgoingMessageUnified({
      id_configuracion,
      id_plataforma: null,
      id_cliente: uni.id_cliente,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,

      mid: message.mid || null,
      text: message.text || null,
      attachments: normalizedAttachments || null,

      status_unificado: 'sent',
      meta: { echo: true, raw: message },
      responsable: 'Instagram Inbox',
      id_encargado: uni.id_encargado,
    });

    if (IO) {
      IO.to(roomConv(uni.id_cliente)).emit('IG_MESSAGE', {
        id_cliente: uni.id_cliente,
        message: {
          id: safeMsgId(saved?.message_id, message.mid),
          direction: 'out',
          mid: message.mid || null,
          text: message.text || null,
          attachments: normalizedAttachments || null,
          status: 'sent',
          created_at: createdAtNow,
          echo: true,
        },
      });

      IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
        id: uni.id_cliente,
        last_message_at: createdAtNow,
        last_outgoing_at: createdAtNow,
        preview: message.text || '(adjunto)',
      });
    }
  }

  static async handlePostback(userIgsid, postback, pageId, id_configuracion) {
    const createdAtNow = new Date().toISOString();
    const payload = postback.payload || '';

    const uni = await Store.ensureUnifiedConversation({
      id_configuracion,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,
      customer_name: '',
    });
    if (!uni?.id_cliente) return;

    const saved = await Store.saveIncomingMessageUnified({
      id_configuracion,
      id_plataforma: null,
      id_cliente: uni.id_cliente,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,

      mid: postback.mid || null,
      text: null,
      attachments: null,
      postback_payload: payload,
      meta: { raw: postback },
    });

    if (IO) {
      IO.to(roomConv(uni.id_cliente)).emit('IG_MESSAGE', {
        id_cliente: uni.id_cliente,
        message: {
          id: safeMsgId(saved?.message_id, postback.mid),
          direction: 'in',
          mid: postback.mid || null,
          text: `Postback: ${payload}`,
          status: 'received',
          created_at: createdAtNow,
        },
      });
    }
  }
}

module.exports = InstagramService;
module.exports.getPageRowByIgId = getPageRowByIgId;
