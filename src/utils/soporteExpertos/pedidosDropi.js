/**
 * «¿Qué pasa con mis pedidos de Dropi?» (auditoría 265 del 27-oct, grupo c:
 * ••••4081, guías retenidas, «si mi pedido ya está en la agencia»).
 *
 * De dónde sale el dato: del caché de órdenes Dropi de IMPORCHAT
 * (dropi_orders_cache), que el sync y el webhook de cada tienda conectada
 * mantienen al día. NO se consulta Dropi en vivo: Dropi limita por IP y un
 * 429 frena a todas las tiendas del servidor (dropiRateLimiter.js).
 *
 * De quién: solo de la cuenta de IMPORCHAT del que escribe, identificada igual
 * que revisar_mi_imporchat (diagnosticoCuenta.quienEs: su WhatsApp, el cruce
 * por su plataforma de Imporsuit o el número/correo que escribió en este
 * turno). Si se le encontró solo por el número de una conexión, solo se leen
 * los pedidos de esa conexión (en una agencia, las otras pueden ser de otro).
 * El modelo nunca elige de qué cuenta leer.
 *
 * Qué devuelve: el conteo por estado de los últimos 30 días y los pedidos
 * que más esperan o tienen novedad (o los que coinciden con la guía, el
 * número de pedido o el cliente que escribió), con el último movimiento de la
 * transportadora. Del cliente final solo nombre, inicial del apellido y
 * ciudad: el teléfono y la dirección no salen.
 */
const { quienEs, consultarImporchat } = require('./diagnosticoCuenta');
const { urlTrackingParaCliente } = require('../trackingTransportadora');
const { consultarImporsuit } = require('./cargaCliente');
const T = require('./textos');

const DIAS = 30;
const DIAS_BUSCAR = 60;
const MAX_LISTA = 3;
const MAX_BUSCAR = 3;
const ESPERA_DIAS = 5; // en camino hace más de esto = «lleva días»
const LIMITE_MS = 7000; // la herramienta tiene 8 s de tope
const MAX_TEXTO = 1400;

const CERRADOS = ['entregada', 'cancelada'];
// En la lista de «los que esperan» tampoco van las devoluciones: casi todas ya
// volvieron al remitente (se cuentan arriba y se encuentran buscando la guía).
const FUERA_DE_LISTA = [...CERRADOS, 'devolucion'];
const NOMBRE_ESTADO = {
  pendiente: 'pendientes de confirmar',
  guia_generada: 'con guía generada',
  en_transito: 'en tránsito',
  en_reparto: 'en reparto',
  retiro_agencia: 'para retiro en agencia',
  novedad: 'con novedad',
  devolucion: 'en devolución',
  entregada: 'entregados',
  cancelada: 'cancelados',
  otro: 'en otro estado',
};
const ORDEN_ESTADOS = Object.keys(NOMBRE_ESTADO);

const CUANDO = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s')`;

const SQL_CONEXIONES = (conPropia) => `
  SELECT id FROM configuraciones
   WHERE id_usuario = :uid${conPropia ? ' AND id <> :propia' : ''}
   LIMIT 30`;
const SQL_INTEGRACIONES = `
  SELECT id_configuracion, country_code, is_active
    FROM dropi_integrations
   WHERE id_configuracion IN (:ids) AND deleted_at IS NULL`;
// REEMPLAZADA: Dropi la cambió por otra orden; no es un pedido del cliente.
const NO_REEMPLAZADA = "AND COALESCE(status, '') <> 'REEMPLAZADA'";
const SQL_CONTEO = `
  SELECT classified_status AS estado, COUNT(*) AS n, ${CUANDO('MAX(synced_at)')} AS sync
    FROM dropi_orders_cache
   WHERE id_configuracion IN (:ids) AND order_created_at >= NOW() - INTERVAL ${DIAS} DAY ${NO_REEMPLAZADA}
   GROUP BY classified_status`;
const COLS = `dropi_order_id, status, classified_status AS estado, name, surname, city,
       shipping_company, shipping_guide, product_names, agencia_retiro,
       ${CUANDO('order_created_at')} AS creada, order_data`;
// Primero las novedades, luego lo abierto más viejo.
const SQL_ABIERTOS = `
  SELECT ${COLS}
    FROM dropi_orders_cache
   WHERE id_configuracion IN (:ids) AND order_created_at >= NOW() - INTERVAL ${DIAS} DAY ${NO_REEMPLAZADA}
     AND classified_status NOT IN (:fuera)
   ORDER BY (classified_status = 'novedad') DESC, order_created_at ASC
   LIMIT ${MAX_LISTA}`;
const SQL_BUSCAR = (donde) => `
  SELECT ${COLS}
    FROM dropi_orders_cache
   WHERE id_configuracion IN (:ids) AND order_created_at >= NOW() - INTERVAL ${DIAS_BUSCAR} DAY ${NO_REEMPLAZADA}
     AND (${donde})
   ORDER BY order_created_at DESC
   LIMIT ${MAX_BUSCAR}`;

const conLimite = (promesa, ms) =>
  Promise.race([
    promesa,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`pedidosDropi: más de ${ms} ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** '2026-10-27 10:51:30' o '2026-10-27T10:51:30' (hora de Ecuador) → '27-oct'. */
function dia(f) {
  const m = String(f || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])}-${MESES[Number(m[2]) - 1]}` : '';
}
const plano = (t, max = 60) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const cliente = (o) => {
  const n = plano(String(o.name || '').split(' ')[0], 20);
  const a = String(o.surname || '').trim().charAt(0).toUpperCase();
  const c = plano(o.city, 25);
  return `${n}${a ? ` ${a}.` : ''}${c ? ` (${c})` : ''}`.trim() || 'sin nombre';
};

/** Último movimiento de la transportadora y la novedad, del JSON de Dropi. */
function movimiento(o) {
  let d = null;
  try {
    d = JSON.parse(o.order_data || 'null');
  } catch (_) {
    d = null;
  }
  const movs = Array.isArray(d?.servientrega_movements) ? d.servientrega_movements : [];
  const ultimo = movs.length ? movs[movs.length - 1] : null;
  return {
    ultimo: ultimo ? { que: plano(ultimo.nom_mov, 80), cuando: dia(ultimo.created_at) } : null,
    novedad: plano(d?.novedad_servientrega, 120) || null,
  };
}

/** product_names viene como JSON ('["Tabla de picar"]') o como texto. */
function productos(v) {
  try {
    const a = JSON.parse(v);
    if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean).join(', ');
  } catch (_) {
    /* texto plano */
  }
  return String(v || '');
}

function lineaPedido(o, ahoraMs) {
  const m = movimiento(o);
  const partes = [`Pedido #${o.dropi_order_id}`, cliente(o)];
  const prod = plano(productos(o.product_names), 50);
  if (prod) partes.push(prod);
  partes.push(`creado el ${dia(o.creada)}`);
  let estado = `estado: ${plano(o.status, 60) || o.estado}`;
  if (o.estado === 'novedad' && m.novedad) estado += ` («${m.novedad}»)`;
  if (m.ultimo && m.ultimo.que && m.ultimo.que.toUpperCase() !== String(o.status || '').toUpperCase()) {
    estado += `; último movimiento: ${m.ultimo.que}${m.ultimo.cuando ? ` el ${m.ultimo.cuando}` : ''}`;
  } else if (m.ultimo?.cuando) {
    estado += ` desde el ${m.ultimo.cuando}`;
  }
  partes.push(estado);
  const creada = Date.parse(String(o.creada || '').replace(' ', 'T'));
  if (!CERRADOS.includes(o.estado) && Number.isFinite(creada) && ahoraMs - creada > ESPERA_DIAS * 86400000) {
    partes.push(`lleva ${Math.floor((ahoraMs - creada) / 86400000)} días`);
  }
  if (o.shipping_guide) {
    const url = urlTrackingParaCliente(o.shipping_company, o.shipping_guide);
    partes.push(`${plano(o.shipping_company, 30) || 'guía'} ${o.shipping_guide}${url ? ` · rastreo: ${url}` : ''}`);
  }
  if (o.estado === 'retiro_agencia' && o.agencia_retiro) partes.push(`agencia: ${plano(o.agencia_retiro, 80)}`);
  return `- ${partes.join(' · ')}`;
}

/** Lo que escribió el alumno para buscar → condición SQL y sus valores. */
function condicionBuscar(buscar) {
  const t = String(buscar || '').trim().slice(0, 60);
  if (!t) return null;
  const dig = t.replace(/\D/g, '');
  const conds = [];
  const vals = {};
  if (/^[\dA-Za-z-]{5,30}$/.test(t)) {
    conds.push('shipping_guide = :guia');
    vals.guia = t;
  }
  if (dig && dig.length >= 4 && dig.length <= 12 && dig === t.replace(/[\s#-]/g, '')) {
    conds.push('dropi_order_id = :orden');
    vals.orden = Number(dig);
  }
  if (dig.length >= 9 && dig.length <= 15) {
    conds.push("RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', ''), 9) = :cola");
    vals.cola = dig.slice(-9);
  }
  const palabras = t.replace(/[^A-Za-zÁÉÍÓÚÑÜáéíóúñü ]+/g, ' ').trim();
  if (!dig && palabras.length >= 3) {
    conds.push("CONCAT(COALESCE(name, ''), ' ', COALESCE(surname, '')) LIKE :nombre");
    vals.nombre = `%${palabras.replace(/\s+/g, '%')}%`;
  }
  return conds.length ? { donde: conds.join(' OR '), vals } : null;
}

const FIJO = (estado, texto, extra = {}) => ({ estado, texto, ...extra });

async function leer(telefono, o) {
  const consultar = o.consultar || consultarImporchat;
  // Igual que revisar_mi_imporchat: sin consultas inyectadas, cruza también por Imporsuit.
  const consultarIS = o.consultarImporsuit || (o.consultar ? null : consultarImporsuit);
  const ahora = o.ahora instanceof Date ? o.ahora : new Date();
  const propia = Number(o.propia) || null;
  const dueno = await quienEs(telefono, { ...o, consultar, consultarImporsuit: consultarIS, propia, ahora });
  if (dueno.fijo) return FIJO(dueno.fijo.estado, dueno.fijo.texto, { identidad: true });
  const { quien, por, porDato } = dueno;

  const conexiones = ((await consultar(SQL_CONEXIONES(Boolean(propia)), propia ? { uid: quien.idUsuario, propia } : { uid: quien.idUsuario })) || [])
    .map((f) => Number(f.id))
    .filter((id) => id && (!quien.solo || quien.solo.has(id)));
  const integraciones = conexiones.length ? (await consultar(SQL_INTEGRACIONES, { ids: conexiones })) || [] : [];
  const ids = [...new Set(integraciones.map((f) => Number(f.id_configuracion)).filter(Boolean))];
  if (!ids.length) return FIJO('sin_dropi', T.DROPI.sin_dropi, { por });
  const activa = integraciones.some((f) => Number(f.is_active) === 1);

  const conteo = (await consultar(SQL_CONTEO, { ids })) || [];
  const cond = condicionBuscar(o.buscar);
  let pedidos;
  let modo = 'resumen';
  if (cond) {
    pedidos = (await consultar(SQL_BUSCAR(cond.donde), { ids, ...cond.vals })) || [];
    modo = 'buscar';
  } else {
    pedidos = (await consultar(SQL_ABIERTOS, { ids, fuera: FUERA_DE_LISTA })) || [];
  }

  const ahoraMs = ahora.getTime();
  const total = conteo.reduce((s, f) => s + Number(f.n || 0), 0);
  const sync = conteo.map((f) => f.sync).filter(Boolean).sort().pop() || null;
  const lineas = [];
  if (porDato) lineas.push(porDato);
  lineas.push(`🛒 Tus pedidos de Dropi (tienda conectada a tu IMPORCHAT${sync ? `, actualizado el ${dia(sync)} a las ${String(sync).slice(11, 16)}` : ''}):`);
  if (!activa) lineas.push(T.DROPI.integracion_apagada);
  if (total) {
    const porEstado = new Map(conteo.map((f) => [f.estado || 'otro', Number(f.n || 0)]));
    const resumen = ORDEN_ESTADOS.filter((k) => porEstado.get(k)).map((k) => `${porEstado.get(k)} ${NOMBRE_ESTADO[k]}`);
    lineas.push(`Últimos ${DIAS} días: ${total} pedidos — ${resumen.join(', ')}.`);
  } else {
    lineas.push(`Últimos ${DIAS} días: no hay pedidos registrados.`);
  }
  if (modo === 'buscar') {
    lineas.push(pedidos.length ? `Coinciden con «${plano(o.buscar, 40)}»:` : T.DROPI.no_coincide.replace('{dato}', plano(o.buscar, 40)));
  } else if (pedidos.length) {
    lineas.push('Los que tienen novedad o llevan más tiempo:');
  }
  for (const p of pedidos) lineas.push(lineaPedido(p, ahoraMs));

  let texto = lineas.join('\n');
  if (texto.length > MAX_TEXTO) texto = `${texto.slice(0, MAX_TEXTO - 1)}…`;
  return { estado: 'leido', por, modo, total, encontrados: pedidos.length, texto };
}

/**
 * @param {string} telefono  el WhatsApp del que escribe
 * @param {object} [o]       { dato, mensaje, buscar, propia, consultar, consultarImporsuit, ahora, limite_ms }
 * @returns {Promise<object>} estado: leido | sin_dropi | sin_cuenta | ambiguo | pide_dato | limite | error
 */
async function pedidosDropi(telefono, o = {}) {
  try {
    return await conLimite(leer(telefono, o), o.limite_ms || LIMITE_MS);
  } catch (err) {
    return FIJO('error', T.DROPI.error, { motivo: String(err?.message || err) });
  }
}

/** Lo que recibe el modelo. */
function bloquePedidosDropi(r) {
  if (!r) return T.DROPI.error;
  if (r.estado !== 'leido') return r.texto;
  return `${r.texto}\n${T.DROPI.instruccion}`;
}

module.exports = { pedidosDropi, bloquePedidosDropi, condicionBuscar, dia, MAX_TEXTO };
