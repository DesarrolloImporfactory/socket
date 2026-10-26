const jwt = require('jsonwebtoken');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const { ROL_EQUIPO, esEquipo, enPruebaDeTeam, puedeTenerRolEquipo, EMISOR_TEAM, DESTINO_TEAM } = require('../utils/rolEquipo');
const { taparTelefonos } = require('../utils/taparTelefonos');

/*  Rutas de Team para el rol «equipo» (ver utils/rolEquipo.js). */

const DURACION_SESION = '8h';

/*  POST /api/v1/equipo/sesion — servidor de Team, con TEAM_EQUIPO_TOKEN.
 *  Team ya validó a su usuario y dice qué sub-usuario de IMPORCHAT le toca.
 *  Solo se emite para un sub-usuario vigente, con rol «equipo» o de prueba
 *  (ROL_EQUIPO_PRUEBA_SUBS), y de una cuenta autorizada (ROL_EQUIPO_CUENTAS). El token lleva `origen: 'team'`: protect
 *  lo limita a /api/v1/equipo/ y le tapa los teléfonos.
 */
exports.sesion = catchAsync(async (req, res, next) => {
  const id_sub_usuario = Number(req.body?.id_sub_usuario);
  const team_usuario = String(req.body?.team_usuario || '').slice(0, 80);
  // Gerencia mirando la silla con «Ver como»: la sesión sirve para leer y no
  // para enviar (POST …/mensajes responde 403), aunque Team se equivoque.
  const solo_lectura = req.body?.solo_lectura === true;
  if (!Number.isInteger(id_sub_usuario) || id_sub_usuario <= 0) {
    return next(new AppError('id_sub_usuario es requerido', 400));
  }

  const sub = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);
  const motivo = !sub
    ? 'NO_EXISTE'
    : Number(sub.suspendido) === 1
      ? 'SUSPENDIDO'
      : !esEquipo(sub) && !enPruebaDeTeam(sub)
        ? 'SIN_ROL_EQUIPO'
        : !puedeTenerRolEquipo(sub.id_usuario)
          ? 'CUENTA_NO_HABILITADA'
          : null;

  console.log(
    '[EQUIPO_SESION]',
    JSON.stringify({ id_sub_usuario, team_usuario, solo_lectura, ok: !motivo, motivo, prueba: !!sub && !esEquipo(sub) && enPruebaDeTeam(sub) }),
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
      ...(solo_lectura ? { solo_lectura: true } : {}),
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

/* ───────── Chat de Team ─────────
 *
 *  Lo mismo que ve un asesor de ventas en la pantalla vieja (sus chats y los
 *  en espera de sus canales), pero por REST y con sesión: el chat viejo pide
 *  la lista por el socket sin sesión. Los teléfonos salen tapados por protect.
 *  Responder: POST …/mensajes, más abajo, solo texto por WhatsApp.
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
 *  ellos, y buscar por número dejaría adivinar teléfonos (¿existe este?).
 *  Sin cifras y sin comodines del LIKE: «09%9%1%» probaría el número cifra por
 *  cifra mirando si el chat sigue saliendo. */
function filtrosDeEquipo(q) {
  const filtros = {};
  const termino = String(q.q || '').trim().slice(0, 60);
  if (termino && !/[\d%_\\]/.test(termino)) filtros.searchTerm = termino;
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

  // Siempre con el alcance de un asesor (sus chats y los en espera de sus
  // canales), aunque sea un sub-usuario de prueba con otro rol: en Team nadie
  // ve la lista entera de la línea.
  const chats = await new ChatService().findChats(cfg.id, u.id_sub_usuario, ROL_EQUIPO, {
    cursorFecha,
    cursorId,
    limit,
    filtros: filtrosDeEquipo(req.query),
    scopeChats: req.query.scope === 'espera' ? 'espera' : 'mine',
  });
  res.json({ status: 'success', data: chats });
});

/*  ¿Este asesor puede abrir este chat? Lo mismo que lo deja verlo en la
 *  lista: es suyo, o está en espera en uno de sus canales. Devuelve la fila
 *  (con el número, que no sale de acá: sirve para taparlo en otros formatos)
 *  o null. */
async function chatVisible(id_cliente, cfg, u) {
  const filtroCanal = sqlFiltroCanales(await canalesDeUsuarioEnConfig(u.id_sub_usuario, cfg.id));
  const [fila] = await db.query(
    `SELECT id, celular_cliente, source FROM clientes_chat_center
      WHERE id = ? AND id_configuracion = ? AND propietario != 1
        AND (id_encargado = ? OR (id_encargado IS NULL${filtroCanal ? ` AND ${filtroCanal}` : ''}))
      LIMIT 1`,
    { replacements: [id_cliente, cfg.id, u.id_sub_usuario], type: db.QueryTypes.SELECT },
  );
  return fila || null;
}

const MAX_MENSAJES = 200;

/*  GET /api/v1/equipo/chats/:id_cliente/mensajes?id_configuracion= */
exports.mensajes = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return next(new AppError('Chat no encontrado', 404));
  // Lectura propia, no getChatsByClient: aquel marca los mensajes como vistos
  // (Team sondea cada 10 s y le borraría los pendientes al encargado) y los
  // trae todos. Acá, solo los últimos y solo lo que Team pinta.
  const filas = await db.query(
    `SELECT id, rol_mensaje, tipo_mensaje, texto_mensaje, ruta_archivo, responsable, created_at, eliminado_at
       FROM mensajes_clientes
      WHERE celular_recibe = ? AND id_configuracion = ? AND deleted_at IS NULL
        AND (tipo_mensaje IS NULL OR tipo_mensaje NOT IN ('reaction', 'edit', 'revoke'))
      ORDER BY created_at DESC, id DESC
      LIMIT ${MAX_MENSAJES}`,
    { replacements: [String(id_cliente), cfg.id], type: db.QueryTypes.SELECT },
  );
  const data = [{ id: id_cliente, mensajes: filas.reverse() }];
  res.json({ status: 'success', data: taparTelefonos(data, { telefonosConocidos: [chat.celular_cliente] }) });
});

/* ───────── Responder desde Team ───────── */

const MAX_TEXTO = 4096; // lo que acepta WhatsApp en un mensaje de texto
const VENTANA_HORAS = 24;
const TOPE_ENVIOS = 20; // por asesor, por minuto
const enviosRecientes = new Map(); // id_sub_usuario → horas de sus últimos envíos

function pasaElTope(id_sub_usuario, ahora = Date.now()) {
  const recientes = (enviosRecientes.get(id_sub_usuario) || []).filter((t) => ahora - t < 60 * 1000);
  if (recientes.length >= TOPE_ENVIOS) {
    enviosRecientes.set(id_sub_usuario, recientes);
    return false;
  }
  recientes.push(ahora);
  enviosRecientes.set(id_sub_usuario, recientes);
  return true;
}

/*  POST /api/v1/equipo/chats/:id_cliente/mensajes  { id_configuracion, texto }
 *  Le contesta al cliente con un texto por la línea oficial: el mismo envío
 *  que la pantalla vieja (ChatService.sendMessage, que también lo guarda en
 *  mensajes_clientes con el nombre del asesor). El número lo pone el servidor
 *  a partir del chat; Team no lo manda ni lo recibe.
 *  Solo chats de WhatsApp que el asesor ve (los suyos y los en espera de sus
 *  canales) y solo dentro de las 24 h desde el último mensaje del cliente:
 *  fuera de esa ventana WhatsApp solo deja mandar plantillas, y Meta aceptaría
 *  el envío para descartarlo después sin que el asesor se entere. */
exports.enviarMensaje = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  if (req.sesionTeamSoloLectura) {
    return next(new AppError('Estás en «Ver como»: el chat es de solo lectura.', 403));
  }
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const texto = typeof req.body?.texto === 'string' ? req.body.texto.replace(/\r\n?/g, '\n').trim() : '';
  if (!texto) return next(new AppError('Escribe el mensaje.', 400));
  if (texto.length > MAX_TEXTO) return next(new AppError(`El mensaje es muy largo (máximo ${MAX_TEXTO} caracteres).`, 400));

  const cfg = await conexionDeLaCuenta(req.body?.id_configuracion, u.id_usuario);
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return next(new AppError('Chat no encontrado', 404));
  if (String(chat.source || 'wa').toLowerCase() !== 'wa') {
    return next(new AppError('Desde Team por ahora solo se contesta por WhatsApp.', 422));
  }
  const [ultimo] = await db.query(
    `SELECT MAX(created_at) AS ult FROM mensajes_clientes
      WHERE celular_recibe = ? AND id_configuracion = ? AND rol_mensaje = 0 AND deleted_at IS NULL
        AND created_at > NOW() - INTERVAL ${VENTANA_HORAS} HOUR`,
    { replacements: [String(id_cliente), cfg.id], type: db.QueryTypes.SELECT },
  );
  if (!ultimo?.ult) {
    return next(
      new AppError(
        'El cliente no escribe desde hace más de 24 horas: WhatsApp no deja mandarle un mensaje libre. Usa una plantilla desde ImporChat.',
        422,
      ),
    );
  }
  if (!pasaElTope(Number(u.id_sub_usuario))) {
    return next(new AppError('Vas muy rápido: espera un minuto y vuelve a enviar.', 429));
  }

  const chatService = new ChatService();
  const dataAdmin = await chatService.getDataAdmin(cfg.id);
  if (!dataAdmin?.id_telefono || !dataAdmin?.token) {
    return next(new AppError('La línea no está lista para enviar.', 503));
  }
  const registro = { id_sub_usuario: u.id_sub_usuario, id_configuracion: cfg.id, id_cliente, team_usuario: req.sesionTeamUsuario || '' };
  let resp;
  try {
    resp = await chatService.sendMessage({
      mensaje: texto,
      to: String(chat.celular_cliente || '').replace(/\s+/g, '').replace(/^\+/, ''),
      dataAdmin,
      tipo_mensaje: 'text',
      id_configuracion: cfg.id,
      nombre_encargado: u.nombre_encargado,
    });
  } catch (e) {
    console.log('[EQUIPO_ENVIO]', JSON.stringify({ ...registro, ok: false }));
    return next(new AppError('WhatsApp no aceptó el mensaje. Vuelve a intentar en un momento.', 502));
  }
  const m = resp?.mensajeNuevo;
  console.log('[EQUIPO_ENVIO]', JSON.stringify({ ...registro, ok: true, id_mensaje: m?.id || null }));
  // Lo mismo que Team pinta de un mensaje; sin el wamid (lleva el número).
  res.json({
    status: 'success',
    data: {
      id: m?.id || null,
      rol_mensaje: 1,
      tipo_mensaje: 'text',
      texto_mensaje: m?.texto_mensaje ?? texto,
      ruta_archivo: null,
      responsable: m?.responsable ?? u.nombre_encargado ?? null,
      created_at: m?.created_at || new Date(),
      eliminado_at: null,
    },
  });
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
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return next(new AppError('Chat no encontrado', 404));
  const celular = String(chat.celular_cliente || '');
  const r = await cargasDelTelefono(celular);
  // La nota de logística puede traer el número del cliente en otro formato.
  res.json({
    status: 'success',
    data: taparTelefonos({
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
    }, { telefonosConocidos: [celular] }),
  });
});
