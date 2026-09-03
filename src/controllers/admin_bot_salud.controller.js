// controllers/admin_bot_salud.controller.js
// Tablero superadmin "Salud del bot": lee el snapshot bot_metricas_diarias
// (lo llena el cron botMetricasSnapshot) para responder al instante. Todo
// protegido con requireSuperAdmin en la ruta.
//
// El tablero mide SOLO cuentas e-commerce: las que tienen tablero de
// dropshipping (kanban_columnas.es_dropi_principal = 1). Las verticales de
// servicios (citas, inmobiliaria...) no venden por orden Dropi, así que su
// "tasa de cierre" con esta definición saldría 0 y ensuciaría el promedio.
const catchAsync = require('../utils/catchAsync');
const { db } = require('../database/config');
const { recalcularVentana } = require('../services/botMetricas.service');

function rangoDias(req) {
  return Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 90);
}

async function q(sql, replacements = []) {
  return db.query(sql, { replacements, type: db.QueryTypes.SELECT });
}

/* El día en curso está incompleto (mensajes y órdenes siguen entrando):
   incluirlo desploma el final de la serie y la comparativa. Todas las
   ventanas terminan AYER. */
const SIN_HOY = `AND m.fecha < CURDATE()`;

/* Filtro de cuentas e-commerce (m = alias de bot_metricas_diarias). */
const SOLO_ECOMMERCE = `
  AND EXISTS (SELECT 1 FROM kanban_columnas ke
               WHERE ke.id_configuracion = m.id_configuracion
                 AND ke.es_dropi_principal = 1)`;

const CAMPOS_SUMA = `
  SUM(m.convers_ia)            AS convers_ia,
  SUM(m.convers_respondieron)  AS convers_respondieron,
  SUM(m.respuestas_ia)         AS respuestas_ia,
  SUM(m.cierres_kanban)        AS cierres_kanban,
  SUM(m.entregadas_kanban)     AS entregadas_kanban,
  SUM(m.auto_intentos)         AS auto_intentos,
  SUM(m.auto_creadas)          AS auto_creadas,
  SUM(m.auto_fallidas)         AS auto_fallidas,
  SUM(m.ordenes_total)         AS ordenes_total,
  SUM(m.cierres_bot)           AS cierres_bot,
  SUM(m.entregadas_bot)        AS entregadas_bot,
  SUM(m.canceladas_bot)        AS canceladas_bot`;

/* ══════════════════════════════════════════════════════════════
   GET /admin_bot_salud/resumen?dias=30
   KPIs globales del período + comparación con el período anterior
   + serie diaria para el gráfico. Solo cuentas e-commerce.
   ══════════════════════════════════════════════════════════════ */
exports.resumen = catchAsync(async (req, res) => {
  const dias = rangoDias(req);

  const [actual] = await q(
    `SELECT ${CAMPOS_SUMA}
       FROM bot_metricas_diarias m
      WHERE m.fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${SIN_HOY} ${SOLO_ECOMMERCE}`,
    [dias],
  );
  const [previo] = await q(
    `SELECT ${CAMPOS_SUMA}
       FROM bot_metricas_diarias m
      WHERE m.fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND m.fecha <  DATE_SUB(CURDATE(), INTERVAL ? DAY) ${SOLO_ECOMMERCE}`,
    [dias * 2, dias],
  );

  const serie = await q(
    `SELECT m.fecha, ${CAMPOS_SUMA}
       FROM bot_metricas_diarias m
      WHERE m.fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${SIN_HOY} ${SOLO_ECOMMERCE}
      GROUP BY m.fecha
      ORDER BY m.fecha ASC`,
    [dias],
  );

  const [cuentasIA] = await q(
    `SELECT COUNT(DISTINCT m.id_configuracion) AS n
       FROM bot_metricas_diarias m
      WHERE m.fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${SIN_HOY}
        AND m.convers_ia > 0 ${SOLO_ECOMMERCE}`,
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
   Tabla por cuenta (solo e-commerce): volumen, % respuesta,
   % cierre y su delta vs el período anterior — para ver de un
   vistazo si cada bot vende mejor o peor que antes.
   ══════════════════════════════════════════════════════════════ */
exports.cuentas = catchAsync(async (req, res) => {
  const dias = rangoDias(req);

  /* Una sola pasada sobre 2×dias: el CASE separa período actual y anterior. */
  const rows = await q(
    `
    SELECT m.id_configuracion,
           c.nombre_configuracion,
           c.telefono,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.convers_ia ELSE 0 END)           AS convers_ia,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.convers_respondieron ELSE 0 END) AS convers_respondieron,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.auto_creadas ELSE 0 END)         AS auto_creadas,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.auto_fallidas ELSE 0 END)        AS auto_fallidas,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.ordenes_total ELSE 0 END)        AS ordenes_total,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.cierres_kanban ELSE 0 END)       AS cierres_kanban,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.cierres_bot ELSE 0 END)          AS cierres_bot,
           SUM(CASE WHEN m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.entregadas_bot ELSE 0 END)       AS entregadas_bot,
           SUM(CASE WHEN m.fecha <  DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.convers_ia ELSE 0 END)           AS prev_convers_ia,
           SUM(CASE WHEN m.fecha <  DATE_SUB(CURDATE(), INTERVAL :d DAY) THEN m.cierres_kanban ELSE 0 END)       AS prev_cierres_kanban,
           (SELECT GROUP_CONCAT(DISTINCT COALESCE(kc.modelo, 'default'))
              FROM kanban_columnas kc
             WHERE kc.id_configuracion = m.id_configuracion
               AND kc.activo = 1 AND kc.activa_ia = 1) AS modelos
      FROM bot_metricas_diarias m
      LEFT JOIN configuraciones c ON c.id = m.id_configuracion
     WHERE m.fecha >= DATE_SUB(CURDATE(), INTERVAL :d2 DAY) ${SIN_HOY} ${SOLO_ECOMMERCE}
     GROUP BY m.id_configuracion, c.nombre_configuracion, c.telefono
    HAVING convers_ia > 0 OR ordenes_total > 0
     ORDER BY convers_ia DESC
    `,
    { d: dias, d2: dias * 2 },
  );

  /* % de cierre = cierres del KANBAN (el chat llegó a generar_guia o más
     allá) ÷ conversaciones. Las órdenes Dropi quedan como dato secundario. */
  const pctO = (a, b) => (Number(b) > 0 ? (Number(a) / Number(b)) * 100 : null);
  const data = rows.map((r) => {
    const convers = Number(r.convers_ia) || 0;
    const cierres = Number(r.cierres_kanban) || 0;
    const pctCierre = pctO(cierres, convers);
    const pctCierrePrev = pctO(r.prev_cierres_kanban, r.prev_convers_ia);
    return {
      id_configuracion: r.id_configuracion,
      nombre: r.nombre_configuracion || '(sin nombre)',
      telefono: r.telefono || null,
      modelos: r.modelos || null,
      convers_ia: convers,
      convers_dia: Number((convers / dias).toFixed(1)),
      convers_respondieron: Number(r.convers_respondieron) || 0,
      pct_respuesta:
        pctO(r.convers_respondieron, convers) !== null
          ? Number(pctO(r.convers_respondieron, convers).toFixed(1))
          : null,
      auto_creadas: Number(r.auto_creadas) || 0,
      auto_fallidas: Number(r.auto_fallidas) || 0,
      ordenes_total: Number(r.ordenes_total) || 0,
      cierres_kanban: cierres,
      cierres_ordenes: Number(r.cierres_bot) || 0,
      pct_cierre: pctCierre !== null ? Number(pctCierre.toFixed(1)) : null,
      pct_cierre_prev:
        pctCierrePrev !== null ? Number(pctCierrePrev.toFixed(1)) : null,
      /* Delta en PUNTOS porcentuales vs el período anterior (null si no hay
         historia previa). Positivo = el bot vende mejor que antes. */
      delta_cierre:
        pctCierre !== null && pctCierrePrev !== null
          ? Number((pctCierre - pctCierrePrev).toFixed(1))
          : null,
      entregadas_bot: Number(r.entregadas_bot) || 0,
      pct_entrega:
        pctO(r.entregadas_bot, convers) !== null
          ? Number(pctO(r.entregadas_bot, convers).toFixed(1))
          : null,
    };
  });

  res.json({ status: 'success', dias, total: data.length, data });
});

/* ══════════════════════════════════════════════════════════════
   GET /admin_bot_salud/embudo?dias=30[&id_configuracion=610]
   Embudo de conversión global (solo e-commerce) o de una cuenta.
   ══════════════════════════════════════════════════════════════ */
exports.embudo = catchAsync(async (req, res) => {
  const dias = rangoDias(req);
  const idConfig = parseInt(req.query.id_configuracion, 10) || null;

  const filtro = idConfig ? 'AND m.id_configuracion = ?' : SOLO_ECOMMERCE;
  const repl = idConfig ? [dias, idConfig] : [dias];

  const [tot] = await q(
    `SELECT ${CAMPOS_SUMA}
       FROM bot_metricas_diarias m
      WHERE m.fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${SIN_HOY} ${filtro}`,
    repl,
  );

  const n = (v) => Number(v) || 0;
  res.json({
    status: 'success',
    dias,
    id_configuracion: idConfig,
    data: {
      /* Cierre y entrega según el estado del kanban (la señal del propio
         asistente), no según las órdenes Dropi sincronizadas. */
      embudo: [
        { paso: 'Conversaciones IA', valor: n(tot?.convers_ia) },
        { paso: 'Cliente respondió', valor: n(tot?.convers_respondieron) },
        { paso: 'Cerró venta (generar guía)', valor: n(tot?.cierres_kanban) },
        { paso: 'Entregadas', valor: n(tot?.entregadas_kanban) },
      ],
      auto: {
        intentos: n(tot?.auto_intentos),
        creadas: n(tot?.auto_creadas),
        fallidas: n(tot?.auto_fallidas),
      },
      canceladas: n(tot?.canceladas_bot),
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /admin_bot_salud/recalcular  { dias?: 35 }
   Botón "recalcular ahora". Tarda ~1-2 min: recorre mensajes y
   órdenes de la ventana y reescribe el snapshot.
   ══════════════════════════════════════════════════════════════ */
exports.recalcular = catchAsync(async (req, res) => {
  const dias = Math.min(Math.max(parseInt(req.body?.dias, 10) || 35, 1), 120);
  const resultado = await recalcularVentana(dias);
  res.json({ status: 'success', data: resultado });
});
