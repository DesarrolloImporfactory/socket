const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const {
  enviarConsultaAPI,
} = require('../utils/webhook_whatsapp/enviar_consulta_socket');

// Bitácora de incidencias por chat (contacto). La escriben los asesores que
// confirman órdenes: intentos de llamada, mensajes, etc. Cada uno solo puede
// borrar las suyas.
//
// Desde el 2026-09-28 una incidencia puede ser además un CASO: «Escalar» u
// «Oportunidad Comercial». El caso tiene tipo, destinatario y estado (sin
// resolver / resuelto) y deja una nota automática en la conversación. Quién
// recibe cada tipo, y en qué conexiones hay botones, lo dice la tabla
// incidencias_casos_destinatarios (ver incidencias_casos_migration.sql).

/** Tipos de caso: el texto de la nota que queda en el chat. */
const TIPOS_CASO = {
  escalamiento: { accion: 'escaló este caso a' },
  oportunidad: { accion: 'marcó una oportunidad comercial para' },
};

const TIPO_LABEL = {
  escalamiento: 'el escalamiento',
  oportunidad: 'la oportunidad comercial',
};

/** Roles de sub_usuarios_chat_center que ven y resuelven todos los casos de su cuenta. */
const ROLES_ADMIN = ['administrador', 'super_administrador'];

// ¿Ya se corrieron las migraciones? Mientras no, Incidencias sigue exactamente
// como antes. Mismo esquema de caché que utils/historialEncargados.js: una
// columna que falta se vuelve a mirar cada 5 minutos.
//   escalado_resuelto → incidencias_casos_migration.sql (parte 1: casos)
//   estado_caso       → incidencias_casos_estado_migration.sql (parte 2: «en espera»)
const columnasCache = {};
const RECHECK_MS = 5 * 60 * 1000;

async function tieneColumna(columna) {
  const ahora = Date.now();
  const c = columnasCache[columna];
  if (c?.ok === true) return true;
  if (c?.ok === false && ahora - c.at < RECHECK_MS) return false;
  let ok = false;
  try {
    const rows = await db.query(
      `SHOW COLUMNS FROM incidencias_chat_center LIKE '${columna}'`,
      { type: db.QueryTypes.SELECT },
    );
    ok = rows.length > 0;
  } catch (_) {
    ok = false;
  }
  columnasCache[columna] = { ok, at: ahora };
  return ok;
}

const tieneMigracionCasos = () => tieneColumna('escalado_resuelto');
const tieneEstadoCaso = () => tieneColumna('estado_caso');

// Línea de tiempo del caso → incidencias_casos_eventos_migration.sql (parte 3).
let eventosCache = null;
async function tieneEventos() {
  const ahora = Date.now();
  if (eventosCache?.ok === true) return true;
  if (eventosCache?.ok === false && ahora - eventosCache.at < RECHECK_MS) return false;
  let ok = false;
  try {
    const rows = await db.query("SHOW TABLES LIKE 'incidencias_casos_eventos'", {
      type: db.QueryTypes.SELECT,
    });
    ok = rows.length > 0;
  } catch (_) {
    ok = false;
  }
  eventosCache = { ok, at: ahora };
  return ok;
}

/**
 * Agrega una entrada a la línea de tiempo de un caso. Es un registro de
 * auditoría: solo INSERT, nunca UPDATE ni DELETE. Va dentro de la misma
 * transacción que la acción, para que no quede una sin la otra.
 */
async function registrarEvento(req, id_incidencia, accion, comentario, transaction) {
  if (!(await tieneEventos())) return;
  await db.query(
    `INSERT INTO incidencias_casos_eventos
       (id_incidencia, accion, comentario, id_sub_usuario, autor_nombre, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    {
      replacements: [
        id_incidencia,
        accion,
        comentario || null,
        req.sessionUser?.id_sub_usuario || null,
        autorDe(req),
      ],
      transaction,
    },
  );
}

/** Línea de tiempo de varios casos: { [id_incidencia]: [{ accion, comentario, autor_nombre, created_at }] } */
async function eventosDe(ids) {
  const limpios = [...new Set(ids.map(Number).filter(Boolean))];
  if (!limpios.length || !(await tieneEventos())) return null;
  const rows = await db.query(
    `SELECT id, id_incidencia, accion, comentario, autor_nombre, created_at
       FROM incidencias_casos_eventos
      WHERE id_incidencia IN (:ids)
      ORDER BY created_at ASC, id ASC`,
    { replacements: { ids: limpios }, type: db.QueryTypes.SELECT },
  );
  const porCaso = {};
  for (const id of limpios) porCaso[id] = [];
  for (const r of rows) porCaso[r.id_incidencia].push(r);
  return porCaso;
}

/** Chat + lo necesario para dejarle una nota: conexión, dueño y propietario. */
async function datosChat(id_cliente) {
  const [chat] = await db.query(
    `SELECT c.id, c.id_configuracion, c.celular_cliente, cfg.id_usuario,
            cfg.id_telefono, p.id AS propietario_id
       FROM clientes_chat_center c
       JOIN configuraciones cfg ON cfg.id = c.id_configuracion
       LEFT JOIN clientes_chat_center p
              ON p.id_configuracion = c.id_configuracion AND p.propietario = 1
      WHERE c.id = ?
      LIMIT 1`,
    { replacements: [id_cliente], type: db.QueryTypes.SELECT },
  );
  return chat || null;
}

/**
 * Nota automática en la conversación. Igual que la de cierre de chat
 * (clientes_chat_center.controller.js): `notificacion`, rol 3, no sale a
 * WhatsApp. Si falla, la acción ya quedó guardada: se registra y se sigue.
 */
async function notaEnChat(chat, texto) {
  if (!chat?.propietario_id) return;
  try {
    const cuando = new Date().toLocaleString('es-EC', {
      timeZone: 'America/Guayaquil',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    await db.query(
      `INSERT INTO mensajes_clientes
         (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje,
          rol_mensaje, celular_recibe, texto_mensaje, visto, uid_whatsapp)
       VALUES
         (:id_config, :id_cliente, :mid, 'notificacion',
          3, :cel_recibe, :texto, 0, :uid)`,
      {
        replacements: {
          id_config: chat.id_configuracion,
          id_cliente: chat.propietario_id,
          mid: chat.id_telefono ?? null,
          cel_recibe: chat.id,
          texto: `${texto} — ${cuando}`,
          uid: chat.celular_cliente ?? null,
        },
        type: db.QueryTypes.INSERT,
      },
    );
    await enviarConsultaAPI(chat.id_configuracion, chat.id);
  } catch (err) {
    console.error('[incidencias] nota en el chat no registrada:', err.message);
  }
}

/**
 * Acceso a la vista de seguimiento de casos. Entra quien es destinatario de
 * algún tipo de caso en una conexión de su cuenta, o un administrador de una
 * cuenta que tenga casos configurados. Ve las conexiones de su cuenta.
 */
async function accesoCasos(req) {
  const sin = { acceso: false, configs: [], esAdmin: false, idSub: null };
  if (!(await tieneMigracionCasos())) return sin;
  const idSub = Number(req.sessionUser?.id_sub_usuario) || null;
  const idUsuario = Number(req.sessionUser?.id_usuario) || null;
  if (!idSub || !idUsuario) return sin;

  const filas = await db.query(
    `SELECT d.id_configuracion, d.id_sub_usuario
       FROM incidencias_casos_destinatarios d
       JOIN configuraciones c ON c.id = d.id_configuracion
      WHERE c.id_usuario = ?`,
    { replacements: [idUsuario], type: db.QueryTypes.SELECT },
  );
  const esAdmin = ROLES_ADMIN.includes(String(req.sessionUser?.rol || ''));
  const esDestinatario = filas.some((f) => Number(f.id_sub_usuario) === idSub);
  const configs = [...new Set(filas.map((f) => Number(f.id_configuracion)))];
  return { acceso: configs.length > 0 && (esAdmin || esDestinatario), configs, esAdmin, idSub };
}

/** Destinatarios configurados para una conexión: [{ tipo, id_sub_usuario, nombre }]. */
async function destinatariosDe(id_configuracion) {
  if (!id_configuracion || !(await tieneMigracionCasos())) return [];
  const rows = await db.query(
    `SELECT d.tipo, d.id_sub_usuario, s.nombre_encargado AS nombre
       FROM incidencias_casos_destinatarios d
       JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = d.id_sub_usuario
      WHERE d.id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return rows.filter((r) => TIPOS_CASO[r.tipo]);
}

function autorDe(req) {
  return (
    req.sessionUser?.nombre_encargado ||
    req.sessionUser?.usuario ||
    req.sessionUser?.email ||
    'Asesor'
  );
}

exports.listar = catchAsync(async (req, res, next) => {
  const id_cliente = Number(req.query.id_cliente || req.params.id_cliente);
  if (!id_cliente) return next(new AppError('Falta id_cliente', 400));

  const casos = await tieneMigracionCasos();
  const conEstado = casos && (await tieneEstadoCaso());
  const [rows] = await db.query(
    casos
      ? `SELECT i.id, i.id_sub_usuario, i.autor_nombre, i.descripcion, i.created_at,
                i.tipo, i.id_sub_usuario_destino, s.nombre_encargado AS destino_nombre,
                i.escalado_resuelto, i.resolucion_comentario, i.resolucion_fecha
                ${conEstado ? ', i.estado_caso' : ''}
           FROM incidencias_chat_center i
           LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = i.id_sub_usuario_destino
          WHERE i.id_cliente_chat_center = ? AND i.deleted_at IS NULL
          ORDER BY i.created_at ASC`
      : `SELECT id, id_sub_usuario, autor_nombre, descripcion, created_at
           FROM incidencias_chat_center
          WHERE id_cliente_chat_center = ? AND deleted_at IS NULL
          ORDER BY created_at ASC`,
    { replacements: [id_cliente] },
  );

  const yo = Number(req.sessionUser?.id_sub_usuario) || null;
  const eventos = casos ? await eventosDe(rows.filter((r) => r.tipo).map((r) => r.id)) : null;
  res.json({
    status: 'success',
    data: rows.map((r) => ({
      ...r,
      propia: Number(r.id_sub_usuario) === yo,
      ...(eventos && r.tipo ? { eventos: eventos[r.id] || [] } : {}),
    })),
  });
});

exports.crear = catchAsync(async (req, res, next) => {
  const id_cliente = Number(req.body.id_cliente);
  const id_configuracion = Number(req.body.id_configuracion) || null;
  const descripcion = String(req.body.descripcion || '').trim();

  if (!id_cliente || !descripcion) {
    return next(new AppError('Falta id_cliente o descripción', 400));
  }

  const autor = autorDe(req);
  const id_sub_usuario = req.sessionUser?.id_sub_usuario || null;

  // db.query de un INSERT devuelve [insertId, affectedRows]; el id es [0].
  const [insertId] = await db.query(
    `INSERT INTO incidencias_chat_center
       (id_cliente_chat_center, id_configuracion, id_sub_usuario, autor_nombre, descripcion, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    {
      replacements: [
        id_cliente,
        id_configuracion,
        id_sub_usuario,
        autor,
        descripcion.slice(0, 2000),
      ],
    },
  );

  res.status(201).json({
    status: 'success',
    data: {
      id: insertId,
      id_sub_usuario,
      autor_nombre: autor,
      descripcion: descripcion.slice(0, 2000),
      created_at: new Date(),
      propia: true,
    },
  });
});

/**
 * GET /incidencias_chat_center/casos-config?id_configuracion=
 * Qué botones de caso ve esta conexión y a quién le llega cada uno. Lista
 * vacía = conexión no habilitada (o migración sin correr): no hay botones.
 */
exports.casosConfig = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.query.id_configuracion) || null;
  const tipos = await destinatariosDe(id_configuracion);
  res.json({ status: 'success', data: tipos });
});

/**
 * POST /incidencias_chat_center/caso
 * body: { id_cliente, tipo: 'escalamiento' | 'oportunidad', descripcion }
 *
 * Guarda la incidencia como caso sin resolver para el destinatario
 * configurado y deja la nota en la conversación. Si el chat ya tiene un caso
 * de ese tipo sin resolver, responde 409 y no duplica.
 */
exports.crearCaso = catchAsync(async (req, res, next) => {
  const id_cliente = Number(req.body.id_cliente);
  const tipo = String(req.body.tipo || '');
  const descripcion = String(req.body.descripcion || '').trim().slice(0, 2000);

  if (!id_cliente) return next(new AppError('Falta id_cliente', 400));
  if (!TIPOS_CASO[tipo]) return next(new AppError('Tipo de caso inválido', 400));
  if (!descripcion) return next(new AppError('Escribe el motivo del caso', 400));
  if (!(await tieneMigracionCasos())) {
    return next(new AppError('Los casos aún no están habilitados', 409));
  }

  // La conexión sale del chat, no del body; y el chat tiene que ser de la
  // cuenta del asesor.
  const chat = await datosChat(id_cliente);
  if (!chat) return next(new AppError('Chat no encontrado', 404));
  if (Number(chat.id_usuario) !== Number(req.sessionUser?.id_usuario)) {
    return next(new AppError('Este chat no es de tu cuenta', 403));
  }

  const destino = (await destinatariosDe(chat.id_configuracion)).find(
    (d) => d.tipo === tipo,
  );
  if (!destino) {
    return next(
      new AppError('Esta conexión no tiene responsable para este tipo de caso', 403),
    );
  }

  const autor = autorDe(req);
  const id_sub_usuario = req.sessionUser?.id_sub_usuario || null;

  // Doble clic / dos asesores a la vez: el FOR UPDATE sobre el chat serializa
  // la verificación de duplicado y el INSERT.
  const t = await db.transaction();
  let insertId;
  try {
    await db.query(`SELECT id FROM clientes_chat_center WHERE id = ? FOR UPDATE`, {
      replacements: [id_cliente],
      transaction: t,
    });
    const [abiertos] = await db.query(
      `SELECT id FROM incidencias_chat_center
        WHERE id_cliente_chat_center = ? AND tipo = ?
          AND escalado_resuelto = 0 AND deleted_at IS NULL
        LIMIT 1`,
      { replacements: [id_cliente, tipo], transaction: t },
    );
    if (abiertos.length) {
      await t.rollback();
      return next(
        new AppError(
          tipo === 'escalamiento'
            ? 'Este caso ya está escalado y sin resolver'
            : 'Este caso ya está marcado como oportunidad y sin resolver',
          409,
        ),
      );
    }
    const conEstado = await tieneEstadoCaso();
    [insertId] = await db.query(
      `INSERT INTO incidencias_chat_center
         (id_cliente_chat_center, id_configuracion, id_sub_usuario, autor_nombre,
          descripcion, tipo, id_sub_usuario_destino, escalado_resuelto,
          ${conEstado ? 'estado_caso, ' : ''}created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ${conEstado ? "'sin_resolver', " : ''}NOW())`,
      {
        replacements: [
          id_cliente,
          chat.id_configuracion,
          id_sub_usuario,
          autor,
          descripcion,
          tipo,
          destino.id_sub_usuario,
        ],
        transaction: t,
      },
    );
    await registrarEvento(req, insertId, 'creado', descripcion, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  await notaEnChat(chat, `${autor} ${TIPOS_CASO[tipo].accion} ${destino.nombre}`);

  res.status(201).json({
    status: 'success',
    data: {
      id: insertId,
      id_sub_usuario,
      autor_nombre: autor,
      descripcion,
      created_at: new Date(),
      tipo,
      id_sub_usuario_destino: destino.id_sub_usuario,
      destino_nombre: destino.nombre,
      escalado_resuelto: 0,
      estado_caso: 'sin_resolver',
      propia: true,
    },
  });
});

// ─── Seguimiento de casos (parte 2): la vista de Johan ──────────────────────

/** Expresión SQL del estado del caso, con o sin la migración de «en espera». */
const estadoSql = (conEstado) =>
  conEstado
    ? "COALESCE(i.estado_caso, IF(i.escalado_resuelto = 1, 'resuelto', 'sin_resolver'))"
    : "IF(i.escalado_resuelto = 1, 'resuelto', 'sin_resolver')";

/** GET /incidencias_chat_center/casos-acceso — ¿se pinta «Seguimiento de casos» en el menú? */
exports.casosAcceso = catchAsync(async (req, res) => {
  const a = await accesoCasos(req);
  res.json({ status: 'success', data: { acceso: a.acceso } });
});

/**
 * GET /incidencias_chat_center/casos
 * query: tipo (oportunidad|escalamiento), estado ('' | pendientes |
 * sin_resolver | en_espera | resuelto), search, id_asesor, dias, orden
 * (antiguas), page, limit.
 *
 * Los casos de las conexiones de la cuenta, con los conteos de las dos listas
 * por estado (en la ventana de `dias`) para las tarjetas y las pestañas.
 */
exports.listarCasos = catchAsync(async (req, res, next) => {
  const acceso = await accesoCasos(req);
  if (!acceso.acceso) {
    return next(new AppError('No tienes permiso para ver el seguimiento de casos', 403));
  }

  const tipo = TIPOS_CASO[req.query.tipo] ? req.query.tipo : 'oportunidad';
  const estado = String(req.query.estado || '');
  const search = String(req.query.search || '').trim();
  const idAsesor = Number(req.query.id_asesor) || null;
  const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const orden = req.query.orden === 'antiguas' ? 'ASC' : 'DESC';

  const conEstado = await tieneEstadoCaso();
  const est = estadoSql(conEstado);

  // Alcance: casos de las conexiones de la cuenta, en la ventana de días.
  const base = [
    'i.deleted_at IS NULL',
    'i.tipo IS NOT NULL',
    'i.id_configuracion IN (:configs)',
    'i.created_at >= DATE_SUB(NOW(), INTERVAL :dias DAY)',
  ];
  const repl = { configs: acceso.configs, dias };

  const conteosRows = await db.query(
    `SELECT i.tipo, ${est} AS estado, COUNT(*) AS n
       FROM incidencias_chat_center i
      WHERE ${base.join(' AND ')}
      GROUP BY i.tipo, estado`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );
  const conteos = {};
  for (const t of Object.keys(TIPOS_CASO)) {
    conteos[t] = { total: 0, sin_resolver: 0, en_espera: 0, resuelto: 0 };
  }
  for (const r of conteosRows) {
    if (!conteos[r.tipo]) continue;
    conteos[r.tipo][r.estado] = Number(r.n);
    conteos[r.tipo].total += Number(r.n);
  }

  // Filtros de la lista.
  const where = [...base, 'i.tipo = :tipo'];
  repl.tipo = tipo;
  if (estado === 'pendientes') where.push(`${est} IN ('sin_resolver','en_espera')`);
  else if (['sin_resolver', 'en_espera', 'resuelto'].includes(estado)) {
    where.push(`${est} = :estado`);
    repl.estado = estado;
  }
  if (idAsesor) {
    where.push('i.id_sub_usuario = :asesor');
    repl.asesor = idAsesor;
  }
  if (search) {
    where.push(
      `(CONCAT_WS(' ', c.nombre_cliente, c.apellido_cliente) LIKE :q
        OR c.celular_cliente LIKE :q OR i.descripcion LIKE :q)`,
    );
    repl.q = `%${search}%`;
  }

  const from = `FROM incidencias_chat_center i
      LEFT JOIN clientes_chat_center c ON c.id = i.id_cliente_chat_center
      LEFT JOIN sub_usuarios_chat_center d ON d.id_sub_usuario = i.id_sub_usuario_destino
      LEFT JOIN sub_usuarios_chat_center r ON r.id_sub_usuario = i.resolucion_por
      ${conEstado ? 'LEFT JOIN sub_usuarios_chat_center e ON e.id_sub_usuario = i.espera_por' : ''}
     WHERE ${where.join(' AND ')}`;

  const [{ total }] = await db.query(`SELECT COUNT(*) AS total ${from}`, {
    replacements: repl,
    type: db.QueryTypes.SELECT,
  });

  const filas = await db.query(
    `SELECT i.id, i.id_cliente_chat_center AS id_chat, i.id_configuracion,
            TRIM(CONCAT_WS(' ', c.nombre_cliente, c.apellido_cliente)) AS cliente,
            c.celular_cliente AS celular,
            i.id_sub_usuario AS id_asesor, i.autor_nombre AS asesor,
            i.created_at AS fecha, i.descripcion AS motivo, i.tipo,
            i.id_sub_usuario_destino, d.nombre_encargado AS destino,
            ${est} AS estado,
            i.resolucion_comentario, i.resolucion_fecha, r.nombre_encargado AS resuelto_por
            ${conEstado ? ', i.espera_comentario, i.espera_fecha, e.nombre_encargado AS espera_por' : ''}
       ${from}
      ORDER BY i.created_at ${orden}, i.id ${orden}
      LIMIT :limit OFFSET :offset`,
    {
      replacements: { ...repl, limit, offset: (page - 1) * limit },
      type: db.QueryTypes.SELECT,
    },
  );

  const asesores = await db.query(
    `SELECT DISTINCT i.id_sub_usuario AS id, i.autor_nombre AS nombre
       FROM incidencias_chat_center i
      WHERE ${base.join(' AND ')} AND i.id_sub_usuario IS NOT NULL
      ORDER BY nombre`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  const eventos = await eventosDe(filas.map((f) => f.id));
  res.json({
    status: 'success',
    data: filas.map((f) => ({
      ...f,
      ...(eventos ? { eventos: eventos[f.id] || [] } : {}),
      puede_resolver:
        f.estado !== 'resuelto' &&
        (acceso.esAdmin || Number(f.id_sub_usuario_destino) === acceso.idSub),
    })),
    conteos,
    asesores,
    espera_habilitada: conEstado,
    total: Number(total),
    pagina: page,
    total_paginas: Math.max(Math.ceil(Number(total) / limit), 1),
  });
});

/** Carga un caso y valida que quien actúa pueda cerrarlo o ponerlo en espera. */
async function casoParaActuar(req, next) {
  const id = Number(req.params.id);
  if (!id) {
    next(new AppError('Falta id', 400));
    return null;
  }

  const acceso = await accesoCasos(req);
  if (!acceso.acceso) {
    next(new AppError('No tienes permiso para ver el seguimiento de casos', 403));
    return null;
  }
  const conEstado = await tieneEstadoCaso();
  const [caso] = await db.query(
    `SELECT i.id, i.id_cliente_chat_center, i.id_configuracion, i.tipo,
            i.id_sub_usuario_destino, ${estadoSql(conEstado)} AS estado
       FROM incidencias_chat_center i
      WHERE i.id = ? AND i.deleted_at IS NULL AND i.tipo IS NOT NULL`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!caso || !acceso.configs.includes(Number(caso.id_configuracion))) {
    next(new AppError('Caso no encontrado', 404));
    return null;
  }
  if (!acceso.esAdmin && Number(caso.id_sub_usuario_destino) !== acceso.idSub) {
    next(new AppError('Este caso le toca a otra persona', 403));
    return null;
  }
  if (caso.estado === 'resuelto') {
    next(new AppError('Este caso ya está resuelto', 409));
    return null;
  }
  return { caso, conEstado };
}

/**
 * PATCH /incidencias_chat_center/caso/:id/resolver  body: { comentario }
 * Patrón de encuestas.controller.js#resolverEscalado. Deja la resolución en
 * la conversación del cliente.
 */
exports.resolverCaso = catchAsync(async (req, res, next) => {
  const comentario = String(req.body.comentario || '').trim().slice(0, 2000);
  if (!comentario) return next(new AppError('Escribe cómo se resolvió el caso', 400));

  const r = await casoParaActuar(req, next);
  if (!r) return undefined;
  const { caso, conEstado } = r;

  // El `escalado_resuelto = 0` del WHERE evita resolverlo dos veces si dos
  // personas confirman a la vez. El cambio de estado y su entrada en la línea
  // de tiempo van juntos o no va ninguno.
  const t = await db.transaction();
  try {
    const [, afectadas] = await db.query(
      `UPDATE incidencias_chat_center SET
         escalado_resuelto = 1,
         ${conEstado ? "estado_caso = 'resuelto'," : ''}
         resolucion_comentario = :comentario,
         resolucion_por = :por,
         resolucion_fecha = NOW()
       WHERE id = :id AND escalado_resuelto = 0`,
      {
        replacements: { id: caso.id, comentario, por: req.sessionUser?.id_sub_usuario },
        type: db.QueryTypes.UPDATE,
        transaction: t,
      },
    );
    if (!afectadas) {
      await t.rollback();
      return next(new AppError('Este caso ya está resuelto', 409));
    }
    await registrarEvento(req, caso.id, 'resuelto', comentario, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  const chat = await datosChat(caso.id_cliente_chat_center);
  await notaEnChat(chat, `${autorDe(req)} resolvió ${TIPO_LABEL[caso.tipo]}: ${comentario}`);

  res.json({ status: 'success', message: 'Caso resuelto' });
});

/**
 * PATCH /incidencias_chat_center/caso/:id/espera  body: { comentario }
 * Lo deja «en espera» (sigue abierto: no se puede volver a marcar el chat).
 */
exports.esperaCaso = catchAsync(async (req, res, next) => {
  const comentario = String(req.body.comentario || '').trim().slice(0, 2000);
  if (!comentario) return next(new AppError('Escribe qué se está esperando', 400));
  if (!(await tieneEstadoCaso())) {
    return next(new AppError('El estado «en espera» aún no está habilitado', 409));
  }

  const r = await casoParaActuar(req, next);
  if (!r) return undefined;
  const { caso } = r;
  if (caso.estado === 'en_espera') return next(new AppError('Este caso ya está en espera', 409));

  // `estado_caso <> 'en_espera'`: si dos personas lo ponen en espera a la
  // vez, la segunda recibe el aviso en lugar de pisar el comentario.
  const t = await db.transaction();
  try {
    const [, afectadas] = await db.query(
      `UPDATE incidencias_chat_center SET
         estado_caso = 'en_espera',
         espera_comentario = :comentario,
         espera_por = :por,
         espera_fecha = NOW()
       WHERE id = :id AND escalado_resuelto = 0
         AND (estado_caso IS NULL OR estado_caso <> 'en_espera')`,
      {
        replacements: { id: caso.id, comentario, por: req.sessionUser?.id_sub_usuario },
        type: db.QueryTypes.UPDATE,
        transaction: t,
      },
    );
    if (!afectadas) {
      await t.rollback();
      return next(new AppError('Este caso ya cambió de estado; actualiza la lista', 409));
    }
    await registrarEvento(req, caso.id, 'en_espera', comentario, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  const chat = await datosChat(caso.id_cliente_chat_center);
  await notaEnChat(chat, `${autorDe(req)} puso en espera ${TIPO_LABEL[caso.tipo]}: ${comentario}`);

  res.json({ status: 'success', message: 'Caso en espera' });
});

exports.eliminar = catchAsync(async (req, res, next) => {
  const id = Number(req.params.id || req.body.id);
  if (!id) return next(new AppError('Falta id', 400));

  const casos = await tieneMigracionCasos();
  const [rows] = await db.query(
    `SELECT id_sub_usuario${casos ? ', tipo' : ''} FROM incidencias_chat_center
      WHERE id = ? AND deleted_at IS NULL`,
    { replacements: [id] },
  );
  if (!rows.length) return next(new AppError('Incidencia no encontrada', 404));

  const yo = Number(req.sessionUser?.id_sub_usuario) || null;
  if (Number(rows[0].id_sub_usuario) !== yo) {
    return next(new AppError('Solo puedes borrar tus propias incidencias', 403));
  }
  // Un caso ya le llegó a otra persona: borrarlo lo haría desaparecer de su
  // bandeja sin aviso. Se cierra al resolverlo, no se borra.
  if (rows[0].tipo) {
    return next(new AppError('Un caso escalado no se puede borrar', 403));
  }

  await db.query(
    `UPDATE incidencias_chat_center SET deleted_at = NOW() WHERE id = ?`,
    { replacements: [id] },
  );
  res.json({ status: 'success' });
});
