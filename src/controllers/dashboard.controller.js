const { db } = require('../database/config');

const DepartamentosChatCenter = require('../models/departamentos_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const Sub_usuarios_departamento = require('../models/sub_usuarios_departamento.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

const EtiquetaService = require('../services/etiqueta.service');
const catchAsync = require('../utils/catchAsync');

// ════════════════════════════════════════════════════════════════════════
// HELPER: Obtener IDs de configuraciones del usuario (se reutiliza en todo)
// ════════════════════════════════════════════════════════════════════════
async function getConfigIds(id_usuario, id_configuracion = null) {
  const where = id_configuracion
    ? 'WHERE id_usuario = ? AND suspendido = 0 AND id = ?'
    : 'WHERE id_usuario = ? AND suspendido = 0';
  const replacements = id_configuracion
    ? [id_usuario, id_configuracion]
    : [id_usuario];

  const rows = await db.query(`SELECT id FROM configuraciones ${where}`, {
    replacements,
    type: db.QueryTypes.SELECT,
  });
  return rows.map((r) => r.id);
}

// ════════════════════════════════════════════════════════════════════════
// Helper: placeholder seguro para IN (?)
// Si el array está vacío devuelve [0] para que el query no falle
// ════════════════════════════════════════════════════════════════════════
function safeIn(ids) {
  return ids.length ? ids : [0];
}

// ════════════════════════════════════════════════════════════════════════════
// 1) FILTROS DEL DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
exports.obtenerFiltrosDashboard = catchAsync(async (req, res) => {
  const { id_usuario, id_sub_usuario, incluir_etiquetas = 1 } = req.body;

  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }

  // ── Determinar rol (admin o no) ──────────────────────────────────────
  let esAdmin = true;

  if (id_sub_usuario) {
    const [subRow] = await db.query(
      `SELECT rol FROM sub_usuarios_chat_center
       WHERE id_sub_usuario = ? AND id_usuario = ? LIMIT 1`,
      {
        replacements: [id_sub_usuario, id_usuario],
        type: db.QueryTypes.SELECT,
      },
    );

    const rol = subRow?.rol || null;
    if (!rol) {
      return res.status(403).json({
        status: 'error',
        message: 'Subusuario inválido o no pertenece al usuario.',
      });
    }
    esAdmin = rol === 'administrador' || rol === 'super_administrador';
  }

  // ── Ejecutar en PARALELO: usuarios, conexiones, departamentos ────────
  const [usuarios, conexiones, deps] = await Promise.all([
    // Usuarios
    Sub_usuarios_chat_center.findAll({ where: { id_usuario } }).then((rows) =>
      (rows || []).map((u) => {
        const { password, admin_pass, ...safe } = u.toJSON();
        return safe;
      }),
    ),

    // Conexiones (query directa, ya optimizada)
    db.query(
      `SELECT
          c.id, c.id_plataforma, c.nombre_configuracion, c.telefono,
          c.id_telefono, c.id_whatsapp, c.webhook_url, c.metodo_pago,
          c.suspendido, c.tipo_configuracion, c.sincronizo_coexistencia,
          CASE WHEN COALESCE(c.id_telefono,'') <> '' AND COALESCE(c.id_whatsapp,'') <> '' THEN 1 ELSE 0 END AS conectado,
          EXISTS (SELECT 1 FROM messenger_pages mp WHERE mp.id_configuracion = c.id AND mp.subscribed = 1 AND mp.status = 'active') AS messenger_conectado,
          (SELECT mp.page_name FROM messenger_pages mp WHERE mp.id_configuracion = c.id AND mp.subscribed = 1 AND mp.status = 'active' ORDER BY mp.id_messenger_page DESC LIMIT 1) AS messenger_page_name,
          (SELECT mp.page_id   FROM messenger_pages mp WHERE mp.id_configuracion = c.id AND mp.subscribed = 1 AND mp.status = 'active' ORDER BY mp.id_messenger_page DESC LIMIT 1) AS messenger_page_id,
          EXISTS (SELECT 1 FROM instagram_pages ip WHERE ip.id_configuracion = c.id AND ip.subscribed = 1 AND ip.status = 'active') AS instagram_conectado,
          EXISTS (SELECT 1 FROM tiktok_devs_connections tdc WHERE tdc.id_configuracion = c.id) AS tiktok_conectado
        FROM configuraciones c
        WHERE c.id_usuario = ? AND c.suspendido = 0
          AND (? = 1 OR EXISTS (
            SELECT 1 FROM departamentos_chat_center dcc
            INNER JOIN sub_usuarios_departamento sud ON sud.id_departamento = dcc.id_departamento
            WHERE dcc.id_configuracion = c.id AND sud.id_sub_usuario = ?
          ))
        ORDER BY c.id DESC`,
      {
        replacements: [id_usuario, esAdmin ? 1 : 0, id_sub_usuario || 0],
        type: db.QueryTypes.SELECT,
      },
    ),

    // Departamentos con includes
    DepartamentosChatCenter.findAll({
      where: { id_usuario },
      include: [
        {
          model: Configuraciones,
          as: 'configuracion',
          attributes: ['nombre_configuracion', 'id', 'permiso_round_robin'],
          required: false,
        },
      ],
    }),
  ]);

  // ── Departamentos: agregar usuarios asignados en paralelo ────────────
  const departamentos = await Promise.all(
    (deps || []).map(async (dep) => {
      const asignaciones = await Sub_usuarios_departamento.findAll({
        where: { id_departamento: dep.id_departamento },
        attributes: ['id_sub_usuario', 'asignacion_auto'],
        raw: true,
      });
      const depJson = dep.toJSON();
      return {
        ...depJson,
        nombre_configuracion:
          depJson.configuracion?.nombre_configuracion ?? null,
        permiso_round_robin: Number(depJson.configuracion?.permiso_round_robin)
          ? 1
          : 0,
        usuarios_asignados: (asignaciones || []).map((a) => ({
          id_sub_usuario: Number(a.id_sub_usuario),
          asignacion_auto: Number(a.asignacion_auto) ? 1 : 0,
        })),
      };
    }),
  );

  // ── Etiquetas (si se piden) ──────────────────────────────────────────
  let etiquetas_por_configuracion = {};
  if (Number(incluir_etiquetas) === 1) {
    const idsConfig = (conexiones || [])
      .map((c) => Number(c.id))
      .filter(Boolean);

    // Batch con Promise.all en lugar de secuencial
    const etiquetasArr = await Promise.all(
      idsConfig.map(async (id_configuracion) => {
        try {
          const etiquetas =
            await EtiquetaService.obtenerEtiquetas(id_configuracion);
          return { id_configuracion, etiquetas: etiquetas || [] };
        } catch {
          return { id_configuracion, etiquetas: [] };
        }
      }),
    );
    etiquetas_por_configuracion = etiquetasArr.reduce((acc, it) => {
      acc[it.id_configuracion] = it.etiquetas;
      return acc;
    }, {});
  }

  return res.status(200).json({
    status: 'success',
    data: {
      departamentos,
      usuarios,
      conexiones,
      etiquetas_por_configuracion,
      motivos: [],
    },
  });
});

// ESTRATEGIA:
//   1. Obtener IDs de configs (1 query liviana)
//   2. Ejecutar TODAS las secciones en PARALELO con Promise.all
//   3. Cada query usa IN (config_ids) + índices compuestos
//   4. NO se usa transacción (solo lectura, no hay estado mutable)
//   5. Las sub-consultas correlacionadas se limitan con índices

const CHANNEL_MAP = {
  wa: 'WhatsApp',
  ig: 'Instagram',
  ms: 'Messenger',
};
function mapChannel(s) {
  return CHANNEL_MAP[s] || s || '—';
}

exports.obtenerDashboardCompleto = catchAsync(async (req, res) => {
  const { id_usuario, id_configuracion = null, from, to } = req.body;

  if (!id_usuario || !from || !to) {
    return res.status(400).json({
      status: 'error',
      message: 'Faltan parámetros requeridos: id_usuario, from, to',
    });
  }

  const fromDT = `${from} 00:00:00`;
  const toDT = `${to} 23:59:59`;

  // ── Paso 1: Config IDs (muy rápido, PK) ─────────────────────────────
  const configIds = await getConfigIds(id_usuario, id_configuracion);

  if (!configIds.length) {
    return res.json({
      status: 'success',
      data: {
        summary: {
          chatsCreated: 0,
          chatsResolved: 0,
          withReplies: 0,
          noReply: 0,
          avgFirstResponseSeconds: null,
          avgResolutionSeconds: null,
        },
        pendingQueue: [],
        slaToday: {
          generalPct: 0,
          metaPct: 0,
          channels: [],
          resolvedToday: 0,
          abandoned: 0,
        },
        charts: {
          byChannel: [],
          byConnection: [],
          chatsCreated: [],
          chatsResolved: [],
          firstResponse: [],
          resolution: [],
        },
        agentLoad: [],
        frequentTransfers: [],
        meta: {
          from,
          to,
          id_configuracion: id_configuracion || null,
          executedAt: new Date().toISOString(),
        },
      },
    });
  }

  const ids = safeIn(configIds);

  // ── Paso 2: Ejecutar TODAS las secciones en paralelo ─────────────────
  const [
    summaryResults,
    pendingQueue,
    slaResults,
    chartsResults,
    agentLoadResults,
    frequentTransfers,
  ] = await Promise.all([
    // ═══ SECCION 1: SUMMARY ═══
    buildSummary(ids, fromDT, toDT),

    // ═══ SECCION 2: PENDING QUEUE ═══
    buildPendingQueue(ids, fromDT, toDT),

    // ═══ SECCION 3: SLA ═══
    buildSLA(ids, fromDT, toDT),

    // ═══ SECCION 4: CHARTS ═══
    buildCharts(ids, fromDT, toDT),

    // ═══ SECCION 5: AGENT LOAD ═══
    buildAgentLoad(ids, id_usuario, fromDT, toDT),

    // ═══ SECCION 6: FREQUENT TRANSFERS ═══
    buildFrequentTransfers(ids, fromDT, toDT),
  ]);

  return res.json({
    status: 'success',
    data: {
      summary: summaryResults,
      pendingQueue,
      slaToday: slaResults,
      charts: chartsResults,
      agentLoad: agentLoadResults,
      frequentTransfers,
      meta: {
        from,
        to,
        id_configuracion: id_configuracion || null,
        executedAt: new Date().toISOString(),
      },
    },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECCION 1: SUMMARY
// ════════════════════════════════════════════════════════════════════════════
// Una sola query con sub-selects condicionales.
// Evita las 4 queries separadas del controller original.
// ════════════════════════════════════════════════════════════════════════════
async function buildSummary(configIds, fromDT, toDT) {
  // 1a + 1b + 1c en paralelo con queries independientes
  const [chatsCreatedRow, chatsResolvedRow, repliesAgg, resolutionAgg] =
    await Promise.all([
      // Chats creados en el rango
      db.query(
        `SELECT COUNT(*) AS total
         FROM (
           SELECT mc.celular_recibe
           FROM mensajes_clientes mc
           INNER JOIN clientes_chat_center ccc
             ON ccc.id_configuracion = mc.id_configuracion AND ccc.id = mc.celular_recibe
           WHERE mc.id_configuracion IN (?)
             AND mc.deleted_at IS NULL
             AND mc.rol_mensaje = 0
             AND mc.created_at BETWEEN ? AND ?
             AND ccc.deleted_at IS NULL
             AND ccc.propietario = 0
           GROUP BY mc.id_configuracion, mc.celular_recibe
         ) sub`,
        { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
      ),

      // Chats resueltos en el rango
      db.query(
        `SELECT COUNT(*) AS total
         FROM clientes_chat_center ccc
         WHERE ccc.id_configuracion IN (?)
           AND ccc.deleted_at IS NULL
           AND ccc.propietario = 0
           AND ccc.chat_cerrado = 1
           AND ccc.chat_cerrado_at BETWEEN ? AND ?`,
        { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
      ),

      // Con/sin respuesta + avg primera respuesta
      // Usa CTE para el primer entrante y luego busca primera respuesta via índice
      db.query(
        `SELECT
           SUM(CASE WHEN first_resp_at IS NOT NULL THEN 1 ELSE 0 END) AS withReplies,
           SUM(CASE WHEN first_resp_at IS NULL     THEN 1 ELSE 0 END) AS noReply,
           ROUND(AVG(
             CASE WHEN first_resp_at IS NOT NULL
               THEN TIMESTAMPDIFF(SECOND, first_in_at, first_resp_at)
             END
           )) AS avgFirstResponseSeconds
         FROM (
           SELECT
             pe.id_configuracion,
             pe.client_ccc_id,
             pe.first_in_at,
             (SELECT MIN(mo.created_at)
              FROM mensajes_clientes mo
              WHERE mo.id_configuracion = pe.id_configuracion
                AND mo.celular_recibe   = pe.client_ccc_id
                AND mo.rol_mensaje      = 1
                AND mo.deleted_at IS NULL
                AND mo.created_at > pe.first_in_at
                AND mo.created_at <= ?
              LIMIT 1
             ) AS first_resp_at
           FROM (
             SELECT mc.id_configuracion,
                    mc.celular_recibe AS client_ccc_id,
                    MIN(mc.created_at) AS first_in_at
             FROM mensajes_clientes mc
             WHERE mc.id_configuracion IN (?)
               AND mc.deleted_at IS NULL
               AND mc.rol_mensaje = 0
               AND mc.created_at BETWEEN ? AND ?
             GROUP BY mc.id_configuracion, mc.celular_recibe
           ) pe
           INNER JOIN clientes_chat_center ccc
             ON ccc.id_configuracion = pe.id_configuracion
             AND ccc.id = pe.client_ccc_id
             AND ccc.deleted_at IS NULL
             AND ccc.propietario = 0
         ) analysis`,
        {
          replacements: [toDT, configIds, fromDT, toDT],
          type: db.QueryTypes.SELECT,
        },
      ),

      // Avg tiempo de resolución
      db.query(
        `SELECT ROUND(AVG(
           TIMESTAMPDIFF(SECOND, first_in.first_in_at, ccc.chat_cerrado_at)
         )) AS avgResolutionSeconds
         FROM clientes_chat_center ccc
         INNER JOIN (
           SELECT id_configuracion,
                  celular_recibe AS client_ccc_id,
                  MIN(created_at) AS first_in_at
           FROM mensajes_clientes
           WHERE id_configuracion IN (?)
             AND deleted_at IS NULL
             AND rol_mensaje = 0
           GROUP BY id_configuracion, celular_recibe
         ) first_in
           ON first_in.id_configuracion = ccc.id_configuracion
           AND first_in.client_ccc_id = ccc.id
         WHERE ccc.id_configuracion IN (?)
           AND ccc.deleted_at IS NULL
           AND ccc.propietario = 0
           AND ccc.chat_cerrado = 1
           AND ccc.chat_cerrado_at BETWEEN ? AND ?`,
        {
          replacements: [configIds, configIds, fromDT, toDT],
          type: db.QueryTypes.SELECT,
        },
      ),
    ]);

  return {
    chatsCreated: Number(chatsCreatedRow?.[0]?.total || 0),
    chatsResolved: Number(chatsResolvedRow?.[0]?.total || 0),
    withReplies: Number(repliesAgg?.[0]?.withReplies || 0),
    noReply: Number(repliesAgg?.[0]?.noReply || 0),
    avgFirstResponseSeconds:
      repliesAgg?.[0]?.avgFirstResponseSeconds != null
        ? Number(repliesAgg[0].avgFirstResponseSeconds)
        : null,
    avgResolutionSeconds:
      resolutionAgg?.[0]?.avgResolutionSeconds != null
        ? Number(resolutionAgg[0].avgResolutionSeconds)
        : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SECCION 2: PENDING QUEUE
// ════════════════════════════════════════════════════════════════════════════
// Clientes con chat abierto cuyo último mensaje entrante NO tiene
// respuesta posterior. Usa LEFT JOIN anti-pattern en vez de NOT EXISTS.
// ════════════════════════════════════════════════════════════════════════════
async function buildPendingQueue(configIds, fromDT, toDT) {
  const rows = await db.query(
    `SELECT
       ccc.id,
       ccc.nombre_cliente,
       ccc.apellido_cliente,
       ccc.source,
       ccc.estado_contacto,
       ccc.celular_cliente,
       ccc.id_encargado,
       ccc.id_configuracion,
       su.nombre_encargado AS responsable,
       ultimo_in.ultima_entrada_at,
       TIMESTAMPDIFF(SECOND, ultimo_in.ultima_entrada_at, NOW()) AS waitSeconds
     FROM clientes_chat_center ccc
     INNER JOIN (
       SELECT mc.id_configuracion,
              mc.celular_recibe AS client_ccc_id,
              MAX(mc.created_at) AS ultima_entrada_at
       FROM mensajes_clientes mc
       WHERE mc.id_configuracion IN (?)
         AND mc.deleted_at IS NULL
         AND mc.rol_mensaje = 0
       GROUP BY mc.id_configuracion, mc.celular_recibe
     ) ultimo_in
       ON ultimo_in.id_configuracion = ccc.id_configuracion
       AND ultimo_in.client_ccc_id = ccc.id
     LEFT JOIN (
       SELECT mc2.id_configuracion,
              mc2.celular_recibe AS client_ccc_id,
              MAX(mc2.created_at) AS ultima_salida_at
       FROM mensajes_clientes mc2
       WHERE mc2.id_configuracion IN (?)
         AND mc2.deleted_at IS NULL
         AND mc2.rol_mensaje = 1
       GROUP BY mc2.id_configuracion, mc2.celular_recibe
     ) ultimo_out
       ON ultimo_out.id_configuracion = ccc.id_configuracion
       AND ultimo_out.client_ccc_id = ccc.id
     LEFT JOIN sub_usuarios_chat_center su
       ON su.id_sub_usuario = ccc.id_encargado
     WHERE ccc.id_configuracion IN (?)
       AND ccc.deleted_at IS NULL
       AND ccc.propietario = 0
       AND ccc.chat_cerrado = 0
       AND ultimo_in.ultima_entrada_at BETWEEN ? AND ?
       AND (ultimo_out.ultima_salida_at IS NULL OR ultimo_out.ultima_salida_at < ultimo_in.ultima_entrada_at)
     ORDER BY ultimo_in.ultima_entrada_at ASC
     LIMIT 50`,
    {
      replacements: [configIds, configIds, configIds, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  return rows.map((r) => {
    const wait = Number(r.waitSeconds || 0);
    let priority = 'Baja';
    if (wait >= 600) priority = 'Alta';
    else if (wait >= 300) priority = 'Media';

    const fullName =
      `${(r.nombre_cliente || '').trim()} ${(r.apellido_cliente || '').trim()}`.trim();
    return {
      priority,
      id: `${r.id}`,
      client: fullName || 'Cliente sin nombre',
      channel: mapChannel(r.source),
      waitSeconds: wait,
      estado_contacto: r.estado_contacto || '—',
      celular_cliente: r.celular_cliente || '—',
      responsable: r.responsable || 'Sin asignar',
      id_configuracion: r.id_configuracion,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SECCION 3: SLA
// ════════════════════════════════════════════════════════════════════════════
async function buildSLA(configIds, fromDT, toDT) {
  const ABANDON_HOURS = Number(process.env.SLA_ABANDON_HOURS || 2);

  const [resolvedByChannel, abandonedByChannel] = await Promise.all([
    db.query(
      `SELECT ccc.source, COUNT(*) AS total
       FROM clientes_chat_center ccc
       WHERE ccc.id_configuracion IN (?)
         AND ccc.deleted_at IS NULL
         AND ccc.propietario = 0
         AND ccc.chat_cerrado = 1
         AND ccc.chat_cerrado_at BETWEEN ? AND ?
       GROUP BY ccc.source`,
      { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
    ),

    db.query(
      `SELECT ccc.source, COUNT(*) AS total
       FROM clientes_chat_center ccc
       INNER JOIN (
         SELECT mc.id_configuracion,
                mc.celular_recibe AS client_ccc_id,
                MAX(mc.created_at) AS ultima_entrada_at
         FROM mensajes_clientes mc
         WHERE mc.id_configuracion IN (?)
           AND mc.deleted_at IS NULL
           AND mc.rol_mensaje = 0
         GROUP BY mc.id_configuracion, mc.celular_recibe
       ) ultimo_in
         ON ultimo_in.id_configuracion = ccc.id_configuracion
         AND ultimo_in.client_ccc_id = ccc.id
       LEFT JOIN (
         SELECT mc2.id_configuracion,
                mc2.celular_recibe AS client_ccc_id,
                MAX(mc2.created_at) AS ultima_salida_at
         FROM mensajes_clientes mc2
         WHERE mc2.id_configuracion IN (?)
           AND mc2.deleted_at IS NULL
           AND mc2.rol_mensaje = 1
         GROUP BY mc2.id_configuracion, mc2.celular_recibe
       ) ultimo_out
         ON ultimo_out.id_configuracion = ccc.id_configuracion
         AND ultimo_out.client_ccc_id = ccc.id
       WHERE ccc.id_configuracion IN (?)
         AND ccc.deleted_at IS NULL
         AND ccc.propietario = 0
         AND ccc.chat_cerrado = 0
         AND ultimo_in.ultima_entrada_at BETWEEN ? AND ?
         AND TIMESTAMPDIFF(HOUR, ultimo_in.ultima_entrada_at, NOW()) >= ?
         AND (ultimo_out.ultima_salida_at IS NULL OR ultimo_out.ultima_salida_at < ultimo_in.ultima_entrada_at)
       GROUP BY ccc.source`,
      {
        replacements: [
          configIds,
          configIds,
          configIds,
          fromDT,
          toDT,
          ABANDON_HOURS,
        ],
        type: db.QueryTypes.SELECT,
      },
    ),
  ]);

  const resolvedMap = new Map(
    resolvedByChannel.map((r) => [r.source, Number(r.total)]),
  );
  const abandonedMap = new Map(
    abandonedByChannel.map((r) => [r.source, Number(r.total)]),
  );

  const sources = ['wa', 'ms', 'ig'];
  const channels = sources.map((s) => {
    const resolved = resolvedMap.get(s) || 0;
    const aband = abandonedMap.get(s) || 0;
    const d = resolved + aband;
    return {
      name: mapChannel(s),
      pct: d ? Math.round((resolved / d) * 1000) / 10 : 0,
    };
  });

  const resolvedToday = sources.reduce(
    (a, s) => a + (resolvedMap.get(s) || 0),
    0,
  );
  const abandonedTotal = sources.reduce(
    (a, s) => a + (abandonedMap.get(s) || 0),
    0,
  );
  const denom = resolvedToday + abandonedTotal;

  return {
    generalPct: denom ? Math.round((resolvedToday / denom) * 1000) / 10 : 0,
    metaPct: denom ? Math.round((resolvedToday / denom) * 1000) / 10 : 0,
    channels,
    resolvedToday,
    abandoned: abandonedTotal,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SECCION 4: CHARTS
// ════════════════════════════════════════════════════════════════════════════
async function buildCharts(configIds, fromDT, toDT) {
  const [
    byChannel,
    byConnection,
    chatsCreated,
    chatsResolved,
    firstResponse,
    resolution,
  ] = await Promise.all([
    // Por canal
    db.query(
      `SELECT UPPER(COALESCE(ccc.source, 'OTHER')) AS name, COUNT(*) AS value
         FROM mensajes_clientes mc
         INNER JOIN clientes_chat_center ccc
           ON ccc.id_configuracion = mc.id_configuracion AND ccc.id = mc.celular_recibe
         WHERE mc.id_configuracion IN (?)
           AND mc.deleted_at IS NULL
           AND mc.rol_mensaje = 0
           AND mc.created_at BETWEEN ? AND ?
           AND ccc.deleted_at IS NULL
           AND ccc.propietario = 0
         GROUP BY ccc.source ORDER BY value DESC`,
      { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
    ),

    // Por conexión
    db.query(
      `SELECT cfg.nombre_configuracion AS name, COUNT(*) AS value
         FROM mensajes_clientes mc
         INNER JOIN configuraciones cfg ON cfg.id = mc.id_configuracion
         INNER JOIN clientes_chat_center ccc
           ON ccc.id_configuracion = mc.id_configuracion AND ccc.id = mc.celular_recibe
         WHERE mc.id_configuracion IN (?)
           AND mc.deleted_at IS NULL
           AND mc.rol_mensaje = 0
           AND mc.created_at BETWEEN ? AND ?
           AND ccc.deleted_at IS NULL
           AND ccc.propietario = 0
         GROUP BY cfg.id, cfg.nombre_configuracion ORDER BY value DESC`,
      { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
    ),

    // Chats creados por hora
    db.query(
      `SELECT DATE_FORMAT(first_in_at, '%H:00') AS hour, COUNT(*) AS chats
         FROM (
           SELECT MIN(mc.created_at) AS first_in_at
           FROM mensajes_clientes mc
           INNER JOIN clientes_chat_center ccc
             ON ccc.id_configuracion = mc.id_configuracion AND ccc.id = mc.celular_recibe
           WHERE mc.id_configuracion IN (?)
             AND mc.deleted_at IS NULL
             AND mc.rol_mensaje = 0
             AND mc.created_at BETWEEN ? AND ?
             AND ccc.deleted_at IS NULL
             AND ccc.propietario = 0
           GROUP BY mc.id_configuracion, mc.celular_recibe
         ) sub
         GROUP BY hour ORDER BY hour ASC`,
      { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
    ),

    // Chats resueltos por hora
    db.query(
      `SELECT DATE_FORMAT(ccc.chat_cerrado_at, '%H:00') AS hour, COUNT(*) AS resolved
         FROM clientes_chat_center ccc
         WHERE ccc.id_configuracion IN (?)
           AND ccc.deleted_at IS NULL
           AND ccc.propietario = 0
           AND ccc.chat_cerrado = 1
           AND ccc.chat_cerrado_at BETWEEN ? AND ?
         GROUP BY hour ORDER BY hour ASC`,
      { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
    ),

    // Primera respuesta por hora
    db.query(
      `SELECT
           DATE_FORMAT(pe.first_in_at, '%H:00') AS hour,
           AVG(TIMESTAMPDIFF(SECOND, pe.first_in_at, pe.first_resp_at)) AS avgSeconds,
           COUNT(*) AS chats
         FROM (
           SELECT
             sub.first_in_at,
             (SELECT MIN(mo.created_at)
              FROM mensajes_clientes mo
              WHERE mo.id_configuracion = sub.id_configuracion
                AND mo.celular_recibe   = sub.client_ccc_id
                AND mo.rol_mensaje      = 1
                AND mo.deleted_at IS NULL
                AND mo.created_at > sub.first_in_at
              LIMIT 1
             ) AS first_resp_at,
             sub.id_configuracion,
             sub.client_ccc_id
           FROM (
             SELECT mc.id_configuracion,
                    mc.celular_recibe AS client_ccc_id,
                    MIN(mc.created_at) AS first_in_at
             FROM mensajes_clientes mc
             INNER JOIN clientes_chat_center ccc
               ON ccc.id_configuracion = mc.id_configuracion AND ccc.id = mc.celular_recibe
             WHERE mc.id_configuracion IN (?)
               AND mc.deleted_at IS NULL
               AND mc.rol_mensaje = 0
               AND mc.created_at BETWEEN ? AND ?
               AND ccc.deleted_at IS NULL
               AND ccc.propietario = 0
             GROUP BY mc.id_configuracion, mc.celular_recibe
           ) sub
         ) pe
         WHERE pe.first_resp_at IS NOT NULL
         GROUP BY hour ORDER BY hour ASC`,
      { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
    ),

    // Resolución por hora
    db.query(
      `SELECT
           DATE_FORMAT(ccc.chat_cerrado_at, '%H:00') AS hour,
           AVG(TIMESTAMPDIFF(SECOND, first_in.first_in_at, ccc.chat_cerrado_at)) AS avgSeconds,
           COUNT(*) AS chats
         FROM clientes_chat_center ccc
         INNER JOIN (
           SELECT id_configuracion,
                  celular_recibe AS client_ccc_id,
                  MIN(created_at) AS first_in_at
           FROM mensajes_clientes
           WHERE id_configuracion IN (?)
             AND deleted_at IS NULL
             AND rol_mensaje = 0
           GROUP BY id_configuracion, celular_recibe
         ) first_in
           ON first_in.id_configuracion = ccc.id_configuracion
           AND first_in.client_ccc_id = ccc.id
         WHERE ccc.id_configuracion IN (?)
           AND ccc.deleted_at IS NULL
           AND ccc.propietario = 0
           AND ccc.chat_cerrado = 1
           AND ccc.chat_cerrado_at BETWEEN ? AND ?
         GROUP BY hour ORDER BY hour ASC`,
      {
        replacements: [configIds, configIds, fromDT, toDT],
        type: db.QueryTypes.SELECT,
      },
    ),
  ]);

  return {
    byChannel,
    byConnection,
    chatsCreated: chatsCreated.map((r) => ({
      hour: r.hour,
      chats: Number(r.chats || 0),
    })),
    chatsResolved: chatsResolved.map((r) => ({
      hour: r.hour,
      resolved: Number(r.resolved || 0),
    })),
    firstResponse: firstResponse.map((r) => ({
      hour: r.hour,
      avgSeconds:
        r.avgSeconds === null ? null : Math.round(Number(r.avgSeconds)),
      chats: Number(r.chats || 0),
    })),
    resolution: resolution.map((r) => ({
      hour: r.hour,
      avgSeconds:
        r.avgSeconds === null ? null : Math.round(Number(r.avgSeconds)),
      chats: Number(r.chats || 0),
    })),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SECCION 5: AGENT LOAD
// ════════════════════════════════════════════════════════════════════════════
async function buildAgentLoad(configIds, id_usuario, fromDT, toDT) {
  const [agentLoadHistorico, agentLoadActual] = await Promise.all([
    // Chats asignados en el rango (via historial_encargados)
    db.query(
      `SELECT
         su.id_sub_usuario,
         su.nombre_encargado,
         COUNT(DISTINCT h.id_cliente_chat_center) AS total_chats
       FROM sub_usuarios_chat_center su
       LEFT JOIN (
         SELECT h2.id_encargado_nuevo, h2.id_cliente_chat_center
         FROM historial_encargados h2
         INNER JOIN clientes_chat_center ccc2
           ON ccc2.id = h2.id_cliente_chat_center
         WHERE ccc2.id_configuracion IN (?)
           AND h2.fecha_registro BETWEEN ? AND ?
           AND ccc2.deleted_at IS NULL
           AND ccc2.propietario = 0
       ) h ON h.id_encargado_nuevo = su.id_sub_usuario
       WHERE su.id_usuario = ?
       GROUP BY su.id_sub_usuario, su.nombre_encargado
       ORDER BY total_chats DESC`,
      {
        replacements: [configIds, fromDT, toDT, id_usuario],
        type: db.QueryTypes.SELECT,
      },
    ),

    // Chats abiertos ahora mismo
    db.query(
      `SELECT
         su.id_sub_usuario,
         COUNT(DISTINCT ccc.id) AS chats_abiertos_ahora
       FROM sub_usuarios_chat_center su
       LEFT JOIN clientes_chat_center ccc
         ON ccc.id_encargado = su.id_sub_usuario
         AND ccc.id_configuracion IN (?)
         AND ccc.chat_cerrado = 0
         AND ccc.deleted_at IS NULL
         AND ccc.propietario = 0
       WHERE su.id_usuario = ?
       GROUP BY su.id_sub_usuario`,
      { replacements: [configIds, id_usuario], type: db.QueryTypes.SELECT },
    ),
  ]);

  const actualMap = new Map(
    agentLoadActual.map((r) => [
      r.id_sub_usuario,
      Number(r.chats_abiertos_ahora || 0),
    ]),
  );

  return agentLoadHistorico.map((r) => ({
    id_sub_usuario: r.id_sub_usuario,
    nombre_encargado: r.nombre_encargado,
    total_chats: Number(r.total_chats || 0),
    chats_abiertos_ahora: actualMap.get(r.id_sub_usuario) || 0,
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// SECCION 6: FREQUENT TRANSFERS
// ════════════════════════════════════════════════════════════════════════════
async function buildFrequentTransfers(configIds, fromDT, toDT) {
  const rows = await db.query(
    `SELECT
       h.id_cliente_chat_center,
       ccc.nombre_cliente,
       ccc.apellido_cliente,
       ccc.celular_cliente,
       ccc.source,
       ccc.id_configuracion,
       COUNT(h.id) AS total_transferencias,
       su_actual.nombre_encargado AS responsable_actual
     FROM historial_encargados h
     INNER JOIN clientes_chat_center ccc ON ccc.id = h.id_cliente_chat_center
     LEFT JOIN sub_usuarios_chat_center su_actual ON su_actual.id_sub_usuario = ccc.id_encargado
     WHERE ccc.id_configuracion IN (?)
       AND ccc.deleted_at IS NULL
       AND h.fecha_registro BETWEEN ? AND ?
     GROUP BY h.id_cliente_chat_center, ccc.nombre_cliente, ccc.apellido_cliente,
              ccc.celular_cliente, ccc.source, ccc.id_configuracion, su_actual.nombre_encargado
     HAVING total_transferencias >= 3
     ORDER BY total_transferencias DESC
     LIMIT 30`,
    { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
  );

  return rows.map((r) => {
    const fullName =
      `${(r.nombre_cliente || '').trim()} ${(r.apellido_cliente || '').trim()}`.trim();
    return {
      id: `${r.id_cliente_chat_center}`,
      client: fullName || 'Cliente sin nombre',
      telefono: r.celular_cliente || '—',
      channel: mapChannel(r.source),
      totalTransferencias: Number(r.total_transferencias),
      responsableActual: r.responsable_actual || 'Sin asignar',
      id_configuracion: r.id_configuracion,
    };
  });
}
