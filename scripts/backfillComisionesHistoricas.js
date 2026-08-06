'use strict';

/**
 * scripts/backfillComisionesHistoricas.js
 *
 * Devenga en `referidos_comisiones` las comisiones que YA se habrían ganado si
 * el programa hubiera existido desde el principio.
 *
 * POR QUÉ SE HACE Y NO SE NEGOCIA APARTE
 * La decisión fue pagar el histórico de quien pertenece a la comunidad. Si eso
 * se salda por fuera —una transferencia y un mensaje— el referidor entra a la
 * pantalla, ve $0.00 y tiene que creer en la palabra de alguien. Metiéndolo en
 * la tabla, la vista se explica sola: aparece el saldo, aparece cada comisión
 * con su mes real, y no hace falta ninguna conversación.
 *
 * CÓMO CUENTA
 * Exactamente igual que el webhook en vivo: ordena las facturas pagadas de cada
 * referido de la más vieja a la más nueva, y aplica la escalera de
 * `referidos.config.js` — ciclos 1-2 nada, 3-12 el 25%, 13+ el 10%, siempre
 * sobre lo efectivamente cobrado.
 *
 * DOS DETALLES QUE IMPORTAN
 * · `created_at` se graba con la fecha REAL de la factura, no con la de hoy.
 *   Si se estampara hoy, el gráfico mensual amontonaría un año de comisiones
 *   en un solo mes y contaría una historia falsa.
 * · Nacen en 'disponible' y no en 'pendiente'. La retención de 30 días existe
 *   para cubrir la ventana de reembolso, y estos cobros ocurrieron hace meses:
 *   esa ventana ya cerró.
 *
 * Es idempotente: `invoice_id` es UNIQUE, así que correrlo dos veces no duplica
 * un centavo. Y por lo mismo no choca con el webhook si alguna de esas facturas
 * volviera a pasar por él.
 *
 * USO
 *   NODE_ENV=production node scripts/backfillComisionesHistoricas.js
 *   NODE_ENV=production node scripts/backfillComisionesHistoricas.js --aplicar
 *   ... --aplicar 2711     → solo los referidos de ese referidor
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
const usd = (c) => `$${((c || 0) / 100).toFixed(2)}`;

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
          sub,
          neto,
          moneda: inv.currency || 'usd',
          ts: Number(inv.created || 0),
        });
      }
    }

    if (!lote.has_more) break;
    starting_after = lote.data[lote.data.length - 1]?.id;
    if (!starting_after) break;
  }

  return out.sort((a, b) => a.ts - b.ts);
}

/** 'YYYY-MM-DD HH:MM:SS' en hora local, que es como guarda el resto del sistema. */
const aMysql = (ts) => {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
};

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const soloRef = args.find((a) => /^\d+$/.test(a));

  console.log(
    `\n${aplicar ? '### APLICANDO ###' : '### SIMULACRO — no se escribe nada ###'}` +
      `   (Stripe ${isProd ? 'PROD' : 'TEST'})\n`,
  );

  const referidos = await db.query(
    `SELECT u.id_usuario, u.nombre, u.id_costumer, u.referido_por,
            r.nombre AS referidor
       FROM usuarios_chat_center u
       JOIN usuarios_chat_center r ON r.id_usuario = u.referido_por
      WHERE u.referido_por IS NOT NULL
        ${soloRef ? 'AND u.referido_por = :ref' : ''}
      ORDER BY u.referido_por, u.id_usuario`,
    { replacements: soloRef ? { ref: Number(soloRef) } : {}, ...SELECT },
  );

  if (!referidos.length) {
    console.log('No hay referidos atribuidos.');
    return;
  }

  const yaExisten = new Set(
    (await db.query(`SELECT invoice_id FROM referidos_comisiones`, SELECT)).map(
      (r) => r.invoice_id,
    ),
  );

  let insertadas = 0;
  let totalCent = 0;
  const porReferidor = new Map();

  for (const r of referidos) {
    if (!r.id_costumer) continue;

    let facturas = [];
    try {
      facturas = await facturasPagadas(r.id_costumer);
    } catch (e) {
      console.log(`  ⚠ ${r.nombre}: ${e?.message}`);
      continue;
    }

    for (let i = 0; i < facturas.length; i++) {
      const f = facturas[i];
      const ciclo = i + 1;
      const pct = porcentajeParaCiclo(ciclo);
      if (pct <= 0) continue;
      if (yaExisten.has(f.id)) continue;

      const comision = Math.round((f.neto * pct) / 100);
      if (comision <= 0) continue;

      const fechaFactura = aMysql(f.ts);
      console.log(
        `  ${aplicar ? '✓' : '·'} ${String(r.nombre).slice(0, 30).padEnd(30)} ` +
          `ciclo ${String(ciclo).padStart(2)}  ${fechaFactura.slice(0, 10)}  ` +
          `pagó ${usd(f.neto).padStart(8)}  ${pct}% → ${usd(comision)}`,
      );

      if (aplicar) {
        await db.query(
          `INSERT IGNORE INTO referidos_comisiones
             (id_usuario_referidor, id_usuario_referido, invoice_id,
              subscription_id, ciclo_num, monto_base_cent, porcentaje,
              monto_comision_cent, moneda, estado, disponible_desde, created_at)
           VALUES (:ref, :usr, :inv, :sub, :ciclo, :base, :pct, :com, :mon,
                   'disponible', DATE(:fecha), :fecha)`,
          {
            replacements: {
              ref: r.referido_por,
              usr: r.id_usuario,
              inv: f.id,
              sub: f.sub,
              ciclo,
              base: f.neto,
              pct,
              com: comision,
              mon: f.moneda,
              fecha: fechaFactura,
            },
          },
        );
      }

      insertadas++;
      totalCent += comision;
      const acc = porReferidor.get(r.referido_por) || {
        nombre: r.referidor,
        cent: 0,
        n: 0,
      };
      acc.cent += comision;
      acc.n += 1;
      porReferidor.set(r.referido_por, acc);
    }
  }

  console.log('\n──────────────────────────────────────────────────────────');
  if (!insertadas) {
    console.log('  Nada que devengar: el histórico ya estaba cargado.');
  } else {
    for (const [id, a] of porReferidor) {
      console.log(`  ${a.nombre} (#${id}): ${a.n} comisiones → ${usd(a.cent)}`);
    }
    console.log(
      `\n  ${insertadas} comisiones · ${usd(totalCent)} ${aplicar ? 'devengados' : 'se devengarían'}`,
    );
  }
  console.log('──────────────────────────────────────────────────────────');
  if (!aplicar && insertadas) {
    console.log('\n  Corre otra vez con --aplicar para escribirlo.\n');
  }
}

main()
  .catch((e) => {
    console.error('Error:', e?.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
