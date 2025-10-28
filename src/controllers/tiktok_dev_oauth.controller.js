const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const TikTokDevOAuthService = require('../services/tiktok_dev_oauth.service');

exports.getDevLoginUrl = catchAsync(async (req, res, next) => {
  const { id_configuracion, redirect_uri } = req.query;
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const finalRedirect = redirect_uri || process.env.TIKTOK_REDIRECT_URI;
  if (!finalRedirect) return next(new AppError('redirect_uri faltante', 400));

  const { url, state } = await TikTokDevOAuthService.buildLoginUrl({
    id_configuracion,
    redirect_uri: finalRedirect,
    scopes: ['user.info.basic'], // Agregue más scopes cuando TikTok se los habilite
  });

  res.json({ ok: true, url, state, redirect_uri: finalRedirect });
});

exports.devExchangeCode = catchAsync(async (req, res, next) => {
  const { code, state, redirect_uri } = req.body;
  if (!code || !state)
    return next(new AppError('code y state son requeridos', 400));

  const finalRedirect = redirect_uri || process.env.TIKTOK_REDIRECT_URI;

  // 1) Canjear el code → tokens (resuelve id_configuracion desde oauth_states)
  const tokenPayload = await TikTokDevOAuthService.exchangeCode({
    code,
    state,
    redirect_uri: finalRedirect,
  });

  const {
    access_token,
    refresh_token,
    expires_in,
    scope,
    token_type,
    open_id,
    id_configuracion, // ← viene resuelto desde el state persistido
  } = tokenPayload;

  // 2) Perfil básico (opcional, no bloquea)
  let profile = null;
  try {
    profile = await TikTokDevOAuthService.getUserInfo({ access_token });
  } catch {
    profile = { open_id };
  }

  // 3) Persistir/actualizar conexión Developers (Login Kit)
  const expiresAtISO = await TikTokDevOAuthService.upsertDevelopersConnection({
    id_configuracion,
    open_id,
    access_token,
    refresh_token,
    scope,
    token_type,
    expires_in,
  });

  // 4) Respuesta compacta al front
  res.json({
    ok: true,
    connected: true,
    id_configuracion,
    connection: {
      open_id,
      scope,
      profile,
      expires_at: expiresAtISO,
    },
    tokens: {
      access_token,
      refresh_token,
      expires_in,
    },
  });
});
