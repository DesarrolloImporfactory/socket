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

/* Elige, entre los CONECTADOS, al que lleva más tiempo sin recibir un chat
   del round robin (rotación real por antigüedad de última asignación).

   Reemplaza al puntero viejo ("el siguiente del último asignado"), que tenía
   un sesgo medido con datos reales: si el último asignado NO estaba online en
   ese momento, la elección se caía a lista[0] — el sub-usuario de id más
   bajo — en vez de continuar la rueda. En la cfg 666 eso pasó 285 veces en
   una semana (la asesora de id más bajo recibió 751 chats contra 254 de la
   última) y en la 242 el reparto quedó 12x entre el primero y el último.
   Con "gana el de asignación más vieja" el reparto queda parejo entre los
   que SÍ están conectados, sin importar cuántos parpadeos de presencia haya.

   Solo cuentan las asignaciones del propio round robin (motivo auto_%): las
   manuales no corren el turno de nadie. La ventana de 30 días acota el scan;
   quien no recibe nada hace más de 30 días cuenta como "nunca" y gana el
   siguiente turno — que es exactamente lo justo. */
async function elegirMenosReciente(id_configuracion, lista) {
  const ultimas = await db.query(
    `SELECT he.id_encargado_nuevo AS enc, MAX(he.id) AS ult
       FROM historial_encargados he
       INNER JOIN clientes_chat_center cc ON cc.id = he.id_cliente_chat_center
      WHERE cc.id_configuracion = ?
        AND (he.motivo = 'auto_round_robin' OR he.motivo LIKE 'auto_round_robin_%')
        AND he.id_encargado_nuevo IN (?)
        AND he.fecha_registro >= NOW() - INTERVAL 30 DAY
      GROUP BY he.id_encargado_nuevo`,
    { replacements: [id_configuracion, lista], type: db.QueryTypes.SELECT },
  );
  const ult = new Map(ultimas.map((r) => [Number(r.enc), Number(r.ult)]));
  let elegido = lista[0];
  for (const id of lista) {
    if ((ult.get(id) || 0) < (ult.get(elegido) || 0)) elegido = id;
  }
  return elegido;
}

/* Evidencia para las quejas de reparto: quiénes eran candidatos y a quiénes
   vio ONLINE la rueda en el momento exacto de asignar. Se guarda en la
   columna historial_encargados.candidatos_online (migración
   historial_encargados_candidatos_migration.sql); si la columna aún no
   existe, el INSERT clásico sigue funcionando igual que siempre. */
function textoCandidatos(listaOnline, listaAuto) {
  return `online:${listaOnline.join(',')} | auto:${listaAuto.join(',')}`.slice(
    0,
    255,
  );
}

async function insertarHistorial({
  id_cliente,
  id_departamento_asginado,
  id_encargado_nuevo,
  motivo,
  candidatos_online,
}) {
  try {
    await db.query(
      `INSERT INTO historial_encargados
         (id_cliente_chat_center, id_departamento_asginado, id_encargado_anterior, id_encargado_nuevo, motivo, candidatos_online)
       VALUES (?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_cliente,
          id_departamento_asginado,
          null,
          id_encargado_nuevo,
          motivo,
          candidatos_online,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (_) {
    // Columna candidatos_online aún no migrada → INSERT clásico.
    await db.query(
      `INSERT INTO historial_encargados
         (id_cliente_chat_center, id_departamento_asginado, id_encargado_anterior, id_encargado_nuevo, motivo)
       VALUES (?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_cliente,
          id_departamento_asginado,
          null,
          id_encargado_nuevo,
          motivo,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }
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
      console.log(
        '[clientes_chat_center INSERT] utils/webhook_whatsapp/round_robin.js ~L63 — rrDisabled, celular:',
        source === 'wa' ? phone_whatsapp_from : external_id,
        'id_configuracion:',
        id_configuracion,
      );
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
      console.log(
        '[clientes_chat_center INSERT] utils/webhook_whatsapp/round_robin.js ~L113 — sin departamento, celular:',
        source === 'wa' ? phone_whatsapp_from : external_id,
        'id_configuracion:',
        id_configuracion,
      );
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
      WHERE suc.id_usuario = ? AND sud.id_departamento = ? AND sud.asignacion_auto = 1
      AND suc.rol NOT IN ('administrador', 'super_administrador') ORDER BY suc.id_sub_usuario ASC;
      `,
      {
        replacements: [id_usuario_dueno, id_departamento_asginado],
        type: db.QueryTypes.SELECT,
      },
    );

    // listaAuto = todos los candidatos con asignacion_auto; lista = los que
    // además están conectados. Se guardan AMBAS en el historial: son la
    // evidencia de por qué un chat le tocó a quien le tocó.
    const listaAuto = encargados
      .map((x) => Number(x.id_sub_usuario))
      .filter(Boolean);

    console.log('lista encargados sin filtrar: ' + JSON.stringify(listaAuto));

    // ✅ Filtrar SOLO conectados
    let lista = listaAuto.filter((id) => {
      const p = presenceStore.getPresence(id); // { online, socket_count, ... }
      return p?.online === true; // (si quiere más estricto, también p.socket_count > 0)
    });

    console.log('lista encargados con filtrar: ' + JSON.stringify(lista));

    // Si no hay nadie, crear sin encargado
    if (!lista.length) {
      console.log(
        '[clientes_chat_center INSERT] utils/webhook_whatsapp/round_robin.js ~L174 — sin encargado online, celular:',
        source === 'wa' ? phone_whatsapp_from : external_id,
        'id_configuracion:',
        id_configuracion,
      );
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

    // 3-4) Elegir al conectado con la asignación más vieja. Reemplaza al
    // puntero "siguiente del último": ver elegirMenosReciente (el puntero
    // se reseteaba a lista[0] cuando el último asignado estaba offline y
    // cargaba de más al sub-usuario de id más bajo).
    const id_encargado_nuevo = await elegirMenosReciente(
      id_configuracion,
      lista,
    );

    // 5) Crear cliente con encargado
    console.log(
      '[clientes_chat_center INSERT] utils/webhook_whatsapp/round_robin.js ~L236 — con encargado RR, celular:',
      source === 'wa' ? phone_whatsapp_from : external_id,
      'id_configuracion:',
      id_configuracion,
      'encargado:',
      id_encargado_nuevo,
    );
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

    // 6) Guardar historial (cliente NUEVO => anterior NULL) + evidencia de
    // quiénes estaban online al momento de asignar.
    await insertarHistorial({
      id_cliente: cliente.id,
      id_departamento_asginado,
      id_encargado_nuevo,
      motivo,
      candidatos_online: textoCandidatos(lista, listaAuto),
    });

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

async function asignarRoundRobinClienteExistente({
  id_cliente,
  id_configuracion,
  id_usuario_dueno,
  permiso_round_robin,
  motivo = 'auto_round_robin_reopen',
}) {
  // Si no tiene permiso, no hacer nada
  const rrDisabled =
    permiso_round_robin === 0 ||
    permiso_round_robin === '0' ||
    permiso_round_robin === false;

  if (rrDisabled) {
    await ClientesChatCenter.update(
      { chat_cerrado: 0, id_encargado: null },
      { where: { id: id_cliente } },
    );
    await log(
      `⚠️ RR deshabilitado. Chat reabierto sin encargado (espera). id_cliente=${id_cliente}`,
    );
    return null;
  }

  const lockKey = `rr:${id_configuracion}`;

  const [lockRow] = await db.query(`SELECT GET_LOCK(?, 5) AS got`, {
    replacements: [lockKey],
    type: db.QueryTypes.SELECT,
  });

  if (!lockRow || Number(lockRow.got) !== 1) {
    await log(`⚠️ No se pudo obtener GET_LOCK para ${lockKey}.`);
  }

  try {
    // 1) Obtener departamento
    const dept = await db.query(
      `SELECT id_departamento FROM departamentos_chat_center
       WHERE id_configuracion = ? ORDER BY id_departamento ASC LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    const id_departamento_asginado = dept?.[0]?.id_departamento ?? null;

    if (!id_departamento_asginado) {
      await log(
        `⚠️ Sin departamento. No se asigna encargado. id_cliente=${id_cliente}`,
      );
      return null;
    }

    // 2) Candidatos online
    const encargados = await db.query(
      `SELECT suc.id_sub_usuario FROM sub_usuarios_chat_center suc 
       INNER JOIN sub_usuarios_departamento sud ON suc.id_sub_usuario = sud.id_sub_usuario 
       WHERE suc.id_usuario = ? AND sud.id_departamento = ? AND sud.asignacion_auto = 1
       AND suc.rol NOT IN ('administrador', 'super_administrador')
       ORDER BY suc.id_sub_usuario ASC`,
      {
        replacements: [id_usuario_dueno, id_departamento_asginado],
        type: db.QueryTypes.SELECT,
      },
    );

    const listaAuto = encargados
      .map((x) => Number(x.id_sub_usuario))
      .filter(Boolean);

    const lista = listaAuto.filter((id) => {
      const p = presenceStore.getPresence(id);
      return p?.online === true;
    });

    if (!lista.length) {
      // ← AGREGAR ESTO
      await ClientesChatCenter.update(
        { chat_cerrado: 0, id_encargado: null },
        { where: { id: id_cliente } },
      );
      await log(
        `⚠️ Sin encargados online al reabrir. id_cliente=${id_cliente} → reabierto sin encargado`,
      );
      return null;
    }

    // 3-4) Elegir al conectado con la asignación más vieja (ver
    // elegirMenosReciente: reemplaza al puntero, que se reseteaba a
    // lista[0] cuando el último asignado estaba offline).
    const id_encargado_nuevo = await elegirMenosReciente(
      id_configuracion,
      lista,
    );

    // 5) Update cliente existente
    await ClientesChatCenter.update(
      {
        chat_cerrado: 0,
        id_encargado: id_encargado_nuevo,
        id_departamento: id_departamento_asginado,
      },
      { where: { id: id_cliente } },
    );

    // 6) Guardar historial + evidencia de quiénes estaban online.
    await insertarHistorial({
      id_cliente,
      id_departamento_asginado,
      id_encargado_nuevo,
      motivo,
      candidatos_online: textoCandidatos(lista, listaAuto),
    });

    await log(
      `✅ RR reopen: id_cliente=${id_cliente} asignado a id_encargado=${id_encargado_nuevo}`,
    );
    return id_encargado_nuevo;
  } finally {
    await db.query(`SELECT RELEASE_LOCK(?) AS released`, {
      replacements: [lockKey],
      type: db.QueryTypes.SELECT,
    });
  }
}

module.exports = {
  crearClienteConRoundRobinUnDepto,
  asignarRoundRobinClienteExistente,
};
