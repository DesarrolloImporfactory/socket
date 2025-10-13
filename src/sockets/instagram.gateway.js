const ig = require('../utils/instagramGraph');

module.exports = function attachInstagramGateway(io, services) {
  io.on('connection', (socket) => {
    // Unirse a salas
    socket.on('IG_JOIN_CONV', ({ conversation_id, id_configuracion }) => {
      socket.join(`ig:conv:${conversation_id}`);
      socket.join(`ig:cfg:${id_configuracion}`);
    });

    // Enviar (agente -> usuario IG)
    socket.on(
      'IG_SEND',
      async ({
        conversation_id,
        text,
        attachment, // { kind:"image"|"video"|"document", url, name, mimeType, size }
        messaging_type,
        tag,
        metadata,
        agent_id,
        agent_name,
        client_tmp_id,
      }) => {
        try {
          const [conv] = await services.db.query(
            `SELECT id_configuracion, page_id, igsid, last_incoming_at
             FROM instagram_conversations
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

          const olderThan24h =
            !conv.last_incoming_at ||
            Date.now() - new Date(conv.last_incoming_at).getTime() >
              24 * 60 * 60 * 1000;

          let opts = { messaging_type, tag, metadata };
          if (olderThan24h) {
            if (!tag) {
              socket.emit('IG_SEND_ERROR', {
                conversation_id,
                error: 'Fuera de 24h: se requiere Message Tag válido.',
                client_tmp_id,
              });
              return;
            }
            opts.messaging_type = 'MESSAGE_TAG';
          } else {
            if (!opts.messaging_type) opts.messaging_type = 'RESPONSE';
          }

          const hasText = !!(text && String(text).trim());
          const hasAttachment = !!(attachment && attachment.url);
          if (!hasText && !hasAttachment) {
            socket.emit('IG_SEND_ERROR', {
              conversation_id,
              error: { error: { message: 'El mensaje no puede estar vacío' } },
              client_tmp_id,
            });
            return;
          }

          let igRes;
          let preview = hasText ? text.trim() : '';

          if (hasAttachment) {
            const type =
              attachment.kind === 'image'
                ? 'image'
                : attachment.kind === 'video'
                ? 'video'
                : 'file';
            igRes = await ig.sendAttachment(
              conv.igsid,
              { type, url: attachment.url },
              pageAccessToken,
              opts
            );
            if (!preview) {
              preview =
                attachment.kind === 'image'
                  ? '📷 Imagen'
                  : attachment.kind === 'video'
                  ? '🎬 Video'
                  : '📎 Archivo';
            }
          } else {
            igRes = await ig.sendText(
              conv.igsid,
              text.trim(),
              pageAccessToken,
              opts
            );
          }

          const mid = igRes?.message_id || igRes?.messages?.[0]?.id || null;

          const saved = await services.IGStore.saveOutgoingMessage({
            id_configuracion: conv.id_configuracion,
            page_id: conv.page_id,
            igsid: conv.igsid,
            text: hasText ? text.trim() : null,
            mid,
            status: 'sent',
            attachments: hasAttachment
              ? [
                  {
                    type: attachment.kind,
                    url: attachment.url,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    storage: 's3',
                  },
                ]
              : null,
            meta: {
              response: igRes,
              source: 'socket',
              agent_id,
              agent_name,
              opts,
              client_tmp_id,
            },
            id_encargado: agent_id || null,
          });

          io.to(`ig:conv:${conversation_id}`).emit('IG_MESSAGE', {
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

          io.to(`ig:cfg:${conv.id_configuracion}`).emit('IG_CONV_UPSERT', {
            id: conversation_id,
            last_message_at: new Date().toISOString(),
            last_outgoing_at: new Date().toISOString(),
            preview,
            unread_count: 0,
          });
        } catch (e) {
          console.error('[IG_SEND][ERROR]', e.response?.data || e.message);
          socket.emit('IG_SEND_ERROR', {
            conversation_id,
            error: e.response?.data || e.message,
            client_tmp_id,
          });
        }
      }
    );
  });
};
