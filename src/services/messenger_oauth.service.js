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
  static buildLoginUrl({ id_configuracion, redirect_uri, config_id }) {
    // incluye el id_configuracion en el state
    const state = `cfg_${id_configuracion}_${crypto
      .randomBytes(8)
      .toString('hex')}`;
    const base = `https://www.facebook.com/${FB_VERSION}/dialog/oauth`;

    if (config_id) {
      console.log(
        `[FB_CONNECT] 1/5 login-url · cfg=${id_configuracion} · ` +
          `Login for Business config_id=${config_id} · redirect=${redirect_uri}`,
      );
      // ✅ Facebook Login for Business (usa config_id, NO scope)
      return `${base}?client_id=${encodeURIComponent(
        FB_APP_ID
      )}&redirect_uri=${encodeURIComponent(
        redirect_uri
      )}&config_id=${encodeURIComponent(
        config_id
      )}&response_type=code&override_default_response_type=true&state=${encodeURIComponent(
        state
      )}`;
    }

    console.warn(
      `[FB_CONNECT] 1/5 login-url · cfg=${id_configuracion} · ` +
        `SIN config_id → login clásico. Los permisos saldrán de la lista de ` +
        `abajo, NO de la configuración de Business Login del App Dashboard.`,
    );

    // (fallback) Login “clásico” con scope – por si algún día se requiere.
    //
    // Ojo: con Facebook Login for Business (la rama de arriba, la que se usa
    // hoy) esta lista NO se aplica. Los permisos salen de la configuración
    // `config_id` en el App Dashboard de Meta y `scope` se ignora. Si hace
    // falta agregar un permiso al flujo real, se agrega allá, no acá.
    const scope = [
      'pages_show_list',
      'pages_messaging',
      'pages_manage_metadata',
      // Comentarios: leer el autor de cada comentario y poder responderlos.
      // pages_manage_engagement necesita Advanced Access (App Review) para
      // usuarios normales; con una cuenta admin/dev/tester de la app funciona
      // en modo desarrollo sin esperar la revisión.
      'pages_read_engagement',
      'pages_manage_engagement',
    ].join(',');
    return `${base}?client_id=${encodeURIComponent(
      FB_APP_ID
    )}&redirect_uri=${encodeURIComponent(
      redirect_uri
    )}&scope=${encodeURIComponent(
      scope
    )}&response_type=code&state=${encodeURIComponent(
      state
    )}&auth_type=rerequest`;
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

    // 3.b) Qué permisos otorgó (y cuáles rechazó) el usuario.
    //
    // Es lo primero que hay que mirar cuando "se conectó pero no funciona":
    // Meta deja que el usuario destilde permisos en la pantalla de consentimiento
    // y la conexión igual se completa. Los rechazados no aparecen en ningún
    // error, sólo acá. Nunca lanza: es diagnóstico, no parte del flujo.
    try {
      const { data: permisos } = await axios.get(
        `https://graph.facebook.com/${FB_VERSION}/me/permissions`,
        { params: { access_token: user_token_long } },
      );
      const otorgados = (permisos.data || [])
        .filter((p) => p.status === 'granted')
        .map((p) => p.permission);
      const rechazados = (permisos.data || [])
        .filter((p) => p.status !== 'granted')
        .map((p) => p.permission);

      console.log(
        `[FB_CONNECT] 2/5 token OK · usuario="${me.name}" (${me.id}) · cfg=${id_configuracion}`,
      );
      console.log(`[FB_CONNECT]     otorgados : ${otorgados.join(', ') || '(ninguno)'}`);
      if (rechazados.length) {
        console.warn(`[FB_CONNECT]     RECHAZADOS: ${rechazados.join(', ')}`);
      }
      // Los tres que decide si el módulo de comentarios va a servir.
      for (const p of [
        'pages_messaging',
        'pages_read_engagement',
        'pages_manage_engagement',
      ]) {
        console.log(
          `[FB_CONNECT]     ${otorgados.includes(p) ? '✅' : '❌'} ${p}`,
        );
      }
    } catch (err) {
      console.warn(
        '[FB_CONNECT] no se pudieron leer los permisos:',
        err.response?.data?.error?.message || err.message,
      );
    }

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

    // /me/accounts trae páginas + tokens de página del usuario.
    // Requiere pages_show_list: sin ese permiso Meta responde error y, como el
    // manejador global no loguea, el flujo moría en silencio justo acá.
    let data;
    try {
      ({ data } = await axios.get(
        `https://graph.facebook.com/${FB_VERSION}/me/accounts`,
        {
          params: { access_token: session.user_token_long },
        }
      ));
    } catch (err) {
      const meta = err.response?.data?.error;
      console.error(
        `[FB_CONNECT][ERROR] 3/5 no se pudieron listar las páginas · ` +
          `cfg=${session.id_configuracion} · ` +
          (meta
            ? `Meta code=${meta.code}: ${meta.message}`
            : err.message) +
          ` — casi siempre falta pages_show_list en la configuración de login`,
      );
      throw err;
    }
    const paginas = data.data || [];
    // Sólo id y nombre: /me/accounts devuelve el access_token de cada página
    // y eso no debe terminar nunca en un log.
    console.log(
      `[FB_CONNECT] 3/5 páginas del usuario: ${paginas.length} · ` +
        (paginas.map((p) => `"${p.name}" (${p.id})`).join(', ') || '(ninguna)'),
    );
    if (!paginas.length) {
      console.warn(
        '[FB_CONNECT]     sin páginas: falta pages_show_list, o el usuario no ' +
          'tiene rol de admin/editor en ninguna página',
      );
    }
    return paginas;
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
