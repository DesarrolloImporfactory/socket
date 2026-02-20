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
        attributes: ['nombre_configuracion', 'id', 'permiso_round_robin'],
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
        attributes: ['id_sub_usuario', 'asignacion_auto'],
        raw: true,
      });

      const depJson = dep.toJSON();

      return {
        ...depJson,
        nombre_configuracion:
          depJson.configuracion?.nombre_configuracion ?? null,
        permiso_round_robin: Number(depJson.configuracion?.permiso_round_robin)
          ? 1
          : 0, // ✅ NUEVO
        usuarios_asignados: asignaciones.map((a) => ({
          id_sub_usuario: Number(a.id_sub_usuario),
          asignacion_auto: Number(a.asignacion_auto) ? 1 : 0,
        })),
      };
    }),
  );

  res.status(200).json({
    status: 'success',
    data: departamentosConUsuarios,
  });
});

exports.togglePermisoRoundRobin = catchAsync(async (req, res) => {
  const { id_configuracion, permiso_round_robin } = req.body;

  if (!id_configuracion) {
    return res.status(400).json({
      status: "error",
      message: "Faltan parámetros (id_configuracion).",
    });
  }

  const valor = Number(permiso_round_robin) ? 1 : 0;

  // Validar pertenencia (seguridad)
  const config = await Configuraciones.findOne({
    where: { id: id_configuracion },
  });

  if (!config) {
    return res.status(404).json({
      status: "error",
      message: "Configuración no encontrada para este usuario.",
    });
  }

  await Configuraciones.update(
    { permiso_round_robin: valor },
    { where: { id: id_configuracion } }
  );

  return res.status(200).json({
    status: "success",
    message: "Autoasignación actualizada.",
    data: { id_configuracion, permiso_round_robin: valor },
  });
});

exports.listar_por_usuario = catchAsync(async (req, res, next) => {
  const { id_sub_usuario } = req.body;

  const departamentos = await db.query(
    'SELECT dcc.id_departamento, dcc.nombre_departamento, dcc.color, dcc.id_configuracion FROM departamentos_chat_center dcc INNER JOIN sub_usuarios_departamento sud ON dcc.id_departamento = sud.id_departamento WHERE sud.id_sub_usuario = ?;',
    {
      replacements: [id_sub_usuario],
      type: db.QueryTypes.SELECT,
    },
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
    const filas = usuarios_asignados.map((u) => ({
      id_departamento,
      id_sub_usuario: Number(u.id_sub_usuario),
      asignacion_auto: Number(u.asignacion_auto) ? 1 : 0,
    }));

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
    usuarios_asignados = [], // [{ id_sub_usuario, asignacion_auto }]
  } = req.body;

  if (!id_departamento) {
    return res.status(400).json({
      status: 'fail',
      message: 'Falta id_departamento',
    });
  }

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

  // Normaliza incoming a Map<id_sub_usuario, asignacion_auto(0|1)>
  const incomingArr = Array.isArray(usuarios_asignados)
    ? usuarios_asignados
    : [];
  const incomingMap = new Map();

  for (const u of incomingArr) {
    const id = Number(u?.id_sub_usuario);
    if (!id) continue;

    const auto = Number(u?.asignacion_auto) ? 1 : 0;
    incomingMap.set(id, auto); // si viene repetido, el último gana
  }

  const incomingIds = [...incomingMap.keys()];

  const t = await DepartamentosChatCenter.sequelize.transaction();
  try {
    // 1) Actualizar datos del departamento
    await departamento.update(
      { nombre_departamento, color, mensaje_saludo, id_configuracion },
      { transaction: t },
    );

    // 2) Obtener asignaciones actuales (incluye asignacion_auto)
    const actuales = await Sub_usuarios_departamento.findAll({
      where: { id_departamento },
      attributes: ['id_sub_usuario', 'asignacion_auto'],
      raw: true,
      transaction: t,
    });

    const actualesMap = new Map(
      actuales.map((a) => [
        Number(a.id_sub_usuario),
        Number(a.asignacion_auto) ? 1 : 0,
      ]),
    );

    const actualesIdsSet = new Set([...actualesMap.keys()]);

    // 3) Diff
    const toAdd = incomingIds.filter((id) => !actualesIdsSet.has(id));
    const toRemove = [...actualesIdsSet].filter((id) => !incomingMap.has(id));
    const toMaybeUpdate = incomingIds.filter((id) => actualesIdsSet.has(id));

    // 4) Eliminar los no seleccionados
    if (toRemove.length > 0) {
      await Sub_usuarios_departamento.destroy({
        where: { id_departamento, id_sub_usuario: toRemove },
        transaction: t,
      });
    }

    // 5) Insertar nuevos (con asignacion_auto)
    if (toAdd.length > 0) {
      const filas = toAdd.map((id_sub_usuario) => ({
        id_departamento,
        id_sub_usuario,
        asignacion_auto: incomingMap.get(id_sub_usuario) ?? 0,
      }));

      await Sub_usuarios_departamento.bulkCreate(filas, {
        ignoreDuplicates: true, // recomendado: índice único (id_departamento, id_sub_usuario)
        transaction: t,
      });
    }

    // 6) Actualizar asignacion_auto si cambió (solo para los que ya existen)
    // Nota: esto hace updates individuales; si quieres optimizar, se puede hacer con bulk upsert.
    for (const id_sub_usuario of toMaybeUpdate) {
      const nuevoAuto = incomingMap.get(id_sub_usuario) ?? 0;
      const actualAuto = actualesMap.get(id_sub_usuario) ?? 0;

      if (nuevoAuto !== actualAuto) {
        await Sub_usuarios_departamento.update(
          { asignacion_auto: nuevoAuto },
          {
            where: { id_departamento, id_sub_usuario },
            transaction: t,
          },
        );
      }
    }

    await t.commit();

    // 7) Respuesta con el formato nuevo
    const usuariosAsignadosResp = incomingIds.map((id) => ({
      id_sub_usuario: id,
      asignacion_auto: incomingMap.get(id) ?? 0,
    }));

    return res.status(200).json({
      status: 'success',
      data: {
        ...departamento.toJSON(),
        usuarios_asignados: usuariosAsignadosResp,
      },
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
        include: [
          {
            model: Configuraciones,
            as: 'configuracion',
            required: true, // required:true => INNER JOIN
            attributes: ['id_telefono'], // trae solo lo que necesitas
          },
        ],
      });

      await Clientes_chat_center.update(
        { id_encargado: id_encargado },
        {
          where: { id: clienteActual.id },
        },
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
          `No existe cliente propietario para id_configuracion=${configuracion_transferida.id_configuracion}`,
        );
      }

      await MensajesClientes.create({
        id_configuracion: configuracion_transferida.id_configuracion,
        id_cliente: cliente_configuracion.id,
        mid_mensaje: configuracion_transferida.configuracion.id_telefono,
        tipo_mensaje: 'notificacion',
        visto: 0,
        texto_mensaje: emisor + ' te transfirió este chat. Motivo: ' + motivo,
        rol_mensaje: 3,
        celular_recibe: clienteActual.id,
        uid_whatsapp: clienteActual.celular_cliente,
      });

      enviarConsultaAPI(
        configuracion_transferida.id_configuracion,
        clienteActual.id,
      );

      break;
    }
    case 'ig': {
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
        include: [
          {
            model: Configuraciones,
            as: 'configuracion',
            required: true, // required:true => INNER JOIN
            attributes: ['id_telefono'], // trae solo lo que necesitas
          },
        ],
      });

      await Clientes_chat_center.update(
        { id_encargado: id_encargado },
        {
          where: { id: clienteActual.id },
        },
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
          `No existe cliente propietario para id_configuracion=${configuracion_transferida.id_configuracion}`,
        );
      }

      await MensajesClientes.create({
        id_configuracion: configuracion_transferida.id_configuracion,
        id_cliente: cliente_configuracion.id,
        mid_mensaje: configuracion_transferida.configuracion.id_telefono,
        tipo_mensaje: 'notificacion',
        visto: 0,
        texto_mensaje: emisor + ' te transfirió este chat. Motivo: ' + motivo,
        rol_mensaje: 3,
        celular_recibe: clienteActual.id,
        uid_whatsapp: clienteActual.celular_cliente,
      });

      enviarConsultaAPI(
        configuracion_transferida.id_configuracion,
        clienteActual.id,
      );

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
        include: [
          {
            model: Configuraciones,
            as: 'configuracion',
            required: true, // required:true => INNER JOIN
            attributes: ['id_telefono'], // trae solo lo que necesitas
          },
        ],
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
            },
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
              `No existe cliente propietario para id_configuracion=${configuracion_transferida.id_configuracion}`,
            );
          }

          await MensajesClientes.create({
            id_configuracion: configuracion_transferida.id_configuracion,
            id_cliente: cliente_configuracion.id,
            mid_mensaje: configuracion_transferida.configuracion.id_telefono,
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
            validar_cliente_new_conf.id,
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
            `No existe cliente propietario para id_configuracion=${configuracion_transferida.id_configuracion}`,
          );
        }

        if (validar_cliente_new_conf) {
          await Clientes_chat_center.update(
            { id_encargado: id_encargado },
            {
              where: { id: validar_cliente_new_conf.id },
            },
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
            validar_cliente_new_conf.id,
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
            nuevo_cliente.id,
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
  const { id_encargado, id_cliente_chat_center, id_configuracion } = req.body;

  if (!id_encargado) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_encargado es requerido',
    });
  }

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
    { where: { id: id_cliente_chat_center } },
  );

  enviarConsultaAPI(id_configuracion, id_cliente_chat_center);

  return res
    .status(200)
    .json({ status: 'success', message: 'Chat asignado correctamente' });
});
