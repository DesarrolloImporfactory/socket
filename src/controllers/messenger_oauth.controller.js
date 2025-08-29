const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const MessengerOAuthService = require('../services/messenger_oauth.service');
const MessengerConnectService = require('../services/messenger_connect.service');

// GET /api/v1/messenger/facebook/login-url?id_configuracion=123&redirect_uri=https://tu.front/conexiones
exports.getLoginUrl = catchAsync(async (req, res, next) => {
  const { id_configuracion, redirect_uri, config_id } = req.query;

  if (!id_configuracion || !redirect_uri) {
    return next(
      new AppError('id_configuracion y redirect_uri son requeridos', 400)
    );
  }
  const url = MessengerOAuthService.buildLoginUrl({
    id_configuracion,
    redirect_uri,
    config_id,
  });
  res.json({ ok: true, url });
});

// POST /api/v1/messenger/facebook/oauth/exchange
// body: { code, id_configuracion, redirect_uri }
// crea sesión oauth (guarda user_token_largo) y devuelve oauth_session_id
exports.exchangeCode = catchAsync(async (req, res, next) => {
  const { code, id_configuracion, redirect_uri } = req.body;
  if (!code || !id_configuracion || !redirect_uri) {
    return next(
      new AppError('code, id_configuracion y redirect_uri son requeridos', 400)
    );
  }
  const session = await MessengerOAuthService.exchangeCodeAndCreateSession({
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

// GET /api/v1/messenger/facebook/pages?oauth_session_id=...
exports.listUserPages = catchAsync(async (req, res, next) => {
  const { oauth_session_id } = req.query;
  if (!oauth_session_id)
    return next(new AppError('oauth_session_id es requerido', 400));
  const pages = await MessengerOAuthService.listPagesFromSession(
    oauth_session_id
  );
  // Devolver solo lo necesario al front
  res.json({ ok: true, pages: pages.map((p) => ({ id: p.id, name: p.name })) });
});

// POST /api/v1/messenger/facebook/connect
// body: { oauth_session_id, id_configuracion, page_id }
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
  const result = await MessengerConnectService.connect({
    oauth_session_id,
    id_configuracion,
    page_id,
  });
  res.json({ ok: true, ...result });
});
