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
    const { id_plataforma } = req.body;

    /* validar si existe una configuracion con ese id_plataforma */
    const configuraciones = await Configuraciones.findOne({
      where: { id_plataforma },
    });
    if (!configuraciones) {
      return res.status(400).json({
        status: 'fail',
        message: 'No existe ninguna configuracion con ese id_plataforma',
      });
    }

    let id_configuracion = configuraciones.id;
    let nombre_configuracion = configuraciones.nombre_configuracion;
    /* validar si existe una configuracion con ese id_plataforma */

    /* validar si existe usuario */
    const usuario_plataforma = await Usuario_plataforma.findOne({
      where: { id_plataforma },
    });
    if (!usuario_plataforma) {
      return res.status(400).json({
        status: 'fail',
        message: 'No existe ningun usuario_plataforma',
      });
    }

    const users = await Users.findOne({
      where: { id_users: usuario_plataforma.id_usuario },
    });
    if (!users) {
      return res.status(400).json({
        status: 'fail',
        message: 'No existe ningun usuario',
      });
    }

    /* validar si existe usuario */

    let usuario_users = users.usuario_users;
    let nombre_users = users.nombre_users;
    let con_users = users.con_users;

    let id_usuario_chat_center = '';

    const sub_usuarios_chat_center = await Sub_usuarios_chat_center.findOne({
      where: { email: usuario_users },
    });
    if (!sub_usuarios_chat_center) {
      const crear_usuario = await Usuarios_chat_center.create({
        nombre: nombre_configuracion,
        id_plan: 2,
        fecha_inicio:"2025-08-13",
        fecha_renovacion: "2025-09-13",
        estado: "activo",
      });

      const crear_sub_usuario = await Sub_usuarios_chat_center.create({
        id_usuario: crear_usuario.id_usuario,
        usuario: nombre_users.replace(/\s+/g, ''),
        password: con_users,
        email: usuario_users,
        nombre_encargado: nombre_users,
        rol: 'administrador',
      });

      id_usuario_chat_center = crear_sub_usuario.id_usuario;
    } else {
      id_usuario_chat_center = sub_usuarios_chat_center.id_usuario;
    }

    /* editar id_usuario a configuraciones */
    await configuraciones.update({
      id_usuario: id_usuario_chat_center,
    });
    /* editar id_usuario a configuraciones */

    /* editar id_configuraciones a clientes_chat_center */
    await Clientes_chat_center.update(
      {
        id_configuracion,
      },
      {
        where: {
          id_plataforma,
        },
      }
    );
    /* editar id_configuraciones a clientes_chat_center */

    /* editar id_configuraciones a mensajes_clientes */
    await Mensaje_cliente.update(
      {
        id_configuracion,
      },
      {
        where: {
          id_plataforma,
        },
      }
    );
    /* editar id_configuraciones a mensajes_clientes */

    /* editar id_configuraciones a etiquetas_asignadas */
    await Etiquetas_asignadas.update(
      {
        id_configuracion,
      },
      {
        where: {
          id_plataforma,
        },
      }
    );
    /* editar id_configuraciones a etiquetas_asignadas */

    /* editar id_configuraciones a etiquetas_chat_center  */
    await Etiquetas_chat_center.update(
      {
        id_configuracion,
      },
      {
        where: {
          id_plataforma,
        },
      }
    );
    /* editar id_configuraciones a etiquetas_chat_center  */

    /* editar id_configuraciones a templates_chat_center  */
    await Templates_chat_center.update(
      {
        id_configuracion,
      },
      {
        where: {
          id_plataforma,
        },
      }
    );
    /* editar id_configuraciones a templates_chat_center  */

    res.status(200).json({
      status: 'success',
      message: 'Importacion de chat completada',
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
    return res.status(400).json({ status: 'fail', message: 'id_usuario es requerido' });
  }

  const row = await Usuarios_chat_center.findOne({
    where: { id_usuario },
    attributes: ['tour_conexiones_dismissed'],
  });

  if (!row) {
    return res.status(404).json({ status: 'fail', message: 'Usuario no encontrado' });
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
    return res.status(400).json({ status: 'fail', message: 'id_usuario es requerido' });
  }

  const row = await Usuarios_chat_center.findOne({ where: { id_usuario } });
  if (!row) {
    return res.status(404).json({ status: 'fail', message: 'Usuario no encontrado' });
  }

  row.tour_conexiones_dismissed = Number(tour_conexiones_dismissed) === 1 ? 1 : 0;
  await row.save();

  return res.status(200).json({ status: 'success' });
});
