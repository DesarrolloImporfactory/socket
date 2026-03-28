const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const catchAsync = require('../utils/catchAsync');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const Password_reset_codes = require('../models/password_reset_codes.model');
const { enviarCodigoRecuperacion } = require('../utils/mailer');
const { Op, where } = require('sequelize');
const e = require('express');

exports.requestCode = catchAsync(async (req, res, next) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      status: 'fail',
      message: 'El correo es obligatorio',
    });
  }

  const emailNorm = email.trim().toLowerCase();

  //Find sub_user
  const usuario = await Sub_usuarios_chat_center.findOne({
    where: { email: emailNorm },
  });

  if (!usuario) {
    return res.status(404).json({
      status: 'fail',
      message: 'No existe una cuenta vinculada a este correo',
    });
  }

  // Invalidar códigos anteriores pendientes de este email
  await Password_reset_codes.update(
    { usado: 1 },
    {
      where: {
        email: emailNorm,
        tipo: 'codigo',
        usado: 0,
      },
    },
  );

  //Generar codigo de 6 digitos
  const codigo = crypto.randomInt(100000, 999999).toString();

  //Guardar con expiracion de 15 minutos
  const expiraEn = new Date(Date.now() + 15 * 60 * 1000);

  await Password_reset_codes.create({
    id_sub_usuario: usuario.id_sub_usuario,
    email: emailNorm,
    codigo,
    tipo: 'codigo',
    expira_en: expiraEn,
  });

  await enviarCodigoRecuperacion(
    emailNorm,
    codigo,
    usuario.nombre_encargado || 'Usuario',
  );

  return res.status(200).json({
    status: 'success',
    message: 'Código enviado. Revisa tu bandeja de entrada.',
  });
});

exports.verifyCode = catchAsync(async (req, res, next) => {
  const { email, codigo } = req.body;

  if (!email || !codigo) {
    return res.status(400).json({
      status: 'fail',
      message: 'Correo y código son obligatorios',
    });
  }

  const emailNorm = email.trim().toLowerCase();

  //Buscar codigo valido - no usado y no expirado
  const registro = Password_reset_codes.findOne({
    where: {
      email: emailNorm,
      codigo: codigo.trim(),
      tipo: 'codigo',
      usado: 0,
      expira_en: { [Op.gt]: new Date() },
    },
    order: [['created_at', 'DESC']],
  });

  if (!registro) {
    return res.status(400).json({
      status: 'fail',
      message: 'Código inválido o expirado',
    });
  }

  await registro.update({ usado: 1 });

  // Generar token temporal para el paso 3
  const resetToken = crypto.randomBytes(32).toString('hex');
  const tokenExpira = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await Password_reset_codes.create({
    id_sub_usuario: registro.id_sub_usuario,
    email: emailNorm,
    codigo: resetToken,
    tipo: 'token',
    expira_en: tokenExpira,
  });

  return res.status(200).json({
    status: 'success',
    message: 'Código verificado',
    resetToken,
  });
});

exports.changePassword = catchAsync(async (req, res, next) => {
  const { email, resetToken, nuevaPassword } = req.body;

  if (!email || !resetToken || !nuevaPassword) {
    return res.status(400).json({
      status: 'fail',
      message: 'Todos los campos son obligatorios',
    });
  }

  if (nuevaPassword.length < 6) {
    return res.status(400).json({
      status: 'fail',
      message: 'La contraseña debe tener al menos 6 caracteres',
    });
  }

  const emailNorm = email.trim().toLowerCase();

  // Verificar token válido
  const registro = await Password_reset_codes.findOne({
    where: {
      email: emailNorm,
      codigo: resetToken,
      tipo: 'token',
      usado: 0,
      expira_en: { [Op.gt]: new Date() },
    },
    order: [['created_at', 'DESC']],
  });

  if (!registro) {
    return res.status(400).json({
      status: 'fail',
      message: 'Sesión expirada. Solicita un nuevo código.',
    });
  }

  // Hashear nueva contraseña
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(nuevaPassword, salt);

  // Actualizar contraseña en sub_usuarios_chat_center
  await Sub_usuarios_chat_center.update(
    { password: hash },
    { where: { id_sub_usuario: registro.id_sub_usuario } },
  );

  // Marcar token como usado
  await registro.update({ usado: 1 });

  // Invalidar cualquier otro código/token pendiente de este email
  await Password_reset_codes.update(
    { usado: 1 },
    {
      where: {
        email: emailNorm,
        usado: 0,
      },
    },
  );

  return res.status(200).json({
    status: 'success',
    message: 'Contraseña actualizada exitosamente',
  });
});
