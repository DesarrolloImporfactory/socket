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

  // =========================
  // 1) USUARIOS (sanitizados)
  // =========================
  const subUsuarios = await Sub_usuarios_chat_center.findAll({
    where: { id_usuario },
  });

  const usuarios = (subUsuarios || []).map((u) => {
    const { password, admin_pass, ...safe } = u.toJSON();
    return safe;
  });

  // =====================================
  // 2) CONEXIONES (misma lógica sub_user)
  // =====================================
  let esAdmin = true;

  if (id_sub_usuario) {
    const subRow = await db.query(
      `
      SELECT rol
      FROM sub_usuarios_chat_center
      WHERE id_sub_usuario = ?
        AND id_usuario = ?
      LIMIT 1
      `,
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
    `
    SELECT
      c.id,
      c.id_plataforma,
      c.nombre_configuracion,
      c.telefono,
      c.id_telefono,
      c.id_whatsapp,
      c.webhook_url,
      c.metodo_pago,
      c.suspendido,
      c.tipo_configuracion,
      c.sincronizo_coexistencia,

      CASE
        WHEN COALESCE(c.id_telefono,'') <> '' AND COALESCE(c.id_whatsapp,'') <> '' THEN 1
        ELSE 0
      END AS conectado,

      EXISTS (
        SELECT 1
        FROM messenger_pages mp
        WHERE mp.id_configuracion = c.id
          AND mp.subscribed = 1
          AND mp.status = 'active'
      ) AS messenger_conectado,

      (
        SELECT mp.page_name
        FROM messenger_pages mp
        WHERE mp.id_configuracion = c.id
          AND mp.subscribed = 1
          AND mp.status = 'active'
        ORDER BY mp.id_messenger_page DESC
        LIMIT 1
      ) AS messenger_page_name,

      (
        SELECT mp.page_id
        FROM messenger_pages mp
        WHERE mp.id_configuracion = c.id
          AND mp.subscribed = 1
          AND mp.status = 'active'
        ORDER BY mp.id_messenger_page DESC
        LIMIT 1
      ) AS messenger_page_id,

      EXISTS (
        SELECT 1
        FROM instagram_pages ip
        WHERE ip.id_configuracion = c.id
          AND ip.subscribed = 1
          AND ip.status = 'active'
      ) AS instagram_conectado,

      EXISTS (
        SELECT 1
        FROM tiktok_devs_connections tdc
        WHERE tdc.id_configuracion = c.id
      ) AS tiktok_conectado

    FROM configuraciones c
    WHERE c.id_usuario = ?
      AND c.suspendido = 0
      AND (
        ? = 1
        OR EXISTS (
          SELECT 1
          FROM departamentos_chat_center dcc
          INNER JOIN sub_usuarios_departamento sud
            ON sud.id_departamento = dcc.id_departamento
          WHERE dcc.id_configuracion = c.id
            AND sud.id_sub_usuario = ?
        )
      )
    ORDER BY c.id DESC
    `,
    {
      replacements: [id_usuario, esAdmin ? 1 : 0, id_sub_usuario || 0],
    },
  );

  // ==========================================
  // 3) DEPARTAMENTOS (con usuarios_asignados)
  // ==========================================
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

  // ==========================================
  // 4) ETIQUETAS por configuración (opcional)
  // ==========================================
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

  // Motivos: por ahora vacío (como usted dijo)
  const motivos = [];

  return res.status(200).json({
    status: 'success',
    data: {
      departamentos: departamentosConUsuarios,
      usuarios,
      conexiones,
      etiquetas_por_configuracion,
      motivos,
    },
  });
});

// ========================================================================
// ENDPOINT CONSOLIDADO: Reemplaza los 4 endpoints actuales
// Ejecuta las 13 consultas en secuencia optimizada dentro de una sola
// request HTTP.
//
// FIX: Todas las queries corren dentro de una TRANSACTION para garantizar
//      que usen la misma conexión del pool y la tabla temporal sea visible.
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

  // =====================================================================
  // Abrir transacción → misma conexión para TODAS las queries
  // =====================================================================
  const transaction = await db.transaction();

  try {
    // ====================================================================
    // CREAR TABLA TEMPORAL (visible en toda la transacción)
    // ====================================================================
    await db.query(
      `CREATE TEMPORARY TABLE IF NOT EXISTS temp_mensajes_validos AS
       SELECT DISTINCT id_configuracion, id_cliente 
       FROM mensajes_clientes 
       WHERE deleted_at IS NULL
       UNION
       SELECT DISTINCT id_configuracion, CAST(celular_recibe AS UNSIGNED) 
       FROM mensajes_clientes 
       WHERE deleted_at IS NULL AND celular_recibe IS NOT NULL AND celular_recibe <> ''`,
      { transaction },
    );

    // ====================================================================
    // SECCIÓN 1: ESTADÍSTICAS (4 consultas)
    // ====================================================================

    const [chatsCreatedRow] = await db.query(
      `SELECT COUNT(DISTINCT ccc.id) AS total
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN temp_mensajes_validos msg ON msg.id_configuracion = ccc.id_configuracion AND msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ?
         AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ms','ig')
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.created_at BETWEEN ? AND ?`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const [chatsResolvedRow] = await db.query(
      `SELECT COUNT(DISTINCT ccc.id) AS total
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN temp_mensajes_validos msg ON msg.id_configuracion = ccc.id_configuracion AND msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ?
         AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ms','ig')
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.chat_cerrado_at BETWEEN ? AND ?`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const [repliesAgg] = await db.query(
      `SELECT
         SUM(CASE WHEN first_out_at IS NOT NULL THEN 1 ELSE 0 END) AS withReplies,
         SUM(CASE WHEN first_out_at IS NULL THEN 1 ELSE 0 END) AS noReply,
         ROUND(AVG(CASE WHEN first_out_at IS NOT NULL 
                   THEN TIMESTAMPDIFF(SECOND, first_in_at, first_out_at) ELSE NULL END)) AS avgFirstResponseSeconds
       FROM (
         SELECT fi.id_configuracion, fi.contact_id, fi.first_in_at,
                (SELECT MIN(mo.created_at) FROM mensajes_clientes mo
                 WHERE mo.id_configuracion = fi.id_configuracion AND mo.deleted_at IS NULL
                   AND mo.rol_mensaje = 1 AND mo.celular_recibe = fi.contact_id
                   AND mo.created_at > fi.first_in_at AND mo.created_at <= ?) AS first_out_at
         FROM (
           SELECT mc.id_configuracion, mc.id_cliente AS contact_id, MIN(mc.created_at) AS first_in_at
           FROM mensajes_clientes mc
           INNER JOIN configuraciones cfg ON cfg.id = mc.id_configuracion
           WHERE cfg.id_usuario = ? AND mc.deleted_at IS NULL AND mc.rol_mensaje = 0
             ${id_configuracion ? 'AND mc.id_configuracion = ?' : ''}
             AND mc.created_at BETWEEN ? AND ?
           GROUP BY mc.id_configuracion, mc.id_cliente
         ) fi
       ) t`,
      {
        replacements: id_configuracion
          ? [toDT, id_usuario, id_configuracion, fromDT, toDT]
          : [toDT, id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const [resolutionAgg] = await db.query(
      `SELECT ROUND(AVG(TIMESTAMPDIFF(SECOND, first_msg.first_in_at, ccc.chat_cerrado_at))) AS avgResolutionSeconds
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN (
         SELECT id_configuracion, id_cliente, MIN(created_at) AS first_in_at
         FROM mensajes_clientes
         WHERE deleted_at IS NULL AND rol_mensaje = 0
         GROUP BY id_configuracion, id_cliente
       ) first_msg ON first_msg.id_configuracion = ccc.id_configuracion AND first_msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ?
         AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ms','ig')
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.chat_cerrado_at BETWEEN ? AND ?`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
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
    // SECCIÓN 2: COLA DE PENDIENTES
    // ====================================================================

    const pendingQueue = await db.query(
      `SELECT ccc.id, ccc.nombre_cliente, ccc.apellido_cliente, ccc.source, ccc.estado_contacto,
              last_msg.ultimo_mensaje_at, ccc.telefono_limpio,
              TIMESTAMPDIFF(SECOND, last_msg.ultimo_mensaje_at, NOW()) AS waitSeconds
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN (
         SELECT id_configuracion, id_cliente, MAX(created_at) AS ultimo_mensaje_at
         FROM (
           SELECT id_configuracion, id_cliente, created_at FROM mensajes_clientes
           WHERE deleted_at IS NULL AND rol_mensaje = 0
           UNION ALL
           SELECT id_configuracion, CAST(celular_recibe AS UNSIGNED), created_at FROM mensajes_clientes
           WHERE deleted_at IS NULL AND rol_mensaje = 1 
             AND celular_recibe IS NOT NULL AND celular_recibe <> ''
         ) msgs
         GROUP BY id_configuracion, id_cliente
       ) last_msg ON last_msg.id_configuracion = ccc.id_configuracion AND last_msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ? AND ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.source IN ('wa','ig','ms') AND ccc.chat_cerrado = 0
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND last_msg.ultimo_mensaje_at BETWEEN ? AND ?
       ORDER BY last_msg.ultimo_mensaje_at ASC
       LIMIT 50`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
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
        id: `#${r.id}`,
        client: fullName || `Cliente ${r.id}`,
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
      };
    });

    // ====================================================================
    // SECCIÓN 3: SLA
    // ====================================================================

    const ABANDON_HOURS = Number(process.env.SLA_ABANDON_HOURS || 2);

    const resolvedByChannel = await db.query(
      `SELECT ccc.source, COUNT(DISTINCT ccc.id) AS total
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN temp_mensajes_validos msg ON msg.id_configuracion = ccc.id_configuracion AND msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ?
         AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ig','ms')
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.chat_cerrado_at BETWEEN ? AND ?
       GROUP BY ccc.source`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const abandonedByChannel = await db.query(
      `SELECT ccc.source, COUNT(DISTINCT ccc.id) AS total
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN (
         SELECT id_configuracion, id_cliente, MAX(created_at) AS ultimo_mensaje_at
         FROM (
           SELECT id_configuracion, id_cliente, created_at FROM mensajes_clientes
           WHERE deleted_at IS NULL AND rol_mensaje = 0
           UNION ALL
           SELECT id_configuracion, CAST(celular_recibe AS UNSIGNED), created_at FROM mensajes_clientes
           WHERE deleted_at IS NULL AND rol_mensaje = 1 
             AND celular_recibe IS NOT NULL AND celular_recibe <> ''
         ) msgs
         GROUP BY id_configuracion, id_cliente
       ) last_msg ON last_msg.id_configuracion = ccc.id_configuracion AND last_msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ?
         AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ig','ms')
         AND ccc.chat_cerrado = 0
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND last_msg.ultimo_mensaje_at BETWEEN ? AND ?
         AND TIMESTAMPDIFF(HOUR, last_msg.ultimo_mensaje_at, NOW()) >= ?
       GROUP BY ccc.source`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT, ABANDON_HOURS]
          : [id_usuario, fromDT, toDT, ABANDON_HOURS],
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
    const mapChannel = (s) => {
      if (s === 'wa') return 'WhatsApp';
      if (s === 'ig') return 'Instagram';
      if (s === 'ms') return 'Messenger';
      return s || '—';
    };

    const channels = sources.map((s) => {
      const resolved = resolvedMap.get(s) || 0;
      const abandoned = abandonedMap.get(s) || 0;
      const denom = resolved + abandoned;
      const pct = denom ? Math.round((resolved / denom) * 1000) / 10 : 0;
      return { name: mapChannel(s), pct };
    });

    const resolvedToday = sources.reduce(
      (acc, s) => acc + (resolvedMap.get(s) || 0),
      0,
    );
    const abandoned = sources.reduce(
      (acc, s) => acc + (abandonedMap.get(s) || 0),
      0,
    );
    const denom = resolvedToday + abandoned;
    const generalPct = denom
      ? Math.round((resolvedToday / denom) * 1000) / 10
      : 0;

    const slaData = {
      generalPct,
      metaPct: generalPct,
      channels,
      resolvedToday,
      abandoned,
    };

    // ====================================================================
    // SECCIÓN 4: CHARTS (6 consultas)
    // ====================================================================

    const byChannel = await db.query(
      `SELECT UPPER(ccc.source) AS name, COUNT(DISTINCT ccc.id) AS value
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN temp_mensajes_validos msg ON msg.id_configuracion = ccc.id_configuracion AND msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ? AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ig','ms')
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.created_at BETWEEN ? AND ?
       GROUP BY ccc.source ORDER BY value DESC`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const byConnection = await db.query(
      `SELECT cfg.nombre_configuracion AS name, COUNT(DISTINCT ccc.id) AS value
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN temp_mensajes_validos msg ON msg.id_configuracion = ccc.id_configuracion AND msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ? AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ig','ms')
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.created_at BETWEEN ? AND ?
       GROUP BY cfg.id, cfg.nombre_configuracion ORDER BY value DESC`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const chatsCreated = await db.query(
      `SELECT DATE_FORMAT(ccc.created_at, '%H:00') AS hour, COUNT(DISTINCT ccc.id) AS chats
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN temp_mensajes_validos msg ON msg.id_configuracion = ccc.id_configuracion AND msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ? AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ig','ms')
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.created_at BETWEEN ? AND ?
       GROUP BY hour ORDER BY hour ASC`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const chatsResolved = await db.query(
      `SELECT DATE_FORMAT(ccc.chat_cerrado_at, '%H:00') AS hour, COUNT(DISTINCT ccc.id) AS resolved
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN temp_mensajes_validos msg ON msg.id_configuracion = ccc.id_configuracion AND msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ? AND ccc.deleted_at IS NULL AND ccc.propietario = 0 AND ccc.source IN ('wa','ig','ms')
         AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.chat_cerrado_at BETWEEN ? AND ?
       GROUP BY hour ORDER BY hour ASC`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const firstResponse = await db.query(
      `SELECT DATE_FORMAT(first_in_at, '%H:00') AS hour,
              AVG(TIMESTAMPDIFF(SECOND, first_in_at, first_out_at)) AS avgSeconds, COUNT(*) AS chats
       FROM (
         SELECT fi.id_configuracion, fi.contact_id, fi.first_in_at,
                (SELECT MIN(mo.created_at) FROM mensajes_clientes mo
                 WHERE mo.id_configuracion = fi.id_configuracion AND mo.deleted_at IS NULL
                   AND mo.rol_mensaje = 1 AND mo.celular_recibe = fi.contact_id
                   AND mo.created_at > fi.first_in_at) AS first_out_at
         FROM (
           SELECT mc.id_configuracion, mc.id_cliente AS contact_id, MIN(mc.created_at) AS first_in_at
           FROM mensajes_clientes mc
           INNER JOIN configuraciones cfg ON cfg.id = mc.id_configuracion
           WHERE cfg.id_usuario = ? AND mc.deleted_at IS NULL AND mc.rol_mensaje = 0
             ${id_configuracion ? 'AND mc.id_configuracion = ?' : ''}
             AND mc.created_at BETWEEN ? AND ?
           GROUP BY mc.id_configuracion, mc.id_cliente
         ) fi
       ) t
       WHERE first_out_at IS NOT NULL
       GROUP BY hour ORDER BY hour ASC`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
    );

    const resolution = await db.query(
      `SELECT DATE_FORMAT(ccc.chat_cerrado_at, '%H:00') AS hour,
              AVG(TIMESTAMPDIFF(SECOND, first_msg.first_in_at, ccc.chat_cerrado_at)) AS avgSeconds, COUNT(*) AS chats
       FROM clientes_chat_center ccc
       INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
       INNER JOIN (
         SELECT id_configuracion, id_cliente, MIN(created_at) AS first_in_at
         FROM mensajes_clientes WHERE deleted_at IS NULL AND rol_mensaje = 0
         GROUP BY id_configuracion, id_cliente
       ) first_msg ON first_msg.id_configuracion = ccc.id_configuracion AND first_msg.id_cliente = ccc.id
       WHERE cfg.id_usuario = ? AND ccc.deleted_at IS NULL AND ccc.propietario = 0
         AND ccc.source IN ('wa','ms','ig') AND ccc.chat_cerrado = 1 AND ccc.chat_cerrado_at IS NOT NULL
         ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
         AND ccc.chat_cerrado_at BETWEEN ? AND ?
       GROUP BY hour ORDER BY hour ASC`,
      {
        replacements: id_configuracion
          ? [id_usuario, id_configuracion, fromDT, toDT]
          : [id_usuario, fromDT, toDT],
        type: db.QueryTypes.SELECT,
        transaction,
      },
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

    // ==================================================================
    // LIMPIEZA + COMMIT
    // ==================================================================
    await db.query('DROP TEMPORARY TABLE IF EXISTS temp_mensajes_validos', {
      transaction,
    });
    await transaction.commit();

    // ==================================================================
    // RESPUESTA CONSOLIDADA
    // ==================================================================
    return res.json({
      status: 'success',
      data: {
        summary,
        pendingQueue: queueData,
        slaToday: slaData,
        charts: chartsData,
        meta: {
          from,
          to,
          id_configuracion: id_configuracion || null,
          executedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    // Rollback libera la conexión y limpia la tabla temporal automáticamente
    await transaction.rollback();
    throw error; // catchAsync lo maneja
  }
});
