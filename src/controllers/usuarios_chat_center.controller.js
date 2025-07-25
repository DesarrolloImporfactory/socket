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
const catchAsync = require('../utils/catchAsync');

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
