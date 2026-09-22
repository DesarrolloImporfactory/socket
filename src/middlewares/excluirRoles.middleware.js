const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

/* Complemento de restrictTo.middleware: en vez de enumerar los roles que SÍ
   pueden, niega a los que NO deben. Sirve para lo que un asesor de ventas no
   tiene por qué ver (métricas de la cuenta, inversión en anuncios, ajustes de
   departamentos) sin tener que listar administrador, admin_limitado,
   gestor_clientes y super_administrador en cada ruta.

   Lee el rol fresco de la BD, igual que restrictToRoles: un cambio de rol
   aplica sin esperar a que el token expire. */
const excluirRoles = (...rolesExcluidos) => {
  return async (req, res, next) => {
    const subUsuario = req.sessionUser;

    if (!subUsuario) {
      return res.status(401).json({
        status: 'fail',
        message: 'No estás autenticado como subusuario',
      });
    }

    const usuarioDB = await Sub_usuarios_chat_center.findByPk(
      subUsuario.id_sub_usuario,
    );

    if (!usuarioDB || rolesExcluidos.includes(usuarioDB.rol)) {
      return res.status(403).json({
        status: 'fail',
        code: 'ROL_SIN_ACCESO',
        message: 'Tu rol no tiene acceso a esta sección',
      });
    }

    req.user = usuarioDB;
    next();
  };
};

module.exports = excluirRoles;
