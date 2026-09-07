/**
 * metaAdsReglas.service.js
 * Motor propio de reglas automáticas para las campañas del Lanzador
 * (camino 2: en vez de las reglas nativas de Meta —lentas de auditar y con
 * métricas que Meta mismo admite que "se retrasan y fluctúan"— Imporchat lee
 * gasto y mensajes por anuncio en vivo y actúa con sus propios endpoints).
 *
 * La evaluación es POR ANUNCIO: se pausa el perdedor y la campaña sigue
 * aprendiendo con las demás variaciones. A nivel campaña solo aplican el
 * corte total y la acción de presupuesto (se ajusta el conjunto).
 *
 * Alcance: solo los anuncios lanzados desde Imporchat (meta_ads_lanzamientos)
 * — jamás tocamos campañas que el cliente creó por fuera.
 */

const axios = require('axios');
const { db } = require('../database/config');
const logger = require('../utils/logger');
const { enviarAvisoRegla } = require('./metaAdsAvisos.service');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

function metaAx(token) {
  return axios.create({
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
    validateStatus: () => true,
  });
}

/* Paquete recomendado — fase 1 · reglas de corte por anuncio (valores de la
   asesoría, editables por el cliente):
   · $0.25 = costo ideal por mensaje
   · $0.40 = corte sin mensajes (1.5× del ideal): si gastó eso y no generó
     ni un mensaje, se apaga antes de llegar al techo absoluto.
   · $0.50 = costo por mensaje máximo aceptable por anuncio (2× del ideal).
   · < $0.25 = la campaña funciona → +10% de presupuesto cada día (con tope
     de seguridad; se ajusta a gusto). */
const REGLAS_RECOMENDADAS = [
  {
    nombre: 'Apagar anuncio sin mensajes',
    descripcion:
      'Gastó $0.40 (1.5× del costo ideal) sin generar ni un mensaje: se apaga antes de llegar al techo.',
    nivel: 'ad',
    metrica: 'msgs',
    operador: '<',
    umbral: 1,
    gasto_minimo: 0.4,
    periodo: 'hoy',
    accion: 'pausar',
    accion_valor: null,
    accion_limite: null,
    frecuencia: '30m',
  },
  {
    nombre: 'Apagar anuncio con mensaje caro',
    descripcion:
      'El costo por mensaje superó los $0.50 (2× del costo ideal): deja de ser aceptable.',
    nivel: 'ad',
    metrica: 'cpa_msg',
    operador: '>',
    umbral: 0.5,
    gasto_minimo: 0.5,
    periodo: 'hoy',
    accion: 'pausar',
    accion_valor: null,
    accion_limite: null,
    frecuencia: '30m',
  },
  {
    nombre: 'Escalar campaña ganadora',
    descripcion:
      'Costo por mensaje bajo $0.25: la campaña funciona, +10% de presupuesto cada día.',
    nivel: 'campaign',
    metrica: 'cpa_msg',
    operador: '<',
    umbral: 0.25,
    gasto_minimo: 0.25,
    periodo: 'hoy',
    accion: 'subir_presupuesto',
    accion_valor: 10,
    accion_limite: 50,
    frecuencia: 'diaria',
  },
];

function parseMsgs(actions) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (a.action_type === 'onsite_conversion.messaging_conversation_started_7d')
      total += Number(a.value) || 0;
  }
  return total;
}

function cumple(valor, operador, umbral) {
  const u = Number(umbral);
  if (operador === '>') return valor > u;
  if (operador === '<') return valor < u;
  return valor === u;
}

async function registrarLog(fila) {
  try {
    await db.query(
      `INSERT INTO meta_ads_reglas_log
         (id_configuracion, id_regla, regla_nombre, nivel, entidad_id,
          entidad_nombre, gasto, mensajes, metrica_valor, accion, resultado,
          detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          fila.id_configuracion,
          fila.id_regla || null,
          fila.regla_nombre || null,
          fila.nivel || null,
          fila.entidad_id || null,
          fila.entidad_nombre || null,
          fila.gasto ?? null,
          fila.mensajes ?? null,
          Number.isFinite(fila.metrica_valor) ? fila.metrica_valor : null,
          fila.accion || null,
          fila.resultado || 'ok',
          fila.detalle || null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (e) {
    logger.error(`metaAdsReglas log: ${e.message}`);
  }
}

/* Frecuencia 'diaria': ¿ya actuó esta regla sobre esta entidad en 24h? */
async function actuoEnUltimas24h(id_regla, entidad_id) {
  const rows = await db.query(
    `SELECT id FROM meta_ads_reglas_log
      WHERE id_regla = ? AND entidad_id = ? AND resultado = 'ok'
        AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      LIMIT 1`,
    { replacements: [id_regla, String(entidad_id)], type: db.QueryTypes.SELECT },
  );
  return rows.length > 0;
}

/* Evalúa y ejecuta todas las reglas activas de una configuración.
   Devuelve un resumen { evaluadas, disparos: [...] } para el "Ejecutar ahora"
   del front. */
async function evaluarReglasConfig(id_configuracion) {
  const resumen = { evaluadas: 0, disparos: [] };

  const reglas = await db.query(
    `SELECT * FROM meta_ads_reglas
      WHERE id_configuracion = ? AND activa = 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!reglas.length) return resumen;

  const [conn] = await db.query(
    `SELECT * FROM meta_ad_connections
      WHERE id_configuracion = ? AND status = 'active' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!conn) return resumen;

  // Lo lanzado desde aquí (últimos 60 días) marca qué es "del sistema";
  // según el ámbito de cada regla se evalúa eso, lo externo, o todo.
  const lanzamientos = await db.query(
    `SELECT campaign_id, adset_id, ad_id, ads_json, plantilla_nombre
       FROM meta_ads_lanzamientos
      WHERE id_configuracion = ? AND resultado = 'ok'
        AND created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const adInfo = new Map(); // ad_id -> { campaign_id, adset_id, plantilla }
  const campInfo = new Map(); // campaign_id -> { adset_id, plantilla }
  for (const l of lanzamientos) {
    if (l.campaign_id) {
      campInfo.set(String(l.campaign_id), {
        adset_id: l.adset_id ? String(l.adset_id) : null,
        plantilla: l.plantilla_nombre || '',
      });
    }
    let ads = [];
    try {
      ads = l.ads_json ? JSON.parse(l.ads_json) : [];
    } catch {}
    if (!ads.length && l.ad_id) ads = [{ ad_id: l.ad_id }];
    for (const a of ads) {
      if (a?.ad_id) {
        adInfo.set(String(a.ad_id), {
          campaign_id: l.campaign_id ? String(l.campaign_id) : null,
          adset_id: l.adset_id ? String(l.adset_id) : null,
          plantilla: l.plantilla_nombre || '',
        });
      }
    }
  }
  const ax = metaAx(conn.access_token);
  const act = String(conn.ad_account_id).startsWith('act_')
    ? conn.ad_account_id
    : `act_${conn.ad_account_id}`;

  // Un fetch de insights por período usado (hoy / últimos 7 días).
  const periodos = [...new Set(reglas.map((r) => r.periodo || 'hoy'))];
  const datosPorPeriodo = {};
  for (const periodo of periodos) {
    // TODOS los anuncios con actividad en el período — con paginación:
    // en cuentas grandes (ámbito 'todas'/'externas') una sola página de 500
    // dejaría anuncios sin analizar en silencio. Tope de 5 páginas (2.500
    // anuncios activos) como cinturón de seguridad.
    const filas = [];
    let url = `${GRAPH_BASE}/${act}/insights`;
    let params = {
      level: 'ad',
      fields: 'ad_id,ad_name,campaign_id,campaign_name,spend,actions',
      date_preset: periodo === '7d' ? 'last_7d' : 'today',
      limit: 500,
    };
    let fallo = false;
    for (let pagina = 0; pagina < 5 && url; pagina++) {
      const resp = await ax.get(url, params ? { params } : undefined);
      if (resp.status < 200 || resp.status >= 300) {
        logger.error(
          `metaAdsReglas insights cfg ${id_configuracion}: ${JSON.stringify(resp.data?.error?.message || resp.status)}`,
        );
        fallo = pagina === 0; // sin primera página no hay nada que evaluar
        break;
      }
      filas.push(...(resp.data?.data || []));
      // paging.next ya trae todos los query params incluidos
      url = resp.data?.paging?.next || null;
      params = null;
    }
    if (fallo) continue;

    const porAd = new Map();
    for (const row of filas) {
      const adId = String(row.ad_id);
      porAd.set(adId, {
        ad_id: adId,
        nombre: row.ad_name || adId,
        campaign_id: String(
          row.campaign_id || adInfo.get(adId)?.campaign_id || '',
        ),
        campaign_name: row.campaign_name || null,
        es_sistema: adInfo.has(adId),
        spend: Number(row.spend) || 0,
        msgs: parseMsgs(row.actions),
      });
    }
    datosPorPeriodo[periodo] = porAd;
  }

  for (const regla of reglas) {
    const porAd = datosPorPeriodo[regla.periodo || 'hoy'];
    if (!porAd) continue;

    // Ámbito de la regla: 'imporchat' (lo lanzado desde el sistema),
    // 'externas' (lo creado por fuera), 'todas', o 'personalizado'
    // (campañas puntuales elegidas por el cliente en campanias_json).
    const ambito = regla.ambito || 'imporchat';
    let campaniasElegidas = null;
    if (ambito === 'personalizado') {
      try {
        const arr = regla.campanias_json
          ? JSON.parse(regla.campanias_json)
          : [];
        campaniasElegidas = new Set(arr.map((c) => String(c.id || c)));
      } catch {
        campaniasElegidas = new Set();
      }
    }
    const enAmbito = (d) => {
      if (ambito === 'todas') return true;
      if (ambito === 'externas') return !d.es_sistema;
      if (ambito === 'personalizado')
        return campaniasElegidas.has(String(d.campaign_id));
      return d.es_sistema; // imporchat
    };
    const adsAmbito = [...porAd.values()].filter(enAmbito);
    if (!adsAmbito.length) continue;

    // Entidades a evaluar según el nivel
    let entidades = [];
    if (regla.nivel === 'campaign') {
      const porCamp = new Map();
      for (const d of adsAmbito) {
        const prev = porCamp.get(d.campaign_id) || {
          entidad_id: d.campaign_id,
          nombre:
            campInfo.get(d.campaign_id)?.plantilla ||
            d.campaign_name ||
            d.campaign_id,
          es_sistema: d.es_sistema,
          spend: 0,
          msgs: 0,
        };
        prev.spend += d.spend;
        prev.msgs += d.msgs;
        porCamp.set(d.campaign_id, prev);
      }
      entidades = [...porCamp.values()];
    } else {
      entidades = adsAmbito.map((d) => ({
        entidad_id: d.ad_id,
        nombre: d.nombre,
        campaign_id: d.campaign_id,
        campaign_nombre:
          campInfo.get(d.campaign_id)?.plantilla || d.campaign_name || '',
        es_sistema: d.es_sistema,
        spend: d.spend,
        msgs: d.msgs,
      }));
    }

    for (const ent of entidades) {
      resumen.evaluadas++;

      // Búfer anti falsos positivos: sin gasto mínimo no se opina.
      if (ent.spend < Number(regla.gasto_minimo || 0)) continue;

      let valor;
      if (regla.metrica === 'msgs') valor = ent.msgs;
      else if (regla.metrica === 'spend') valor = ent.spend;
      else valor = ent.msgs > 0 ? ent.spend / ent.msgs : Infinity; // cpa_msg

      // cpa_msg infinito (0 mensajes) solo dispara reglas de "mayor que".
      if (!cumple(valor, regla.operador, regla.umbral)) continue;

      if (regla.frecuencia === 'diaria') {
        const ya = await actuoEnUltimas24h(regla.id, ent.entidad_id);
        if (ya) continue;
      }

      const base = {
        id_configuracion,
        id_regla: regla.id,
        regla_nombre: regla.nombre,
        nivel: regla.nivel,
        entidad_id: ent.entidad_id,
        entidad_nombre: ent.nombre,
        gasto: Math.round(ent.spend * 100) / 100,
        mensajes: ent.msgs,
        metrica_valor: Number.isFinite(valor)
          ? Math.round(valor * 100) / 100
          : null,
        accion: regla.accion,
      };

      try {
        let nuevoPresupuestoTxt = null;

        if (regla.accion === 'subir_presupuesto') {
          // En campañas del sistema se ajusta SU conjunto (el Lanzador crea
          // 1 por campaña). En campañas externas se intenta el presupuesto
          // CBO de la campaña; sin CBO no se toca (los adsets externos son
          // territorio del cliente). Tope duro en accion_limite.
          const adset_id =
            campInfo.get(String(ent.entidad_id))?.adset_id ||
            adInfo.get(String(ent.entidad_id))?.adset_id;
          let objetivo = adset_id;
          if (!objetivo) {
            const camp = await ax.get(`${GRAPH_BASE}/${ent.entidad_id}`, {
              params: { fields: 'daily_budget' },
            });
            if (Number(camp.data?.daily_budget) > 0) {
              objetivo = String(ent.entidad_id); // CBO: presupuesto en la campaña
            } else {
              throw new Error(
                'La campaña no usa presupuesto diario a nivel campaña (CBO); ajusta el conjunto a mano.',
              );
            }
          }
          const cur = await ax.get(`${GRAPH_BASE}/${objetivo}`, {
            params: { fields: 'daily_budget' },
          });
          const actual = Number(cur.data?.daily_budget) || 0; // centavos
          if (!actual) throw new Error('Sin presupuesto diario que ajustar.');
          const pct = Number(regla.accion_valor) || 10;
          const tope = Math.round((Number(regla.accion_limite) || 50) * 100);
          const nuevo = Math.min(tope, Math.round(actual * (1 + pct / 100)));
          if (nuevo <= actual) {
            continue; // ya está en el tope: nada que hacer, sin log
          }
          const up = await ax.post(`${GRAPH_BASE}/${objetivo}`, {
            daily_budget: nuevo,
          });
          if (up.status >= 300) {
            throw new Error(JSON.stringify(up.data?.error?.message || up.status));
          }
          nuevoPresupuestoTxt = `$${(nuevo / 100).toFixed(2)}`;
          base.detalle = `Presupuesto ${(actual / 100).toFixed(2)} → ${(nuevo / 100).toFixed(2)}`;
        } else {
          // Pausar (verifica el estado para no re-pausar en cada corrida)
          const st = await ax.get(`${GRAPH_BASE}/${ent.entidad_id}`, {
            params: { fields: 'effective_status' },
          });
          const estado = st.data?.effective_status || '';
          if (estado !== 'ACTIVE') continue; // ya está pausado/en revisión
          const pw = await ax.post(`${GRAPH_BASE}/${ent.entidad_id}`, {
            status: 'PAUSED',
          });
          if (pw.status >= 300) {
            throw new Error(JSON.stringify(pw.data?.error?.message || pw.status));
          }
          base.detalle =
            regla.nivel === 'campaign' ? 'Campaña pausada' : 'Anuncio pausado';
        }
        await registrarLog({ ...base, resultado: 'ok' });
        resumen.disparos.push({ ...base, resultado: 'ok' });

        // Aviso por WhatsApp al dueño de la cuenta (si activó los avisos).
        // Best-effort: un fallo del aviso jamás detiene el motor.
        const motivo =
          ent.msgs > 0
            ? `costo por mensaje de $${(ent.spend / ent.msgs).toFixed(2)} con $${ent.spend.toFixed(2)} gastados`
            : `gastó $${ent.spend.toFixed(2)} sin generar mensajes`;
        const contexto = {
          nombre_entidad: ent.nombre,
          nombre_anuncio: regla.nivel === 'campaign' ? '' : ent.nombre,
          nombre_campania:
            regla.nivel === 'campaign'
              ? ent.nombre
              : ent.campaign_nombre || '',
          motivo,
          gasto: ent.spend,
          mensajes: ent.msgs,
          costo_mensaje: ent.msgs > 0 ? ent.spend / ent.msgs : null,
          nuevo_presupuesto: nuevoPresupuestoTxt,
          nombre_regla: regla.nombre,
        };
        await enviarAvisoRegla({
          id_configuracion,
          evento:
            regla.accion === 'subir_presupuesto'
              ? 'regla_presupuesto_subido'
              : regla.nivel === 'campaign'
                ? 'regla_campania_pausada'
                : 'regla_anuncio_pausado',
          contexto,
        });
      } catch (e) {
        await registrarLog({
          ...base,
          resultado: 'error',
          detalle: String(e.message).slice(0, 1000),
        });
        resumen.disparos.push({ ...base, resultado: 'error' });
      }
    }
  }

  return resumen;
}

/* Corre el motor para todas las configuraciones con reglas activas. */
async function evaluarTodas() {
  const configs = await db.query(
    `SELECT DISTINCT id_configuracion FROM meta_ads_reglas WHERE activa = 1`,
    { type: db.QueryTypes.SELECT },
  );
  for (const c of configs) {
    try {
      await evaluarReglasConfig(c.id_configuracion);
    } catch (e) {
      logger.error(
        `metaAdsReglas cfg ${c.id_configuracion}: ${e.message}`,
      );
    }
  }
  return configs.length;
}

module.exports = {
  REGLAS_RECOMENDADAS,
  evaluarReglasConfig,
  evaluarTodas,
};
