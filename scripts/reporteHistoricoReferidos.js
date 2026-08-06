'use strict';

/**
 * scripts/reporteHistoricoReferidos.js
 *
 * ¿CUÁNTO SE LE HABRÍA PAGADO A CADA REFERIDOR SI EL PROGRAMA HUBIERA EXISTIDO
 * DESDE SIEMPRE?
 *
 * Es la cifra para sentarse a negociar el cierre del histórico con los dueños
 * de comunidad. NO devenga nada ni escribe una sola fila: solo lee y reporta.
 *
 * POR QUÉ NO SALE DE LA BASE
 * `transacciones_stripe_chat` guarda el `id_pago` de cada factura pero no el
 * importe, así que el único lugar donde vive cuánto pagó realmente cada persona
 * es Stripe. Por eso el script consulta la API factura por factura en vez de
 * hacer un SELECT.
 *
 * CÓMO CUENTA
 * Reconstruye los ciclos de cada referido ordenando sus facturas pagadas de más
 * vieja a más nueva, y les aplica la misma escalera que usa el programa en
 * vivo (referidos.config.js): ciclos 1-2 nada, 3-12 el 25%, 13+ el 10%. Siempre
 * sobre lo efectivamente cobrado, nunca sobre precio de lista.
 *
 * Descuenta las facturas que YA generaron comisión en `referidos_comisiones`,
 * para que lo que reporta sea estrictamente la deuda vieja y no se solape con
 * lo que el programa ya está pagando solo.
 *
 * USO
 *   node scripts/reporteHistoricoReferidos.js                  → todos los referidores
 *   node scripts/reporteHistoricoReferidos.js 2711             → solo ese referidor
 *   node scripts/reporteHistoricoReferidos.js 2711 --detalle   → factura por factura
 *
 * LO QUE ESTE NÚMERO NO ES
 * Un dato auditable. La atribución vieja (`id_comunidad`) la eligió a mano el
 * propio registrante de un combobox, sin enlace que la respaldara: hay gente
 * que marcó una comunidad de la que nunca vino y gente que vino y no marcó
 * ninguna. Sirve como techo para negociar una cifra cerrada, no como una
 * factura que se pueda defender línea por línea.
 */

require('dotenv').config();

const Stripe = require('stripe');
const { db } = require('../src/database/config');
const { porcentajeParaCiclo } = require('../src/config/referidos.config');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

const SELECT = { type: db.QueryTypes.SELECT };
const usd = (cent) => `$${((cent || 0) / 100).toFixed(2)}`;

/**
 * Facturas cobradas de verdad de un cliente, de la más vieja a la más nueva.
 *
 * Se filtra por `amount_paid > 0` porque los trials y las facturas en $0 no son
 * un ciclo: nadie pagó nada. Y se resta `post_payment_credit_notes_amount`
 * —las notas de crédito posteriores— para no contar como ingreso plata que se
 * terminó devolviendo.
 */
async function facturasPagadas(customerId) {
  const out = [];
  let starting_after;

  for (let pagina = 0; pagina < 12; pagina++) {
    const lote = await stripe.invoices.list({
      customer: customerId,
      status: 'paid',
      limit: 100,
      ...(starting_after && { starting_after }),
    });

    for (const inv of lote.data) {
      const devuelto = Number(inv.post_payment_credit_notes_amount || 0);
      const neto = Number(inv.amount_paid || 0) - devuelto;
      const sub =
        inv.subscription ||
        inv.parent?.subscription_details?.subscription ||
        inv.lines?.data?.[0]?.subscription ||
        null;

      if (neto > 0 && sub) {
        out.push({
          id: inv.id,
          neto,
          fecha: new Date((inv.created || 0) * 1000).toISOString().slice(0, 10),
        });
      }
    }

    if (!lote.has_more) break;
    starting_after = lote.data[lote.data.length - 1]?.id;
    if (!starting_after) break;
  }

  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

async function main() {
  const args = process.argv.slice(2);
  const detalle = args.includes('--detalle');
  const soloReferidor = args.find((a) => /^\d+$/.test(a));

  const referidos = await db.query(
    `SELECT u.id_usuario, u.nombre, u.id_costumer, u.estado,
            u.referido_por, u.referido_origen,
            r.nombre AS nombre_referidor
       FROM usuarios_chat_center u
       JOIN usuarios_chat_center r ON r.id_usuario = u.referido_por
      WHERE u.referido_por IS NOT NULL
        ${soloReferidor ? 'AND u.referido_por = :ref' : ''}
      ORDER BY u.referido_por, u.id_usuario`,
    {
      replacements: soloReferidor ? { ref: Number(soloReferidor) } : {},
      ...SELECT,
    },
  );

  if (!referidos.length) {
    console.log('No hay referidos atribuidos todavía.');
    return;
  }

  // Facturas que el programa ya pagó: no son deuda vieja.
  const yaDevengadas = new Set(
    (
      await db.query(`SELECT invoice_id FROM referidos_comisiones`, SELECT)
    ).map((r) => r.invoice_id),
  );

  console.log(
    `\nAnalizando ${referidos.length} referidos contra Stripe (${isProd ? 'PROD' : 'TEST'})…\n`,
  );

  const porReferidor = new Map();
  let sinCustomer = 0;

  for (const r of referidos) {
    if (!r.id_costumer) {
      sinCustomer++;
      continue;
    }

    let facturas = [];
    try {
      facturas = await facturasPagadas(r.id_costumer);
    } catch (e) {
      console.log(`  ⚠ ${r.nombre} (${r.id_usuario}): ${e?.message}`);
      continue;
    }

    let comisionUsuario = 0;
    let pagadoUsuario = 0;
    const lineas = [];

    facturas.forEach((f, i) => {
      const ciclo = i + 1;
      const pct = porcentajeParaCiclo(ciclo);
      pagadoUsuario += f.neto;

      if (pct <= 0) return;
      if (yaDevengadas.has(f.id)) return; // ya la paga el programa en vivo

      const com = Math.round((f.neto * pct) / 100);
      comisionUsuario += com;
      lineas.push({ ciclo, fecha: f.fecha, pago: f.neto, pct, com });
    });

    const acc = porReferidor.get(r.referido_por) || {
      nombre: r.nombre_referidor,
      referidos: 0,
      ciclos: 0,
      pagado: 0,
      comision: 0,
    };
    acc.referidos += 1;
    acc.ciclos += facturas.length;
    acc.pagado += pagadoUsuario;
    acc.comision += comisionUsuario;
    porReferidor.set(r.referido_por, acc);

    if (detalle) {
      console.log(
        `\n  ${r.nombre} (#${r.id_usuario}, ${r.estado}) — ${facturas.length} facturas, pagó ${usd(pagadoUsuario)}`,
      );
      if (!lineas.length) {
        console.log('    · sin ciclos que comisionen todavía');
      }
      lineas.forEach((l) =>
        console.log(
          `    · ciclo ${String(l.ciclo).padStart(2)} ${l.fecha}  pagó ${usd(l.pago).padStart(9)}  ${l.pct}% → ${usd(l.com)}`,
        ),
      );
    }
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' HISTÓRICO NO PAGADO, POR REFERIDOR');
  console.log('══════════════════════════════════════════════════════════');

  let total = 0;
  for (const [id, a] of porReferidor) {
    total += a.comision;
    console.log(
      `\n  ${a.nombre} (#${id})` +
        `\n    referidos: ${a.referidos}   ciclos cobrados: ${a.ciclos}` +
        `\n    ellos pagaron:  ${usd(a.pagado)}` +
        `\n    le tocaría:     ${usd(a.comision)}`,
    );
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  TOTAL HISTÓRICO: ${usd(total)}`);
  if (sinCustomer) {
    console.log(`  (${sinCustomer} referidos sin cliente de Stripe, omitidos)`);
  }
  console.log('──────────────────────────────────────────────────────────');
  console.log(
    '\n  Recordatorio: es un techo para negociar, no una factura. La\n' +
      '  atribución histórica la eligió a mano cada registrante de un\n' +
      '  combobox, sin enlace que la respaldara.\n',
  );
}

main()
  .catch((e) => {
    console.error('Error:', e?.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
