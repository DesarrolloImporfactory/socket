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
const Comunidad = require('../models/comunidad_chat_center.model');
const { Op } = require('sequelize');
const AppError = require('../utils/appError');
const jwt = require('jsonwebtoken');
const { db, db_2 } = require('../database/config');

exports.registrarUsuario = catchAsync(async (req, res, next) => {
  const {
    email,
    nombre_encargado,
    password,
    whatsapp_lead,
    whatsapp_lead_pais,
    id_comunidad,
  } = req.body;

  // --- Campos obligatorios ahora son 4 (WhatsApp incluido) ---
  if (!email || !nombre_encargado || !password || !whatsapp_lead) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'Todos los campos son obligatorios' });
  }

  const nombre = nombre_encargado.trim();
  const usuario = email.toLowerCase().trim();

  // --- Validar duplicados por email ---
  const existeUsuario = await Usuarios_chat_center.findOne({
    where: { email_propietario: email },
  });
  if (existeUsuario) {
    return res
      .status(400)
      .json({ status: 'fail', message: 'Ya existe una cuenta con ese email' });
  }

  const existeSubUsuario = await Sub_usuarios_chat_center.findOne({
    where: { email },
  });
  if (existeSubUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'El email ya está en uso',
    });
  }

  // --- Normalizar y validar WhatsApp (mínimo 7 dígitos reales) ---
  const waClean = String(whatsapp_lead).replace(/\D/g, '').slice(0, 20);
  if (waClean.length < 7) {
    return res.status(400).json({
      status: 'fail',
      message: 'Número de WhatsApp inválido',
    });
  }
  const waPais = whatsapp_lead_pais
    ? String(whatsapp_lead_pais).slice(0, 8)
    : '+593'; // default Ecuador si no viene

  // --- 🛡️ Validar id_comunidad: solo aceptar si existe en BD (anti-fake) ---
  let comunidadValida = null;
  if (id_comunidad) {
    const found = await Comunidad.findOne({
      where: { id_comunidad: parseInt(id_comunidad, 10), activo: 1 },
      attributes: ['id_comunidad'],
    });
    if (found) comunidadValida = found.id_comunidad;
  }

  const sequelize = Usuarios_chat_center.sequelize;

  try {
    const { nuevoUsuario, nuevoSubUsuario, id_sub_usuario } =
      await sequelize.transaction(async (t) => {
        // 1) Crear usuario principal con campos de lead
        const nuevoUsuarioInst = await Usuarios_chat_center.create(
          {
            nombre,
            email_propietario: email,
            whatsapp_lead: waClean,
            whatsapp_lead_pais: waPais,
            id_comunidad: comunidadValida,
          },
          { transaction: t },
        );

        // 2) Stripe customer
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
          throw err;
        }

        const stripe_customer_id = resultado.id_customer;

        if (!stripe_customer_id?.startsWith('cus_')) {
          const err = new Error('No se pudo crear el cliente en Stripe');
          err.httpStatus = 502;
          err.code = 'STRIPE_CUSTOMER_ID_INVALID';
          throw err;
        }

        await nuevoUsuarioInst.update(
          { id_costumer: stripe_customer_id },
          { transaction: t },
        );

        // 3) Crear subusuario
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

        // 4) Incrementar contador de la comunidad (analytics)
        if (comunidadValida) {
          await sequelize.query(
            `UPDATE comunidades_chat_center 
             SET total_registros = total_registros + 1 
             WHERE id_comunidad = ?`,
            { replacements: [comunidadValida], transaction: t },
          );
        }

        return {
          nuevoUsuario: nuevoUsuarioInst.toJSON(),
          nuevoSubUsuario,
          id_sub_usuario: nuevoSubUsuario.id_sub_usuario,
        };
      });

    const token = await generarToken(id_sub_usuario);

    return res.status(201).json({
      status: 'success',
      message: 'Cuenta creada correctamente 🎉',
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

/**
 * Genera un username único para sub_usuarios_chat_center.
 * Si la base ya existe: LUIS → LUIS2 → LUIS3 ...
 * Sanitiza: solo alfanumérico + underscore, sin tildes, mínimo 3 chars.
 */
async function generarUsernameUnico(base, transaction = null) {
  let baseLimpia = String(base || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .trim();

  if (baseLimpia.length < 3) {
    baseLimpia = `user${Date.now().toString().slice(-6)}`;
  }

  let candidato = baseLimpia;
  let intento = 1;

  while (intento <= 50) {
    const existe = await Sub_usuarios_chat_center.findOne({
      where: { usuario: candidato },
      transaction,
      attributes: ['id_sub_usuario'],
    });

    if (!existe) return candidato;

    intento += 1;
    candidato = `${baseLimpia}${intento}`;
  }

  return `${baseLimpia}_${Date.now().toString().slice(-6)}`;
}

exports.newLogin = async (req, res) => {
  const { token, tienda, tipo } = req.body;

  if (!token || !tienda) {
    return res.status(400).json({ message: 'Token y tienda requeridos' });
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_JWT_SEED);

    const idPlataformaFromToken = decoded?.data?.id_plataforma;

    /* ===== call_center ===== */
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

      const configuracion = await Configuraciones.findOne({
        where: { id_plataforma: tienda, suspendido: 0 },
      });

      if (!configuracion || !configuracion.id_usuario) {
        return res.status(404).json({
          message: 'Configuración no encontrada para esta tienda',
        });
      }

      const usuarioEncontrado = await Sub_usuarios_chat_center.findOne({
        where: {
          id_usuario: configuracion.id_usuario,
          rol: 'administrador',
        },
      });

      if (!usuarioEncontrado) {
        return res.status(404).json({
          message: 'Usuario administrador no encontrado para esta tienda',
        });
      }

      const sessionToken = await generarToken(usuarioEncontrado.id_sub_usuario);
      const usuarioPlano = usuarioEncontrado.toJSON();
      const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

      return res.status(200).json({
        status: 'success',
        token: sessionToken,
        user: usuarioSinPassword,
        id_plataforma: tienda,
        id_configuracion: configuracion.id,
        tipo_configuracion: configuracion.tipo_configuracion,
      });

      /* ===== cursos_imporsuit ===== */
    } else if (tipo == 'cursos_imporsuit') {
      let usuarioEncontrado = null;
      const idUsuarioFromToken = decoded?.data?.id;

      // 👇 Ahora también traemos email_users
      const [user_imporauit] = await db_2.query(
        `SELECT id_rol, ecommerce, membresia_ecommerce, importacion, 
                nombre_users, con_users, usuario_users, email_users
         FROM users 
         WHERE id_users = ? 
         LIMIT 1`,
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

      let ecommerce = user_imporauit.ecommerce;
      let membresia_ecommerce = user_imporauit.membresia_ecommerce;
      let importacion = user_imporauit.importacion;
      let nombre_users = user_imporauit.nombre_users;
      let con_users = user_imporauit.con_users;
      let usuario_users = user_imporauit.usuario_users;
      let email_users = user_imporauit.email_users;
      let id_rol = user_imporauit.id_rol;

      // 🛡️ Validar email real
      if (!email_users || !String(email_users).includes('@')) {
        return res.status(400).json({
          status: 'fail',
          message:
            'El usuario de imporsuit no tiene un email válido registrado (email_users)',
        });
      }

      let id_sub_usuario_encontrado = '';
      let estado_creacion = '';

      if (
        ecommerce == 1 ||
        membresia_ecommerce == 1 ||
        importacion == 1 ||
        id_rol == 16
      ) {
        const validar_usuario_plataforma = await Usuarios_chat_center.findOne({
          where: { id_plataforma: tienda },
        });

        if (
          !validar_usuario_plataforma ||
          !validar_usuario_plataforma.id_usuario
        ) {
          // 🛡️ ESCENARIO B: ¿ya existe usuario en chatcenter con ese email?
          const usuarioExistentePorEmail = await Usuarios_chat_center.findOne({
            where: { email_propietario: email_users },
          });

          if (usuarioExistentePorEmail) {
            if (!usuarioExistentePorEmail.id_plataforma) {
              await usuarioExistentePorEmail.update({ id_plataforma: tienda });
            }

            const subUserExistente = await Sub_usuarios_chat_center.findOne({
              where: {
                id_usuario: usuarioExistentePorEmail.id_usuario,
                rol: 'administrador',
              },
            });

            if (!subUserExistente) {
              return res.status(404).json({
                status: 'fail',
                message: 'Usuario administrador no encontrado para esta cuenta',
              });
            }

            const sessionToken = await generarToken(
              subUserExistente.id_sub_usuario,
            );
            const { password, admin_pass, ...subUserSinPassword } =
              subUserExistente.toJSON();

            return res.status(200).json({
              status: 'success',
              estado_creacion:
                usuarioExistentePorEmail.estado === 'activo'
                  ? 'completo'
                  : 'incompleto',
              token: sessionToken,
              user: subUserSinPassword,
              id_plataforma: tienda,
              id_configuracion: null,
            });
          }

          // 🆕 ESCENARIO A: crear desde cero
          const sequelize = Usuarios_chat_center.sequelize;

          try {
            const { usuarioCreado, subUsuarioCreado, id_sub_usuario } =
              await sequelize.transaction(async (t) => {
                // 1) Crear usuario principal
                const crear_usuario = await Usuarios_chat_center.create(
                  {
                    nombre: nombre_users,
                    id_plan: null,
                    id_plataforma: tienda,
                    fecha_inicio: null,
                    fecha_renovacion: null,
                    estado: 'inactivo',
                    email_propietario: email_users,
                  },
                  { transaction: t },
                );

                // 2) Stripe (reutiliza customer si ya existe en Stripe)
                const resultado = await crearStripeCustomer({
                  nombre: nombre_users,
                  email: email_users, // 👈 email REAL
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

                // 3) Guardar stripe id
                await crear_usuario.update(
                  { id_costumer: stripe_customer_id },
                  { transaction: t },
                );

                // 4) Generar username único + crear subusuario
                const usernameBase =
                  usuario_users && String(usuario_users).trim().length >= 3
                    ? usuario_users
                    : nombre_users.replace(/\s+/g, '');

                const usernameUnico = await generarUsernameUnico(
                  usernameBase,
                  t,
                );

                const crear_sub_usuario = await crearSubUsuario(
                  {
                    id_usuario: crear_usuario.id_usuario,
                    usuario: usernameUnico, // 👈 garantizado único
                    password: con_users,
                    email: email_users, // 👈 email REAL
                    nombre_encargado: nombre_users,
                    rol: 'administrador',
                  },
                  { transaction: t },
                );

                return {
                  usuarioCreado: crear_usuario.toJSON(),
                  subUsuarioCreado: crear_sub_usuario,
                  id_sub_usuario: crear_sub_usuario.id_sub_usuario,
                };
              });

            const sessionToken = await generarToken(id_sub_usuario);

            return res.status(200).json({
              status: 'success',
              estado_creacion: 'incompleto',
              token: sessionToken,
              user: subUsuarioCreado,
              id_plataforma: tienda,
              id_configuracion: null,
            });
          } catch (err) {
            // 🔍 Log detallado por si vuelve a fallar
            console.error('❌ DEBUG newLogin/cursos_imporsuit catch:', {
              name: err.name,
              message: err.message,
              code: err.code,
              errors: err.errors?.map((e) => ({
                path: e.path,
                message: e.message,
                type: e.type,
                value: e.value,
                validatorKey: e.validatorKey,
              })),
              sqlMessage: err.original?.sqlMessage,
            });

            let mensajeAmigable = err.message || 'Error inesperado';
            let detalles = null;

            if (err.name === 'SequelizeUniqueConstraintError') {
              detalles = err.errors?.map((e) => ({
                campo: e.path,
                valor: e.value,
                problema: 'duplicado',
              }));
              mensajeAmigable = `UNIQUE constraint: ${err.errors
                ?.map((e) => `${e.path}=${e.value}`)
                .join(', ')}`;
            } else if (err.name === 'SequelizeValidationError') {
              detalles = err.errors?.map((e) => ({
                campo: e.path,
                valor: e.value,
                problema: e.message,
              }));
              mensajeAmigable = `Validation: ${err.errors
                ?.map((e) => `${e.path} → ${e.message}`)
                .join(', ')}`;
            }

            return res.status(err.httpStatus || 500).json({
              status: 'fail',
              message: mensajeAmigable,
              code: err.code || err.name,
              detalles,
              sqlMessage: err.original?.sqlMessage || null,
            });
          }
        } else {
          // Ya existe usuario asociado a esta plataforma
          const usuarios_chat_center = await Usuarios_chat_center.findOne({
            where: { id_plataforma: tienda },
          });

          if (!usuarios_chat_center) {
            return res.status(404).json({
              message: 'Usuario administrador no encontrado para esta tienda',
            });
          }

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

          estado_creacion =
            usuarios_chat_center.estado === 'activo'
              ? 'completo'
              : 'incompleto';

          const sessionToken = await generarToken(id_sub_usuario_encontrado);
          const usuarioPlano = usuarioEncontrado.toJSON();
          const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

          return res.status(200).json({
            status: 'success',
            estado_creacion,
            token: sessionToken,
            user: usuarioSinPassword,
            id_plataforma: tienda,
            id_configuracion: null,
          });
        }
      } else {
        // Usuario imporsuit sin permisos (ni ecommerce, ni membresia, ni importacion, ni rol 16)
        const configuracion = await Configuraciones.findOne({
          where: { id_plataforma: tienda, suspendido: 0 },
        });

        if (!configuracion || !configuracion.id_usuario) {
          return res.status(200).json({
            status: 'success',
            estado_creacion: 'nulo',
            token: null,
            user: null,
            id_plataforma: tienda,
            id_configuracion: null,
          });
        }

        const usuarios_chat_center = await Usuarios_chat_center.findOne({
          where: { id_usuario: configuracion.id_usuario },
        });

        if (!usuarios_chat_center) {
          return res.status(404).json({
            message: 'Usuario administrador no encontrado para esta tienda',
          });
        }

        const subusuarios_chat_center = await Sub_usuarios_chat_center.findOne({
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

        const sessionToken = await generarToken(id_sub_usuario_encontrado);
        const usuarioPlano = usuarioEncontrado.toJSON();
        const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

        return res.status(200).json({
          status: 'success',
          estado_creacion,
          token: sessionToken,
          user: usuarioSinPassword,
          id_plataforma: tienda,
          id_configuracion: null,
        });
      }
    }
  } catch (err) {
    return res
      .status(401)
      .json({ message: 'Token inválido o expirado', error: err.message });
  }
};
/**
 * Single sign-out: marca users.logout_at = NOW() para forzar la invalidación
 * de todos los JWTs anteriores del usuario en ambas apps (Imporsuit y Chatcenter).
 *
 * IMPORTANTE: req.sessionUser.id_usuario es el ID de Usuarios_chat_center
 * (BD chatcenter), NO el id_users de imporsuit. Mapeamos por email, que es
 * el identificador común entre ambas BDs.
 */
exports.logoutGlobal = catchAsync(async (req, res, next) => {
  const subUser = req.sessionUser;
  const email = subUser?.email;
  const usuario = subUser?.usuario;

  if (!email && !usuario) {
    return res.status(401).json({
      status: 'fail',
      message: 'No autenticado',
    });
  }

  try {
    const [, affected] = await db_2.query(
      `UPDATE users
         SET logout_at = NOW()
       WHERE email_users = ? OR usuario_users = ?`,
      {
        replacements: [email || '', usuario || email || ''],
        type: db_2.QueryTypes.UPDATE,
      },
    );
    console.log(
      `logoutGlobal: email=${email} usuario=${usuario} → filas actualizadas=${affected}`,
    );
  } catch (err) {
    console.error('logoutGlobal: error actualizando users.logout_at', err);
    return res.status(500).json({
      status: 'fail',
      message: 'No se pudo cerrar sesión globalmente',
    });
  }

  return res.status(200).json({
    status: 'success',
    message: 'Sesión cerrada en todas las aplicaciones',
  });
});

/**
 * Emite un JWT corto-vivido (60s) con el secret compartido para que el
 * usuario actual del chatcenter pueda iniciar sesión en imporsuit sin
 * volver a poner credenciales. Validado por Acceso::sso_from_chatcenter.
 */
exports.issueImporsuitToken = catchAsync(async (req, res) => {
  const subUser = req.sessionUser;
  const email = subUser?.email || '';
  const usuario = subUser?.usuario || '';

  if (!email && !usuario) {
    return res.status(401).json({
      status: 'fail',
      message: 'No autenticado',
    });
  }

  // Verificar que el usuario tiene cuenta en imporsuit
  let imporUser;
  try {
    [imporUser] = await db_2.query(
      `SELECT email_users
         FROM users
        WHERE email_users = ? OR usuario_users = ?
        LIMIT 1`,
      {
        replacements: [email, usuario || email],
        type: db_2.QueryTypes.SELECT,
      },
    );
  } catch (err) {
    console.error(
      'issueImporsuitToken: error consultando users —',
      err.message,
    );
    return res.status(500).json({
      status: 'fail',
      message: 'Error verificando cuenta de imporsuit',
    });
  }

  if (!imporUser) {
    return res.status(404).json({
      status: 'fail',
      code: 'NO_IMPORSUIT_ACCOUNT',
      message: 'No tienes cuenta de ImporSuit asociada a este correo',
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const ssoToken = jwt.sign(
    {
      iss: 'chatcenter',
      aud: 'imporsuit',
      iat: now,
      exp: now + 60, // un solo uso, 60 segundos
      email: imporUser.email_users,
    },
    process.env.SECRET_JWT_SEED,
    { algorithm: 'HS256' },
  );

  return res.status(200).json({
    status: 'success',
    token: ssoToken,
    expiresIn: 60,
  });
});

/**
 * Devuelve qué apps del ecosistema tiene registradas el usuario autenticado.
 * Usado por el App Switcher del chatcenter para saber si mostrar ImporSuit
 * como disponible o bloqueada (no tiene cuenta).
 */
exports.crossAppStatus = catchAsync(async (req, res) => {
  const subUser = req.sessionUser;
  const email = subUser?.email || '';
  const usuario = subUser?.usuario || '';

  // Si llegó hasta acá, ya está autenticado en chatcenter
  let hasChatcenter = true;
  let hasImporsuit = false;

  if (email || usuario) {
    try {
      const [row] = await db_2.query(
        `SELECT 1 AS x
           FROM users
          WHERE email_users = ? OR usuario_users = ?
          LIMIT 1`,
        {
          replacements: [email, usuario || email],
          type: db_2.QueryTypes.SELECT,
        },
      );
      hasImporsuit = !!row;
    } catch (err) {
      console.warn('crossAppStatus: error consultando users —', err.message);
    }
  }

  return res.status(200).json({
    status: 'success',
    hasImporsuit,
    hasChatcenter,
  });
});

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
