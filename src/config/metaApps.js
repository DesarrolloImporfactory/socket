/**
 * config/metaApps.js
 * Registro central de las apps de Meta que usa el backend.
 *
 * Hasta ahora había una sola app y su id/secreto se leían de process.env
 * directamente en nueve archivos. Messenger necesita una segunda app mientras
 * la primera sigue restringida, y con dos apps el secreto deja de ser una
 * constante global: cada página, cada token de página y cada firma de webhook
 * pertenecen a UNA de las dos. Usar el secreto equivocado no da un error
 * legible — da un 401 de firma inválida o un `appsecret_proof` que Meta
 * rechaza sin decir por qué.
 *
 * WhatsApp, Instagram y Meta Ads siguen en la app `legacy` y no se tocan:
 * mover una WABA de app es una migración con Meta de por medio, no un cambio
 * de variable de entorno.
 */

const crypto = require('crypto');

/** Claves internas. La de `legacy` no cambia nunca: es la app histórica. */
const LEGACY = 'legacy';
const MESSENGER = 'messenger';

function build(key, idEnv, secretEnv, loginConfigEnv) {
  const id = process.env[idEnv];
  const secret = process.env[secretEnv];
  if (!id || !secret) return null;
  return {
    key,
    id: String(id),
    secret,
    loginConfigId: process.env[loginConfigEnv] || null,
    /** Token de app (`id|secreto`), para endpoints que no usan token de usuario. */
    appAccessToken: `${id}|${secret}`,
  };
}

const REGISTRY = {
  [LEGACY]: build(
    LEGACY,
    'FB_APP_ID',
    'FB_APP_SECRET',
    'FB_LOGIN_CONFIG_ID',
  ),
  [MESSENGER]: build(
    MESSENGER,
    'FB_MS_APP_ID',
    'FB_MS_APP_SECRET',
    'FB_MS_LOGIN_CONFIG_ID',
  ),
};

/** Todas las apps realmente configuradas (con id y secreto presentes). */
function listApps() {
  return Object.values(REGISTRY).filter(Boolean);
}

/** La app histórica. Siempre existe si el .env está bien. */
function legacyApp() {
  return REGISTRY[LEGACY];
}

/**
 * Con qué app se conectan las páginas NUEVAS de Messenger.
 *
 * Se controla con FB_MESSENGER_APP=legacy|messenger. Por defecto `legacy`,
 * así que mientras la app nueva no esté aprobada nada cambia de comportamiento
 * con solo desplegar este código. El día que Meta apruebe App Review, esto es
 * una línea en el .env del servidor.
 *
 * Si se pide `messenger` pero esa app no está configurada, se avisa y se cae a
 * `legacy`: es preferible seguir conectando por la app vieja que romper el
 * botón de conectar.
 */
function defaultMessengerApp() {
  const pedida = (process.env.FB_MESSENGER_APP || LEGACY).trim().toLowerCase();
  const app = REGISTRY[pedida];
  if (app) return app;
  if (pedida !== LEGACY) {
    console.warn(
      `[META_APPS] FB_MESSENGER_APP="${pedida}" pero esa app no está ` +
        `configurada (faltan FB_MS_APP_ID/FB_MS_APP_SECRET). Se usa "${LEGACY}".`,
    );
  }
  return legacyApp();
}

/**
 * Resuelve una app por clave interna ('legacy'/'messenger') o por su App ID
 * numérico de Meta. Devuelve `legacy` si no reconoce el valor, que es lo
 * correcto para las 13 páginas que se conectaron antes de que existiera la
 * columna `fb_app_id` y la tienen en NULL.
 */
function resolveApp(keyOrId) {
  if (!keyOrId) return legacyApp();
  const v = String(keyOrId).trim().toLowerCase();
  if (REGISTRY[v]) return REGISTRY[v];
  const porId = listApps().find((a) => a.id === String(keyOrId).trim());
  return porId || legacyApp();
}

/** ¿Este App ID de Meta es de alguna de nuestras apps? */
function isOwnAppId(appId) {
  if (!appId) return false;
  return listApps().some((a) => a.id === String(appId));
}

/**
 * `appsecret_proof`: HMAC-SHA256 del token, con el secreto de la app que
 * EMITIÓ ese token. Si se cruzan, Meta responde 400 sin explicar la causa.
 */
function appSecretProof(accessToken, app) {
  const secreto = (app && app.secret) || legacyApp()?.secret;
  if (!secreto || !accessToken) return null;
  return crypto
    .createHmac('sha256', secreto)
    .update(String(accessToken))
    .digest('hex');
}

module.exports = {
  LEGACY,
  MESSENGER,
  listApps,
  legacyApp,
  defaultMessengerApp,
  resolveApp,
  isOwnAppId,
  appSecretProof,
};
