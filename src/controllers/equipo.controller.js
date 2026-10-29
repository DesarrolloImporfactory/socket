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
    `SELECT id, celular_cliente, source, id_encargado FROM clientes_chat_center
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

/* ───────── Bandeja de Team (26-oct-2026) ─────────
 *
 *  Los chats del asesor en tres grupos, para que no tenga que entrar uno por
 *  uno a ver cuál le toca:
 *   · te_toca    el bot ya no contesta (bot_openia = 0) y lo último lo escribió
 *                el cliente: espera a una persona. El que más espera, primero.
 *   · esperando  el bot no contesta y lo último lo escribió alguien del equipo.
 *   · bot        el bot sigue contestando y el cliente escribió en las últimas
 *                24 h. El más reciente, primero.
 *  Con el bot encendido, el chat sale de «bot» cuando lo último que le escribió
 *  el equipo fue de una persona y no del bot: el bot calla mientras el asesor
 *  está en la conversación (ajustesIA, 45 min), así que si el cliente volvió a
 *  escribir le toca al asesor, y si no, espera al cliente. Antes se quedaba en
 *  verde y nadie lo contestaba (26-oct: 22 chats de la 265, hasta 2 h).
 *  Lo que manda el bot (responsable IA_…) no cuenta como «alguien del equipo»:
 *  si contara, el pase del bot («un asesor te escribe») dejaría el chat en
 *  «esperando» justo cuando le toca a una persona.
 *  El bot se apaga en un chat cuando él mismo lo pasa a una persona (ajuste
 *  soporte_expertos.callar_al_pasar) o cuando el asesor pulsa «Lo atiendo yo»;
 *  vuelve con «Devolver al bot» (POST …/bot). Mismo alcance que la lista: los
 *  chats del asesor y los en espera de sus canales.
 */
const BANDEJA_PERSONAS = 200;
const BANDEJA_BOT = 40; // solo el grupo verde; los que pasan a te_toca/esperando no se recortan
const BANDEJA_BOT_HORAS = 24;
// Un chat sin bot donde nadie escribió en 7 días no se muestra en «Te toca» ni
// en «Esperando» (vuelve solo si el cliente escribe). Sin esto, los chats
// apagados se acumulaban y uno de hace 3 meses quedaba arriba con «espera 90
// días». Las horas se miran en los últimos 30 días para no recorrer historias
// enteras cada 30 s (auditoría del 26-oct).
const BANDEJA_DIAS_VIVO = 7;
const BANDEJA_DIAS_HISTORIA = 30;
// Clientes con mensajes en 24 h que se miran antes de aplicar el alcance del
// asesor: con 400 se perdían chats suyos en la 265.
const BANDEJA_RECIENTES = 1500;
// Lo mismo que esResponsableHumano (utils/ajustesIA.js), en SQL, más
// «Automatizador | Cotizador», que en la 265 manda ~200 mensajes por semana y
// no es una persona. La comparación no distingue mayúsculas (collation _ci).
const SQL_ES_PERSONA = `m.responsable IS NOT NULL AND TRIM(m.responsable) <> ''
       AND m.responsable NOT REGEXP '^(IA_|IA$|cron_|dropi|aliclik|sistema|instagram|messenger|respondedor|encuesta|automatizador|bot([^a-z0-9_]|$))'`;

// El pase del bot a una persona: el mismo criterio que esPase
// (utils/soporteExpertos/escalado.js, rama del agente 265). Si cambia allá,
// cambia aquí. Sin callar_al_pasar el bot sigue encendido después del pase y,
// sin esto, el chat se quedaba en verde aunque el cliente espera a alguien.
const RE_PASE_BOT =
  /\b(?:(?:un|tu) asesor (?:(?:lo|la|los|las) )?revis\w*|asesor (?:te|le) escrib\w*|lo sumo a tu caso|tu caso pasa a|el area de [a-z]+ (?:revisa|lleva|te escribe)|las lleva el area)\b/;
const llanoPase = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
const esPaseDelBot = (texto) => RE_PASE_BOT.test(llanoPase(texto));

/** Fecha de chat_center (Date, o texto en hora de Ecuador sin zona) a milisegundos. */
const fechaChat = (v) => {
  if (!v) return 0;
  // db.query devuelve DATETIME como Date (el instante real); String(Date) no se
  // puede volver a leer y daba 0: el chat apagado desaparecía de la bandeja.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 0 : v.getTime();
  const s = String(v);
  const n = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + '-05:00').getTime();
  return Number.isNaN(n) ? 0 : n;
};

/** El grupo de un chat sin bot según quién escribió último. */
function grupoSinBot(ultCliente, ultPersona) {
  if (!ultCliente) return 'esperando';
  if (!ultPersona) return 'te_toca';
  return fechaChat(ultCliente) > fechaChat(ultPersona) ? 'te_toca' : 'esperando';
}

/*  GET /api/v1/equipo/bandeja?id_configuracion= */
exports.bandeja = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  if (!cfg) return next(new AppError('Conexión no válida', 404));
  const filtroCanal = sqlFiltroCanales(await canalesDeUsuarioEnConfig(u.id_sub_usuario, cfg.id));
  const alcance = `c.id_configuracion = ? AND c.propietario != 1 AND c.chat_cerrado = 0
        AND (c.id_encargado = ? OR (c.id_encargado IS NULL${filtroCanal ? ` AND ${filtroCanal}` : ''}))`;
  const SEL = (t) => db.query(t[0], { replacements: t[1], type: db.QueryTypes.SELECT });

  // 1. Los chats sin bot (pocos: los que atiende una persona).
  const sinBot = await SEL([
    `SELECT c.id, c.nombre_cliente, c.apellido_cliente, c.celular_cliente, c.source, c.id_encargado
       FROM clientes_chat_center c
      WHERE ${alcance} AND c.bot_openia = 0
      ORDER BY c.id DESC
      LIMIT ${BANDEJA_PERSONAS}`,
    [cfg.id, u.id_sub_usuario],
  ]);

  // 2. Los chats con bot donde el cliente escribió hace poco.
  const recientes = await SEL([
    `SELECT m.celular_recibe AS id, MAX(m.created_at) AS ult_cliente
       FROM mensajes_clientes m
      WHERE m.id_configuracion = ? AND m.rol_mensaje = 0 AND m.deleted_at IS NULL
        AND m.created_at >= NOW() - INTERVAL ${BANDEJA_BOT_HORAS} HOUR
      GROUP BY m.celular_recibe
      ORDER BY ult_cliente DESC
      LIMIT ${BANDEJA_RECIENTES}`,
    [cfg.id],
  ]);
  const idsRecientes = recientes.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
  const conBot = idsRecientes.length
    ? await SEL([
        `SELECT c.id, c.nombre_cliente, c.apellido_cliente, c.celular_cliente, c.source, c.id_encargado
           FROM clientes_chat_center c
          WHERE ${alcance} AND c.bot_openia = 1 AND c.id IN (?)`,
        [cfg.id, u.id_sub_usuario, idsRecientes],
      ])
    : [];
  const ordenReciente = new Map(idsRecientes.map((id, i) => [id, i]));
  conBot.sort((a, b) => ordenReciente.get(Number(a.id)) - ordenReciente.get(Number(b.id)));
  // Todos se clasifican: recortar antes dejaba fuera chats donde ya entró un asesor.
  const bot = conBot;

  // 3. Quién escribió último en cada uno y desde cuándo espera el cliente.
  const todos = [...sinBot, ...bot];
  const ids = todos.map((c) => String(c.id));
  const tiempos = ids.length
    ? await SEL([
        `SELECT m.celular_recibe AS id,
                -- Un 👍 (reaction) o una edición del cliente no lo pone en «Te toca».
                MAX(CASE WHEN m.rol_mensaje = 0 AND (m.tipo_mensaje IS NULL OR m.tipo_mensaje NOT IN ('reaction', 'edit', 'revoke')) THEN m.created_at END) AS ult_cliente,
                MAX(CASE WHEN m.rol_mensaje = 1 AND ${SQL_ES_PERSONA} THEN m.created_at END) AS ult_persona,
                MAX(CASE WHEN m.tipo_mensaje IS NULL OR m.tipo_mensaje NOT IN ('reaction', 'edit', 'revoke') THEN m.id END) AS ult_id,
                MAX(CASE WHEN m.rol_mensaje = 1 AND NOT (${SQL_ES_PERSONA}) THEN m.id END) AS ult_bot_id
           FROM mensajes_clientes m
          WHERE m.id_configuracion = ? AND m.celular_recibe IN (?) AND m.deleted_at IS NULL AND m.rol_mensaje IN (0, 1)
            AND m.created_at >= NOW() - INTERVAL ${BANDEJA_DIAS_HISTORIA} DAY
          GROUP BY m.celular_recibe`,
        [cfg.id, ids],
      ])
    : [];
  const t = new Map(tiempos.map((f) => [String(f.id), f]));
  const ultIds = [...new Set(tiempos.flatMap((f) => [Number(f.ult_id), Number(f.ult_bot_id)]).filter(Boolean))];
  const ultimos = ultIds.length
    ? await SEL([
        `SELECT id, celular_recibe, tipo_mensaje, texto_mensaje, rol_mensaje, created_at FROM mensajes_clientes WHERE id IN (?)`,
        [ultIds],
      ])
    : [];
  const porId = new Map(ultimos.map((m) => [Number(m.id), m]));
  const ultimo = new Map(tiempos.map((f) => [String(f.id), porId.get(Number(f.ult_id))]).filter((e) => e[1]));
  const ultBot = new Map(tiempos.map((f) => [String(f.id), porId.get(Number(f.ult_bot_id))]).filter((e) => e[1]));

  const grupos = { te_toca: [], esperando: [], bot: [] };
  // Chats con bot donde lo último del bot fue pasarlo a una persona y nadie del
  // equipo escribió después: le toca a alguien aunque el bot siga encendido.
  const pasados = new Set(
    bot
      .filter((c) => {
        const tt = t.get(String(c.id)) || {};
        const b = ultBot.get(String(c.id));
        if (!b || !esPaseDelBot(b.texto_mensaje)) return false;
        return !tt.ult_persona || new Date(b.created_at) > new Date(tt.ult_persona);
      })
      .map((c) => Number(c.id)),
  );
  // Chats con bot donde una persona del equipo escribió después del bot (o el
  // bot nunca escribió): el bot está callado y el chat es del asesor.
  const conAsesor = new Set(
    bot
      .filter((c) => {
        if (pasados.has(Number(c.id))) return false;
        const tt = t.get(String(c.id)) || {};
        const b = ultBot.get(String(c.id));
        const persona = fechaChat(tt.ult_persona);
        return persona > 0 && persona > fechaChat(b && b.created_at);
      })
      .map((c) => Number(c.id)),
  );
  const fila = (c, grupo) => {
    const tt = t.get(String(c.id)) || {};
    const um = ultimo.get(String(c.id)) || {};
    return {
      id: c.id,
      nombre_cliente: c.nombre_cliente,
      apellido_cliente: c.apellido_cliente,
      celular_cliente: c.celular_cliente,
      source: c.source,
      es_mio: Number(c.id_encargado) === Number(u.id_sub_usuario),
      bandeja: grupo,
      bot: grupo === 'bot' || pasados.has(Number(c.id)) || conAsesor.has(Number(c.id)),
      pase: pasados.has(Number(c.id)),
      asesor: conAsesor.has(Number(c.id)),
      texto_mensaje: um.texto_mensaje ?? null,
      tipo_mensaje: um.tipo_mensaje ?? null,
      mensaje_created_at: um.created_at ?? null,
      ult_cliente: tt.ult_cliente ?? null,
      ult_persona: tt.ult_persona ?? null,
    };
  };
  const vivoDesde = Date.now() - BANDEJA_DIAS_VIVO * 86400000;
  for (const c of sinBot) {
    const tt = t.get(String(c.id)) || {};
    const ultimoMovimiento = Math.max(fechaChat(tt.ult_cliente), fechaChat(tt.ult_persona));
    if (ultimoMovimiento < vivoDesde) continue;
    const g = grupoSinBot(tt.ult_cliente, tt.ult_persona);
    grupos[g].push(fila(c, g));
  }
  for (const c of bot) {
    if (pasados.has(Number(c.id))) grupos.te_toca.push(fila(c, 'te_toca'));
    else if (conAsesor.has(Number(c.id))) {
      const tt = t.get(String(c.id)) || {};
      const g = grupoSinBot(tt.ult_cliente, tt.ult_persona);
      grupos[g].push(fila(c, g));
    } else if (grupos.bot.length < BANDEJA_BOT) grupos.bot.push(fila(c, 'bot'));
  }

  // Desde cuándo espera: si el bot lo pasó, desde el pase. Si no, el primer
  // mensaje del cliente después de lo último que le contestó alguien (persona
  // o bot); antes contaba desde el primer mensaje de toda la historia cuando
  // nadie del equipo había escrito nunca (auditoría del 26-oct).
  const porBuscar = [];
  for (const c of grupos.te_toca) {
    const b = ultBot.get(String(c.id));
    if (c.pase && b) c.espera_desde = b.created_at;
    else porBuscar.push([c, Math.max(fechaChat(c.ult_persona), fechaChat(b && b.created_at))]);
  }
  if (porBuscar.length) {
    const conds = porBuscar.map(() => '(m.celular_recibe = ? AND m.created_at > ?)').join(' OR ');
    const rep = [cfg.id];
    for (const [c, desde] of porBuscar) rep.push(String(c.id), new Date(desde || 0));
    const desde = await SEL([
      `SELECT m.celular_recibe AS id, MIN(m.created_at) AS desde
         FROM mensajes_clientes m
        WHERE m.id_configuracion = ? AND m.rol_mensaje = 0 AND m.deleted_at IS NULL AND (${conds})
        GROUP BY m.celular_recibe`,
      rep,
    ]);
    const d = new Map(desde.map((f) => [String(f.id), f.desde]));
    for (const [c] of porBuscar) c.espera_desde = d.get(String(c.id)) || c.ult_cliente;
  }
  const ms = (x) => (x ? new Date(x).getTime() : 0);
  grupos.te_toca.sort((a, b) => ms(a.espera_desde) - ms(b.espera_desde));
  grupos.esperando.sort((a, b) => ms(b.mensaje_created_at) - ms(a.mensaje_created_at));

  res.json({ status: 'success', data: grupos });
});

/*  POST /api/v1/equipo/chats/:id_cliente/bot  { id_configuracion, encender }
 *  «Devolver al bot» (encender: true) o «Lo atiendo yo» (false). */
exports.cambiarBot = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  if (req.sesionTeamSoloLectura) {
    return next(new AppError('Estás en «Ver como»: el chat es de solo lectura.', 403));
  }
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  if (typeof req.body?.encender !== 'boolean') return next(new AppError('Falta decir si el bot se enciende o se apaga.', 400));
  const encender = req.body.encender;
  const cfg = await conexionDeLaCuenta(req.body?.id_configuracion, u.id_usuario);
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return next(new AppError('Chat no encontrado', 404));
  await db.query('UPDATE clientes_chat_center SET bot_openia = ? WHERE id = ? AND id_configuracion = ?', {
    replacements: [encender ? 1 : 0, id_cliente, cfg.id],
    type: db.QueryTypes.UPDATE,
  });
  console.log(
    '[EQUIPO_BOT]',
    JSON.stringify({ id_sub_usuario: u.id_sub_usuario, team_usuario: req.sesionTeamUsuario || '', id_configuracion: cfg.id, id_cliente, encender }),
  );
  res.json({ status: 'success', data: { id: id_cliente, bot: encender } });
});

/* ───────── Pasar el chat a otro asesor (27-oct-2026) ─────────
 *
 *  Gerencia: «que podamos transferir a los asesores». Lo mismo que hace el
 *  botón de transferir de ImporChat dentro de la misma línea:
 *  - cambia el encargado y reabre el chat;
 *  - lo anota en historial_encargados;
 *  - deja la nota interna «X te transfirió este chat» (rol_mensaje 3, no le
 *    llega al cliente);
 *  - avisa al socket para que la pantalla vieja lo mueva.
 *  Puede pasarlo quien lo ve en Team: su dueño, o cualquiera si está en espera
 *  en sus canales. Es la regla de puedeTransferir.
 *  En «Ver como» SÍ se puede, a diferencia de contestar: gerencia mira la
 *  silla para repartir sus chats, y Team solo da «Ver como» a gerencia. Ahí la
 *  nota sale a nombre de «Gerencia» y el historial va sin autor, porque la
 *  sesión es la del asesor mirado, no la de quien lo pasa.
 */

const MensajesClientes = require('../models/mensaje_cliente.model');
const { crearHistorial } = require('../utils/historialEncargados');
const { enviarConsultaAPI } = require('../utils/webhook_whatsapp/enviar_consulta_socket');
const { puedeEntrarDesdeTeam } = require('../utils/rolEquipo');

const MAX_MOTIVO = 200;

/*  Los asesores vigentes de la cuenta que atienden la línea (están en uno de
 *  sus departamentos). Primero los que trabajan desde Team; después, por nombre.
 *  Solo id y nombre: sin correo ni teléfono. */
async function asesoresDeLaLinea(cfg, id_usuario) {
  const filas = await db.query(
    `SELECT s.id_sub_usuario, s.id_usuario, s.rol, s.nombre_encargado, MIN(d.id_departamento) AS id_departamento
       FROM sub_usuarios_chat_center s
       INNER JOIN sub_usuarios_departamento sd ON sd.id_sub_usuario = s.id_sub_usuario
       INNER JOIN departamentos_chat_center d ON d.id_departamento = sd.id_departamento
      WHERE s.id_usuario = ? AND s.suspendido = 0 AND d.id_configuracion = ?
      GROUP BY s.id_sub_usuario, s.id_usuario, s.rol, s.nombre_encargado`,
    { replacements: [Number(id_usuario), cfg.id], type: db.QueryTypes.SELECT },
  );
  return filas
    .map((f) => ({
      id: Number(f.id_sub_usuario),
      nombre: String(f.nombre_encargado || `Asesor ${f.id_sub_usuario}`).trim(),
      en_team: puedeEntrarDesdeTeam(f),
      id_departamento: Number(f.id_departamento) || null,
    }))
    .sort((a, b) => Number(b.en_team) - Number(a.en_team) || a.nombre.localeCompare(b.nombre, 'es'));
}

/*  GET /api/v1/equipo/asesores?id_configuracion= — a quién se le puede pasar un chat. */
exports.asesores = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  if (!cfg) return next(new AppError('Conexión no válida', 404));
  const lista = await asesoresDeLaLinea(cfg, u.id_usuario);
  res.json({ status: 'success', data: lista.map(({ id, nombre, en_team }) => ({ id, nombre, en_team, soy_yo: id === Number(u.id_sub_usuario) })) });
});

/*  POST /api/v1/equipo/chats/:id_cliente/transferir  { id_configuracion, a_sub, motivo } */
exports.transferir = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const a_sub = Number(req.body?.a_sub);
  if (!Number.isInteger(a_sub) || a_sub <= 0) return next(new AppError('Elige a quién pasarle el chat.', 400));
  const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.replace(/\s+/g, ' ').trim().slice(0, MAX_MOTIVO) : '';

  const cfg = await conexionDeLaCuenta(req.body?.id_configuracion, u.id_usuario);
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return next(new AppError('Chat no encontrado', 404));
  const antes = chat.id_encargado == null ? null : Number(chat.id_encargado);
  if (antes === a_sub) return next(new AppError('El chat ya es de esa persona.', 409));
  const destino = (await asesoresDeLaLinea(cfg, u.id_usuario)).find((a) => a.id === a_sub);
  if (!destino) return next(new AppError('Esa persona no atiende esta línea.', 422));

  // Solo si nadie lo movió entre que se abrió y ahora (otro asesor lo tomó).
  const r = await db.query(
    `UPDATE clientes_chat_center SET id_encargado = ?, chat_cerrado = 0
      WHERE id = ? AND id_configuracion = ? AND id_encargado <=> ?`,
    { replacements: [a_sub, id_cliente, cfg.id, antes], type: db.QueryTypes.UPDATE },
  );
  if ((Array.isArray(r) ? r[1] : r) === 0) {
    return next(new AppError('Alguien acaba de mover este chat. Actualiza la lista.', 409));
  }

  const verComo = req.sesionTeamSoloLectura === true;
  const emisor = verComo ? 'Gerencia' : u.nombre_encargado || 'Un asesor';
  const registro = { id_sub_usuario: u.id_sub_usuario, team_usuario: req.sesionTeamUsuario || '', ver_como: verComo, id_configuracion: cfg.id, id_cliente, de: antes, a: a_sub };
  // El cambio ya está hecho: perder el historial o la nota no lo deshace.
  try {
    await crearHistorial(
      {
        id_cliente_chat_center: id_cliente,
        id_departamento_asginado: destino.id_departamento,
        id_encargado_anterior: antes,
        id_encargado_nuevo: a_sub,
        motivo: `${verComo ? 'Gerencia desde Team' : 'Desde Team'}${motivo ? `: ${motivo}` : ''}`,
      },
      verComo ? null : u.id_sub_usuario,
    );
  } catch (e) {
    console.warn('[EQUIPO_TRANSFERIR] sin historial —', e.message);
  }
  try {
    const [linea] = await db.query(
      `SELECT c.id, cfg.id_telefono FROM clientes_chat_center c
         INNER JOIN configuraciones cfg ON cfg.id = c.id_configuracion
        WHERE c.id_configuracion = ? AND c.propietario = 1 ORDER BY c.id LIMIT 1`,
      { replacements: [cfg.id], type: db.QueryTypes.SELECT },
    );
    if (linea) {
      await MensajesClientes.create({
        id_configuracion: cfg.id,
        id_cliente: linea.id,
        mid_mensaje: linea.id_telefono,
        tipo_mensaje: 'notificacion',
        visto: 0,
        texto_mensaje: `${emisor} te transfirió este chat. Motivo: ${motivo || 'sin motivo'}`,
        rol_mensaje: 3,
        celular_recibe: id_cliente,
        uid_whatsapp: chat.celular_cliente,
      });
    }
  } catch (e) {
    console.warn('[EQUIPO_TRANSFERIR] sin nota —', e.message);
  }
  enviarConsultaAPI(cfg.id, id_cliente).catch(() => {});
  console.log('[EQUIPO_TRANSFERIR]', JSON.stringify(registro));
  res.json({ status: 'success', data: { id: id_cliente, a_sub, nombre: destino.nombre } });
});

/* ───────── Cerrar el chat desde Team (27-oct-2026) ─────────
 *
 *  Gerencia: «hay el botón de cerrar chats». Lo mismo que el botón de cerrar
 *  de ImporChat (clientes_chat_center.actualizar_cerrado):
 *  - chat_cerrado = 1 y la hora del cierre; el bot vuelve a encenderse (es lo
 *    que manda la pantalla de ImporChat al cerrar);
 *  - si la cuenta lo tiene así en /kanban_config, el contacto vuelve a la
 *    columna principal;
 *  - avisa al tablero (chat resuelto) y deja la nota interna «Chat cerrado por
 *    X — fecha» (rol_mensaje 3, el cliente no la ve).
 *  - programa la encuesta de satisfacción al cliente, como ImporChat, si la
 *    cuenta la tiene con «enviar al cerrar» (gerencia, 27-oct-2026: «que al
 *    cerrar desde Team también se mande la encuesta»). Solo WhatsApp. Para
 *    apagarla sin tocar el código: ENCUESTA_AL_CERRAR_DESDE_TEAM=0.
 *  En «Ver como» se puede, igual que pasar el chat: la nota sale a nombre de
 *  «Gerencia».
 */

const dashboardEmitter = require('./dashboardEmitter');
const { getKanbanConfigCuenta } = require('../utils/kanbanConfigCuenta');

async function columnaPrincipal(id_configuracion) {
  const [col] = await db.query(
    `SELECT estado_db FROM kanban_columnas
      WHERE id_configuracion = ? AND es_principal = 1 AND activo = 1 AND id_tablero IS NULL
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return col?.estado_db || 'contacto_inicial';
}

/*  POST /api/v1/equipo/chats/:id_cliente/cerrar  { id_configuracion } */
exports.cerrar = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const cfg = await conexionDeLaCuenta(req.body?.id_configuracion, u.id_usuario);
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return next(new AppError('Chat no encontrado', 404));

  let volver_al_cerrar = true;
  try {
    ({ volver_al_cerrar } = await getKanbanConfigCuenta(cfg.id));
  } catch (e) {
    console.warn('[EQUIPO_CERRAR] sin ajuste del kanban —', e.message);
  }
  const sets = ['chat_cerrado = 1', 'bot_openia = 1', 'chat_cerrado_at = NOW()'];
  const valores = [];
  if (volver_al_cerrar) {
    sets.push('estado_contacto = ?');
    valores.push(await columnaPrincipal(cfg.id));
  }
  // Solo si seguía abierto: dos asesores cerrando a la vez dejan una sola nota.
  const r = await db.query(
    `UPDATE clientes_chat_center SET ${sets.join(', ')}
      WHERE id = ? AND id_configuracion = ? AND COALESCE(chat_cerrado, 0) = 0`,
    { replacements: [...valores, id_cliente, cfg.id], type: db.QueryTypes.UPDATE },
  );
  if ((Array.isArray(r) ? r[1] : r) === 0) {
    return next(new AppError('Este chat ya estaba cerrado. Actualiza la lista.', 409));
  }

  const verComo = req.sesionTeamSoloLectura === true;
  const quien = verComo ? 'Gerencia' : u.nombre_encargado || 'un asesor';
  // El cierre ya está hecho: perder el aviso o la nota no lo deshace.
  dashboardEmitter.emitByConfig(cfg.id, 'chat_resolved', { chatsResolved: 1 }).catch(() => {});
  try {
    const [linea] = await db.query(
      `SELECT c.id, cfg.id_telefono FROM clientes_chat_center c
         INNER JOIN configuraciones cfg ON cfg.id = c.id_configuracion
        WHERE c.id_configuracion = ? AND c.propietario = 1 ORDER BY c.id LIMIT 1`,
      { replacements: [cfg.id], type: db.QueryTypes.SELECT },
    );
    if (linea) {
      const cuando = new Date().toLocaleString('es-EC', {
        timeZone: 'America/Guayaquil',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      await MensajesClientes.create({
        id_configuracion: cfg.id,
        id_cliente: linea.id,
        mid_mensaje: linea.id_telefono,
        tipo_mensaje: 'notificacion',
        visto: 0,
        texto_mensaje: `Chat cerrado por ${quien} — ${cuando}`,
        rol_mensaje: 3,
        celular_recibe: id_cliente,
        uid_whatsapp: chat.celular_cliente,
      });
    }
  } catch (e) {
    console.warn('[EQUIPO_CERRAR] sin nota —', e.message);
  }
  enviarConsultaAPI(cfg.id, id_cliente).catch(() => {});

  let encuesta = 'no aplica';
  if (process.env.ENCUESTA_AL_CERRAR_DESDE_TEAM !== '0' && (!chat.source || chat.source === 'wa')) {
    try {
      const { intentarEnviarEncuesta } = require('../utils/encuestaSatisfaccion');
      const [d] = await db.query('SELECT nombre_cliente, id_encargado FROM clientes_chat_center WHERE id = ? LIMIT 1', {
        replacements: [id_cliente],
        type: db.QueryTypes.SELECT,
      });
      const rr = await intentarEnviarEncuesta({
        idConfiguracion: cfg.id,
        idClienteChatCenter: id_cliente,
        idEncargado: d?.id_encargado || u.id_sub_usuario || null,
        nombreCliente: d?.nombre_cliente || '',
      });
      encuesta = rr.programado ? 'programada' : `no: ${rr.razon}`;
    } catch (e) {
      encuesta = 'error';
      console.warn('[EQUIPO_CERRAR] encuesta —', e.message);
    }
  }
  console.log(
    '[EQUIPO_CERRAR]',
    JSON.stringify({ id_sub_usuario: u.id_sub_usuario, team_usuario: req.sesionTeamUsuario || '', ver_como: verComo, id_configuracion: cfg.id, id_cliente, encuesta }),
  );
  res.json({ status: 'success', data: { id: id_cliente, cerrado: true } });
});

/* ───────── Responder desde Team ───────── */

const MAX_TEXTO = 4096; // lo que acepta WhatsApp en un mensaje de texto
const VENTANA_HORAS = 24;
const TOPE_ENVIOS = 20; // por asesor, por minuto
const notaDeVoz = require('../utils/notaDeVoz');
const imagenTeam = require('../utils/imagenTeam');
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

/*  Controles comunes a contestar con texto y con nota de voz. Devuelve
 *  { error } o lo necesario para enviar. Solo chats de WhatsApp que el asesor
 *  ve (los suyos y los en espera de sus canales) y solo dentro de las 24 h
 *  desde el último mensaje del cliente: fuera de esa ventana WhatsApp solo
 *  deja mandar plantillas, y Meta aceptaría el envío para descartarlo después
 *  sin que el asesor se entere. El número lo pone el servidor a partir del
 *  chat; Team no lo manda ni lo recibe. */
async function prepararEnvio(req, id_cliente, o = {}) {
  const u = req.sessionUser;
  const cfg = await conexionDeLaCuenta(req.body?.id_configuracion, u.id_usuario);
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return { error: new AppError('Chat no encontrado', 404) };
  if (String(chat.source || 'wa').toLowerCase() !== 'wa') {
    return { error: new AppError('Desde Team por ahora solo se contesta por WhatsApp.', 422) };
  }
  // Las plantillas aprobadas por Meta sí salen fuera de la ventana (o.sinVentana).
  const [ultimo] = o.sinVentana ? [{ ult: true }] : await db.query(
    `SELECT MAX(created_at) AS ult FROM mensajes_clientes
      WHERE celular_recibe = ? AND id_configuracion = ? AND rol_mensaje = 0 AND deleted_at IS NULL
        AND created_at > NOW() - INTERVAL ${VENTANA_HORAS} HOUR`,
    { replacements: [String(id_cliente), cfg.id], type: db.QueryTypes.SELECT },
  );
  if (!ultimo?.ult) {
    return {
      error: new AppError(
        'El cliente no escribe desde hace más de 24 horas: WhatsApp no deja mandarle un mensaje libre. Usa una plantilla desde ImporChat.',
        422,
      ),
    };
  }
  if (!o.sinTope && !pasaElTope(Number(u.id_sub_usuario))) {
    return { error: new AppError('Vas muy rápido: espera un minuto y vuelve a enviar.', 429) };
  }
  const chatService = new ChatService();
  const dataAdmin = await chatService.getDataAdmin(cfg.id);
  if (!dataAdmin?.id_telefono || !dataAdmin?.token) {
    return { error: new AppError('La línea no está lista para enviar.', 503) };
  }
  return {
    u,
    cfg,
    chat,
    chatService,
    dataAdmin,
    to: String(chat.celular_cliente || '').replace(/\s+/g, '').replace(/^\+/, ''),
    registro: { id_sub_usuario: u.id_sub_usuario, id_configuracion: cfg.id, id_cliente, team_usuario: req.sesionTeamUsuario || '' },
  };
}

// Lo mismo que Team pinta de un mensaje; sin el wamid (lleva el número).
function mensajeParaTeam(m, u, tipo, texto, ruta) {
  return {
    id: m?.id || null,
    rol_mensaje: 1,
    tipo_mensaje: tipo,
    texto_mensaje: m?.texto_mensaje ?? texto,
    ruta_archivo: ruta,
    responsable: m?.responsable ?? u.nombre_encargado ?? null,
    created_at: m?.created_at || new Date(),
    eliminado_at: null,
  };
}

/*  POST /api/v1/equipo/chats/:id_cliente/mensajes  { id_configuracion, texto }
 *  Le contesta al cliente con un texto por la línea oficial: el mismo envío
 *  que la pantalla vieja (ChatService.sendMessage, que también lo guarda en
 *  mensajes_clientes con el nombre del asesor). */
exports.enviarMensaje = catchAsync(async (req, res, next) => {
  if (req.sesionTeamSoloLectura) {
    return next(new AppError('Estás en «Ver como»: el chat es de solo lectura.', 403));
  }
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const texto = typeof req.body?.texto === 'string' ? req.body.texto.replace(/\r\n?/g, '\n').trim() : '';
  if (!texto) return next(new AppError('Escribe el mensaje.', 400));
  if (texto.length > MAX_TEXTO) return next(new AppError(`El mensaje es muy largo (máximo ${MAX_TEXTO} caracteres).`, 400));

  const p = await prepararEnvio(req, id_cliente);
  if (p.error) return next(p.error);
  let resp;
  try {
    resp = await p.chatService.sendMessage({
      mensaje: texto,
      to: p.to,
      dataAdmin: p.dataAdmin,
      tipo_mensaje: 'text',
      id_configuracion: p.cfg.id,
      nombre_encargado: p.u.nombre_encargado,
    });
  } catch (e) {
    console.log('[EQUIPO_ENVIO]', JSON.stringify({ ...p.registro, ok: false }));
    return next(new AppError('WhatsApp no aceptó el mensaje. Vuelve a intentar en un momento.', 502));
  }
  const m = resp?.mensajeNuevo;
  console.log('[EQUIPO_ENVIO]', JSON.stringify({ ...p.registro, ok: true, id_mensaje: m?.id || null }));
  res.json({ status: 'success', data: mensajeParaTeam(m, p.u, 'text', texto, null) });
});

/*  POST /api/v1/equipo/chats/:id_cliente/audio  multipart { id_configuracion, audio }
 *  Nota de voz grabada en Team. Se pasa a ogg/opus, se sube al almacén de
 *  ImporChat y sale por el mismo ChatService.sendMessage que usa la pantalla
 *  vieja para los audios: llega al cliente como nota de voz y queda en el
 *  historial como tipo «audio». Mismas reglas que el texto. */
exports.enviarAudio = catchAsync(async (req, res, next) => {
  if (req.sesionTeamSoloLectura) {
    return next(new AppError('Estás en «Ver como»: el chat es de solo lectura.', 403));
  }
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const f = req.file;
  if (!f || !f.buffer || !f.buffer.length) return next(new AppError('Graba la nota de voz.', 400));
  if (!/^(audio|video)\//i.test(String(f.mimetype || ''))) {
    return next(new AppError('Eso no es una grabación de audio.', 400));
  }

  const p = await prepararEnvio(req, id_cliente);
  if (p.error) return next(p.error);

  let ogg, segundos;
  try {
    ({ ogg, segundos } = await notaDeVoz.convertirAOggOpus(f.buffer));
  } catch (e) {
    console.log('[EQUIPO_AUDIO]', JSON.stringify({ ...p.registro, ok: false, paso: 'convertir' }));
    return next(new AppError('No se pudo leer la grabación. Vuelve a grabarla.', 400));
  }
  if (segundos !== null && segundos < notaDeVoz.MIN_SEGUNDOS) {
    return next(new AppError('La nota de voz salió vacía. Vuelve a grabarla.', 400));
  }
  let url;
  try {
    url = await notaDeVoz.subirAlUploader(ogg);
  } catch (e) {
    console.log('[EQUIPO_AUDIO]', JSON.stringify({ ...p.registro, ok: false, paso: 'subir' }));
    return next(new AppError('No se pudo guardar la nota de voz. Vuelve a intentar en un momento.', 502));
  }
  let resp;
  try {
    // tipo «document» con una URL de audio: chat.service la manda como nota de voz.
    resp = await p.chatService.sendMessage({
      mensaje: '',
      to: p.to,
      dataAdmin: p.dataAdmin,
      tipo_mensaje: 'document',
      ruta_archivo: url,
      id_configuracion: p.cfg.id,
      nombre_encargado: p.u.nombre_encargado,
    });
  } catch (e) {
    console.log('[EQUIPO_AUDIO]', JSON.stringify({ ...p.registro, ok: false, paso: 'whatsapp' }));
    return next(new AppError('WhatsApp no aceptó la nota de voz. Vuelve a intentar en un momento.', 502));
  }
  const m = resp?.mensajeNuevo;
  console.log('[EQUIPO_AUDIO]', JSON.stringify({ ...p.registro, ok: true, segundos, id_mensaje: m?.id || null }));
  res.json({ status: 'success', data: mensajeParaTeam(m, p.u, 'audio', '', m?.ruta_archivo || url) });
});

/*  POST /api/v1/equipo/chats/:id_cliente/imagen  multipart { id_configuracion, imagen, texto? }
 *  Foto desde Team (galería o cámara del celular). Team ya la manda achicada
 *  a JPG; se comprueba, se sube al almacén de ImporChat y sale por
 *  ChatService.sendMessage como imagen de WhatsApp, con el texto como
 *  leyenda. Mismas reglas que el texto. */
exports.enviarImagen = catchAsync(async (req, res, next) => {
  if (req.sesionTeamSoloLectura) {
    return next(new AppError('Estás en «Ver como»: el chat es de solo lectura.', 403));
  }
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const f = req.file;
  if (!f || !f.buffer || !f.buffer.length) return next(new AppError('Elige la foto.', 400));
  const tipo = imagenTeam.tipoDeImagen(f.buffer);
  if (!tipo) return next(new AppError('Esa foto no se puede mandar: usa una imagen JPG o PNG.', 400));
  if (f.buffer.length > imagenTeam.MAX_BYTES) {
    return next(new AppError('La foto pesa más de 5 MB. Elige una más liviana.', 413));
  }
  const leyenda = typeof req.body?.texto === 'string' ? req.body.texto.replace(/\r\n?/g, '\n').trim() : '';
  if (leyenda.length > imagenTeam.MAX_LEYENDA) {
    return next(new AppError(`El texto de la foto es muy largo (máximo ${imagenTeam.MAX_LEYENDA} caracteres).`, 400));
  }

  const p = await prepararEnvio(req, id_cliente);
  if (p.error) return next(p.error);

  let url;
  try {
    url = await imagenTeam.subirImagen(f.buffer, tipo);
  } catch (e) {
    console.log('[EQUIPO_IMAGEN]', JSON.stringify({ ...p.registro, ok: false, paso: 'subir' }));
    return next(new AppError('No se pudo guardar la foto. Vuelve a intentar en un momento.', 502));
  }
  let resp;
  try {
    resp = await p.chatService.sendMessage({
      mensaje: leyenda,
      to: p.to,
      dataAdmin: p.dataAdmin,
      tipo_mensaje: 'image',
      ruta_archivo: url,
      id_configuracion: p.cfg.id,
      nombre_encargado: p.u.nombre_encargado,
    });
  } catch (e) {
    console.log('[EQUIPO_IMAGEN]', JSON.stringify({ ...p.registro, ok: false, paso: 'whatsapp' }));
    return next(new AppError('WhatsApp no aceptó la foto. Vuelve a intentar en un momento.', 502));
  }
  const m = resp?.mensajeNuevo;
  console.log('[EQUIPO_IMAGEN]', JSON.stringify({ ...p.registro, ok: true, bytes: f.buffer.length, id_mensaje: m?.id || null }));
  res.json({ status: 'success', data: mensajeParaTeam(m, p.u, 'image', leyenda, m?.ruta_archivo || url) });
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

const historialMod = require('../utils/historialCargas');

/*  GET /api/v1/equipo/chats/:id_cliente/historial-cargas?id_configuracion=
 *  Todas las cotizaciones del número de ese chat (también las entregadas y las
 *  que no avanzaron) para que el asesor tenga la información a mano. Solo
 *  lectura, sin montos; el número se queda en el servidor. */
exports.historialCargas = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const cfg = await conexionDeLaCuenta(req.query.id_configuracion, u.id_usuario);
  const chat = cfg && (await chatVisible(id_cliente, cfg, u));
  if (!chat) return next(new AppError('Chat no encontrado', 404));
  const celular = String(chat.celular_cliente || '');
  const r = await historialMod.historialDelTelefono(celular);
  res.json({ status: 'success', data: taparTelefonos(r, { telefonosConocidos: [celular] }) });
});

const plantillaCarga = require('../utils/plantillaCarga');
const PLANTILLA_REPETIDA_MIN = 10;

/*  POST /api/v1/equipo/chats/:id_cliente/enviar-informacion
 *    { id_configuracion }                          → vista previa, no envía
 *    { id_configuracion, confirmar, id_cotizacion } → envía la plantilla
 *  Botón «Enviar información» de la Agenda: la plantilla aprobada
 *  carga_novedad_contenedor con la carga más reciente del cliente que ya está
 *  en un contenedor. Es plantilla, así que sale también fuera de las 24 h.
 *  Mismas reglas que el resto: número tapado, solo chats de la silla, «Ver
 *  como» no envía. Se confirma con la carga que vio el asesor: si cambió entre
 *  la vista previa y el envío, no se manda. */
exports.enviarInformacion = catchAsync(async (req, res, next) => {
  if (req.sesionTeamSoloLectura) {
    return next(new AppError('Estás en «Ver como»: el chat es de solo lectura.', 403));
  }
  const id_cliente = Number(req.params.id_cliente);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0) return next(new AppError('Chat no válido', 400));
  const confirmar = req.body?.confirmar === true || req.body?.confirmar === 'true' || req.body?.confirmar === '1';
  const idCot = Number(req.body?.id_cotizacion);
  if (confirmar && (!Number.isInteger(idCot) || idCot <= 0)) return next(new AppError('Falta la carga a informar.', 400));

  // El tope de envíos se mira justo antes de mandar: la vista previa y los rechazos no cuentan.
  const p = await prepararEnvio(req, id_cliente, { sinVentana: true, sinTope: true });
  if (p.error) return next(p.error);
  if (Number(p.cfg.id) !== plantillaCarga.LINEA) {
    return next(new AppError('«Enviar información» solo funciona en la línea de Soporte Importaciones.', 422));
  }
  const celular = String(p.chat.celular_cliente || '');
  const h = await historialMod.historialDelTelefono(celular);
  if (h.estado === 'error') return next(new AppError('No se pudieron leer las cargas del cliente. Vuelve a intentar en un momento.', 502));
  if (h.estado === 'varios_clientes') {
    return next(new AppError('Este número está en cotizaciones de dos clientes: manda la información a mano.', 422));
  }
  const carga = plantillaCarga.elegirCarga(h.cotizaciones, confirmar ? idCot : null);
  if (!carga) {
    return next(confirmar
      ? new AppError('La carga cambió o ya no está en un contenedor: vuelve a abrir «Enviar información».', 409)
      : new AppError('Este cliente no tiene una carga en contenedor sin entregar: no hay información que mandar.', 422));
  }
  const prm = plantillaCarga.parametros(carga, h.cliente);
  const texto = plantillaCarga.textoFinal(prm);
  const registro = { ...p.registro, id_cotizacion: carga.id_cotizacion };

  if (!confirmar) {
    return res.json({
      status: 'success',
      data: taparTelefonos({ id_cotizacion: carga.id_cotizacion, contenedor: prm[2], texto }, { telefonosConocidos: [celular] }),
    });
  }

  const [repetida] = await db.query(
    `SELECT COUNT(*) AS n FROM mensajes_clientes
      WHERE celular_recibe = ? AND id_configuracion = ? AND template_name = ? AND rol_mensaje = 1
        AND created_at > NOW() - INTERVAL ${PLANTILLA_REPETIDA_MIN} MINUTE`,
    { replacements: [String(id_cliente), p.cfg.id, plantillaCarga.NOMBRE], type: db.QueryTypes.SELECT },
  );
  if (Number(repetida?.n) > 0) {
    return next(new AppError(`Ya se le mandó esta información hace menos de ${PLANTILLA_REPETIDA_MIN} minutos.`, 409));
  }

  if (!pasaElTope(Number(p.u.id_sub_usuario))) {
    return next(new AppError('Vas muy rápido: espera un minuto y vuelve a enviar.', 429));
  }
  let envio;
  try {
    envio = await plantillaCarga.enviar({ dataAdmin: p.dataAdmin, to: p.to, p: prm });
  } catch (e) {
    // El mensaje de Meta puede traer el número: solo al log del servidor, tapado.
    console.log('[EQUIPO_PLANTILLA]', JSON.stringify({ ...registro, ok: false, error: taparTelefonos(String(e.message || ''), { telefonosConocidos: [celular] }) }));
    return next(new AppError('WhatsApp no aceptó la plantilla. Vuelve a intentar en un momento.', 502));
  }

  let m = null;
  try {
    const [propia] = await db.query(
      `SELECT c.id FROM clientes_chat_center c WHERE c.propietario = 1 AND c.id_configuracion = ? LIMIT 1`,
      { replacements: [p.cfg.id], type: db.QueryTypes.SELECT },
    );
    m = await MensajesClientes.create({
      id_configuracion: p.cfg.id,
      id_cliente: propia?.id || null,
      source: 'wa',
      mid_mensaje: p.dataAdmin.id_telefono,
      tipo_mensaje: 'template',
      rol_mensaje: 1,
      celular_recibe: String(id_cliente),
      responsable: p.u.nombre_encargado,
      uid_whatsapp: p.to,
      id_wamid_mensaje: envio.wamid,
      texto_mensaje: texto,
      ruta_archivo: JSON.stringify({ placeholders: prm, header: null, template_name: plantillaCarga.NOMBRE, language: plantillaCarga.IDIOMA }),
      template_name: plantillaCarga.NOMBRE,
      language_code: plantillaCarga.IDIOMA,
      informacion_suficiente: 1,
      visto: 0,
    });
  } catch (e) {
    // Ya salió: no se dice que falló, solo que no quedó en el historial.
    console.warn('[EQUIPO_PLANTILLA] enviada pero no guardada —', e.message);
  }
  console.log('[EQUIPO_PLANTILLA]', JSON.stringify({ ...registro, ok: true, estado: envio.estado, id_mensaje: m?.id || null }));
  res.json({ status: 'success', data: taparTelefonos(mensajeParaTeam(m, p.u, 'template', texto, null), { telefonosConocidos: [celular] }) });
});
