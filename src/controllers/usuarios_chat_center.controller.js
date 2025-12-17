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

const { obtenerOCrearStripeCustomer } = require('./../utils/stripe/crear_customer');
const { Op } = require('sequelize');
const { crearSubUsuario } = require('./../utils/crearSubUsuario');
const { actualizarSubUsuario } = require('./../utils/actualizarSubUsuario');
const catchAsync = require('../utils/catchAsync');

exports.listarUsuarios = catchAsync(async (req, res, next) => {
  const { id_usuario } = req.body;

  const sub_usuarios_chat_center = await Sub_usuarios_chat_center.findAll({
    where: { id_usuario },
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
  const { id_usuario, usuario, password, email, nombre_encargado, rol } =
    req.body;

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

  // Validar campos obligatorios
  if (!id_sub_usuario || !usuario || !email || !nombre_encargado || !rol) {
    return res.status(400).json({
      status: 'fail',
      message: 'Todos los campos son obligatorios',
    });
  }

  // Validar usuario o email en uso por otro subusuario
  const existeSubUsuario = await Sub_usuarios_chat_center.findOne({
    where: {
      [Op.or]: [{ usuario }, { email }],
      id_sub_usuario: {
        [Op.ne]: id_sub_usuario, // Excluir el mismo subusuario
      },
    },
  });

  if (existeSubUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El usuario o el email ya están en uso por otro subusuario',
    });
  }

  // Actualizar subusuario
  const nuevoSubUsuario = await actualizarSubUsuario({
    id_sub_usuario,
    usuario,
    password,
    email,
    nombre_encargado,
    rol,
  });

  res.status(201).json({
    status: 'success',
    message: 'Cuenta y usuario actualizados correctamente 🎉',
    user: nuevoSubUsuario,
  });
});

exports.eliminarSubUsuario = catchAsync(async (req, res, next) => {
  const { id_sub_usuario } = req.body;

  if (!id_sub_usuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El ID del subusuario es obligatorio',
    });
  }

  const subUsuario = await Sub_usuarios_chat_center.findByPk(id_sub_usuario);

  if (!subUsuario) {
    return res.status(404).json({
      status: 'fail',
      message: 'Subusuario no encontrado',
    });
  }

  await subUsuario.destroy();

  res.status(200).json({
    status: 'success',
    message: 'Subusuario eliminado correctamente',
  });
});

exports.importacion_chat_center = catchAsync(async (req, res, next) => {
  try {
    const { id_usuario } = req.body;

    /* obtener usuarios con email_propietario null */
    const usuarios = await Usuarios_chat_center.findAll({
      where: {
        email_propietario: { [Op.is]: null },
        id_usuario: id_usuario
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
          order: [['id', 'ASC']],
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
          mensaje: 'Error inesperado actualizando este usuario',
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
