const TikTokDevOAuthService = require('../services/tiktok_dev_oauth.service');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

exports.getDevLoginUrl = catchAsync(async (req, res, next) => {
  const { id_configuracion, redirect_uri } = req.query;
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const finalRedirect = redirect_uri || process.env.TIKTOK_REDIRECT_URI;
  if (!finalRedirect) return next(new AppError('redirect_uri faltante', 400));

  const { url, state } = TikTokDevOAuthService.buildLoginUrl({
    id_configuracion,
    redirect_uri: finalRedirect,
    scopes: ['user.info.basic'], // agrega más cuando TikTok te los habilite
  });

  res.json({ ok: true, url, state, redirect_uri: finalRedirect });
});

exports.devExchangeCode = catchAsync(async (req, res, next) => {
  const { code, state, redirect_uri } = req.body;
  if (!code || !state)
    return next(new AppError('code y state son requeridos', 400));

  const finalRedirect = redirect_uri || process.env.TIKTOK_REDIRECT_URI;

  // 1) Canje code -> tokens
  const tokenPayload = await TikTokDevOAuthService.exchangeCode({
    code,
    state,
    redirect_uri: finalRedirect,
  });
  const { access_token, refresh_token, expires_in, scope, open_id } =
    tokenPayload;

  // 2) Perfil básico
  let profile = null;
  try {
    profile = await TikTokDevOAuthService.getUserInfo({ access_token });
  } catch (e) {
    // Si falla, no bloqueamos el flujo
    profile = { open_id };
  }

  // 3) (Opcional) Persistir en tu BD:
  // - Mapea "state" -> id_configuracion (decodifica base64url)
  // - Guarda open_id, access_token, refresh_token, expires_at, scope
  // - Marca como "conectado"
  //
  // Ejemplo (pseudo):
  // const { id_configuracion } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  // await TikTokDevelopersConnection.upsert({ id_configuracion, open_id, access_token, refresh_token, expires_at: new Date(Date.now()+expires_in*1000), scope });

  res.json({
    ok: true,
    connection: {
      open_id,
      scope,
      expires_at: new Date(Date.now() + (expires_in || 0) * 1000),
      profile,
    },
    tokens: {
      access_token,
      refresh_token,
      expires_in,
    },
  });
});
