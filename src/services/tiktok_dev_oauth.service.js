const crypto = require('crypto');
const axios = require('axios');
const { QueryTypes } = require('sequelize');
const { db } = require('../database/config');

class TikTokDevOAuthService {
  static AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
  static TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
  static USERINFO_URL = 'https://open.tiktokapis.com/v2/user/info/';

  /* =========================
   * Utilidades base64url / PKCE
   * ========================= */
  static base64url(buf) {
    return buf
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  static pkceChallengeFromVerifier(verifier) {
    return this.base64url(
      crypto.createHash('sha256').update(verifier).digest()
    );
  }

  static encodeStateJson(obj) {
    const json = JSON.stringify(obj);
    return Buffer.from(json, 'utf8').toString('base64url');
  }

  static decodeStateJson(stateB64url) {
    try {
      const json = Buffer.from(stateB64url, 'base64url').toString('utf8');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /* =========================
   * Persistencia oauth_states
   * ========================= */
  static async saveOauthState({
    provider = 'tiktok',
    nonce,
    id_configuracion,
    redirect_uri,
    code_verifier,
    ttlSeconds = 600,
  }) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await db.query(
      `INSERT INTO oauth_states
         (provider, nonce, id_configuracion, redirect_uri, code_verifier, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         id_configuracion = VALUES(id_configuracion),
         redirect_uri    = VALUES(redirect_uri),
         code_verifier   = VALUES(code_verifier),
         expires_at      = VALUES(expires_at),
         updated_at      = NOW()`,
      {
        replacements: [
          provider,
          nonce,
          id_configuracion,
          redirect_uri,
          code_verifier,
          expiresAt,
        ],
        type: QueryTypes.INSERT,
      }
    );
    return expiresAt;
  }

  static async getOauthState({ provider = 'tiktok', nonce }) {
    const rows = await db.query(
      `SELECT id_configuracion, redirect_uri, code_verifier, expires_at
         FROM oauth_states
        WHERE provider = ? AND nonce = ?
        LIMIT 1`,
      { replacements: [provider, nonce], type: QueryTypes.SELECT }
    );
    return rows?.[0] || null;
  }

  static async deleteOauthState({ provider = 'tiktok', nonce }) {
    await db.query(
      `DELETE FROM oauth_states WHERE provider = ? AND nonce = ?`,
      { replacements: [provider, nonce], type: QueryTypes.DELETE }
    );
  }

  /* =========================
   * Flujo de Login (Developers)
   * ========================= */
  static buildStatePayload({ id_configuracion }) {
    return {
      id_configuracion: Number(id_configuracion),
      nonce: crypto.randomUUID(),
      ts: Date.now(),
    };
  }

  static async buildLoginUrl({
    id_configuracion,
    redirect_uri,
    scopes = ['user.info.basic'],
  }) {
    const client_key = process.env.TIKTOK_CLIENT_KEY;
    if (!client_key) throw new Error('Falta TIKTOK_CLIENT_KEY');

    // state + PKCE
    const statePayload = this.buildStatePayload({ id_configuracion });
    const state = this.encodeStateJson(statePayload);

    const code_verifier = crypto.randomBytes(32).toString('hex');
    const code_challenge = this.pkceChallengeFromVerifier(code_verifier);

    // Persistimos el state/PKCE para validar el exchange luego
    await this.saveOauthState({
      provider: 'tiktok',
      nonce: statePayload.nonce,
      id_configuracion: statePayload.id_configuracion,
      redirect_uri,
      code_verifier,
      ttlSeconds: 900, // 15 minutos
    });

    const params = new URLSearchParams({
      client_key,
      scope: scopes.join(','),
      response_type: 'code',
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method: 'S256',
    });

    return { url: `${this.AUTH_URL}?${params.toString()}`, state };
  }

  static async exchangeCode({ code, state, redirect_uri }) {
    const client_key = process.env.TIKTOK_CLIENT_KEY;
    const client_secret = process.env.TIKTOK_CLIENT_SECRET;
    if (!client_key || !client_secret)
      throw new Error('Faltan credenciales de TikTok Developers');

    // Recuperar nonce e id_configuracion desde el state
    const decoded = this.decodeStateJson(state) || {};
    const nonce = decoded.nonce || null;
    if (!nonce) throw new Error('state inválido');

    const row = await this.getOauthState({ provider: 'tiktok', nonce });
    if (!row) throw new Error('state no encontrado o expirado');

    // Opcional: bloquear expirados
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      // Puede lanzar error si prefiere estrictos
      // throw new Error('state expirado');
      // o continuar por tolerancia (no recomendado)
    }

    const code_verifier = row.code_verifier;

    // Intercambio de token
    const { data } = await axios.post(
      this.TOKEN_URL,
      {
        client_key,
        client_secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri,
        code_verifier,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    // Limpieza del state usado
    await this.deleteOauthState({ provider: 'tiktok', nonce });

    // Inyectamos id_configuracion resuelto para el controller
    return {
      ...data, // { access_token, refresh_token, open_id, scope, token_type, expires_in, ... }
      id_configuracion: row.id_configuracion,
    };
  }

  static async getUserInfo({ access_token }) {
    const fields = ['open_id', 'display_name', 'avatar_url'];
    const { data } = await axios.get(
      `${this.USERINFO_URL}?fields=${fields.join(',')}`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );
    return data?.data || null;
  }

  /* =========================
   * Persistencia de conexión Developers
   * ========================= */
  static async upsertDevelopersConnection({
    id_configuracion,
    open_id,
    access_token,
    refresh_token,
    scope,
    token_type,
    expires_in,
  }) {
    const expiresAt = new Date(Date.now() + (Number(expires_in) || 0) * 1000);

    await db.query(
      `INSERT INTO tiktok_devs_connections
         (id_configuracion, open_id, access_token, refresh_token, scope, token_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         open_id       = VALUES(open_id),
         access_token  = VALUES(access_token),
         refresh_token = VALUES(refresh_token),
         scope         = VALUES(scope),
         token_type    = VALUES(token_type),
         expires_at    = VALUES(expires_at),
         updated_at    = NOW()`,
      {
        replacements: [
          id_configuracion,
          open_id || '',
          access_token || '',
          refresh_token || '',
          scope || null,
          token_type || null,
          expiresAt,
        ],
        type: QueryTypes.INSERT,
      }
    );

    return expiresAt.toISOString();
  }

  /* =========================
   * Desconexión (útil para su DELETE /disconnect)
   * ========================= */
  static async deleteDevelopersConnection({ id_configuracion }) {
    await db.query(
      `DELETE FROM tiktok_devs_connections WHERE id_configuracion = ?`,
      { replacements: [id_configuracion], type: QueryTypes.DELETE }
    );
    return true;
  }
}

module.exports = TikTokDevOAuthService;
