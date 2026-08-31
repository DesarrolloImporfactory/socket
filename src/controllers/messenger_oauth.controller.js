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
  let session;
  try {
    session = await MessengerOAuthService.exchangeCodeAndCreateSession({
      code,
      id_configuracion,
      redirect_uri,
    });
  } catch (err) {
    // El `code` de Meta es de un solo uso y dura ~10 minutos. Las dos causas
    // que más se ven acá son recargar la página de retorno (reusa el code) y
    // un redirect_uri que no coincide carácter por carácter con el que se usó
    // para pedir el login. El mensaje de Meta distingue una de otra, y sin
    // este catch no llegaba a ningún lado.
    const meta = err.response?.data?.error;
    console.error(
      `[FB_CONNECT][ERROR] 2/5 falló el intercambio del code · ` +
        `cfg=${id_configuracion} · redirect_uri=${redirect_uri} · ` +
        `code=…${String(code).slice(-8)} · ` +
        (meta
          ? `Meta code=${meta.code}${meta.error_subcode ? `/${meta.error_subcode}` : ''}: ${meta.message}`
          : err.message),
    );

    // Un code quemado (36009) o vencido (36007) no es una caída del servidor:
    // es el usuario recargando la pantalla de retorno, y la salida es volver a
    // conectar. Devolverlo como 500 "Something went very wrong!" dejaba al
    // cliente sin saber qué hacer y a nosotros sin poder distinguirlo de un
    // fallo real en los logs de errores.
    if (meta?.error_subcode === 36007 || meta?.error_subcode === 36009) {
      return next(
        new AppError(
          'El enlace de conexión con Facebook ya se usó o expiró. ' +
            'Vuelve a pulsar "Conectar Messenger" para empezar de nuevo.',
          400,
        ),
      );
    }
    throw err;
  }
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
  // El manejador global de errores no escribe nada en los logs, así que sin
  // este catch un fallo al conectar sólo se ve en el navegador del cliente y
  // en el servidor no queda rastro. Se vuelve a lanzar: el comportamiento de
  // la respuesta no cambia, sólo se deja la traza.
  let result;
  try {
    result = await MessengerConnectService.connect({
      oauth_session_id,
      id_configuracion,
      page_id,
    });
  } catch (err) {
    const meta = err.response?.data?.error;
    console.error(
      `[FB_CONNECT][ERROR] cfg=${id_configuracion} page_id=${page_id} · ` +
        (meta
          ? `Meta code=${meta.code}${meta.error_subcode ? `/${meta.error_subcode}` : ''}: ${meta.message}`
          : err.message),
    );
    throw err;
  }

  console.log(
    `[FB_CONNECT] ✅ conectada "${result.page_name}" (${result.page_id}) ` +
      `en cfg=${id_configuracion}`,
  );
  res.json({ ok: true, ...result });
});
