const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const Usuario_plataforma = require('../models/usuario_plataforma.model');
const Users = require('../models/user.model');
const Clientes_chat_center = require('../models/clientes_chat_center.model');
const Mensaje_cliente = require('../models/mensaje_cliente.model');
const Etiquetas_asignadas = require('../models/etiquetas_asignadas.model');
const Etiquetas_chat_center = require('../models/etiquetas_chat_center.model');
const Templates_chat_center = require('../models/templates_chat_center.model');

const bcrypt = require('bcrypt');
const {
  obtenerOCrearStripeCustomer,
} = require('./../utils/stripe/crear_customer');
const { Op } = require('sequelize');
const { crearSubUsuario } = require('./../utils/crearSubUsuario');
const { actualizarSubUsuario } = require('./../utils/actualizarSubUsuario');
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const { tieneColumnaAccion } = require('../utils/historialEncargados');

exports.listarUsuarios = catchAsync(async (req, res, next) => {
  // El id_usuario sale de la sesión, no del body (evita listar cuentas ajenas)
  const id_usuario = req.sessionUser.id_usuario;

  const sub_usuarios_chat_center = await Sub_usuarios_chat_center.findAll({
    where: { id_usuario, suspendido: 0 },
  });

  if (!sub_usuarios_chat_center || sub_usuarios_chat_center.length === 0) {
    return res.status(400).json({
      status: 'fail',
      message: 'No existen usuarios para este usuario.',
    });
  }

  // Limpiar datos sensibles
  const usuariosSanitizados = sub_usuarios_chat_center.map((usuario) => {
    const { password, admin_pass, ...safeData } = usuario.toJSON();
    return safeData;
  });

  res.status(200).json({
    status: 'success',
    data: usuariosSanitizados,
  });
});

exports.agregarUsuario = catchAsync(async (req, res, next) => {
  const { usuario, password, email, nombre_encargado, rol } = req.body;
  const id_usuario = req.sessionUser.id_usuario;

  // Validar campos obligatorios
  if (
    !id_usuario ||
    !usuario ||
    !password ||
    !email ||
    !nombre_encargado ||
    !rol
  ) {
    return res.status(400).json({
      status: 'fail',
      message: 'Todos los campos son obligatorios',
    });
  }

  // Validar usuario o email de subusuario
  const existeSubUsuario = await Sub_usuarios_chat_center.findOne({
    where: {
      [Op.or]: [{ usuario }, { email }],
    },
  });
  if (existeSubUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El usuario o el email ya están en uso',
    });
  }

  // Crear subusuario administrador
  const nuevoSubUsuario = await crearSubUsuario({
    id_usuario: id_usuario,
    usuario,
    password: password,
    email,
    nombre_encargado,
    rol: rol,
  });

  res.status(201).json({
    status: 'success',
    message: 'Cuenta y usuario administrador creados correctamente 🎉',
    user: nuevoSubUsuario,
  });
});

exports.actualizarUsuario = catchAsync(async (req, res, next) => {
  const { id_sub_usuario, usuario, password, email, nombre_encargado, rol } =
    req.body;

  // Validar campos obligatorios (password NO es obligatorio)
  if (!id_sub_usuario || !usuario || !email || !nombre_encargado || !rol) {
    return res.status(400).json({
      status: 'fail',
      message: 'Todos los campos son obligatorios',
    });
  }

  // El subusuario debe existir y pertenecer a la cuenta del admin logueado
  const target = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);
  if (!target) {
    return res.status(404).json({
      status: 'fail',
      message: 'Subusuario no encontrado',
    });
  }
  if (Number(target.id_usuario) !== Number(req.sessionUser.id_usuario)) {
    return res.status(403).json({
      status: 'fail',
      message: 'Este usuario no pertenece a tu cuenta',
    });
  }

  const esSelf =
    Number(id_sub_usuario) === Number(req.sessionUser.id_sub_usuario);
  const cambiaRol = String(rol) !== String(target.rol);

  // Un admin no puede bajarse su propio rol (se quedaría fuera de /usuarios)
  if (esSelf && cambiaRol) {
    return res.status(400).json({
      status: 'fail',
      code: 'SELF_ROLE_CHANGE',
      message:
        'No puedes cambiar tu propio rol. Pídele a otro administrador que lo haga.',
    });
  }

  // No dejar la cuenta sin administradores al degradar a otro admin
  if (cambiaRol && target.rol === 'administrador') {
    const otrosAdmins = await Sub_usuarios_chat_center.count({
      where: {
        id_usuario: target.id_usuario,
        rol: 'administrador',
        suspendido: 0,
        id_sub_usuario: { [Op.ne]: id_sub_usuario },
      },
    });
    if (otrosAdmins === 0) {
      return res.status(400).json({
        status: 'fail',
        code: 'LAST_ADMIN',
        message:
          'No puedes quitar el rol al último administrador de la cuenta.',
      });
    }
  }

  // Validar usuario o email en uso por otro subusuario
  const existeSubUsuario = await Sub_usuarios_chat_center.findOne({
    where: {
      [Op.or]: [{ usuario }, { email }],
      id_sub_usuario: { [Op.ne]: id_sub_usuario },
    },
  });

  if (existeSubUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El usuario o el email ya están en uso por otro subusuario',
    });
  }

  // ✅ Armar payload de actualización
  const dataToUpdate = {
    id_sub_usuario,
    usuario,
    email,
    nombre_encargado,
    rol,
  };

  // ✅ Solo incluir password si viene con contenido
  // Cambiar una contraseña exige confirmar la contraseña actual del admin
  // logueado (evita que alguien con la sesión abierta cambie claves).
  if (typeof password === 'string' && password.trim().length > 0) {
    const { password_actual } = req.body;
    if (
      typeof password_actual !== 'string' ||
      password_actual.trim().length === 0
    ) {
      return res.status(400).json({
        status: 'fail',
        code: 'CURRENT_PASSWORD_REQUIRED',
        message:
          'Para cambiar la contraseña debes confirmar tu contraseña actual.',
      });
    }
    const coincide = await bcrypt.compare(
      password_actual,
      req.sessionUser.password || '',
    );
    if (!coincide) {
      return res.status(401).json({
        status: 'fail',
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'Tu contraseña actual no es correcta.',
      });
    }
    dataToUpdate.password = password.trim();
  }

  const nuevoSubUsuario = await actualizarSubUsuario(dataToUpdate);

  return res.status(200).json({
    status: 'success',
    message: 'Cuenta y usuario actualizados correctamente 🎉',
    user: nuevoSubUsuario,
  });
});

/* Chats (WhatsApp y los unificados de clientes_chat_center) que tiene
   asignados un subusuario. Lo usa el modal de eliminar para avisar antes de
   borrar: si no se reasignan, quedan apuntando a un usuario que ya no existe
   y nadie los ve en «En espera». */
async function contarChatsAsignados(id_sub_usuario) {
  const [row] = await db.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(chat_cerrado = 0), 0) AS abiertos
       FROM clientes_chat_center
      WHERE id_encargado = ?
        AND deleted_at IS NULL`,
    { replacements: [id_sub_usuario], type: db.QueryTypes.SELECT },
  );
  return {
    total: Number(row?.total || 0),
    abiertos: Number(row?.abiertos || 0),
  };
}

// GET /chatsAsignados/:id_sub_usuario
exports.chatsAsignados = catchAsync(async (req, res, next) => {
  const id_sub_usuario = Number(req.params.id_sub_usuario);
  const subUsuario = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);

  if (
    !subUsuario ||
    Number(subUsuario.id_usuario) !== Number(req.sessionUser.id_usuario)
  ) {
    return res.status(404).json({
      status: 'fail',
      message: 'Subusuario no encontrado',
    });
  }

  const conteo = await contarChatsAsignados(id_sub_usuario);
  res.status(200).json({ status: 'success', data: conteo });
});

exports.eliminarSubUsuario = catchAsync(async (req, res, next) => {
  const { id_sub_usuario } = req.body;
  // A quién pasan sus chats: un id de subusuario, o null/'' = «En espera».
  const reasignarA =
    req.body.reasignar_a === undefined ||
    req.body.reasignar_a === null ||
    req.body.reasignar_a === ''
      ? null
      : Number(req.body.reasignar_a);

  if (!id_sub_usuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El ID del subusuario es obligatorio',
    });
  }

  // Un admin no puede eliminarse a sí mismo (quedaría fuera del sistema)
  if (Number(id_sub_usuario) === Number(req.sessionUser.id_sub_usuario)) {
    return res.status(400).json({
      status: 'fail',
      code: 'SELF_DELETE',
      message:
        'No puedes eliminar tu propio usuario. Pídele a otro administrador que lo haga.',
    });
  }

  const subUsuario = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);

  if (!subUsuario) {
    return res.status(404).json({
      status: 'fail',
      message: 'Subusuario no encontrado',
    });
  }

  // Solo se pueden eliminar subusuarios de la propia cuenta
  if (Number(subUsuario.id_usuario) !== Number(req.sessionUser.id_usuario)) {
    return res.status(403).json({
      status: 'fail',
      message: 'Este usuario no pertenece a tu cuenta',
    });
  }

  // No dejar la cuenta sin administradores
  if (subUsuario.rol === 'administrador') {
    const otrosAdmins = await Sub_usuarios_chat_center.count({
      where: {
        id_usuario: subUsuario.id_usuario,
        rol: 'administrador',
        suspendido: 0,
        id_sub_usuario: { [Op.ne]: id_sub_usuario },
      },
    });
    if (otrosAdmins === 0) {
      return res.status(400).json({
        status: 'fail',
        code: 'LAST_ADMIN',
        message:
          'No puedes eliminar al último administrador de la cuenta.',
      });
    }
  }

  // El destino tiene que ser otro subusuario activo de la misma cuenta
  if (reasignarA !== null) {
    const destino = await Sub_usuarios_chat_center.findByPk(reasignarA);
    if (
      !destino ||
      Number(destino.id_usuario) !== Number(subUsuario.id_usuario) ||
      Number(destino.suspendido) === 1 ||
      Number(reasignarA) === Number(id_sub_usuario)
    ) {
      return res.status(400).json({
        status: 'fail',
        message: 'El usuario elegido para recibir los chats no es válido',
      });
    }
  }

  const motivo =
    reasignarA === null
      ? `Usuario eliminado (${subUsuario.nombre_encargado || subUsuario.usuario}): devuelto a En espera`
      : `Usuario eliminado (${subUsuario.nombre_encargado || subUsuario.usuario}): chat reasignado`;
  const conAccion = await tieneColumnaAccion();

  // Todo o nada: si falla algo, el usuario no se borra y los chats siguen con él
  const reasignados = await db.transaction(async (transaction) => {
    // El historial va ANTES del UPDATE: después ya no se sabe qué chats eran suyos
    await db.query(
      `INSERT INTO historial_encargados
         (id_cliente_chat_center, id_departamento_asginado,
          id_encargado_anterior, id_encargado_nuevo, motivo${
            conAccion ? ', id_sub_usuario_accion' : ''
          })
       SELECT c.id, c.id_departamento, c.id_encargado, ?, ?${
         conAccion ? ', ?' : ''
       }
         FROM clientes_chat_center c
        WHERE c.id_encargado = ?
          AND c.deleted_at IS NULL`,
      {
        replacements: [
          reasignarA,
          motivo,
          ...(conAccion ? [req.sessionUser.id_sub_usuario] : []),
          id_sub_usuario,
        ],
        type: db.QueryTypes.INSERT,
        transaction,
      },
    );

    const [, filas] = await db.query(
      `UPDATE clientes_chat_center
          SET id_encargado = ?
        WHERE id_encargado = ?
          AND deleted_at IS NULL`,
      {
        replacements: [reasignarA, id_sub_usuario],
        type: db.QueryTypes.UPDATE,
        transaction,
      },
    );

    // Tablas propias de Messenger/Instagram, que guardan su propio encargado
    for (const tabla of ['messenger_conversations', 'instagram_conversations']) {
      await db.query(
        `UPDATE ${tabla} SET id_encargado = ? WHERE id_encargado = ?`,
        {
          replacements: [reasignarA, id_sub_usuario],
          type: db.QueryTypes.UPDATE,
          transaction,
        },
      );
    }

    await subUsuario.destroy({ transaction });
    return filas;
  });

  res.status(200).json({
    status: 'success',
    message: 'Subusuario eliminado correctamente',
    chats_reasignados: reasignados,
    reasignados_a: reasignarA,
  });
});

exports.importacion_chat_center = catchAsync(async (req, res, next) => {
  try {
    const { id_usuario } = req.body;

    /* obtener usuarios con email_propietario null */
    const usuarios = await Usuarios_chat_center.findAll({
      where: {
        email_propietario: { [Op.is]: null },
      },
    });

    if (usuarios.length === 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'No existe ningún usuario con email_propietario null',
      });
    }

    const resultados = [];

    for (const usuario of usuarios) {
      try {
        const sub_usuario = await Sub_usuarios_chat_center.findOne({
          where: { id_usuario: usuario.id_usuario, rol: 'administrador' },
          order: [['id_sub_usuario', 'ASC']],
        });

        if (!sub_usuario) {
          resultados.push({
            id_usuario: usuario.id_usuario,
            status: 'fail',
            mensaje: 'No existe subusuario administrador',
          });
          continue;
        }

        const stripe_customer_id = await obtenerOCrearStripeCustomer({
          nombre: usuario.nombre,
          email: sub_usuario.email,
          id_usuario: usuario.id_usuario,
        });

        if (
          !stripe_customer_id ||
          typeof stripe_customer_id !== 'string' ||
          !stripe_customer_id.startsWith('cus_')
        ) {
          resultados.push({
            id_usuario: usuario.id_usuario,
            status: 'fail',
            mensaje: 'No se pudo crear el cliente en Stripe',
          });
          continue;
        }

        await usuario.update({
          email_propietario: sub_usuario.email,
          id_costumer: stripe_customer_id,
        });

        resultados.push({
          id_usuario: usuario.id_usuario,
          status: 'success',
        });
      } catch (errorUser) {
        console.error('❌ Error con usuario específico:', errorUser);
        resultados.push({
          id_usuario: usuario.id_usuario,
          status: 'error',
          mensaje: 'Error inesperado actualizando este usuario: ' + errorUser,
        });
      }
    }

    return res.status(200).json({
      status: 'success',
      message: 'Proceso finalizado',
      resultados,
    });
  } catch (err) {
    console.error('❌ Error en importacion_chat_center:', err);
    return res.status(500).json({
      status: 'fail',
      message: 'Ocurrió un error inesperado durante la importación.',
    });
  }
});

/* === Obtener preferencia de tour (por body) === */
exports.getTourConexionesPrefByBody = catchAsync(async (req, res) => {
  const { id_usuario } = req.body || {};
  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'id_usuario es requerido' });
  }

  const row = await Usuarios_chat_center.findOne({
    where: { id_usuario },
    attributes: ['tour_conexiones_dismissed'],
  });

  if (!row) {
    return res
      .status(404)
      .json({ status: 'fail', message: 'Usuario no encontrado' });
  }

  return res.status(200).json({
    status: 'success',
    tour_conexiones_dismissed: Number(row.tour_conexiones_dismissed) || 0,
  });
});

/* === Actualizar preferencia de tour (por body) === */
exports.updateTourConexionesPrefByBody = catchAsync(async (req, res) => {
  const { id_usuario, tour_conexiones_dismissed } = req.body || {};
  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'id_usuario es requerido' });
  }

  const row = await Usuarios_chat_center.findOne({ where: { id_usuario } });
  if (!row) {
    return res
      .status(404)
      .json({ status: 'fail', message: 'Usuario no encontrado' });
  }

  row.tour_conexiones_dismissed =
    Number(tour_conexiones_dismissed) === 1 ? 1 : 0;
  await row.save();

  return res.status(200).json({ status: 'success' });
});

// ──────────────────────────────────────────────────────────────
// POST /actualizarWhatsappLead
// Permite a usuarios sin whatsapp_lead/whatsapp_lead_pais
// completar esa info al ingresar al selector de herramientas.
// ──────────────────────────────────────────────────────────────
exports.actualizarWhatsappLead = catchAsync(async (req, res) => {
  const { id_usuario, whatsapp_lead, whatsapp_lead_pais } = req.body;

  if (!id_usuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_usuario es requerido',
    });
  }

  // Limpiar y validar el número
  const digits = String(whatsapp_lead || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 20) {
    return res.status(400).json({
      status: 'fail',
      message: 'Número de WhatsApp inválido (7 a 20 dígitos).',
    });
  }

  // Validar formato del código de país (+XX o +XXX o +XXXX)
  const pais = String(whatsapp_lead_pais || '').trim();
  if (!/^\+\d{1,4}$/.test(pais)) {
    return res.status(400).json({
      status: 'fail',
      message: 'Código de país inválido (ej: +593, +52, +1).',
    });
  }

  // Whitelist — los países que soportas en el Register
  const PAISES_PERMITIDOS = [
    '+593',
    '+57',
    '+51',
    '+52',
    '+56',
    '+54',
    '+55',
    '+58',
    '+591',
    '+595',
    '+598',
    '+507',
    '+506',
    '+34',
    '+1',
  ];
  if (!PAISES_PERMITIDOS.includes(pais)) {
    return res.status(400).json({
      status: 'fail',
      message: 'País no soportado.',
    });
  }

  // Verificar que el usuario existe
  const usuario = await Usuarios_chat_center.findByPk(id_usuario);
  if (!usuario) {
    return res.status(404).json({
      status: 'fail',
      message: 'Usuario no encontrado.',
    });
  }

  // Update vía modelo Sequelize
  await usuario.update({
    whatsapp_lead: digits,
    whatsapp_lead_pais: pais,
  });

  return res.status(200).json({
    status: 'success',
    message: 'WhatsApp actualizado correctamente.',
    data: {
      whatsapp_lead: digits,
      whatsapp_lead_pais: pais,
    },
  });
});

// ──────────────────────────────────────────────────────────────
// Información principal del dueño de la cuenta (vista Mi Perfil):
// datos básicos + el WhatsApp personal donde recibe TODOS los
// avisos del sistema (reglas de Meta Ads y los que vengan).
// ──────────────────────────────────────────────────────────────
exports.infoPropietario = catchAsync(async (req, res) => {
  const { id_usuario } = req.body;
  if (!id_usuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_usuario es requerido',
    });
  }
  const u = await Usuarios_chat_center.findByPk(id_usuario, {
    attributes: [
      'id_usuario',
      'nombre',
      'email_propietario',
      'estado',
      'tipo_plan',
      'fecha_renovacion',
      'whatsapp_lead',
      'whatsapp_lead_pais',
      'created_at',
    ],
  });
  if (!u) {
    return res.status(404).json({
      status: 'fail',
      message: 'Usuario no encontrado.',
    });
  }
  return res.status(200).json({ status: 'success', data: u });
});

// ──────────────────────────────────────────────────────────────
// Avisos que el sistema le ha enviado al dueño (bitácora de la
// tarjeta "Avisos" en Mi Perfil).
// ──────────────────────────────────────────────────────────────
exports.avisosEnviados = catchAsync(async (req, res) => {
  const { id_usuario } = req.body;
  if (!id_usuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'id_usuario es requerido',
    });
  }
  const { db } = require('../database/config');
  const rows = await db.query(
    `SELECT id, id_configuracion, evento, resumen, created_at
       FROM avisos_enviados
      WHERE id_usuario = ?
      ORDER BY id DESC
      LIMIT 30`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  return res.status(200).json({ status: 'success', data: rows });
});
