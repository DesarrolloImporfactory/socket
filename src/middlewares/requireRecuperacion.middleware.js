const AppError = require('../utils/appError');
const { db } = require('../database/config');

/**
 * Acceso al módulo de recuperación de clientes (/recuperacion) y al historial
 * de seguimientos que usa.
 *
 * Entran: super_administrador, gestor_clientes (internos, como siempre) y los
 * subusuarios que el super admin eligió en recuperacion_asesores_chat_center.
 * Esa lista existe porque los asesores que hacen el seguimiento (p. ej. los de
 * la conexión de soporte "expertos") son `ventas` de otra cuenta: cambiarles
 * el rol les abriría todo el panel interno. Aquí solo se les abre esto.
 *
 * Deja en req.recuperacion { es_super, es_gestor, es_asesor, puede_asignar,
 * puede_gestionar_asesores } para que el controlador decida qué más permite.
 */
const ROLES_INTERNOS = ['super_administrador', 'gestor_clientes'];

async function resolverAcceso(sessionUser) {
  const id_sub_usuario = sessionUser?.id_sub_usuario;
  const id_usuario = sessionUser?.id_usuario;
  if (!id_sub_usuario || !id_usuario) return null;

  const rows = await db.query(
    `SELECT s.rol,
            (SELECT COUNT(*) FROM recuperacion_asesores_chat_center a
              WHERE a.id_sub_usuario = s.id_sub_usuario AND a.activo = 1) AS es_asesor
       FROM sub_usuarios_chat_center s
      WHERE s.id_sub_usuario = ? AND s.id_usuario = ?
      LIMIT 1`,
    { replacements: [id_sub_usuario, id_usuario], type: db.QueryTypes.SELECT },
  );
  const r = rows?.[0];
  if (!r) return null;
  const es_super = r.rol === 'super_administrador';
  const es_gestor = r.rol === 'gestor_clientes';
  const es_asesor = Number(r.es_asesor) > 0;
  return {
    rol: r.rol,
    es_super,
    es_gestor,
    es_asesor,
    acceso: es_super || es_gestor || es_asesor,
    puede_asignar: es_super || es_gestor,
    puede_gestionar_asesores: es_super,
  };
}

module.exports = async (req, res, next) => {
  try {
    let acceso;
    try {
      acceso = await resolverAcceso(req.sessionUser);
    } catch (e) {
      // La tabla de asesores aún no existe (migración pendiente): solo
      // entran los roles internos.
      if (e?.original?.code !== 'ER_NO_SUCH_TABLE') throw e;
      const rol = req.sessionUser?.rol || null;
      const es_super = rol === 'super_administrador';
      acceso = rol && ROLES_INTERNOS.includes(rol)
        ? { rol, es_super, es_gestor: !es_super, es_asesor: false, acceso: true, puede_asignar: true, puede_gestionar_asesores: es_super }
        : null;
    }
    if (!acceso) return next(new AppError('No autenticado', 401));
    if (!acceso.acceso) {
      return next(
        new AppError(
          'Acceso denegado. Esta sección es solo para los asesores de recuperación.',
          403,
        ),
      );
    }
    req.sessionUser.rol = acceso.rol;
    req.recuperacion = acceso;
    next();
  } catch (err) {
    console.error('requireRecuperacion error:', err);
    next(new AppError('Error validando permisos', 500));
  }
};

module.exports.resolverAcceso = resolverAcceso;
