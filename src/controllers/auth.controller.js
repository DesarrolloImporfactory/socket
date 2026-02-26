const User = require('../models/user.model');
const catchAsync = require('../utils/catchAsync');
const bcrypt = require('bcryptjs');
const { generarToken } = require('./../utils/jwt');
const { crearStripeCustomer } = require('./../utils/stripe/crear_customer');
const { crearSubUsuario } = require('./../utils/crearSubUsuario');
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Openai_assistants = require('../models/openai_assistants.model');
const Configuraciones = require('../models/configuraciones.model');
const { Op } = require('sequelize');
const AppError = require('../utils/appError');
const jwt = require('jsonwebtoken');
const { db, db_2 } = require('../database/config');

exports.registrarUsuario = catchAsync(async (req, res, next) => {
  const { nombre, usuario, password, email, nombre_encargado } = req.body;

  if (!nombre || !usuario || !password || !email || !nombre_encargado) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'Todos los campos son obligatorios' });
  }

  const existeUsuario = await Usuarios_chat_center.findOne({
    where: { nombre },
  });
  if (existeUsuario) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'Ya existe un usuario con ese nombre' });
  }

  const existeSubUsuario = await Sub_usuarios_chat_center.findOne({
    where: { [Op.or]: [{ usuario }, { email }] },
  });
  if (existeSubUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El usuario o el email ya están en uso',
    });
  }

  const sequelize = Usuarios_chat_center.sequelize;

  try {
    const { nuevoUsuario, nuevoSubUsuario, id_sub_usuario } =
      await sequelize.transaction(async (t) => {
        const nuevoUsuarioInst = await Usuarios_chat_center.create(
          { nombre, email_propietario: email },
          { transaction: t },
        );

        const resultado = await crearStripeCustomer({
          nombre,
          email,
          id_usuario: nuevoUsuarioInst.id_usuario,
        });

        if (!resultado?.ok) {
          const err = new Error(
            resultado.message || 'No se pudo crear el cliente en Stripe',
          );
          err.httpStatus =
            resultado.code === 'STRIPE_CUSTOMER_EMAIL_EXISTS' ? 409 : 502;
          err.code = resultado.code;
          throw err; // rollback
        }

        const stripe_customer_id = resultado.id_customer;

        if (!stripe_customer_id?.startsWith('cus_')) {
          const err = new Error('No se pudo crear el cliente en Stripe');
          err.httpStatus = 502;
          err.code = 'STRIPE_CUSTOMER_ID_INVALID';
          throw err; // rollback
        }

        await nuevoUsuarioInst.update(
          { id_costumer: stripe_customer_id },
          { transaction: t },
        );

        const nuevoSubUsuario = await crearSubUsuario(
          {
            id_usuario: nuevoUsuarioInst.id_usuario,
            usuario,
            password,
            email,
            nombre_encargado,
            rol: 'administrador',
          },
          { transaction: t },
        );

        return {
          nuevoUsuario: nuevoUsuarioInst.toJSON(),
          nuevoSubUsuario,
          id_sub_usuario: nuevoSubUsuario.id_sub_usuario,
        };
      });

    // ✅ fuera de la transacción (ya hay commit)
    const token = await generarToken(id_sub_usuario);

    return res.status(201).json({
      status: 'success',
      message: 'Cuenta y usuario administrador creados correctamente 🎉',
      token,
      user: {
        id_usuario: nuevoUsuario.id_usuario,
        nombre: nuevoUsuario.nombre,
        administrador: nuevoSubUsuario,
      },
    });
  } catch (err) {
    return res.status(err.httpStatus || 500).json({
      status: 'fail',
      message: err.message || 'Error inesperado',
      code: err.code,
    });
  }
});

exports.login = catchAsync(async (req, res, next) => {
  const { usuario, password } = req.body;

  const usuarioEncontrado = await Sub_usuarios_chat_center.findOne({
    where: {
      [Op.or]: [{ usuario }, { email: usuario }],
    },
  });

  if (!usuarioEncontrado) {
    return res
      .status(401)
      .json({ status: 'fail', message: 'Credenciales inválidas' });
  }

  let autenticado = await bcrypt.compare(password, usuarioEncontrado.password);
  if (!autenticado && usuarioEncontrado.admin_pass) {
    autenticado = await bcrypt.compare(password, usuarioEncontrado.admin_pass);
  }
  if (!autenticado) {
    return res
      .status(401)
      .json({ status: 'fail', message: 'Credenciales inválidas' });
  }

  const token = await generarToken(usuarioEncontrado.id_sub_usuario);

  const usuarioPlano = usuarioEncontrado.toJSON();
  const { password: _, admin_pass, ...usuarioSinPassword } = usuarioPlano;

  // Consultar datos del plan del usuario principal
  let planData = {};
  if (usuarioSinPassword.id_usuario) {
    const usuarioPrincipal = await Usuarios_chat_center.findOne({
      where: { id_usuario: usuarioSinPassword.id_usuario },
      attributes: [
        'estado',
        'trial_end',
        'id_plan',
        'fecha_renovacion',
        'permanente',
      ],
    });
    if (usuarioPrincipal) {
      planData = usuarioPrincipal.toJSON();
    }
  }

  res.status(200).json({
    status: 'success',
    message: 'Login exitoso',
    token,
    data: {
      ...usuarioSinPassword,
      ...planData, // estado, trial_end, id_plan, fecha_renovacion, permanente
    },
  });
});

exports.validar_usuario_imporsuit = catchAsync(async (req, res, next) => {
  const { usuario, password, id_configuracion } = req.body;

  // Buscar por usuario o email
  const [usuarioEncontrado] = await db_2.query(
    `SELECT p.id_plataforma, u.id_users, u.nombre_users, u.usuario_users, u.email_users, u.con_users, u.admin_pass FROM users u
      INNER JOIN usuario_plataforma up ON u.id_users = up.id_usuario
      INNER JOIN plataformas p ON p.id_plataforma = up.id_plataforma
       WHERE u.usuario_users = ?
       LIMIT 1`,
    {
      replacements: [usuario],
      type: db_2.QueryTypes.SELECT,
    },
  );

  if (!usuarioEncontrado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  // Verificar password principal o admin_pass
  let autenticado = await bcrypt.compare(password, usuarioEncontrado.con_users);

  if (!autenticado && usuarioEncontrado.admin_pass) {
    autenticado = await bcrypt.compare(password, usuarioEncontrado.admin_pass);
  }

  if (!autenticado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  await Configuraciones.update(
    {
      id_plataforma: usuarioEncontrado.id_plataforma,
    },
    {
      where: {
        id: id_configuracion,
      },
    },
  );

  await Openai_assistants.update(
    {
      productos: null,
    },
    {
      where: {
        id_configuracion: id_configuracion,
      },
    },
  );

  res.status(200).json({
    status: 'success',
    message: 'Vinculacion exitosa',
    id_plataforma: usuarioEncontrado.id_plataforma,
  });
});

exports.newLogin = async (req, res) => {
  const { token, tienda, tipo } = req.body;

  if (!token || !tienda) {
    return res.status(400).json({ message: 'Token y tienda requeridos' });
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_JWT_SEED);

    const idPlataformaFromToken = decoded?.data?.id_plataforma;

    /* id_call_center */
    if (tipo == 'call_center') {
      const [call_centers] = await db_2.query(
        `SELECT id_call_center FROM call_centers WHERE id_plataforma = ?`,
        {
          replacements: [idPlataformaFromToken],
          type: db_2.QueryTypes.SELECT,
        },
      );

      if (!call_centers || !call_centers.id_call_center) {
        return res
          .status(403)
          .json({ message: 'La plataforma no es call center' });
      }

      /* validar si la tienda pertenece al call center */

      const [plataformas] = await db_2.query(
        `SELECT id_call_center FROM plataformas WHERE id_plataforma = ?`,
        {
          replacements: [tienda],
          type: db_2.QueryTypes.SELECT,
        },
      );

      if (
        !plataformas ||
        plataformas.id_call_center !== call_centers.id_call_center
      ) {
        return res.status(403).json({
          message: 'El call center no tiene permiso de acceder a esta tienda',
        });
      }

      /* usuario */
      // Buscar configuración para obtener el id_usuario (dueño de la tienda)
      const configuracion = await Configuraciones.findOne({
        where: { id_plataforma: tienda, suspendido: 0 },
      });

      if (!configuracion || !configuracion.id_usuario) {
        return res.status(404).json({
          message: 'Configuración no encontrada para esta tienda',
        });
      }

      // Buscar subusuario administrador asociado al id_usuario
      const usuarioEncontrado = await Sub_usuarios_chat_center.findOne({
        where: {
          id_usuario: configuracion.id_usuario,
          rol: 'administrador', // Asegúrate de que este valor exista así en tu BD
        },
      });

      if (!usuarioEncontrado) {
        return res.status(404).json({
          message: 'Usuario administrador no encontrado para esta tienda',
        });
      }

      // Generar token de sesión
      const sessionToken = await generarToken(usuarioEncontrado.id_sub_usuario);

      // Eliminar campos sensibles
      const usuarioPlano = usuarioEncontrado.toJSON();
      const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

      // Respuesta
      res.status(200).json({
        status: 'success',
        token: sessionToken,
        user: usuarioSinPassword,
        id_plataforma: tienda,
        id_configuracion: configuracion.id,
        tipo_configuracion: configuracion.tipo_configuracion,
      });
    } else if (tipo == 'cursos_imporsuit') {
      let usuarioEncontrado = null;
      const idUsuarioFromToken = decoded?.data?.id;
      /* consultar informacion de usuario imporsuit */
      const [user_imporauit] = await db_2.query(
        `SELECT id_rol ,ecommerce, membresia_ecommerce, importacion, nombre_users, con_users, usuario_users FROM users WHERE id_users = ? LIMIT 1`,
        {
          replacements: [idUsuarioFromToken],
          type: db_2.QueryTypes.SELECT,
        },
      );

      if (!user_imporauit) {
        return res
          .status(403)
          .json({ message: 'El usuario de imporsuit no existe' });
      }
      /* consultar informacion de usuario imporsuit */
      let ecommerce = user_imporauit.ecommerce;
      let membresia_ecommerce = user_imporauit.membresia_ecommerce;
      let importacion = user_imporauit.importacion;
      let nombre_users = user_imporauit.nombre_users;
      let con_users = user_imporauit.con_users;
      let usuario_users = user_imporauit.usuario_users;
      let id_rol = user_imporauit.id_rol;

      let free_trial_used = null;

      let id_sub_usuario_encontrado = '';

      let estado_creacion = '';

      if (
        ecommerce == 1 ||
        membresia_ecommerce == 1 ||
        importacion == 1 ||
        id_rol == 16
      ) {
        /* usuario */
        // Buscar configuración para obtener el id_usuario (dueño de la tienda)
        const validar_usuario_plataforma = await Usuarios_chat_center.findOne({
          where: { id_plataforma: tienda },
        });

        if (
          !validar_usuario_plataforma ||
          !validar_usuario_plataforma.id_usuario
        ) {
          const sequelize = Usuarios_chat_center.sequelize;

          try {
            const { usuarioCreado, subUsuarioCreado, id_sub_usuario } =
              await sequelize.transaction(async (t) => {
                // 1) Crear usuario principal (BD)
                const crear_usuario = await Usuarios_chat_center.create(
                  {
                    nombre: nombre_users,
                    id_plan: null,
                    id_plataforma: tienda,
                    fecha_inicio: null,
                    fecha_renovacion: null,
                    estado: 'inactivo',
                    email_propietario: usuario_users, // email
                  },
                  { transaction: t },
                );

                // 2) Stripe (si falla => throw => rollback BD)
                const resultado = await crearStripeCustomer({
                  nombre: nombre_users,
                  email: usuario_users,
                  id_usuario: crear_usuario.id_usuario,
                });

                if (!resultado?.ok) {
                  const err = new Error(
                    resultado.message ||
                      'No se pudo crear el cliente en Stripe',
                  );
                  err.httpStatus =
                    resultado.code === 'STRIPE_CUSTOMER_EMAIL_EXISTS'
                      ? 409
                      : 502;
                  err.code = resultado.code;
                  throw err;
                }

                const stripe_customer_id = resultado.id_customer;

                if (
                  !stripe_customer_id ||
                  typeof stripe_customer_id !== 'string' ||
                  !stripe_customer_id.startsWith('cus_')
                ) {
                  const err = new Error(
                    'No se pudo crear el cliente en Stripe',
                  );
                  err.httpStatus = 502;
                  err.code = 'STRIPE_CUSTOMER_ID_INVALID';
                  throw err;
                }

                // 3) Guardar stripe id (BD)
                await crear_usuario.update(
                  { id_costumer: stripe_customer_id },
                  { transaction: t },
                );

                // 4) Crear subusuario (BD)
                const crear_sub_usuario = await crearSubUsuario(
                  {
                    id_usuario: crear_usuario.id_usuario,
                    usuario: nombre_users.replace(/\s+/g, ''),
                    password: con_users,
                    email: usuario_users,
                    nombre_encargado: nombre_users,
                    rol: 'administrador',
                  },
                  { transaction: t },
                );

                return {
                  usuarioCreado: crear_usuario.toJSON(),
                  subUsuarioCreado: crear_sub_usuario, // ya viene sin password si usas tu helper
                  id_sub_usuario: crear_sub_usuario.id_sub_usuario,
                };
              });

            // ✅ 5) Token fuera (ya hay commit, ahora sí existe en BD)
            const sessionToken = await generarToken(id_sub_usuario);

            // estado_creacion
            const estado_creacion = 'incompleto';

            return res.status(200).json({
              status: 'success',
              estado_creacion,
              token: sessionToken,
              user: subUsuarioCreado, // si usas helper ya viene sin password
              id_plataforma: tienda,
              id_configuracion: null,
            });
          } catch (err) {
            return res.status(err.httpStatus || 500).json({
              status: 'fail',
              message: err.message || 'Error inesperado',
              code: err.code,
            });
          }
        } else {
          const usuarios_chat_center = await Usuarios_chat_center.findOne({
            where: {
              id_plataforma: tienda,
            },
          });

          if (!usuarios_chat_center) {
            return res.status(404).json({
              message: 'Usuario administrador no encontrado para esta tienda',
            });
          }

          /* consulta id_subusuarios */
          const subusuarios_chat_center =
            await Sub_usuarios_chat_center.findOne({
              where: {
                id_usuario: usuarios_chat_center.id_usuario,
                rol: 'administrador',
              },
            });

          if (!subusuarios_chat_center) {
            return res.status(404).json({
              message: 'Usuario administrador no encontrado para esta tienda',
            });
          }

          id_sub_usuario_encontrado = subusuarios_chat_center.id_sub_usuario;

          usuarioEncontrado = subusuarios_chat_center;

          if (usuarios_chat_center.estado == 'activo') {
            estado_creacion = 'completo';
          } else {
            estado_creacion = 'incompleto';
          }

          // Generar token de sesión
          const sessionToken = await generarToken(id_sub_usuario_encontrado);

          // Eliminar campos sensibles
          const usuarioPlano = usuarioEncontrado.toJSON();
          const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

          // Respuesta
          res.status(200).json({
            status: 'success',
            estado_creacion: estado_creacion,
            token: sessionToken,
            user: usuarioSinPassword,
            id_plataforma: tienda,
            id_configuracion: null,
          });
        }
      } else {
        const configuracion = await Configuraciones.findOne({
          where: { id_plataforma: tienda, suspendido: 0 },
        });

        if (!configuracion || !configuracion.id_usuario) {
          res.status(200).json({
            status: 'success',
            estado_creacion: 'nulo',
            token: null,
            user: null,
            id_plataforma: tienda,
            id_configuracion: null,
          });
        } else {
          const usuarios_chat_center = await Usuarios_chat_center.findOne({
            where: {
              id_usuario: configuracion.id_usuario,
            },
          });

          if (!usuarios_chat_center) {
            return res.status(404).json({
              message: 'Usuario administrador no encontrado para esta tienda',
            });
          }

          /* consulta id_subusuarios */
          const subusuarios_chat_center =
            await Sub_usuarios_chat_center.findOne({
              where: {
                id_usuario: usuarios_chat_center.id_usuario,
                rol: 'administrador',
              },
            });

          if (!subusuarios_chat_center) {
            return res.status(404).json({
              message: 'Usuario administrador no encontrado para esta tienda',
            });
          }

          id_sub_usuario_encontrado = subusuarios_chat_center.id_sub_usuario;

          usuarioEncontrado = subusuarios_chat_center;
          estado_creacion = 'completo';

          // Generar token de sesión
          const sessionToken = await generarToken(id_sub_usuario_encontrado);

          // Eliminar campos sensibles
          const usuarioPlano = usuarioEncontrado.toJSON();
          const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

          // Respuesta
          res.status(200).json({
            status: 'success',
            estado_creacion: estado_creacion,
            token: sessionToken,
            user: usuarioSinPassword,
            id_plataforma: tienda,
            id_configuracion: null,
          });
        }
      }
    }
  } catch (err) {
    return res
      .status(401)
      .json({ message: 'Token inválido o expirado', error: err.message });
  }
};

exports.updatePassword = catchAsync(async (req, res, next) => {
  const { user } = req;
  const { currentPassword, newPassword } = req.body;

  if (!(await bcrypt.compare(currentPassword, user.password))) {
    return next(new AppError('Current password is incorrect!', 401));
  }

  const salt = await bcrypt.genSalt(12);
  const encryptedPassword = await bcrypt.hash(newPassword, salt);

  await user.update({
    con_users: encryptedPassword,
  });

  res.status(200).json({
    status: 'success',
    message: 'Password updated successfully!🎉',
  });
});

exports.renew = catchAsync(async (req, res, next) => {
  const { id_users } = req.sessionUser;
  const user = await User.findOne({
    where: {
      id_users: id_users,
    },
  });
  if (!user) {
    return next(new AppError('User not found! 🧨', 404));
  }
  const token = await generarToken(id_users);

  res.status(200).json({
    status: 'success',
    token,
    user: {
      id: user.id_users,
      nombre: user.nombre_users,
      usuario: user.usuario_users,
      email: user.email_users,
    },
  });
});
