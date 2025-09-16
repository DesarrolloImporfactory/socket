const fb = require('../utils/facebookGraph');

module.exports = function attachMessengerGateway(io, services) {
  io.on('connection', (socket) => {
    // 1) Rooms
    socket.on('MS_JOIN_CONV', ({ conversation_id, id_configuracion }) => {
      socket.join(`ms:conv:${conversation_id}`);
      socket.join(`ms:cfg:${id_configuracion}`);
    });

    // 2) Enviar mensaje (agente -> usuario)
    socket.on(
      'MS_SEND',
      async ({
        conversation_id,
        text,
        messaging_type,
        tag,
        metadata, // opcional para Graph
        agent_id,
        agent_name,
        client_tmp_id,
      }) => {
        try {
          const [conv] = await services.db.query(
            `SELECT id_configuracion, page_id, psid, last_incoming_at
               FROM messenger_conversations
              WHERE id = ? LIMIT 1`,
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

          // --- Ventana 24h en servidor ---
          const olderThan24h =
            !conv.last_incoming_at ||
            Date.now() - new Date(conv.last_incoming_at).getTime() >
              24 * 60 * 60 * 1000;

          // Normaliza campos Graph
          let opts = { messaging_type, tag, metadata };
          if (olderThan24h) {
            // Fuera de 24h: DEBE ser MESSAGE_TAG con tag válido
            if (!tag) {
              socket.emit('MS_SEND_ERROR', {
                conversation_id,
                error:
                  'Fuera de la ventana de 24h: se requiere Message Tag (p.ej. HUMAN_AGENT / ACCOUNT_UPDATE).',
              });
              return;
            }
            opts.messaging_type = 'MESSAGE_TAG';
          } else {
            // Dentro de 24h: RESPONSE por defecto si no vino
            if (!opts.messaging_type) opts.messaging_type = 'RESPONSE';
          }

          // --- Enviar a Graph ---
          const res = await fb.sendText(conv.psid, text, pageAccessToken, opts);

          // --- Persistir (incluye encargado) ---
          const saved = await services.Store.saveOutgoingMessage({
            id_configuracion: conv.id_configuracion,
            page_id: conv.page_id,
            psid: conv.psid,
            text,
            mid: res?.message_id || null,
            status: 'sent',
            meta: {
              response: res,
              source: 'socket',
              agent_id,
              agent_name,
              opts,
              client_tmp_id,
            },
            id_encargado: agent_id,
          });

          // --- Touch conversación ---
          await services.Store.touchConversationOnOutgoing({
            id_configuracion: conv.id_configuracion,
            page_id: conv.page_id,
            psid: conv.psid,
            now: new Date(),
          });

          // --- Emit tiempo real ---
          io.to(`ms:conv:${conversation_id}`).emit('MS_MESSAGE', {
            conversation_id,
            message: {
              id: saved.id,
              direction: 'out',
              text,
              mid: res?.message_id || null,
              status: 'sent',
              created_at: saved.created_at,
              agent_name,
              client_tmp_id,
            },
          });

          io.to(`ms:cfg:${conv.id_configuracion}`).emit('MS_CONV_UPSERT', {
            id: conversation_id,
            last_message_at: new Date().toISOString(),
            last_outgoing_at: new Date().toISOString(),
            preview: text,
            unread_count: 0,
          });
        } catch (e) {
          console.error('[MS_SEND][ERROR]', e.response?.data || e.message);
          socket.emit('MS_SEND_ERROR', {
            conversation_id,
            error: e.response?.data || e.message,
            client_tmp_id,
          });
        }
      }
    );
  });
};
