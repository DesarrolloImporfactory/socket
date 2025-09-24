const axios = require('axios');
const { db } = require('../database/config');

const FB_VERSION = 'v23.0';

module.exports = {
  async connect({ oauth_session_id, id_configuracion, page_id }) {
    // 1) sesión
    const sessions = await db.query(
      'SELECT * FROM instagram_oauth_sessions WHERE id_oauth_session = ? AND used = 0 LIMIT 1',
      { replacements: [oauth_session_id], type: db.QueryTypes.SELECT }
    );
    const session = sessions?.[0] || null;
    if (!session) throw new Error('OAuth session no encontrada o ya usada');

    const userToken = session.user_token_long;

    // 2) pages del usuario
    const pagesResp = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me/accounts`,
      {
        params: {
          fields:
            'id,name,access_token,connected_instagram_account{id,username}',
          access_token: userToken,
        },
      }
    );

    const pages = pagesResp.data?.data || [];
    const page = pages.find((p) => String(p.id) === String(page_id));
    if (!page) throw new Error('La página no pertenece al usuario autenticado');

    if (!page.connected_instagram_account?.id) {
      throw new Error(
        `La Página "${page.name}" no tiene una cuenta de Instagram vinculada.

        1) Asegúrate que la cuenta IG es Profesional (Business/Creator).
        2) Vincúlala a esta Página en Instagram app o Business Suite.
        3) Repite el flujo.`
      );
    }

    const pageAccessToken = page.access_token;
    const pageName = page.name;
    const igId = page.connected_instagram_account.id;
    const igUser = page.connected_instagram_account.username;

    // 3) Suscribir app a la Page con campos válidos para IG Messaging
    // Recomendado para IG: messages, messaging_postbacks, message_reactions, message_edit
    const subscribed_fields =
      'messages,messaging_postbacks,message_reactions,message_edits,message_deliveries,message_reads';

    try {
      await axios.post(
        `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
        {}, // body vacío
        {
          params: {
            access_token: pageAccessToken,
            subscribed_fields,
          },
        }
      );
    } catch (err) {
      const g = err?.response?.data?.error;
      console.error('[IG subscribe error]', {
        status: err?.response?.status,
        code: g?.code,
        subcode: g?.error_subcode,
        type: g?.type,
        message: g?.message,
      });
      throw new Error(
        `No se pudo suscribir la Página a la app. ${g?.message || 'Error 400'}`
      );
    }

    // 3.1) Verificar estado de suscripción (como en Messenger)
    const { data: status } = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/${page_id}/subscribed_apps`,
      { params: { access_token: pageAccessToken } }
    );

    // 4) Upsert en instagram_pages
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
    await db.query(upsertSQL, {
      replacements: [
        id_configuracion,
        page_id,
        pageName,
        pageAccessToken,
        igId,
        igUser,
        session.fb_user_id || null,
        session.fb_user_name || null,
      ],
      type: db.QueryTypes.INSERT,
    });

    // 5) Consumir sesión
    await db.query(
      'UPDATE instagram_oauth_sessions SET used = 1 WHERE id_oauth_session = ?',
      { replacements: [oauth_session_id], type: db.QueryTypes.UPDATE }
    );

    return {
      page_id,
      page_name: pageName,
      ig_id: igId,
      ig_username: igUser,
      connected: true,
      subscribed_apps: status?.data || [], //Verificamos si suscribimos a la page
    };
  },
};
