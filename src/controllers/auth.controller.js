const User = require('../models/user.model');
const catchAsync = require('../utils/catchAsync');
const bcrypt = require('bcryptjs');
const { generarToken } = require('./../utils/jwt');
const { crearSubUsuario } = require('./../utils/crearSubUsuario');
const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Openai_assistants = require('../models/openai_assistants.model');
const Configuraciones = require('../models/configuraciones.model');
const { Op } = require('sequelize');
const AppError = require('../utils/appError');
const jwt = require('jsonwebtoken');
const { db } = require('../database/config');

exports.registrarUsuario = catchAsync(async (req, res, next) => {
  const { nombre, usuario, password, email, nombre_encargado } = req.body;

  // Validar campos obligatorios
  if (!nombre || !usuario || !password || !email || !nombre_encargado) {
    return res.status(400).json({
      status: 'fail',
      message: 'Todos los campos son obligatorios',
    });
  }

  // Validar existencia de nombre de usuario principal
  const existeUsuario = await Usuarios_chat_center.findOne({
    where: { nombre },
  });
  if (existeUsuario) {
    return res.status(400).json({
      status: 'fail',
      message: 'Ya existe un usuario con ese nombre',
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

  // Crear usuario principal
  const nuevoUsuario = await Usuarios_chat_center.create({ nombre });

  // Crear subusuario administrador
  const nuevoSubUsuario = await crearSubUsuario({
    id_usuario: nuevoUsuario.id_usuario,
    usuario,
    password: password,
    email,
    nombre_encargado,
    rol: 'administrador',
  });

  // Generar token JWT
  const token = await generarToken(nuevoSubUsuario.id_sub_usuario);

  res.status(201).json({
    status: 'success',
    message: 'Cuenta y usuario administrador creados correctamente 🎉',
    token,
    user: {
      id_usuario: nuevoUsuario.id_usuario,
      nombre: nuevoUsuario.nombre,
      administrador: nuevoSubUsuario,
    },
  });
});

exports.login = catchAsync(async (req, res, next) => {
  const { usuario, password } = req.body;

  // Buscar por usuario o email
  const usuarioEncontrado = await Sub_usuarios_chat_center.findOne({
    where: {
      [Op.or]: [{ usuario }, { email: usuario }],
    },
  });

  if (!usuarioEncontrado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  // Verificar password principal o admin_pass
  let autenticado = await bcrypt.compare(password, usuarioEncontrado.password);

  if (!autenticado && usuarioEncontrado.admin_pass) {
    autenticado = await bcrypt.compare(password, usuarioEncontrado.admin_pass);
  }

  if (!autenticado) {
    return res.status(401).json({
      status: 'fail',
      message: 'Credenciales inválidas',
    });
  }

  // Generar token
  const token = await generarToken(usuarioEncontrado.id_sub_usuario);

  // Eliminar campos sensibles
  const usuarioPlano = usuarioEncontrado.toJSON();
  const { password: _, admin_pass, ...usuarioSinPassword } = usuarioPlano;

  res.status(200).json({
    status: 'success',
    message: 'Login exitoso',
    token,
    data: usuarioSinPassword,
  });
});

exports.validar_usuario_imporsuit = catchAsync(async (req, res, next) => {
  const { usuario, password, id_configuracion } = req.body;

  // Buscar por usuario o email
  const [usuarioEncontrado] = await db.query(
    `SELECT p.id_plataforma, u.id_users, u.nombre_users, u.usuario_users, u.email_users, u.con_users, u.admin_pass FROM users u
      INNER JOIN usuario_plataforma up ON u.id_users = up.id_usuario
      INNER JOIN plataformas p ON p.id_plataforma = up.id_plataforma
       WHERE u.usuario_users = ?
       LIMIT 1`,
    {
      replacements: [usuario],
      type: db.QueryTypes.SELECT,
    }
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
    }
  );

  await Openai_assistants.update(
    {
      productos: null,
    },
    {
      where: {
        id_configuracion: id_configuracion,
      },
    }
  );

  res.status(200).json({
    status: 'success',
    message: 'Vinculacion exitosa',
    id_plataforma: usuarioEncontrado.id_plataforma,
  });
});

exports.newLogin = async (req, res) => {
  const { token, tienda, tipo } = req.body; // 'tipo' solo para call_center

  if (!token) {
    console.error("[newLogin] Falta token en body");
    return res.status(400).json({ message: "Token requerido" });
  }
  if (tipo === "call_center" && !tienda) {
    console.error("[newLogin] Falta tienda para call_center");
    return res.status(400).json({ message: "Para call_center, tienda requerida" });
  }

  // Log básico del request (sin imprimir el token completo)
  console.log("[newLogin] request", {
    hasToken: !!token,
    tokenPreview: token.slice(0, 24) + "...",
    tienda,
    tipo,
  });

  // Helpers
  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  // 1) DEBUG: decodificar sin verificar (para ver header/payload/exp)
  const decodedLoose = jwt.decode(token, { complete: true }) || {};
  const nowEpoch = Math.floor(Date.now() / 1000);
  console.log("[newLogin] jwt.decode (NO verificado)", {
    header: decodedLoose.header || null,
    payloadPreview: decodedLoose.payload
      ? {
          sub: decodedLoose.payload.sub || null,
          dataKeys: decodedLoose.payload.data
            ? Object.keys(decodedLoose.payload.data)
            : [],
          iat: decodedLoose.payload.iat || null,
          nbf: decodedLoose.payload.nbf || null,
          exp: decodedLoose.payload.exp || null,
        }
      : null,
    nowEpoch,
    nowISO: new Date().toISOString(),
    secretPresent: !!process.env.SECRET_JWT_SEED,
    secretLen: process.env.SECRET_JWT_SEED
      ? String(process.env.SECRET_JWT_SEED).length
      : 0,
  });

  // 2) Verificar JWT (si falla, devolvemos 401 con motivo real)
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.SECRET_JWT_SEED /* , { algorithms: ["HS256"] } */);
    console.log("[newLogin] jwt.verify OK", {
      iat: decoded.iat || null,
      nbf: decoded.nbf || null,
      exp: decoded.exp || null,
      nowEpoch,
      skewFromIat: decoded.iat ? nowEpoch - decoded.iat : null,
    });
  } catch (err) {
    console.error("[newLogin] jwt.verify FAILED", {
      name: err.name,
      message: err.message,
      expiredAt: err.expiredAt || null,
      payloadPreview: decodedLoose.payload
        ? {
            iat: decodedLoose.payload.iat || null,
            nbf: decodedLoose.payload.nbf || null,
            exp: decodedLoose.payload.exp || null,
          }
        : null,
      nowEpoch,
      nowISO: new Date().toISOString(),
      secretPresent: !!process.env.SECRET_JWT_SEED,
    });
    return res.status(401).json({ message: "Token inválido o expirado", error: err.message });
  }

  try {
    // 3) Derivados desde el token: AQUÍ TOMAMOS id_usuario DEL TOKEN
    const ownerIdFromToken = toNum(
      decoded?.data?.id_usuario ?? decoded?.data?.id ?? decoded?.uid
    );
    const emailFromToken = String(decoded?.data?.correo ?? decoded?.sub ?? "")
      .trim()
      .toLowerCase();
    const idPlataformaFromToken = toNum(decoded?.data?.id_plataforma ?? decoded?.id_plataforma);
    const tiendaNum = toNum(tienda);

    console.log("[newLogin] derivados", {
      ownerIdFromToken,       // <--- ESTE ES EL id_usuario tomado del token
      emailFromToken,
      idPlataformaFromToken,
      tiendaNum,
      tipo,
    });

    // 4) Gate cursos: si podemos identificar al alumno, exigir flags (1) en users
    let alumno = null;

    if (ownerIdFromToken != null) {
      const [row] = await db.query(
        `SELECT id_users, importacion, membresia_ecommerce, ecommerce
           FROM users
          WHERE id_users = ?
          LIMIT 1`,
        { replacements: [ownerIdFromToken], type: db.QueryTypes.SELECT }
      );
      if (row) alumno = row;
    }
    if (!alumno && emailFromToken) {
      const [rowByEmail] = await db.query(
        `SELECT id_users, importacion, membresia_ecommerce, ecommerce
           FROM users
          WHERE LOWER(email_users) = ?
             OR LOWER(usuario_users) = ?
          LIMIT 1`,
        { replacements: [emailFromToken, emailFromToken], type: db.QueryTypes.SELECT }
      );
      if (rowByEmail) alumno = rowByEmail;
    }

    if (alumno) {
      const tieneAcceso =
        Number(alumno.membresia_ecommerce) === 1 ||
        Number(alumno.ecommerce) === 1 ||
        Number(alumno.importacion) === 1;

      console.log("[newLogin] alumno encontrado y flags", {
        id_users: alumno.id_users,
        importacion: alumno.importacion,
        membresia_ecommerce: alumno.membresia_ecommerce,
        ecommerce: alumno.ecommerce,
        tieneAcceso,
      });

      if (!tieneAcceso) {
        return res.status(403).json({
          code: "NO_COURSE_ACCESS",
          message: "Esta cuenta no tiene acceso a cursos. Continúe con el login normal.",
        });
      }
    } else {
      console.log("[newLogin] No se pudo identificar alumno en 'users' (no bloquea).");
    }

    // 5) Validación call_center (igual que antes)
    if (tipo === "call_center") {
      const [cc] = await db.query(
        `SELECT id_call_center FROM call_centers WHERE id_plataforma = ?`,
        { replacements: [idPlataformaFromToken], type: db.QueryTypes.SELECT }
      );
      console.log("[newLogin] call_center check", { idPlataformaFromToken, cc: !!cc });

      if (!cc || !cc.id_call_center) {
        return res.status(403).json({ message: "La plataforma no es call center" });
      }
      const [pl] = await db.query(
        `SELECT id_call_center FROM plataformas WHERE id_plataforma = ?`,
        { replacements: [tiendaNum], type: db.QueryTypes.SELECT }
      );
      console.log("[newLogin] call_center tienda check", { tiendaNum, pl: !!pl });

      if (!pl || pl.id_call_center !== cc.id_call_center) {
        return res.status(403).json({
          message: "El call center no tiene permiso de acceder a esta tienda",
        });
      }
    }

    // 6) Resolver configuración (tienda → token). OJO: no tocamos 'plataformas.id_usuario'
    let configuracion = null;

    if (tiendaNum != null) {
      configuracion = await Configuraciones.findOne({
        where: { id_plataforma: tiendaNum },
      });
      console.log("[newLogin] configuracion by tienda", !!configuracion);
    }

    if (!configuracion && idPlataformaFromToken != null) {
      configuracion = await Configuraciones.findOne({
        where: { id_plataforma: idPlataformaFromToken },
      });
      console.log("[newLogin] configuracion by token", !!configuracion);
    }

    if (!configuracion) {
      console.error("[newLogin] Sin configuración para tienda/token");
      return res.status(404).json({ message: "Configuración no encontrada para esta tienda" });
    }

    console.log("[newLogin] configuracion encontrada", {
      id: configuracion.id,
      id_plataforma: configuracion.id_plataforma,
      id_usuario_en_config: configuracion.id_usuario ?? null,
    });

    
    
    
    

    // 8) Subusuario del ownerId (admin o cualquiera)
    let sub = await Sub_usuarios_chat_center.findOne({
      where: { id_usuario: ownerId, rol: "administrador" },
    });
    if (!sub) {
      sub = await Sub_usuarios_chat_center.findOne({
        where: { id_usuario: ownerId },
        order: [["id_sub_usuario", "DESC"]],
      });
    }
    if (!sub) {
      console.error("[newLogin] No existen subusuarios para el ownerId", ownerId);
      return res.status(404).json({
        message: "No existen subusuarios para el dueño de esta plataforma",
      });
    }

    // 9) Generar token de sesión para ImporChat y responder
    const sessionToken = await generarToken(sub.id_sub_usuario);

    const usuarioPlano = sub.toJSON();
    const { password, admin_pass, ...usuarioSinPassword } = usuarioPlano;

    console.log("[newLogin] OK -> emitiendo sesión", {
      id_plataforma: configuracion.id_plataforma,
      id_configuracion: configuracion.id,
      subusuario: sub.id_sub_usuario,
    });

    return res.status(200).json({
      status: "success",
      token: sessionToken,
      user: usuarioSinPassword,
      id_plataforma: configuracion.id_plataforma,
      id_configuracion: configuracion.id,
    });
  } catch (err) {
    // Cualquier error SQL/lógico entra aquí (ya no diremos "token inválido")
    console.error("[newLogin] ERROR no controlado", { name: err.name, message: err.message, stack: err.stack });
    return res.status(500).json({ message: "Error interno", error: err.message });
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
