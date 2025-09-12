module.exports = function attachMessengerGateway(io, services) {
  // services: { Store, fb, db, getPageTokenByPageId, getConfigIdByPageId }
  io.on('connection', (socket) => {
    // 1) Unirse a una conversación para recibir tiempo real
    socket.on('MS_JOIN_CONV', ({ conversation_id, id_configuracion }) => {
      socket.join(`ms:conv:${conversation_id}`);
      socket.join(`ms:cfg:${id_configuracion}`); // para actualizaciones de la lista
    });

    // 2) Enviar mensaje (desde el agente) por Messenger
    socket.on('MS_SEND', async ({ conversation_id, text }) => {
      try {
        // Carga conversación
        const [conv] = await services.db.query(
          `SELECT id_configuracion, page_id, psid FROM messenger_conversations WHERE id = ? LIMIT 1`,
          {
            replacements: [conversation_id],
            type: services.db.QueryTypes.SELECT,
          }
        );
        if (!conv) return;

        const pageAccessToken = await services.getPageTokenByPageId(
          conv.page_id
        );
        if (!pageAccessToken) return;

        // Envía al Graph
        const res = await services.fb.sendText(
          conv.psid,
          text,
          pageAccessToken
        );

        // Persiste como OUT 'sent'
        const saved = await services.Store.saveOutgoingMessage({
          id_configuracion: conv.id_configuracion,
          page_id: conv.page_id,
          psid: conv.psid,
          text,
          mid: res?.message_id || null,
          status: 'sent',
          meta: { response: res, source: 'socket' },
        });

        // Actualiza cabecera de la conversación
        await services.Store.touchConversationOnOutgoing({
          id_configuracion: conv.id_configuracion,
          page_id: conv.page_id,
          psid: conv.psid,
          now: new Date(),
        });

        // Notifica en tiempo real a la caja de chat
        io.to(`ms:conv:${conversation_id}`).emit('MS_MESSAGE', {
          conversation_id,
          message: {
            id: saved.id,
            direction: 'out',
            text,
            mid: res?.message_id || null,
            status: 'sent',
            created_at: saved.created_at,
          },
        });

        // Notifica actualización de la lista (preview/orden)
        io.to(`ms:cfg:${conv.id_configuracion}`).emit('MS_CONV_UPSERT', {
          id: conversation_id,
          last_message_at: new Date().toISOString(),
          last_outgoing_at: new Date().toISOString(),
          preview: text,
          unread_count: 0,
        });
      } catch (e) {
        console.error('[MS_SEND][ERROR]', e.response?.data || e.message);
        // opcional: emitir error al cliente
        socket.emit('MS_SEND_ERROR', {
          conversation_id,
          error: e.response?.data || e.message,
        });
      }
    });
  });
};
