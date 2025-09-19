const qs = require('querystring');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../database/config');

/** helpers */
function signStatePayload(payload) {
  const json = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', process.env.FB_APP_SECRET);
  hmac.update(json);
  const s = hmac.digest('hex');
  return Buffer.from(JSON.stringify({ p: json, s })).toString('base64url');
}

module.exports = {
  buildLoginUrl({ id_configuracion, redirect_uri, config_id }) {
    const scope = [
      'pages_show_list',
      'pages_manage_metadata',
      'pages_read_engagement',
      'instagram_basic',
      'instagram_manage_messages',
    ].join(',');

    const state = signStatePayload({
      id_configuracion: String(id_configuracion),
      config_id: config_id ? String(config_id) : null,
      t: Date.now(),
    });

    const params = {
      client_id: process.env.FB_APP_ID,
      redirect_uri,
      response_type: 'code',
      scope,
      state,
    };

    return (
      'https://www.facebook.com/v21.0/dialog/oauth?' + qs.stringify(params)
    );
  },

  async exchangeCodeAndCreateSession({ code, id_configuracion, redirect_uri }) {
    // 1) code -> short-lived user token
    const shortRes = await axios.get(
      'https://graph.facebook.com/v21.0/oauth/access_token',
      {
        params: {
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          redirect_uri,
          code,
        },
      }
    );
    const shortUserToken = shortRes.data.access_token;

    // 2) short -> long-lived
    const longRes = await axios.get(
      'https://graph.facebook.com/v21.0/oauth/access_token',
      {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          fb_exchange_token: shortUserToken,
        },
      }
    );
    const userLongToken = longRes.data.access_token;
    const expiresIn = Number(longRes.data.expires_in || 60 * 24 * 3600);

    // 3) enriquecer con /me
    const meRes = await axios.get('https://graph.facebook.com/v21.0/me', {
      params: { fields: 'id,name', access_token: userLongToken },
    });
    const fbUserId = meRes.data?.id || null;
    const fbUserName = meRes.data?.name || null;

    // 4) insertar sesión
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const state = crypto.randomBytes(12).toString('hex');

    const insertSQL = `
      INSERT INTO instagram_oauth_sessions
        (id_configuracion, state, fb_user_id, fb_user_name, user_token_long, created_at, expires_at, used)
      VALUES (?, ?, ?, ?, ?, NOW(), ?, 0)
    `;
    const params = [
      id_configuracion,
      state,
      fbUserId,
      fbUserName,
      userLongToken,
      expiresAt,
    ];
    const [result] = await db.query(insertSQL, params);

    return {
      id_oauth_session: result.insertId,
      id_configuracion,
      state,
      fb_user_id: fbUserId,
      fb_user_name: fbUserName,
      expires_at: expiresAt,
    };
  },

  async listPagesFromSession(oauth_session_id) {
    const [rows] = await db.query(
      'SELECT * FROM instagram_oauth_sessions WHERE id_oauth_session = ? AND used = 0 LIMIT 1',
      [oauth_session_id]
    );
    if (!rows.length) throw new Error('OAuth session no encontrada o ya usada');

    const session = rows[0];
    const token = session.user_token_long;

    const resp = await axios.get(
      'https://graph.facebook.com/v21.0/me/accounts',
      {
        params: {
          fields:
            'id,name,access_token,connected_instagram_account{id,username}',
          access_token: token,
        },
      }
    );

    return resp.data?.data || [];
  },
};
