const fb = require('../utils/facebookGraph');

module.exports = function attachMessengerGateway(io, services) {
  io.on('connection', (socket) => {
    // Rooms
    socket.on('MS_JOIN_CONV', ({ conversation_id, id_configuracion }) => {
      socket.join(`ms:conv:${conversation_id}`);
      socket.join(`ms:cfg:${id_configuracion}`);
    });

    // Enviar mensaje (agente -> usuario)
    socket.on(
      'MS_SEND',
      async ({
        conversation_id,
        text, // opcional
        attachment, // <-- { kind: "image"|"video"|"document", url, name, mimeType, size }
        messaging_type,
        tag,
        metadata,
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
            if (!tag) {
              socket.emit('MS_SEND_ERROR', {
                conversation_id,
                error:
                  'Fuera de 24h: se requiere Message Tag (p.ej. HUMAN_AGENT).',
                client_tmp_id,
              });
              return;
            }
            opts.messaging_type = 'MESSAGE_TAG';
          } else {
            if (!opts.messaging_type) opts.messaging_type = 'RESPONSE';
          }

          // --- Validación: debe venir texto o attachment ---
          // --- Validación: debe venir texto o attachment ---
          const hasText = !!(text && String(text).trim());
          const hasAttachment = !!(attachment && attachment.url);
          if (!hasText && !hasAttachment) {
            socket.emit('MS_SEND_ERROR', {
              conversation_id,
              error: { error: { message: 'El mensaje no puede estar vacío' } },
              client_tmp_id,
            });
            return;
          }

          // --- Enviar a Graph ---
          let fbRes;
          let messagePreview = hasText ? text.trim() : '';

          if (hasAttachment) {
            // mapear kind -> type de Messenger
            const type =
              attachment.kind === 'image'
                ? 'image'
                : attachment.kind === 'video'
                ? 'video'
                : 'file'; // "document" => "file"

            fbRes = await fb.sendAttachment(
              conv.psid,
              { type, url: attachment.url },
              pageAccessToken,
              opts
            );

            if (!messagePreview) {
              messagePreview =
                attachment.kind === 'image'
                  ? '📷 Imagen'
                  : attachment.kind === 'video'
                  ? '🎬 Video'
                  : '📎 Archivo';
            }
          } else {
            fbRes = await fb.sendText(
              conv.psid,
              text.trim(),
              pageAccessToken,
              opts
            );
          }

          const mid = fbRes?.message_id || fbRes?.messages?.[0]?.id || null;

          // --- Persistir (OJO: aquí attachments es un ARRAY JS; el Store lo serializa) ---
          const saved = await services.Store.saveOutgoingMessage({
            id_configuracion: conv.id_configuracion,
            page_id: conv.page_id,
            psid: conv.psid,
            text: hasText ? text.trim() : null,
            mid,
            status: 'sent',
            attachments: hasAttachment
              ? [
                  {
                    type: attachment.kind, // image | video | document
                    url: attachment.url,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    storage: 's3',
                  },
                ]
              : null,
            meta: {
              response: fbRes,
              source: 'socket',
              agent_id,
              agent_name,
              opts,
              client_tmp_id,
            },
            id_encargado: agent_id || null,
          });

          // --- Emitir a los clientes para reemplazar el tmp ---
          io.to(`ms:conv:${conversation_id}`).emit('MS_MESSAGE', {
            conversation_id,
            message: {
              id: saved.message_id,
              direction: 'out',
              text: hasText ? text.trim() : '',
              attachments: hasAttachment
                ? [
                    {
                      type: attachment.kind,
                      url: attachment.url,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                      size: attachment.size,
                    },
                  ]
                : null,
              mid,
              status: 'sent',
              created_at: saved.created_at,
              agent_name,
              client_tmp_id,
            },
          });

          // --- Upsert para el preview del sidebar ---
          io.to(`ms:cfg:${conv.id_configuracion}`).emit('MS_CONV_UPSERT', {
            id: conversation_id,
            last_message_at: new Date().toISOString(),
            last_outgoing_at: new Date().toISOString(),
            preview: messagePreview,
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
