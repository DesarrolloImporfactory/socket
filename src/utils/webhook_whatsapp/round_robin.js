const fs = require('fs').promises;
const path = require('path');
const { db } = require('../../database/config');
const ClientesChatCenter = require('../../models/clientes_chat_center.model');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (_) {}
}

async function log(msg) {
  await ensureDir(logsDir);
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] ${msg}\n`
  );
}

async function crearClienteConRoundRobinUnDepto({
  id_configuracion,
  business_phone_id,
  nombre_cliente,
  apellido_cliente,
  phone_whatsapp_from,
  metaClienteTimestamps = {},
  motivo = 'auto_round_robin',
  id_usuario_dueno, // configuracion.id_usuario
}) {
  const lockKey = `rr:${id_configuracion}`;

  // Lock para concurrencia
  const [lockRow] = await db.query(`SELECT GET_LOCK(?, 5) AS got`, {
    replacements: [lockKey],
    type: db.QueryTypes.SELECT,
  });

  if (!lockRow || Number(lockRow.got) !== 1) {
    await log(
      `⚠️ No se pudo obtener GET_LOCK para ${lockKey}. Continuando sin lock.`
    );
  }

  try {
    // 1) Obtener el único departamento de la configuración
    const dept = await db.query(
      `
      SELECT id_departamento
      FROM departamentos_chat_center
      WHERE id_configuracion = ?
      ORDER BY id_departamento ASC
      LIMIT 1
      `,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT }
    );

    const id_departamento_asginado = dept?.[0]?.id_departamento ?? null;

    // 2) Candidatos a asignar (sub-usuarios del dueño)
    const encargados = await db.query(
      `
  SELECT id_sub_usuario
  FROM sub_usuarios_chat_center
  WHERE id_usuario = ?
    AND rol NOT IN ('administrador', 'super_administrador')
  ORDER BY id_sub_usuario ASC
  `,
      { replacements: [id_usuario_dueno], type: db.QueryTypes.SELECT }
    );

    let lista = encargados.map((x) => Number(x.id_sub_usuario)).filter(Boolean);

    // Fallback: si no hay agentes, usar administrador
    if (!lista.length) {
      const admin = await db.query(
        `
        SELECT id_sub_usuario
        FROM sub_usuarios_chat_center
        WHERE id_usuario = ?
          AND rol = 'administrador'
        ORDER BY id_sub_usuario ASC
        LIMIT 1
        `,
        { replacements: [id_usuario_dueno], type: db.QueryTypes.SELECT }
      );

      const adminId = admin?.[0]?.id_sub_usuario
        ? Number(admin[0].id_sub_usuario)
        : null;

      lista = adminId ? [adminId] : [];
    }

    // Si no hay nadie, crear sin encargado
    if (!lista.length) {
      const cliente = await ClientesChatCenter.create({
        id_configuracion,
        uid_cliente: business_phone_id,
        nombre_cliente,
        apellido_cliente,
        celular_cliente: phone_whatsapp_from,
        id_encargado: null,
        ...metaClienteTimestamps,
      });

      await log(`✅ Cliente creado SIN encargado. id_cliente=${cliente.id}`);
      return { cliente, id_encargado_nuevo: null, id_departamento_asginado };
    }

    // 3) Obtener "puntero" round-robin: último encargado asignado (global por config+depto)
    const last = await db.query(
      `
      SELECT he.id_encargado_nuevo
  FROM historial_encargados he
  INNER JOIN clientes_chat_center cc ON cc.id = he.id_cliente_chat_center
  WHERE cc.id_configuracion = ?
    AND he.motivo = 'auto_round_robin'
  ORDER BY he.id DESC
  LIMIT 1
      `,
      {
        replacements: [id_configuracion, id_departamento_asginado],
        type: db.QueryTypes.SELECT,
      }
    );

    const lastAssigned = last?.[0]?.id_encargado_nuevo
      ? Number(last[0].id_encargado_nuevo)
      : null;

    // 4) Elegir siguiente (round-robin)
    let id_encargado_nuevo = null;

    if (!lastAssigned) {
      id_encargado_nuevo = lista[0];
    } else {
      const idx = lista.indexOf(lastAssigned);
      id_encargado_nuevo =
        idx === -1 ? lista[0] : lista[(idx + 1) % lista.length];
    }

    // 5) Crear cliente con encargado
    const cliente = await ClientesChatCenter.create({
      id_configuracion,
      uid_cliente: business_phone_id,
      nombre_cliente,
      apellido_cliente,
      celular_cliente: phone_whatsapp_from,
      id_encargado: id_encargado_nuevo,
      ...metaClienteTimestamps,
    });

    // 6) Guardar historial (cliente NUEVO => anterior NULL)
    await db.query(
      `
      INSERT INTO historial_encargados
        (id_cliente_chat_center, id_departamento_asginado, id_encargado_anterior, id_encargado_nuevo, motivo)
      VALUES
        (?, ?, ?, ?, ?)
      `,
      {
        replacements: [
          cliente.id,
          id_departamento_asginado,
          null, // ✅ primer movimiento del cliente
          id_encargado_nuevo,
          motivo,
        ],
        type: db.QueryTypes.INSERT,
      }
    );

    await log(
      `✅ Cliente creado. id_cliente=${cliente.id} id_encargado=${id_encargado_nuevo}`
    );

    console.log(
      `✅ Cliente creado. id_cliente=${cliente.id} id_encargado=${id_encargado_nuevo}`
    );

    return { cliente, id_encargado_nuevo, id_departamento_asginado };
  } finally {
    await db.query(`SELECT RELEASE_LOCK(?) AS released`, {
      replacements: [lockKey],
      type: db.QueryTypes.SELECT,
    });
  }
}

module.exports = { crearClienteConRoundRobinUnDepto };
