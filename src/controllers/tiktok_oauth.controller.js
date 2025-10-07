const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const TikTokOAuthService = require('../services/tiktok_oauth.service');

/**
 * GET /api/v1/tiktok/login-url?id_configuracion=123&redirect_uri=https://tu.front/conexiones&platform=web
 * Construye la URL de login con TikTok Business
 */
exports.getLoginUrl = catchAsync(async (req, res, next) => {
  const { id_configuracion, redirect_uri, platform = 'web' } = req.query;

  if (!id_configuracion || !redirect_uri) {
    return next(
      new AppError('id_configuracion y redirect_uri son requeridos', 400)
    );
  }

  // Validar plataforma
  const validPlatforms = ['web', 'desktop', 'android', 'ios'];
  if (!validPlatforms.includes(platform)) {
    return next(
      new AppError(
        `Plataforma debe ser una de: ${validPlatforms.join(', ')}`,
        400
      )
    );
  }

  const url = TikTokOAuthService.buildLoginUrl({
    id_configuracion,
    redirect_uri,
    platform,
  });

  res.json({
    ok: true,
    url,
    platform,
  });
});

/**
 * POST /api/v1/tiktok/oauth/exchange
 * body: { code, id_configuracion, redirect_uri, platform }
 * Intercambia code → access token + crea sesión OAuth
 */
exports.exchangeCode = catchAsync(async (req, res, next) => {
  const { code, id_configuracion, redirect_uri, platform = 'web' } = req.body;

  if (!code || !id_configuracion || !redirect_uri) {
    return next(
      new AppError('code, id_configuracion y redirect_uri son requeridos', 400)
    );
  }

  const session = await TikTokOAuthService.exchangeCodeAndCreateSession({
    code,
    id_configuracion,
    redirect_uri,
    platform,
  });

  res.json({
    ok: true,
    oauth_session_id: session.id_oauth_session,
    state: session.state,
    platform: session.platform,
    expires_at: session.expires_at,
  });
});

/**
 * GET /api/v1/tiktok/profile?oauth_session_id=...
 * Obtiene información del perfil del usuario autenticado
 */
exports.getUserProfile = catchAsync(async (req, res, next) => {
  const { oauth_session_id } = req.query;

  if (!oauth_session_id) {
    return next(new AppError('oauth_session_id es requerido', 400));
  }

  const profile = await TikTokOAuthService.getUserProfileFromSession(
    oauth_session_id
  );

  res.json({
    ok: true,
    profile,
  });
});

/**
 * GET /api/v1/tiktok/business-accounts?oauth_session_id=...
 * Lista las cuentas de negocio del usuario autenticado
 */
exports.getBusinessAccounts = catchAsync(async (req, res, next) => {
  const { oauth_session_id } = req.query;

  if (!oauth_session_id) {
    return next(new AppError('oauth_session_id es requerido', 400));
  }

  const accounts = await TikTokOAuthService.getBusinessAccountsFromSession(
    oauth_session_id
  );

  res.json({
    ok: true,
    accounts,
  });
});

/**
 * POST /api/v1/tiktok/connect
 * body: { oauth_session_id, id_configuracion, business_account_id }
 * Conecta una cuenta de negocio de TikTok a una configuración
 */
exports.connectBusinessAccount = catchAsync(async (req, res, next) => {
  const { oauth_session_id, id_configuracion, business_account_id } = req.body;

  if (!oauth_session_id || !id_configuracion || !business_account_id) {
    return next(
      new AppError(
        'oauth_session_id, id_configuracion y business_account_id son requeridos',
        400
      )
    );
  }

  const connection = await TikTokOAuthService.connectBusinessAccount({
    oauth_session_id,
    id_configuracion,
    business_account_id,
  });

  res.json({
    ok: true,
    connection,
    message: 'Cuenta de TikTok Business conectada exitosamente',
  });
});

/**
 * GET /api/v1/tiktok/refresh-token?oauth_session_id=...
 * Refresca el token de acceso
 */
exports.refreshToken = catchAsync(async (req, res, next) => {
  const { oauth_session_id } = req.query;

  if (!oauth_session_id) {
    return next(new AppError('oauth_session_id es requerido', 400));
  }

  const refreshedSession = await TikTokOAuthService.refreshAccessToken(
    oauth_session_id
  );

  res.json({
    ok: true,
    oauth_session_id: refreshedSession.id_oauth_session,
    expires_at: refreshedSession.expires_at,
    message: 'Token refrescado exitosamente',
  });
});

/**
 * DELETE /api/v1/tiktok/disconnect?id_configuracion=123
 * Desconecta una configuración de TikTok
 */
exports.disconnectAccount = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.query;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  await TikTokOAuthService.disconnectAccount(id_configuracion);

  res.json({
    ok: true,
    message: 'Cuenta de TikTok desconectada exitosamente',
  });
});
