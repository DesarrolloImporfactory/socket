const AppError = require('../utils/appError');
const { db } = require('../database/config');

/**
 * Middleware que exige rol super_administrador.
 * Se apoya en req.sessionUser (seteado por protect).
 *
 * protect deja en req.sessionUser la info del sub_usuario autenticado,
 * por lo que aquí leemos su rol directo de la tabla sub_usuarios_chat_center
 */
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

    if (rol !== 'super_administrador') {
      return next(
        new AppError(
          'Acceso denegado. Esta sección es solo para super administradores.',
          403,
        ),
      );
    }

    req.sessionUser.rol = rol;
    next();
  } catch (err) {
    console.error('requireSuperAdmin error:', err);
    next(new AppError('Error validando permisos', 500));
  }
};
