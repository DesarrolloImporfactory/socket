const jwt = require('jsonwebtoken');
const AppError = require('../utils/appError');
const { apiKeyAuth, requireScope, leerKey } = require('./apiKey.middleware');

/**
 * Autenticación servidor-a-servidor con Imporsuit (PHP, imporsuti-pro).
 *
 * Las dos apps ya comparten la semilla del SSO: el chatcenter firma con
 * SECRET_JWT_SEED lo que el PHP valida con JWT_SECRET (issueImporsuitToken →
 * Acceso::sso_from_chatcenter) y al revés (newLogin cursos_imporsuit). Acá se
 * reutiliza ese mismo secreto para que el PHP nos llame sin API key: firma un
 * JWT de 60 s con iss=imporsuit, aud=chatcenter y lo manda como Bearer
 * (Class/AvisoPagoChatCenter.php).
 *
 * Fija req.apiKey (sintético, para auditoría y rate limit) y
 * req.id_configuracion = conexión de ventas desde la que cobra Imporsuit, así
 * los handlers de la API pública funcionan sin cambios.
 */

const ISSUER = 'imporsuit';
const AUDIENCE = 'chatcenter';

/* Conexión de ImporChat con las plantillas de cobro de Imporsuit (242 =
   ImporFactory Ventas). La elige el servidor, nunca el que llama. */
const ID_CONFIGURACION_COBROS_IMPORSUIT = Number(
  process.env.IMPORSUIT_COBROS_ID_CONFIGURACION || 242,
);

/* Un JWT tiene tres segmentos; las API keys del panel empiezan con ick_. */
const esTokenSso = (raw) =>
  typeof raw === 'string' &&
  !raw.startsWith('ick_') &&
  raw.split('.').length === 3;

exports.ID_CONFIGURACION_COBROS_IMPORSUIT = ID_CONFIGURACION_COBROS_IMPORSUIT;
exports.esTokenSso = esTokenSso;

exports.ssoImporsuitAuth = (req, res, next) => {
  const raw = leerKey(req);
  if (!raw) {
    return next(
      new AppError(
        'Falta el token. Envíalo en el header Authorization: Bearer <jwt>.',
        401,
      ),
    );
  }
  if (!process.env.SECRET_JWT_SEED) {
    return next(new AppError('SECRET_JWT_SEED no está configurado.', 500));
  }

  let payload;
  try {
    payload = jwt.verify(raw, process.env.SECRET_JWT_SEED, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      ignoreExpiration: false,
    });
  } catch (e) {
    return next(
      new AppError(`Token de Imporsuit inválido o vencido (${e.message}).`, 401),
    );
  }
  // Sin exp no se acepta: tiene que ser de vida corta (el PHP firma 60 s).
  if (!payload || typeof payload !== 'object' || !payload.exp) {
    return next(new AppError('Token de Imporsuit sin vencimiento.', 401));
  }

  req.apiKey = {
    id: 0,
    id_configuracion: ID_CONFIGURACION_COBROS_IMPORSUIT,
    nombre: 'imporsuit',
    scopesLista: ['mensajes:write'],
  };
  req.id_configuracion = ID_CONFIGURACION_COBROS_IMPORSUIT;
  req.ssoImporsuit = payload;
  next();
};

/* Acepta las dos formas: JWT del PHP (sin configurar nada) o una API key del
   panel con permiso mensajes:write (por si un CRM externo quiere disparar el
   mismo aviso para su propia conexión). */
exports.autenticarCobrosImporsuit = (req, res, next) => {
  if (esTokenSso(leerKey(req))) return exports.ssoImporsuitAuth(req, res, next);
  return apiKeyAuth(req, res, (err) => {
    if (err) return next(err);
    return requireScope('mensajes:write')(req, res, next);
  });
};
