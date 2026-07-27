const fb = require('../utils/facebookGraph');
const { db } = require('../database/config');
const Store = require('./messenger_store.service');
const dashboardEmitter = require('../controllers/dashboardEmitter');
const { rehostAttachments } = require('../utils/rehostMediaMeta');
const { describirImagenDesdeUrl } = require('../utils/openia/describirImagen');
const {
  transcribirAudioDesdeUrl,
  TEXTO_AUDIO_ILEGIBLE,
} = require('../utils/openia/transcribirAudio');

const FB_APP_ID = process.env.FB_APP_ID;

/**
 * Guarda la transcripción en el mensaje entrante ya insertado.
 *
 * Igual que en WhatsApp e Instagram: construirRecapConversacion()
 * (kanban_ia.service.js) reconstruye el historial leyendo texto_mensaje de la
 * BD, así que si la transcripción vive sólo en memoria la IA pierde lo que el
 * cliente dijo por audio en cuanto se resetea el hilo.
 *
 * Para audios, saveIncomingMessageUnified guarda texto_mensaje = null (no hay
 * caption que pisar), así que esto sólo agrega información.
 * Nunca lanza: un fallo acá no debe impedir que la IA responda.
 */
async function guardarTranscripcionMS(idMensaje, texto) {
  if (!idMensaje || !texto) return;
  try {
    await db.query(
      `UPDATE mensajes_clientes SET texto_mensaje = ?, updated_at = NOW() WHERE id = ?`,
      { replacements: [texto, idMensaje], type: db.QueryTypes.UPDATE },
    );
  } catch (err) {
    console.error('[MS][WHISPER][GUARDAR_TRANSCRIPCION]', err.message);
  }
}

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
  // Se excluyen las conexiones suspendidas y, ante empate, gana la más
  // reciente. Sin esto, una fila 'active' de una tarjeta ya suspendida se
  // quedaba con el LIMIT 1 y los mensajes nunca llegaban a la conexión viva
  // del mismo cliente (caso real: página en las configs 491 suspendida y 626
  // activa; todo se iba a la 491).
  const [row] = await db.query(
    `SELECT mp.id_configuracion
       FROM messenger_pages mp
       JOIN configuraciones c ON c.id = mp.id_configuracion
      WHERE mp.page_id = ?
        AND mp.status = 'active'
        AND c.suspendido = 0
      ORDER BY mp.id_messenger_page DESC
      LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT },
  );
  return row?.id_configuracion || null;
}

/**
 * Corre la MISMA IA kanban de WhatsApp sobre un mensaje entrante de Messenger.
 * Reutiliza procesarMensajeKanban con un "canal" MS (fb.sendText/sendAttachment
 * + persistencia unificada + emit socket) y engancha el remarketing MS.
 *
 * v1: solo texto y audios (transcritos). Remarketing solo IA, dentro de 24h.
 * Nunca lanza: cualquier error se loguea para no romper la recepción.
 */
async function runKanbanIaMS({
  id_configuracion,
  idClienteDueno,
  idClienteContacto,
  psid,
  pageId,
  pageAccessToken,
  message,
  uni,
  idMensaje = null, // id del mensaje entrante ya guardado (para la transcripción)
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

    // 3) Construir el mensaje para la IA (texto, audio transcrito o imagen leída)
    let mensajeIA = (message.text || '').trim();
    if (!mensajeIA) {
      const audioUrl = (message.attachments || []).find(
        (a) => a?.type === 'audio' && a?.payload?.url,
      )?.payload?.url;

      if (audioUrl) {
        const transcrito = await transcribirAudioDesdeUrl(
          audioUrl,
          api_key_openai,
          'MS',
          // mid de Meta + id del mensaje en nuestra BD: con eso se ubica el
          // audio exacto en debug_log.txt si la transcripción falla.
          `mid=${message.mid || 's/n'} msg=${idMensaje || 's/n'}`,
        );

        if (transcrito) {
          mensajeIA = transcrito.trim();
          await guardarTranscripcionMS(idMensaje, mensajeIA);
        } else {
          // Antes, si la transcripción fallaba, mensajeIA quedaba vacío y el
          // `return` de más abajo dejaba al cliente sin ninguna respuesta y sin
          // rastro. Mismo criterio que las imágenes: se avisa a la IA.
          console.log('[MS][WHISPER] audio no transcrito — se avisa a la IA');
          mensajeIA = TEXTO_AUDIO_ILEGIBLE;
        }
      }
    }
    if (!mensajeIA) {
      const imagenUrl = (message.attachments || []).find(
        (a) => a?.type === 'image' && a?.payload?.url,
      )?.payload?.url;

      if (imagenUrl) {
        const descripcion = await describirImagenDesdeUrl(
          imagenUrl,
          api_key_openai,
          'MS',
        );
        // Si la visión falla se avisa igual, para que la IA no reciba vacío.
        mensajeIA = (descripcion || '[El cliente envió una imagen]').trim();
      }
    }
    if (!mensajeIA) return; // solo texto/audio/imagen disparan la IA

    // 4) Adaptador de canal Messenger (envío + persistencia + socket)
    const persistirYEmitir = async ({
      fbRes,
      text,
      attachments,
      responsable,
    }) => {
      const mid = fbRes?.message_id || fbRes?.messages?.[0]?.id || null;
      const saved = await Store.saveOutgoingMessageUnified({
        id_configuracion,
        id_plataforma: null,
        id_cliente: idClienteDueno,
        celular_recibe: idClienteContacto,
        source: 'ms',
        page_id: pageId,
        external_id: psid,
        mid,
        text: text || null,
        attachments: attachments || null,
        status_unificado: 'sent',
        responsable,
        meta: { ia: true, response: fbRes },
        id_encargado: uni?.id_encargado ?? null,
      });

      emitUpdateChatMS({
        id_configuracion,
        chatId: idClienteContacto,
        pageId,
        external_id: psid,
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
      source: 'ms',
      enviarTexto: async ({ texto, responsable }) => {
        const fbRes = await fb.sendText(psid, texto, pageAccessToken);
        await persistirYEmitir({ fbRes, text: texto, responsable });
      },
      enviarMedia: async ({ tipo, url, responsable }) => {
        const fbType =
          tipo === 'video' ? 'video' : tipo === 'image' ? 'image' : 'file';
        const fbRes = await fb.sendAttachment(
          psid,
          { type: fbType, url },
          pageAccessToken,
        );
        await persistirYEmitir({
          fbRes,
          text: null,
          attachments: [{ type: fbType, payload: { url } }],
          responsable,
        });
      },
    };

    const {
      procesarMensajeKanban,
      cancelarRemarketingKanban,
    } = require('./kanban_ia.service');
    const { programarRemarketingMS } = require('./remarketing_ms.service');

    // 1. Cliente respondió → cancelar remarketing pendiente SIEMPRE
    await cancelarRemarketingKanban(idClienteContacto, id_configuracion);

    // 2. Ejecutar el MISMO cerebro kanban de WhatsApp
    await procesarMensajeKanban({
      id_configuracion,
      id_cliente: idClienteContacto,
      telefono: '', // MS no tiene teléfono; Dropi por teléfono no aplica
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

    // 4. Programar remarketing MS (solo IA, solo dentro de 24h) según estado final
    await programarRemarketingMS({
      id_configuracion,
      id_cliente: idClienteContacto,
      page_id: pageId,
      external_id: psid,
      estado_contacto: estadoFinal,
    });
  } catch (err) {
    console.error('[MS][KANBAN_IA][ERROR]', err.response?.data || err.message);
  }
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

    // Re-hospedar media entrante (las URLs de Meta expiran) en nuestro dominio.
    let attsRehosted = message.attachments || null;
    if (attsRehosted) {
      attsRehosted = await rehostAttachments(attsRehosted);
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
        attachments: attsRehosted,
        quick_reply_payload: message.quick_reply?.payload || null,
        sticker_id: message.sticker_id || null,
        meta: { raw: message },
      });

      console.log('[MS][SAVE_INCOMING][OK]', saved);

      // Meta reenvió un evento que ya habíamos procesado: no re-emitimos al
      // front ni volvemos a disparar la IA (evita mensaje duplicado en el chat,
      // segunda transcripción y respuesta doble al cliente).
      if (saved?.duplicado) return;

      // Dashboard real-time
      dashboardEmitter.emitByConfig(id_configuracion, 'new_chat', {
        chatsCreated: 1,
      });

      //  emitir UPDATE_CHAT para ver en tiempo real (MS IN)
      emitUpdateChatMS({
        id_configuracion,
        chatId: idClienteContacto,
        pageId,
        external_id: senderPsid,
        uni,
        saved,
        rawMessage: { ...message, attachments: attsRehosted },
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

    // ✅ IA kanban (mismo cerebro que WhatsApp). No bloquea la recepción.
    await runKanbanIaMS({
      id_configuracion,
      idClienteDueno,
      idClienteContacto,
      psid: senderPsid,
      pageId,
      pageAccessToken,
      message,
      uni,
      idMensaje: saved?.message_id ?? null, // para persistir la transcripción
    });
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

      // Dashboard real-time
      dashboardEmitter.emitByConfig(id_configuracion, 'new_chat', {
        chatsCreated: 1,
      });

      //  emitir UPDATE_CHAT para ver en tiempo real (MS POSTBACK IN)
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
