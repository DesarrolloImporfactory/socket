const ig = require('../utils/instagramGraph');
const { db } = require('../database/config');
const Store = require('./messenger_store.service');

let IO = null;

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

function emitUpdateChatIG({
  id_configuracion,
  chatId,
  pageId,
  external_id,
  uni,
  saved,
  rawMessage,
  kind, // 'in' | 'postback' | 'out-echo'
}) {
  if (!IO) return;

  const isIncoming = kind === 'in' || kind === 'postback';

  const tipo_mensaje =
    kind === 'postback'
      ? 'postback'
      : rawMessage?.attachments?.length
        ? 'attachment'
        : rawMessage?.text
          ? 'text'
          : 'text';

  const texto =
    kind === 'postback'
      ? `Postback: ${rawMessage?.payload || ''}`
      : rawMessage?.text || null;

  const messageForFront = {
    id: saved?.message_id || null,
    created_at: saved?.created_at || new Date().toISOString(),

    texto_mensaje: texto,
    text: texto,

    tipo_mensaje,
    rol_mensaje: isIncoming ? 0 : 1,
    direction: isIncoming ? 'in' : 'out',

    source: 'ig',
    page_id: String(pageId),
    uid_whatsapp: String(external_id || ''), // en su tabla se usa uid_whatsapp como external_id

    mid_mensaje: rawMessage?.mid || null,
    external_mid: rawMessage?.mid || null,

    attachments_unificado: rawMessage?.attachments || null,
    status_unificado: isIncoming ? 'received' : 'sent',
  };

  const chatForFront = {
    id: chatId,
    id_configuracion,
    source: 'ig',
    page_id: String(pageId),
    external_id: String(external_id || ''),
    id_encargado: uni?.id_encargado ?? null,
    id_departamento: uni?.id_departamento ?? null,
  };

  IO.emit('UPDATE_CHAT', {
    id_configuracion,
    chatId: String(chatId),
    source: 'ig',
    message: messageForFront,
    chat: chatForFront,
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
        } catch (e) {
          console.warn('[IG_MARK_SEEN][WARN]', e.response?.data || e.message);
        }
      });
    });
  }

  /**
   * Router de eventos Instagram
   * Heurística:
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
  }

  static async handleMessage(userIgsid, message, pageId, id_configuracion) {
    const normalizedAttachments = normalizeAttachments(message);

    // ✅ Asegura conversación unificada: devuelve dueño + contacto
    const uni = await Store.ensureUnifiedConversation({
      id_configuracion,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,
      customer_name: '',
    });

    const idClienteDueno = uni?.id_cliente ?? uni?.id_cliente_dueno ?? null;
    const idClienteContacto = uni?.id_cliente_contacto ?? null;

    if (!idClienteDueno || !idClienteContacto) {
      console.warn('[IG][ENSURE_UNI][NO_IDS]', {
        uni,
        idClienteDueno,
        idClienteContacto,
      });
      return;
    }

    // ✅ Guardar mensaje entrante:
    // id_cliente = dueño
    // celular_recibe = contacto
    const saved = await Store.saveIncomingMessageUnified({
      id_configuracion,
      id_plataforma: null,
      id_cliente: idClienteDueno,
      celular_recibe: idClienteContacto,

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

    // ✅ UPDATE_CHAT (IG IN)
    emitUpdateChatIG({
      id_configuracion,
      chatId: idClienteContacto, // ✅ contacto
      pageId,
      external_id: userIgsid,
      uni,
      saved,
      rawMessage: {
        mid: message.mid || null,
        text: message.text || null,
        attachments: normalizedAttachments || null,
      },
      kind: 'in',
    });
  }

  static async handleEchoAsOutgoing({
    id_configuracion,
    pageId,
    userIgsid,
    message,
  }) {
    const normalizedAttachments = normalizeAttachments(message);

    const uni = await Store.ensureUnifiedConversation({
      id_configuracion,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,
      customer_name: '',
    });

    const idClienteDueno = uni?.id_cliente ?? uni?.id_cliente_dueno ?? null;
    const idClienteContacto = uni?.id_cliente_contacto ?? null;

    if (!idClienteDueno || !idClienteContacto) {
      console.warn('[IG][ENSURE_UNI][NO_IDS]', {
        uni,
        idClienteDueno,
        idClienteContacto,
      });
      return;
    }

    const saved = await Store.saveOutgoingMessageUnified({
      id_configuracion,
      id_plataforma: null,
      id_cliente: idClienteDueno,
      celular_recibe: idClienteContacto,

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

    // ✅ UPDATE_CHAT (IG OUT echo)
    emitUpdateChatIG({
      id_configuracion,
      chatId: idClienteContacto,
      pageId,
      external_id: userIgsid,
      uni,
      saved,
      rawMessage: {
        mid: message.mid || null,
        text: message.text || null,
        attachments: normalizedAttachments || null,
      },
      kind: 'out-echo',
    });
  }

  static async handlePostback(userIgsid, postback, pageId, id_configuracion) {
    const payload = postback.payload || '';

    const uni = await Store.ensureUnifiedConversation({
      id_configuracion,
      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,
      customer_name: '',
    });

    const idClienteDueno = uni?.id_cliente ?? uni?.id_cliente_dueno ?? null;
    const idClienteContacto = uni?.id_cliente_contacto ?? null;

    if (!idClienteDueno || !idClienteContacto) {
      console.warn('[IG][ENSURE_UNI][NO_IDS]', {
        uni,
        idClienteDueno,
        idClienteContacto,
      });
      return;
    }

    const saved = await Store.saveIncomingMessageUnified({
      id_configuracion,
      id_plataforma: null,
      id_cliente: idClienteDueno,
      celular_recibe: idClienteContacto,

      source: 'ig',
      page_id: pageId,
      external_id: userIgsid,

      mid: postback.mid || null,
      text: null,
      attachments: null,
      postback_payload: payload,
      meta: { raw: postback },
    });

    // ✅ UPDATE_CHAT (IG POSTBACK IN)
    emitUpdateChatIG({
      id_configuracion,
      chatId: idClienteContacto,
      pageId,
      external_id: userIgsid,
      uni,
      saved,
      rawMessage: {
        mid: postback.mid || null,
        payload,
        text: null,
        attachments: null,
      },
      kind: 'postback',
    });
  }
}

module.exports = InstagramService;
module.exports.getPageRowByIgId = getPageRowByIgId;
