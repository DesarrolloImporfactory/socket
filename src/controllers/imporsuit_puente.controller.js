/* ═══════════════════════════════════════════════════════════
   Puente a Imporsuit — Carterachat y Cotizachat

   Hasta el 13-10-2026 el navegador llamaba directo a new.imporsuitpro.com con
   la llave compartida (CHATCENTER_API_TOKEN) compilada en el bundle público, y
   además decía él mismo quién era (`_cc_actor.id_sub_usuario`). Cualquiera que
   abriera el JS podía operar la cartera y firmar como cualquier asesor.

   Ahora el navegador le pide a este puente con su sesión de ImporChat y el
   puente:
     1. exige sesión (auth.protect, en la ruta) y que la cuenta sea de las
        conexiones de Imporfactory (CONFIGS_SOPORTE);
     2. solo reenvía a Carterachat/* y Cotizachat/*;
     3. agrega la llave, que vive solo en el .env del servidor;
     4. pone la identidad del asesor desde la sesión, pisando lo que mande el
        navegador.

   Imporsuit sigue validando la llave como siempre (hash_equals).
   ═══════════════════════════════════════════════════════════ */
const axios = require('axios');
const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { CONFIGS_SOPORTE } = require('../utils/configsSoporte');

const IMPORSUIT_URL = (
  process.env.IMPORSUIT_URL || 'https://new.imporsuitpro.com'
).replace(/\/+$/, '');

/* Únicos controladores de Imporsuit que se pueden alcanzar por acá. */
const CONTROLADORES = ['Carterachat', 'Cotizachat'];
const METODO = /^[a-z][a-z0-9_]{1,60}$/;
// Carterachat/cliente/{id} y Carterachat/deudas/{uuid}
const PARAMETRO = /^[A-Za-z0-9-]{1,64}$/;

/* ia_analizar tarda hasta un minuto; el front pone su propio límite por
   llamada, este es solo el techo del servidor. */
const TIMEOUT_MS = 185000;

/* Cuentas ya comprobadas como dueñas de una conexión de Imporfactory. Solo se
   guardan los aciertos: el listado de chats dispara varias llamadas seguidas y
   no vale la pena consultar la BD en cada una. */
const cuentasOk = new Map();
const CUENTA_OK_MS = 5 * 60 * 1000;

/* No basta con estar logueado: ImporChat lo usan clientes externos y esto
   expone la cartera de Imporfactory. */
exports.exigirImporfactory = catchAsync(async (req, res, next) => {
  const ownerId = Number(req.sessionUser?.id_usuario);
  if (!ownerId) throw new AppError('No autenticado o sesión inválida', 401);

  if ((cuentasOk.get(ownerId) || 0) > Date.now()) return next();

  const [row] = await db.query(
    `SELECT id FROM configuraciones
      WHERE id_usuario = :owner AND id IN (:configs) LIMIT 1`,
    {
      replacements: { owner: ownerId, configs: CONFIGS_SOPORTE },
      type: db.QueryTypes.SELECT,
    },
  );
  if (!row)
    throw new AppError(
      'Esta sección solo está disponible para las conexiones de Imporfactory.',
      403,
    );

  cuentasOk.set(ownerId, Date.now() + CUENTA_OK_MS);
  next();
});

/* Quién es el asesor, según la sesión. Del navegador solo se conserva el
   contexto de la cartera abierta (qué conexión y qué cliente), que es dato de
   auditoría y no identidad. */
function actorDeSesion(req) {
  const u = req.sessionUser;
  const enviado =
    req.body?._cc_actor && typeof req.body._cc_actor === 'object'
      ? req.body._cc_actor
      : {};
  const idConfig = Number(enviado.id_configuracion);

  return {
    id_usuario: Number(u.id_usuario) || null,
    id_sub_usuario: Number(u.id_sub_usuario) || null,
    nombre: u.nombre_encargado || u.usuario || '',
    email: u.email || '',
    rol: u.rol || '',
    id_configuracion:
      Number.isInteger(idConfig) && idConfig > 0 ? idConfig : null,
    correo: typeof enviado.correo === 'string' ? enviado.correo : null,
  };
}

exports.reenviar = catchAsync(async (req, res) => {
  const token = process.env.IMPORSUIT_CHATCENTER_TOKEN || '';
  if (!token) {
    console.error('[imporsuit_puente] falta IMPORSUIT_CHATCENTER_TOKEN');
    throw new AppError(
      'La integración con Imporsuit no está configurada.',
      503,
    );
  }

  const { controlador, metodo, parametro } = req.params;
  if (
    !CONTROLADORES.includes(controlador) ||
    !METODO.test(metodo) ||
    (parametro !== undefined && !PARAMETRO.test(parametro))
  ) {
    throw new AppError('Ruta de Imporsuit no permitida.', 404);
  }

  const actor = actorDeSesion(req);
  const esGet = req.method === 'GET';
  const cuerpo =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};

  let respuesta;
  try {
    respuesta = await axios({
      method: req.method,
      url: `${IMPORSUIT_URL}/${controlador}/${metodo}${
        parametro !== undefined ? `/${parametro}` : ''
      }`,
      // Las lecturas identifican al asesor por `agente` (ia_cotizaciones,
      // ia_bandeja): también sale de la sesión.
      params: esGet
        ? { ...req.query, agente: actor.id_sub_usuario }
        : req.query,
      data: esGet ? undefined : { ...cuerpo, _cc_actor: actor },
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch (err) {
    console.error(
      `[imporsuit_puente] ${controlador}/${metodo} sin respuesta:`,
      err.message,
    );
    throw new AppError('Imporsuit no respondió. Vuelve a intentar.', 502);
  }

  // Un 401 de Imporsuit es de la llave del servidor, no de la sesión del
  // asesor: si se devolviera tal cual, el front lo tomaría por sesión vencida.
  if (respuesta.status === 401) {
    console.error(
      `[imporsuit_puente] Imporsuit rechazó la llave en ${controlador}/${metodo}`,
    );
    throw new AppError('La integración con Imporsuit no está disponible.', 502);
  }

  if (respuesta.data && typeof respuesta.data === 'object') {
    return res.status(respuesta.status).json(respuesta.data);
  }
  // Algo que no es JSON (página de error de PHP): nunca como HTML.
  return res
    .status(respuesta.status >= 400 ? respuesta.status : 502)
    .type('text/plain')
    .send(String(respuesta.data ?? ''));
});
