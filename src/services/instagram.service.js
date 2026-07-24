const axios = require('axios');
const FormData = require('form-data');
const ig = require('../utils/instagramGraph');
const { db } = require('../database/config');
const Store = require('./messenger_store.service');
const dashboardEmitter = require('../controllers/dashboardEmitter');
const { rehostAttachments } = require('../utils/rehostMediaMeta');

let IO = null;

/**
 * Transcribe un audio de Instagram (URL pública del CDN de Meta) usando Whisper.
 * Equivalente a transcribirAudioConWhisperDesdeArchivo de WhatsApp, pero
 * descargando desde URL en vez de leer un archivo local.
 */
async function transcribirAudioIgUrl(url, apiKeyOpenAI) {
  try {
    const audioRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const form = new FormData();
    form.append('file', Buffer.from(audioRes.data), { filename: 'audio_ig.mp4' });
    form.append('model', 'gpt-4o-transcribe');
    form.append('language', 'es');
    form.append('response_format', 'json');
    form.append(
      'prompt',
      'Audio de Instagram en español. Conversación informal entre cliente y empresa.',
    );

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${apiKeyOpenAI}`,
          ...form.getHeaders(),
        },
      },
    );

    return response.data?.text || null;
  } catch (err) {
    console.error(
      '[IG][WHISPER][ERROR]',
      err.response?.data || err.message,
    );
    return null;
  }
}

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

/**
 * Corre la MISMA IA kanban de WhatsApp sobre un mensaje entrante de Instagram.
 * Reutiliza procesarMensajeKanban inyectándole un "canal" IG (envío por
 * ig.sendText/sendAttachment + persistencia unificada + emit socket).
 *
 * v1: solo texto y audios (transcritos). Sin remarketing (IG no tiene el
 * sistema de plantillas de WhatsApp).
 * Nunca lanza: cualquier error se loguea para no romper la recepción.
 */
async function runKanbanIaIG({
  id_configuracion,
  idClienteDueno,
  idClienteContacto,
  igsid,
  pageId,
  pageAccessToken,
  message,
  uni,
}) {
  try {
    if (!pageAccessToken) return;

    // 1) ¿La configuración es de tipo kanban? ¿Tiene API key de OpenAI?
    const [cfg] = await db.query(
      `SELECT tipo_configuracion, api_key_openai
         FROM configuraciones
        WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (!cfg || cfg.tipo_configuracion !== 'kanban') return;

    const api_key_openai = cfg.api_key_openai;
    if (!api_key_openai) return;

    // 2) Estado del contacto + gate del bot (igual que en WhatsApp)
    const [contacto] = await db.query(
      `SELECT bot_openia, estado_contacto
         FROM clientes_chat_center
        WHERE id = ? LIMIT 1`,
      { replacements: [idClienteContacto], type: db.QueryTypes.SELECT },
    );
    if (!contacto) return;
    if (Number(contacto.bot_openia) !== 1) return; // IA apagada para este chat
    const estado_contacto = contacto.estado_contacto || 'contacto_inicial';

    // 3) Construir el mensaje para la IA (texto o audio transcrito)
    let mensajeIA = (message.text || '').trim();
    if (!mensajeIA) {
      const audioUrl = (message.attachments || []).find(
        (a) => a?.type === 'audio' && a?.payload?.url,
      )?.payload?.url;

      if (audioUrl) {
        const transcrito = await transcribirAudioIgUrl(audioUrl, api_key_openai);
        if (transcrito) mensajeIA = transcrito.trim();
      }
    }
    if (!mensajeIA) return; // v1: solo texto/audio disparan la IA

    // 4) Adaptador de canal Instagram (envío + persistencia + socket)
    const persistirYEmitir = async ({ igRes, text, attachments, responsable }) => {
      const mid = igRes?.message_id || igRes?.messages?.[0]?.id || null;
      const saved = await Store.saveOutgoingMessageUnified({
        id_configuracion,
        id_plataforma: null,
        id_cliente: idClienteDueno,
        celular_recibe: idClienteContacto,
        source: 'ig',
        page_id: pageId,
        external_id: igsid,
        mid,
        text: text || null,
        attachments: attachments || null,
        status_unificado: 'sent',
        responsable,
        meta: { ia: true, response: igRes },
        id_encargado: uni?.id_encargado ?? null,
      });

      emitUpdateChatIG({
        id_configuracion,
        chatId: idClienteContacto,
        pageId,
        external_id: igsid,
        uni,
        saved,
        rawMessage: {
          mid,
          text: text || null,
          attachments: attachments || null,
        },
        kind: 'out-echo',
      });
    };

    const canal = {
      source: 'ig',
      enviarTexto: async ({ texto, responsable }) => {
        const igRes = await ig.sendText(igsid, texto, pageAccessToken);
        await persistirYEmitir({ igRes, text: texto, responsable });
      },
      enviarMedia: async ({ tipo, url, responsable }) => {
        const igType =
          tipo === 'video' ? 'video' : tipo === 'image' ? 'image' : 'file';
        const igRes = await ig.sendAttachment(
          igsid,
          { type: igType, url },
          pageAccessToken,
        );
        await persistirYEmitir({
          igRes,
          text: null,
          attachments: [{ type: igType, payload: { url } }],
          responsable,
        });
      },
    };

    const {
      procesarMensajeKanban,
      cancelarRemarketingKanban,
    } = require('./kanban_ia.service');
    const { programarRemarketingIG } = require('./remarketing_ig.service');

    // 1. Cliente respondió → cancelar remarketing pendiente SIEMPRE
    await cancelarRemarketingKanban(idClienteContacto, id_configuracion);

    // 2. Ejecutar el MISMO cerebro kanban de WhatsApp
    await procesarMensajeKanban({
      id_configuracion,
      id_cliente: idClienteContacto,
      telefono: '', // IG no tiene teléfono; Dropi por teléfono no aplica
      mensaje: mensajeIA,
      estado_contacto,
      api_key_openai,
      business_phone_id: null,
      accessToken: null,
      canal,
    });

    // 3. Re-leer estado (la IA pudo cambiarlo con un trigger cambiar_estado)
    const [clienteAct] = await db.query(
      `SELECT estado_contacto FROM clientes_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [idClienteContacto], type: db.QueryTypes.SELECT },
    );
    const estadoFinal = clienteAct?.estado_contacto || estado_contacto;

    // 4. Programar remarketing IG (solo IA, solo dentro de 24h) según estado final
    await programarRemarketingIG({
      id_configuracion,
      id_cliente: idClienteContacto,
      page_id: pageId,
      external_id: igsid,
      estado_contacto: estadoFinal,
    });
  } catch (err) {
    console.error('[IG][KANBAN_IA][ERROR]', err.response?.data || err.message);
  }
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
        pageAccessToken,
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

  static async handleMessage(
    userIgsid,
    message,
    pageId,
    id_configuracion,
    pageAccessToken = null,
  ) {
    let normalizedAttachments = normalizeAttachments(message);

    // Re-hospedar media entrante (las URLs de Meta expiran) en nuestro dominio.
    if (normalizedAttachments) {
      normalizedAttachments = await rehostAttachments(normalizedAttachments);
    }

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

    //  UPDATE_CHAT (IG IN)
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

    // Dashboard real-time
    dashboardEmitter.emitByConfig(id_configuracion, 'new_chat', {
      chatsCreated: 1,
    });

    // ✅ IA kanban (mismo cerebro que WhatsApp). No bloquea la recepción.
    await runKanbanIaIG({
      id_configuracion,
      idClienteDueno,
      idClienteContacto,
      igsid: userIgsid,
      pageId,
      pageAccessToken,
      message,
      uni,
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

    //  UPDATE_CHAT (IG POSTBACK IN)
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

    // Dashboard real-time
    dashboardEmitter.emitByConfig(id_configuracion, 'new_chat', {
      chatsCreated: 1,
    });
  }
}

module.exports = InstagramService;
module.exports.getPageRowByIgId = getPageRowByIgId;
