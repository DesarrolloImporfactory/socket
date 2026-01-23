const fb = require('../utils/facebookGraph');
const { db } = require('../database/config');
const Store = require('./messenger_store.service');

const FB_APP_ID = process.env.FB_APP_ID;

// Socket.IO (inyectado desde server.js)
let IO = null;

// helpers de rooms
const roomConv = (id_cliente) => `ms:conv:${id_cliente}`;
const roomCfg = (id_configuracion) => `ms:cfg:${id_configuracion}`;

// id “seguro” para no romper el front si insertId viene undefined
const safeMsgId = (dbId, mid) =>
  dbId || mid || `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// helpers que también exportamos para usarlos en otros módulos (gateway, etc.)
async function getPageTokenByPageId(page_id) {
  const [row] = await db.query(
    `SELECT page_access_token FROM messenger_pages WHERE page_id = ? AND status='active' LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT },
  );
  return row?.page_access_token || null;
}

function emitUpdateChatMS({
  id_configuracion,
  chatId,
  pageId,
  external_id,
  uni,
  saved,
  rawMessage,
  kind,
}) {
  if (!IO) return;

  // kind: 'in' | 'postback' | 'out-echo'
  const isIncoming = kind === 'in' || kind === 'postback';
  const tipo_mensaje =
    kind === 'postback'
      ? 'postback'
      : rawMessage?.attachments?.length
        ? 'attachment'
        : 'text';

  const texto =
    kind === 'postback'
      ? `Postback: ${rawMessage?.payload || ''}`
      : rawMessage?.text || null;

  const messageForFront = {
    // ✅ si ya guardó en DB, este id es el real
    id: saved?.message_id || null,

    created_at: saved?.created_at || new Date().toISOString(),

    // ✅ compat front
    texto_mensaje: texto,
    text: texto,

    tipo_mensaje,
    rol_mensaje: isIncoming ? 0 : 1,
    direction: isIncoming ? 'in' : 'out',

    source: 'ms',
    page_id: String(pageId),
    uid_whatsapp: String(external_id || ''),

    mid_mensaje: rawMessage?.mid || null,
    external_mid: rawMessage?.mid || null,

    attachments_unificado: rawMessage?.attachments || null,
    status_unificado: isIncoming ? 'received' : 'sent',
  };

  // ✅ chat mínimo pero útil para permisos y render
  const chatForFront = {
    id: chatId,
    id_configuracion,
    source: 'ms',
    page_id: String(pageId),
    external_id: String(external_id || ''),
    id_encargado: uni?.id_encargado ?? null,
    id_departamento: uni?.id_departamento ?? null,
  };

  IO.emit('UPDATE_CHAT', {
    id_configuracion,
    chatId: String(chatId),
    source: 'ms',
    message: messageForFront,
    chat: chatForFront,
  });
}

async function getConfigIdByPageId(page_id) {
  const [row] = await db.query(
    `SELECT id_configuracion FROM messenger_pages WHERE page_id = ? AND status='active' LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT },
  );
  return row?.id_configuracion || null;
}

class MessengerService {
  static setIO(io) {
    IO = io;
  }

  /**
   * Router de eventos del webhook de Messenger
   */
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
      isEcho: !!event.message?.is_echo,
    });

    if (!pageId) return;

    // --- 1) ECHOS ---
    if (event.message?.is_echo) {
      const appId = event.message?.app_id || null;
      const pageIdEcho = event.sender?.id; // en echos: sender.id = PAGE
      const psidEcho = event.recipient?.id; // recipient.id = USER

      // Si el echo es de nuestra propia app, ignoramos
      if (String(appId || '') === String(FB_APP_ID)) {
        console.log('[SKIP][ECHO][OWN]', { mid: event.message?.mid, appId });
        return;
      }

      const id_cfg_echo = await getConfigIdByPageId(pageIdEcho);
      if (!id_cfg_echo) {
        console.warn(
          '[ECHO][WARN] No id_configuracion para pageId',
          pageIdEcho,
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
    // (delivery/read se manejan al final y NO requieren cortar si no hay senderPsid)
    const id_configuracion = await getConfigIdByPageId(pageId);

    // Mensaje normal
    if (event.message) {
      if (!senderPsid) {
        console.warn('[ROUTE_EVENT] message sin senderPsid; se ignora');
        return;
      }
      if (!id_configuracion) {
        console.warn('[STORE][WARN] No id_configuracion para pageId', pageId);
        return; // 👈 evita inserts sin config
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
        id_configuracion,
      );
      return;
    }

    // Postback
    if (event.postback) {
      if (!senderPsid) {
        console.warn('[ROUTE_EVENT] postback sin senderPsid; se ignora');
        return;
      }
      if (!id_configuracion) {
        console.warn('[STORE][WARN] No id_configuracion para pageId', pageId);
        return; // 👈 evita inserts sin config
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
        id_configuracion,
      );
      return;
    }

    // READ
    if (event.read) {
      const watermark = event.read.watermark;

      const cfg = id_configuracion || (await getConfigIdByPageId(pageId));
      if (!cfg) return;

      // senderPsid aquí puede venir vacío en algunos reads.
      const psid = event.sender?.id || senderPsid || null;

      // si tenemos psid, podemos resolver id_cliente para marcar visto
      let id_cliente = null;
      if (psid) {
        const uni = await Store.ensureUnifiedConversation({
          id_configuracion: cfg,
          source: 'ms',
          page_id: pageId,
          external_id: psid,
          customer_name: '',
        });
        id_cliente = uni?.id_cliente || null;
      }

      await Store.markReadUnified({
        id_configuracion: cfg,
        source: 'ms',
        page_id: pageId,
        external_id: psid || '',
        watermark,
        id_cliente,
      });

      if (IO) {
        IO.to(roomCfg(cfg)).emit('MS_READ', { page_id: pageId, watermark });
      }
      return;
    }
  }

  /**
   * Mensaje entrante (user -> page) — sin auto-reply
   */
  static async handleMessage(
    senderPsid,
    message,
    pageAccessToken,
    pageId,
    id_configuracion,
  ) {
    const createdAtNow = new Date().toISOString();

    console.log('[MS][HANDLE_MESSAGE][PAYLOAD]', {
      id_configuracion,
      pageId,
      senderPsid,
      mid: message?.mid,
      text: message?.text,
      hasAttachments: !!message?.attachments?.length,
    });

    let uni = null;
    try {
      uni = await Store.ensureUnifiedConversation({
        id_configuracion,
        source: 'ms',
        page_id: pageId,
        external_id: senderPsid,
        customer_name: '',
      });

      console.log('[MS][ENSURE_UNI][OK]', uni);
    } catch (err) {
      console.error('[MS][ENSURE_UNI][ERROR]', {
        name: err?.name,
        message: err?.message,
        errors: err?.errors?.map((e) => ({
          path: e.path,
          message: e.message,
          value: e.value,
          validatorKey: e.validatorKey,
        })),
        parent: err?.parent?.message,
        sql: err?.sql,
      });
      return;
    }

    // ✅ id_cliente = dueño
    const idClienteDueno = uni?.id_cliente ?? uni?.id_cliente_dueno ?? null;
    const idClienteContacto = uni?.id_cliente_contacto ?? null;

    if (!idClienteDueno || !idClienteContacto) {
      console.warn('[MS][ENSURE_UNI][NO_IDS]', {
        uni,
        idClienteDueno,
        idClienteContacto,
      });
      return;
    }

    let saved = null;
    try {
      saved = await Store.saveIncomingMessageUnified({
        id_configuracion,
        id_plataforma: null,

        id_cliente: idClienteDueno, // ✅ dueño
        celular_recibe: idClienteContacto, // ✅ contacto

        source: 'ms',
        page_id: pageId,
        external_id: senderPsid,

        mid: message.mid || null,
        text: message.text || null,
        attachments: message.attachments || null,
        quick_reply_payload: message.quick_reply?.payload || null,
        sticker_id: message.sticker_id || null,
        meta: { raw: message },
      });

      console.log('[MS][SAVE_INCOMING][OK]', saved);

      // ✅ emitir UPDATE_CHAT para ver en tiempo real (MS IN)
      emitUpdateChatMS({
        id_configuracion,
        chatId: idClienteContacto,
        pageId,
        external_id: senderPsid,
        uni,
        saved,
        rawMessage: message,
        kind: 'in',
      });
    } catch (err) {
      console.error('[MS][SAVE_INCOMING][ERROR]', {
        name: err?.name,
        message: err?.message,
        errors: err?.errors?.map((e) => ({
          path: e.path,
          message: e.message,
          value: e.value,
          validatorKey: e.validatorKey,
        })),
        parent: err?.parent?.message,
        sql: err?.sql,
      });
      return;
    }
  }

  static async handlePostback(
    senderPsid,
    postback,
    pageAccessToken,
    pageId,
    id_configuracion,
  ) {
    const payload = postback.payload || '';
    const createdAtNow = new Date().toISOString();

    console.log('[MS][HANDLE_POSTBACK][PAYLOAD]', {
      id_configuracion,
      pageId,
      senderPsid,
      payload,
      mid: postback?.mid,
    });

    let uni = null;
    try {
      uni = await Store.ensureUnifiedConversation({
        id_configuracion,
        source: 'ms',
        page_id: pageId,
        external_id: senderPsid,
        customer_name: '',
      });
      console.log('[MS][ENSURE_UNI][OK]', uni);
    } catch (err) {
      console.error('[MS][ENSURE_UNI][ERROR]', {
        name: err?.name,
        message: err?.message,
        errors: err?.errors?.map((e) => ({
          path: e.path,
          message: e.message,
          value: e.value,
          validatorKey: e.validatorKey,
        })),
        parent: err?.parent?.message,
        sql: err?.sql,
      });
      return;
    }

    const idClienteDueno = uni?.id_cliente ?? uni?.id_cliente_dueno ?? null;
    const idClienteContacto = uni?.id_cliente_contacto ?? null;

    if (!idClienteDueno || !idClienteContacto) {
      console.warn('[MS][ENSURE_UNI][NO_IDS]', {
        uni,
        idClienteDueno,
        idClienteContacto,
      });
      return;
    }

    let inSaved = null;
    try {
      inSaved = await Store.saveIncomingMessageUnified({
        id_configuracion,
        id_plataforma: null,

        id_cliente: idClienteDueno, // ✅ dueño
        celular_recibe: idClienteContacto, // ✅ contacto

        source: 'ms',
        page_id: pageId,
        external_id: senderPsid,

        mid: postback.mid || null,
        text: null,
        attachments: null,
        postback_payload: payload,
        meta: { raw: postback },
      });

      console.log('[MS][SAVE_POSTBACK_IN][OK]', inSaved);
      // ✅ emitir UPDATE_CHAT para ver en tiempo real (MS POSTBACK IN)
      emitUpdateChatMS({
        id_configuracion,
        chatId: idClienteContacto,
        pageId,
        external_id: senderPsid,
        uni,
        saved: inSaved,
        rawMessage: {
          payload,
          mid: postback?.mid || null,
          text: null,
          attachments: null,
        },
        kind: 'postback',
      });
    } catch (err) {
      console.error('[MS][SAVE_POSTBACK_IN][ERROR]', {
        name: err?.name,
        message: err?.message,
        errors: err?.errors?.map((e) => ({
          path: e.path,
          message: e.message,
          value: e.value,
          validatorKey: e.validatorKey,
        })),
        parent: err?.parent?.message,
        sql: err?.sql,
      });
      return;
    }
  }

  static async handleEcho({ pageId, psid, message, id_configuracion }) {
    const createdAtNow = new Date().toISOString();

    console.log('[MS][HANDLE_ECHO][PAYLOAD]', {
      id_configuracion,
      pageId,
      psid,
      mid: message?.mid,
      text: message?.text,
      app_id: message?.app_id,
    });

    let uni = null;
    try {
      uni = await Store.ensureUnifiedConversation({
        id_configuracion,
        source: 'ms',
        page_id: pageId,
        external_id: psid,
        customer_name: '',
      });
      console.log('[MS][ENSURE_UNI][OK]', uni);
    } catch (err) {
      console.error('[MS][ENSURE_UNI][ERROR]', {
        name: err?.name,
        message: err?.message,
        errors: err?.errors?.map((e) => ({
          path: e.path,
          message: e.message,
          value: e.value,
          validatorKey: e.validatorKey,
        })),
        parent: err?.parent?.message,
        sql: err?.sql,
      });
      return;
    }

    const idClienteDueno = uni?.id_cliente ?? uni?.id_cliente_dueno ?? null;
    const idClienteContacto = uni?.id_cliente_contacto ?? null;

    if (!idClienteDueno || !idClienteContacto) {
      console.warn('[MS][ENSURE_UNI][NO_IDS]', {
        uni,
        idClienteDueno,
        idClienteContacto,
      });
      return;
    }

    try {
      const saved = await Store.saveOutgoingMessageUnified({
        id_configuracion,
        id_plataforma: null,

        id_cliente: idClienteDueno, // ✅ dueño
        celular_recibe: idClienteContacto, // ✅ contacto

        source: 'ms',
        page_id: pageId,
        external_id: psid,

        mid: message.mid || null,
        text: message.text || null,
        attachments: message.attachments || null,
        status_unificado: 'sent',
        meta: { echo: true, app_id: message.app_id || null, raw: message },
        responsable: 'Messenger Inbox',
        id_encargado: uni.id_encargado,
      });

      console.log('[MS][SAVE_ECHO_OUT][OK]', saved);

      // ✅ emitir UPDATE_CHAT para ver en tiempo real (MS OUT echo)
      emitUpdateChatMS({
        id_configuracion,
        chatId: idClienteContacto,
        pageId,
        external_id: psid,
        uni,
        saved,
        rawMessage: message,
        kind: 'out-echo',
      });
    } catch (err) {
      console.error('[MS][SAVE_ECHO_OUT][ERROR]', {
        name: err?.name,
        message: err?.message,
        errors: err?.errors?.map((e) => ({
          path: e.path,
          message: e.message,
          value: e.value,
          validatorKey: e.validatorKey,
        })),
        parent: err?.parent?.message,
        sql: err?.sql,
      });
      return;
    }
  }
}

module.exports = MessengerService;
module.exports.getPageTokenByPageId = getPageTokenByPageId;
module.exports.getConfigIdByPageId = getConfigIdByPageId;
