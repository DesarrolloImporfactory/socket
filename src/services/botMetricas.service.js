// services/botMetricas.service.js
// Rendimiento del bot por cuenta y por día, para el tablero superadmin de
// salud del bot (admin_bot_salud). Todo se precalcula en bot_metricas_diarias
// porque las consultas sobre mensajes_clientes toman decenas de segundos: el
// tablero solo lee el snapshot.
//
// Definiciones:
// - Conversación IA: contacto con al menos un mensaje saliente del bot
//   (rol_mensaje=1, responsable LIKE 'IA_%') ese día.
// - Cierre atribuido al bot: orden de dropi_orders_cache cuyo teléfono tuvo
//   conversación IA en la misma cuenta dentro de los 30 días previos a la
//   orden. Incluye órdenes creadas a mano: si el bot atendió al cliente y el
//   vendedor remató, cuenta como cierre asistido.
//
// El cron recalcula una ventana móvil completa en cada corrida (no solo ayer)
// porque las órdenes Dropi se sincronizan por horas y sus estados
// (entregada/cancelada) cambian días después.

const { db } = require('../database/config');
const BotMetricasDiarias = require('../models/bot_metricas_diarias.model');

const DIAS_ATRIBUCION = 30; // orden atribuida si hubo conversación IA en los 30 días previos

/* Estados del kanban e-commerce que significan "la venta se cerró": el chat
   llegó a generar guía o a cualquier etapa posterior del flujo logístico.

   'cancelados' NO va en esta lista: en esa columna caen dos cosas distintas.
   (a) El pedido que el bot SÍ cerró y después se canceló en Dropi — eso es
       cierre del bot (él vendió; que luego se caiga ya no es su tema).
   (b) El cliente que le dijo que NO al bot (tag [cancelados]:true) — eso
       nunca fue una venta.
   Medido el 2026-10-05 sobre 500 contactos en cancelados: 82 % eran (b). Con
   'cancelados' en la lista, cada rechazo contaba como venta cerrada. Ahora un
   cancelado cuenta SOLO si hay evidencia de que el bot confirmó el pedido:
   escribió el resumen o hubo intento de auto-orden (ver el embudo). */
const ESTADOS_CIERRE = [
  'generar_guia',
  'guia_generada',
  'guia_creada',
  'en_transito',
  'entregada',
  'retiro_agencia',
  'novedad',
  'devolucion',
];

function normTel(t) {
  const d = String(t || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

function fechaStr(d) {
  if (!d) return null;
  if (d instanceof Date) {
    // La conexión ya viene en -05:00; toISOString la movería de día.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  return String(d).slice(0, 10);
}

async function q(sql, replacements = []) {
  return db.query(sql, { replacements, type: db.QueryTypes.SELECT });
}

/* ¿Ya existe bot_metricas_diarias.cierres_respondieron? La migración la
   aplica una persona a mano y el código puede llegar antes al servidor: sin
   este chequeo, el upsert nocturno y el tablero reventarían por "Unknown
   column". Mientras falte, todo sigue como antes (y el tablero cae al
   cálculo viejo). Se consulta una vez por proceso hasta que aparezca. */
let _tieneCierresResp = null;
async function tieneCierresRespondieron() {
  if (_tieneCierresResp === true) return true;
  try {
    const cols = await q(
      `SHOW COLUMNS FROM bot_metricas_diarias LIKE 'cierres_respondieron'`,
    );
    _tieneCierresResp = cols.length > 0;
  } catch (_) {
    _tieneCierresResp = false;
  }
  return _tieneCierresResp;
}

/**
 * Recalcula la ventana [hoy - diasVentana, hoy] y hace upsert en
 * bot_metricas_diarias. Devuelve un resumen de la corrida.
 */
async function recalcularVentana(diasVentana = 35) {
  const t0 = Date.now();
  const dias = Math.min(Math.max(Number(diasVentana) || 35, 1), 120);

  /* 1) Embudo de conversación por (día, cuenta). Todo se agrega en MySQL:
        el detalle por contacto solo vive en la tabla derivada. El join a
        clientes_chat_center trae el estado ACTUAL del kanban: una
        conversación cuenta como cierre si ese contacto llegó a
        generar_guia o más allá (no hay historial de cambios de estado,
        así que los días recientes maduran con cada recálculo). */
  const listaCierre = ESTADOS_CIERRE.map(() => '?').join(',');
  const embudo = await q(
    `
    SELECT t.fecha, t.id_configuracion,
           COUNT(*)                                    AS convers_ia,
           SUM(t.ultimo_in > t.primer_ia)              AS convers_respondieron,
           SUM(t.resp_ia)                              AS respuestas_ia,
           SUM(
             cc.estado_contacto IN (${listaCierre})
             OR (cc.estado_contacto = 'cancelados'
                 AND (t.resumen_bot = 1 OR al.id_cliente IS NOT NULL))
           )                                           AS cierres_kanban,
           /* Mismo criterio de cierre, solo entre quienes respondieron ese
              día: numerador del "% de cierre sobre quienes conversaron". */
           SUM(
             t.ultimo_in > t.primer_ia
             AND (cc.estado_contacto IN (${listaCierre})
                  OR (cc.estado_contacto = 'cancelados'
                      AND (t.resumen_bot = 1 OR al.id_cliente IS NOT NULL)))
           )                                           AS cierres_respondieron,
           SUM(cc.estado_contacto = 'entregada')       AS entregadas_kanban
      FROM (
        SELECT DATE(created_at) AS fecha,
               id_configuracion,
               celular_recibe,
               SUM(rol_mensaje = 1 AND responsable LIKE 'IA\\_%') AS resp_ia,
               MIN(CASE WHEN rol_mensaje = 1 AND responsable LIKE 'IA\\_%'
                        THEN created_at END)           AS primer_ia,
               MAX(CASE WHEN rol_mensaje = 0 THEN created_at END) AS ultimo_in,
               /* El bot escribió el resumen del pedido ese día (rótulos del
                  cierre): es la confirmación, aunque después se cancele. */
               MAX(rol_mensaje = 1 AND responsable LIKE 'IA\\_%'
                   AND texto_mensaje LIKE '%Producto:%'
                   AND (texto_mensaje LIKE '%Nombre:%'
                        OR texto_mensaje LIKE '%Cliente:%')) AS resumen_bot
          FROM mensajes_clientes
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY DATE(created_at), id_configuracion, celular_recibe
        HAVING resp_ia > 0
      ) t
      LEFT JOIN clientes_chat_center cc ON cc.id = t.celular_recibe
      /* Intento de auto-orden = el bot cerró con su tag (tabla chica). La
         ventana va más atrás que la del embudo: el pedido pudo confirmarse
         días antes de la conversación que se está contando. */
      LEFT JOIN (
        SELECT DISTINCT id_cliente
          FROM dropi_auto_ordenes_log
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ) al ON al.id_cliente = t.celular_recibe
     GROUP BY t.fecha, t.id_configuracion
    `,
    [...ESTADOS_CIERRE, ...ESTADOS_CIERRE, dias, dias + 30],
  );

  /* 2) Auto-orden por (día, cuenta). Tabla chica, directo. */
  const auto = await q(
    `
    SELECT DATE(created_at) AS fecha, id_configuracion,
           COUNT(*)                          AS auto_intentos,
           SUM(resultado = 'creada')         AS auto_creadas,
           SUM(resultado = 'fallida')        AS auto_fallidas
      FROM dropi_auto_ordenes_log
     WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(created_at), id_configuracion
    `,
    [dias],
  );

  /* 3) Órdenes de la ventana (para total y atribución por teléfono). */
  const ordenes = await q(
    `
    SELECT id_configuracion, phone, classified_status,
           DATE(order_created_at) AS fecha, order_created_at
      FROM dropi_orders_cache
     WHERE order_created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `,
    [dias],
  );

  /* 4) Actividad IA por contacto (ventana + 30 días hacia atrás para poder
        atribuir las órdenes del inicio de la ventana), con el teléfono real
        del contacto. celular_recibe guarda el ID de clientes_chat_center. */
  const contactos = await q(
    `
    SELECT mc.id_configuracion,
           COALESCE(NULLIF(cc.telefono_limpio, ''), cc.celular_cliente) AS telefono,
           mc.primer_ia, mc.ultimo_ia
      FROM (
        SELECT id_configuracion, celular_recibe,
               MIN(created_at) AS primer_ia,
               MAX(created_at) AS ultimo_ia
          FROM mensajes_clientes
         WHERE rol_mensaje = 1
           AND responsable LIKE 'IA\\_%'
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY id_configuracion, celular_recibe
      ) mc
      LEFT JOIN clientes_chat_center cc ON cc.id = mc.celular_recibe
    `,
    [dias + DIAS_ATRIBUCION],
  );

  /* Índice: cuenta -> teléfono -> [{primer_ia, ultimo_ia}] */
  const actividadIA = new Map();
  for (const c of contactos) {
    const tel = normTel(c.telefono);
    if (!tel) continue;
    let porTel = actividadIA.get(c.id_configuracion);
    if (!porTel) {
      porTel = new Map();
      actividadIA.set(c.id_configuracion, porTel);
    }
    const prev = porTel.get(tel);
    const primer = new Date(c.primer_ia).getTime();
    const ultimo = new Date(c.ultimo_ia).getTime();
    if (prev) {
      prev.primer = Math.min(prev.primer, primer);
      prev.ultimo = Math.max(prev.ultimo, ultimo);
    } else {
      porTel.set(tel, { primer, ultimo });
    }
  }

  /* 5) Atribución de órdenes y agregado por (día, cuenta). */
  const MS_ATRIB = DIAS_ATRIBUCION * 24 * 3600 * 1000;
  const ordAgg = new Map(); // 'fecha|cfg' -> {ordenes_total, cierres_bot, entregadas_bot, canceladas_bot}
  for (const o of ordenes) {
    const key = `${fechaStr(o.fecha)}|${o.id_configuracion}`;
    let a = ordAgg.get(key);
    if (!a) {
      a = { ordenes_total: 0, cierres_bot: 0, entregadas_bot: 0, canceladas_bot: 0 };
      ordAgg.set(key, a);
    }
    a.ordenes_total += 1;
    const porTel = actividadIA.get(o.id_configuracion);
    const act = porTel && porTel.get(normTel(o.phone));
    if (!act) continue;
    const tOrden = new Date(o.order_created_at).getTime();
    // Atribuida si la IA atendió al contacto antes de la orden y su última
    // actividad no queda a más de 30 días de ella.
    if (tOrden >= act.primer && tOrden <= act.ultimo + MS_ATRIB) {
      const st = String(o.classified_status || '').toUpperCase();
      a.cierres_bot += 1;
      if (st.includes('ENTREG')) a.entregadas_bot += 1;
      if (st.includes('CANCEL') || st.includes('DEVOL') || st.includes('RECHAZ'))
        a.canceladas_bot += 1;
    }
  }

  /* 6) Merge de las tres fuentes y upsert. */
  const filas = new Map(); // 'fecha|cfg' -> fila
  const fila = (fecha, cfg) => {
    const key = `${fecha}|${cfg}`;
    let f = filas.get(key);
    if (!f) {
      f = {
        fecha,
        id_configuracion: cfg,
        convers_ia: 0,
        convers_respondieron: 0,
        respuestas_ia: 0,
        cierres_kanban: 0,
        cierres_respondieron: 0,
        entregadas_kanban: 0,
        auto_intentos: 0,
        auto_creadas: 0,
        auto_fallidas: 0,
        ordenes_total: 0,
        cierres_bot: 0,
        entregadas_bot: 0,
        canceladas_bot: 0,
      };
      filas.set(key, f);
    }
    return f;
  };

  for (const e of embudo) {
    const f = fila(fechaStr(e.fecha), e.id_configuracion);
    f.convers_ia = Number(e.convers_ia) || 0;
    f.convers_respondieron = Number(e.convers_respondieron) || 0;
    f.respuestas_ia = Number(e.respuestas_ia) || 0;
    f.cierres_kanban = Number(e.cierres_kanban) || 0;
    f.cierres_respondieron = Number(e.cierres_respondieron) || 0;
    f.entregadas_kanban = Number(e.entregadas_kanban) || 0;
  }
  for (const a of auto) {
    const f = fila(fechaStr(a.fecha), a.id_configuracion);
    f.auto_intentos = Number(a.auto_intentos) || 0;
    f.auto_creadas = Number(a.auto_creadas) || 0;
    f.auto_fallidas = Number(a.auto_fallidas) || 0;
  }
  for (const [key, a] of ordAgg) {
    const [fecha, cfg] = key.split('|');
    Object.assign(fila(fecha, Number(cfg)), a);
  }

  const rows = [...filas.values()].filter((f) => f.fecha && f.id_configuracion);
  /* La columna nueva solo viaja si ya existe en la base (ver
     tieneCierresRespondieron): `fields` limita el INSERT a lo que hay. */
  const conResp = await tieneCierresRespondieron();
  const metricas = [
    'convers_ia',
    'convers_respondieron',
    'respuestas_ia',
    'cierres_kanban',
    ...(conResp ? ['cierres_respondieron'] : []),
    'entregadas_kanban',
    'auto_intentos',
    'auto_creadas',
    'auto_fallidas',
    'ordenes_total',
    'cierres_bot',
    'entregadas_bot',
    'canceladas_bot',
  ];
  const LOTE = 2000;
  for (let i = 0; i < rows.length; i += LOTE) {
    await BotMetricasDiarias.bulkCreate(rows.slice(i, i + LOTE), {
      fields: ['fecha', 'id_configuracion', ...metricas, 'created_at', 'updated_at'],
      updateOnDuplicate: [...metricas, 'updated_at'],
    });
  }

  return {
    dias_ventana: dias,
    filas: rows.length,
    cuentas: new Set(rows.map((r) => r.id_configuracion)).size,
    segundos: Number(((Date.now() - t0) / 1000).toFixed(1)),
  };
}

module.exports = {
  recalcularVentana,
  tieneCierresRespondieron,
  DIAS_ATRIBUCION,
};
