const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');

const Planes_chat_centerModel = require('../models/planes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Usuarios_chat_centerModel = require('../models/usuarios_chat_center.model');

const ChatService = require('../services/chat.service');
const { Op, fn, col } = require('sequelize');

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
      }
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
      }
    );

    if (!configuracion) {
      return next(
        new AppError('No se encontró configuración para la plataforma', 400)
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
      }
    );

    if (!clientes_chat_center) {
      return next(
        new AppError('No se encontró configuración para la plataforma', 400)
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
  } = req.body;

  try {
    // 1) Obtener datos desde configuraciones (para armar el "cliente propietario")
    const [config] = await db.query(
      'SELECT id_telefono, nombre_configuracion FROM configuraciones WHERE id = ? AND suspendido = 0',
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
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
        (id_configuracion, uid_cliente, nombre_cliente, apellido_cliente, celular_cliente, propietario, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
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
        telefono_configuracion,
        1,
      ],
      type: db.QueryTypes.INSERT,
    });

    const [{ id: id_cliente_configuracion }] = await db.query(
      'SELECT LAST_INSERT_ID() AS id',
      { type: db.QueryTypes.SELECT }
    );

    // 3) Insertar mensaje (aquí NO toqué su lógica; si quiere anti-duplicado aquí también, se hace con UNIQUE + IGNORE/UPSERT)
    await db.query(
      `INSERT INTO mensajes_clientes 
        (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje, rol_mensaje, celular_recibe, responsable, texto_mensaje, ruta_archivo, visto, uid_whatsapp, id_wamid_mensaje, template_name, language_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          id_cliente_configuracion,
          mid_mensaje,
          tipo_mensaje,
          1,
          id_recibe,
          responsable,
          texto_mensaje,
          ruta_archivo,
          1,
          telefono_recibe,
          id_wamid_mensaje,
          template_name,
          language_code,
        ],
        type: db.QueryTypes.INSERT,
      }
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
      }
    );

    // Después eliminamos de la tabla errores_chat_meta
    await db.query(
      `DELETE FROM errores_chat_meta 
       WHERE id_wamid_mensaje = ?`,
      {
        replacements: [id_wamid_mensaje],
        type: db.QueryTypes.DELETE,
      }
    );

    return res.status(200).json({
      status: 200,
      title: 'Petición exitosa',
      message: 'Mensaje actualizado y error eliminado correctamente',
    });
  } catch (error) {
    console.error(
      'Error al actualizar mensaje reenviado o eliminar error:',
      error
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

exports.findFullByPhone_desconect = catchAsync(async (req, res, next) => {
  const phone = req.params.phone.trim();
  const id_configuracion = req.query.id_configuracion;

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const chatService = new ChatService();
  const chat = await chatService.findChatByPhone_desconect(
    id_configuracion,
    phone
  );

  if (!chat)
    return res.status(404).json({ status: 404, message: 'Chat no encontrado' });

  res.json({ status: 200, data: chat });
});

/* ---------- helpers ---------- */
function parseSort(sort) {
  switch (sort) {
    case 'antiguos':
      return 'created_at ASC';
    case 'actividad_asc':
      return 'updated_at ASC';
    case 'actividad_desc':
      return 'updated_at DESC';
    case 'recientes':
    default:
      return 'created_at DESC';
  }
}
function parseEstado(estado) {
  if (
    estado === undefined ||
    estado === null ||
    estado === '' ||
    estado === 'todos'
  )
    return null;
  if (
    estado === '1' ||
    estado === 1 ||
    estado === 'activo' ||
    estado === 'nuevo'
  )
    return 1;
  if (
    estado === '0' ||
    estado === 0 ||
    estado === 'inactivo' ||
    estado === 'perdido'
  )
    return 0;
  return null;
}

exports.listarContactosEstado = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.body;

  if (!id_configuracion) {
    return next(new AppError('Falta el id_configuracion', 400));
  }

  try {
    // 1) Consultar todos los contactos de esa configuración
    const clientes = await db.query(
      `SELECT id, nombre_cliente, apellido_cliente, telefono_limpio, estado_contacto, created_at, bot_openia
       FROM clientes_chat_center
       WHERE id_configuracion = ? AND propietario <> 1;`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    // 2) Si no existen contactos
    if (!clientes || clientes.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          CONTACTO_INICIAL: [],
          PLATAFORMAS_Y_CLASES: [],
          PRODUCTOS_Y_PROVEEDORES: [],
          VENTAS: [],
          ASESOR: [],
          COTIZACIONES: [],
          IA_VENTAS: [],
          GENERAR_GUIA: [],
          SEGUIMIENTO: [],
          CANCELADO: [],
          IA_VENTAS_IMPORSHOP: [],
          ATENCION_URGENTE: [],
        },
      });
    }

    // 3) Construir estructura Kanban inicial
    const data = {
      CONTACTO_INICIAL: [],
      PLATAFORMAS_Y_CLASES: [],
      PRODUCTOS_Y_PROVEEDORES: [],
      VENTAS: [],
      ASESOR: [],
      COTIZACIONES: [],
      IA_VENTAS: [],
      GENERAR_GUIA: [],
      SEGUIMIENTO: [],
      CANCELADO: [],
      IA_VENTAS_IMPORSHOP: [],
      ATENCION_URGENTE: [],
    };

    // 4) Clasificar cada contacto según su estado
    clientes.forEach((c) => {
      const estado = (c.estado_contacto || '').toLowerCase();

      switch (estado) {
        case 'contacto_inicial':
          data.CONTACTO_INICIAL.push(c);
          break;

        case 'plataformas_clases':
          data.PLATAFORMAS_Y_CLASES.push(c);
          break;

        case 'productos_proveedores':
          data.PRODUCTOS_Y_PROVEEDORES.push(c);
          break;

        case 'ventas_imporfactory':
          data.VENTAS.push(c);
          break;

        case 'asesor':
          data.ASESOR.push(c);
          break;

        case 'cotizaciones_imporfactory':
          data.COTIZACIONES.push(c);
          break;

        case 'ia_ventas':
          data.IA_VENTAS.push(c);
          break;

        case 'generar_guia':
          data.GENERAR_GUIA.push(c);
          break;

        case 'seguimiento':
          data.SEGUIMIENTO.push(c);
          break;

        case 'cancelado':
          data.CANCELADO.push(c);
          break;

        case 'ia_ventas_imporshop':
          data.IA_VENTAS_IMPORSHOP.push(c);
          break;

        case 'atencion_urgente':
          data.ATENCION_URGENTE.push(c);
          break;

        default:
          // Si llega un estado desconocido, lo mando a "CONTACTO INICIAL"
          data.CONTACTO_INICIAL.push(c);
          break;
      }
    });

    // 5) Respuesta al frontend
    return res.status(200).json({
      success: true,
      data: data,
    });
  } catch (error) {
    console.error('Error al listar contactos:', error);

    return res.status(500).json({
      success: false,
      message: 'Ocurrió un error al listar los contactos',
    });
  }
});

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
      }
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

/* ============================================================
   GET /api/v1/clientes_chat_center/listar
   ?page=&limit=&q=&estado=&id_etiqueta=&sort=
   ============================================================ */
exports.listarClientes = catchAsync(async (req, res, next) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
  const offset = (page - 1) * limit;
  const id_configuracion = req.query.id_configuracion ?? '';

  const subUsuarioSession = req.sessionUser;
  if (!subUsuarioSession) {
    return res.status(401).json({
      status: 'fail',
      message: 'No estás autenticado como subusuario',
    });
  }

  const id_usuario_session = subUsuarioSession.id_usuario;

  let validar_permiso_usuario = await Configuraciones.findOne({
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

  const { q, id_etiqueta } = req.query;
  const estadoParsed = parseEstado(req.query.estado);
  const orderBy = parseSort(req.query.sort);

  const whereParts = ['deleted_at IS NULL'];
  const params = [];

  if (estadoParsed !== null) {
    whereParts.push('estado_cliente = ?');
    params.push(estadoParsed);
  }
  if (id_etiqueta) {
    whereParts.push('id_etiqueta = ?');
    params.push(id_etiqueta);
  }
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    whereParts.push(`(
      nombre_cliente   LIKE ? OR
      apellido_cliente LIKE ? OR
      email_cliente    LIKE ? OR
      celular_cliente  LIKE ? OR
      telefono_limpio  LIKE ? OR
      uid_cliente      LIKE ?
    )`);
    params.push(like, like, like, like, like, like);
  }

  const whereClause = whereParts.length
    ? `WHERE ${whereParts.join(' AND ')}`
    : '';

  // Datos
  const dataSql = `
    SELECT
      id, id_plataforma, id_configuracion, id_etiqueta, uid_cliente,
      nombre_cliente, apellido_cliente, email_cliente, celular_cliente,
      imagePath, mensajes_por_dia_cliente, estado_cliente,
      created_at, updated_at, deleted_at,
      chat_cerrado, bot_openia, id_departamento, id_encargado,
      pedido_confirmado, telefono_limpio, direccion, productos,
      -- Aquí es donde agregamos la lógica para determinar el valor de "aprobado"
    CASE 
        WHEN EXISTS (
            SELECT 1 
            FROM mensajes_clientes m
            WHERE m.celular_recibe = clientes_chat_center.id
              AND m.rol_mensaje = 0
        ) THEN 1
        ELSE 0
    END AS aprobado
    FROM clientes_chat_center
    ${whereClause}
    AND id_configuracion = ${id_configuracion}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?;
  `;
  const dataParams = [...params, limit, offset];

  // Total
  const countSql = `
    SELECT COUNT(*) AS total
    FROM clientes_chat_center
    ${whereClause}
    AND id_configuracion = ${id_configuracion};
  `;

  const rows = await db.query(dataSql, {
    replacements: dataParams,
    type: db.QueryTypes.SELECT,
  });
  const [{ total }] = await db.query(countSql, {
    replacements: params,
    type: db.QueryTypes.SELECT,
  });

  return res.status(200).json({
    status: 'success',
    data: rows,
    total,
    page,
    limit,
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
    { replacements: [lastId], type: db.QueryTypes.SELECT }
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
    { replacements: [id], type: db.QueryTypes.SELECT }
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

  // ✅ CLAVE: filtrar también etiquetas_asignadas por id_configuracion
  const baseFromJoin = `
    FROM clientes_chat_center c
    INNER JOIN etiquetas_asignadas ea
      ON ea.id_cliente_chat_center = c.id
     AND ea.id_configuracion = c.id_configuracion
    WHERE ${where.join(' AND ')}
      AND ea.id_etiqueta IN (${inPlaceholders})
  `;

  const dataSql = `
    SELECT
      c.id, c.id_plataforma, c.id_configuracion, c.id_etiqueta, c.uid_cliente,
      c.nombre_cliente, c.apellido_cliente, c.email_cliente, c.celular_cliente,
      c.imagePath, c.mensajes_por_dia_cliente, c.estado_cliente,
      c.created_at, c.updated_at, c.deleted_at,
      c.chat_cerrado, c.bot_openia, c.id_departamento, c.id_encargado,
      c.pedido_confirmado, c.telefono_limpio, c.direccion, c.productos
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
      subUsuarioSession.id_sub_usuario
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
      { include: [{ model: Planes_chat_centerModel, as: 'plan' }] }
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
        Number(row.total || 0)
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
      0
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
