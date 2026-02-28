const { db } = require('../database/config');

const DepartamentosChatCenter = require('../models/departamentos_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const Sub_usuarios_departamento = require('../models/sub_usuarios_departamento.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');

// Service de etiquetas
const EtiquetaService = require('../services/etiqueta.service');

const catchAsync = require('../utils/catchAsync');
// const AppError = require("../utils/appError"); // si lo usa

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

// Helpers: fechas seguras (incluye el día completo)
function buildRange(from, to) {
  const fromDT = `${from} 00:00:00`;
  const toDT = `${to} 23:59:59`;
  return { fromDT, toDT };
}

exports.obtenerEstadisticas = catchAsync(async (req, res) => {
  const { id_usuario, id_configuracion = null, from, to } = req.body;

  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }
  if (!from || !to) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta rango de fechas (from/to)' });
  }

  const { fromDT, toDT } = buildRange(from, to);

  // =========================================================
  // 1) Chats creados (CONTACTOS) por rango
  // - clientes_chat_center
  // - excluye propietarios (propietario=0)
  // - solo canales reales wa/ms/ig
  // =========================================================
  const chatsCreatedRow = await db.query(
    `
    SELECT COUNT(*) AS total
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ms','ig')
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.created_at BETWEEN ? AND ?
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  const chatsCreated = Number(chatsCreatedRow?.[0]?.total || 0);

  // =========================================================
  // 2) Chats resueltos (chat_cerrado = 1)
  // - proxy por updated_at (por ahora)
  // =========================================================
  const chatsResolvedRow = await db.query(
    `
    SELECT COUNT(*) AS total
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ms','ig')
      AND ccc.chat_cerrado = 1
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.updated_at BETWEEN ? AND ?
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  const chatsResolved = Number(chatsResolvedRow?.[0]?.total || 0);

  // =========================================================
  // 3) Con respuesta / Sin respuesta + Avg Primera Respuesta
  //
  // LÓGICA ROBUSTA (sin depender de clientes_chat_center):
  // - Definimos "conversación" por (id_configuracion, contact_id)
  // - contact_id = id_cliente de los mensajes del cliente (rol_mensaje=0)
  // - Primera entrada del cliente en el rango: MIN(created_at)
  // - Respuesta = primer OUT posterior:
  //     rol_mensaje=1 AND celular_recibe = contact_id AND created_at > first_in_at
  //
  // NOTA:
  // - NO hacemos JOIN a clientes_chat_center (para no romper históricos borrados).
  // - Si algún OUT no tiene celular_recibe válido, simplemente no se asigna como respuesta.
  // =========================================================
  const repliesAgg = await db.query(
    `
    SELECT
      SUM(CASE WHEN t.first_out_at IS NOT NULL THEN 1 ELSE 0 END) AS withReplies,
      SUM(CASE WHEN t.first_out_at IS NULL THEN 1 ELSE 0 END) AS noReply,
      ROUND(AVG(
        CASE
          WHEN t.first_out_at IS NOT NULL
          THEN TIMESTAMPDIFF(SECOND, t.first_in_at, t.first_out_at)
          ELSE NULL
        END
      )) AS avgFirstResponseSeconds
    FROM (
      SELECT
        fi.id_configuracion,
        fi.contact_id,
        fi.first_in_at,
        MIN(mo.created_at) AS first_out_at
      FROM (
        SELECT
          mc.id_configuracion,
          mc.id_cliente AS contact_id,
          MIN(mc.created_at) AS first_in_at
        FROM mensajes_clientes mc
        INNER JOIN configuraciones cfg ON cfg.id = mc.id_configuracion
        WHERE cfg.id_usuario = ?
          AND mc.deleted_at IS NULL
          AND mc.rol_mensaje = 0
          AND mc.created_at BETWEEN ? AND ?
          ${id_configuracion ? 'AND mc.id_configuracion = ?' : ''}
        GROUP BY mc.id_configuracion, mc.id_cliente
      ) fi
      LEFT JOIN mensajes_clientes mo
        ON mo.id_configuracion = fi.id_configuracion
       AND mo.deleted_at IS NULL
       AND mo.rol_mensaje = 1
       AND mo.celular_recibe = fi.contact_id
       AND mo.created_at > fi.first_in_at
       AND mo.created_at <= ?
      GROUP BY fi.id_configuracion, fi.contact_id, fi.first_in_at
    ) t
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, fromDT, toDT, id_configuracion, toDT]
        : [id_usuario, fromDT, toDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  const withReplies = Number(repliesAgg?.[0]?.withReplies || 0);
  const noReply = Number(repliesAgg?.[0]?.noReply || 0);
  const avgFirstResponseSeconds =
    repliesAgg?.[0]?.avgFirstResponseSeconds !== null &&
    repliesAgg?.[0]?.avgFirstResponseSeconds !== undefined
      ? Number(repliesAgg[0].avgFirstResponseSeconds)
      : null;

  // =========================================================
  // 4) Avg Resolución (por ahora null hasta tener chat_cerrado_at real)
  // =========================================================
  const avgResolutionSeconds = null;

  return res.json({
    status: 'success',
    data: {
      summary: {
        chatsCreated,
        chatsResolved,
        withReplies,
        noReply,
        avgFirstResponseSeconds,
        avgResolutionSeconds,
      },
      meta: {
        from,
        to,
        id_configuracion: id_configuracion || null,
      },
    },
  });
});

function mapChannel(source) {
  if (source === 'wa') return 'WhatsApp';
  if (source === 'ig') return 'Instagram';
  if (source === 'ms') return 'Messenger';
  return source || '—';
}

/**
 * 1) COLA DE CHATS PENDIENTES
 * - Pendiente = chat_cerrado = 0
 * - espera = segundos desde última actividad (ccc.updated_at)
 * - prioridad por espera:
 *    Alta: >= 10m
 *    Media: >= 5m
 *    Baja: < 5m
 * - motivo: por ahora usamos estado_contacto (hasta que definamos una tabla real de motivos)
 */
exports.obtenerColaPendientes = catchAsync(async (req, res) => {
  const {
    id_usuario,
    id_configuracion = null,
    from,
    to,
    limit = 50,
  } = req.body;

  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }
  if (!from || !to) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta rango de fechas (from/to)' });
  }

  const { fromDT, toDT } = buildRange(from, to);

  const rows = await db.query(
    `
    SELECT
      ccc.id,
      ccc.nombre_cliente,
      ccc.apellido_cliente,
      ccc.source,
      ccc.estado_contacto,
      ccc.updated_at,
      TIMESTAMPDIFF(SECOND, ccc.updated_at, NOW()) AS waitSeconds
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ig','ms')
      AND ccc.chat_cerrado = 0
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      -- “Actualizado: ahora” en UI, pero filtramos por rango para que sea consistente con filtros
      AND ccc.updated_at BETWEEN ? AND ?
    ORDER BY ccc.updated_at ASC
    LIMIT ?
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT, Number(limit)]
        : [id_usuario, fromDT, toDT, Number(limit)],
      type: db.QueryTypes.SELECT,
    },
  );

  const data = rows.map((r) => {
    const wait = Number(r.waitSeconds || 0);

    let priority = 'Baja';
    if (wait >= 10 * 60) priority = 'Alta';
    else if (wait >= 5 * 60) priority = 'Media';

    const fullName =
      `${(r.nombre_cliente || '').trim()} ${(r.apellido_cliente || '').trim()}`.trim();

    return {
      priority, // Alta | Media | Baja
      id: `#${r.id}`, // UI
      client: fullName || `Cliente ${r.id}`,
      channel: mapChannel(r.source),
      waitSeconds: wait,
      motive: r.estado_contacto || '—',
    };
  });

  return res.json({
    status: 'success',
    data,
    meta: { from, to, id_configuracion: id_configuracion || null },
  });
});

/**
 * 2) CUMPLIMIENTO SLA HOY
 * - resolvedToday: chats cerrados hoy (chat_cerrado=1 y updated_at hoy)
 * - abandoned: pendientes cuyo “tiempo sin actividad” >= X horas (SLA_ABANDON_HOURS)
 * - % general: resolved/(resolved+abandoned)
 * - % meta: igual pero solo canales meta (wa, ig, ms) -> en su caso todos son meta
 * - channels[]: pct por canal (wa/ig/ms)
 */
exports.obtenerSlaHoy = catchAsync(async (req, res) => {
  const { id_usuario, id_configuracion = null } = req.body;

  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }

  // “Hoy” según servidor. Si quiere forzar timezone Ecuador, lo manejamos luego a nivel DB/session.
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const from = `${yyyy}-${mm}-${dd}`;
  const { fromDT, toDT } = buildRange(from, from);

  // Umbral de abandono (por defecto 2 horas sin actividad)
  const ABANDON_HOURS = Number(process.env.SLA_ABANDON_HOURS || 2);

  // Resueltos hoy (por canal)
  const resolvedByChannel = await db.query(
    `
    SELECT
      ccc.source,
      COUNT(*) AS total
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ig','ms')
      AND ccc.chat_cerrado = 1
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.updated_at BETWEEN ? AND ?
    GROUP BY ccc.source
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  // Abandonados hoy (por canal): pendientes que llevan >= ABANDON_HOURS sin actividad
  const abandonedByChannel = await db.query(
    `
    SELECT
      ccc.source,
      COUNT(*) AS total
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ig','ms')
      AND ccc.chat_cerrado = 0
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.updated_at BETWEEN ? AND ?
      AND TIMESTAMPDIFF(HOUR, ccc.updated_at, NOW()) >= ?
    GROUP BY ccc.source
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT, ABANDON_HOURS]
        : [id_usuario, fromDT, toDT, ABANDON_HOURS],
      type: db.QueryTypes.SELECT,
    },
  );

  const resolvedMap = new Map(
    resolvedByChannel.map((r) => [r.source, Number(r.total || 0)]),
  );
  const abandonedMap = new Map(
    abandonedByChannel.map((r) => [r.source, Number(r.total || 0)]),
  );

  const sources = ['wa', 'ms', 'ig'];
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

  // En su caso “Meta” = todos los canales que maneja (wa/ms/ig)
  const metaPct = generalPct;

  return res.json({
    status: 'success',
    data: {
      generalPct,
      metaPct,
      channels,
      resolvedToday,
      abandoned,
      meta: {
        date: from,
        abandonHours: ABANDON_HOURS,
        id_configuracion: id_configuracion || null,
      },
    },
  });
});

/**
 * 3) CHARTS (todo lo que falta en el front)
 * - byChannel
 * - byConnection
 * - firstResponseHourly (promedio por hora)
 * - resolutionHourly (vacío por ahora)
 * - chatsCreatedHourly
 * - chatsResolvedHourly
 */
exports.obtenerCharts = catchAsync(async (req, res) => {
  const { id_usuario, id_configuracion = null, from, to } = req.body;

  if (!id_usuario) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta id_usuario' });
  }
  if (!from || !to) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Falta rango de fechas (from/to)' });
  }

  const { fromDT, toDT } = buildRange(from, to);

  // --- Chats por canal (conteo de contactos creados)
  const byChannel = await db.query(
    `
    SELECT
      UPPER(ccc.source) AS name,
      COUNT(*) AS value
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ig','ms')
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.created_at BETWEEN ? AND ?
    GROUP BY ccc.source
    ORDER BY value DESC
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  // --- Chats por conexión (conteo de contactos creados)
  const byConnection = await db.query(
    `
    SELECT
      cfg.nombre_configuracion AS name,
      COUNT(*) AS value
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ig','ms')
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.created_at BETWEEN ? AND ?
    GROUP BY cfg.id, cfg.nombre_configuracion
    ORDER BY value DESC
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  // --- Chats creados por hora
  const chatsCreatedHourly = await db.query(
    `
    SELECT
      DATE_FORMAT(ccc.created_at, '%H:00') AS hour,
      COUNT(*) AS chats
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ig','ms')
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.created_at BETWEEN ? AND ?
    GROUP BY hour
    ORDER BY hour ASC
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  // --- Chats resueltos por hora (proxy: updated_at cuando chat_cerrado=1)
  const chatsResolvedHourly = await db.query(
    `
    SELECT
      DATE_FORMAT(ccc.updated_at, '%H:00') AS hour,
      COUNT(*) AS resolved
    FROM clientes_chat_center ccc
    INNER JOIN configuraciones cfg ON cfg.id = ccc.id_configuracion
    WHERE cfg.id_usuario = ?
      AND ccc.deleted_at IS NULL
      AND ccc.propietario = 0
      AND ccc.source IN ('wa','ig','ms')
      AND ccc.chat_cerrado = 1
      ${id_configuracion ? 'AND ccc.id_configuracion = ?' : ''}
      AND ccc.updated_at BETWEEN ? AND ?
    GROUP BY hour
    ORDER BY hour ASC
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  // --- Tiempo promedio de primera respuesta por hora (SQL directo, sin unions gigantes)
  // Definición:
  //  - first_in: min(created_at) de mensajes del cliente (rol_mensaje=0) por (id_configuracion, id_cliente)
  //  - first_out: min(created_at) posterior donde rol_mensaje=1 y celular_recibe = contact_id
  //  - agrupamos por hora(first_in_at)
  const firstResponseHourly = await db.query(
    `
    WITH first_in AS (
      SELECT
        mc.id_configuracion,
        mc.id_cliente AS contact_id,
        MIN(mc.created_at) AS first_in_at
      FROM mensajes_clientes mc
      INNER JOIN configuraciones cfg ON cfg.id = mc.id_configuracion
      WHERE cfg.id_usuario = ?
        AND mc.deleted_at IS NULL
        AND mc.rol_mensaje = 0
        ${id_configuracion ? 'AND mc.id_configuracion = ?' : ''}
        AND mc.created_at BETWEEN ? AND ?
      GROUP BY mc.id_configuracion, mc.id_cliente
    ),
    first_out AS (
      SELECT
        fi.id_configuracion,
        fi.contact_id,
        fi.first_in_at,
        MIN(mo.created_at) AS first_out_at
      FROM first_in fi
      LEFT JOIN mensajes_clientes mo
        ON mo.id_configuracion = fi.id_configuracion
       AND mo.deleted_at IS NULL
       AND mo.rol_mensaje = 1
       AND mo.celular_recibe = fi.contact_id
       AND mo.created_at > fi.first_in_at
      GROUP BY fi.id_configuracion, fi.contact_id, fi.first_in_at
    )
    SELECT
      DATE_FORMAT(first_in_at, '%H:00') AS hour,
      AVG(TIMESTAMPDIFF(SECOND, first_in_at, first_out_at)) AS avgSeconds,
      COUNT(*) AS chats
    FROM first_out
    WHERE first_out_at IS NOT NULL
    GROUP BY hour
    ORDER BY hour ASC
    `,
    {
      replacements: id_configuracion
        ? [id_usuario, id_configuracion, fromDT, toDT]
        : [id_usuario, fromDT, toDT],
      type: db.QueryTypes.SELECT,
    },
  );

  // --- Tiempo promedio de resolución por hora (NO disponible aún)
  const resolutionHourly = []; // luego: con chat_cerrado_at o tabla de eventos

  return res.json({
    status: 'success',
    data: {
      byChannel,
      byConnection,
      firstResponseHourly: firstResponseHourly.map((r) => ({
        hour: r.hour,
        avgSeconds:
          r.avgSeconds === null ? null : Math.round(Number(r.avgSeconds)),
        chats: Number(r.chats || 0),
      })),
      resolutionHourly,
      chatsCreatedHourly: chatsCreatedHourly.map((r) => ({
        hour: r.hour,
        chats: Number(r.chats || 0),
      })),
      chatsResolvedHourly: chatsResolvedHourly.map((r) => ({
        hour: r.hour,
        resolved: Number(r.resolved || 0),
      })),
      meta: { from, to, id_configuracion: id_configuracion || null },
    },
  });
});
