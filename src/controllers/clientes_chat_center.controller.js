const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const ClientesChatCenter = require('../models/clientes_chat_center.model');

const ChatService = require('../services/chat.service');

// controllers/clientes_chat_centerController.js
exports.actualizar_cerrado = catchAsync(async (req, res, next) => {
  const { chatId, nuevoEstado, bot_openia } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE clientes_chat_center SET chat_cerrado = ?, bot_openia = ? WHERE id = ?`,
      {
        replacements: [nuevoEstado, bot_openia, chatId],
        type: db.QueryTypes.UPDATE,
      }
    );

    // result en UPDATE devuelve un array (dependiendo de la DB puede ser el número de filas afectadas)
    res.status(200).json({
      status: '200',
      title: 'Petición exitosa',
      message: 'Chat actualizado correctamente',
    });
  } catch (error) {
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
      'SELECT id_telefono FROM configuraciones WHERE id = ?',
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

    await db.query(
      `INSERT INTO clientes_chat_center 
      (id_configuracion, nombre_cliente, apellido_cliente, celular_cliente, uid_cliente)
      VALUES (?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          nombre,
          apellido,
          telefono,
          uid_cliente,
        ],
        type: db.QueryTypes.INSERT,
      }
    );

    const [resultado] = await db.query(
      `SELECT id FROM clientes_chat_center 
       WHERE celular_cliente = ? AND id_configuracion = ?
       ORDER BY id DESC LIMIT 1`,
      {
        replacements: [telefono, id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    if (!resultado) {
      return next(new AppError('No se pudo recuperar el ID del registro', 400));
    }

    const lastId = resultado.id;

    return res.status(200).json({
      status: 200,
      title: 'Petición exitosa',
      message: 'Número agregado correctamente',
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
    // 1. Verificar si ya existe cliente con el teléfono de configuración
    const [clienteExistente] = await db.query(
      'SELECT id FROM clientes_chat_center WHERE celular_cliente = ? AND id_configuracion = ?',
      {
        replacements: [telefono_configuracion, id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    let id_cliente_configuracion;

    if (!clienteExistente) {
      // 2. Obtener datos desde configuraciones
      const [config] = await db.query(
        'SELECT id_telefono, nombre_configuracion FROM configuraciones WHERE id = ?',
        {
          replacements: [id_configuracion],
          type: db.QueryTypes.SELECT,
        }
      );

      const id_telefono = config.id_telefono;
      const nombre_cliente = config.nombre_configuracion;
      const apellido_cliente = '';

      // 3. Insertar nuevo cliente
      await db.query(
        `INSERT INTO clientes_chat_center 
        (id_configuracion, uid_cliente, nombre_cliente, apellido_cliente, celular_cliente, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        {
          replacements: [
            id_configuracion,
            id_telefono,
            nombre_cliente,
            apellido_cliente,
            telefono_configuracion,
          ],
          type: db.QueryTypes.INSERT,
        }
      );

      // 4. Obtener ID insertado
      const [insertado] = await db.query(
        `SELECT id FROM clientes_chat_center 
         WHERE celular_cliente = ? AND id_configuracion = ?
         ORDER BY id DESC LIMIT 1`,
        {
          replacements: [telefono_configuracion, id_configuracion],
          type: db.QueryTypes.SELECT,
        }
      );

      id_cliente_configuracion = insertado.id;
    } else {
      id_cliente_configuracion = clienteExistente.id;
    }

    // 5. Insertar mensaje en mensajes_clientes
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
          1, // rol_mensaje fijo en 1
          id_recibe,
          responsable,
          texto_mensaje,
          ruta_archivo,
          1, // visto por defecto en 1
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
    case 'antiguos':       return 'created_at ASC';
    case 'actividad_asc':  return 'updated_at ASC';
    case 'actividad_desc': return 'updated_at DESC';
    case 'recientes':
    default:               return 'created_at DESC';
  }
}
function parseEstado(estado) {
  if (estado === undefined || estado === null || estado === '' || estado === 'todos') return null;
  if (estado === '1' || estado === 1 || estado === 'activo' || estado === 'nuevo') return 1;
  if (estado === '0' || estado === 0 || estado === 'inactivo' || estado === 'perdido') return 0;
  return null;
}

/* ============================================================
   GET /api/v1/clientes_chat_center/listar
   ?page=&limit=&q=&estado=&id_etiqueta=&sort=
   ============================================================ */
exports.listarClientes = catchAsync(async (req, res, next) => {
  const page  = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
  const offset = (page - 1) * limit;

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

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  // Datos
  const dataSql = `
    SELECT
      id, id_plataforma, id_configuracion, id_etiqueta, uid_cliente,
      nombre_cliente, apellido_cliente, email_cliente, celular_cliente,
      imagePath, mensajes_por_dia_cliente, estado_cliente,
      created_at, updated_at, deleted_at,
      chat_cerrado, bot_openia, id_departamento, id_encargado,
      pedido_confirmado, telefono_limpio
    FROM clientes_chat_center
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?;
  `;
  const dataParams = [...params, limit, offset];

  // Total
  const countSql = `
    SELECT COUNT(*) AS total
    FROM clientes_chat_center
    ${whereClause};
  `;

  const rows = await db.query(dataSql, { replacements: dataParams, type: db.QueryTypes.SELECT });
  const [{ total }] = await db.query(countSql, { replacements: params, type: db.QueryTypes.SELECT });

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

  const insertSql = `
    INSERT INTO clientes_chat_center (
      id_plataforma, id_configuracion, id_etiqueta, uid_cliente,
      nombre_cliente, apellido_cliente, email_cliente, celular_cliente,
      imagePath, mensajes_por_dia_cliente, estado_cliente,
      created_at, updated_at, chat_cerrado, bot_openia,
      id_departamento, id_encargado, pedido_confirmado
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, NOW(), NOW(), ?,?,?,?,?)
  `;
  const insertParams = [
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
    (estado_cliente ?? 1),
    (chat_cerrado ?? 0),
    (bot_openia ?? 1),
    id_departamento ?? null,
    id_encargado ?? null,
    pedido_confirmado ?? 0,
  ];

  // Ejecutar inserción
  const result = await db.query(insertSql, { replacements: insertParams, type: db.QueryTypes.INSERT });
  // `result` en mysql2 suele ser [metadata, _]; recuperamos el último id con otra consulta fiable:
  const [{ id: lastId }] = await db.query('SELECT LAST_INSERT_ID() AS id', { type: db.QueryTypes.SELECT });

  // Devolver fila creada
  const [created] = await db.query(
    `SELECT id, id_plataforma, id_configuracion, id_etiqueta, uid_cliente,
            nombre_cliente, apellido_cliente, email_cliente, celular_cliente,
            imagePath, mensajes_por_dia_cliente, estado_cliente,
            created_at, updated_at, deleted_at, chat_cerrado, bot_openia,
            id_departamento, id_encargado, pedido_confirmado, telefono_limpio
     FROM clientes_chat_center WHERE id = ?`,
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
    'id_plataforma','id_configuracion','id_etiqueta','uid_cliente',
    'nombre_cliente','apellido_cliente','email_cliente','celular_cliente',
    'imagePath','mensajes_por_dia_cliente','estado_cliente',
    'chat_cerrado','bot_openia','id_departamento','id_encargado','pedido_confirmado'
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
  if (setParts.length === 0) return res.status(200).json({ status: 'success', data: null });

  setParts.push('updated_at = NOW()');

  const updateSql = `
    UPDATE clientes_chat_center
    SET ${setParts.join(', ')}
    WHERE id = ? AND deleted_at IS NULL
  `;
  params.push(id);

  const upd = await db.query(updateSql, { replacements: params, type: db.QueryTypes.UPDATE });

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