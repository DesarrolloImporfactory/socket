'use strict';

/**
 * services/stripe_addons.service.js
 *
 * Cuánto factura cada complemento (Conexión adicional, Subusuario adicional,
 * ImporKiller…). El dashboard solo desglosaba por plan, y como los
 * complementos son items dentro de la misma suscripción, su ingreso quedaba
 * mezclado con el del plan.
 *
 * Dos lecturas, las dos de Stripe:
 *  - Recurrente hoy: items de complemento en las suscripciones vivas. Se separa
 *    lo que ya cobra (active) de lo que está en prueba gratis (trialing, cobra
 *    cuando termine) y de lo que está en mora (past_due/unpaid).
 *  - Cobrado en el rango: líneas de complemento en las facturas pagadas.
 *
 * La BD aporta lo que Stripe no ve: complementos encendidos a mano desde el
 * panel (cortesías), que se usan pero no facturan.
 */

const { db } = require('../database/config');
const { _interno } = require('./stripe_cobros.service');

const { stripe, MODO, parseRango, cents, idDe, SUB_VIVA } = _interno;

const CACHE_MS = 5 * 60 * 1000;
const MAX_FACTURAS = 6000;
const TRAMOS = 8;
const _cache = new Map();

const COLUMNAS = new Set([
  'conexiones_adicionales',
  'subusuarios_adicionales',
  'imporkiller',
]);

async function catalogoAddons() {
  const rows = await db.query(
    `SELECT clave, nombre, precio, activo, id_price_prod, id_price_test,
            target_columna
       FROM addons_chat_center
      ORDER BY id_addon`,
    { type: db.QueryTypes.SELECT },
  );
  return (rows || []).map((a) => ({
    clave: a.clave,
    nombre: a.nombre,
    precio: Number(a.precio || 0),
    activo: Number(a.activo) === 1,
    price: MODO === 'live' ? a.id_price_prod : a.id_price_test,
    columna: COLUMNAS.has(a.target_columna) ? a.target_columna : null,
  }));
}

// Un precio semestral o anual pesa su parte mensual en el recurrente.
const mesesDe = (price) => {
  const r = price?.recurring;
  if (!r) return 1;
  const n = Number(r.interval_count || 1);
  if (r.interval === 'year') return 12 * n;
  if (r.interval === 'month') return n;
  if (r.interval === 'week') return n / 4.345;
  if (r.interval === 'day') return n / 30.44;
  return 1;
};

const vacio = () => ({ cuentas: 0, unidades: 0, mrr: 0 });

/** Barrido de suscripciones vivas: recurrente por complemento y por planes. */
async function recurrenteHoy(porPrice) {
  const porAddon = new Map();
  for (const a of porPrice.values()) {
    porAddon.set(a.clave, {
      activas: vacio(),
      prueba: vacio(),
      mora: vacio(),
      subs: new Set(),
    });
  }
  const planes = { activas: vacio(), prueba: vacio(), mora: vacio() };

  for await (const s of stripe.subscriptions.list({
    status: 'all',
    limit: 100,
  })) {
    if (!SUB_VIVA.includes(s.status)) continue;
    const grupo =
      s.status === 'active'
        ? 'activas'
        : s.status === 'trialing'
          ? 'prueba'
          : 'mora';
    let tienePlan = false;
    let mrrPlan = 0;
    for (const it of s.items?.data || []) {
      const qty = Number(it.quantity || 1);
      const mensual = (cents(it.price?.unit_amount) * qty) / mesesDe(it.price);
      const addon = porPrice.get(it.price?.id);
      if (!addon) {
        tienePlan = true;
        mrrPlan += mensual;
        continue;
      }
      const acc = porAddon.get(addon.clave);
      acc[grupo].cuentas += 1;
      acc[grupo].unidades += qty;
      acc[grupo].mrr += mensual;
      acc.subs.add(s.id);
    }
    if (tienePlan) {
      planes[grupo].cuentas += 1;
      planes[grupo].mrr += mrrPlan;
    }
  }
  return { porAddon, planes };
}

/** Líneas de complemento en las facturas pagadas del rango. */
async function cobradoEnRango(gte, lt, porPrice) {
  const dias = Math.ceil((lt - gte) / 86400);
  const tramos = Math.min(TRAMOS, Math.max(1, dias));
  const paso = Math.ceil((lt - gte) / tramos);
  const porTramo = Math.ceil(MAX_FACTURAS / tramos);

  const pedidos = [];
  for (let a = gte; a < lt; a += paso) {
    pedidos.push(
      (async () => {
        const acc = new Map();
        let total = 0;
        let n = 0;
        let truncado = false;
        for await (const inv of stripe.invoices.list({
          status: 'paid',
          created: { gte: a, lt: Math.min(a + paso, lt) },
          limit: 100,
        })) {
          n += 1;
          if (Number(inv.amount_paid || 0) > 0) {
            total += cents(inv.amount_paid);
            const vistos = new Set();
            for (const l of inv.lines?.data || []) {
              const priceId =
                idDe(l.price) || l.pricing?.price_details?.price || null;
              const addon = porPrice.get(priceId);
              if (!addon) continue;
              const fila = acc.get(addon.clave) || { monto: 0, facturas: 0 };
              // amount incluye los prorrateos (negativos al bajar cantidad).
              fila.monto += cents(l.amount);
              if (!vistos.has(addon.clave)) {
                fila.facturas += 1;
                vistos.add(addon.clave);
              }
              acc.set(addon.clave, fila);
            }
          }
          if (n >= porTramo) {
            truncado = true;
            break;
          }
        }
        return { acc, total, truncado };
      })(),
    );
  }

  const res = await Promise.all(pedidos);
  const porAddon = new Map();
  let total = 0;
  for (const r of res) {
    total += r.total;
    for (const [clave, f] of r.acc) {
      const fila = porAddon.get(clave) || { monto: 0, facturas: 0 };
      fila.monto += f.monto;
      fila.facturas += f.facturas;
      porAddon.set(clave, fila);
    }
  }
  return { porAddon, total, truncado: res.some((r) => r.truncado) };
}

/** Cuentas con el complemento encendido en la BD que Stripe no cobra. */
async function otorgadosAMano(addon, subsConAddon) {
  if (!addon.columna) return { cuentas: 0, unidades: 0, total_bd: 0 };
  const rows = await db.query(
    `SELECT stripe_subscription_id AS sub, ${addon.columna} AS n
       FROM usuarios_chat_center
      WHERE ${addon.columna} > 0`,
    { type: db.QueryTypes.SELECT },
  );
  let cuentas = 0;
  let unidades = 0;
  for (const r of rows || []) {
    if (r.sub && subsConAddon.has(r.sub)) continue;
    cuentas += 1;
    unidades += Number(r.n || 0);
  }
  return { cuentas, unidades, total_bd: (rows || []).length };
}

const red = (n) => Math.round(Number(n || 0) * 100) / 100;
const redGrupo = (g) => ({ ...g, mrr: red(g.mrr) });

async function facturacionPorAddon(desde, hasta, { fresh = false } = {}) {
  const { gte, lt } = parseRango(desde, hasta);
  const key = `${gte}|${lt}`;
  const hit = _cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const catalogo = await catalogoAddons();
  const porPrice = new Map(
    catalogo.filter((a) => a.price).map((a) => [a.price, a]),
  );

  const [rec, cob] = await Promise.all([
    recurrenteHoy(porPrice),
    cobradoEnRango(gte, lt, porPrice),
  ]);

  const addons = [];
  for (const a of catalogo) {
    const r = rec.porAddon.get(a.clave) || {
      activas: vacio(),
      prueba: vacio(),
      mora: vacio(),
      subs: new Set(),
    };
    const c = cob.porAddon.get(a.clave) || { monto: 0, facturas: 0 };
    const mano = await otorgadosAMano(a, r.subs);
    addons.push({
      clave: a.clave,
      nombre: a.nombre,
      precio: a.precio,
      activo: a.activo,
      activas: redGrupo(r.activas),
      prueba: redGrupo(r.prueba),
      mora: redGrupo(r.mora),
      a_mano: { cuentas: mano.cuentas, unidades: mano.unidades },
      cuentas_total:
        r.activas.cuentas + r.prueba.cuentas + r.mora.cuentas + mano.cuentas,
      cobrado: { monto: red(c.monto), facturas: c.facturas },
    });
  }
  addons.sort(
    (x, y) => y.activas.mrr - x.activas.mrr || y.cuentas_total - x.cuentas_total,
  );

  const mrrAddons = addons.reduce((t, a) => t + a.activas.mrr, 0);
  const mrrPlanes = rec.planes.activas.mrr;
  const cobradoAddons = addons.reduce((t, a) => t + a.cobrado.monto, 0);

  const data = {
    modo: MODO,
    rango: { desde, hasta },
    generado_en: new Date().toISOString(),
    truncado: cob.truncado,
    addons,
    totales: {
      mrr_addons: red(mrrAddons),
      mrr_planes: red(mrrPlanes),
      pct_addons_mrr:
        mrrAddons + mrrPlanes > 0
          ? red((mrrAddons / (mrrAddons + mrrPlanes)) * 100)
          : 0,
      mrr_addons_en_prueba: red(addons.reduce((t, a) => t + a.prueba.mrr, 0)),
      cobrado_addons: red(cobradoAddons),
      cobrado_total: red(cob.total),
      pct_addons_cobrado:
        cob.total > 0 ? red((cobradoAddons / cob.total) * 100) : 0,
      suscripciones_pagando: rec.planes.activas.cuentas,
    },
  };

  if (_cache.size > 50) _cache.clear();
  _cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { facturacionPorAddon };
