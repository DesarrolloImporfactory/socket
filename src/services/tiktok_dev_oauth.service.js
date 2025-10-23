const crypto = require('crypto');
const axios = require('axios');

const verifierStore = new Map();

class TikTokDevOAuthService {
  static AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
  static TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
  static USERINFO_URL = 'https://open.tiktokapis.com/v2/user/info/';

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

  static buildState({ id_configuracion }) {
    const payload = {
      id_configuracion,
      nonce: crypto.randomUUID(),
      ts: Date.now(),
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  static buildLoginUrl({
    id_configuracion,
    redirect_uri,
    scopes = ['user.info.basic'],
  }) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) throw new Error('Falta TIKTOK_CLIENT_KEY');

    const state = this.buildState({ id_configuracion });
    const code_verifier = crypto.randomBytes(32).toString('hex');
    const code_challenge = this.pkceChallengeFromVerifier(code_verifier);

    verifierStore.set(state, { code_verifier, createdAt: Date.now() }); // TTL manual si quieres

    const params = new URLSearchParams({
      client_key: clientKey,
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

    const saved = verifierStore.get(state);
    if (!saved) throw new Error('state inválido o expirado');
    verifierStore.delete(state);

    const { code_verifier } = saved;

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

    // data: { access_token, refresh_token, open_id, scope, expires_in, ... }
    return data;
  }

  static async getUserInfo({ access_token }) {
    // Campos típicos disponibles con user.info.basic
    const fields = ['open_id', 'display_name', 'avatar_url'];
    const { data } = await axios.get(
      `${this.USERINFO_URL}?fields=${fields.join(',')}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    // data.data = { open_id, display_name, avatar_url, ... }
    return data.data;
  }
}

module.exports = TikTokDevOAuthService;
