/**
 * dropi_cartera.service.js
 * Bloque «Cobros de Dropi para reclamar» del dashboard de conexión v2.
 *
 * El detalle de cada orden en Dropi (GET /orders/myorders/:id) trae su
 * history_wallet: los movimientos de cartera de esa orden. Se revisa cada
 * orden UNA vez al llegar a un estado final y se marca lo que Dropi cobró
 * de más:
 *   - cobro_repetido      dos salidas idénticas (mismo monto y descripción)
 *   - flete_de_mas        devolución con más flete cobrado que el de la orden
 *   - flete_en_entregada  orden entregada con cobro de flete (la ganancia ya
 *                         viene sin flete: se cobró dos veces)
 *   - ganancia_no_pagada  entregada hace +20 días y la ganancia no entró
 *   - cobro_en_cancelada  cancelada / anulada con cobro neto
 * Comprobado con Import Store (cfg 324, 10-11-2026): 1.073 órdenes, 5 cobros
 * de más por $33,37 (2 fletes dobles en el mismo segundo y 3 entregadas con
 * flete).
 *
 * Una orden queda «cerrada» (no se vuelve a pedir) cuando es final y tiene
 * más de DIAS_CIERRE días: Dropi paga la ganancia y cobra el flete unos días
 * después del cambio de estado. Antes de eso se revisa de nuevo cada
 * DIAS_RECHEQUEO días.
 *
 * El sincronizador arranca solo cuando la tienda abre el bloque y corre en
 * el servidor aunque cierre la pantalla. Va una orden a la vez por el
 * limitador global de Dropi (services/dropi.service.js), máximo
 * MAX_SINCRONIZANDO tiendas a la vez para no comerse el cupo de los crons.
 */
const { db } = require('../database/config');
const DropiIntegrations = require('../models/dropi_integrations.model');
const { decryptToken } = require('../utils/cryptoToken');
const dropiService = require('./dropi.service');

const FINALES = ['ENTREGADO', 'DEVOLUCION', 'CANCELADO', 'GUIA_ANULADA', 'RECHAZADO'];
// Solo se revisan las órdenes de los últimos DIAS_HISTORIA días: una cuenta
// grande (8.000+ órdenes) tardaría horas, y un cobro más viejo ya no se
// reclama en Dropi.
const DIAS_HISTORIA = 180;
// Una orden se cierra cuando lleva DIAS_CIERRE días sin movimientos de
// cartera. Si es reciente (menos de DIAS_VIEJA días), además tiene que
// haberse visto ya en ese estado final en una revisión anterior: Dropi
// cobra el flete de devolución días después del cambio de estado.
const DIAS_CIERRE = 20;
const DIAS_VIEJA = 60;
const DIAS_RECHEQUEO = 3;
const MAX_SINCRONIZANDO = 2;
const PAUSA_MS = 700;
const TOL = 0.02;
const ESTADOS_RECLAMO = ['pendiente', 'reclamado', 'devuelto', 'descartado'];

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const lista = (arr) => arr.map((s) => db.escape(s)).join(',');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tabla ───────────────────────────────────────────────────────────────
let tablaLista = false;
async function ensureTabla() {
  if (tablaLista) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS dropi_cartera_revision (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      id_configuracion BIGINT UNSIGNED NOT NULL,
      dropi_order_id BIGINT UNSIGNED NOT NULL,
      status VARCHAR(100) NULL,
      guia VARCHAR(100) NULL,
      transportadora VARCHAR(100) NULL,
      order_created_at DATETIME NULL,
      shipping_amount DECIMAL(10,2) NULL,
      profit DECIMAL(10,2) NULL,
      movimientos TEXT NULL,
      hallazgos TEXT NULL,
      monto_reclamo DECIMAL(10,2) NOT NULL DEFAULT 0,
      cerrada TINYINT(1) NOT NULL DEFAULT 0,
      proxima_revision DATETIME NULL,
      reclamo_estado ENUM('pendiente','reclamado','devuelto','descartado') NOT NULL DEFAULT 'pendiente',
      reclamo_actualizado_en DATETIME NULL,
      revisado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_orden (id_configuracion, dropi_order_id),
      KEY ix_reclamo (id_configuracion, monto_reclamo),
      KEY ix_revision (id_configuracion, cerrada, proxima_revision)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  tablaLista = true;
}

// ── Reglas ──────────────────────────────────────────────────────────────
const esFlete = (desc) => /FLETE|DEVOLUCI/i.test(String(desc || ''));
const esGanancia = (desc) => /GANANCIA/i.test(String(desc || ''));
// Cuenta de proveedor (p. ej. IMPORSHOP PROVEEDOR): su cartera cobra como
// proveedor y el profit de la orden es la ganancia del dropshipper, así que
// las reglas de este bloque no aplican.
const esProveedor = (hw) => (hw || []).some((w) => /COMO PROVEEDOR/i.test(String(w.description || '')));
const DIA = 86400000;

// Fechas de Dropi («2026-05-14T12:28:40», hora de la tienda) → «14-may 12:28».
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fechaCorta(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? `${Number(m[3])}-${MESES[Number(m[2]) - 1]}-${m[1]} ${m[4]}:${m[5]}` : String(s || '');
}
const seg = (s) => String(s || '').slice(0, 19).replace(' ', 'T');
// Cambios de estado (orden.history) a la misma hora que un movimiento de
// cartera: Dropi cobra al recibir el estado, con 1-2 segundos de diferencia.
const cerca = (a, b) => Math.abs(new Date(seg(a)) - new Date(seg(b))) <= 5000;
const estadosEn = (historial, fecha) => historial.filter((h) => cerca(h.created_at, fecha));

/**
 * orden = { status, rate_type, shipping_amount, profit, created_at, history_wallet, history }
 * estadoPrevio = status guardado en la revisión anterior (o null).
 */
function evaluar(orden, ahora = new Date(), estadoPrevio = null) {
  const st = String(orden.status || '').toUpperCase();
  const hw = Array.isArray(orden.history_wallet) ? orden.history_wallet : [];
  const historial = Array.isArray(orden.history) ? orden.history : [];
  // SIN RECAUDO: el cliente le paga directo a la tienda y Dropi cobra producto
  // + flete al crear la orden («SALIDA POR NUEVA ORDEN»). Ahí nunca entra
  // ganancia ni hay flete aparte, así que esas dos reglas no aplican.
  const sinRecaudo = /SIN RECAUDO/i.test(String(orden.rate_type || ''));
  const flete = Number(orden.shipping_amount || 0);
  const profit = Number(orden.profit || 0);
  const salidas = hw.filter((w) => w.type === 'SALIDA');
  const entradas = hw.filter((w) => w.type === 'ENTRADA');
  const suma = (arr) => arr.reduce((s, w) => s + Number(w.amount || 0), 0);
  const ids = (arr) => arr.map((w) => w.id).join(', ');
  const hallazgos = [];

  // Salidas idénticas repetidas
  const grupos = new Map();
  for (const w of salidas) {
    const k = `${r2(w.amount)}|${w.description}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(w);
  }
  let repetido = 0;
  for (const g of grupos.values()) {
    if (g.length < 2) continue;
    const monto = r2(Number(g[0].amount) * (g.length - 1));
    repetido += monto;
    // Causa: la transportadora mandó el mismo estado varias veces en el mismo
    // segundo y Dropi cobró por cada aviso.
    const avisos = estadosEn(historial, g[0].created_at);
    const mismoSegundo = g.every((w) => cerca(w.created_at, g[0].created_at));
    const causa = mismoSegundo && avisos.length >= g.length
      ? ` El ${fechaCorta(g[0].created_at)} el estado ${String(avisos[0].status).toUpperCase()} llegó ${avisos.length} veces en el mismo segundo y Dropi cobró por cada aviso: corresponde un solo cobro.`
      : '';
    hallazgos.push({
      tipo: 'cobro_repetido',
      monto,
      detalle: `Se cobró ${g.length} veces $${r2(g[0].amount).toFixed(2)} por el mismo concepto.${causa}`,
      movimientos: ids(g),
    });
  }

  const fleteCobrado = suma(salidas.filter((w) => esFlete(w.description)));
  if (st === 'DEVOLUCION' && fleteCobrado - repetido > flete + TOL) {
    hallazgos.push({
      tipo: 'flete_de_mas',
      monto: r2(fleteCobrado - repetido - flete),
      detalle: `Flete cobrado $${r2(fleteCobrado).toFixed(2)} y el de la orden es $${r2(flete).toFixed(2)}`,
      movimientos: ids(salidas),
    });
  }
  const ganancia = suma(entradas.filter((w) => esGanancia(w.description)));
  if (st === 'ENTREGADO' && !sinRecaudo && fleteCobrado - repetido > TOL) {
    const fletes = salidas.filter((w) => esFlete(w.description));
    // Causa habitual: la transportadora marcó DEVOLUCION por error (Dropi
    // cobra el flete en ese mismo segundo) y luego la orden volvió a
    // ENTREGADO sin que Dropi devolviera el cobro.
    const f = fletes[0];
    const devol = f && estadosEn(historial, f.created_at).find((h) => /DEVOLUCI/i.test(h.status));
    const vuelta = devol && historial.find((h) => seg(h.created_at) > seg(devol.created_at)
      && String(h.status).toUpperCase() === 'ENTREGADO');
    const cuenta = ganancia > TOL
      ? `Dropi pagó $${r2(ganancia).toFixed(2)} de ganancia, que ya viene sin el flete de $${r2(flete).toFixed(2)}, y además cobró $${r2(fleteCobrado - repetido).toFixed(2)} de flete.`
      : `La orden está entregada y se cobraron $${r2(fleteCobrado - repetido).toFixed(2)} de flete, que ya va descontado de la ganancia.`;
    const causa = vuelta
      ? ` El ${fechaCorta(devol.created_at)} la transportadora la marcó DEVOLUCION y Dropi cobró el flete; el ${fechaCorta(vuelta.created_at)} volvió a ENTREGADO y el flete no se devolvió.`
      : '';
    hallazgos.push({
      tipo: 'flete_en_entregada',
      monto: r2(fleteCobrado - repetido),
      detalle: cuenta + causa,
      movimientos: ids(fletes),
    });
  }
  const creada = orden.created_at ? new Date(orden.created_at) : null;
  const dias = creada ? (ahora - creada) / 86400000 : 0;
  if (st === 'ENTREGADO' && !sinRecaudo && dias > DIAS_CIERRE && profit > 0 && ganancia + TOL < profit) {
    hallazgos.push({
      tipo: 'ganancia_no_pagada',
      monto: r2(profit - ganancia),
      detalle: ganancia > 0
        ? `Se pagaron $${r2(ganancia).toFixed(2)} de ganancia y la orden marca $${r2(profit).toFixed(2)}`
        : `Entregada hace ${Math.floor(dias)} días y la ganancia de $${r2(profit).toFixed(2)} no entró a la cartera`,
      movimientos: ids(entradas),
    });
  }
  const neto = suma(salidas) - suma(entradas);
  if ((st === 'CANCELADO' || st === 'GUIA_ANULADA') && neto - repetido > TOL) {
    hallazgos.push({
      tipo: 'cobro_en_cancelada',
      monto: r2(neto - repetido),
      detalle: 'Orden cancelada que nunca salió y tiene cobro en cartera',
      movimientos: ids(salidas),
    });
  }

  const final = FINALES.includes(st);
  const fechas = hw.map((w) => new Date(w.created_at).getTime()).filter((t) => !Number.isNaN(t));
  if (creada && !Number.isNaN(creada.getTime())) fechas.push(creada.getTime());
  const quieto = fechas.length ? (ahora - Math.max(...fechas)) / DIA : Infinity;
  const vieja = !creada || dias > DIAS_VIEJA;
  const yaVistaFinal = String(estadoPrevio || '').toUpperCase() === st;
  // Sin punto final: la pantalla arma el texto del reclamo uniendo con «. ».
  for (const h of hallazgos) h.detalle = h.detalle.replace(/\.$/, '');
  return {
    hallazgos,
    monto: r2(hallazgos.reduce((s, h) => s + h.monto, 0)),
    cerrada: final && quieto > DIAS_CIERRE && (vieja || yaVistaFinal),
  };
}

async function guardar(id_configuracion, dropi_order_id, orden) {
  const [previa] = await db.query(
    'SELECT status FROM dropi_cartera_revision WHERE id_configuracion = ? AND dropi_order_id = ?',
    { replacements: [id_configuracion, dropi_order_id], type: db.QueryTypes.SELECT },
  );
  const proveedor = esProveedor(orden.history_wallet);
  const ev = proveedor
    ? { hallazgos: [], monto: 0, cerrada: true }
    : evaluar(orden, new Date(), previa?.status || null);
  const movs = (orden.history_wallet || []).map((w) => ({
    id: w.id, tipo: w.type, monto: r2(w.amount), fecha: w.created_at, descripcion: w.description,
  }));
  await db.query(
    `INSERT INTO dropi_cartera_revision
       (id_configuracion, dropi_order_id, status, guia, transportadora, order_created_at,
        shipping_amount, profit, movimientos, hallazgos, monto_reclamo, cerrada, proxima_revision, revisado_en)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL ${DIAS_RECHEQUEO} DAY), NOW())
     ON DUPLICATE KEY UPDATE status=VALUES(status), guia=VALUES(guia), transportadora=VALUES(transportadora),
       order_created_at=VALUES(order_created_at), shipping_amount=VALUES(shipping_amount), profit=VALUES(profit),
       movimientos=VALUES(movimientos), hallazgos=VALUES(hallazgos), monto_reclamo=VALUES(monto_reclamo),
       cerrada=VALUES(cerrada), proxima_revision=VALUES(proxima_revision), revisado_en=NOW()`,
    {
      replacements: [
        id_configuracion, dropi_order_id, orden.status || null, orden.guia || null,
        orden.transportadora || null,
        orden.created_at ? String(orden.created_at).replace('T', ' ').slice(0, 19) : null,
        r2(orden.shipping_amount), r2(orden.profit), JSON.stringify(movs),
        JSON.stringify(ev.hallazgos), ev.monto, ev.cerrada ? 1 : 0,
      ],
    },
  );
  return { proveedor };
}

async function esCuentaProveedor(id_configuracion) {
  const [r] = await db.query(
    `SELECT 1 x FROM dropi_cartera_revision
      WHERE id_configuracion = ? AND movimientos LIKE '%COMO PROVEEDOR%' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return Boolean(r);
}

async function integracionActiva(id_configuracion) {
  return DropiIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
}

// ── Pendientes ──────────────────────────────────────────────────────────
// Órdenes finales del cache (últimos DIAS_HISTORIA días) que nunca se
// revisaron, o abiertas cuya próxima revisión ya llegó.
const SQL_FINALES = (id, alias = 'c') => `
  ${alias}.id_configuracion = ${db.escape(id)}
  AND ${alias}.order_created_at >= DATE_SUB(NOW(), INTERVAL ${DIAS_HISTORIA} DAY)
  AND UPPER(${alias}.status) IN (${lista(FINALES)})`;
const SQL_PENDIENTES = (id) => `
  FROM dropi_orders_cache c
  LEFT JOIN dropi_cartera_revision r
    ON r.id_configuracion = c.id_configuracion AND r.dropi_order_id = c.dropi_order_id
  WHERE ${SQL_FINALES(id)}
    AND (r.id IS NULL OR (r.cerrada = 0 AND r.proxima_revision <= NOW()))`;

// ── Sincronizador ───────────────────────────────────────────────────────
const corriendo = new Map(); // id_configuracion → { revisadas, desde }
const enCola = [];

function sincronizar(id_configuracion) {
  if (corriendo.has(id_configuracion) || enCola.includes(id_configuracion)) return;
  if (corriendo.size >= MAX_SINCRONIZANDO) {
    enCola.push(id_configuracion);
    return;
  }
  const estado = { revisadas: 0, desde: new Date() };
  corriendo.set(id_configuracion, estado);
  correr(id_configuracion, estado)
    .catch((e) => console.error(`[cartera ${id_configuracion}]`, e?.message))
    .finally(() => {
      corriendo.delete(id_configuracion);
      const sig = enCola.shift();
      if (sig) sincronizar(sig);
    });
}

// Antes de la primera sincronización: una entregada de hace 15-60 días ya
// tiene sus movimientos; si son «como proveedor», la cuenta es de proveedor.
async function sondearProveedor(id_configuracion, integrationKey, country_code) {
  if (await esCuentaProveedor(id_configuracion)) return true;
  const [muestra] = await db.query(
    `SELECT c.dropi_order_id id FROM dropi_orders_cache c
      LEFT JOIN dropi_cartera_revision r
        ON r.id_configuracion = c.id_configuracion AND r.dropi_order_id = c.dropi_order_id
      WHERE c.id_configuracion = ? AND r.id IS NULL AND UPPER(c.status) = 'ENTREGADO'
        AND c.order_created_at BETWEEN DATE_SUB(NOW(), INTERVAL 60 DAY) AND DATE_SUB(NOW(), INTERVAL 15 DAY)
      ORDER BY c.order_created_at DESC LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!muestra) return false;
  try {
    const d = await dropiService.getOrderDetail({ integrationKey, orderId: muestra.id, country_code });
    const o = d?.objects || d || {};
    const { proveedor } = await guardar(id_configuracion, muestra.id, {
      status: o.status, guia: o.shipping_guide, transportadora: o.shipping_company,
      created_at: o.created_at, shipping_amount: o.shipping_amount,
      profit: o.dropshipper_amount_to_win, history_wallet: o.history_wallet, history: o.history,
      rate_type: o.rate_type,
    });
    return proveedor;
  } catch {
    return false;
  }
}

async function correr(id_configuracion, estado) {
  const integ = await integracionActiva(id_configuracion);
  if (!integ) return;
  const integrationKey = decryptToken(integ.integration_key_enc);
  const country_code = integ.country_code;
  if (await sondearProveedor(id_configuracion, integrationKey, country_code)) {
    console.warn(`[cartera ${id_configuracion}] cuenta de proveedor: no se sincroniza`);
    return;
  }
  let fallosSeguidos = 0;
  for (;;) {
    const lote = await db.query(
      `SELECT c.dropi_order_id id ${SQL_PENDIENTES(id_configuracion)} ORDER BY c.dropi_order_id DESC LIMIT 25`,
      { type: db.QueryTypes.SELECT },
    );
    if (!lote.length) return;
    for (const { id } of lote) {
      try {
        const d = await dropiService.getOrderDetail({ integrationKey, orderId: id, country_code });
        const o = d?.objects || d || {};
        const { proveedor } = await guardar(id_configuracion, id, {
          status: o.status, guia: o.shipping_guide, transportadora: o.shipping_company,
          created_at: o.created_at, shipping_amount: o.shipping_amount,
          profit: o.dropshipper_amount_to_win, history_wallet: o.history_wallet, history: o.history,
      rate_type: o.rate_type,
        });
        if (proveedor) {
          console.warn(`[cartera ${id_configuracion}] cuenta de proveedor: no se sincroniza`);
          return;
        }
        fallosSeguidos = 0;
      } catch (e) {
        const st = e?.statusCode || e?.status || e?.response?.status;
        if (st === 404) {
          // Orden que Dropi ya no tiene (p. ej. REEMPLAZADA): no se pide más.
          await guardar(id_configuracion, id, { status: 'NO_ENCONTRADA', history_wallet: [] });
          await db.query(
            'UPDATE dropi_cartera_revision SET cerrada = 1 WHERE id_configuracion = ? AND dropi_order_id = ?',
            { replacements: [id_configuracion, id] },
          );
        } else {
          fallosSeguidos += 1;
          if (fallosSeguidos >= 5) {
            console.warn(`[cartera ${id_configuracion}] 5 fallos seguidos (${st}), se retoma en la próxima apertura`);
            return;
          }
          await dormir(st === 429 ? 30000 : 5000);
          continue;
        }
      }
      estado.revisadas += 1;
      await dormir(PAUSA_MS);
    }
  }
}

// ── Lectura para el dashboard ───────────────────────────────────────────
async function resumenCartera({ id_configuracion }) {
  await ensureTabla();
  const vacio = (extra) => ({
    guias: { finales: 0, revisadas: 0, pendientes: 0, sincronizando: false, en_cola: false, dias_historia: DIAS_HISTORIA, ...extra },
    totales: Object.fromEntries(ESTADOS_RECLAMO.map((e) => [e, { ordenes: 0, monto: 0 }])),
    reclamos: [],
  });
  if (await esCuentaProveedor(id_configuracion)) return vacio({ proveedor: true });
  const integ = await integracionActiva(id_configuracion);
  if (!integ) return vacio({ sin_integracion: true });

  const [conteo] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM dropi_orders_cache c WHERE ${SQL_FINALES(id_configuracion)}) AS finales,
       (SELECT COUNT(*) FROM dropi_orders_cache c
          JOIN dropi_cartera_revision r
            ON r.id_configuracion = c.id_configuracion AND r.dropi_order_id = c.dropi_order_id
         WHERE ${SQL_FINALES(id_configuracion)}) AS revisadas`,
    { type: db.QueryTypes.SELECT },
  );
  const [pend] = await db.query(`SELECT COUNT(*) n ${SQL_PENDIENTES(id_configuracion)}`, {
    type: db.QueryTypes.SELECT,
  });
  const pendientes = Number(pend?.n || 0);
  if (pendientes > 0) sincronizar(id_configuracion);

  const filas = await db.query(
    `SELECT dropi_order_id, status, guia, transportadora, order_created_at, shipping_amount, profit,
            movimientos, hallazgos, monto_reclamo, reclamo_estado, reclamo_actualizado_en, revisado_en
       FROM dropi_cartera_revision
      WHERE id_configuracion = ? AND monto_reclamo > 0
      ORDER BY FIELD(reclamo_estado,'pendiente','reclamado','devuelto','descartado'), monto_reclamo DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const totales = Object.fromEntries(ESTADOS_RECLAMO.map((e) => [e, { ordenes: 0, monto: 0 }]));
  const reclamos = filas.map((f) => {
    const t = totales[f.reclamo_estado];
    t.ordenes += 1;
    t.monto = r2(t.monto + Number(f.monto_reclamo));
    return {
      ...f,
      monto_reclamo: r2(f.monto_reclamo),
      movimientos: JSON.parse(f.movimientos || '[]'),
      hallazgos: JSON.parse(f.hallazgos || '[]'),
    };
  });
  const finales = Number(conteo?.finales || 0);
  const revisadas = Number(conteo?.revisadas || 0);
  const run = corriendo.get(id_configuracion);
  return {
    guias: {
      finales,
      revisadas,
      pendientes,
      sincronizando: Boolean(run) || enCola.includes(id_configuracion),
      en_cola: enCola.includes(id_configuracion),
      dias_historia: DIAS_HISTORIA,
    },
    totales,
    reclamos,
  };
}

async function marcarReclamo({ id_configuracion, dropi_order_id, estado }) {
  await ensureTabla();
  if (!ESTADOS_RECLAMO.includes(estado)) {
    const e = new Error('Estado no válido');
    e.codigo = 'estado_invalido';
    throw e;
  }
  const [, meta] = await db.query(
    `UPDATE dropi_cartera_revision SET reclamo_estado = ?, reclamo_actualizado_en = NOW()
      WHERE id_configuracion = ? AND dropi_order_id = ? AND monto_reclamo > 0`,
    { replacements: [estado, id_configuracion, dropi_order_id] },
  );
  return { actualizada: Number(meta?.affectedRows ?? meta ?? 0) > 0 };
}

module.exports = { ensureTabla, evaluar, guardar, resumenCartera, marcarReclamo, FINALES };
