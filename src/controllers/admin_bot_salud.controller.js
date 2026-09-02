// controllers/admin_bot_salud.controller.js
// Tablero superadmin "Salud del bot": lee el snapshot bot_metricas_diarias
// (lo llena el cron botMetricasSnapshot) para responder al instante. Solo el
// desglose de fallos de auto-orden se consulta en vivo porque esa tabla es
// chica. Todo protegido con requireSuperAdmin en la ruta.
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const { recalcularVentana } = require('../services/botMetricas.service');

function rangoDias(req) {
  return Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 90);
}

async function q(sql, replacements = []) {
  return db.query(sql, { replacements, type: db.QueryTypes.SELECT });
}

const CAMPOS_SUMA = `
  SUM(convers_ia)            AS convers_ia,
  SUM(convers_respondieron)  AS convers_respondieron,
  SUM(respuestas_ia)         AS respuestas_ia,
  SUM(auto_intentos)         AS auto_intentos,
  SUM(auto_creadas)          AS auto_creadas,
  SUM(auto_fallidas)         AS auto_fallidas,
  SUM(ordenes_total)         AS ordenes_total,
  SUM(cierres_bot)           AS cierres_bot,
  SUM(entregadas_bot)        AS entregadas_bot,
  SUM(canceladas_bot)        AS canceladas_bot`;

/* ══════════════════════════════════════════════════════════════
   GET /admin_bot_salud/resumen?dias=30
   KPIs globales del período + comparación con el período anterior
   + serie diaria para el gráfico.
   ══════════════════════════════════════════════════════════════ */
exports.resumen = catchAsync(async (req, res) => {
  const dias = rangoDias(req);

  const [actual] = await q(
    `SELECT ${CAMPOS_SUMA}
       FROM bot_metricas_diarias
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [dias],
  );
  const [previo] = await q(
    `SELECT ${CAMPOS_SUMA}
       FROM bot_metricas_diarias
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND fecha <  DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [dias * 2, dias],
  );

  const serie = await q(
    `SELECT fecha, ${CAMPOS_SUMA}
       FROM bot_metricas_diarias
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY fecha
      ORDER BY fecha ASC`,
    [dias],
  );

  const [cuentasIA] = await q(
    `SELECT COUNT(DISTINCT id_configuracion) AS n
       FROM bot_metricas_diarias
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND convers_ia > 0`,
    [dias],
  );

  const [ultimaCorrida] = await q(
    `SELECT MAX(updated_at) AS ultima FROM bot_metricas_diarias`,
  );

  res.json({
    status: 'success',
    data: {
      dias,
      actual: actual || {},
      previo: previo || {},
      serie,
      cuentas_con_ia: Number(cuentasIA?.n || 0),
      snapshot_actualizado: ultimaCorrida?.ultima || null,
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   GET /admin_bot_salud/cuentas?dias=30
   Tabla por cuenta: volumen, % respuesta, % cierre, % entrega,
   con nombre y modelos de IA configurados.
   ══════════════════════════════════════════════════════════════ */
exports.cuentas = catchAsync(async (req, res) => {
  const dias = rangoDias(req);

  const rows = await q(
    `
    SELECT m.id_configuracion,
           c.nombre_configuracion,
           c.telefono,
           ${CAMPOS_SUMA},
           (SELECT GROUP_CONCAT(DISTINCT COALESCE(kc.modelo, 'default'))
              FROM kanban_columnas kc
             WHERE kc.id_configuracion = m.id_configuracion
               AND kc.activo = 1 AND kc.activa_ia = 1) AS modelos
      FROM bot_metricas_diarias m
      LEFT JOIN configuraciones c ON c.id = m.id_configuracion
     WHERE m.fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY m.id_configuracion, c.nombre_configuracion, c.telefono
    HAVING SUM(m.convers_ia) > 0 OR SUM(m.ordenes_total) > 0
     ORDER BY SUM(m.convers_ia) DESC
    `,
    [dias],
  );

  const data = rows.map((r) => {
    const convers = Number(r.convers_ia) || 0;
    const cierres = Number(r.cierres_bot) || 0;
    const respond = Number(r.convers_respondieron) || 0;
    const entreg = Number(r.entregadas_bot) || 0;
    return {
      id_configuracion: r.id_configuracion,
      nombre: r.nombre_configuracion || '(sin nombre)',
      telefono: r.telefono || null,
      modelos: r.modelos || null,
      convers_ia: convers,
      convers_dia: Number((convers / dias).toFixed(1)),
      convers_respondieron: respond,
      pct_respuesta: convers ? Number(((respond / convers) * 100).toFixed(1)) : null,
      auto_intentos: Number(r.auto_intentos) || 0,
      auto_creadas: Number(r.auto_creadas) || 0,
      auto_fallidas: Number(r.auto_fallidas) || 0,
      ordenes_total: Number(r.ordenes_total) || 0,
      cierres_bot: cierres,
      pct_cierre: convers ? Number(((cierres / convers) * 100).toFixed(1)) : null,
      entregadas_bot: entreg,
      pct_entrega: convers ? Number(((entreg / convers) * 100).toFixed(1)) : null,
      canceladas_bot: Number(r.canceladas_bot) || 0,
    };
  });

  res.json({ status: 'success', dias, total: data.length, data });
});

/* ══════════════════════════════════════════════════════════════
   GET /admin_bot_salud/embudo?dias=30[&id_configuracion=610]
   Embudo global (o de una cuenta) + desglose de fallos del
   auto-orden (paso_fallo) para ubicar el cuello de botella.
   ══════════════════════════════════════════════════════════════ */
exports.embudo = catchAsync(async (req, res) => {
  const dias = rangoDias(req);
  const idConfig = parseInt(req.query.id_configuracion, 10) || null;
  const filtroCfg = idConfig ? 'AND id_configuracion = ?' : '';
  const repl = idConfig ? [dias, idConfig] : [dias];

  const [tot] = await q(
    `SELECT ${CAMPOS_SUMA}
       FROM bot_metricas_diarias
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${filtroCfg}`,
    repl,
  );

  // Motivos de fallo del auto-orden, en vivo (tabla chica).
  const fallos = await q(
    `SELECT COALESCE(paso_fallo, '(sin paso)') AS paso, COUNT(*) AS n
       FROM dropi_auto_ordenes_log
      WHERE resultado = 'fallida'
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${filtroCfg}
      GROUP BY paso_fallo
      ORDER BY n DESC
      LIMIT 12`,
    repl,
  );

  const n = (v) => Number(v) || 0;
  const convers = n(tot?.convers_ia);
  res.json({
    status: 'success',
    dias,
    id_configuracion: idConfig,
    data: {
      /* El auto-orden NO es un paso del embudo: la mayoría de órdenes se
         crean a mano en el panel, así que iría "hacia atrás". Se reporta
         aparte en `auto`. */
      embudo: [
        { paso: 'Conversaciones IA', valor: convers },
        { paso: 'Cliente respondió', valor: n(tot?.convers_respondieron) },
        { paso: 'Cierres (orden creada)', valor: n(tot?.cierres_bot) },
        { paso: 'Entregadas', valor: n(tot?.entregadas_bot) },
      ],
      auto: {
        intentos: n(tot?.auto_intentos),
        creadas: n(tot?.auto_creadas),
        fallidas: n(tot?.auto_fallidas),
      },
      fallos_auto_orden: fallos.map((f) => ({ paso: f.paso, n: Number(f.n) })),
      canceladas: n(tot?.canceladas_bot),
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /admin_bot_salud/recalcular  { dias?: 35 }
   Botón "recalcular ahora". Tarda ~1 min: recorre mensajes y
   órdenes de la ventana y reescribe el snapshot.
   ══════════════════════════════════════════════════════════════ */
exports.recalcular = catchAsync(async (req, res) => {
  const dias = Math.min(Math.max(parseInt(req.body?.dias, 10) || 35, 1), 120);
  const resultado = await recalcularVentana(dias);
  res.json({ status: 'success', data: resultado });
});
