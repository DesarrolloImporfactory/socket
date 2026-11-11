/**
 * dropi_rentabilidad.service.js
 * Bloque «¿Cuánto ganaste de verdad?» del dashboard de conexión v2: lo que le
 * queda al vendedor en el bolsillo en el rango, no lo que facturó.
 *
 *  Cascada (pedidos Dropi por fecha de creación, sin REEMPLAZADA):
 *    facturado entregado − costo del producto − flete de lo entregado
 *    = ganancia Dropi (dropshipper_profit)
 *    − flete de las devoluciones (un flete por devolución: shipping_amount del pedido)
 *    − flete de lo que el courier ya lleva (ya se pagó, aún no se cobra)
 *    − publicidad (Meta + impuesto_ads_pct; sin Meta, el gasto manual)
 *    − otros gastos (gastos_adicionales del Dropiboard)
 *    = neto hoy.
 *  Es la misma fórmula que ganancia_neta de marketing-control y la
 *  rentabilidad del Dropiboard: si cambia un lado, cambiar los otros.
 *
 *  Encima: proyección de lo que está en camino con la efectividad real del
 *  rango, ganancia por entrega, ROAS sobre lo entregado, punto de equilibrio
 *  (% de entrega para no perder), serie diaria, ganancia por producto y por
 *  anuncio (atribución chat→pedido de marketing_control.buildAdsDashboard).
 */
const axios = require('axios');
const { db } = require('../database/config');
const {
  buildAdsDashboard,
} = require('../controllers/marketing_control.controller');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;
const TTL_META_MS = 10 * 60 * 1000;
const cacheMeta = new Map();

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

const EN_COURIER = ['en_transito', 'en_reparto', 'novedad', 'retiro_agencia'];
const EN_BODEGA = ['guia_generada', 'pendiente'];
const lista = (arr) => arr.map((s) => db.escape(s)).join(',');

const AGREGADOS = `
  COUNT(*) AS pedidos,
  SUM(c.classified_status = 'entregada') AS entregadas,
  SUM(c.classified_status = 'devolucion') AS devoluciones,
  SUM(c.classified_status = 'cancelada') AS canceladas,
  SUM(c.classified_status IN (${lista(EN_COURIER)})) AS en_courier,
  SUM(c.classified_status IN (${lista(EN_BODEGA)})) AS en_bodega,
  SUM(CASE WHEN c.classified_status = 'entregada' THEN COALESCE(c.total_order, 0) ELSE 0 END) AS facturado,
  SUM(CASE WHEN c.classified_status = 'entregada' THEN COALESCE(c.dropshipper_profit, 0) ELSE 0 END) AS ganancia,
  SUM(CASE WHEN c.classified_status = 'entregada' THEN COALESCE(c.flete_amount, 0) ELSE 0 END) AS flete_entregadas,
  SUM(CASE WHEN c.classified_status = 'devolucion' THEN COALESCE(c.flete_amount, 0) ELSE 0 END) AS flete_devoluciones,
  SUM(CASE WHEN c.classified_status IN (${lista(EN_COURIER)}) THEN COALESCE(c.flete_amount, 0) ELSE 0 END) AS flete_courier,
  SUM(CASE WHEN c.classified_status IN (${lista(EN_COURIER)}, ${lista(EN_BODEGA)}) THEN COALESCE(c.dropshipper_profit, 0) ELSE 0 END) AS ganancia_camino,
  SUM(CASE WHEN c.classified_status IN (${lista(EN_COURIER)}, ${lista(EN_BODEGA)}) THEN COALESCE(c.flete_amount, 0) ELSE 0 END) AS flete_camino`;

const num = (row) => {
  const o = {};
  for (const [k, v] of Object.entries(row || {})) o[k] = Number(v || 0);
  return o;
};

async function getAdConnection(id_configuracion) {
  const rows = await db.query(
    `SELECT * FROM meta_ad_connections WHERE id_configuracion = ? AND status = 'active' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return rows[0] || null;
}

/* Gasto de Meta por día (sin impuesto). Una sola llamada con time_increment. */
async function gastoMetaDiario(conn, from, until) {
  const resp = await axios.get(`${GRAPH_BASE}/${conn.ad_account_id}/insights`, {
    headers: { Authorization: `Bearer ${conn.access_token}` },
    timeout: 20000,
    validateStatus: () => true,
    params: {
      fields: 'spend',
      time_range: JSON.stringify({ since: from, until }),
      time_increment: 1,
      level: 'account',
      limit: 400,
    },
  });
  if (resp.status >= 400) {
    const msg = resp.data?.error?.message || `HTTP ${resp.status}`;
    throw new Error(`Meta: ${msg}`);
  }
  const porDia = {};
  for (const r of resp.data?.data || []) {
    porDia[r.date_start] = (porDia[r.date_start] || 0) + Number(r.spend || 0);
  }
  return porDia;
}

/* Lo de Meta tarda (el cruce por anuncio ~13 s): cache por conexión y rango. */
async function datosMeta(conn, { id_configuracion, from, until }) {
  const key = `${id_configuracion}|${from}|${until}`;
  const hit = cacheMeta.get(key);
  if (hit && Date.now() - hit.t < TTL_META_MS) return hit.v;

  const [diario, ads] = await Promise.allSettled([
    gastoMetaDiario(conn, from, until),
    buildAdsDashboard({ id_configuracion, since: from, until, limit: 50 }),
  ]);
  const v = {
    diario: diario.status === 'fulfilled' ? diario.value : null,
    error: diario.status === 'rejected' ? diario.reason?.message : null,
    ads: ads.status === 'fulfilled' ? ads.value : null,
    error_ads: ads.status === 'rejected' ? ads.reason?.message : null,
  };
  if (v.diario) cacheMeta.set(key, { t: Date.now(), v });
  return v;
}

function diasEntre(from, until) {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`);
  const fin = new Date(`${until}T12:00:00Z`);
  while (d <= fin && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function calcularRentabilidad({ id_configuracion, from, until }) {
  const repl = {
    idCfg: id_configuracion,
    from: `${from} 00:00:00`,
    until: `${until} 23:59:59`,
    dFrom: from,
    dUntil: until,
  };
  const base = `
    FROM dropi_orders_cache c
   WHERE c.id_configuracion = :idCfg
     AND c.id_usuario = 0
     AND c.order_created_at BETWEEN :from AND :until
     AND (c.status <> 'REEMPLAZADA' OR c.status IS NULL)`;
  const q = (sql) =>
    db.query(sql, { replacements: repl, type: db.QueryTypes.SELECT });

  const conn = await getAdConnection(id_configuracion);
  const [[tot], [hist], porDia, porProducto, manual, meta] = await Promise.all([
    q(`SELECT ${AGREGADOS} ${base}`),
    // Efectividad para proyectar: 90 días de la tienda hasta el fin del rango.
    // La del propio rango corto sale inflada (las devoluciones tardan más).
    q(`SELECT SUM(c.classified_status = 'entregada') AS entregadas,
              SUM(c.classified_status = 'devolucion') AS devoluciones
         FROM dropi_orders_cache c
        WHERE c.id_configuracion = :idCfg
          AND c.id_usuario = 0
          AND c.order_created_at BETWEEN :until - INTERVAL 90 DAY AND :until
          AND (c.status <> 'REEMPLAZADA' OR c.status IS NULL)`),
    q(`SELECT DATE_FORMAT(c.order_created_at, '%Y-%m-%d') AS dia, ${AGREGADOS}
         ${base} GROUP BY dia`),
    q(`SELECT COALESCE(NULLIF(TRIM(c.product_names), ''), 'Sin nombre') AS producto, ${AGREGADOS}
         ${base} GROUP BY producto`),
    q(`SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS dia,
              SUM(COALESCE(gasto_diario, 0)) AS gasto,
              SUM(COALESCE(gastos_adicionales, 0)) AS otros
         FROM dropi_daily_metrics
        WHERE id_configuracion = :idCfg AND fecha BETWEEN :dFrom AND :dUntil
        GROUP BY dia`),
    conn
      ? datosMeta(conn, { id_configuracion, from, until })
      : Promise.resolve(null),
  ]);

  const t = num(tot);
  const finalizadas = t.entregadas + t.devoluciones;
  const ef = finalizadas > 0 ? t.entregadas / finalizadas : null;

  // ── Publicidad: Meta si está conectada y respondió; si no, la manual ──
  const impuestoPct = conn
    ? Math.max(0, Number(conn.impuesto_ads_pct || 0))
    : 0;
  const manualDia = {};
  for (const m of manual) manualDia[m.dia] = num(m);
  let fuente = 'ninguna';
  let gastoDia = {};
  if (meta?.diario) {
    fuente = 'meta';
    for (const [d, v] of Object.entries(meta.diario))
      gastoDia[d] = v * (1 + impuestoPct / 100);
  } else if (manual.some((m) => Number(m.gasto) > 0)) {
    fuente = 'manual';
    for (const [d, m] of Object.entries(manualDia)) gastoDia[d] = m.gasto;
  }
  const publicidad = Object.values(gastoDia).reduce((s, v) => s + v, 0);
  const otros = Object.values(manualDia).reduce((s, m) => s + m.otros, 0);

  // ── Cascada y neto ──
  const costoProducto = Math.max(
    0,
    t.facturado - t.ganancia - t.flete_entregadas,
  );
  const neto =
    t.ganancia - t.flete_devoluciones - t.flete_courier - publicidad - otros;

  /* Proyección: lo en camino termina entregado con la efectividad del rango
     (deja su ganancia) o devuelto (cuesta su flete). Se reemplaza el flete
     del courier que el neto de hoy ya restó. */
  const h = num(hist);
  const efProy =
    h.entregadas + h.devoluciones >= 20
      ? h.entregadas / (h.entregadas + h.devoluciones)
      : (ef ?? 0);
  const aporteCamino =
    efProy * t.ganancia_camino - (1 - efProy) * t.flete_camino;
  const netoProyectado = neto + t.flete_courier + aporteCamino;

  /* Punto de equilibrio: el % de entrega de TODOS los pedidos vivos del
     periodo (entregados + devueltos + en camino) con el que el neto queda en
     0. e tal que N·e·p − N·(1−e)·f − C = 0, con p ganancia media por pedido
     entregado, f flete medio de una devolución, C publicidad + otros.
     Con lo en camino incluido funciona también con «Hoy» (antes salía «—»
     hasta que hubiera pedidos cerrados) y es el mismo número que marca el
     simulador. Las medias de lo cerrado mandan si hay base; si no, las de
     lo en camino. */
  const enCamino = t.en_courier + t.en_bodega;
  const vivos = finalizadas + enCamino;
  const pMedia =
    t.entregadas >= 5
      ? t.ganancia / t.entregadas
      : t.entregadas + enCamino > 0
        ? (t.ganancia + t.ganancia_camino) / (t.entregadas + enCamino)
        : 0;
  const fMedio =
    t.devoluciones >= 5
      ? t.flete_devoluciones / t.devoluciones
      : vivos > 0
        ? (t.flete_entregadas + t.flete_devoluciones + t.flete_camino) / vivos
        : 0;
  let equilibrio = null;
  if (vivos > 0 && pMedia + fMedio > 0) {
    const e = (publicidad + otros + vivos * fMedio) / (vivos * (pMedia + fMedio));
    equilibrio = Math.round(Math.min(1.5, Math.max(0, e)) * 1000) / 10;
  }

  // ── Serie diaria ──
  const diaSql = {};
  for (const r of porDia) diaSql[r.dia] = num(r);
  const serie = diasEntre(from, until).map((d) => {
    const x = diaSql[d] || {};
    const pub = gastoDia[d] || 0;
    const otr = manualDia[d]?.otros || 0;
    const ganancia = x.ganancia || 0;
    const netoDia =
      ganancia - (x.flete_devoluciones || 0) - (x.flete_courier || 0) - pub - otr;
    // Los días recientes tienen casi todo en camino: el neto de caja sale
    // rojo aunque el día haya sido bueno. La serie se dibuja proyectada.
    const proyDia =
      netoDia +
      (x.flete_courier || 0) +
      efProy * (x.ganancia_camino || 0) -
      (1 - efProy) * (x.flete_camino || 0);
    return {
      dia: d,
      pedidos: x.pedidos || 0,
      entregadas: x.entregadas || 0,
      en_camino: (x.en_courier || 0) + (x.en_bodega || 0),
      ganancia: r2(ganancia),
      publicidad: r2(pub),
      neto: r2(netoDia),
      neto_proyectado: r2(proyDia),
      // Para el simulador del front: neto(s) = neto + flete_courier
      //   + s·ganancia_camino − (1 − s)·flete_camino
      flete_courier: r2(x.flete_courier || 0),
      ganancia_camino: r2(x.ganancia_camino || 0),
      flete_camino: r2(x.flete_camino || 0),
    };
  });

  // ── Por producto (sin publicidad: aún no se reparte el gasto por producto) ──
  // product_names llega como JSON '["A","B"]'; se junta por nombre limpio.
  const porNombre = new Map();
  for (const r of porProducto) {
    let nombre = r.producto;
    try {
      const arr = JSON.parse(nombre);
      if (Array.isArray(arr)) nombre = arr.join(' + ') || 'Sin nombre';
    } catch {}
    const acc = porNombre.get(nombre) || {};
    for (const [k, v] of Object.entries(num(r)))
      if (k !== 'producto') acc[k] = (acc[k] || 0) + v;
    porNombre.set(nombre, acc);
  }
  const productos = [...porNombre.entries()]
    .map(([nombre, x]) => {
      const fin = x.entregadas + x.devoluciones;
      return {
        producto: nombre,
        pedidos: x.pedidos,
        entregadas: x.entregadas,
        devoluciones: x.devoluciones,
        en_camino: x.en_courier + x.en_bodega,
        canceladas: x.canceladas || 0,
        /* Entregados sobre todo lo vivo (lo en camino cuenta): con pedidos
           en ruta, entregados ÷ (entregados + devueltos) salía 100 %. */
        efectividad: pct(x.entregadas, fin + x.en_courier + x.en_bodega),
        efectividad_final: pct(x.entregadas, fin),
        facturado: r2(x.facturado),
        ganancia: r2(x.ganancia),
        flete_devoluciones: r2(x.flete_devoluciones),
        neto: r2(x.ganancia - x.flete_devoluciones - x.flete_courier),
        flete_courier: r2(x.flete_courier),
        ganancia_camino: r2(x.ganancia_camino),
        flete_camino: r2(x.flete_camino),
        neto_proyectado: r2(
          x.ganancia -
            x.flete_devoluciones +
            efProy * x.ganancia_camino -
            (1 - efProy) * x.flete_camino,
        ),
      };
    })
    .sort((a, b) => b.neto_proyectado - a.neto_proyectado);

  // ── Por anuncio (atribución chat→pedido de marketing-control) ──
  let anuncios = null;
  if (meta?.ads) {
    const at = meta.ads.attribution || {};
    const items = (at.items || [])
      .filter((a) => Number(a.spend) > 0 || Number(a.ordenes_estimadas) > 0)
      .map((a) => {
        const gasto = Number(a.spend || 0) * (1 + impuestoPct / 100);
        const fleteDev = Number(a.devueltas_atribuidas || 0) * fMedio;
        const netoAd = Number(a.utilidad_estimada || 0) - fleteDev - gasto;
        const camino = Number(a.en_camino_atribuidas || 0);
        const proyAd = netoAd + camino * (efProy * pMedia - (1 - efProy) * fMedio);
        return {
          ad_id: a.ad_id,
          nombre: a.ad_name,
          campana: a.campaign_name,
          estado: a.effective_status,
          miniatura: a.thumbnail_url,
          gasto: r2(gasto),
          pedidos: Number(a.ordenes_estimadas || 0),
          entregadas: Number(a.entregadas_estimadas || 0),
          devoluciones: Number(a.devueltas_atribuidas || 0),
          en_camino: Number(a.en_camino_atribuidas || 0),
          canceladas: Number(a.canceladas_atribuidas || 0),
          facturado: r2(a.revenue_estimado),
          ganancia: r2(a.utilidad_estimada),
          neto: r2(netoAd),
          neto_proyectado: r2(proyAd),
          roas: gasto > 0 ? r2(Number(a.revenue_estimado || 0) / gasto) : null,
          /* ROAS con el que el anuncio queda en 0 hoy: facturado ÷ lo que deja
             antes de publicidad. Null si ni sin publicidad gana. */
          roas_minimo:
            netoAd + gasto > 0 && Number(a.revenue_estimado || 0) > 0
              ? r2(Number(a.revenue_estimado) / (netoAd + gasto))
              : null,
        };
      })
      .sort((a, b) => b.gasto - a.gasto);
    anuncios = {
      pct_atribuidos: at.totales_rango?.pct_atribuidas ?? null,
      pedidos_atribuidos: at.totales_rango?.ordenes_atribuidas ?? 0,
      ventana_horas: meta.ads.window_hours,
      items,
    };
  }

  return {
    desde: from,
    hasta: until,
    publicidad_fuente: fuente,
    meta_conectada: Boolean(conn),
    meta_error: meta?.error || null,
    impuesto_ads_pct: impuestoPct,
    pedidos: {
      total: t.pedidos,
      entregadas: t.entregadas,
      devoluciones: t.devoluciones,
      canceladas: t.canceladas,
      en_courier: t.en_courier,
      en_bodega: t.en_bodega,
      finalizadas,
      efectividad: ef == null ? null : Math.round(ef * 1000) / 10,
      entrega_hasta_hoy: pct(
        t.entregadas,
        finalizadas + t.en_courier + t.en_bodega,
      ),
    },
    cascada: {
      facturado: r2(t.facturado),
      costo_producto: r2(costoProducto),
      flete_entregadas: r2(t.flete_entregadas),
      ganancia_dropi: r2(t.ganancia),
      flete_devoluciones: r2(t.flete_devoluciones),
      flete_en_camino: r2(t.flete_courier),
      publicidad: r2(publicidad),
      otros: r2(otros),
      neto: r2(neto),
    },
    proyeccion: {
      en_camino: t.en_courier + t.en_bodega,
      ganancia_en_camino: r2(t.ganancia_camino),
      flete_en_camino_total: r2(t.flete_camino),
      neto_proyectado: r2(netoProyectado),
      efectividad_usada: Math.round(efProy * 1000) / 10,
    },
    kpis: {
      ganancia_por_entrega:
        t.entregadas > 0 ? r2(neto / t.entregadas) : null,
      ganancia_por_entrega_proyectada:
        t.entregadas + (t.en_courier + t.en_bodega) * efProy > 0
          ? r2(
              netoProyectado /
                (t.entregadas + (t.en_courier + t.en_bodega) * efProy),
            )
          : null,
      roas_real: publicidad > 0 ? r2(t.facturado / publicidad) : null,
      margen_neto: t.facturado > 0 ? pct(neto, t.facturado) : null,
      punto_equilibrio: equilibrio,
      ganancia_media_entrega: r2(pMedia),
      flete_medio_devolucion: r2(fMedio),
    },
    serie,
    productos: productos.slice(0, 12),
    anuncios,
  };
}

module.exports = { calcularRentabilidad };
