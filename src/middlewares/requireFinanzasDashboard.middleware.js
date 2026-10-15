const AppError = require('../utils/appError');
const { db } = require('../database/config');

/**
 * Lectura del tablero de ingresos (/admin_dashboard): super_administrador o un
 * sub-usuario de finanzas de esta lista. No da ningún otro permiso.
 */
const SUB_USUARIOS_FINANZAS = [
  7, // EvelynCherrez (cuenta 8) — finanzas y auditoría GRUPO IMPOR, pedido de Daniel 13-oct-2026
];

module.exports = async (req, res, next) => {
  try {
    const id_sub_usuario = req.sessionUser?.id_sub_usuario;
    const id_usuario = req.sessionUser?.id_usuario;

    if (!id_sub_usuario || !id_usuario) {
      return next(new AppError('No autenticado', 401));
    }

    const rows = await db.query(
      `SELECT rol, suspendido
         FROM sub_usuarios_chat_center
        WHERE id_sub_usuario = ?
          AND id_usuario = ?
        LIMIT 1`,
      {
        replacements: [id_sub_usuario, id_usuario],
        type: db.QueryTypes.SELECT,
      },
    );

    const fila = rows?.[0] || null;
    const esSuperAdmin = fila?.rol === 'super_administrador';
    // Un sub-usuario suspendido no entra aunque esté en la lista
    const esFinanzas =
      !!fila &&
      Number(fila.suspendido) !== 1 &&
      SUB_USUARIOS_FINANZAS.includes(Number(id_sub_usuario));

    if (!esSuperAdmin && !esFinanzas) {
      return next(
        new AppError(
          'Acceso denegado. Esta sección es solo para super administradores y finanzas.',
          403,
        ),
      );
    }

    if (esSuperAdmin) req.sessionUser.rol = fila.rol;
    next();
  } catch (err) {
    console.error('requireFinanzasDashboard error:', err);
    next(new AppError('Error validando permisos', 500));
  }
};
