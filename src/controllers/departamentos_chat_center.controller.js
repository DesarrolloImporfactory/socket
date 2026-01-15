const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const { db } = require('../database/config');

const DepartamentosChatCenter = require('../models/departamentos_chat_center.model');
const Sub_usuarios_departamento = require('../models/sub_usuarios_departamento.model');
const Clientes_chat_center = require('../models/clientes_chat_center.model');
const Historial_encargados = require('../models/historial_encargados.model');
const HistorialEncargadosFacebook = require('../models/historial_encargados_messenger.model');

const MessengerConversation = require('../models/messenger_conversations.model');
const MessengerMessage = require('../models/messenger_messages.model');
const InstagramConversation = require('../models/instagram_conversations.model');
const InstagramMessage = require('../models/instagram_messages.model');
const HistorialEncargadosInstagram = require('../models/historial_encargados_instagram.model');

const Configuraciones = require('../models/configuraciones.model');
const MensajesClientes = require('../models/mensaje_cliente.model');

const {
  enviarConsultaAPI,
} = require('../utils/webhook_whatsapp/enviar_consulta_socket');

exports.listarDepartamentos = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;

  const departamentos = await DepartamentosChatCenter.findAll({
    where: { id_usuario },
    include: [
      {
        model: Configuraciones,
        as: 'configuracion',
        attributes: ['nombre_configuracion'],
        required: false,
      },
    ],
  });

  if (!departamentos || departamentos.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: [],
      message: 'No existen departamentos para este usuario.',
    });
  }

  const departamentosConUsuarios = await Promise.all(
    departamentos.map(async (dep) => {
      const asignaciones = await Sub_usuarios_departamento.findAll({
        where: { id_departamento: dep.id_departamento },
        attributes: ['id_sub_usuario'],
      });

      const depJson = dep.toJSON();

      return {
        ...depJson,
        nombre_configuracion:
          depJson.configuracion?.nombre_configuracion ?? null,
        usuarios_asignados: asignaciones.map((a) => a.id_sub_usuario),
        // opcional: si no quieres devolver el objeto configuracion anidado:
        // configuracion: undefined,
      };
    })
  );

  res.status(200).json({
    status: 'success',
    data: departamentosConUsuarios,
  });
});

exports.listar_por_usuario = catchAsync(async (req, res, next) => {
  const { id_sub_usuario } = req.body;

  const departamentos = await db.query(
    'SELECT dcc.id_departamento, dcc.nombre_departamento, dcc.color, dcc.id_configuracion FROM departamentos_chat_center dcc INNER JOIN sub_usuarios_departamento sud ON dcc.id_departamento = sud.id_departamento WHERE sud.id_sub_usuario = ?;',
    {
      replacements: [id_sub_usuario],
      type: db.QueryTypes.SELECT,
    }
  );
  if (!departamentos || departamentos.length === 0) {
    res.status(201).json({
      status: 'success',
      data: 'No se encontro departamento',
    });
  }

  res.status(200).json({
    status: 'success',
    data: departamentos,
  });
});

exports.agregarDepartamento = catchAsync(async (req, res, next) => {
  const {
    id_usuario,
    nombre_departamento,
    color,
    mensaje_saludo,
    id_configuracion,
    usuarios_asignados = [], // Array de id_sub_usuario
  } = req.body;

  // Validaciones mínimas
  if (!id_usuario || !nombre_departamento || !color) {
    return res.status(400).json({
      status: 'fail',
      message: 'No ha llenado los datos del departamento.',
    });
  }

  // TIP: si quieres atomicidad total, usa una transacción:
  // const t = await sequelize.transaction();
  // try { ... await t.commit(); } catch (e) { await t.rollback(); throw e; }

  // 1) Crear el departamento
  const nuevoDepartamento = await DepartamentosChatCenter.create({
    id_usuario,
    nombre_departamento,
    color,
    mensaje_saludo,
    id_configuracion,
  });

  const id_departamento = nuevoDepartamento.id_departamento;

  // 2) Insertar asignaciones (si llegan)
  if (Array.isArray(usuarios_asignados) && usuarios_asignados.length > 0) {
    const filas = usuarios_asignados.map((id_sub_usuario) => ({
      id_departamento,
      id_sub_usuario,
    }));

    // Si tienes un índice único (id_departamento, id_sub_usuario),
    // puedes usar ignoreDuplicates para evitar error si se repite algún ID:
    await Sub_usuarios_departamento.bulkCreate(filas, {
      ignoreDuplicates: true,
    });
  }

  // 3) Responder incluyendo los usuarios asignados
  res.status(201).json({
    status: 'success',
    data: {
      ...nuevoDepartamento.toJSON(),
      usuarios_asignados,
    },
  });
});

exports.actualizarDepartamento = catchAsync(async (req, res, next) => {
  const {
    id_departamento,
    nombre_departamento,
    color,
    mensaje_saludo,
    id_configuracion,
    usuarios_asignados = [],
  } = req.body;

  if (!nombre_departamento || !color) {
    return res.status(400).json({
      status: 'fail',
      message: 'Faltan datos obligatorios: nombre_departamento o color',
    });
  }

  const departamento = await DepartamentosChatCenter.findByPk(id_departamento);
  if (!departamento) {
    return res.status(404).json({
      status: 'fail',
      message: 'Departamento no encontrado',
    });
  }

  const incoming = Array.from(
    new Set(
      (Array.isArray(usuarios_asignados) ? usuarios_asignados : []).map(Number)
    )
  );

  // ✅ instancia tomada del modelo
  const t = await DepartamentosChatCenter.sequelize.transaction();
  try {
    // 1) Actualizar datos del departamento
    await departamento.update(
      { nombre_departamento, color, mensaje_saludo, id_configuracion },
      { transaction: t }
    );

    // 2) Obtener asignaciones actuales
    const actuales = await Sub_usuarios_departamento.findAll({
      where: { id_departamento },
      attributes: ['id_sub_usuario'],
      raw: true,
      transaction: t,
    });
    const actualesIds = new Set(actuales.map((a) => Number(a.id_sub_usuario)));

    // 3) Diff
    const toAdd = incoming.filter((id) => !actualesIds.has(id));
    const toRemove = [...actualesIds].filter((id) => !incoming.includes(id));

    // 4) Eliminar los no seleccionados
    if (toRemove.length > 0) {
      await Sub_usuarios_departamento.destroy({
        where: { id_departamento, id_sub_usuario: toRemove },
        transaction: t,
      });
    }

    // 5) Insertar nuevos
    if (toAdd.length > 0) {
      const filas = toAdd.map((id_sub_usuario) => ({
        id_departamento,
        id_sub_usuario,
      }));
      await Sub_usuarios_departamento.bulkCreate(filas, {
        ignoreDuplicates: true, // requiere índice único compuesto recomendado
        transaction: t,
      });
    }

    await t.commit();

    return res.status(200).json({
      status: 'success',
      data: { ...departamento.toJSON(), usuarios_asignados: incoming },
    });
  } catch (err) {
    await t.rollback();
    return next(err);
  }
});

exports.eliminarDepartamento = catchAsync(async (req, res, next) => {
  const { id_departamento } = req.body;

  const departamento = await DepartamentosChatCenter.findByPk(id_departamento);

  if (!departamento) {
    return res.status(404).json({
      status: 'fail',
      message: 'Departamento no encontrado.',
    });
  }

  await departamento.destroy();

  res.status(200).json({
    status: 'success',
    message: 'Departamento eliminado correctamente.',
  });
});

exports.transferirChat = catchAsync(async (req, res, next) => {
  const {
    source, // 'ms' | 'ig' | 'wa' (o undefined => WhatsApp)
    id_encargado,
    id_departamento,
    id_cliente_chat_center, // para WhatsApp
    motivo,
    id_configuracion,
    emisor,
  } = req.body;

  if (id_encargado == null && id_departamento == null) {
    return res.status(400).json({
      status: 'fail',
      message: 'Debe enviar al menos id_encargado o id_departamento',
    });
  }

  switch (source) {
    case 'ms': {
      if (!id_cliente_chat_center) {
        return res.status(400).json({
          status: 'fail',
          message: 'Falta id_conversation para Messenger',
        });
      }

      const conversacionActual = await MessengerConversation.findOne({
        where: { id: id_cliente_chat_center },
      });

      if (!conversacionActual) {
        return res.status(404).json({
          status: 'fail',
          message: 'Conversación no encontrada',
        });
      }

      // 2) Guardar encargado anterior
      const id_encargado_anterior = conversacionActual.id_encargado;

      // 3) Historial
      await HistorialEncargadosFacebook.create({
        id_messenger_conversation: id_cliente_chat_center,
        id_departamento_asginado: id_departamento ?? null,
        id_encargado_anterior: id_encargado_anterior ?? null,
        id_encargado_nuevo: id_encargado,
        motivo: motivo ?? null,
      });

      // 4) Actualizar conversación
      await MessengerConversation.update(
        { id_encargado: id_encargado, id_departamento: id_departamento },
        {
          where: { id: id_cliente_chat_center },
        }
      );

      // 5) Crear messenger_messages (notificación)
      await MessengerMessage.create({
        conversation_id: conversacionActual.id,
        id_configuracion: conversacionActual.id_configuracion,
        page_id: conversacionActual.page_id,
        psid: conversacionActual.psid,

        direction: 'out',
        mid: null,
        text: `${emisor || 'Sistema'} te transfirió este chat. Motivo: ${
          motivo || 'No especificado'
        }`,
        attachments: null,
        postback_payload: null,
        quick_reply_payload: null,
        sticker_id: null,

        status: 'notification',

        meta: {
          system_notification: true,
          type: 'transfer',
          from_id_encargado: id_encargado_anterior ?? null,
          to_id_encargado: id_encargado ?? null,
          id_departamento: id_departamento ?? null,
          emisor: emisor ?? null,
          motivo: motivo ?? null,
        },

        // si quiere registrar quién ejecutó la transferencia (humano):
        // id_encargado: id_encargado,
        id_encargado: null,
      });

      break;
    }
    case 'ig': {
      if (!id_cliente_chat_center) {
        return res.status(400).json({
          status: 'fail',
          message: 'Falta id_conversation para Instagram',
        });
      }

      const conversacionActual = await InstagramConversation.findOne({
        where: { id: id_cliente_chat_center },
      });

      if (!conversacionActual) {
        return res.status(404).json({
          status: 'fail',
          message: 'Conversación no encontrada',
        });
      }

      // 2) Guardar encargado anterior
      const id_encargado_anterior = conversacionActual.id_encargado;

      // 3) Historial
      await HistorialEncargadosInstagram.create({
        id_instagram_conversation: id_cliente_chat_center,
        id_departamento_asginado: id_departamento ?? null,
        id_encargado_anterior: id_encargado_anterior ?? null,
        id_encargado_nuevo: id_encargado,
        motivo: motivo ?? null,
      });

      // 4) Actualizar conversación
      await InstagramConversation.update(
        { id_encargado: id_encargado, id_departamento: id_departamento },
        { where: { id: id_cliente_chat_center } }
      );

      // 5) Crear instagram_messages (notificación)
      await InstagramMessage.create({
        conversation_id: conversacionActual.id,
        id_configuracion: conversacionActual.id_configuracion,
        page_id: conversacionActual.page_id,
        igsid: conversacionActual.igsid,

        direction: 'out',
        mid: null,
        text: `${emisor || 'Sistema'} te transfirió este chat. Motivo: ${
          motivo || 'No especificado'
        }`,

        // En su modelo es TEXT('long'), puede ir null o string
        attachments: null,

        status: 'notification',

        delivery_watermark: null,
        read_watermark: null,
        error_code: null,
        error_subcode: null,
        error_message: null,

        // En su modelo meta es TEXT('long'), así que guárdelo como string JSON
        meta: JSON.stringify({
          system_notification: true,
          type: 'transfer',
          from_id_encargado: id_encargado_anterior ?? null,
          to_id_encargado: id_encargado ?? null,
          id_departamento: id_departamento ?? null,
          emisor: emisor ?? null,
          motivo: motivo ?? null,
        }),

        id_encargado: null,
        is_unsupported: 0,
      });

      break;
    }
    // WhatsApp por defecto (o 'wa')
    default: {
      if (!id_cliente_chat_center) {
        return res.status(400).json({
          status: 'fail',
          message: 'Falta id_cliente_chat_center para WhatsApp',
        });
      }

      // 1. Obtener el registro actual
      const clienteActual = await Clientes_chat_center.findOne({
        where: { id: id_cliente_chat_center },
      });

      if (!clienteActual) {
        return res.status(404).json({
          status: 'fail',
          message: 'Cliente no encontrado',
        });
      }

      // 2. Guardar el id_encargado actual en variable
      const id_encargado_anterior = clienteActual.id_encargado;

      await Historial_encargados.create({
        id_cliente_chat_center,
        id_departamento_asginado: id_departamento,
        id_encargado_anterior,
        id_encargado_nuevo: id_encargado,
        motivo,
      });

      const configuracion_transferida = await DepartamentosChatCenter.findOne({
        where: { id_departamento },
      });

      if (configuracion_transferida.id_configuracion == id_configuracion) {
        /* validar si existe un cliente ya en esa otra configuracion */
        const validar_cliente_new_conf = await Clientes_chat_center.findOne({
          where: {
            id_configuracion: configuracion_transferida.id_configuracion,
            celular_cliente: clienteActual.celular_cliente,
          },
        });

        if (validar_cliente_new_conf) {
          await Clientes_chat_center.update(
            { id_encargado: id_encargado },
            {
              where: { id: id_cliente_chat_center },
            }
          );

          // Buscar el cliente propietario de esa configuración (igual que arriba)
          const cliente_configuracion = await Clientes_chat_center.findOne({
            where: {
              id_configuracion: configuracion_transferida.id_configuracion,
              propietario: 1,
            },
          });

          // (opcional pero recomendado) si no existe propietario, evita crashear:
          if (!cliente_configuracion) {
            throw new Error(
              `No existe cliente propietario para id_configuracion=${configuracion_transferida.id_configuracion}`
            );
          }

          await MensajesClientes.create({
            id_configuracion: configuracion_transferida.id_configuracion,
            id_cliente: cliente_configuracion.id,
            mid_mensaje: configuracion_transferida.id_telefono,
            tipo_mensaje: 'notificacion',
            visto: 0,
            texto_mensaje:
              emisor + ' te transfirió este chat. Motivo: ' + motivo,
            rol_mensaje: 3,
            celular_recibe: validar_cliente_new_conf.id,
            uid_whatsapp: validar_cliente_new_conf.celular_cliente,
          });

          enviarConsultaAPI(
            configuracion_transferida.id_configuracion,
            validar_cliente_new_conf.id
          );
        }
      } else {
        /* validar si existe un cliente ya en esa otra configuracion */
        const validar_cliente_new_conf = await Clientes_chat_center.findOne({
          where: {
            id_configuracion: configuracion_transferida.id_configuracion,
            celular_cliente: clienteActual.celular_cliente,
          },
        });

        // Buscar el cliente propietario de esa configuración (igual que arriba)
        const cliente_configuracion = await Clientes_chat_center.findOne({
          where: {
            id_configuracion: configuracion_transferida.id_configuracion,
            propietario: 1,
          },
        });

        // (opcional pero recomendado) si no existe propietario, evita crashear:
        if (!cliente_configuracion) {
          throw new Error(
            `No existe cliente propietario para id_configuracion=${configuracion_transferida.id_configuracion}`
          );
        }

        if (validar_cliente_new_conf) {
          await Clientes_chat_center.update(
            { id_encargado: id_encargado },
            {
              where: { id: validar_cliente_new_conf.id },
            }
          );

          await MensajesClientes.create({
            id_configuracion: configuracion_transferida.id_configuracion,
            id_cliente: cliente_configuracion.id,
            mid_mensaje: configuracion_transferida.id_telefono,
            tipo_mensaje: 'notificacion',
            visto: 0,
            texto_mensaje:
              emisor + ' te transfirió este chat. Motivo: ' + motivo,
            rol_mensaje: 3,
            celular_recibe: validar_cliente_new_conf.id,
            uid_whatsapp: validar_cliente_new_conf.celular_cliente,
          });

          enviarConsultaAPI(
            configuracion_transferida.id_configuracion,
            validar_cliente_new_conf.id
          );
        } else {
          // 1) Crear el cliente porque no existe en la nueva configuración
          const nuevo_cliente = await Clientes_chat_center.create({
            id_configuracion: configuracion_transferida.id_configuracion,
            nombre_cliente: clienteActual.nombre_cliente,
            apellido_cliente: clienteActual.apellido_cliente,
            celular_cliente: clienteActual.celular_cliente,
            id_encargado: id_encargado,
            propietario: 0,
            uid_cliente: cliente_configuracion.uid_cliente,
          });

          // 2) Crear el mensaje usando el nuevo cliente
          await MensajesClientes.create({
            id_configuracion: configuracion_transferida.id_configuracion,
            id_cliente: cliente_configuracion.id,
            mid_mensaje: cliente_configuracion.uid_cliente,
            tipo_mensaje: 'notificacion',
            visto: 0,
            texto_mensaje:
              emisor + ' te transfirió este chat. Motivo: ' + motivo,
            rol_mensaje: 3,
            celular_recibe: nuevo_cliente.id, // igual que tu patrón (usas el id)
            uid_whatsapp: nuevo_cliente.celular_cliente, // el celular del nuevo cliente
          });

          enviarConsultaAPI(
            configuracion_transferida.id_configuracion,
            nuevo_cliente.id
          );
        }
      }
      break;
    }
  }

  return res
    .status(200)
    .json({ status: 'success', message: 'Chat transferido correctamente' });
});

exports.asignar_encargado = catchAsync(async (req, res, next) => {
  const {
    source,
    id_encargado,
    id_cliente_chat_center,
    id_conversation,
    id_configuracion = null,
  } = req.body;

  if (!id_encargado) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_encargado es requerido',
    });
  }

  switch (source) {
    case 'ms': {
      if (!id_conversation) {
        return res.status(400).json({
          status: 'fail',
          message: 'id_conversation es requerido para Messenger',
        });
      }
      await MessengerConversation.update(
        { id_encargado },
        { where: { id: id_conversation } }
      );
      break;
    }
    case 'ig': {
      if (!id_conversation) {
        return res.status(400).json({
          status: 'fail',
          message: 'id_conversation es requerido para Instagram',
        });
      }
      await InstagramConversation.update(
        { id_encargado },
        { where: { id: id_conversation } }
      );
      break;
    }
    // WhatsApp por defecto (o 'wa')
    default: {
      if (!id_cliente_chat_center || !id_configuracion) {
        return res.status(400).json({
          status: 'fail',
          message:
            'id_cliente_chat_center o id_configuracion es requerido para WhatsApp',
        });
      }

      const Departamento = await DepartamentosChatCenter.findOne({
        where: { id_configuracion },
      });

      const id_departamento = Departamento?.id_departamento ?? null;

      await Historial_encargados.create({
        id_cliente_chat_center,
        id_encargado_nuevo: id_encargado,
        motivo: 'Auto-asignacion de chat',
        id_departamento_asginado: id_departamento,
      });

      await Clientes_chat_center.update(
        { id_encargado },
        { where: { id: id_cliente_chat_center } }
      );
      break;
    }
  }

  return res
    .status(200)
    .json({ status: 'success', message: 'Chat asignado correctamente' });
});
