const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const InstagramOAuthService = require('../services/instagram_oauth.service');
const InstagramConnectService = require('../services/instagram_connect.service');

/**
 * GET /api/v1/instagram/facebook/login-url?id_configuracion=123&redirect_uri=https://tu.front/conexiones
 * Construye la URL de login con Facebook (scopes para IG)
 */
exports.getLoginUrl = catchAsync(async (req, res, next) => {
  const { id_configuracion, redirect_uri, config_id } = req.query;

  if (!id_configuracion || !redirect_uri) {
    return next(
      new AppError('id_configuracion y redirect_uri son requeridos', 400)
    );
  }

  const url = InstagramOAuthService.buildLoginUrl({
    id_configuracion,
    redirect_uri,
    config_id,
  });

  res.json({ ok: true, url });
});

/**
 * POST /api/v1/instagram/facebook/oauth/exchange
 * body: { code, id_configuracion, redirect_uri }
 * Intercambia code → long-lived user token + crea sesión OAuth
 */
exports.exchangeCode = catchAsync(async (req, res, next) => {
  const { code, id_configuracion, redirect_uri } = req.body;
  if (!code || !id_configuracion || !redirect_uri) {
    return next(
      new AppError('code, id_configuracion y redirect_uri son requeridos', 400)
    );
  }

  const session = await InstagramOAuthService.exchangeCodeAndCreateSession({
    code,
    id_configuracion,
    redirect_uri,
  });

  res.json({
    ok: true,
    oauth_session_id: session.id_oauth_session,
    state: session.state,
    expires_at: session.expires_at,
  });
});

/**
 * GET /api/v1/instagram/facebook/pages?oauth_session_id=...
 * Lista páginas del usuario (filtrando las que tienen IG conectado)
 */
exports.listUserPages = catchAsync(async (req, res, next) => {
  const { oauth_session_id } = req.query;
  if (!oauth_session_id) {
    return next(new AppError('oauth_session_id es requerido', 400));
  }

  const pages = await InstagramOAuthService.listPagesFromSession(
    oauth_session_id
  );

  const withIG = pages.filter((p) => p.has_ig);
  const withoutIG = pages.filter((p) => !p.has_ig);

  res.json({
    ok: true,
    pages_with_ig: withIG,
    pages_without_ig: withoutIG, 
  });
});

/**
 * POST /api/v1/instagram/facebook/connect
 * body: { oauth_session_id, id_configuracion, page_id }
 * Suscribe la app a la página, guarda tokens, IG account, etc.
 */
exports.connectPage = catchAsync(async (req, res, next) => {
  const { oauth_session_id, id_configuracion, page_id } = req.body;
  if (!oauth_session_id || !id_configuracion || !page_id) {
    return next(
      new AppError(
        'oauth_session_id, id_configuracion y page_id son requeridos',
        400
      )
    );
  }

  const result = await InstagramConnectService.connect({
    oauth_session_id,
    id_configuracion,
    page_id,
  });

  res.json({ ok: true, ...result });
});
