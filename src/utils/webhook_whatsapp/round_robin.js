const fs = require('fs').promises;
const path = require('path');
const { db } = require('../../database/config');
const ClientesChatCenter = require('../../models/clientes_chat_center.model');

const presenceStore = require('../../sockets/presence/presenceStore');

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
    `[${new Date().toISOString()}] ${msg}\n`,
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

  // ✅ Unificación multi-canal
  source = 'wa', // 'wa' | 'ms' | 'ig'
  page_id = null, // ms/ig page id
  external_id = null, // ms/ig PSID/IGSID
  permiso_round_robin,
}) {
  const lockKey = `rr:${id_configuracion}`;

  // Lock para concurrencia
  const [lockRow] = await db.query(`SELECT GET_LOCK(?, 5) AS got`, {
    replacements: [lockKey],
    type: db.QueryTypes.SELECT,
  });

  if (!lockRow || Number(lockRow.got) !== 1) {
    await log(
      `⚠️ No se pudo obtener GET_LOCK para ${lockKey}. Continuando sin lock.`,
    );
  }

  try {
    // ✅ helper: interpreta 0, "0", false como deshabilitado
    const rrDisabled =
      permiso_round_robin === 0 ||
      permiso_round_robin === '0' ||
      permiso_round_robin === false;

    // ✅ Si NO tiene permiso, crear cliente SIN round robin, SIN historial
    if (rrDisabled) {
      const cliente = await ClientesChatCenter.create({
        id_configuracion,
        uid_cliente: business_phone_id,

        nombre_cliente,
        apellido_cliente,

        // WA usa celular_cliente, MS/IG queda null
        celular_cliente: source === 'wa' ? phone_whatsapp_from : null,

        // identidad del canal
        source,
        page_id: source === 'wa' ? null : String(page_id || null),
        external_id: source === 'wa' ? null : String(external_id || null),

        // ✅ SIN depto / SIN encargado
        id_departamento: null,
        id_encargado: null,

        ...metaClienteTimestamps,
      });

      await log(
        `✅ Cliente creado SIN RR (permiso_round_robin=0). id_cliente=${cliente.id}`,
      );

      return {
        cliente,
        id_encargado_nuevo: null,
        id_departamento_asginado: null,
        rr_aplicado: false,
      };
    }

    // 1) Obtener el único departamento de la configuración
    const dept = await db.query(
      `
      SELECT id_departamento
      FROM departamentos_chat_center
      WHERE id_configuracion = ?
      ORDER BY id_departamento ASC
      LIMIT 1
      `,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    const id_departamento_asginado = dept?.[0]?.id_departamento ?? null;

    // ✅ Si NO hay departamento, crear cliente SIN encargado y SIN historial (como rrDisabled)
    if (!id_departamento_asginado) {
      const cliente = await ClientesChatCenter.create({
        id_configuracion,
        uid_cliente: business_phone_id,

        nombre_cliente,
        apellido_cliente,

        celular_cliente: source === 'wa' ? phone_whatsapp_from : null,

        source,
        page_id: source === 'wa' ? null : String(page_id || null),
        external_id: source === 'wa' ? null : String(external_id || null),

        id_departamento: null,
        id_encargado: null,

        ...metaClienteTimestamps,
      });

      await log(
        `✅ Cliente creado SIN depto (id_departamento null) => SIN RR. id_cliente=${cliente.id}`,
      );

      return {
        cliente,
        id_encargado_nuevo: null,
        id_departamento_asginado: null,
        rr_aplicado: false,
      };
    }

    // 2) Candidatos (sub-usuarios del dueño) excluyendo admin/super_admin
    const encargados = await db.query(
      `
      SELECT suc.id_sub_usuario FROM sub_usuarios_chat_center suc 
      INNER JOIN sub_usuarios_departamento sud ON suc.id_sub_usuario = sud.id_sub_usuario 
      WHERE suc.id_usuario = ? AND sud.id_departamento = ? 
      AND suc.rol NOT IN ('administrador', 'super_administrador') ORDER BY suc.id_sub_usuario ASC;
      `,
      {
        replacements: [id_usuario_dueno, id_departamento_asginado],
        type: db.QueryTypes.SELECT,
      },
    );

    

    let lista = encargados.map((x) => Number(x.id_sub_usuario)).filter(Boolean);

    console.log("lista encargados sin filtrar: "+ JSON.stringify(lista));

    // ✅ Filtrar SOLO conectados
    const listaOnline = lista.filter((id) => {
      const p = presenceStore.getPresence(id); // { online, socket_count, ... }
      return p?.online === true; // (si quiere más estricto, también p.socket_count > 0)
    });

    lista = listaOnline;

    console.log("lista encargados con filtrar: "+ JSON.stringify(lista));

    // Si no hay nadie, crear sin encargado
    if (!lista.length) {
      const cliente = await ClientesChatCenter.create({
        id_configuracion,
        uid_cliente: business_phone_id,

        nombre_cliente,
        apellido_cliente,

        // WA usa celular_cliente, MS/IG queda null
        celular_cliente: source === 'wa' ? phone_whatsapp_from : null,

        // identidad del canal
        source,
        page_id: source === 'wa' ? null : String(page_id || null),
        external_id: source === 'wa' ? null : String(external_id || null),

        // ✅ GUARDAR DEPARTAMENTO
        id_departamento: id_departamento_asginado,

        id_encargado: null,
        ...metaClienteTimestamps,
      });

      await log(`✅ Cliente creado SIN encargado. id_cliente=${cliente.id}`);
      return { cliente, id_encargado_nuevo: null, id_departamento_asginado };
    }

    // 3) Obtener el último encargado asignado (puntero) — ✅ soporte multi motivo
    const last = await db.query(
      `
      SELECT he.id_encargado_nuevo
      FROM historial_encargados he
      INNER JOIN clientes_chat_center cc ON cc.id = he.id_cliente_chat_center
      WHERE cc.id_configuracion = ?
        AND (
          he.motivo = 'auto_round_robin'
          OR he.motivo LIKE 'auto_round_robin_%'
        )
      ORDER BY he.id DESC
      LIMIT 1
      `,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    const lastAssigned = last?.[0]?.id_encargado_nuevo
      ? Number(last[0].id_encargado_nuevo)
      : null;

    // 4) Elegir siguiente
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

      celular_cliente: source === 'wa' ? phone_whatsapp_from : null,

      source,
      page_id: source === 'wa' ? null : String(page_id || null),
      external_id: source === 'wa' ? null : String(external_id || null),

      // ✅ GUARDAR DEPARTAMENTO
      id_departamento: id_departamento_asginado,

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
          null,
          id_encargado_nuevo,
          motivo,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    await log(
      `✅ Cliente creado. id_cliente=${cliente.id} id_encargado=${id_encargado_nuevo} motivo=${motivo}`,
    );

    console.log(
      `✅ Cliente creado. id_cliente=${cliente.id} id_encargado=${id_encargado_nuevo} motivo=${motivo}`,
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
