const jwt = require('jsonwebtoken');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const { esEquipo, puedeTenerRolEquipo, EMISOR_TEAM, DESTINO_TEAM } = require('../utils/rolEquipo');

/*  Rutas de Team para el rol «equipo» (ver utils/rolEquipo.js). */

const DURACION_SESION = '8h';

/*  POST /api/v1/equipo/sesion — servidor de Team, con TEAM_EQUIPO_TOKEN.
 *  Team ya validó a su usuario y dice qué sub-usuario de IMPORCHAT le toca.
 *  Solo se emite para un sub-usuario vigente, con rol «equipo» y de una cuenta
 *  autorizada (ROL_EQUIPO_CUENTAS). El token lleva `origen: 'team'`: protect
 *  lo limita a /api/v1/equipo/ y le tapa los teléfonos.
 */
exports.sesion = catchAsync(async (req, res, next) => {
  const id_sub_usuario = Number(req.body?.id_sub_usuario);
  const team_usuario = String(req.body?.team_usuario || '').slice(0, 80);
  if (!Number.isInteger(id_sub_usuario) || id_sub_usuario <= 0) {
    return next(new AppError('id_sub_usuario es requerido', 400));
  }

  const sub = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);
  const motivo = !sub
    ? 'NO_EXISTE'
    : Number(sub.suspendido) === 1
      ? 'SUSPENDIDO'
      : !esEquipo(sub)
        ? 'SIN_ROL_EQUIPO'
        : !puedeTenerRolEquipo(sub.id_usuario)
          ? 'CUENTA_NO_HABILITADA'
          : null;

  console.log(
    '[EQUIPO_SESION]',
    JSON.stringify({ id_sub_usuario, team_usuario, ok: !motivo, motivo }),
  );
  if (motivo) {
    // Un solo mensaje para todos los casos: no dice qué sub-usuarios existen.
    return next(new AppError('Este usuario no puede entrar desde Team.', 403));
  }

  const token = jwt.sign(
    {
      id_sub_usuario,
      id_usuario: Number(sub.id_usuario),
      rol: sub.rol,
      nombre_encargado: sub.nombre_encargado,
      origen: 'team',
      // Quién de Team está detrás, por si varias personas usan el mismo
      // sub-usuario.
      team_usuario,
    },
    process.env.SECRET_JWT_SEED,
    // Sello propio: protect exige este emisor y destino a toda sesión de Team,
    // y ninguna otra puerta (ssoImporsuit, newLogin) lo acepta como suyo.
    { expiresIn: DURACION_SESION, issuer: EMISOR_TEAM, audience: DESTINO_TEAM },
  );

  res.json({ status: 'success', token, expira_en: DURACION_SESION });
});

/*  GET /api/v1/equipo/yo — con la sesión de Team. Quién soy. */
exports.yo = catchAsync(async (req, res) => {
  const u = req.sessionUser;
  res.json({
    status: 'success',
    data: {
      id_sub_usuario: u.id_sub_usuario,
      id_usuario: u.id_usuario,
      nombre_encargado: u.nombre_encargado,
      rol: u.rol,
    },
  });
});

/* ───────── Chat de Team: solo lectura ─────────
 *
 *  Lo mismo que ve un asesor de ventas en la pantalla vieja (sus chats y los
 *  en espera de sus canales), pero por REST y con sesión: el chat viejo pide
 *  la lista por el socket sin sesión. Los teléfonos salen tapados por protect.
 *  Responder (manda WhatsApp a clientes) va aparte, cuando se pueda probar con
 *  un número de prueba.
 */

const { db } = require('../database/config');
const ChatService = require('../services/chat.service');
const { canalesDeUsuarioEnConfig, sqlFiltroCanales } = require('../utils/canalesDepartamento');

const MAX_CHATS = 30;

async function conexionDeLaCuenta(id_configuracion, id_usuario) {
  const id = Number(id_configuracion);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [fila] = await db.query(
    `SELECT id, nombre_configuracion FROM configuraciones
      WHERE id = ? AND id_usuario = ? AND suspendido = 0 LIMIT 1`,
    { replacements: [id, Number(id_usuario)], type: db.QueryTypes.SELECT },
  );
  return fila || null;
}

/*  GET /api/v1/equipo/conexiones — las líneas de la cuenta (sin su número). */
exports.conexiones = catchAsync(async (req, res) => {
  const filas = await db.query(
    `SELECT id, nombre_configuracion FROM configuraciones
      WHERE id_usuario = ? AND suspendido = 0 ORDER BY id`,
    { replacements: [Number(req.sessionUser.id_usuario)], type: db.QueryTypes.SELECT },
  );
  res.json({ status: 'success', data: filas });
});

/*  Filtros que acepta Team. Todo lo demás se ignora: findChats arma SQL con
 *  ellos, y buscar por número dejaría adivinar teléfonos (¿existe este?). */
function filtrosDeEquipo(q) {
  const filtros = {};
  const termino = String(q.q || '').trim().slice(0, 60);
  if (termino && !/\d{3,}/.test(termino)) filtros.searchTerm = termino;
  if (['no_leidos', 'leidos'].includes(q.lectura)) filtros.selectedLectura = { value: q.lectura };
  if (['abierto', 'resueltos'].includes(q.estado)) filtros.selectedTab = q.estado;
  if (['wa', 'ig', 'ms'].includes(q.canal)) filtros.source = q.canal;
  return filtros;
}

/*  GET /api/v1/equipo/chats?id_configuracion=&scope=mine|espera
 *      &cursorFecha=&cursorId=&limit=&q=&lectura=&estado=&canal= */
exports.chats = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  if (!cfg) return next(new AppError('Conexión no válida', 404));

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_CHATS);
  const cursorId = Number(req.query.cursorId) || null;
  const cursorFecha = cursorId && req.query.cursorFecha ? String(req.query.cursorFecha).slice(0, 40) : null;

  const chats = await new ChatService().findChats(cfg.id, u.id_sub_usuario, u.rol, {
    cursorFecha,
    cursorId,
    limit,
    filtros: filtrosDeEquipo(req.query),
    scopeChats: req.query.scope === 'espera' ? 'espera' : 'mine',
  });
  res.json({ status: 'success', data: chats });
});

/*  ¿Este asesor puede abrir este chat? Lo mismo que lo deja verlo en la
 *  lista: es suyo, o está en espera en uno de sus canales. */
async function chatVisible(id_cliente, cfg, u) {
  const filtroCanal = sqlFiltroCanales(await canalesDeUsuarioEnConfig(u.id_sub_usuario, cfg.id));
  const [fila] = await db.query(
    `SELECT id FROM clientes_chat_center
      WHERE id = ? AND id_configuracion = ? AND propietario != 1
        AND (id_encargado = ? OR (id_encargado IS NULL${filtroCanal ? ` AND ${filtroCanal}` : ''}))
      LIMIT 1`,
    { replacements: [id_cliente, cfg.id, u.id_sub_usuario], type: db.QueryTypes.SELECT },
  );
  return Boolean(fila);
}

/*  GET /api/v1/equipo/chats/:id_cliente/mensajes?id_configuracion= */
exports.mensajes = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  if (!cfg || !(await chatVisible(id_cliente, cfg, u))) {
    return next(new AppError('Chat no encontrado', 404));
  }
  const data = await new ChatService().getChatsByClient(id_cliente, cfg.id);
  res.json({ status: 'success', data });
});

/* ───────── Barra lateral de Team: solo lectura ───────── */

const { cargasDelTelefono } = require('../utils/soporteExpertos/cargaCliente');

const AGENDA_DIAS = 14;
const AGENDA_MAX = 50;

/*  GET /api/v1/equipo/agenda?id_configuracion=
 *  Las reuniones de este asesor en esa línea: de hace 2 h a 14 días, sin las
 *  canceladas. Sin descripción ni datos del invitado: solo título, hora y Meet. */
exports.agenda = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  if (!cfg) return next(new AppError('Conexión no válida', 404));
  const filas = await db.query(
    `SELECT a.id, a.title, a.status, a.start_utc, a.end_utc, a.meeting_url
       FROM appointments a
       JOIN calendars c ON c.id = a.calendar_id
      WHERE c.account_id = ? AND a.assigned_user_id = ?
        AND a.status IN ('Agendado', 'Confirmado')
        AND a.end_utc > UTC_TIMESTAMP() - INTERVAL 2 HOUR
        AND a.start_utc < UTC_TIMESTAMP() + INTERVAL ${AGENDA_DIAS} DAY
      ORDER BY a.start_utc ASC
      LIMIT ${AGENDA_MAX}`,
    { replacements: [cfg.id, Number(u.id_sub_usuario)], type: db.QueryTypes.SELECT },
  );
  res.json({ status: 'success', data: filas });
});

/*  GET /api/v1/equipo/chats/:id_cliente/carga?id_configuracion=
 *  En qué va la carga del cliente de ese chat: la misma lectura que usa el
 *  bot de la línea (ver_mi_carga), buscando por el número del chat. El número
 *  se queda en el servidor; a Team le llega el paso, la marca y la fecha. */
exports.carga = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  if (!cfg || !(await chatVisible(id_cliente, cfg, u))) {
    return next(new AppError('Chat no encontrado', 404));
  }
  const [fila] = await db.query(
    `SELECT celular_cliente FROM clientes_chat_center WHERE id = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id_cliente, cfg.id], type: db.QueryTypes.SELECT },
  );
  const r = await cargasDelTelefono(String(fila?.celular_cliente || ''));
  res.json({
    status: 'success',
    data: {
      estado: r.estado,
      hay_mas: r.hay_mas || 0,
      cargas: (r.cargas || []).map((c) => ({
        id_cotizacion: c.id_cotizacion,
        destino: c.destino,
        marcas: c.marcas,
        paso: c.paso,
        paso_nombre: c.paso_nombre,
        entregada: c.entregada,
        parcial: c.parcial,
        contenedor: c.contenedor,
        fecha_estimada_texto: c.fecha_estimada_texto,
        estimada_vencida: c.estimada_vencida,
        marcas_pendientes: c.marcas_pendientes,
        nota_cliente: c.nota_cliente,
        informable: c.informable,
        motivo: c.motivo,
      })),
    },
  });
});
