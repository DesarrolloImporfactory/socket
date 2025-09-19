// services/instagram_connect.service.js
const axios = require('axios');
const { db } = require('../database/config');

module.exports = {
  /**
   * Conecta una Page (con IG) a un id_configuracion:
   * - Lee session → user_long_token
   * - Busca la page
   * - Suscribe webhooks
   * - Persiste (upsert) en instagram_pages
   */
  async connect({ oauth_session_id, id_configuracion, page_id }) {
    // 1) sesión
    const [[session]] = await db.query(
      'SELECT * FROM instagram_oauth_sessions WHERE id_oauth_session = ? AND used = 0 LIMIT 1',
      [oauth_session_id]
    );
    if (!session) throw new Error('OAuth session no encontrada o ya usada');

    const userToken = session.user_token_long;

    // 2) obtener pages del usuario
    const pagesResp = await axios.get(
      'https://graph.facebook.com/v21.0/me/accounts',
      {
        params: {
          fields:
            'id,name,access_token,connected_instagram_account{id,username}',
          access_token: userToken,
        },
      }
    );

    const pages = pagesResp.data?.data || [];
    const page = pages.find((p) => p.id === String(page_id));
    if (!page) throw new Error('La página no pertenece al usuario autenticado');

    if (!page.connected_instagram_account?.id) {
      throw new Error('La página no tiene una cuenta de Instagram conectada');
    }

    const pageAccessToken = page.access_token;
    const pageName = page.name;
    const igId = page.connected_instagram_account.id;
    const igUser = page.connected_instagram_account.username;

    // 3) suscribir app a la page
    await axios.post(
      `https://graph.facebook.com/v21.0/${page_id}/subscribed_apps`,
      null,
      { params: { access_token: pageAccessToken } }
    );

    // 4) upsert en instagram_pages
    const upsertSQL = `
      INSERT INTO instagram_pages
        (id_configuracion, page_id, page_name, page_access_token, ig_id, ig_username, subscribed,
         connected_by_fb_user_id, connected_by_name, status, connected_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', NOW())
      ON DUPLICATE KEY UPDATE
        page_name = VALUES(page_name),
        page_access_token = VALUES(page_access_token),
        ig_id = VALUES(ig_id),
        ig_username = VALUES(ig_username),
        subscribed = 1,
        connected_by_fb_user_id = VALUES(connected_by_fb_user_id),
        connected_by_name = VALUES(connected_by_name),
        status = 'active',
        updated_at = NOW()
    `;
    await db.query(upsertSQL, [
      id_configuracion,
      page_id,
      pageName,
      pageAccessToken,
      igId,
      igUser,
      session.fb_user_id || null,
      session.fb_user_name || null,
    ]);

    // 5) marcar sesión como usada (opcional)
    await db.query(
      'UPDATE instagram_oauth_sessions SET used = 1 WHERE id_oauth_session = ?',
      [oauth_session_id]
    );

    return {
      page_id,
      page_name: pageName,
      ig_id: igId,
      ig_username: igUser,
      connected: true,
    };
  },
};
