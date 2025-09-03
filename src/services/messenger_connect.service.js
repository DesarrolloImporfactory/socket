const axios = require('axios');
const { db } = require('../database/config');
const MessengerOAuthService = require('./messenger_oauth.service');

const FB_VERSION = 'v22.0';

// Helpers
async function upsertMessengerPage({
  id_configuracion,
  page_id,
  page_name,
  page_access_token,
  subscribed,
  fb_user_id,
}) {
  const [existing] = await db.query(
    `SELECT id_messenger_page FROM messenger_pages WHERE id_configuracion = ? AND page_id = ?`,
    { replacements: [id_configuracion, page_id], type: db.QueryTypes.SELECT }
  );

  if (existing) {
    await db.query(
      `UPDATE messenger_pages
       SET page_name = ?, page_access_token = ?, subscribed = ?, connected_by_fb_user_id = ?, status='active', updated_at=NOW()
       WHERE id_messenger_page = ?`,
      {
        replacements: [
          page_name,
          page_access_token,
          subscribed ? 1 : 0,
          fb_user_id || null,
          existing.id_messenger_page,
        ],
        type: db.QueryTypes.UPDATE,
      }
    );
    return existing.id_messenger_page;
  } else {
    const [insertId] = await db.query(
      `INSERT INTO messenger_pages (id_configuracion, page_id, page_name, page_access_token, subscribed, connected_by_fb_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
      {
        replacements: [
          id_configuracion,
          page_id,
          page_name,
          page_access_token,
          subscribed ? 1 : 0,
          fb_user_id || null,
        ],
        type: db.QueryTypes.INSERT,
      }
    );
    return insertId;
  }
}

class MessengerConnectService {
  // Conecta (suscribe) una página usando la sesión OAuth del usuario
  static async connect({ oauth_session_id, id_configuracion, page_id }) {
    // 1) obtener page token a partir de la sesión
    const { page_access_token, page_name } =
      await MessengerOAuthService.getPageTokenFromSession(
        oauth_session_id,
        page_id
      );

    console.log('[CONNECT][START]', { page_id, page_name });

    // 2) Suscribir app a la página (pasando params, más claro para el reviewer)
    const subscribed_fields =
      'messages,messaging_postbacks,message_deliveries,message_reads';
    console.log('[SUBSCRIBE][REQUEST]', {
      endpoint: `/${page_id}/subscribed_apps`,
      subscribed_fields,
    });

    const subRes = await axios.post(
      `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
      {}, // cuerpo vacío
      {
        params: {
          access_token: page_access_token,
          subscribed_fields, // como query param
        },
      }
    );
    console.log('[SUBSCRIBE][RESPONSE]', subRes.data);

    // 3) Verificar suscripción (esto es lo que quieres devolver al front)
    const { data: status } = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
      { params: { access_token: page_access_token } }
    );
    console.log('[SUBSCRIBE_STATUS]', JSON.stringify(status));

    // 4) guardar en DB
    const session = await db
      .query(
        `SELECT fb_user_id FROM messenger_oauth_sessions WHERE id_oauth_session = ?`,
        { replacements: [oauth_session_id], type: db.QueryTypes.SELECT }
      )
      .then((r) => r[0] || null);

    const id_messenger_page = await upsertMessengerPage({
      id_configuracion,
      page_id,
      page_name,
      page_access_token,
      subscribed: true,
      fb_user_id: session?.fb_user_id || null,
    });

    // 5) opcional: marcar sesión usada
    await MessengerOAuthService.consumeSession(oauth_session_id);

    console.log('[CONNECT][DONE]', { page_id, page_name, id_messenger_page });

    // 🔎 Devolvemos el estado de suscripción para que el front lo muestre en el Network
    return {
      id_messenger_page,
      page_id,
      page_name,
      subscribed: true,
      subscribed_apps: status?.data || [],
    };
  }
}

module.exports = MessengerConnectService;
