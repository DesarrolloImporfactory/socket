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
 * Round robin para MESSENGER:
 * - Usa 1 solo depto (el primero por config)
 * - Lista agentes (sub_usuarios_chat_center) excluyendo admin/super_admin
 * - Fallback a admin si no hay agentes
 * - Puntero: historial_encargados_messenger (último id_encargado_nuevo)
 * - Lock para concurrencia
 */
async function rrMessengerUnDepto({
  id_configuracion,
  motivo = 'auto_round_robin_messenger',
}) {
  const lockKey = `rr:ms:${id_configuracion}`;

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

    // 1) depto único
    const dept = await db.query(
      `SELECT id_departamento
       FROM departamentos_chat_center
       WHERE id_configuracion = ?
       ORDER BY id_departamento ASC
       LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT }
    );

    const id_departamento_asginado = dept?.[0]?.id_departamento ?? null;

    // 2) candidatos
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

    // 3-4) Elegir al conectado con la asignación más vieja (rotación real).
    // El puntero viejo ("el siguiente del último asignado") se reseteaba a
    // lista[0] cuando el último no estaba online, cargando de más al
    // sub-usuario de id más bajo — mismo sesgo medido en WhatsApp
    // (round_robin.js → elegirMenosReciente).
    const ultimas = await db.query(
      `SELECT he.id_encargado_nuevo AS enc, MAX(he.id) AS ult
         FROM historial_encargados_messenger he
         INNER JOIN messenger_conversations mc
           ON mc.id = he.id_messenger_conversation
        WHERE mc.id_configuracion = ?
          AND he.motivo IN ('auto_round_robin_messenger')
          AND he.id_encargado_nuevo IN (?)
        GROUP BY he.id_encargado_nuevo`,
      {
        replacements: [id_configuracion, lista],
        type: db.QueryTypes.SELECT,
      }
    );
    const ult = new Map(ultimas.map((r) => [Number(r.enc), Number(r.ult)]));
    let id_encargado_nuevo = lista[0];
    for (const id of lista) {
      if ((ult.get(id) || 0) < (ult.get(id_encargado_nuevo) || 0))
        id_encargado_nuevo = id;
    }

    return { id_encargado_nuevo, id_departamento_asginado };
  } finally {
    // liberar lock aunque no lo haya obtenido
    await db.query(`SELECT RELEASE_LOCK(?) AS released`, {
      replacements: [lockKey],
      type: db.QueryTypes.SELECT,
    });
  }
}

module.exports = { rrMessengerUnDepto };
