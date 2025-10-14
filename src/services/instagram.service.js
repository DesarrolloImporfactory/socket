/**
 * Instagram Service
 * -----------------
 * - Enruta eventos de IG (webhook) y emite a Socket.IO.
 * - Persiste ENTRANTES (in) y ECOS (out) SIN duplicar.
 * - NO marca "visto" automáticamente; expone eventos socket para:
 *   * IG_MARK_SEEN  → mark_seen + markRead cuando el asesor abre el chat.
 *   * IG_TYPING     → typing_on/off mientras el asesor teclea.
 *
 * Requiere:
 *   - Constraint UNIQUE para evitar duplicados en instagram_messages (p.ej. UNIQUE (conversation_id, direction, mid))
 */

const ig = require('../utils/instagramGraph');
const { db } = require('../database/config');
const Store = require('./instagram_store.service');

let IO = null;
const roomConv = (conversation_id) => `ig:conv:${conversation_id}`;
const roomCfg = (id_configuracion) => `ig:cfg:${id_configuracion}`;

/* =============================
   Helpers de acceso a página
============================= */

/** Devuelve fila de la página por IG Business ID (sender/recipient en IG) */
async function getPageRowByIgId(ig_id) {
  const [row] = await db.query(
    `SELECT id_configuracion, page_id, page_access_token
       FROM instagram_pages
      WHERE ig_id = ?
        AND status = 'active'
      LIMIT 1`,
    { replacements: [ig_id], type: db.QueryTypes.SELECT }
  );
  return row || null;
}

/* =============================
   Normalizadores / utilidades
============================= */

const safeMsgId = (dbId, mid) =>
  dbId || mid || `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function normalizeAttachments(msg) {
  const atts = msg?.attachments;
  if (!Array.isArray(atts) || !atts.length) return null;

  return atts.map((a) => {
    const p = a?.payload || {};
    return {
      type: a?.type || null, // "image" | "audio" | "video" | "file" | "location" | "sticker"...
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

/* =============================
   Servicio principal
============================= */
class InstagramService {
  /** Inicializa IO y registra listeners de socket de alto nivel */
  static setIO(io) {
    IO = io;

    io.on('connection', (socket) => {
      // 1) “Escribiendo…” controlado por el asesor
      socket.on('IG_TYPING', async ({ conversation_id, on }) => {
        try {
          const conv = await Store.getConversationById(conversation_id);
          if (!conv) return;

          const [pageRow] = await db.query(
            `SELECT page_access_token FROM instagram_pages
              WHERE page_id=? AND status='active' LIMIT 1`,
            { replacements: [conv.page_id], type: db.QueryTypes.SELECT }
          );
          const pat = pageRow?.page_access_token;
          if (!pat) return;

          await ig.sendSenderAction(
            conv.igsid,
            on ? 'typing_on' : 'typing_off',
            pat
          );
        } catch (e) {
          console.warn('[IG_TYPING][WARN]', e.response?.data || e.message);
        }
      });

      // 2) Marcar visto solo cuando el asesor abre el chat (no en webhook)
      socket.on('IG_MARK_SEEN', async ({ conversation_id }) => {
        try {
          const conv = await Store.getConversationById(conversation_id);
          if (!conv) return;

          const [pageRow] = await db.query(
            `SELECT page_access_token FROM instagram_pages
              WHERE page_id=? AND status='active' LIMIT 1`,
            { replacements: [conv.page_id], type: db.QueryTypes.SELECT }
          );
          const pat = pageRow?.page_access_token;
          if (!pat) return;

          // mark_seen hacia IG + reset de unread_count en BD
          await ig.sendSenderAction(conv.igsid, 'mark_seen', pat);
          await Store.markRead({
            id_configuracion: conv.id_configuracion,
            page_id: conv.page_id,
            igsid: conv.igsid,
          });

          // opcional: notificar a paneles (sidebar) que se limpió el contador
          io.to(roomCfg(conv.id_configuracion)).emit('IG_READ', {
            page_id: conv.page_id,
            igsid: conv.igsid,
          });
        } catch (e) {
          console.warn('[IG_MARK_SEEN][WARN]', e.response?.data || e.message);
        }
      });
    });
  }

  /**
   * Router de eventos Instagram (webhook object='instagram' via Page)
   * - Heurística de IG:
   *   * Entrante (usuario→negocio): sender.id = IGSID usuario | recipient.id = IG Business ID
   *   * Eco (negocio→usuario):      sender.id = IG Business ID | recipient.id = IGSID usuario
   */
  static async routeEvent(event) {
    const isEcho = event.message?.is_echo === true;
    const businessId = isEcho ? event.sender?.id : event.recipient?.id; // IG Business ID
    const userIgsid = isEcho ? event.recipient?.id : event.sender?.id; // IGSID del cliente

    if (!businessId) {
      console.warn(
        '[IG ROUTE_EVENT] IG Business ID ausente (sender/recipient)'
      );
      return;
    }

    const pageRow = await getPageRowByIgId(businessId);
    if (!pageRow) {
      console.warn(
        '[IG ROUTE_EVENT] IG Business no registrado en BD:',
        businessId
      );
      return;
    }

    const {
      id_configuracion,
      page_id: pageId,
      page_access_token: pageAccessToken,
    } = pageRow;
    const mid = event.message?.mid || event.postback?.mid || null;
    const text = event.message?.text || null;

    console.log('[IG ROUTE_EVENT][IN]', {
      businessId,
      pageId,
      igsid: userIgsid,
      mid,
      text: text || '(no-text)',
      hasDelivery: !!event.delivery,
      hasRead: !!event.read,
      hasPostback: !!event.postback,
      isEcho,
    });

    // 1) ECO → guardar como SALIENTE (out) y emitir a UI
    if (isEcho && event.message) {
      await this.handleEchoAsOutgoing({
        id_configuracion,
        pageId,
        userIgsid,
        message: event.message,
      });
      return;
    }

    // 2) ENTRANTE (usuario → negocio)
    if (event.message) {
      if (!userIgsid) return;
      if (!pageAccessToken) {
        console.warn('[IG] No page_access_token para pageId', pageId);
        return;
      }
      await this.handleMessage(
        userIgsid,
        event.message,
        pageAccessToken,
        pageId,
        id_configuracion
      );
      return;
    }

    // 3) Postbacks: opcional. Déjalo si lo usas; si no, puedes eliminar este bloque.
    if (event.postback) {
      if (!pageAccessToken) return;
      await this.handlePostback(
        userIgsid,
        event.postback,
        pageAccessToken,
        pageId,
        id_configuracion
      );
      return;
    }

    // 4) Lecturas (IG puede enviar “read”, pero NO marcaremos visto aquí)
    if (event.read) {
      // Si quisieras reflejar “cliente leyó”, emitirías un evento; de momento ignoramos.
      return;
    }

    // 5) Delivery (placeholder)
    if (event.delivery) {
      return;
    }
  }

  /** Persiste ENTRANTE y emite a sockets. (Sin mark_seen automático) */
  static async handleMessage(
    igsid,
    message,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    const createdAtNow = new Date().toISOString();
    const normalizedAttachments = normalizeAttachments(message);
    const text = message.text || null;
    const mid = message.mid || null;

    let savedIn = null;
    try {
      savedIn = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        igsid,
        text,
        attachments: normalizedAttachments,
        mid,
        meta: { raw: message },
      });

      // Enriquecer perfil si falta
      try {
        const [conv] = await db.query(
          `SELECT id, customer_name, profile_pic_url
             FROM instagram_conversations
            WHERE id_configuracion=? AND page_id=? AND igsid=? LIMIT 1`,
          {
            replacements: [id_configuracion, pageId, igsid],
            type: db.QueryTypes.SELECT,
          }
        );

        if (conv && (!conv.customer_name || !conv.profile_pic_url)) {
          const profile = await ig.getUserProfile(igsid, pageAccessToken);
          if (profile) {
            await db.query(
              `UPDATE instagram_conversations
                  SET customer_name   = COALESCE(?, customer_name),
                      profile_pic_url = COALESCE(?, profile_pic_url),
                      updated_at      = NOW()
                WHERE id = ?`,
              {
                replacements: [
                  profile.name || null,
                  profile.profile_pic || null,
                  conv.id,
                ],
              }
            );
          }
        }
      } catch (e) {
        console.warn(
          '[IG PROFILE ENRICH][WARN]',
          e.response?.data || e.message
        );
      }

      if (IO && savedIn?.conversation_id) {
        IO.to(roomConv(savedIn.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: savedIn.conversation_id,
          message: {
            id: safeMsgId(savedIn.message_id, mid),
            direction: 'in',
            mid,
            text,
            attachments: normalizedAttachments,
            status: 'received',
            created_at: createdAtNow,
            is_unsupported: Boolean(message?.is_unsupported),
          },
        });

        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: savedIn.conversation_id,
          last_message_at: createdAtNow,
          last_incoming_at: createdAtNow,
          preview: text || '(adjunto)',
        });
      }
    } catch (e) {
      console.error('[IG STORE][INCOMING][ERROR]', e.message);
    }

    // IMPORTANTE:
    // Ya NO hacemos mark_seen ni typing_off aquí. Eso se hará por sockets:
    // - IG_MARK_SEEN cuando el asesor abre el chat
    // - IG_TYPING (on/off) mientras el asesor escribe
  }

  /** Guarda ECO (negocio → usuario) como SALIENTE y emite con client_tmp_id (si existe) */
  static async handleEchoAsOutgoing({
    id_configuracion,
    pageId,
    userIgsid,
    message,
  }) {
    const createdAtNow = new Date().toISOString();
    const normalizedAttachments = normalizeAttachments(message);
    const text = message.text || null;
    const mid = message.mid || null;

    try {
      const outSave = await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        igsid: userIgsid,
        text,
        attachments: normalizedAttachments,
        mid,
        status: 'sent',
        meta: { raw: message, via: 'echo' }, // meta se fusionará si ya existía
      });

      // Intentar recuperar client_tmp_id que guardaste al ENVIAR (siempre que insertaras meta con ese dato)
      const existing = await Store.findOutgoingByMid({
        conversation_id: outSave.conversation_id,
        mid,
      });

      let clientTmpId = null;
      try {
        const meta = existing?.meta && JSON.parse(existing.meta);
        clientTmpId = meta?.client_tmp_id || meta?.opts?.client_tmp_id || null;
      } catch {}

      if (IO && outSave?.conversation_id) {
        IO.to(roomConv(outSave.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: outSave.conversation_id,
          message: {
            id: safeMsgId(outSave?.message_id, mid),
            direction: 'out',
            mid,
            text,
            attachments: normalizedAttachments,
            status: 'sent',
            created_at: createdAtNow,
            client_tmp_id: clientTmpId, // permite al front sustituir el optimista por el real
          },
        });

        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: outSave.conversation_id,
          last_message_at: createdAtNow,
          last_outgoing_at: createdAtNow,
          preview: text || '(adjunto)',
          unread_count: 0,
        });
      }
    } catch (e) {
      console.error('[IG STORE][OUTGOING_ECHO][ERROR]', e.message);
    }
  }

  /**
   * Opcional para botones con respuest rapidaa.
   */
  static async handlePostback(
    igsid,
    postback,
    pageAccessToken,
    pageId,
    id_configuracion
  ) {
    const payload = postback.payload || '';
    const createdAtNow = new Date().toISOString();

    let savedIn = null;
    try {
      savedIn = await Store.saveIncomingMessage({
        id_configuracion,
        page_id: pageId,
        igsid,
        text: null,
        attachments: null,
        mid: postback.mid || null,
        meta: { raw: postback, postback_payload: payload },
      });

      if (IO && savedIn?.conversation_id) {
        IO.to(roomConv(savedIn.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: savedIn.conversation_id,
          message: {
            id: safeMsgId(savedIn.message_id, postback.mid),
            direction: 'in',
            mid: postback.mid || null,
            text: `Postback: ${payload}`,
            status: 'received',
            created_at: createdAtNow,
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: savedIn.conversation_id,
          last_message_at: createdAtNow,
          last_incoming_at: createdAtNow,
          preview: `Postback: ${payload}`,
        });
      }
    } catch (e) {
      console.error('[IG STORE][INCOMING_POSTBACK][ERROR]', e.message);
    }

    // Auto-respuesta opcional
    try {
      const res = await ig.sendText(
        igsid,
        `Postback: ${payload}`,
        pageAccessToken
      );
      const outSave = await Store.saveOutgoingMessage({
        id_configuracion,
        page_id: pageId,
        igsid,
        text: `Postback: ${payload}`,
        mid: res?.message_id || null,
        status: 'sent',
        meta: { response: res },
      });

      if (IO && savedIn?.conversation_id) {
        IO.to(roomConv(savedIn.conversation_id)).emit('IG_MESSAGE', {
          conversation_id: savedIn.conversation_id,
          message: {
            id: safeMsgId(outSave?.message_id, res?.message_id),
            direction: 'out',
            mid: res?.message_id || null,
            text: `Postback: ${payload}`,
            status: 'sent',
            created_at: new Date().toISOString(),
          },
        });
        IO.to(roomCfg(id_configuracion)).emit('IG_CONV_UPSERT', {
          id: savedIn.conversation_id,
          last_message_at: new Date().toISOString(),
          last_outgoing_at: new Date().toISOString(),
          preview: `Postback: ${payload}`,
          unread_count: 0,
        });
      }
    } catch (e) {
      console.error(
        '[IG SEND/STORE][OUTGOING_POSTBACK][ERROR]',
        e.response?.data || e.message
      );
      try {
        await Store.saveOutgoingMessage({
          id_configuracion,
          page_id: pageId,
          igsid,
          text: `Postback: ${payload}`,
          status: 'failed',
          meta: { error: e.response?.data || e.message },
        });
      } catch (_) {}
    }
  }
}

// === Helpers Importantes
async function getPageTokenByPageId(page_id) {
  const [row] = await db.query(
    `SELECT page_access_token
       FROM instagram_pages
      WHERE page_id=? AND status='active'
      LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.page_access_token || null;
}

async function getConfigIdByPageId(page_id) {
  const [row] = await db.query(
    `SELECT id_configuracion
       FROM instagram_pages
      WHERE page_id=? AND status='active'
      LIMIT 1`,
    { replacements: [page_id], type: db.QueryTypes.SELECT }
  );
  return row?.id_configuracion || null;
}

module.exports = InstagramService;
module.exports.getPageRowByIgId = getPageRowByIgId;
module.exports.getPageTokenByPageId = getPageTokenByPageId; // 👈 nuevo
module.exports.getConfigIdByPageId = getConfigIdByPageId; // 👈 nuevo
