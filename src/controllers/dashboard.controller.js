const { db } = require('../database/config');

const DepartamentosChatCenter = require('../models/departamentos_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const Sub_usuarios_departamento = require('../models/sub_usuarios_departamento.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

// Service de etiquetas
const EtiquetaService = require('../services/etiqueta.service');

const catchAsync = require('../utils/catchAsync');

exports.obtenerFiltrosDashboard = catchAsync(async (req, res) => {
  const { id_usuario, id_sub_usuario, incluir_etiquetas = 1 } = req.body;

  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }

  const subUsuarios = await Sub_usuarios_chat_center.findAll({
    where: { id_usuario },
  });

  const usuarios = (subUsuarios || []).map((u) => {
    const { password, admin_pass, ...safe } = u.toJSON();
    return safe;
  });

  let esAdmin = true;

  if (id_sub_usuario) {
    const subRow = await db.query(
      `SELECT rol FROM sub_usuarios_chat_center
       WHERE id_sub_usuario = ? AND id_usuario = ? LIMIT 1`,
      {
        replacements: [id_sub_usuario, id_usuario],
        type: db.QueryTypes.SELECT,
      },
    );

    const rol = subRow?.[0]?.rol || null;
    if (!rol) {
      return res.status(403).json({
        status: 'error',
        message: 'Subusuario inválido o no pertenece al usuario.',
      });
    }
    esAdmin = rol === 'administrador' || rol === 'super_administrador';
  }

  const [conexiones] = await db.query(
    `SELECT
      c.id, c.id_plataforma, c.nombre_configuracion, c.telefono,
      c.id_telefono, c.id_whatsapp, c.webhook_url, c.metodo_pago,
      c.suspendido, c.tipo_configuracion, c.sincronizo_coexistencia,
      CASE WHEN COALESCE(c.id_telefono,'') <> '' AND COALESCE(c.id_whatsapp,'') <> '' THEN 1 ELSE 0 END AS conectado,
      EXISTS (SELECT 1 FROM messenger_pages mp WHERE mp.id_configuracion = c.id AND mp.subscribed = 1 AND mp.status = 'active') AS messenger_conectado,
      (SELECT mp.page_name FROM messenger_pages mp WHERE mp.id_configuracion = c.id AND mp.subscribed = 1 AND mp.status = 'active' ORDER BY mp.id_messenger_page DESC LIMIT 1) AS messenger_page_name,
      (SELECT mp.page_id FROM messenger_pages mp WHERE mp.id_configuracion = c.id AND mp.subscribed = 1 AND mp.status = 'active' ORDER BY mp.id_messenger_page DESC LIMIT 1) AS messenger_page_id,
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
    { replacements: [id_usuario, esAdmin ? 1 : 0, id_sub_usuario || 0] },
  );

  const deps = await DepartamentosChatCenter.findAll({
    where: { id_usuario },
    include: [
      {
        model: Configuraciones,
        as: 'configuracion',
        attributes: ['nombre_configuracion', 'id', 'permiso_round_robin'],
        required: false,
      },
    ],
  });

  const departamentosConUsuarios = await Promise.all(
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

  let etiquetas_por_configuracion = {};
  if (Number(incluir_etiquetas) === 1) {
    const idsConfig = (conexiones || [])
      .map((c) => Number(c.id))
      .filter(Boolean);
    const etiquetasArr = await Promise.all(
      idsConfig.map(async (id_configuracion) => {
        try {
          const etiquetas =
            await EtiquetaService.obtenerEtiquetas(id_configuracion);
          return { id_configuracion, etiquetas: etiquetas || [] };
        } catch (e) {
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
      departamentos: departamentosConUsuarios,
      usuarios,
      conexiones,
      etiquetas_por_configuracion,
      motivos: [],
    },
  });
});

// ========================================================================
// DASHBOARD COMPLETO — OPTIMIZADO CON TABLAS TEMPORALES PRE-COMPUTADAS
// ========================================================================
// MODELO DE DATOS (mensajes_clientes):
//   celular_recibe = ccc.id del cliente (SIEMPRE, en AMBAS direcciones)
//   id_cliente     = ID del telefono del negocio (NO es el cliente)
//   rol_mensaje 0  = entrante (cliente -> negocio)
//   rol_mensaje 1  = saliente (negocio -> cliente)
//   rol_mensaje 3  = notificacion interna (transferencias, etc.)
//
// ESTRATEGIA DE PERFORMANCE:
//   temp_configs         -> IDs de configs del usuario (filtra todo)
//   temp_primer_entrante -> primer msg entrante por cliente EN EL RANGO
//   temp_ultimo_entrante -> ultimo msg entrante por cliente (global)
//   temp_ultimo_saliente -> ultimo msg saliente por cliente (global)
//
// Con estas 4 tablas, TODAS las queries son JOINs simples.
// Los NOT EXISTS se reemplazan por LEFT JOIN + IS NULL.
// ========================================================================
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

  const transaction = await db.transaction();

  try {
    // ══════════════════════════════════════════════════════════════════
    // LIMPIEZA PREVENTIVA
    // ══════════════════════════════════════════════════════════════════
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_configs', {
      transaction,
    });
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_primer_entrante', {
      transaction,
    });
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_ultimo_entrante', {
      transaction,
    });
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_ultimo_saliente', {
      transaction,
    });

    // ══════════════════════════════════════════════════════════════════
    // TEMP 1: Configuraciones del usuario
    // ══════════════════════════════════════════════════════════════════
    await db.query(
      `CREATE TEMPORARY TABLE temp_configs (
         id INT PRIMARY KEY
       ) AS
       SELECT id FROM configuraciones
       WHERE id_usuario = ? AND suspendido = 0
         ${id_configuracion ? 'AND id = ?' : ''}`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion]
          : [id_usuario],
        transaction,
      },
    );

    // ══════════════════════════════════════════════════════════════════
    // TEMP 2: Primer mensaje ENTRANTE por cliente EN EL RANGO
    // ══════════════════════════════════════════════════════════════════
    await db.query(
      `CREATE TEMPORARY TABLE temp_primer_entrante (
         id_configuracion INT,
         client_ccc_id INT,
         first_in_at DATETIME,
         INDEX idx_pe (id_configuracion, client_ccc_id)
       ) AS
       SELECT mc.id_configuracion, mc.celular_recibe AS client_ccc_id, MIN(mc.created_at) AS first_in_at
       FROM mensajes_clientes mc
       INNER JOIN temp_configs tc ON tc.id = mc.id_configuracion
       WHERE mc.deleted_at IS NULL
         AND mc.rol_mensaje = 0
         AND mc.created_at BETWEEN ? AND ?
       GROUP BY mc.id_configuracion, mc.celular_recibe`,
      { replacements: [fromDT, toDT], transaction },
    );

    // ══════════════════════════════════════════════════════════════════
    // TEMP 3: Ultimo mensaje ENTRANTE por cliente (global)
    // ══════════════════════════════════════════════════════════════════
    await db.query(
      `CREATE TEMPORARY TABLE temp_ultimo_entrante (
         id_configuracion INT,
         client_ccc_id INT,
         ultima_entrada_at DATETIME,
         INDEX idx_ue (id_configuracion, client_ccc_id)
       ) AS
       SELECT mc.id_configuracion, mc.celular_recibe AS client_ccc_id, MAX(mc.created_at) AS ultima_entrada_at
       FROM mensajes_clientes mc
       INNER JOIN temp_configs tc ON tc.id = mc.id_configuracion
       WHERE mc.deleted_at IS NULL AND mc.rol_mensaje = 0
       GROUP BY mc.id_configuracion, mc.celular_recibe`,
      { transaction },
    );

    // ══════════════════════════════════════════════════════════════════
    // TEMP 4: Ultimo mensaje SALIENTE por cliente (global)
    // ══════════════════════════════════════════════════════════════════
    await db.query(
      `CREATE TEMPORARY TABLE temp_ultimo_saliente (
         id_configuracion INT,
         client_ccc_id INT,
         ultima_salida_at DATETIME,
         INDEX idx_us (id_configuracion, client_ccc_id)
       ) AS
       SELECT mc.id_configuracion, mc.celular_recibe AS client_ccc_id, MAX(mc.created_at) AS ultima_salida_at
       FROM mensajes_clientes mc
       INNER JOIN temp_configs tc ON tc.id = mc.id_configuracion
       WHERE mc.deleted_at IS NULL AND mc.rol_mensaje = 1
       GROUP BY mc.id_configuracion, mc.celular_recibe`,
      { transaction },
    );

    // ====================================================================
    // SECCION 1: ESTADISTICAS
    // ====================================================================

    // 1a) Chats creados (clientes con actividad entrante en el rango)
    const [chatsCreatedRow] = await db.query(
      `SELECT COUNT(*) AS total FROM temp_primer_entrante tpe
       INNER JOIN clientes_chat_center ccc
         ON ccc.id_configuracion = tpe.id_configuracion AND ccc.id = tpe.client_ccc_id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0`,
      { type: db.QueryTypes.SELECT, transaction },
    );

    // 1b) Chats resueltos
    const [chatsResolvedRow] = await db.query(
      `SELECT COUNT(DISTINCT ccc.id) AS total
       FROM clientes_chat_center ccc
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         AND ccc.chat_cerrado_at BETWEEN ? AND ?`,
      { replacements: [fromDT, toDT], type: db.QueryTypes.SELECT, transaction },
    );

    // 1c) Con/sin respuesta + avg primera respuesta
    const [repliesAgg] = await db.query(
      `SELECT
         SUM(CASE WHEN tus.ultima_salida_at > tpe.first_in_at THEN 1 ELSE 0 END) AS withReplies,
         SUM(CASE WHEN tus.ultima_salida_at IS NULL OR tus.ultima_salida_at <= tpe.first_in_at THEN 1 ELSE 0 END) AS noReply,
         ROUND(AVG(
           CASE WHEN tus.ultima_salida_at > tpe.first_in_at
             THEN TIMESTAMPDIFF(SECOND, tpe.first_in_at,
               (SELECT MIN(mo.created_at) FROM mensajes_clientes mo
                WHERE mo.id_configuracion = tpe.id_configuracion
                  AND mo.deleted_at IS NULL AND mo.rol_mensaje = 1
                  AND mo.celular_recibe = tpe.client_ccc_id
                  AND mo.created_at > tpe.first_in_at AND mo.created_at <= ?))
             ELSE NULL END
         )) AS avgFirstResponseSeconds
       FROM temp_primer_entrante tpe
       INNER JOIN clientes_chat_center ccc
         ON ccc.id_configuracion = tpe.id_configuracion AND ccc.id = tpe.client_ccc_id
       LEFT JOIN temp_ultimo_saliente tus
         ON tus.id_configuracion = tpe.id_configuracion AND tus.client_ccc_id = tpe.client_ccc_id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0`,
      { replacements: [toDT], type: db.QueryTypes.SELECT, transaction },
    );

    // 1d) Tiempo de resolucion
    const [resolutionAgg] = await db.query(
      `SELECT ROUND(AVG(
         TIMESTAMPDIFF(SECOND, tpe_all.first_in_at, ccc.chat_cerrado_at)
       )) AS avgResolutionSeconds
       FROM clientes_chat_center ccc
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       INNER JOIN (
         SELECT id_configuracion, celular_recibe AS client_ccc_id, MIN(created_at) AS first_in_at
         FROM mensajes_clientes WHERE deleted_at IS NULL AND rol_mensaje = 0
         GROUP BY id_configuracion, celular_recibe
       ) tpe_all ON tpe_all.id_configuracion = ccc.id_configuracion AND tpe_all.client_ccc_id = ccc.id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         AND ccc.chat_cerrado_at BETWEEN ? AND ?`,
      { replacements: [fromDT, toDT], type: db.QueryTypes.SELECT, transaction },
    );

    const summary = {
      chatsCreated: Number(chatsCreatedRow?.total || 0),
      chatsResolved: Number(chatsResolvedRow?.total || 0),
      withReplies: Number(repliesAgg?.withReplies || 0),
      noReply: Number(repliesAgg?.noReply || 0),
      avgFirstResponseSeconds:
        repliesAgg?.avgFirstResponseSeconds != null
          ? Number(repliesAgg.avgFirstResponseSeconds)
          : null,
      avgResolutionSeconds:
        resolutionAgg?.avgResolutionSeconds != null
          ? Number(resolutionAgg.avgResolutionSeconds)
          : null,
    };

    // ====================================================================
    // SECCION 2: COLA DE PENDIENTES (con responsable)
    // ====================================================================
    const pendingQueue = await db.query(
      `SELECT
         ccc.id,
         ccc.nombre_cliente,
         ccc.apellido_cliente,
         ccc.source,
         ccc.estado_contacto,
         ccc.telefono_limpio,
         ccc.id_encargado,
         ccc.id_configuracion,
         su.nombre_encargado AS responsable,
         tue.ultima_entrada_at,
         TIMESTAMPDIFF(SECOND, tue.ultima_entrada_at, NOW()) AS waitSeconds
       FROM clientes_chat_center ccc
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       INNER JOIN temp_ultimo_entrante tue
         ON tue.id_configuracion = ccc.id_configuracion AND tue.client_ccc_id = ccc.id
       LEFT JOIN temp_ultimo_saliente tus
         ON tus.id_configuracion = ccc.id_configuracion AND tus.client_ccc_id = ccc.id
       LEFT JOIN sub_usuarios_chat_center su
         ON su.id_sub_usuario = ccc.id_encargado
       WHERE ccc.deleted_at IS NULL
         AND ccc.propietario = 0
         AND ccc.chat_cerrado = 0
         AND tue.ultima_entrada_at BETWEEN ? AND ?
         AND (tus.ultima_salida_at IS NULL OR tus.ultima_salida_at < tue.ultima_entrada_at)
       ORDER BY tue.ultima_entrada_at ASC
       LIMIT 50`,
      { replacements: [fromDT, toDT], type: db.QueryTypes.SELECT, transaction },
    );

    const queueData = pendingQueue.map((r) => {
      const wait = Number(r.waitSeconds || 0);
      let priority = 'Baja';
      if (wait >= 10 * 60) priority = 'Alta';
      else if (wait >= 5 * 60) priority = 'Media';

      const fullName =
        `${(r.nombre_cliente || '').trim()} ${(r.apellido_cliente || '').trim()}`.trim();
      return {
        priority,
        id: `${r.id}`,
        client: fullName || 'Cliente sin nombre',
        channel:
          r.source === 'wa'
            ? 'WhatsApp'
            : r.source === 'ig'
              ? 'Instagram'
              : r.source === 'ms'
                ? 'Messenger'
                : r.source || '—',
        waitSeconds: wait,
        estado_contacto: r.estado_contacto || '—',
        telefono_limpio: r.telefono_limpio || '—',
        responsable: r.responsable || 'Sin asignar',
        id_configuracion: r.id_configuracion,
      };
    });

    // ====================================================================
    // SECCION 3: SLA
    // ====================================================================
    const ABANDON_HOURS = Number(process.env.SLA_ABANDON_HOURS || 2);

    const resolvedByChannel = await db.query(
      `SELECT ccc.source, COUNT(DISTINCT ccc.id) AS total
       FROM clientes_chat_center ccc
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         AND ccc.chat_cerrado_at BETWEEN ? AND ?
       GROUP BY ccc.source`,
      { replacements: [fromDT, toDT], type: db.QueryTypes.SELECT, transaction },
    );

    const abandonedByChannel = await db.query(
      `SELECT ccc.source, COUNT(DISTINCT ccc.id) AS total
       FROM clientes_chat_center ccc
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       INNER JOIN temp_ultimo_entrante tue
         ON tue.id_configuracion = ccc.id_configuracion AND tue.client_ccc_id = ccc.id
       LEFT JOIN temp_ultimo_saliente tus
         ON tus.id_configuracion = ccc.id_configuracion AND tus.client_ccc_id = ccc.id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.chat_cerrado = 0
         AND tue.ultima_entrada_at BETWEEN ? AND ?
         AND TIMESTAMPDIFF(HOUR, tue.ultima_entrada_at, NOW()) >= ?
         AND (tus.ultima_salida_at IS NULL OR tus.ultima_salida_at < tue.ultima_entrada_at)
       GROUP BY ccc.source`,
      {
        replacements: [fromDT, toDT, ABANDON_HOURS],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const resolvedMap = new Map(
      resolvedByChannel.map((r) => [r.source, Number(r.total || 0)]),
    );
    const abandonedMap = new Map(
      abandonedByChannel.map((r) => [r.source, Number(r.total || 0)]),
    );

    const sources = ['wa', 'ms', 'ig'];
    const mapChannel = (s) =>
      s === 'wa'
        ? 'WhatsApp'
        : s === 'ig'
          ? 'Instagram'
          : s === 'ms'
            ? 'Messenger'
            : s || '—';

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

    const slaData = {
      generalPct: denom ? Math.round((resolvedToday / denom) * 1000) / 10 : 0,
      metaPct: denom ? Math.round((resolvedToday / denom) * 1000) / 10 : 0,
      channels,
      resolvedToday,
      abandoned: abandonedTotal,
    };

    // ====================================================================
    // SECCION 4: CHARTS
    // ====================================================================

    const byChannel = await db.query(
      `SELECT UPPER(COALESCE(ccc.source, 'OTHER')) AS name, COUNT(*) AS value
       FROM temp_primer_entrante tpe
       INNER JOIN clientes_chat_center ccc
         ON ccc.id_configuracion = tpe.id_configuracion AND ccc.id = tpe.client_ccc_id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
       GROUP BY ccc.source ORDER BY value DESC`,
      { type: db.QueryTypes.SELECT, transaction },
    );

    const byConnection = await db.query(
      `SELECT cfg.nombre_configuracion AS name, COUNT(*) AS value
       FROM temp_primer_entrante tpe
       INNER JOIN configuraciones cfg ON cfg.id = tpe.id_configuracion
       INNER JOIN clientes_chat_center ccc
         ON ccc.id_configuracion = tpe.id_configuracion AND ccc.id = tpe.client_ccc_id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
       GROUP BY cfg.id, cfg.nombre_configuracion ORDER BY value DESC`,
      { type: db.QueryTypes.SELECT, transaction },
    );

    const chatsCreated = await db.query(
      `SELECT DATE_FORMAT(tpe.first_in_at, '%H:00') AS hour, COUNT(*) AS chats
       FROM temp_primer_entrante tpe
       INNER JOIN clientes_chat_center ccc
         ON ccc.id_configuracion = tpe.id_configuracion AND ccc.id = tpe.client_ccc_id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
       GROUP BY hour ORDER BY hour ASC`,
      { type: db.QueryTypes.SELECT, transaction },
    );

    const chatsResolved = await db.query(
      `SELECT DATE_FORMAT(ccc.chat_cerrado_at, '%H:00') AS hour, COUNT(DISTINCT ccc.id) AS resolved
       FROM clientes_chat_center ccc
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         AND ccc.chat_cerrado_at BETWEEN ? AND ?
       GROUP BY hour ORDER BY hour ASC`,
      { replacements: [fromDT, toDT], type: db.QueryTypes.SELECT, transaction },
    );

    const firstResponse = await db.query(
      `SELECT DATE_FORMAT(tpe.first_in_at, '%H:00') AS hour,
              AVG(TIMESTAMPDIFF(SECOND, tpe.first_in_at,
                (SELECT MIN(mo.created_at) FROM mensajes_clientes mo
                 WHERE mo.id_configuracion = tpe.id_configuracion
                   AND mo.deleted_at IS NULL AND mo.rol_mensaje = 1
                   AND mo.celular_recibe = tpe.client_ccc_id
                   AND mo.created_at > tpe.first_in_at)
              )) AS avgSeconds,
              COUNT(*) AS chats
       FROM temp_primer_entrante tpe
       INNER JOIN clientes_chat_center ccc
         ON ccc.id_configuracion = tpe.id_configuracion AND ccc.id = tpe.client_ccc_id
       INNER JOIN temp_ultimo_saliente tus
         ON tus.id_configuracion = tpe.id_configuracion AND tus.client_ccc_id = tpe.client_ccc_id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND tus.ultima_salida_at > tpe.first_in_at
       GROUP BY hour ORDER BY hour ASC`,
      { type: db.QueryTypes.SELECT, transaction },
    );

    const resolution = await db.query(
      `SELECT DATE_FORMAT(ccc.chat_cerrado_at, '%H:00') AS hour,
              AVG(TIMESTAMPDIFF(SECOND, tpe_all.first_in_at, ccc.chat_cerrado_at)) AS avgSeconds,
              COUNT(*) AS chats
       FROM clientes_chat_center ccc
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       INNER JOIN (
         SELECT id_configuracion, celular_recibe AS client_ccc_id, MIN(created_at) AS first_in_at
         FROM mensajes_clientes WHERE deleted_at IS NULL AND rol_mensaje = 0
         GROUP BY id_configuracion, celular_recibe
       ) tpe_all ON tpe_all.id_configuracion = ccc.id_configuracion AND tpe_all.client_ccc_id = ccc.id
       WHERE ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         AND ccc.chat_cerrado_at BETWEEN ? AND ?
       GROUP BY hour ORDER BY hour ASC`,
      { replacements: [fromDT, toDT], type: db.QueryTypes.SELECT, transaction },
    );

    const chartsData = {
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

    // ====================================================================
    // SECCION 5: CARGA POR ASESOR
    // ====================================================================
    const agentLoad = await db.query(
      `SELECT
        su.id_sub_usuario,
        su.nombre_encargado,
        COUNT(DISTINCT ccc.id) AS total_chats
          FROM sub_usuarios_chat_center su
          LEFT JOIN (
            SELECT ccc2.id, ccc2.id_encargado
            FROM clientes_chat_center ccc2
            INNER JOIN temp_configs tc ON tc.id = ccc2.id_configuracion
            INNER JOIN temp_primer_entrante tpe
              ON tpe.id_configuracion = ccc2.id_configuracion
              AND tpe.client_ccc_id = ccc2.id
            WHERE ccc2.deleted_at IS NULL AND ccc2.propietario = 0
          ) ccc ON ccc.id_encargado = su.id_sub_usuario
          WHERE su.id_usuario = ?
          GROUP BY su.id_sub_usuario, su.nombre_encargado
          ORDER BY total_chats DESC`,
      { replacements: [id_usuario], type: db.QueryTypes.SELECT, transaction },
    );
    // ====================================================================
    // SECCION 6: CLIENTES CON +3 TRANSFERENCIAS
    // ====================================================================
    const frequentTransfers = await db.query(
      `SELECT
         h.id_cliente_chat_center,
         ccc.nombre_cliente,
         ccc.apellido_cliente,
         ccc.telefono_limpio,
         ccc.source,
         ccc.id_configuracion,
         COUNT(h.id) AS total_transferencias,
         su_actual.nombre_encargado AS responsable_actual
       FROM historial_encargados h
       INNER JOIN clientes_chat_center ccc ON ccc.id = h.id_cliente_chat_center
       INNER JOIN temp_configs tc ON tc.id = ccc.id_configuracion
       LEFT JOIN sub_usuarios_chat_center su_actual ON su_actual.id_sub_usuario = ccc.id_encargado
       WHERE ccc.deleted_at IS NULL
         AND h.fecha_registro BETWEEN ? AND ?
       GROUP BY h.id_cliente_chat_center, ccc.nombre_cliente, ccc.apellido_cliente,
                ccc.telefono_limpio, ccc.source, ccc.id_configuracion, su_actual.nombre_encargado
       HAVING total_transferencias >= 3
       ORDER BY total_transferencias DESC
       LIMIT 30`,
      { replacements: [fromDT, toDT], type: db.QueryTypes.SELECT, transaction },
    );

    const frequentTransfersData = frequentTransfers.map((r) => {
      const fullName =
        `${(r.nombre_cliente || '').trim()} ${(r.apellido_cliente || '').trim()}`.trim();
      return {
        id: `${r.id_cliente_chat_center}`,
        client: fullName || 'Cliente sin nombre',
        telefono: r.telefono_limpio || '—',
        channel: mapChannel(r.source),
        totalTransferencias: Number(r.total_transferencias),
        responsableActual: r.responsable_actual || 'Sin asignar',
        id_configuracion: r.id_configuracion,
      };
    });

    // ══════════════════════════════════════════════════════════════════
    // LIMPIEZA + COMMIT
    // ══════════════════════════════════════════════════════════════════
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_configs', {
      transaction,
    });
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_primer_entrante', {
      transaction,
    });
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_ultimo_entrante', {
      transaction,
    });
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_ultimo_saliente', {
      transaction,
    });
    await transaction.commit();

    // ══════════════════════════════════════════════════════════════════
    // RESPUESTA
    // ══════════════════════════════════════════════════════════════════
    return res.json({
      status: 'success',
      data: {
        summary,
        pendingQueue: queueData,
        slaToday: slaData,
        charts: chartsData,
        agentLoad,
        frequentTransfers: frequentTransfersData,
        meta: {
          from,
          to,
          id_configuracion: id_configuracion || null,
          executedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
});
