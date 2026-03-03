const XLSX = require('xlsx');

const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');

const Planes_chat_centerModel = require('../models/planes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Usuarios_chat_centerModel = require('../models/usuarios_chat_center.model');
const { QueryTypes } = require('sequelize');
const ChatService = require('../services/chat.service');
const { Op, fn, col } = require('sequelize');
const crypto = require('crypto');

// controllers/clientes_chat_centerController.js
exports.actualizar_cerrado = catchAsync(async (req, res, next) => {
  const { chatId, nuevoEstado, bot_openia } = req.body;

  try {
    // Armamos el query dinámico
    let query = `UPDATE clientes_chat_center SET chat_cerrado = ?, bot_openia = ?`;
    const replacements = [nuevoEstado, bot_openia];

    // Si bot_openia == 1 → también actualizar estado_contacto
    if (bot_openia == 1) {
      query += `, estado_contacto = ?`;
      replacements.push('contacto_inicial');
    }

    query += ` WHERE id = ?`;
    replacements.push(chatId);

    // Ejecutar
    await db.query(query, {
      replacements,
      type: db.QueryTypes.UPDATE,
    });

    res.status(200).json({
      status: '200',
      title: 'Petición exitosa',
      message: 'Chat actualizado correctamente',
    });
  } catch (error) {
    console.error(error);
    return next(new AppError('Error al actualizar el chat', 500));
  }
});

exports.actualizar_bot_openia = catchAsync(async (req, res, next) => {
  const { chatId, nuevoEstado } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE clientes_chat_center SET bot_openia = ? WHERE id = ?`,
      {
        replacements: [nuevoEstado, chatId],
        type: db.QueryTypes.UPDATE,
      },
    );

    res.status(200).json({
      status: '200',
      message: 'Estado del bot actualizado correctamente',
    });
  } catch (error) {
    return next(new AppError('Error al actualizar bot_openia', 500));
  }
});

exports.agregarNumeroChat = catchAsync(async (req, res, next) => {
  const { telefono, nombre, apellido, id_configuracion } = req.body;

  try {
    // 1. Obtener id_telefono desde configuraciones
    const [configuracion] = await db.query(
      'SELECT id_telefono FROM configuraciones WHERE id = ? AND suspendido = 0',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!configuracion) {
      return next(
        new AppError('No se encontró configuración para la plataforma', 400),
      );
    }

    const uid_cliente = configuracion.id_telefono;

    // 2) UPSERT (si existe por UNIQUE, no falla y devuelve el id existente)
    const upsertSql = `
      INSERT INTO clientes_chat_center
        (id_configuracion, nombre_cliente, apellido_cliente, celular_cliente, uid_cliente, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        nombre_cliente   = VALUES(nombre_cliente),
        apellido_cliente = VALUES(apellido_cliente),
        celular_cliente  = VALUES(celular_cliente),
        uid_cliente      = VALUES(uid_cliente),
        updated_at       = NOW(),
        id              = LAST_INSERT_ID(id)
    `;

    await db.query(upsertSql, {
      replacements: [
        id_configuracion,
        nombre ?? '',
        apellido ?? '',
        telefono ?? '',
        uid_cliente,
      ],
      type: db.QueryTypes.INSERT,
    });

    // 3) Recuperar ID (funciona tanto para insert como para duplicado)
    const [{ id: lastId }] = await db.query('SELECT LAST_INSERT_ID() AS id', {
      type: db.QueryTypes.SELECT,
    });

    return res.status(200).json({
      status: 200,
      title: 'Petición exitosa',
      message: 'Número agregado/actualizado correctamente',
      id: lastId,
    });
  } catch (error) {
    console.error('Error al agregar número de chat:', error);
    return res.status(500).json({
      status: 500,
      title: 'Error',
      message: 'Ocurrió un error al agregar el número de chat',
    });
  }
});

exports.buscar_id_recibe = catchAsync(async (req, res, next) => {
  const { telefono, id_configuracion } = req.body;

  try {
    const [clientes_chat_center] = await db.query(
      'SELECT id FROM clientes_chat_center WHERE celular_cliente = ? AND id_configuracion = ?',
      {
        replacements: [telefono, id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!clientes_chat_center) {
      return next(
        new AppError('No se encontró configuración para la plataforma', 400),
      );
    }

    const id_recibe = clientes_chat_center.id;

    return res.status(200).json({
      status: 200,
      data: { id_recibe: id_recibe },
    });
  } catch (error) {
    console.error('Error al agregar número de chat:', error);
    return res.status(500).json({
      status: 500,
      title: 'Error',
      message: 'Ocurrió un error al agregar el número de chat',
    });
  }
});

exports.agregarMensajeEnviado = catchAsync(async (req, res, next) => {
  const {
    texto_mensaje,
    tipo_mensaje,
    mid_mensaje,
    id_recibe,
    ruta_archivo,
    telefono_configuracion,
    telefono_recibe,
    id_configuracion,
    responsable,
    id_wamid_mensaje,
    template_name,
    language_code,
    meta_media_id,
  } = req.body;

  try {
    // 1) Obtener datos desde configuraciones (para armar el "cliente propietario")
    const [config] = await db.query(
      'SELECT id_telefono, nombre_configuracion FROM configuraciones WHERE id = ? AND suspendido = 0',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!config) {
      return next(new AppError('No se encontró configuración', 400));
    }

    const uid_cliente = config.id_telefono;
    const nombre_cliente = config.nombre_configuracion;
    const apellido_cliente = '';

    // 2) UPSERT cliente propietario (evita duplicados y carreras)
    const upsertClienteSql = `
      INSERT INTO clientes_chat_center
        (id_configuracion, uid_cliente, nombre_cliente, apellido_cliente, email_cliente, celular_cliente, propietario, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        uid_cliente      = VALUES(uid_cliente),
        nombre_cliente   = VALUES(nombre_cliente),
        apellido_cliente = VALUES(apellido_cliente),
        celular_cliente  = VALUES(celular_cliente),
        propietario      = VALUES(propietario),
        updated_at       = NOW(),
        id              = LAST_INSERT_ID(id)
    `;

    await db.query(upsertClienteSql, {
      replacements: [
        id_configuracion,
        uid_cliente,
        nombre_cliente,
        apellido_cliente,
        '',
        telefono_configuracion,
        1,
      ],
      type: db.QueryTypes.INSERT,
    });

    const [{ id: id_cliente_configuracion }] = await db.query(
      'SELECT LAST_INSERT_ID() AS id',
      { type: db.QueryTypes.SELECT },
    );

    // 3) Insertar mensaje
    await db.query(
      `INSERT INTO mensajes_clientes 
   (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje, rol_mensaje,
    celular_recibe, responsable, texto_mensaje, ruta_archivo, visto,
    uid_whatsapp, id_wamid_mensaje, template_name, language_code, meta_media_id)
   VALUES
   (:id_config, :id_cliente, :mid, :tipo, :rol,
    :cel_recibe, :resp, :texto, :ruta, :visto,
    :uid_whatsapp, :wamid, :template, :lang, :metaMediaId)`,
      {
        replacements: {
          id_config: id_configuracion,
          id_cliente: id_cliente_configuracion,
          mid: mid_mensaje,
          tipo: tipo_mensaje,
          rol: 1,
          cel_recibe: id_recibe,
          resp: responsable ?? '',
          texto: texto_mensaje ?? '',
          ruta: ruta_archivo ?? null,
          visto: 1,
          uid_whatsapp: telefono_recibe,
          wamid: id_wamid_mensaje ?? null,
          template: template_name ?? '',
          lang: language_code ?? '',
          metaMediaId: meta_media_id ?? null,
        },
        type: db.QueryTypes.INSERT,
      },
    );

    return res.status(200).json({
      status: 200,
      title: 'Petición exitosa',
      message: 'Mensaje agregado correctamente',
    });
  } catch (error) {
    console.error('Error al agregar mensaje enviado:', error);
    return res.status(500).json({
      status: 500,
      title: 'Error',
      message: 'Ocurrió un error al agregar el mensaje',
    });
  }
});

exports.actualizarMensajeReenviado = catchAsync(async (req, res, next) => {
  const { id_mensaje, new_wamid, id_wamid_mensaje } = req.body;

  try {
    // Primero actualizamos
    await db.query(
      `UPDATE mensajes_clientes 
       SET id_wamid_mensaje = ?
       WHERE id = ?`,
      {
        replacements: [new_wamid, id_mensaje],
        type: db.QueryTypes.UPDATE,
      },
    );

    // Después eliminamos de la tabla errores_chat_meta
    await db.query(
      `DELETE FROM errores_chat_meta 
       WHERE id_wamid_mensaje = ?`,
      {
        replacements: [id_wamid_mensaje],
        type: db.QueryTypes.DELETE,
      },
    );

    return res.status(200).json({
      status: 200,
      title: 'Petición exitosa',
      message: 'Mensaje actualizado y error eliminado correctamente',
    });
  } catch (error) {
    console.error(
      'Error al actualizar mensaje reenviado o eliminar error:',
      error,
    );
    return res.status(500).json({
      status: 500,
      title: 'Error',
      message: 'Ocurrió un error al actualizar o limpiar errores',
    });
  }
});

exports.findFullByPhone = catchAsync(async (req, res, next) => {
  const phone = req.params.phone.trim();
  const id_plataforma = req.query.id_plataforma;

  if (!id_plataforma)
    return next(new AppError('id_plataforma es requerido', 400));

  const chatService = new ChatService();
  const chat = await chatService.findChatByPhone(id_plataforma, phone);

  if (!chat)
    return res.status(404).json({ status: 404, message: 'Chat no encontrado' });

  res.json({ status: 200, data: chat });
});

exports.findFullByPhone = catchAsync(async (req, res, next) => {
  const identifier = String(req.params.phone || '').trim(); // puede ser phone o chatId
  const id_configuracion = req.query.id_configuracion;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  if (!identifier) {
    return next(new AppError('identificador es requerido', 400));
  }

  const chatService = new ChatService();
  const chat = await chatService.findChatByIdentifier(
    Number(id_configuracion),
    identifier,
  );

  if (!chat) {
    return res.status(404).json({ status: 404, message: 'Chat no encontrado' });
  }

  return res.json({ status: 200, data: chat });
});

exports.listarContactosEstado = catchAsync(async (req, res, next) => {
  const {
    id_configuracion,
    columnKeys = [],
    limit = 20,
    cursors = {},
    search = {},
  } = req.body;

  console.log('cursors incoming:', req.body.cursors);
  console.log('search incoming:', req.body.search);

  if (!id_configuracion)
    return next(new AppError('Falta el id_configuracion', 400));

  // Si no mandan columnas, devuelvo todas las conocidas (fallback)
  const keys =
    Array.isArray(columnKeys) && columnKeys.length
      ? columnKeys
      : Object.keys(ESTADO_DB_MAP);

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  // Función que resuelve una columna
  const fetchColumn = async (colKey) => {
    const estado_db = ESTADO_DB_MAP[colKey];
    if (!estado_db) {
      return {
        key: colKey,
        items: [],
        page: { has_more: false, next_cursor: null, limit: pageSize },
      };
    }

    const cursorRaw = cursors?.[colKey] || null;
    const decoded = cursorRaw ? decodeCursor(cursorRaw) : null;
    const cursorId = decoded?.id || null;

    const term = (search?.[colKey] || '').trim().toLowerCase();

    const where = [];
    const replacements = [];

    where.push('id_configuracion = ?');
    replacements.push(id_configuracion);

    where.push('propietario <> 1');

    where.push('LOWER(estado_contacto) = ?');
    replacements.push(estado_db);

    if (term) {
      where.push(`(
      LOWER(nombre_cliente) LIKE ? OR
      LOWER(apellido_cliente) LIKE ? OR
      telefono_limpio LIKE ?
    )`);
      const like = `%${term}%`;
      replacements.push(like, like, `%${search[colKey] || ''}%`);
    }

    // ✅ Cursor SOLO por id (estable)
    if (cursorId) {
      where.push('id < ?');
      replacements.push(cursorId);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const rows = await db.query(
      `
      SELECT id, nombre_cliente, apellido_cliente, telefono_limpio, estado_contacto, created_at, bot_openia
      FROM clientes_chat_center
      ${whereSql}
      ORDER BY id DESC
      LIMIT ?
    `,
      {
        replacements: [...replacements, pageSize + 1],
        type: db.QueryTypes.SELECT,
      },
    );

    const has_more = rows.length > pageSize;
    const items = has_more ? rows.slice(0, pageSize) : rows;

    const last = items[items.length - 1];
    const next_cursor = last ? encodeCursor({ id: last.id }) : null;

    return {
      key: colKey,
      items,
      page: { has_more, next_cursor, limit: pageSize },
    };
  };

  // Traer todas las columnas solicitadas (en paralelo)
  const results = await Promise.all(keys.map(fetchColumn));

  // Armar respuesta generalizada (misma forma para todos los kanban)
  const data = {};
  results.forEach((r) => {
    data[r.key] = {
      items: r.items,
      page: r.page,
    };
  });

  return res.status(200).json({
    success: true,
    data,
  });
});

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const ESTADO_DB_MAP = {
  CONTACTO_INICIAL: 'contacto_inicial',
  PLATAFORMAS_Y_CLASES: 'plataformas_clases',
  PRODUCTOS_Y_PROVEEDORES: 'productos_proveedores',
  VENTAS: 'ventas_imporfactory',
  ASESOR: 'asesor',
  COTIZACIONES: 'cotizaciones_imporfactory',
  IA_VENTAS: 'ia_ventas',
  GENERAR_GUIA: 'generar_guia',
  SEGUIMIENTO: 'seguimiento',
  CANCELADO: 'cancelado',
  IA_VENTAS_IMPORSHOP: 'ia_ventas_imporshop',
  ATENCION_URGENTE: 'atencion_urgente',
};

exports.actualizarEstado = async (req, res) => {
  try {
    const { id_cliente, nuevo_estado, id_configuracion } = req.body;

    if (!id_cliente || !nuevo_estado || !id_configuracion) {
      return res.status(400).json({
        success: false,
        message: 'Faltan parámetros obligatorios',
      });
    }

    // 🟦 MAPEO del estado del FRONT al estado REAL en la BD
    const estadoMap = {
      CONTACTO_INICIAL: 'contacto_inicial',
      PLATAFORMAS_Y_CLASES: 'plataformas_clases',
      PRODUCTOS_Y_PROVEEDORES: 'productos_proveedores',
      VENTAS: 'ventas_imporfactory',
      ASESOR: 'asesor',
      COTIZACIONES: 'cotizaciones_imporfactory',
      IA_VENTAS: 'ia_ventas',
      GENERAR_GUIA: 'generar_guia',
      SEGUIMIENTO: 'seguimiento',
      CANCELADO: 'cancelado',
      ATENCION_URGENTE: 'atencion_urgente',
      IA_VENTAS_IMPORSHOP: 'ia_ventas_imporshop',
    };

    const estadoBD = estadoMap[nuevo_estado];

    if (!estadoBD) {
      return res.status(400).json({
        success: false,
        message: `El estado "${nuevo_estado}" no es válido.`,
      });
    }

    // Buscar cliente
    const cliente = await ClientesChatCenter.findOne({
      where: { id: id_cliente, id_configuracion },
    });

    if (!cliente) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado',
      });
    }

    // Actualizar
    await cliente.update({
      estado_contacto: estadoBD,
    });

    return res.json({
      success: true,
      message: 'Estado de contacto actualizado correctamente',
      data: cliente,
    });
  } catch (error) {
    console.error('Error al actualizar estado contacto:', error);

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    });
  }
};

exports.ultimo_mensaje = catchAsync(async (req, res, next) => {
  const { id_configuracion, id_cliente } = req.body;

  if (!id_configuracion && !id_cliente) {
    return next(new AppError('Falta el id_configuracion y telefono', 400));
  }

  try {
    // 1) Consultar todos los contactos de esa configuración
    const clientes = await db.query(
      `SELECT * FROM mensajes_clientes WHERE celular_recibe = ? AND rol_mensaje = 0 ORDER BY mensajes_clientes.id DESC LIMIT 1;`,
      {
        replacements: [id_cliente],
        type: db.QueryTypes.SELECT,
      },
    );

    return res.status(200).json({
      success: true,
      data: clientes,
    });
  } catch (error) {
    console.error('Error al listar contactos:', error);

    return res.status(500).json({
      success: false,
      message: 'Ocurrió un error al listar los contactos',
    });
  }
});

// ✅ Whitelist segura para ORDER BY (incluye último mensaje)
function parseSort(sortRaw) {
  const allowed = new Set([
    'id',
    'created_at',
    'updated_at',
    'nombre_cliente',
    'apellido_cliente',
    'estado_cliente',
    'ultimo_mensaje_at',
    'ultimo_msg_id',
  ]);

  let col = 'ultimo_mensaje_at';
  let dir = 'DESC';

  if (sortRaw && String(sortRaw).trim()) {
    const [c, d] = String(sortRaw).trim().split(':');
    if (c && allowed.has(c)) col = c;

    const dd = (d || '').toUpperCase();
    if (dd === 'ASC' || dd === 'DESC') dir = dd;
  }

  // Empujar nulos al final cuando ordena por ultimo_mensaje_at
  if (col === 'ultimo_mensaje_at') {
    return `(${col} IS NULL) ASC, ${col} ${dir}, ultimo_msg_id ${dir}`;
  }

  return `${col} ${dir}`;
}

function parseEstado(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

/* ============================================================
   GET /api/v1/clientes_chat_center/listar
   ?page=&limit=&q=&estado=&id_etiqueta=&sort=&id_configuracion=
   &id_etiqueta_asesor=&id_etiqueta_ciclo=
   ============================================================ */
exports.listarClientes = catchAsync(async (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const MAX_LIMIT = 2000;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(req.query.limit ?? 25)));
  const offset = (page - 1) * limit;

  const id_configuracion = Number(req.query.id_configuracion ?? 0);
  if (!id_configuracion) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_configuracion es requerido',
    });
  }

  const q = String(req.query.q ?? '').trim();
  const estadoParsed = parseEstado(req.query.estado);
  const orderBy = parseSort(req.query.sort);

  const idEtiquetaNum = Number(req.query.id_etiqueta ?? 0);
  const hasEtiqueta = Number.isFinite(idEtiquetaNum) && idEtiquetaNum > 0;

  // WHERE del cliente (solo columnas de clientes_chat_center aquí)
  const whereParts = ['c.deleted_at IS NULL', 'c.id_configuracion = ?'];
  const params = [id_configuracion];

  if (estadoParsed !== null) {
    whereParts.push('c.estado_cliente = ?');
    params.push(estadoParsed);
  }

  if (hasEtiqueta) {
    whereParts.push('c.id_etiqueta = ?');
    params.push(idEtiquetaNum);
  }

  // filtros por asesor y ciclo
  if (req.query.id_etiqueta_asesor) {
    whereParts.push('c.id_etiqueta_asesor = ?');
    params.push(Number(req.query.id_etiqueta_asesor));
  }

  if (req.query.id_etiqueta_ciclo) {
    whereParts.push('c.id_etiqueta_ciclo = ?');
    params.push(Number(req.query.id_etiqueta_ciclo));
  }

  if (q) {
    const like = `%${q}%`;
    whereParts.push(`(
      c.nombre_cliente   LIKE ? OR
      c.apellido_cliente LIKE ? OR
      c.email_cliente    LIKE ? OR
      c.celular_cliente  LIKE ? OR
      c.telefono_limpio  LIKE ?
    )`);
    params.push(like, like, like, like, like);
  }

  const whereClause = `WHERE ${whereParts.join(' AND ')}`;

  // LEFT JOIN para asesor y ciclo + columnas nuevas en SELECT
  const dataSql = `
    SELECT
      c.id, c.id_configuracion, c.id_etiqueta, c.uid_cliente,
      c.nombre_cliente, c.apellido_cliente, c.email_cliente, c.celular_cliente,
      c.estado_cliente,
      c.created_at, c.updated_at,
      c.chat_cerrado, c.telefono_limpio, c.direccion,

      c.id_etiqueta_asesor,
      c.id_etiqueta_ciclo,
      eca.nombre AS asesor_nombre,
      ecc.nombre AS ciclo_nombre,

      lm.ultimo_mensaje_at,
      lm.ultimo_texto,
      lm.ultimo_tipo_mensaje,
      lm.ultimo_rol_mensaje,
      lm.ultimo_msg_id

    FROM clientes_chat_center c

    LEFT JOIN etiquetas_custom_chat_center eca
      ON eca.id = c.id_etiqueta_asesor AND eca.deleted_at IS NULL
    LEFT JOIN etiquetas_custom_chat_center ecc
      ON ecc.id = c.id_etiqueta_ciclo AND ecc.deleted_at IS NULL

    LEFT JOIN (
      SELECT
        t.chat_id,
        t.id_configuracion,
        t.created_at AS ultimo_mensaje_at,
        t.texto_mensaje AS ultimo_texto,
        t.tipo_mensaje AS ultimo_tipo_mensaje,
        t.rol_mensaje  AS ultimo_rol_mensaje,
        t.id           AS ultimo_msg_id
      FROM (
        SELECT
          u.*,
          ROW_NUMBER() OVER (
            PARTITION BY u.id_configuracion, u.chat_id
            ORDER BY u.created_at DESC, u.id DESC
          ) AS rn
        FROM (
          -- mensajes donde el cliente fue el EMISOR
          SELECT
            m.id,
            m.id_configuracion,
            m.id_cliente AS chat_id,
            m.created_at,
            m.texto_mensaje,
            m.tipo_mensaje,
            m.rol_mensaje
          FROM mensajes_clientes m
          WHERE m.deleted_at IS NULL
            AND m.id_configuracion = ?

          UNION ALL

          -- mensajes donde el cliente fue el RECEPTOR
          SELECT
            m.id,
            m.id_configuracion,
            CAST(m.celular_recibe AS UNSIGNED) AS chat_id,
            m.created_at,
            m.texto_mensaje,
            m.tipo_mensaje,
            m.rol_mensaje
          FROM mensajes_clientes m
          WHERE m.deleted_at IS NULL
            AND m.id_configuracion = ?
            AND m.celular_recibe IS NOT NULL
            AND m.celular_recibe <> ''
        ) u
      ) t
      WHERE t.rn = 1
    ) lm
      ON lm.id_configuracion = c.id_configuracion
     AND lm.chat_id = c.id
     AND c.propietario = 0

    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?;
  `;

  const countSql = `
    SELECT COUNT(*) AS total
    FROM clientes_chat_center c
    ${whereClause};
  `;

  // OJO: el subquery lm usa dos veces id_configuracion (?)
  const rows = await db.query(dataSql, {
    replacements: [
      id_configuracion,
      id_configuracion,
      ...params,
      limit,
      offset,
    ],
    type: db.QueryTypes.SELECT,
  });

  const countRows = await db.query(countSql, {
    replacements: params,
    type: db.QueryTypes.SELECT,
  });

  const total = Number(countRows?.[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return res.status(200).json({
    status: 'success',
    data: rows,
    total,
    page,
    limit,
    totalPages,
  });
});

/* ============================================================
   POST /api/v1/clientes_chat_center/agregar
   body: nombre_cliente | email_cliente | celular_cliente (al menos uno)
   + demás columnas que quieras setear
   ============================================================ */
exports.agregarCliente = catchAsync(async (req, res, next) => {
  const {
    id_plataforma,
    id_configuracion,
    id_etiqueta,
    uid_cliente,
    nombre_cliente,
    apellido_cliente,
    email_cliente,
    celular_cliente,
    imagePath,
    mensajes_por_dia_cliente,
    estado_cliente,
    chat_cerrado,
    bot_openia,
    id_departamento,
    id_encargado,
    pedido_confirmado,
  } = req.body;

  if (!nombre_cliente && !celular_cliente && !email_cliente) {
    return next(new AppError('Ingrese al menos nombre, teléfono o email', 400));
  }

  // ✅ UPSERT: si existe, actualiza y no falla por duplicado
  // ✅ Además devuelve el id REAL (nuevo o existente) usando LAST_INSERT_ID
  const upsertSql = `
    INSERT INTO clientes_chat_center (
      id_plataforma, id_configuracion, id_etiqueta, uid_cliente,
      nombre_cliente, apellido_cliente, email_cliente, celular_cliente,
      imagePath, mensajes_por_dia_cliente, estado_cliente,
      chat_cerrado, bot_openia, id_departamento, id_encargado, pedido_confirmado,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      id_plataforma            = VALUES(id_plataforma),
      id_etiqueta              = VALUES(id_etiqueta),
      uid_cliente              = VALUES(uid_cliente),
      nombre_cliente           = VALUES(nombre_cliente),
      apellido_cliente         = VALUES(apellido_cliente),
      email_cliente            = VALUES(email_cliente),
      celular_cliente          = VALUES(celular_cliente),
      imagePath                = VALUES(imagePath),
      mensajes_por_dia_cliente  = VALUES(mensajes_por_dia_cliente),
      estado_cliente           = VALUES(estado_cliente),
      chat_cerrado             = VALUES(chat_cerrado),
      bot_openia               = VALUES(bot_openia),
      id_departamento          = VALUES(id_departamento),
      id_encargado             = VALUES(id_encargado),
      pedido_confirmado        = VALUES(pedido_confirmado),
      updated_at               = NOW(),
      id                       = LAST_INSERT_ID(id)
  `;

  await db.query(upsertSql, {
    replacements: [
      id_plataforma ?? null,
      id_configuracion ?? null,
      id_etiqueta ?? null,
      uid_cliente ?? null,
      nombre_cliente ?? '',
      apellido_cliente ?? '',
      email_cliente ?? '',
      celular_cliente ?? '',
      imagePath ?? '',
      mensajes_por_dia_cliente ?? 0,
      estado_cliente ?? 1,
      chat_cerrado ?? 0,
      bot_openia ?? 1,
      id_departamento ?? null,
      id_encargado ?? null,
      pedido_confirmado ?? 0,
    ],
    type: db.QueryTypes.INSERT,
  });

  // ✅ id (nuevo o existente)
  const [{ id: lastId }] = await db.query('SELECT LAST_INSERT_ID() AS id', {
    type: db.QueryTypes.SELECT,
  });

  const [created] = await db.query(
    `SELECT *
     FROM clientes_chat_center
     WHERE id = ?`,
    { replacements: [lastId], type: db.QueryTypes.SELECT },
  );

  return res.status(201).json({ status: 'success', data: created });
});

/* ============================================================
   PUT /api/v1/clientes_chat_center/actualizar/:id
   Body: solo los campos que quieras cambiar
   ============================================================ */
exports.actualizarCliente = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  // Build SET dinámico seguro
  const fields = [
    'id_plataforma',
    'id_configuracion',
    'id_etiqueta',
    'uid_cliente',
    'nombre_cliente',
    'apellido_cliente',
    'email_cliente',
    'celular_cliente',
    'imagePath',
    'mensajes_por_dia_cliente',
    'estado_cliente',
    'chat_cerrado',
    'bot_openia',
    'id_departamento',
    'id_encargado',
    'pedido_confirmado',
  ];
  const setParts = [];
  const params = [];

  for (const f of fields) {
    if (req.body.hasOwnProperty(f)) {
      setParts.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  // nada que actualizar
  if (setParts.length === 0)
    return res.status(200).json({ status: 'success', data: null });

  setParts.push('updated_at = NOW()');

  const updateSql = `
    UPDATE clientes_chat_center
    SET ${setParts.join(', ')}
    WHERE id = ? AND deleted_at IS NULL
  `;
  params.push(id);

  const upd = await db.query(updateSql, {
    replacements: params,
    type: db.QueryTypes.UPDATE,
  });

  // devolver fila actualizada
  const [row] = await db.query(
    `SELECT id, id_plataforma, id_configuracion, id_etiqueta, uid_cliente,
            nombre_cliente, apellido_cliente, email_cliente, celular_cliente,
            imagePath, mensajes_por_dia_cliente, estado_cliente,
            created_at, updated_at, deleted_at, chat_cerrado, bot_openia,
            id_departamento, id_encargado, pedido_confirmado, telefono_limpio
     FROM clientes_chat_center WHERE id = ?`,
    { replacements: [id], type: db.QueryTypes.SELECT },
  );
  if (!row) return next(new AppError('Cliente no encontrado', 404));

  return res.status(200).json({ status: 'success', data: row });
});

/* ============================================================
   DELETE /api/v1/clientes_chat_center/eliminar/:id  (soft-delete)
   ============================================================ */
exports.eliminarCliente = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const sql = `UPDATE clientes_chat_center SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`;
  await db.query(sql, { replacements: [id], type: db.QueryTypes.UPDATE });
  return res.status(204).json({ status: 'success' });
});

/* ============================================================
   POST /api/v1/clientes_chat_center/eliminar   { ids: [] }
   ============================================================ */
exports.eliminarClientesBulk = catchAsync(async (req, res, next) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
  if (!ids.length) return next(new AppError('ids es requerido', 400));

  const placeholders = ids.map(() => '?').join(',');
  const sql = `UPDATE clientes_chat_center SET deleted_at = NOW()
               WHERE deleted_at IS NULL AND id IN (${placeholders})`;

  await db.query(sql, { replacements: ids, type: db.QueryTypes.UPDATE });
  return res.status(200).json({ status: 'success', deleted: ids.length });
});

// GET /api/v1/clientes_chat_center/listar_por_etiqueta?ids=1,2&page=&limit=&q=&estado=&sort=&id_configuracion=10
exports.listarClientesPorEtiqueta = catchAsync(async (req, res, next) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
  const offset = (page - 1) * limit;

  const id_configuracion = Number(req.query.id_configuracion);
  if (!Number.isFinite(id_configuracion) || id_configuracion <= 0) {
    return next(new AppError('id_configuracion inválido', 400));
  }

  const subUsuarioSession = req.sessionUser;
  if (!subUsuarioSession) {
    return res.status(401).json({
      status: 'fail',
      message: 'No estás autenticado como subusuario',
    });
  }

  const id_usuario_session = subUsuarioSession.id_usuario;

  const validar_permiso_usuario = await Configuraciones.findOne({
    where: {
      id_usuario: id_usuario_session,
      id: id_configuracion,
      suspendido: 0,
    },
  });

  if (!validar_permiso_usuario) {
    return res.status(401).json({
      status: 'fail',
      message:
        'Tu usuario no tiene permiso para acceder a los usuarios de esa configuracion',
    });
  }

  const idsParam = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!idsParam.length) {
    return res
      .status(200)
      .json({ status: 'success', data: [], total: 0, page, limit });
  }

  const estadoParsed = (() => {
    const v = req.query.estado;
    if (v === undefined || v === null || v === '' || v === 'todos') return null;
    if (v === '1' || v === 1 || v === 'activo' || v === 'nuevo') return 1;
    if (v === '0' || v === 0 || v === 'inactivo' || v === 'perdido') return 0;
    return null;
  })();

  function parseSort(sort) {
    switch (sort) {
      case 'antiguos':
        return 'c.created_at ASC';
      case 'actividad_asc':
        return 'c.updated_at ASC';
      case 'actividad_desc':
        return 'c.updated_at DESC';
      case 'recientes':
      default:
        return 'c.created_at DESC';
    }
  }
  const orderBy = parseSort(req.query.sort);

  const where = ['c.deleted_at IS NULL', 'c.id_configuracion = ?'];
  const params = [id_configuracion];

  if (estadoParsed !== null) {
    where.push('c.estado_cliente = ?');
    params.push(estadoParsed);
  }

  if (req.query.q && String(req.query.q).trim()) {
    const like = `%${String(req.query.q).trim()}%`;
    where.push(`(
      c.nombre_cliente   LIKE ? OR
      c.apellido_cliente LIKE ? OR
      c.email_cliente    LIKE ? OR
      c.celular_cliente  LIKE ? OR
      c.telefono_limpio  LIKE ? OR
      c.uid_cliente      LIKE ?
    )`);
    params.push(like, like, like, like, like, like);
  }

  // ★ NUEVO: filtros por asesor y ciclo
  if (req.query.id_etiqueta_asesor) {
    where.push('c.id_etiqueta_asesor = ?');
    params.push(Number(req.query.id_etiqueta_asesor));
  }

  if (req.query.id_etiqueta_ciclo) {
    where.push('c.id_etiqueta_ciclo = ?');
    params.push(Number(req.query.id_etiqueta_ciclo));
  }

  // IN dinámico para etiquetas
  const inPlaceholders = idsParam.map(() => '?').join(',');
  const etiquetaParams = idsParam
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));

  if (!etiquetaParams.length) {
    return res
      .status(200)
      .json({ status: 'success', data: [], total: 0, page, limit });
  }

  // ★ CAMBIO: LEFT JOIN para asesor y ciclo
  const baseFromJoin = `
    FROM clientes_chat_center c
    INNER JOIN etiquetas_asignadas ea
      ON ea.id_cliente_chat_center = c.id
     AND ea.id_configuracion = c.id_configuracion
    LEFT JOIN etiquetas_custom_chat_center eca
      ON eca.id = c.id_etiqueta_asesor AND eca.deleted_at IS NULL
    LEFT JOIN etiquetas_custom_chat_center ecc
      ON ecc.id = c.id_etiqueta_ciclo AND ecc.deleted_at IS NULL
    WHERE ${where.join(' AND ')}
      AND ea.id_etiqueta IN (${inPlaceholders})
  `;

  // ★ CAMBIO: columnas asesor/ciclo en SELECT
  const dataSql = `
    SELECT
      c.id, c.id_plataforma, c.id_configuracion, c.id_etiqueta, c.uid_cliente,
      c.nombre_cliente, c.apellido_cliente, c.email_cliente, c.celular_cliente,
      c.imagePath, c.mensajes_por_dia_cliente, c.estado_cliente,
      c.created_at, c.updated_at, c.deleted_at,
      c.chat_cerrado, c.bot_openia, c.id_departamento, c.id_encargado,
      c.pedido_confirmado, c.telefono_limpio, c.direccion, c.productos,
      c.id_etiqueta_asesor,
      c.id_etiqueta_ciclo,
      eca.nombre AS asesor_nombre,
      ecc.nombre AS ciclo_nombre
    ${baseFromJoin}
    GROUP BY c.id
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?;
  `;

  const countSql = `
    SELECT COUNT(DISTINCT c.id) AS total
    ${baseFromJoin};
  `;

  const dataParams = [...params, ...etiquetaParams, limit, offset];
  const countParams = [...params, ...etiquetaParams];

  const rows = await db.query(dataSql, {
    replacements: dataParams,
    type: db.QueryTypes.SELECT,
  });

  const [{ total }] = await db.query(countSql, {
    replacements: countParams,
    type: db.QueryTypes.SELECT,
  });

  return res
    .status(200)
    .json({ status: 'success', data: rows, total, page, limit });
});

exports.totalClientesUltimoMes = async (req, res) => {
  try {
    // 1) Verificar sesión
    const subUsuarioSession = req.sessionUser;
    if (!subUsuarioSession) {
      return res.status(401).json({
        status: 'fail',
        message: 'No estás autenticado como subusuario',
      });
    }

    // 2) Cargar subusuario
    const subUsuarioDB = await Sub_usuarios_chat_center.findByPk(
      subUsuarioSession.id_sub_usuario,
    );

    if (!subUsuarioDB) {
      return res.status(401).json({
        status: 'fail',
        message: 'No se encontró el subusuario en la base de datos',
      });
    }

    // 3) Cargar usuario + plan
    const usuario = await Usuarios_chat_centerModel.findByPk(
      subUsuarioDB.id_usuario,
      { include: [{ model: Planes_chat_centerModel, as: 'plan' }] },
    );

    if (!usuario) {
      return res.status(404).json({
        status: 'fail',
        message: 'Usuario no encontrado',
      });
    }

    if (!usuario.plan) {
      return res.status(403).json({
        status: 'fail',
        message: 'El usuario no tiene plan asignado',
      });
    }

    // 4) Límite por plan
    const maxPlanConversaciones = Number(usuario.plan?.n_conversaciones || 0);

    // 5) Configuraciones del usuario
    const configuraciones = await Configuraciones.findAll({
      where: { id_usuario: usuario.id_usuario },
      attributes: ['id'],
    });

    const configIds = configuraciones.map((c) => c.id);

    // 6) Rango mes actual
    const ahora = new Date();
    const año = ahora.getFullYear();
    const mes = ahora.getMonth(); // 0=enero

    const inicio = new Date(año, mes, 1);
    const fin = new Date(año, mes + 1, 1);

    // 7) Conteo conversaciones (clientes) del mes actual
    const totalActualConversaciones = configIds.length
      ? await ClientesChatCenter.count({
          where: {
            id_configuracion: { [Op.in]: configIds },
            created_at: { [Op.gte]: inicio, [Op.lt]: fin },
          },
        })
      : 0;

    // 8) Respuesta (solo los 2 campos)
    return res.status(200).json({
      totalActualConversaciones,
      maxPlanConversaciones,
    });
  } catch (err) {
    console.error('Error en totalConversacionesUltimoMes:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Error interno del servidor',
    });
  }
};

exports.totalClientesUltimoMesTodos = async (req, res) => {
  try {
    const ahora = new Date();
    const año = ahora.getFullYear();
    const mes = ahora.getMonth();

    const inicio = new Date(año, mes, 1);
    const fin = new Date(año, mes + 1, 1);

    const usuarios = await Usuarios_chat_centerModel.findAll({
      attributes: ['id_usuario', 'nombre'],
      include: [
        {
          model: Planes_chat_centerModel,
          as: 'plan',
          attributes: ['n_conversaciones'],
          required: false,
        },
      ],
    });

    const configuraciones = await Configuraciones.findAll({
      attributes: ['id', 'id_usuario'],
      raw: true,
    });

    const configIds = configuraciones.map((c) => c.id);

    const countsPorConfig = configIds.length
      ? await ClientesChatCenter.findAll({
          attributes: [
            'id_configuracion',
            [fn('COUNT', col('id_configuracion')), 'total'],
          ],
          where: {
            id_configuracion: { [Op.in]: configIds },
            created_at: { [Op.gte]: inicio, [Op.lt]: fin },
          },
          group: ['id_configuracion'],
          raw: true,
        })
      : [];

    const totalPorConfigMap = new Map();
    for (const row of countsPorConfig) {
      totalPorConfigMap.set(
        Number(row.id_configuracion),
        Number(row.total || 0),
      );
    }

    const configsPorUsuarioMap = new Map();
    for (const c of configuraciones) {
      const userId = Number(c.id_usuario);
      if (!configsPorUsuarioMap.has(userId))
        configsPorUsuarioMap.set(userId, []);
      configsPorUsuarioMap.get(userId).push(Number(c.id));
    }

    const data = usuarios.map((u) => {
      const userId = Number(u.id_usuario);
      const maxPlanConversaciones = Number(u.plan?.n_conversaciones || 0);

      const misConfigs = configsPorUsuarioMap.get(userId) || [];
      const totalActualConversaciones = misConfigs.reduce((acc, cfgId) => {
        return acc + (totalPorConfigMap.get(cfgId) || 0);
      }, 0);

      return {
        nombre: u.nombre,
        id_usuario: userId,
        totalActualConversaciones,
        maxPlanConversaciones,
      };
    });

    // ✅ TOTAL GENERAL ACUMULADO
    const totalGeneralConversaciones = data.reduce(
      (acc, u) => acc + Number(u.totalActualConversaciones || 0),
      0,
    );

    return res.status(200).json({
      inicio,
      fin,
      totalGeneralConversaciones,
      data,
    });
  } catch (err) {
    console.error('Error en totalConversacionesUltimoMesTodos:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Error interno del servidor',
    });
  }
};

function splitTags(rawTags) {
  return String(rawTags || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeTagName(tag) {
  return String(tag || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function pickDefaultColor() {
  return '#0075FF';
}

function chunkArray(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toBoolean(value, defaultVal = true) {
  if (value === undefined || value === null || value === '') return defaultVal;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return defaultVal;
}

function parseXlsxBufferToFilas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames?.[0];
  if (!sheetName) return [];

  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!Array.isArray(rows) || rows.length === 0) return [];

  return rows
    .map((r) => {
      const telefono =
        r.Telefono ||
        r.telefono ||
        r['Teléfono'] ||
        r.Celular ||
        r.celular ||
        r.celular_cliente ||
        r.telefono_cliente ||
        '';

      const nombre =
        r.Nombre || r.nombre || r['Nombre'] || r.nombre_cliente || '';

      const apellido =
        r.Apellido || r.apellido || r['Apellido'] || r.apellido_cliente || '';

      const email =
        r.email || r.Email || r.EMAIL || r['Email'] || r['Correo'] || '';

      const etiquetas =
        r.Etiquetas || r.etiquetas || r.Tags || r.tags || r['Etiquetas'] || '';

      // ★ NUEVOS CAMPOS OPCIONALES
      const asesor = String(r.Asesor || r.asesor || r.ASESOR || '').trim();
      const ciclo = String(r.Ciclo || r.ciclo || r.CICLO || '').trim();

      return { telefono, nombre, apellido, email, etiquetas, asesor, ciclo };
    })
    .filter((x) => {
      return (
        String(x.telefono || '').trim() ||
        String(x.nombre || '').trim() ||
        String(x.apellido || '').trim() ||
        String(x.email || '').trim() ||
        String(x.etiquetas || '').trim()
      );
    });
}

exports.importacionMasiva = catchAsync(async (req, res, next) => {
  const id_configuracion = req.body.id_configuracion;
  const actualizar_cache_etiquetas = toBoolean(
    req.body.actualizar_cache_etiquetas,
    true,
  );

  if (!id_configuracion) {
    return next(new AppError('Falta id_configuracion', 400));
  }

  if (!req.file?.buffer) {
    return next(
      new AppError(
        'Debe subir un archivo Excel (.xlsx) en el campo "archivoExcel".',
        400,
      ),
    );
  }

  const filas = parseXlsxBufferToFilas(req.file.buffer);

  if (!Array.isArray(filas) || filas.length === 0) {
    return next(
      new AppError('El Excel no contiene filas válidas o está vacío.', 400),
    );
  }

  const [configRow] = await db.query(
    'SELECT id_telefono FROM configuraciones WHERE id = ? AND suspendido = 0 LIMIT 1',
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!configRow) {
    return next(
      new AppError('No se encontró la configuración o está suspendida.', 400),
    );
  }

  const uid_cliente_config = configRow.id_telefono || null;

  // ========= 1) Normalizar y deduplicar por teléfono =========
  const mapByPhone = new Map();
  const errores = [];
  let filas_validas = 0;

  for (let i = 0; i < filas.length; i++) {
    const row = filas[i] || {};

    const tel = String(
      row.telefono || row.celular_cliente || row.celular || '',
    ).trim();

    if (!tel) {
      errores.push({ index: i, error: 'Teléfono vacío o inválido', row });
      continue;
    }

    const nombre = String(row.nombre || row.nombre_cliente || '').trim();
    const apellido = String(row.apellido || row.apellido_cliente || '').trim();
    const email = String(row.email || row.email_cliente || '').trim();

    const tagsRaw = row.etiquetas || row.tags || '';
    const tags = splitTags(tagsRaw).map(normalizeTagName).filter(Boolean);

    //  Asesor y Ciclo
    const asesor = String(row.asesor || '').trim();
    const ciclo = String(row.ciclo || '').trim();

    if (!mapByPhone.has(tel)) {
      mapByPhone.set(tel, {
        phone: tel,
        celular_cliente: tel,
        nombre,
        apellido,
        email_cliente: email,
        tags: new Set(tags),
        asesor,
        ciclo,
      });
    } else {
      const existing = mapByPhone.get(tel);
      if (!existing.nombre && nombre) existing.nombre = nombre;
      if (!existing.apellido && apellido) existing.apellido = apellido;
      if (!existing.email_cliente && email) existing.email_cliente = email;
      if (!existing.asesor && asesor) existing.asesor = asesor;
      if (!existing.ciclo && ciclo) existing.ciclo = ciclo;
      tags.forEach((t) => existing.tags.add(t));
    }

    filas_validas++;
  }

  if (mapByPhone.size === 0) {
    return res.status(200).json({
      status: 'success',
      message: 'No hubo filas válidas para procesar.',
      filas_recibidas: filas.length,
      filas_validas,
      errores,
    });
  }

  const MAX_UNICOS = 3000;
  if (mapByPhone.size > MAX_UNICOS) {
    return next(
      new AppError(
        `Importación demasiado grande: ${mapByPhone.size} teléfonos únicos. Máximo permitido: ${MAX_UNICOS}. Importa en lotes.`,
        413,
      ),
    );
  }

  // ========= 2) Transacción =========
  const resultado = await db.transaction(async (t) => {
    const clientesArray = Array.from(mapByPhone.values());

    // ──────────────────────────────────────────────────────────
    /// UPSERT etiquetas custom
    // ──────────────────────────────────────────────────────────
    const uniqueAsesores = new Set();
    const uniqueCiclos = new Set();

    clientesArray.forEach((c) => {
      if (c.asesor) uniqueAsesores.add(c.asesor);
      if (c.ciclo) uniqueCiclos.add(c.ciclo);
    });

    /**
     * Crea las opciones en etiquetas_custom_chat_center si no existen
     * (o reactiva soft-deleted) y devuelve Map<nombre, id>
     */
    const upsertCustomLabels = async (tipo, namesSet) => {
      const names = Array.from(namesSet).filter(Boolean);
      if (names.length === 0) return new Map();

      for (const nombre of names) {
        // ¿Existe soft-deleted? → reactivar
        const [softDeleted] = await db.query(
          `SELECT id FROM etiquetas_custom_chat_center
           WHERE id_configuracion = ? AND tipo = ? AND nombre = ? AND deleted_at IS NOT NULL
           LIMIT 1`,
          {
            replacements: [id_configuracion, tipo, nombre],
            type: db.QueryTypes.SELECT,
            transaction: t,
          },
        );

        if (softDeleted) {
          await db.query(
            `UPDATE etiquetas_custom_chat_center SET deleted_at = NULL WHERE id = ?`,
            {
              replacements: [softDeleted.id],
              type: db.QueryTypes.UPDATE,
              transaction: t,
            },
          );
          continue;
        }

        // Insertar si no existe (IGNORE para evitar duplicados activos)
        await db.query(
          `INSERT IGNORE INTO etiquetas_custom_chat_center
             (id_configuracion, tipo, nombre, created_at)
           VALUES (?, ?, ?, NOW())`,
          {
            replacements: [id_configuracion, tipo, nombre],
            type: db.QueryTypes.INSERT,
            transaction: t,
          },
        );
      }

      // Mapear nombre → id
      const placeholders = names.map(() => '?').join(',');
      const rows = await db.query(
        `SELECT id, nombre FROM etiquetas_custom_chat_center
         WHERE id_configuracion = ? AND tipo = ? AND nombre IN (${placeholders})
           AND deleted_at IS NULL`,
        {
          replacements: [id_configuracion, tipo, ...names],
          type: db.QueryTypes.SELECT,
          transaction: t,
        },
      );

      const map = new Map();
      rows.forEach((r) => map.set(r.nombre, r.id));
      return map;
    };

    const asesorIdByName = await upsertCustomLabels('asesor', uniqueAsesores);
    const cicloIdByName = await upsertCustomLabels('ciclo', uniqueCiclos);

    // ──────────────────────────────────────────────────────────
    // 2.1  Upsert masivo clientes
    // ──────────────────────────────────────────────────────────
    const clientChunks = chunkArray(clientesArray, 300);
    let clientes_upsert_intentos = 0;

    for (const chunk of clientChunks) {
      // 9 campos de datos + 2 timestamps = 11 placeholders
      const valuesSql = chunk
        .map(() => '(?,?,?,?,?,?,?,?,?,NOW(),NOW())')
        .join(',');

      const params = [];
      chunk.forEach((c) => {
        const idAsesor = c.asesor ? asesorIdByName.get(c.asesor) || null : null;
        const idCiclo = c.ciclo ? cicloIdByName.get(c.ciclo) || null : null;

        params.push(
          id_configuracion,
          uid_cliente_config,
          c.nombre || '',
          c.apellido || '',
          c.email_cliente || '',
          c.celular_cliente || '',
          0, // propietario
          idAsesor,
          idCiclo,
        );
      });

      const upsertSql = `
        INSERT INTO clientes_chat_center
          (id_configuracion, uid_cliente, nombre_cliente, apellido_cliente,
           email_cliente, celular_cliente, propietario,
           id_etiqueta_asesor, id_etiqueta_ciclo,
           created_at, updated_at)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE
          uid_cliente        = COALESCE(VALUES(uid_cliente), uid_cliente),
          nombre_cliente     = COALESCE(NULLIF(VALUES(nombre_cliente), ''), nombre_cliente),
          apellido_cliente   = COALESCE(NULLIF(VALUES(apellido_cliente), ''), apellido_cliente),
          email_cliente      = COALESCE(NULLIF(VALUES(email_cliente), ''), email_cliente),
          celular_cliente    = COALESCE(NULLIF(VALUES(celular_cliente), ''), celular_cliente),
          id_etiqueta_asesor = COALESCE(VALUES(id_etiqueta_asesor), id_etiqueta_asesor),
          id_etiqueta_ciclo  = COALESCE(VALUES(id_etiqueta_ciclo), id_etiqueta_ciclo),
          updated_at         = NOW()
      `;

      await db.query(upsertSql, {
        replacements: params,
        type: db.QueryTypes.INSERT,
        transaction: t,
      });

      clientes_upsert_intentos += chunk.length;
    }

    // ──────────────────────────────────────────────────────────
    // 2.2  Obtener IDs de clientes por teléfono (mapeo phone → id)
    // ──────────────────────────────────────────────────────────
    const phones = clientesArray.map((c) => c.phone);
    const phoneChunks = chunkArray(phones, 800);

    const clientIdByPhone = new Map();
    for (const pchunk of phoneChunks) {
      const placeholders = pchunk.map(() => '?').join(',');
      const selectSql = `
        SELECT id, celular_cliente
        FROM clientes_chat_center
        WHERE id_configuracion = ?
          AND celular_cliente IN (${placeholders})
      `;
      const rows = await db.query(selectSql, {
        replacements: [id_configuracion, ...pchunk],
        type: db.QueryTypes.SELECT,
        transaction: t,
      });

      rows.forEach((r) => clientIdByPhone.set(String(r.celular_cliente), r.id));
    }

    // ──────────────────────────────────────────────────────────
    // 2.3  Crear/Upsert etiquetas normales (columna "Etiquetas")
    // ──────────────────────────────────────────────────────────
    const allTagsSet = new Set();
    clientesArray.forEach((c) => {
      c.tags.forEach((tg) => allTagsSet.add(normalizeTagName(tg)));
    });

    const allTags = Array.from(allTagsSet).filter(Boolean);
    const tagIdByName = new Map();

    if (allTags.length > 0) {
      const tagChunks = chunkArray(allTags, 400);

      for (const tgChunk of tagChunks) {
        const valuesSql = tgChunk.map(() => '(?,?,?,NOW(),NOW())').join(',');
        const params = [];
        tgChunk.forEach((tg) => {
          params.push(id_configuracion, tg, pickDefaultColor());
        });

        const upsertTagsSql = `
          INSERT INTO etiquetas_chat_center
            (id_configuracion, nombre_etiqueta, color_etiqueta, created_at, updated_at)
          VALUES ${valuesSql}
          ON DUPLICATE KEY UPDATE
            updated_at = NOW()
        `;

        await db.query(upsertTagsSql, {
          replacements: params,
          type: db.QueryTypes.INSERT,
          transaction: t,
        });
      }

      const tagSelectChunks = chunkArray(allTags, 800);
      for (const tgSel of tagSelectChunks) {
        const placeholders = tgSel.map(() => '?').join(',');
        const selSql = `
          SELECT id_etiqueta, nombre_etiqueta
          FROM etiquetas_chat_center
          WHERE id_configuracion = ?
            AND nombre_etiqueta IN (${placeholders})
        `;
        const rows = await db.query(selSql, {
          replacements: [id_configuracion, ...tgSel],
          type: db.QueryTypes.SELECT,
          transaction: t,
        });

        rows.forEach((r) =>
          tagIdByName.set(String(r.nombre_etiqueta), r.id_etiqueta),
        );
      }
    }

    // ──────────────────────────────────────────────────────────
    // 2.4  Sincronizar etiquetas normales (quitar las que no vienen)
    // ──────────────────────────────────────────────────────────
    const desiredTagIdsByClient = new Map();

    clientesArray.forEach((c) => {
      // FIX: Si el Excel no trae etiquetas para este cliente, NO tocar sus tags existentes
      if (c.tags.size === 0) return;

      const clientId = clientIdByPhone.get(String(c.phone));
      if (!clientId) return;

      const set = new Set();
      c.tags.forEach((tg) => {
        const tagId = tagIdByName.get(normalizeTagName(tg));
        if (tagId) set.add(tagId);
      });

      desiredTagIdsByClient.set(clientId, set);
    });

    const affectedClientIdsForSync = Array.from(desiredTagIdsByClient.keys());
    const affectedChunks = chunkArray(affectedClientIdsForSync, 300);

    for (const idChunk of affectedChunks) {
      const placeholders = idChunk.map(() => '?').join(',');

      const currentRows = await db.query(
        `
        SELECT id_cliente_chat_center AS clientId, id_etiqueta AS tagId
        FROM etiquetas_asignadas
        WHERE id_configuracion = ?
          AND id_cliente_chat_center IN (${placeholders})
        `,
        {
          replacements: [id_configuracion, ...idChunk],
          type: db.QueryTypes.SELECT,
          transaction: t,
        },
      );

      const toDelete = [];
      currentRows.forEach((r) => {
        const desiredSet = desiredTagIdsByClient.get(r.clientId) || new Set();
        if (!desiredSet.has(r.tagId)) {
          toDelete.push({ clientId: r.clientId, tagId: r.tagId });
        }
      });

      if (toDelete.length) {
        const delValues = toDelete.map(() => '(?,?)').join(',');
        const delParams = [];
        toDelete.forEach((x) => delParams.push(x.clientId, x.tagId));

        await db.query(
          `
          DELETE FROM etiquetas_asignadas
          WHERE id_configuracion = ?
            AND (id_cliente_chat_center, id_etiqueta) IN (${delValues})
          `,
          {
            replacements: [id_configuracion, ...delParams],
            type: db.QueryTypes.DELETE,
            transaction: t,
          },
        );
      }
    }

    // ──────────────────────────────────────────────────────────
    // 2.5  Insertar asignaciones etiquetas normales
    // ──────────────────────────────────────────────────────────
    const pairs = [];
    const pairKey = new Set();

    clientesArray.forEach((c) => {
      const clientId = clientIdByPhone.get(String(c.phone));
      if (!clientId) return;

      c.tags.forEach((tg) => {
        const tagId = tagIdByName.get(normalizeTagName(tg));
        if (!tagId) return;

        const key = `${clientId}-${tagId}`;
        if (pairKey.has(key)) return;
        pairKey.add(key);

        pairs.push({ clientId, tagId });
      });
    });

    const pairChunks = chunkArray(pairs, 800);
    let asignaciones_intentos = 0;

    for (const pchunk of pairChunks) {
      const valuesSql = pchunk.map(() => '(?,?,?,NOW(),NOW())').join(',');
      const params = [];

      pchunk.forEach((p) => {
        params.push(p.tagId, p.clientId, id_configuracion);
      });

      const insertAsigSql = `
        INSERT INTO etiquetas_asignadas
          (id_etiqueta, id_cliente_chat_center, id_configuracion, created_at, updated_at)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE
          updated_at = NOW(),
          id_configuracion = VALUES(id_configuracion)
      `;

      await db.query(insertAsigSql, {
        replacements: params,
        type: db.QueryTypes.INSERT,
        transaction: t,
      });

      asignaciones_intentos += pchunk.length;
    }

    // ──────────────────────────────────────────────────────────
    // 2.6  Actualizar cache JSON etiquetas normales
    // ──────────────────────────────────────────────────────────
    if (actualizar_cache_etiquetas) {
      const affectedClientIds = affectedClientIdsForSync;
      const clientIdChunks = chunkArray(affectedClientIds, 300);

      for (const idChunk of clientIdChunks) {
        const placeholders = idChunk.map(() => '?').join(',');

        const rows = await db.query(
          `
          SELECT
            ea.id_cliente_chat_center AS id_cliente,
            ec.id_etiqueta,
            ec.nombre_etiqueta,
            ec.color_etiqueta
          FROM etiquetas_asignadas ea
          INNER JOIN etiquetas_chat_center ec
            ON ec.id_etiqueta = ea.id_etiqueta
           AND ec.id_configuracion = ea.id_configuracion
          WHERE ea.id_configuracion = ?
            AND ea.id_cliente_chat_center IN (${placeholders})
          ORDER BY ea.id_cliente_chat_center, ec.id_etiqueta
        `,
          {
            replacements: [id_configuracion, ...idChunk],
            type: db.QueryTypes.SELECT,
            transaction: t,
          },
        );

        const map = new Map();
        rows.forEach((r) => {
          const cid = r.id_cliente;
          if (!map.has(cid)) map.set(cid, []);
          map.get(cid).push({
            id: r.id_etiqueta,
            color: r.color_etiqueta,
            nombre: r.nombre_etiqueta,
          });
        });

        for (const cid of idChunk) {
          const lista = map.get(cid) || [];

          await db.query(
            `
            UPDATE clientes_chat_center
            SET etiquetas = ?, updated_at = NOW()
            WHERE id = ? AND id_configuracion = ?
          `,
            {
              replacements: [JSON.stringify(lista), cid, id_configuracion],
              type: db.QueryTypes.UPDATE,
              transaction: t,
            },
          );
        }
      }
    }

    return {
      clientes_procesados: clientesArray.length,
      clientes_upsert_intentos,
      etiquetas_unicas: allTags.length,
      asignaciones_unicas: pairs.length,
      asignaciones_intentos,
      etiquetas_custom: {
        asesores_creados: uniqueAsesores.size,
        ciclos_creados: uniqueCiclos.size,
      },
    };
  });

  return res.status(200).json({
    status: 'success',
    message: 'Importación masiva ejecutada correctamente.',
    resumen: resultado,
    filas_recibidas: filas.length,
    filas_validas,
    telefonos_unicos: mapByPhone.size,
    errores,
  });
});
