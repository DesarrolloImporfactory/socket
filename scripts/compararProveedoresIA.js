// scripts/compararProveedoresIA.js
// OpenAI vs Claude en una cuenta: ¿con cuál vende mejor el bot?
//
// Separa cada respuesta del bot por el proveedor que la generó (el modelo
// guardado en mensajes_clientes.json_analytics_mensaje: claude-* → Claude;
// gpt-* o sin analytics → OpenAI) y atribuye cada conversación al proveedor
// que contestó la mayoría de sus turnos en el período. Con eso compara:
//
//   · respuestas con IA, tokens y costo estimado (precios de utils/preciosOpenAI)
//   · conversaciones atendidas y cuántas SIGUIERON (el cliente volvió a
//     escribir después de una respuesta del bot)
//   · cierres: conversaciones con orden creada en Dropi (dropi_auto_ordenes_log
//     resultado creada/actualizada) y conversaciones donde el bot escribió el
//     tag de cierre de la columna (kanban_acciones cambiar_estado)
//   · % de cierre sobre conversaciones que siguieron (la misma definición del
//     tablero de salud del bot) y costo por cierre
//   · tiempo medio de respuesta del bot
//   · por día: cuántas respuestas salieron con cada proveedor, para saber qué
//     días corrió cada uno (una semana con cada uno es lo ideal)
//
// Uso:
//   node scripts/compararProveedoresIA.js --config=10 [--dias=14] [--json]
//   node scripts/compararProveedoresIA.js --todas [--dias=14]   (cuentas con llave de Claude)
'use strict';

require('dotenv').config();
const { db } = require('../src/database/config');
const {
  PRECIOS,
  normalizarModelo,
} = require('../src/utils/preciosOpenAI');

const arg = (n) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=').slice(1).join('=') : null;
};
const tiene = (n) => process.argv.includes(`--${n}`);
const DIAS = Math.min(Math.max(Number(arg('dias')) || 14, 1), 90);

const SIN_IA = new Set(['IA_wizard', 'IA_mensaje_fijo', 'IA_respuesta_rapida']);

function proveedorDe(raw) {
  if (!raw) return { prov: 'openai', a: null };
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const modelo = String(a?.modelo || '');
    return { prov: /^claude-/i.test(modelo) ? 'claude' : 'openai', a: a?.modelo ? a : null };
  } catch {
    return { prov: 'openai', a: null };
  }
}

function costoDe(a, tokens, precioRef) {
  if (a) {
    const p = PRECIOS[normalizarModelo(a.modelo)] || precioRef;
    const cached = Number(a.cached) || 0;
    const entrada = Math.max(0, (Number(a.input) || 0) - cached);
    return (entrada * p.input + cached * p.cached + (Number(a.output) || 0) * p.output) / 1e6;
  }
  if (tokens > 0) {
    const e = Math.round(tokens * 0.95);
    return (e * precioRef.input + (tokens - e) * precioRef.output) / 1e6;
  }
  return 0;
}

function nuevoAgregado() {
  return {
    respuestas: 0,
    tokens: 0,
    costo_usd: 0,
    convers: 0,
    convers_siguieron: 0,
    cierres_dropi: 0,
    cierres_tag: 0,
    cierres: 0,
    mixtas: 0,
    tiempos_ms: [],
  };
}

async function comparar(id_configuracion) {
  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion, proveedor_ia, modelo_ref.modelo AS modelo_ref
       FROM configuraciones c
       LEFT JOIN (SELECT id_configuracion, modelo FROM kanban_columnas
                   WHERE activo = 1 AND activa_ia = 1 ORDER BY id LIMIT 1) modelo_ref
         ON modelo_ref.id_configuracion = c.id
      WHERE c.id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  ).catch(async () => {
    const [c] = await db.query(
      `SELECT id, nombre_configuracion, proveedor_ia FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    return [c];
  });
  if (!cfg) throw new Error(`cfg ${id_configuracion} no existe`);
  const precioRef = PRECIOS[normalizarModelo(cfg.modelo_ref)] || PRECIOS['gpt-4o-mini'];

  // Triggers de cierre de la cuenta (tags que mueven la tarjeta a otra columna).
  const acciones = await db.query(
    `SELECT ka.config FROM kanban_acciones ka
       INNER JOIN kanban_columnas kc ON kc.id = ka.id_kanban_columna
      WHERE kc.id_configuracion = ? AND ka.activo = 1 AND ka.tipo_accion = 'cambiar_estado'`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const triggers = acciones
    .map((r) => {
      try {
        const c = typeof r.config === 'string' ? JSON.parse(r.config) : r.config;
        return String(c?.trigger || '').toLowerCase();
      } catch {
        return '';
      }
    })
    .filter((t) => t && /cierre|venta|cerrad|confirm|pedido/i.test(t));

  // Todos los mensajes del período, en orden, por conversación.
  const msgs = await db.query(
    `SELECT id, celular_recibe, rol_mensaje, responsable, texto_mensaje, created_at,
            COALESCE(total_tokens_openai_mensaje, 0) AS tokens, json_analytics_mensaje
       FROM mensajes_clientes
      WHERE id_configuracion = ?
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND (rol_mensaje = 0 OR responsable LIKE 'IA\\_%')
      ORDER BY celular_recibe, id`,
    { replacements: [id_configuracion, DIAS], type: db.QueryTypes.SELECT },
  );

  // Órdenes creadas en Dropi por cliente (id_cliente = celular_recibe en el log).
  const ordenes = await db.query(
    `SELECT DISTINCT id_cliente FROM dropi_auto_ordenes_log
      WHERE id_configuracion = ? AND resultado IN ('creada','actualizada')
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    { replacements: [id_configuracion, DIAS], type: db.QueryTypes.SELECT },
  );
  const conOrden = new Set(ordenes.map((o) => String(o.id_cliente)));

  const porProv = { openai: nuevoAgregado(), claude: nuevoAgregado() };
  const porDia = new Map();

  // Agrupar por conversación
  const convs = new Map();
  for (const m of msgs) {
    const k = String(m.celular_recibe);
    if (!convs.has(k)) convs.set(k, []);
    convs.get(k).push(m);
  }

  for (const [cel, lista] of convs) {
    const cuenta = { openai: 0, claude: 0 };
    let primeraIA = null;
    let siguio = false;
    let cierreTag = false;
    let ultimoCliente = null;
    for (const m of lista) {
      if (String(m.rol_mensaje) === '0') {
        ultimoCliente = new Date(m.created_at);
        if (primeraIA) siguio = true;
        continue;
      }
      if (SIN_IA.has(m.responsable)) continue;
      const { prov, a } = proveedorDe(m.json_analytics_mensaje);
      cuenta[prov] += 1;
      const ag = porProv[prov];
      ag.respuestas += 1;
      ag.tokens += Number(m.tokens) || 0;
      ag.costo_usd += costoDe(a, Number(m.tokens) || 0, precioRef);
      if (!primeraIA) primeraIA = m;
      if (ultimoCliente) {
        const dt = new Date(m.created_at) - ultimoCliente;
        if (dt > 0 && dt < 10 * 60 * 1000) ag.tiempos_ms.push(dt);
        ultimoCliente = null;
      }
      const t = String(m.texto_mensaje || '').toLowerCase();
      if (triggers.some((tr) => t.includes(tr))) cierreTag = true;
      const dia = String(m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at).slice(0, 10);
      if (!porDia.has(dia)) porDia.set(dia, { openai: 0, claude: 0 });
      porDia.get(dia)[prov] += 1;
    }
    const total = cuenta.openai + cuenta.claude;
    if (!total) continue;
    const prov = cuenta.claude > cuenta.openai ? 'claude' : 'openai';
    const ag = porProv[prov];
    ag.convers += 1;
    if (cuenta.openai && cuenta.claude) ag.mixtas += 1;
    if (siguio) ag.convers_siguieron += 1;
    const dropi = conOrden.has(cel);
    if (dropi) ag.cierres_dropi += 1;
    if (cierreTag) ag.cierres_tag += 1;
    if (dropi || cierreTag) ag.cierres += 1;
  }

  const fila = (p) => {
    const a = porProv[p];
    const med = a.tiempos_ms.length
      ? a.tiempos_ms.sort((x, y) => x - y)[Math.floor(a.tiempos_ms.length / 2)] / 1000
      : null;
    return {
      proveedor: p,
      respuestas: a.respuestas,
      tokens: a.tokens,
      costo_usd: +a.costo_usd.toFixed(4),
      costo_por_respuesta: a.respuestas ? +(a.costo_usd / a.respuestas).toFixed(4) : null,
      conversaciones: a.convers,
      conversaciones_mixtas: a.mixtas,
      siguieron: a.convers_siguieron,
      pct_siguieron: a.convers ? +((100 * a.convers_siguieron) / a.convers).toFixed(1) : null,
      cierres: a.cierres,
      cierres_dropi: a.cierres_dropi,
      cierres_tag: a.cierres_tag,
      pct_cierre_sobre_siguieron: a.convers_siguieron
        ? +((100 * a.cierres) / a.convers_siguieron).toFixed(1)
        : null,
      costo_por_cierre: a.cierres ? +(a.costo_usd / a.cierres).toFixed(3) : null,
      respuesta_mediana_seg: med !== null ? +med.toFixed(1) : null,
    };
  };

  return {
    id_configuracion,
    nombre: cfg.nombre_configuracion,
    proveedor_actual: cfg.proveedor_ia || 'openai',
    dias: DIAS,
    triggers_cierre: triggers,
    openai: fila('openai'),
    claude: fila('claude'),
    por_dia: [...porDia.entries()].sort().map(([dia, v]) => ({ dia, ...v })),
  };
}

function imprimir(r) {
  console.log(`\n== cfg ${r.id_configuracion} · ${r.nombre || ''} · responde hoy con ${r.proveedor_actual} · últimos ${r.dias} días`);
  if (!r.triggers_cierre.length) console.log('   (sin tag de cierre configurado: los cierres solo cuentan por órdenes Dropi)');
  const cols = [
    ['respuestas', 'Respuestas IA'],
    ['costo_usd', 'Costo USD'],
    ['costo_por_respuesta', 'USD/respuesta'],
    ['conversaciones', 'Conversaciones'],
    ['siguieron', 'Siguieron'],
    ['pct_siguieron', '% siguieron'],
    ['cierres', 'Cierres'],
    ['pct_cierre_sobre_siguieron', '% cierre'],
    ['costo_por_cierre', 'USD/cierre'],
    ['respuesta_mediana_seg', 'Resp. mediana (s)'],
  ];
  const w = 20;
  console.log('   ' + 'Métrica'.padEnd(28) + 'OpenAI'.padStart(w) + 'Claude'.padStart(w));
  for (const [k, lab] of cols) {
    const f = (v) => (v === null || v === undefined ? '—' : String(v));
    console.log('   ' + lab.padEnd(28) + f(r.openai[k]).padStart(w) + f(r.claude[k]).padStart(w));
  }
  const mixtas = r.openai.conversaciones_mixtas + r.claude.conversaciones_mixtas;
  if (mixtas) console.log(`   (${mixtas} conversaciones tuvieron turnos de los dos; se atribuyen al que contestó más)`);
  console.log('   Por día (respuestas OpenAI / Claude):');
  console.log('   ' + r.por_dia.map((d) => `${d.dia.slice(5)} ${d.openai}/${d.claude}`).join(' · '));
}

(async () => {
  let ids = [];
  if (arg('config')) ids = [Number(arg('config'))];
  else if (tiene('todas')) {
    ids = (
      await db.query(
        `SELECT id FROM configuraciones WHERE api_key_claude IS NOT NULL AND api_key_claude <> '' ORDER BY id`,
        { type: db.QueryTypes.SELECT },
      )
    ).map((r) => r.id);
  } else {
    console.log('Uso: --config=ID | --todas  [--dias=14] [--json]');
    process.exit(1);
  }
  const out = [];
  for (const id of ids) {
    const r = await comparar(id);
    out.push(r);
    if (!tiene('json')) imprimir(r);
  }
  if (tiene('json')) console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
