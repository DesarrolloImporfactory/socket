const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

const { db } = require('../database/config');
const ClientesChatCenter = require('../models/clientes_chat_center.model');

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
  const { telefono, nombre, apellido, id_plataforma } = req.body;

  try {
    // 1. Obtener id_telefono desde configuraciones
    const [configuracion] = await db.query(
      'SELECT id_telefono FROM configuraciones WHERE id_plataforma = ?',
      {
        replacements: [id_plataforma],
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
      (id_plataforma, nombre_cliente, apellido_cliente, celular_cliente, uid_cliente)
      VALUES (?, ?, ?, ?, ?)`,
      {
        replacements: [id_plataforma, nombre, apellido, telefono, uid_cliente],
        type: db.QueryTypes.INSERT,
      }
    );

    const [resultado] = await db.query(
      `SELECT id FROM clientes_chat_center 
       WHERE celular_cliente = ? AND id_plataforma = ?
       ORDER BY id DESC LIMIT 1`,
      {
        replacements: [telefono, id_plataforma],
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
  const { telefono, id_plataforma } = req.body;

  try {
    const [clientes_chat_center] = await db.query(
      'SELECT id FROM clientes_chat_center WHERE celular_cliente = ? AND id_plataforma = ?',
      {
        replacements: [telefono, id_plataforma],
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
    id_plataforma,
  } = req.body;

  try {
    // 1. Verificar si ya existe cliente con el teléfono de configuración
    const [clienteExistente] = await db.query(
      'SELECT id FROM clientes_chat_center WHERE celular_cliente = ? AND id_plataforma = ?',
      {
        replacements: [telefono_configuracion, id_plataforma],
        type: db.QueryTypes.SELECT,
      }
    );

    let id_cliente_configuracion;

    if (!clienteExistente) {
      // 2. Obtener datos desde configuraciones
      const [config] = await db.query(
        'SELECT id_telefono, nombre_configuracion FROM configuraciones WHERE id_plataforma = ?',
        {
          replacements: [id_plataforma],
          type: db.QueryTypes.SELECT,
        }
      );

      const id_telefono = config.id_telefono;
      const nombre_cliente = config.nombre_configuracion;
      const apellido_cliente = '';

      // 3. Insertar nuevo cliente
      await db.query(
        `INSERT INTO clientes_chat_center 
        (id_plataforma, uid_cliente, nombre_cliente, apellido_cliente, celular_cliente, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        {
          replacements: [
            id_plataforma,
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
         WHERE celular_cliente = ? AND id_plataforma = ?
         ORDER BY id DESC LIMIT 1`,
        {
          replacements: [telefono_configuracion, id_plataforma],
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
        (id_plataforma, id_cliente, mid_mensaje, tipo_mensaje, rol_mensaje, celular_recibe, texto_mensaje, ruta_archivo, visto, uid_whatsapp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_plataforma,
          id_cliente_configuracion,
          mid_mensaje,
          tipo_mensaje,
          1, // rol_mensaje fijo en 1
          id_recibe,
          texto_mensaje,
          ruta_archivo,
          1, // visto por defecto en 1
          telefono_recibe,
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
