const ChatService = require('../services/chat.service');

const {
  normPhone,
  pickAttachmentFromPayload,
  normalizeAttachment,
  isValidPublicUrl,
} = require('../utils/media.helpers');

module.exports = function attachUnifiedGateway(io, services) {
  const { db, fb, ig, getPageTokenByPageId } = services;
  const chatService = services.chatService || new ChatService();

  const roomCfg = (id_configuracion) => `cfg:${id_configuracion}`;
  const roomChat = (chatId) => `chat:${chatId}`;

  //mensaje saliente siempre somos rol 1
  const ROL_ASESOR_DEFAULT = 1;

  const norm = (s) =>
    String(s || '')
      .replace(/\s+/g, '')
      .replace(/^\+/, '');

  async function getChatRowById({ chatId, id_configuracion }) {
    const [row] = await db.query(
      `SELECT *
         FROM vista_chats
        WHERE id = :chatId
          AND id_configuracion = :id_configuracion
        LIMIT 1`,
      {
        replacements: { chatId, id_configuracion },
        type: db.QueryTypes.SELECT,
      },
    );
    return row || null;
  }

  // ✅ Busca chatId por teléfono (para alias SEND_MESSAGE -> unified)
  async function getChatIdByPhone({ id_configuracion, to }) {
    const phone = norm(to);

    const [row] = await db.query(
      `SELECT id
         FROM vista_chats
        WHERE id_configuracion = :id_configuracion
          AND REPLACE(REPLACE(celular_cliente,' ',''),'+','') = :phone
        ORDER BY id DESC
        LIMIT 1`,
      {
        replacements: { id_configuracion, phone },
        type: db.QueryTypes.SELECT,
      },
    );

    return row?.id ? Number(row.id) : null;
  }

  /**
   * ✅ Propietario del canal (el que recibe los IN)
   * Regla: clientes_chat_center.propietario = 1
   */
  async function getOwnerClientId({ id_configuracion }) {
    const [row] = await db.query(
      `SELECT id
       FROM clientes_chat_center
      WHERE id_configuracion = :id_configuracion
        AND propietario = 1
        AND deleted_at IS NULL
      LIMIT 1`,
      {
        replacements: { id_configuracion },
        type: db.QueryTypes.SELECT,
      },
    );

    return row?.id ? Number(row.id) : null;
  }

  async function getLastIncomingAt({ chatId, ownerId }) {
    const [row] = await db.query(
      `SELECT MAX(created_at) AS last_incoming_at
        FROM mensajes_clientes
        WHERE id_cliente = :ownerId
          AND celular_recibe = :chatId
          AND direction = 'in'
          AND deleted_at IS NULL
        `,
      {
        replacements: { chatId, ownerId: String(ownerId) },
        type: db.QueryTypes.SELECT,
      },
    );

    return row?.last_incoming_at ? new Date(row.last_incoming_at) : null;
  }

  function buildPreview({ text, tipo_mensaje }) {
    const t = (text || '').trim();
    if (tipo_mensaje && tipo_mensaje !== 'text') {
      if (tipo_mensaje === 'image') return '📷 Imagen';
      if (tipo_mensaje === 'video') return '🎬 Video';
      return '📎 Archivo';
    }
    return t || '';
  }

  /**
   * ✅ Guardar OUT (propietario -> persona)
   * OUT: id_cliente = ownerId
   *      celular_recibe = chatRow.id (persona)
   */
  async function saveOutgoingUnifiedMessage({
    chatRow,
    ownerId,
    source,
    page_id,
    external_mid,
    text,
    tipo_mensaje,
    ruta_archivo,
    status_unificado,
    agent_name,
    rol_mensaje,
    attachments,
    meta,
  }) {
    const now = new Date();
    const finalRol = Number(rol_mensaje || ROL_ASESOR_DEFAULT);

    await db.query(
      `INSERT INTO mensajes_clientes
        (id_plataforma,
         id_configuracion,
         id_cliente,
         source,
         page_id,
         external_mid,
         mid_mensaje,
         tipo_mensaje,
         rol_mensaje,
         celular_recibe,
         responsable,
         direction,
         status_unificado,
         texto_mensaje,
         ruta_archivo,
         json_mensaje,
         attachments_unificado,
         meta_unificado,
         visto,
         created_at,
         updated_at)
       VALUES
        (:id_plataforma,
         :id_configuracion,
         :id_cliente,
         :source,
         :page_id,
         :external_mid,
         :mid_mensaje,
         :tipo_mensaje,
         :rol_mensaje,
         :celular_recibe,
         :responsable,
         'out',
         :status_unificado,
         :texto_mensaje,
         :ruta_archivo,
         :json_mensaje,
         :attachments_unificado,
         :meta_unificado,
         1,
         :created_at,
         :updated_at)`,
      {
        replacements: {
          id_plataforma: chatRow.id_plataforma || null,
          id_configuracion: chatRow.id_configuracion || null,

          // ✅ propietario escribe
          id_cliente: Number(ownerId),

          source,
          page_id: page_id || null,
          external_mid: external_mid || null,
          mid_mensaje: external_mid || null,
          tipo_mensaje: tipo_mensaje || 'text',
          rol_mensaje: finalRol,

          // ✅ persona recibe (chatId)
          celular_recibe: String(chatRow.id),

          responsable: agent_name || null,
          status_unificado: status_unificado || 'sent',
          texto_mensaje: text || null,
          ruta_archivo: ruta_archivo || null,
          json_mensaje: JSON.stringify({
            source,
            page_id,
            external_mid,
            text,
            tipo_mensaje,
            ruta_archivo,
            attachments: attachments || null,
            meta: meta || null,
          }),
          attachments_unificado: attachments
            ? JSON.stringify(attachments)
            : null,
          meta_unificado: JSON.stringify({
            saved_from: 'unified.gateway',
            ownerId,
            created_at: now.toISOString(),
          }),
          created_at: now,
          updated_at: now,
        },
      },
    );

    const [idRow] = await db.query(`SELECT LAST_INSERT_ID() AS id`, {
      type: db.QueryTypes.SELECT,
    });

    return {
      id: idRow?.id || null,

      direction: 'out',
      rol_mensaje: finalRol,
      tipo_mensaje: tipo_mensaje || 'text',

      // ✅ el front viejo/nuevo
      texto_mensaje: text || '',
      text: text || '',

      created_at: now.toISOString(),
      status_unificado: status_unificado || 'sent',

      mid: external_mid || null,
      external_mid: external_mid || null,
      page_id: page_id || null,
      source,

      preview: buildPreview({ text, tipo_mensaje }),
      ruta_archivo: ruta_archivo || null,
      attachments: attachments || null,
    };
  }

  function emitUpdateChatUnified({
    id_configuracion,
    chatId,
    source,
    message,
    chat,
  }) {
    io.emit('UPDATE_CHAT', {
      id_configuracion,
      chatId,
      source, // 'wa' | 'ms' | 'ig'
      message, // mensaje (con created_at, texto_mensaje, tipo_mensaje, rol_mensaje/direction)
      chat, // opcional pero recomendado (para id_encargado, nombre_cliente, etc)
    });
  }

  function emitUnifiedMessage({ id_configuracion, chatId, source, message }) {
    io.to(roomChat(chatId)).emit('CHAT_MESSAGE', {
      id_configuracion,
      chatId,
      source,
      message,
    });

    io.to(roomCfg(id_configuracion)).emit('CHAT_CONV_UPSERT', {
      id_configuracion,
      chatId,
      source,
      last_message_at: message.created_at,
      preview: message.preview || message.text || '',
      unread_count: 0,
    });
  }

  async function sendWA({
    chatRow,
    text,
    tipo_mensaje,
    ruta_archivo,
    agent_name,
  }) {
    const dataAdmin = await chatService.getDataAdmin(chatRow.id_configuracion);
    const to = norm(chatRow.celular_cliente);

    const resp = await chatService.sendMessage({
      mensaje: text,
      to,
      dataAdmin,
      tipo_mensaje: tipo_mensaje || 'text',
      id_configuracion: chatRow.id_configuracion,
      ruta_archivo: ruta_archivo || null,
      nombre_encargado: agent_name || null,
    });

    const m = resp?.mensajeNuevo;

    return {
      // ✅ devolvemos lo que ya genera su WA backend
      id: m?.id,
      direction: 'out',
      text: m?.texto_mensaje || text || '',
      created_at: m?.created_at || new Date().toISOString(),
      status: 'sent',
      mid: m?.id_wamid_mensaje || null,
      preview: buildPreview({
        text: m?.texto_mensaje || text || '',
        tipo_mensaje,
      }),
      ruta_archivo: ruta_archivo || null,
    };
  }

  async function sendMS({
    chatRow,
    text,
    attachment,
    agent_name,
    client_tmp_id,
    messaging_type,
    tag,
    metadata,
    rol_mensaje,
  }) {
    const psid = chatRow.external_id;
    const page_id = chatRow.page_id;

    if (!psid || !page_id)
      throw new Error('MS: falta external_id o page_id en el chat.');

    const ownerId = await getOwnerClientId({
      id_configuracion: chatRow.id_configuracion,
    });
    if (!ownerId)
      throw new Error(
        'MS: no se encontró el cliente propietario (propietario=1).',
      );

    const pageAccessToken = await getPageTokenByPageId(page_id, 'ms');
    if (!pageAccessToken)
      throw new Error('No se encontró page_access_token para Messenger.');

    const lastIncomingAt = await getLastIncomingAt({
      chatId: chatRow.id,
      ownerId,
    });
    const olderThan24h =
      !lastIncomingAt ||
      Date.now() - lastIncomingAt.getTime() > 24 * 60 * 60 * 1000;

    let opts = { messaging_type, tag, metadata };
    if (olderThan24h) {
      if (!tag)
        throw new Error(
          'Fuera de 24h: se requiere Message Tag (p.ej. HUMAN_AGENT).',
        );
      opts.messaging_type = 'MESSAGE_TAG';
    } else {
      if (!opts.messaging_type) opts.messaging_type = 'RESPONSE';
    }

    let picked = attachment;
    if (!picked) picked = pickAttachmentFromPayload({ attachment });

    const hasText = !!(text && String(text).trim());
    const hasAttachment = !!(picked && picked.url);
    if (!hasText && !hasAttachment)
      throw new Error('El mensaje no puede estar vacío');

    let fbRes;
    let tipo_mensaje = 'text';
    let ruta_archivo = null;
    let finalText = hasText ? text.trim() : null;
    let attachments = null;

    if (hasAttachment) {
      const att = normalizeAttachment(picked);

      if (!isValidPublicUrl(att.url)) {
        throw new Error('Adjunto inválido: la URL no es pública/HTTP(S).');
      }

      const type =
        att.kind === 'image'
          ? 'image'
          : att.kind === 'video'
            ? 'video'
            : 'file';

      tipo_mensaje = type === 'file' ? 'file' : type;
      ruta_archivo = att.url;
      attachments = [att];

      fbRes = await fb.sendAttachment(
        psid,
        { type, url: att.url },
        pageAccessToken,
        opts,
      );
    } else {
      fbRes = await fb.sendText(psid, finalText, pageAccessToken, opts);
    }

    const mid = fbRes?.message_id || fbRes?.messages?.[0]?.id || null;

    return await saveOutgoingUnifiedMessage({
      chatRow,
      ownerId,
      source: 'ms',
      page_id,
      external_mid: mid,
      text: finalText,
      tipo_mensaje,
      ruta_archivo,
      status_unificado: 'sent',
      agent_name,
      rol_mensaje,
      attachments,
      meta: { response: fbRes, opts, client_tmp_id },
    });
  }

  async function sendIG({
    chatRow,
    text,
    attachment,
    agent_name,
    client_tmp_id,
    messaging_type,
    tag,
    metadata,
    rol_mensaje,
  }) {
    const igsid = chatRow.external_id;
    const page_id = chatRow.page_id;

    if (!igsid || !page_id)
      throw new Error('IG: falta external_id o page_id en el chat.');

    const ownerId = await getOwnerClientId({
      id_configuracion: chatRow.id_configuracion,
    });
    if (!ownerId)
      throw new Error(
        'IG: no se encontró el cliente propietario (propietario=1).',
      );

    const pageAccessToken = await getPageTokenByPageId(page_id, 'ig');
    if (!pageAccessToken)
      throw new Error('No se encontró page_access_token para Instagram.');

    const lastIncomingAt = await getLastIncomingAt({
      chatId: chatRow.id,
      ownerId,
    });
    const olderThan24h =
      !lastIncomingAt ||
      Date.now() - lastIncomingAt.getTime() > 24 * 60 * 60 * 1000;

    let opts = { messaging_type, tag, metadata };
    if (olderThan24h) {
      if (!tag)
        throw new Error('Fuera de 24h: se requiere Message Tag válido.');
      opts.messaging_type = 'MESSAGE_TAG';
    } else {
      if (!opts.messaging_type) opts.messaging_type = 'RESPONSE';
    }

    // aceptar attachment de varias formas (front nuevo/legacy)
    let picked = attachment;
    if (!picked) picked = pickAttachmentFromPayload({ attachment });

    const hasText = !!(text && String(text).trim());
    const hasAttachment = !!(picked && picked.url);
    if (!hasText && !hasAttachment)
      throw new Error('El mensaje no puede estar vacío');

    let igRes;
    let tipo_mensaje = 'text';
    let ruta_archivo = null;
    let finalText = hasText ? text.trim() : null;
    let attachments = null;

    if (hasAttachment) {
      const att = normalizeAttachment(picked);

      if (!isValidPublicUrl(att.url)) {
        throw new Error('Adjunto inválido: la URL no es pública/HTTP(S).');
      }

      const type =
        att.kind === 'image'
          ? 'image'
          : att.kind === 'video'
            ? 'video'
            : 'file';

      tipo_mensaje = type === 'file' ? 'file' : type;
      ruta_archivo = att.url;
      attachments = [att];

      igRes = await ig.sendAttachment(
        igsid,
        { type, url: att.url },
        pageAccessToken,
        opts,
      );
    } else {
      igRes = await ig.sendText(igsid, finalText, pageAccessToken, opts);
    }

    const mid = igRes?.message_id || igRes?.messages?.[0]?.id || null;

    return await saveOutgoingUnifiedMessage({
      chatRow,
      ownerId,
      source: 'ig',
      page_id,
      external_mid: mid,
      text: finalText,
      tipo_mensaje,
      ruta_archivo,
      status_unificado: 'sent',
      agent_name,
      rol_mensaje,
      attachments,
      meta: { response: igRes, opts, client_tmp_id },
    });
  }

  io.on('connection', (socket) => {
    socket.on('CHAT_JOIN_CFG', ({ id_configuracion }) => {
      if (!id_configuracion) return;
      socket.join(roomCfg(id_configuracion));
    });

    socket.on('CHAT_JOIN_CONV', ({ chatId, id_configuracion }) => {
      if (id_configuracion) socket.join(roomCfg(id_configuracion));
      if (chatId) socket.join(roomChat(chatId));
    });

    const handleUnifiedSend = async (payload) => {
      const {
        id_configuracion,
        chatId,
        text,
        tipo_mensaje,
        ruta_archivo,
        attachment,
        agent_name,
        client_tmp_id,
        messaging_type,
        tag,
        metadata,
        rol_mensaje,

        //si el front manda attachments también
        attachments,
        mime_type,
        file_name,
        size,

        // ✅ nuevo (front)
        attachment_url,
      } = payload || {};

      if (!id_configuracion || !chatId) {
        socket.emit('CHAT_SEND_ERROR', {
          chatId,
          error: 'Falta id_configuracion o chatId',
          client_tmp_id,
        });
        return { ok: false, error: 'Falta id_configuracion o chatId' };
      }

      const chatRow = await getChatRowById({ chatId, id_configuracion });
      if (!chatRow) {
        socket.emit('CHAT_SEND_ERROR', {
          chatId,
          error: 'No se encontró el chat en vista_chats',
          client_tmp_id,
        });
        return { ok: false, error: 'No se encontró el chat en vista_chats' };
      }

      const source = String(chatRow.source || 'wa').toLowerCase();

      // normalizar adjunto desde cualquier formato del front
      const picked = pickAttachmentFromPayload({
        attachment,
        attachments,
        attachment_url, // ✅ nuevo
        ruta_archivo,
        tipo_mensaje,
        mime_type,
        file_name,
        size,
      });

      let msg;

      if (source === 'wa') {
        // ✅ Si viene adjunto, forzar tipo + ruta para WA
        let finalTipo = tipo_mensaje || 'text';
        let finalRuta = ruta_archivo || null;

        if (picked?.url) {
          const k = String(picked.kind || '').toLowerCase();
          finalTipo =
            k === 'image' ? 'image' : k === 'video' ? 'video' : 'document';
          finalRuta = picked.url;
        }

        msg = await sendWA({
          chatRow,
          text, // será caption si hay media
          tipo_mensaje: finalTipo,
          ruta_archivo: finalRuta,
          agent_name,
        });
      } else if (source === 'ms') {
        msg = await sendMS({
          chatRow,
          text,
          attachment: picked,
          agent_name,
          client_tmp_id,
          messaging_type,
          tag,
          metadata,
          rol_mensaje,
        });
      } else if (source === 'ig') {
        msg = await sendIG({
          chatRow,
          text,
          attachment: picked,
          agent_name,
          client_tmp_id,
          messaging_type,
          tag,
          metadata,
          rol_mensaje,
        });
      } else {
        throw new Error(`source no soportado: ${source}`);
      }

      //emitir evento que escucha el FRONT NUEVO (UPDATE_CHAT)
      // emitUpdateChatUnified({
      //   id_configuracion,
      //   chatId,
      //   source,
      //   message: msg,
      //   chat: chatRow, // ✅ trae id_encargado, nombre_cliente, etc (lo usa el front para filtrar)
      // });

      // 2) ack al emisor
      socket.emit('CHAT_SEND_OK', { chatId, client_tmp_id, message: msg });

      return { ok: true, message: msg, source, chatId };
    };

    // ✅ nuevo evento unificado (ideal)
    socket.on('CHAT_SEND', async (payload) => {
      try {
        await handleUnifiedSend(payload);
      } catch (e) {
        socket.emit('CHAT_SEND_ERROR', {
          chatId: payload?.chatId,
          error: e?.response?.data || e.message,
          client_tmp_id: payload?.client_tmp_id,
        });
      }
    });

    /**
     * ✅ ALIAS para front actual: SEND_MESSAGE (WA legacy)
     * Recibe: { mensaje, tipo_mensaje, to, id_configuracion, nombre_encargado, ... }
     * Convierte a: CHAT_SEND { id_configuracion, chatId, text, ... }
     */
    socket.on('SEND_MESSAGE', async (data) => {
      try {
        const id_configuracion = data?.id_configuracion;

        // 1) Intentar usar chatId directo (si el front lo manda)
        let chatId = data?.chatId ? Number(data.chatId) : null;

        // 2) Si no hay chatId, modo WA por teléfono
        if (!chatId && data?.to) {
          chatId = await getChatIdByPhone({ id_configuracion, to: data.to });
        }

        // 3) Si no hay chatId, modo IG/MS por external_id + page_id + source
        if (!chatId && data?.external_id && data?.page_id && data?.source) {
          chatId = await getChatIdByExternal({
            id_configuracion,
            source: String(data.source).toLowerCase(), // 'ig' | 'ms'
            page_id: data.page_id,
            external_id: data.external_id,
          });
        }

        // 4) Si aún no hay chatId, intentar inferir desde selectedChat (si lo manda)
        if (!chatId && data?.selectedChat?.id) {
          chatId = Number(data.selectedChat.id);
        }

        if (!chatId) {
          socket.emit('MESSAGE_RESPONSE', {
            error:
              'No se encontró chatId. En WA envíe to; en IG/MS envíe chatId o (source,page_id,external_id).',
          });
          return;
        }

        // Normalizar payload unificado
        const unifiedPayload = {
          id_configuracion,
          chatId,
          text: data?.mensaje || data?.text || '',
          tipo_mensaje: data?.tipo_mensaje || 'text',
          ruta_archivo: data?.ruta_archivo || null,
          agent_name: data?.nombre_encargado || data?.agent_name || null,

          // Para IG/MS adjuntos + ventana 24h si se desea
          attachment: data?.attachment || null,
          attachments: data?.attachments || null, //(por si el front manda array)
          attachment_url: data?.attachment_url || null, // ✅ nuevo (front)
          messaging_type: data?.messaging_type,
          tag: data?.tag,
          metadata: data?.metadata,
          rol_mensaje: data?.rol_mensaje,
          client_tmp_id: data?.client_tmp_id,

          //  (si el front manda metadata del archivo)
          mime_type: data?.mime_type,
          file_name: data?.file_name,
          size: data?.size,
        };

        const result = await handleUnifiedSend(unifiedPayload);

        if (result.ok) {
          // Mantener compatibilidad con  front
          socket.emit('MESSAGE_RESPONSE', {
            ok: true,
            mensajeNuevo: result.message,
          });
        } else {
          socket.emit('MESSAGE_RESPONSE', { error: result.error });
        }
      } catch (e) {
        socket.emit('MESSAGE_RESPONSE', {
          error: e?.response?.data || e.message,
        });
      }
    });
  });
};
