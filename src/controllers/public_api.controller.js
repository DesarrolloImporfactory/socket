/* ═══════════════════════════════════════════════════════════
   API pública de métricas (v1)

   El tercero autentica con su API key y siempre lee la conexión
   dueña de esa key (nunca manda id_configuracion). Todo es GET y de
   solo lectura; reutiliza los mismos cálculos del panel para que los
   números no se puedan desviar entre el dashboard y la API.
   ═══════════════════════════════════════════════════════════ */
const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { _internal: dropi } = require('./dropi_integrations.controller');
const { buildAdsDashboard } = require('./marketing_control.controller');
const ApiKeys = require('../models/api_keys.model');
const { generarKey } = require('../middlewares/apiKey.middleware');

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/* Rango del periodo. Sin parámetros → últimos 30 días. */
function resolverRango(req) {
  const hoy = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const from = String(req.query.from || req.query.since || '').trim();
  const until = String(req.query.until || '').trim();

  if (!from && !until) {
    const desde = new Date(hoy);
    desde.setDate(desde.getDate() - 29);
    return { from: iso(desde), until: iso(hoy) };
  }
  if (!YMD.test(from) || !YMD.test(until))
    throw new AppError(
      'Rango inválido. Usa from y until en formato YYYY-MM-DD.',
      400,
    );
  if (from > until)
    throw new AppError('from no puede ser mayor que until.', 400);
  return { from, until };
}

/* Conteo por columna del kanban. Compartido por /tablero y /todo. */
async function leerTablero(id_configuracion) {
  const columnas = await db.query(
    `SELECT k.estado_db, k.nombre, k.orden,
            COUNT(cc.id) AS clientes
       FROM kanban_columnas k
       LEFT JOIN clientes_chat_center cc
              ON cc.id_configuracion = k.id_configuracion
             AND cc.deleted_at IS NULL
             AND cc.estado_contacto = k.estado_db
      WHERE k.id_configuracion = :cfg AND k.activo = 1
      GROUP BY k.id, k.estado_db, k.nombre, k.orden
      ORDER BY k.orden`,
    { replacements: { cfg: id_configuracion }, type: db.QueryTypes.SELECT },
  );

  const porEstado = Object.fromEntries(
    columnas.map((c) => [c.estado_db, Number(c.clientes || 0)]),
  );

  return {
    // Atajo a las columnas que se piden siempre, sin recorrer el arreglo
    destacados: {
      contacto_inicial: porEstado.contacto_inicial ?? 0,
      generar_guia: porEstado.generar_guia ?? 0,
      asesor: porEstado.asesor ?? 0,
    },
    columnas: columnas.map((c) => ({
      estado: c.estado_db,
      nombre: c.nombre,
      orden: Number(c.orden || 0),
      clientes: Number(c.clientes || 0),
    })),
    total_clientes: columnas.reduce((s, c) => s + Number(c.clientes || 0), 0),
  };
}

/* Arma el bloque `resumen` a partir del summary crudo.
   Todo sale del mismo objeto que pinta el dashboard de la conexión: si el
   panel muestra un KPI, acá tiene que estar el mismo número. */
const formatearResumen = (d) => {
  // El dashboard encabeza con los pedidos NETOS (sin cancelados) y con la
  // tasa de entrega sobre esa base; sin `canceladas` el tercero no podía
  // reproducir esas dos cifras y le salían distintas a las del panel.
  const pedidosNeto = Math.max(
    0,
    Number(d.totalPedidos || 0) - Number(d.canceladas || 0),
  );
  return {
    ventas: {
      pedidos: d.totalPedidos,
      canceladas: d.canceladas,
      pedidos_neto: pedidosNeto,
      facturado: d.totalFacturado,
      ganancia: d.totalGanancia,
      entregadas: d.entregadas,
      tasa_entrega_pct: d.tasaEntrega,
      // Igual que el panel: entregadas ÷ pedidos vivos (sin cancelados).
      tasa_entrega_real_pct:
        pedidosNeto > 0
          ? Math.round((d.entregadas / pedidosNeto) * 10000) / 100
          : 0,
    },
    conversaciones: {
      total: d.totalConversaciones,
      mensajes_recibidos: d.totalMensajes,
      con_pedido: d.conversacionesConPedido,
      // null = en el periodo nadie escribió, no hay embudo que medir
      pct_confirmacion: d.pctConfirmacion,
    },
    canales: d.canales,
    carritos_abandonados: d.carritos,
    shopify: {
      conectado: d.shopifyConectado,
      // Checkouts detectados por el webhook + ventas Shopify que solo
      // aparecen en Dropi (el mismo dato del KPI "Pedidos Shopify").
      leads: d.shopifyLeads,
      // true → el split WA/Shopify está validado contra el webhook real
      validado_con_webhook: d.shopifyTruth,
    },
    integraciones: {
      meta_ads: d.metaAds,
      shopify_webhook: d.shopifyTruth,
      anuncios_ctwa_activos: d.ctwaActivo,
    },
  };
};

/* Mismo resumen (y misma caché de 5 min) que sirve al dashboard del panel.
   Va por la caché a propósito: garantiza que el tercero lea la MISMA foto
   que ve el cliente en pantalla y evita repetir ~12 queries pesadas en cada
   llamada externa (el rate limit permite 60 por minuto por llave). */
const leerResumen = async (id_configuracion, from, until) => {
  const { data } = await dropi.getConnectionSummaryCached({
    id_configuracion,
    from,
    until,
  });
  return data;
};

// ── GET /ping ──────────────────────────────────────────────
exports.ping = catchAsync(async (req, res) => {
  const [cfg] = await db.query(
    `SELECT nombre_configuracion, telefono FROM configuraciones WHERE id = :id`,
    { replacements: { id: req.id_configuracion }, type: db.QueryTypes.SELECT },
  );
  return res.json({
    ok: true,
    conexion: {
      id_configuracion: req.id_configuracion,
      nombre: cfg?.nombre_configuracion || null,
      telefono: cfg?.telefono || null,
    },
    key: { nombre: req.apiKey.nombre },
    server_time: new Date().toISOString(),
  });
});

// ── GET /resumen ───────────────────────────────────────────
// KPIs del periodo: ventas, conversaciones, embudo y canales.
exports.resumen = catchAsync(async (req, res) => {
  const { from, until } = resolverRango(req);
  const d = await leerResumen(req.id_configuracion, from, until);

  return res.json({ rango: { from, until }, ...formatearResumen(d) });
});

// ── GET /dropi ─────────────────────────────────────────────
// Detalle de operación: estados de las órdenes, productos y serie diaria.
exports.dropiDashboard = catchAsync(async (req, res) => {
  const { from, until } = resolverRango(req);
  const d = await leerResumen(req.id_configuracion, from, until);

  return res.json({
    rango: { from, until },
    totales: {
      pedidos: d.totalPedidos,
      entregadas: d.entregadas,
      facturado: d.totalFacturado,
      ganancia: d.totalGanancia,
    },
    estados: d.statusBreakdown,
    productos: d.productos,
    serie_diaria: d.dailyChart,
  });
});

// ── GET /ads ───────────────────────────────────────────────
// Embudo publicitario y atribución anuncio → orden Dropi.
exports.adsDashboard = catchAsync(async (req, res) => {
  const { from, until } = resolverRango(req);
  const data = await buildAdsDashboard({
    id_configuracion: req.id_configuracion,
    since: from,
    until,
    limit: Math.min(50, parseInt(req.query.limit || '30', 10)),
  });
  return res.json(data);
});

// ── GET /tablero ───────────────────────────────────────────
// Cuántos clientes hay ahora mismo en cada columna del kanban.
exports.tablero = catchAsync(async (req, res) => {
  const tablero = await leerTablero(req.id_configuracion);
  return res.json({ generado_en: new Date().toISOString(), ...tablero });
});

// ── GET /todo ──────────────────────────────────────────────
// Resumen + dropi + ads + tablero en una sola llamada. Pensado para
// sincronizaciones periódicas: el summary se calcula UNA vez y se
// reparte, así cuesta menos que pedir los 4 endpoints por separado.
exports.todo = catchAsync(async (req, res) => {
  const { from, until } = resolverRango(req);
  const limit = Math.min(50, parseInt(req.query.limit || '30', 10));

  const [summary, tablero, ads] = await Promise.all([
    leerResumen(req.id_configuracion, from, until),
    leerTablero(req.id_configuracion),
    // Sin cuenta de Meta conectada el resto igual debe responder
    buildAdsDashboard({
      id_configuracion: req.id_configuracion,
      since: from,
      until,
      limit,
    }).catch((e) => ({ disponible: false, motivo: e?.message || 'sin datos' })),
  ]);

  return res.json({
    rango: { from, until },
    generado_en: new Date().toISOString(),
    resumen: formatearResumen(summary),
    dropi: {
      totales: {
        pedidos: summary.totalPedidos,
        entregadas: summary.entregadas,
        facturado: summary.totalFacturado,
        ganancia: summary.totalGanancia,
      },
      estados: summary.statusBreakdown,
      productos: summary.productos,
      serie_diaria: summary.dailyChart,
    },
    ads,
    tablero,
  });
});

// ── GET /ventas/respuestas ──────────────────────────────────
// Retorna envíos salientes (scope ventas por defecto) y marca si el cliente
// respondió después del envío. Señal primaria: context_wamid; fallback: teléfono.
exports.ventasRespuestas = catchAsync(async (req, res) => {
  const { from, until } = resolverRango(req);
  const limit = Math.min(
    500,
    Math.max(1, parseInt(req.query.limit || '100', 10)),
  );
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

  // Modo prueba: permitir consultar explícitamente la configuración 242
  // sin depender de la API key dueña, pero solo fuera de producción o
  // cuando se habilite por env.
  const requestedCfg = Number(req.query.id_configuracion || 0);
  const allow242 =
    String(process.env.PUBLIC_API_ALLOW_CONFIG_242 || '0') === '1' ||
    process.env.NODE_ENV !== 'production';
  const idConfiguracionObjetivo =
    allow242 && requestedCfg === 242 ? 242 : Number(req.id_configuracion);

  const scope = String(req.query.scope || 'ventas')
    .trim()
    .toLowerCase();
  const responsableLike = String(req.query.responsable_like || '').trim();
  const responsables = String(req.query.responsables || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const fromTs = `${from} 00:00:00`;
  const untilTs = `${until} 23:59:59`;

  const norm = (col) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '+', ''), '-', ''), '(', ''), ')', '')`;

  const where = [
    'm.id_configuracion = ?',
    'm.deleted_at IS NULL',
    'm.rol_mensaje = 1',
    "(m.source = 'wa' OR m.source IS NULL)",
    'm.created_at BETWEEN ? AND ?',
    `${norm('m.uid_whatsapp')} <> ''`,
  ];

  const replacements = [idConfiguracionObjetivo, fromTs, untilTs];

  // Scope por defecto: mensajes de ventas (asistente + remarketing).
  if (scope === 'ventas') {
    where.push(
      "(m.responsable LIKE '%ventas%' OR m.responsable LIKE 'cron_remarketing_%')",
    );
  }

  if (responsableLike) {
    where.push('m.responsable LIKE ?');
    replacements.push(`%${responsableLike}%`);
  }

  if (responsables.length) {
    where.push(`m.responsable IN (${responsables.map(() => '?').join(',')})`);
    replacements.push(...responsables);
  }

  const whereSql = where.join(' AND ');

  const listSql = `
    SELECT
      m.id,
      m.created_at AS fecha_envio,
      m.uid_whatsapp AS telefono,
      m.id_wamid_mensaje AS wamid,
      m.responsable,
      m.template_name,
      m.tipo_mensaje,
      LEFT(COALESCE(m.texto_mensaje, ''), 180) AS preview_mensaje,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM mensajes_clientes r
          WHERE r.id_configuracion = m.id_configuracion
            AND r.deleted_at IS NULL
            AND r.rol_mensaje = 0
            AND r.created_at >= m.created_at
            AND m.id_wamid_mensaje IS NOT NULL
            AND m.id_wamid_mensaje <> ''
            AND r.context_wamid = m.id_wamid_mensaje
        ) THEN 1
        WHEN EXISTS (
          SELECT 1
          FROM mensajes_clientes r
          WHERE r.id_configuracion = m.id_configuracion
            AND r.deleted_at IS NULL
            AND r.rol_mensaje = 0
            AND r.created_at >= m.created_at
            AND ${norm('r.uid_whatsapp')} = ${norm('m.uid_whatsapp')}
        ) THEN 1
        ELSE 0
      END AS si_respondio,
      (
        SELECT MIN(r.created_at)
        FROM mensajes_clientes r
        WHERE r.id_configuracion = m.id_configuracion
          AND r.deleted_at IS NULL
          AND r.rol_mensaje = 0
          AND r.created_at >= m.created_at
          AND (
            (m.id_wamid_mensaje IS NOT NULL AND m.id_wamid_mensaje <> '' AND r.context_wamid = m.id_wamid_mensaje)
            OR ${norm('r.uid_whatsapp')} = ${norm('m.uid_whatsapp')}
          )
      ) AS fecha_respuesta,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM mensajes_clientes r
          WHERE r.id_configuracion = m.id_configuracion
            AND r.deleted_at IS NULL
            AND r.rol_mensaje = 0
            AND r.created_at >= m.created_at
            AND m.id_wamid_mensaje IS NOT NULL
            AND m.id_wamid_mensaje <> ''
            AND r.context_wamid = m.id_wamid_mensaje
        ) THEN 'context_wamid'
        WHEN EXISTS (
          SELECT 1
          FROM mensajes_clientes r
          WHERE r.id_configuracion = m.id_configuracion
            AND r.deleted_at IS NULL
            AND r.rol_mensaje = 0
            AND r.created_at >= m.created_at
            AND ${norm('r.uid_whatsapp')} = ${norm('m.uid_whatsapp')}
        ) THEN 'telefono'
        ELSE NULL
      END AS criterio_respuesta
    FROM mensajes_clientes m
    WHERE ${whereSql}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?`;

  const listRows = await db.query(listSql, {
    replacements: [...replacements, limit, offset],
    type: db.QueryTypes.SELECT,
  });

  const resumenSql = `
    SELECT
      COUNT(*) AS total_envios,
      SUM(
        CASE WHEN EXISTS (
          SELECT 1
          FROM mensajes_clientes r
          WHERE r.id_configuracion = m.id_configuracion
            AND r.deleted_at IS NULL
            AND r.rol_mensaje = 0
            AND r.created_at >= m.created_at
            AND (
              (m.id_wamid_mensaje IS NOT NULL AND m.id_wamid_mensaje <> '' AND r.context_wamid = m.id_wamid_mensaje)
              OR ${norm('r.uid_whatsapp')} = ${norm('m.uid_whatsapp')}
            )
        ) THEN 1 ELSE 0 END
      ) AS total_respondidos,
      COUNT(DISTINCT ${norm('m.uid_whatsapp')}) AS telefonos_enviados,
      COUNT(
        DISTINCT CASE WHEN EXISTS (
          SELECT 1
          FROM mensajes_clientes r
          WHERE r.id_configuracion = m.id_configuracion
            AND r.deleted_at IS NULL
            AND r.rol_mensaje = 0
            AND r.created_at >= m.created_at
            AND (
              (m.id_wamid_mensaje IS NOT NULL AND m.id_wamid_mensaje <> '' AND r.context_wamid = m.id_wamid_mensaje)
              OR ${norm('r.uid_whatsapp')} = ${norm('m.uid_whatsapp')}
            )
        ) THEN ${norm('m.uid_whatsapp')} ELSE NULL END
      ) AS telefonos_respondieron
    FROM mensajes_clientes m
    WHERE ${whereSql}`;

  const [resumenRaw] = await db.query(resumenSql, {
    replacements,
    type: db.QueryTypes.SELECT,
  });

  const totalEnvios = Number(resumenRaw?.total_envios || 0);
  const totalRespondidos = Number(resumenRaw?.total_respondidos || 0);
  const telefonosEnviados = Number(resumenRaw?.telefonos_enviados || 0);
  const telefonosRespondieron = Number(resumenRaw?.telefonos_respondieron || 0);

  return res.json({
    rango: { from, until },
    scope,
    id_configuracion_consultada: idConfiguracionObjetivo,
    filtros: {
      responsable_like: responsableLike || null,
      responsables,
      limit,
      offset,
    },
    resumen: {
      total_envios: totalEnvios,
      total_respondidos: totalRespondidos,
      tasa_respuesta_envio_pct:
        totalEnvios > 0
          ? Number(((totalRespondidos * 100) / totalEnvios).toFixed(1))
          : 0,
      telefonos_enviados: telefonosEnviados,
      telefonos_respondieron: telefonosRespondieron,
      tasa_respuesta_telefonos_pct:
        telefonosEnviados > 0
          ? Number(
              ((telefonosRespondieron * 100) / telefonosEnviados).toFixed(1),
            )
          : 0,
    },
    data: listRows,
  });
});

/* ═══════════════════════════════════════════════════════════
   Administración de llaves (panel, con sesión — NO con API key)
   ═══════════════════════════════════════════════════════════ */

exports.crearApiKey = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(
    req.body?.id_configuracion || req.query?.id_configuracion,
  );
  const nombre = String(req.body?.nombre || '').trim();
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!nombre) return next(new AppError('nombre es requerido', 400));

  /* Scopes opcionales (array o "a,b"): por defecto la llave es solo-lectura.
     Los de escritura (bot:write, flujos:write, plantillas:write) se piden
     explícitos al crearla — nunca se amplía una llave ya entregada. */
  const { SCOPES_VALIDOS } = require('./public_config.controller');
  const scopesInput = Array.isArray(req.body?.scopes)
    ? req.body.scopes
    : String(req.body?.scopes || 'read').split(',');
  const scopes = [
    ...new Set(
      scopesInput.map((s) => String(s).trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const invalidos = scopes.filter((s) => !SCOPES_VALIDOS.includes(s));
  if (invalidos.length) {
    return next(
      new AppError(
        `Scopes inválidos: ${invalidos.join(', ')}. Válidos: ${SCOPES_VALIDOS.join(', ')}.`,
        400,
      ),
    );
  }
  if (!scopes.includes('read') && !scopes.includes('*')) scopes.unshift('read');

  const { raw, hash, prefix } = generarKey();
  const row = await ApiKeys.create({
    id_configuracion,
    id_usuario: req.sessionUser?.id_usuario || null,
    nombre,
    key_prefix: prefix,
    key_hash: hash,
  });

  /* La columna scopes llega con api_public_scopes_migration.sql; si aún no
     corrió, la llave queda solo-lectura (el default del middleware) y se
     avisa en la respuesta en vez de fallar la creación. */
  let scopesAplicados = 'read';
  try {
    await db.query(`UPDATE api_keys SET scopes = ? WHERE id = ?`, {
      replacements: [scopes.join(','), row.id],
      type: db.QueryTypes.UPDATE,
    });
    scopesAplicados = scopes.join(',');
  } catch (e) {
    if (!/Unknown column/i.test(e?.message || '')) throw e;
  }

  return res.json({
    isSuccess: true,
    // La key en claro solo se ve acá; después queda solo el hash.
    data: {
      id: row.id,
      nombre,
      api_key: raw,
      key_prefix: prefix,
      scopes: scopesAplicados,
    },
  });
});

exports.listarApiKeys = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(
    req.query?.id_configuracion || req.body?.id_configuracion,
  );
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const keys = await ApiKeys.findAll({
    where: { id_configuracion },
    attributes: [
      'id',
      'nombre',
      'key_prefix',
      'activo',
      'usos',
      'last_used_at',
      'created_at',
      'revoked_at',
    ],
    order: [['id', 'DESC']],
    raw: true,
  });

  /* Scopes por llave (columna de api_public_scopes_migration.sql). Se leen
     aparte y tolerante: sin la migración, el panel muestra "read". */
  try {
    const filas = await db.query(
      `SELECT id, scopes FROM api_keys WHERE id_configuracion = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    const porId = new Map(filas.map((f) => [Number(f.id), f.scopes]));
    for (const k of keys) k.scopes = porId.get(Number(k.id)) || 'read';
  } catch (e) {
    if (!/Unknown column/i.test(e?.message || '')) throw e;
    for (const k of keys) k.scopes = 'read';
  }

  return res.json({ isSuccess: true, data: keys });
});

/* Reutilizable desde otros controladores (la cartera Imporchat del panel del
   chat arma el mismo bloque de KPIs, pero autenticada con la sesión del asesor
   en vez de con una API key). */
exports._internal = { formatearResumen, resolverRango, leerTablero };

exports.revocarApiKey = catchAsync(async (req, res, next) => {
  const id = Number(req.body?.id || req.params?.id);
  const id_configuracion = Number(req.body?.id_configuracion);
  if (!id || !id_configuracion)
    return next(new AppError('id e id_configuracion son requeridos', 400));

  const [n] = await ApiKeys.update(
    { activo: 0, revoked_at: new Date() },
    { where: { id, id_configuracion } },
  );
  if (!n) return next(new AppError('Llave no encontrada', 404));
  return res.json({ isSuccess: true, message: 'Llave revocada' });
});
