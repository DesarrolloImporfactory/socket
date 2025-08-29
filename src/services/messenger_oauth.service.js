const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../database/config');

const FB_VERSION = 'v22.0';
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;

// Helpers SQL
async function insertOAuthSession({
  id_configuracion,
  state,
  fb_user_id,
  user_token_long,
  expires_at,
}) {
  const [result] = await db.query(
    `INSERT INTO messenger_oauth_sessions (id_configuracion, state, fb_user_id, user_token_long, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        state,
        fb_user_id,
        user_token_long,
        expires_at,
      ],
      type: db.QueryTypes.INSERT,
    }
  );
  return { id_oauth_session: result };
}
async function getSessionById(id) {
  const [row] = await db.query(
    `SELECT * FROM messenger_oauth_sessions WHERE id_oauth_session = ? AND used = 0 AND expires_at > NOW()`,
    { replacements: [id], type: db.QueryTypes.SELECT }
  );
  return row || null;
}
async function markSessionUsed(id) {
  await db.query(
    `UPDATE messenger_oauth_sessions SET used = 1 WHERE id_oauth_session = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE }
  );
}

class MessengerOAuthService {
  static buildLoginUrl({ id_configuracion, redirect_uri }) {
    const scope = [
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_messaging',
      'pages_show_list',
    ].join(',');
    const state = `plat_${id_configuracion}_${crypto
      .randomBytes(8)
      .toString('hex')}`;
    const url = `https://www.facebook.com/${FB_VERSION}/dialog/oauth?client_id=${encodeURIComponent(
      FB_APP_ID
    )}&redirect_uri=${encodeURIComponent(
      redirect_uri
    )}&scope=${encodeURIComponent(
      scope
    )}&response_type=code&state=${encodeURIComponent(
      state
    )}&auth_type=rerequest`;
    return url;
  }

  static async exchangeCodeAndCreateSession({
    code,
    id_configuracion,
    redirect_uri,
  }) {
    // 1) code -> user token corto
    const { data: tokenShort } = await axios.post(
      `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
      new URLSearchParams({
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri,
        code,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    // 2) corto -> user token largo (~60 días)
    const { data: tokenLong } = await axios.post(
      `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: tokenShort.access_token,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const user_token_long = tokenLong.access_token;

    // 3) opcional: quién es el user
    const { data: me } = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me`,
      {
        params: { access_token: user_token_long, fields: 'id,name' },
      }
    );

    // 4) crear sesión temporal (15 min)
    const state = crypto.randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    const session = await insertOAuthSession({
      id_configuracion,
      state,
      fb_user_id: me.id,
      user_token_long,
      expires_at: expires,
    });
    return {
      id_oauth_session: session.id_oauth_session,
      state,
      expires_at: expires.toISOString(),
    };
  }

  static async listPagesFromSession(oauth_session_id) {
    const session = await getSessionById(oauth_session_id);
    if (!session) throw new Error('Sesión OAuth inválida o expirada');

    // /me/accounts trae páginas + tokens de página del usuario
    const { data } = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me/accounts`,
      {
        params: { access_token: session.user_token_long },
      }
    );
    return data.data || [];
  }

  // Para connectPage, necesitamos: page token concreto
  static async getPageTokenFromSession(oauth_session_id, page_id) {
    const pages = await this.listPagesFromSession(oauth_session_id);
    const page = pages.find((p) => String(p.id) === String(page_id));
    if (!page) throw new Error('El usuario no tiene acceso a esa página');
    return { page_access_token: page.access_token, page_name: page.name };
  }

  static async consumeSession(oauth_session_id) {
    await markSessionUsed(oauth_session_id); // opcional (puedes no marcarla usada aquí)
  }
}

module.exports = MessengerOAuthService;
