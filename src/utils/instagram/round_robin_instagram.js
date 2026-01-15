const { db } = require('../../database/config');

async function obtenerOwnerIdPorConfiguracion(id_configuracion) {
  const [row] = await db.query(
    `SELECT id_usuario
       FROM configuraciones
      WHERE id = ? AND suspendido = 0
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT }
  );
  return row?.id_usuario || null;
}

/**
 * Round robin para INSTAGRAM:
 * - Usa 1 solo depto (el primero por config)
 * - Lista agentes (sub_usuarios_chat_center) excluyendo admin/super_admin
 * - Fallback a admin si no hay agentes
 * - Puntero: historial_encargados_instagram (filtrado por id_configuracion)
 * - Lock para concurrencia
 */
async function rrInstagramUnDepto({
  id_configuracion,
  motivo = 'auto_round_robin_instagram',
}) {
  const lockKey = `rr:ig:${id_configuracion}`;

  // Lock
  const [lockRow] = await db.query(`SELECT GET_LOCK(?, 5) AS got`, {
    replacements: [lockKey],
    type: db.QueryTypes.SELECT,
  });

  try {
    const id_usuario_dueno = await obtenerOwnerIdPorConfiguracion(
      id_configuracion
    );
    if (!id_usuario_dueno) {
      return { id_encargado_nuevo: null, id_departamento_asginado: null };
    }

    // 1) depto único (MISMA tabla que Messenger: departamentos_chat_center)
    const dept = await db.query(
      `SELECT id_departamento
         FROM departamentos_chat_center
        WHERE id_configuracion = ?
        ORDER BY id_departamento ASC
        LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT }
    );

    const id_departamento_asginado = dept?.[0]?.id_departamento ?? null;

    // 2) candidatos (MISMA tabla que Messenger: sub_usuarios_chat_center)
    const encargados = await db.query(
      `SELECT id_sub_usuario
         FROM sub_usuarios_chat_center
        WHERE id_usuario = ?
          AND rol NOT IN ('administrador', 'super_administrador')
        ORDER BY id_sub_usuario ASC`,
      { replacements: [id_usuario_dueno], type: db.QueryTypes.SELECT }
    );

    let lista = (encargados || [])
      .map((x) => Number(x.id_sub_usuario))
      .filter(Boolean);

    // fallback admin
    if (!lista.length) {
      const admin = await db.query(
        `SELECT id_sub_usuario
           FROM sub_usuarios_chat_center
          WHERE id_usuario = ?
            AND rol = 'administrador'
          ORDER BY id_sub_usuario ASC
          LIMIT 1`,
        { replacements: [id_usuario_dueno], type: db.QueryTypes.SELECT }
      );

      const adminId = admin?.[0]?.id_sub_usuario
        ? Number(admin[0].id_sub_usuario)
        : null;

      lista = adminId ? [adminId] : [];
    }

    if (!lista.length) {
      return { id_encargado_nuevo: null, id_departamento_asginado };
    }

    // 3) puntero (✅ AISLADO por id_configuracion)
    const last = await db.query(
      `SELECT h.id_encargado_nuevo
     FROM historial_encargados_instagram h
     JOIN instagram_conversations c ON c.id = h.id_instagram_conversation
    WHERE c.id_configuracion = ?
      AND h.id_encargado_nuevo IS NOT NULL
      AND h.motivo IN ('auto_round_robin_instagram')
    ORDER BY h.id DESC
    LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT }
    );

    const lastAssigned = last?.[0]?.id_encargado_nuevo
      ? Number(last[0].id_encargado_nuevo)
      : null;

    // 4) elegir siguiente
    let id_encargado_nuevo = null;
    if (!lastAssigned) {
      id_encargado_nuevo = lista[0];
    } else {
      const idx = lista.indexOf(lastAssigned);
      id_encargado_nuevo =
        idx === -1 ? lista[0] : lista[(idx + 1) % lista.length];
    }

    return { id_encargado_nuevo, id_departamento_asginado };
  } finally {
    await db.query(`SELECT RELEASE_LOCK(?) AS released`, {
      replacements: [lockKey],
      type: db.QueryTypes.SELECT,
    });
  }
}

module.exports = { rrInstagramUnDepto };
