const ChatService = require('../services/chat.service');

module.exports = function attachUnifiedGateway(io, services) {
  const { db, fb, ig, getPageTokenByPageId } = services;
  const chatService = services.chatService || new ChatService();

  const roomCfg = (id_configuracion) => `cfg:${id_configuracion}`;
  const roomChat = (chatId) => `chat:${chatId}`;

  // ⚠️ Ajuste a su valor real si no es 2
  const ROL_ASESOR_DEFAULT = 2;

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

  /**
   * ✅ Propietario del canal (el que recibe los IN)
   * Regla: clientes_chat_center.propietario = 1
   */
  async function getOwnerClientId({ id_configuracion, source, page_id }) {
    const [row] = await db.query(
      `SELECT id
         FROM clientes_chat_center
        WHERE id_configuracion = :id_configuracion
          AND propietario = 1
          AND source = :source
          AND (
            (:page_id IS NULL AND page_id IS NULL)
            OR (page_id = :page_id)
          )
        ORDER BY id ASC
        LIMIT 1`,
      {
        replacements: { id_configuracion, source, page_id: page_id || null },
        type: db.QueryTypes.SELECT,
      },
    );
    return row?.id ? Number(row.id) : null;
  }

  /**
   * ✅ Último mensaje ENTRANTE para ventana 24h
   * Su regla real:
   * IN: id_cliente = persona (chatRow.id)
   *     celular_recibe = ownerId (propietario)
   */
  async function getLastIncomingAt({ chatId, ownerId }) {
    const [row] = await db.query(
      `SELECT MAX(created_at) AS last_incoming_at
         FROM mensajes_clientes
        WHERE id_cliente = :chatId
          AND celular_recibe = :ownerId
          AND direction = 'in'
          AND deleted_at IS NULL`,
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
          id_cliente: Number(ownerId), // ✅ propietario escribe
          source,
          page_id: page_id || null,
          external_mid: external_mid || null,
          mid_mensaje: external_mid || null,
          tipo_mensaje: tipo_mensaje || 'text',
          rol_mensaje: finalRol,
          celular_recibe: String(chatRow.id), // ✅ persona recibe
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
      text: text || '',
      created_at: now.toISOString(),
      status: status_unificado || 'sent',
      mid: external_mid || null,
      preview: buildPreview({ text, tipo_mensaje }),
      ruta_archivo: ruta_archivo || null,
      attachments: attachments || null,
    };
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
      source: 'ms',
      page_id,
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

    const hasText = !!(text && String(text).trim());
    const hasAttachment = !!(attachment && attachment.url);
    if (!hasText && !hasAttachment)
      throw new Error('El mensaje no puede estar vacío');

    let fbRes;
    let tipo_mensaje = 'text';
    let ruta_archivo = null;
    let finalText = hasText ? text.trim() : null;
    let attachments = null;

    if (hasAttachment) {
      const type =
        attachment.kind === 'image'
          ? 'image'
          : attachment.kind === 'video'
            ? 'video'
            : 'file';

      tipo_mensaje = type === 'file' ? 'file' : type;
      ruta_archivo = attachment.url;
      attachments = [attachment];

      fbRes = await fb.sendAttachment(
        psid,
        { type, url: attachment.url },
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
      source: 'ig',
      page_id,
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

    const hasText = !!(text && String(text).trim());
    const hasAttachment = !!(attachment && attachment.url);
    if (!hasText && !hasAttachment)
      throw new Error('El mensaje no puede estar vacío');

    let igRes;
    let tipo_mensaje = 'text';
    let ruta_archivo = null;
    let finalText = hasText ? text.trim() : null;
    let attachments = null;

    if (hasAttachment) {
      const type =
        attachment.kind === 'image'
          ? 'image'
          : attachment.kind === 'video'
            ? 'video'
            : 'file';

      tipo_mensaje = type === 'file' ? 'file' : type;
      ruta_archivo = attachment.url;
      attachments = [attachment];

      igRes = await ig.sendAttachment(
        igsid,
        { type, url: attachment.url },
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

    socket.on('CHAT_SEND', async (payload) => {
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
      } = payload || {};

      try {
        if (!id_configuracion || !chatId) {
          socket.emit('CHAT_SEND_ERROR', {
            chatId,
            error: 'Falta id_configuracion o chatId',
            client_tmp_id,
          });
          return;
        }

        const chatRow = await getChatRowById({ chatId, id_configuracion });
        if (!chatRow) {
          socket.emit('CHAT_SEND_ERROR', {
            chatId,
            error: 'No se encontró el chat en vista_chats',
            client_tmp_id,
          });
          return;
        }

        const source = String(chatRow.source || 'wa').toLowerCase();

        let msg;
        if (source === 'wa') {
          msg = await sendWA({
            chatRow,
            text,
            tipo_mensaje,
            ruta_archivo,
            agent_name,
          });
        } else if (source === 'ms') {
          msg = await sendMS({
            chatRow,
            text,
            attachment,
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
            attachment,
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

        emitUnifiedMessage({ id_configuracion, chatId, source, message: msg });
        socket.emit('CHAT_SEND_OK', { chatId, client_tmp_id, message: msg });
      } catch (e) {
        console.error('[CHAT_SEND][ERROR]', e?.response?.data || e.message);
        socket.emit('CHAT_SEND_ERROR', {
          chatId,
          error: e?.response?.data || e.message,
          client_tmp_id,
        });
      }
    });
  });
};
