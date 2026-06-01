const AppError = require('../utils/appError');
const { db } = require('../database/config');

/**
 * Middleware que permite acceso a super_administrador Y gestor_clientes.
 * Lee el rol fresco desde sub_usuarios_chat_center (igual que requireSuperAdmin).
 */
const ROLES_PERMITIDOS = ['super_administrador', 'gestor_clientes'];

module.exports = async (req, res, next) => {
  try {
    const id_sub_usuario = req.sessionUser?.id_sub_usuario;
    const id_usuario = req.sessionUser?.id_usuario;

    if (!id_sub_usuario || !id_usuario) {
      return next(new AppError('No autenticado', 401));
    }

    const rows = await db.query(
      `SELECT rol
         FROM sub_usuarios_chat_center
        WHERE id_sub_usuario = ?
          AND id_usuario = ?
        LIMIT 1`,
      {
        replacements: [id_sub_usuario, id_usuario],
        type: db.QueryTypes.SELECT,
      },
    );

    const rol = rows?.[0]?.rol || null;

    if (!rol || !ROLES_PERMITIDOS.includes(rol)) {
      return next(
        new AppError(
          'Acceso denegado. No tienes permisos para esta sección.',
          403,
        ),
      );
    }

    req.sessionUser.rol = rol;
    next();
  } catch (err) {
    console.error('requireGestorClientes error:', err);
    next(new AppError('Error validando permisos', 500));
  }
};
