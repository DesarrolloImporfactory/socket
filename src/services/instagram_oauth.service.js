const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../database/config');

const FB_VERSION = 'v22.0';
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;

/* ─────────────────────────────── Helpers SQL ─────────────────────────────── */
async function insertOAuthSession({
  id_configuracion,
  state,
  fb_user_id,
  fb_user_name,
  user_token_long,
  expires_at,
}) {
  // created_at y used tienen DEFAULT en tu tabla, así que no hace falta setearlos
  const [insertId] = await db.query(
    `INSERT INTO instagram_oauth_sessions 
      (id_configuracion, state, fb_user_id, fb_user_name, user_token_long, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        state,
        fb_user_id,
        fb_user_name,
        user_token_long,
        expires_at,
      ],
      type: db.QueryTypes.INSERT,
    }
  );
  return { id_oauth_session: insertId };
}

async function getSessionById(id) {
  const rows = await db.query(
    `SELECT * 
       FROM instagram_oauth_sessions 
      WHERE id_oauth_session = ? 
        AND used = 0 
        AND expires_at > NOW()
      LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT }
  );
  return rows?.[0] || null;
}

async function markSessionUsed(id) {
  await db.query(
    `UPDATE instagram_oauth_sessions 
        SET used = 1 
      WHERE id_oauth_session = ?`,
    { replacements: [id], type: db.QueryTypes.UPDATE }
  );
}

/* ─────────────────────────────── Servicio IG OAuth ─────────────────────────────── */
class InstagramOAuthService {
  /**
   * Construye la URL de login con Facebook para obtener permisos de Instagram.
   * NOTA: Para IG usamos scopes (no config_id). Si te pasan config_id, lo ignoramos aquí.
   */
  static buildLoginUrl({ id_configuracion, redirect_uri /*, config_id*/ }) {
    const state = `cfg_${id_configuracion}_${crypto
      .randomBytes(8)
      .toString('hex')}`;

    const scope = [
      'pages_show_list',
      'pages_manage_metadata',
      'pages_read_engagement',
      'instagram_basic',
      'instagram_manage_messages',
    ].join(',');

    const base = `https://www.facebook.com/${FB_VERSION}/dialog/oauth`;
    const url =
      `${base}?client_id=${encodeURIComponent(FB_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&response_type=code` +
      `&state=${encodeURIComponent(state)}` +
      `&auth_type=rerequest`;

    return url;
  }

  /**
   * Intercambia el "code" por user token corto → largo y crea una sesión OAuth temporal.
   * Devuelve: { id_oauth_session, state, expires_at }
   */
  static async exchangeCodeAndCreateSession({
    code,
    id_configuracion,
    redirect_uri,
  }) {
    // 1) code -> user token corto (POST x-www-form-urlencoded)
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
    const expiresIn = Number(tokenLong.expires_in || 60 * 24 * 3600);

    // 3) enriquecer con /me (id y nombre del usuario que concede permisos)
    const { data: me } = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me`,
      { params: { access_token: user_token_long, fields: 'id,name' } }
    );

    // 4) crear sesión temporal (p. ej. 15 min para completar el flujo)
    const state = crypto.randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    const session = await insertOAuthSession({
      id_configuracion,
      state,
      fb_user_id: me?.id || null,
      fb_user_name: me?.name || null,
      user_token_long,
      expires_at: expires,
    });

    return {
      id_oauth_session: session.id_oauth_session,
      state,
      expires_at: expires.toISOString(),
    };
  }

  /**
   * Devuelve las páginas a las que el usuario tiene acceso,
   * incluyendo el `connected_instagram_account` si existe.
   */
  static async listPagesFromSession(oauth_session_id) {
    const session = await getSessionById(oauth_session_id);
    if (!session) throw new Error('Sesión OAuth inválida o expirada');

    const { data } = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me/accounts`,
      {
        params: {
          access_token: session.user_token_long,
          fields:
            'id,name,access_token,connected_instagram_account{id,username}',
        },
      }
    );

    return data?.data || [];
  }

  /**
   * Obtiene el page token + datos IG de una página concreta desde la sesión.
   * Útil para /facebook/connect.
   */
  static async getPageTokenFromSession(oauth_session_id, page_id) {
    const pages = await this.listPagesFromSession(oauth_session_id);
    const page = pages.find((p) => String(p.id) === String(page_id));
    if (!page) throw new Error('El usuario no tiene acceso a esa página');

    const ig = page.connected_instagram_account || null;
    return {
      page_access_token: page.access_token,
      page_name: page.name,
      ig_id: ig?.id || null,
      ig_username: ig?.username || null,
    };
  }

  /**
   * Marca la sesión como usada (si quieres invalidarla tras conectar).
   */
  static async consumeSession(oauth_session_id) {
    await markSessionUsed(oauth_session_id);
  }
}

module.exports = InstagramOAuthService;
