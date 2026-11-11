/**
 * dropi_efectividad.service.js
 * «Reportes PRO» del vendedor: efectividad de entrega y utilidad por CIUDAD y
 * por TRANSPORTADORA de sus propios pedidos Dropi (dropi_orders_cache), con la
 * tasa del mercado en cada ciudad al lado y una calificación de 1 a 3 ⭐.
 * Encima, un análisis con IA (la llave de Claude u OpenAI del propio negocio)
 * que devuelve 3–5 acciones concretas: confirmar por llamada, cambiar de
 * transportadora, pausar una ciudad, revisar precio.
 *
 *  - Efectividad = entregadas / (entregadas + devoluciones + en curso): lo
 *    que va en camino cuenta como no entregado todavía (si no, una ciudad
 *    con 19 entregados, 0 devueltos y 45 en ruta salía al 100 %). Cuando
 *    ya no queda nada en curso es la efectividad final.
 *  - efectividad_final = entregadas / (entregadas + devoluciones), la que se
 *    compara con el mercado y da las estrellas, solo con la ciudad casi
 *    cerrada (en curso ≤ 20 % de lo vivo).
 *  - Utilidad = ganancia Dropi de las entregadas − flete de las devoluciones
 *    (un flete por devolución: shipping_amount del pedido en Dropi).
 *  - Mercado = misma ciudad, todas las tiendas del mismo país, últimos 90 días
 *    hasta el fin del rango (con el rango corto de «Hoy» no habría finalizadas).
 */
const axios = require('axios');
const { db } = require('../database/config');
const { llavesDeCuenta, claudeJson } = require('../utils/claude/claude');
const {
  _pais: { resolverPaisRaw, configsDePais },
} = require('../controllers/dropi_stats.controller');

const MIN_MUESTRA = 8; // entregadas + devoluciones mínimas para calificar
const UMBRAL_3 = 75; // ⭐⭐⭐ desde este % de entrega (y utilidad positiva)
const UMBRAL_2 = 55; // ⭐⭐ desde este % (y sin pérdida)
const DIAS_MERCADO = 90;
const MAX_EN_CURSO = 0.2; // hasta este peso de lo en curso la fila se da por cerrada
const MODELO_OPENAI = 'gpt-4.1-mini';
const TTL_IA_MS = 30 * 60 * 1000;
const cacheIA = new Map();

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const clave = (s) =>
  String(s || '')
    .trim()
    .toUpperCase();

const EN_CURSO = [
  'en_transito',
  'en_reparto',
  'novedad',
  'retiro_agencia',
  'guia_generada',
  'pendiente',
];
const EN_CURSO_SQL = EN_CURSO.map((s) => db.escape(s)).join(',');

const AGREGADOS = `
  COUNT(*) AS pedidos,
  SUM(c.classified_status = 'entregada') AS entregadas,
  SUM(c.classified_status = 'devolucion') AS devoluciones,
  SUM(c.classified_status IN (${EN_CURSO_SQL})) AS en_curso,
  SUM(c.classified_status = 'cancelada') AS canceladas,
  SUM(CASE WHEN c.classified_status = 'entregada' THEN c.total_order ELSE 0 END) AS venta,
  SUM(CASE WHEN c.classified_status = 'entregada' THEN COALESCE(c.dropshipper_profit, 0) ELSE 0 END) AS ganancia,
  SUM(CASE WHEN c.classified_status = 'devolucion' THEN COALESCE(c.flete_amount, 0) ELSE 0 END) AS flete_devoluciones`;

function estrellas(efectividad, finalizadas, utilidad) {
  if (finalizadas < MIN_MUESTRA || efectividad == null) return null;
  if (efectividad >= UMBRAL_3 && utilidad > 0) return 3;
  if (efectividad >= UMBRAL_2 && utilidad >= 0) return 2;
  return 1;
}

/* Suma una fila agregada de SQL sobre un acumulador (las ciudades llegan
   partidas por mayúsculas/espacios y se juntan por clave). */
function sumar(acc, r) {
  for (const k of [
    'pedidos',
    'entregadas',
    'devoluciones',
    'en_curso',
    'canceladas',
    'venta',
    'ganancia',
    'flete_devoluciones',
  ]) {
    acc[k] = (acc[k] || 0) + Number(r[k] || 0);
  }
  return acc;
}

function cerrar(acc) {
  const finalizadas = acc.entregadas + acc.devoluciones;
  const vivos = finalizadas + acc.en_curso;
  const utilidad = acc.ganancia - acc.flete_devoluciones;
  const efectividad = pct(acc.entregadas, vivos);
  const efectividadFinal = pct(acc.entregadas, finalizadas);
  const cerrada = vivos > 0 && acc.en_curso <= vivos * MAX_EN_CURSO;
  return {
    pedidos: acc.pedidos,
    entregadas: acc.entregadas,
    devoluciones: acc.devoluciones,
    en_curso: acc.en_curso,
    canceladas: acc.canceladas,
    finalizadas,
    efectividad,
    efectividad_final: efectividadFinal,
    cerrada,
    devolucion_pct: pct(acc.devoluciones, finalizadas),
    venta: r2(acc.venta),
    utilidad: r2(utilidad),
    margen: acc.venta > 0 ? Math.round((utilidad / acc.venta) * 1000) / 10 : null,
    estrellas: cerrada ? estrellas(efectividadFinal, finalizadas, utilidad) : null,
  };
}

function restarDias(ymd, dias) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

async function calcularEfectividad({ id_configuracion, from, until }) {
  const repl = {
    idCfg: id_configuracion,
    from: `${from} 00:00:00`,
    until: `${until} 23:59:59`,
  };
  const base = `
    FROM dropi_orders_cache c
   WHERE c.id_configuracion = :idCfg
     AND c.id_usuario = 0
     AND c.order_created_at BETWEEN :from AND :until
     AND (c.status <> 'REEMPLAZADA' OR c.status IS NULL)`;

  const [porCiudadCourier, porCourier] = await Promise.all([
    db.query(
      `SELECT c.city AS ciudad,
              COALESCE(NULLIF(TRIM(c.shipping_company), ''), 'SIN TRANSPORTADORA') AS transportadora,
              ${AGREGADOS}
         ${base}
          AND c.city IS NOT NULL AND TRIM(c.city) <> ''
        GROUP BY c.city, transportadora`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    ),
    db.query(
      `SELECT COALESCE(NULLIF(TRIM(c.shipping_company), ''), 'SIN TRANSPORTADORA') AS transportadora,
              ${AGREGADOS}
         ${base}
        GROUP BY transportadora`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    ),
  ]);

  // Ciudad → acumulado + desglose por transportadora
  const ciudades = new Map();
  const nombresCrudos = new Set();
  for (const r of porCiudadCourier) {
    nombresCrudos.add(r.ciudad);
    const k = clave(r.ciudad);
    if (!ciudades.has(k)) ciudades.set(k, { acc: {}, couriers: new Map() });
    const c = ciudades.get(k);
    sumar(c.acc, r);
    const kt = clave(r.transportadora);
    c.couriers.set(kt, sumar(c.couriers.get(kt) || {}, r));
  }

  // Mercado: misma ciudad, todas las tiendas del país, últimos 90 días.
  const mercado = new Map();
  if (nombresCrudos.size) {
    const paisRaw = await resolverPaisRaw(id_configuracion, []);
    const configs = await configsDePais(paisRaw);
    if (configs.length) {
      const filas = await db.query(
        `SELECT c.city AS ciudad,
                SUM(c.classified_status = 'entregada') AS entregadas,
                SUM(c.classified_status = 'devolucion') AS devoluciones
           FROM dropi_orders_cache c
          WHERE c.city IN (:ciudades)
            AND c.order_created_at BETWEEN :desde AND :until
            AND c.id_configuracion IN (${configs.join(',')})
          GROUP BY c.city`,
        {
          replacements: {
            ciudades: [...nombresCrudos],
            desde: `${restarDias(until, DIAS_MERCADO)} 00:00:00`,
            until: repl.until,
          },
          type: db.QueryTypes.SELECT,
        },
      );
      for (const r of filas) {
        const k = clave(r.ciudad);
        const m = mercado.get(k) || { e: 0, d: 0 };
        m.e += Number(r.entregadas || 0);
        m.d += Number(r.devoluciones || 0);
        mercado.set(k, m);
      }
    }
  }

  const listaCiudades = [...ciudades.entries()]
    .map(([k, c]) => {
      const m = mercado.get(k);
      const mFin = m ? m.e + m.d : 0;
      const fila = cerrar(c.acc);
      return {
        ciudad: k,
        ...fila,
        mercado_efectividad: mFin >= MIN_MUESTRA ? pct(m.e, mFin) : null,
        transportadoras: [...c.couriers.entries()]
          .map(([t, acc]) => ({ transportadora: t, ...cerrar(acc) }))
          .sort((a, b) => b.pedidos - a.pedidos),
      };
    })
    .sort((a, b) => b.pedidos - a.pedidos);

  const transportadoras = porCourier
    .map((r) => ({ transportadora: clave(r.transportadora), ...cerrar(sumar({}, r)) }))
    .sort((a, b) => b.pedidos - a.pedidos);

  const totales = cerrar(
    porCourier.reduce((acc, r) => sumar(acc, r), {}),
  );

  return {
    desde: from,
    hasta: until,
    dias_mercado: DIAS_MERCADO,
    min_muestra: MIN_MUESTRA,
    umbrales: { tres: UMBRAL_3, dos: UMBRAL_2 },
    totales,
    ciudades: listaCiudades,
    transportadoras,
  };
}

/* ── Análisis con IA ─────────────────────────────────────────── */

const PROMPT_SISTEMA = `Eres el analista de logística de una tienda que vende contraentrega (COD) con Dropi. Recibes la efectividad de entrega de la tienda por ciudad y por transportadora, con la tasa del mercado en cada ciudad.

Devuelve de 3 a 5 acciones concretas para subir la efectividad y la utilidad. Reglas:
- Usa SOLO los números que te dan. No inventes ciudades, transportadoras ni cifras.
- Utilidad negativa = solo si el número es menor que 0. No la llames negativa si es baja pero positiva.
- Cada acción menciona la ciudad o transportadora y el número que la justifica (ej. «entregas 52 % contra 71 % del mercado»).
- Prioriza por dinero en juego: ciudades con muchos pedidos y utilidad baja o negativa primero.
- Ignora ciudades con menos de 8 pedidos finalizados (entregados + devueltos): no hay muestra.
- Si la tienda está muy por debajo del mercado en una ciudad, el problema es de la tienda (confirmación, datos del cliente, producto); si toda la ciudad está baja, el problema es de la zona (confirmar por llamada, pedir anticipo o dejar de vender ahí).
- Si en una ciudad una transportadora entrega claramente mejor que otra (con muestra suficiente), recomienda cambiar.
- Tipos de acción: confirmar (confirmar por llamada o anticipo antes de despachar), cambiar_transportadora, pausar_ciudad, precio (subir precio o envío para cubrir devoluciones), otro.
- Español neutro, tuteo, frases cortas. El resumen: 1–2 frases con el diagnóstico general.`;

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen', 'acciones'],
  properties: {
    resumen: { type: 'string' },
    acciones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prioridad', 'tipo', 'donde', 'accion', 'motivo'],
        properties: {
          prioridad: { type: 'string', enum: ['alta', 'media', 'baja'] },
          tipo: {
            type: 'string',
            enum: [
              'confirmar',
              'cambiar_transportadora',
              'pausar_ciudad',
              'precio',
              'otro',
            ],
          },
          donde: { type: 'string' },
          accion: { type: 'string' },
          motivo: { type: 'string' },
        },
      },
    },
  },
};

function errorNegocio(mensaje, codigo) {
  const err = new Error(mensaje);
  err.codigo = codigo;
  return err;
}

/* Tabla compacta para el modelo: las 25 ciudades con más pedidos y, en cada
   una, las transportadoras con al menos 3 finalizadas. */
function construirEntrada(datos) {
  const t = datos.totales;
  const lineas = [
    `Periodo: ${datos.desde} a ${datos.hasta}. Mercado: últimos ${datos.dias_mercado} días.`,
    `TOTAL: ${t.pedidos} pedidos, ${t.entregadas} entregados, ${t.devoluciones} devueltos, ${t.en_curso} en curso, efectividad ${t.efectividad_final ?? '-'} %, venta entregada $${t.venta}, utilidad $${t.utilidad}.`,
    '',
    `CIUDADES (ciudad | pedidos | entregados | devueltos | en curso | efectividad % | mercado % | utilidad $ | transportadoras con ${MIN_MUESTRA}+ finalizadas: nombre efectividad% (finalizadas))`,
  ];
  for (const c of datos.ciudades.slice(0, 25)) {
    const tr = c.transportadoras
      .filter((x) => x.finalizadas >= MIN_MUESTRA)
      .map((x) => `${x.transportadora} ${x.efectividad_final}% (${x.finalizadas})`)
      .join(', ');
    lineas.push(
      `${c.ciudad} | ${c.pedidos} | ${c.entregadas} | ${c.devoluciones} | ${c.en_curso} | ${c.efectividad_final ?? '-'} | ${c.mercado_efectividad ?? '-'} | ${c.utilidad} | ${tr || '-'}`,
    );
  }
  lineas.push('', 'TRANSPORTADORAS (nombre | pedidos | efectividad % | utilidad $)');
  for (const x of datos.transportadoras) {
    lineas.push(
      `${x.transportadora} | ${x.pedidos} | ${x.efectividad_final ?? '-'} | ${x.utilidad}`,
    );
  }
  return lineas.join('\n');
}

async function analizarConIA({ id_configuracion, from, until }) {
  const k = `${id_configuracion}:${from}:${until}`;
  const hit = cacheIA.get(k);
  if (hit && Date.now() - hit.at < TTL_IA_MS) return { ...hit.data, cache: true };

  const datos = await calcularEfectividad({ id_configuracion, from, until });
  if ((datos.totales.finalizadas || 0) < MIN_MUESTRA) {
    throw errorNegocio(
      'Todavía no hay suficientes pedidos entregados o devueltos en este periodo para analizar. Prueba con un rango más largo.',
      'SIN_MUESTRA',
    );
  }

  const llaves = await llavesDeCuenta(id_configuracion);
  if (!llaves.usarClaude && !llaves.api_key_openai) {
    throw errorNegocio(
      'Este negocio todavía no tiene conectada una API Key de OpenAI ni de Claude. Conéctala en Asistentes para usar el análisis.',
      'OPENAI_KEY_MISSING',
    );
  }
  const entrada = construirEntrada(datos);
  let ia;

  if (llaves.usarClaude) {
    try {
      const r = await claudeJson({
        api_key_claude: llaves.api_key_claude,
        system: PROMPT_SISTEMA,
        input: entrada,
        schema: ESQUEMA,
        max_tokens: 1500,
      });
      ia = r.json;
    } catch (e) {
      console.error(`[EFECTIVIDAD_IA] Claude ${e?.status || ''} — ${e?.message}`);
      if (e?.status === 401)
        throw errorNegocio(
          'Tu API Key de Claude no es válida o fue revocada. Revísala en Asistentes.',
          'OPENAI_KEY_INVALID',
        );
      if (e?.status === 429 || /credit balance|too low/i.test(String(e?.message)))
        throw errorNegocio(
          'Tu cuenta de Claude no tiene saldo o llegó a su límite de uso.',
          'OPENAI_RATE_LIMIT',
        );
      throw errorNegocio('Claude no respondió. Intenta de nuevo en un momento.', 'OPENAI_ERROR');
    }
  } else {
    try {
      const { data } = await axios.post(
        'https://api.openai.com/v1/responses',
        {
          model: MODELO_OPENAI,
          instructions: PROMPT_SISTEMA,
          input: [{ role: 'user', content: [{ type: 'input_text', text: entrada }] }],
          text: {
            format: {
              type: 'json_schema',
              name: 'analisis_efectividad',
              strict: true,
              schema: ESQUEMA,
            },
          },
          temperature: 0.2,
          max_output_tokens: 1200,
        },
        {
          headers: { Authorization: `Bearer ${llaves.api_key_openai}` },
          timeout: 45000,
        },
      );
      const texto =
        data?.output_text ||
        (data?.output || [])
          .flatMap((o) => o.content || [])
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text)
          .join('');
      ia = JSON.parse(texto || 'null');
    } catch (e) {
      const st = e?.response?.status;
      console.error(`[EFECTIVIDAD_IA] OpenAI ${st || ''} — ${e?.message}`);
      if (st === 401)
        throw errorNegocio(
          'Tu API Key de OpenAI no es válida o fue revocada. Revísala en Asistentes.',
          'OPENAI_KEY_INVALID',
        );
      if (st === 429)
        throw errorNegocio(
          'Tu cuenta de OpenAI no tiene saldo o llegó a su límite de uso.',
          'OPENAI_RATE_LIMIT',
        );
      throw errorNegocio('OpenAI no respondió. Intenta de nuevo en un momento.', 'OPENAI_ERROR');
    }
  }

  if (!ia || !Array.isArray(ia.acciones)) {
    throw errorNegocio(
      'La IA devolvió una respuesta que no se pudo leer. Intenta de nuevo.',
      'OPENAI_EMPTY',
    );
  }
  const resultado = {
    resumen: String(ia.resumen || ''),
    acciones: ia.acciones.slice(0, 5),
    proveedor: llaves.usarClaude ? 'claude' : 'openai',
    generado: new Date().toISOString(),
  };
  cacheIA.set(k, { at: Date.now(), data: resultado });
  return resultado;
}

module.exports = { calcularEfectividad, analizarConIA, construirEntrada };
