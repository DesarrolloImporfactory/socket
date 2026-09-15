'use strict';

/**
 * scripts/recuperarCiclosReferidos.js
 *
 * Recupera los ciclos (y sus comisiones) que el webhook de Stripe dejó de
 * devengar entre el 05-08-2026 y la corrección de `facturaLiquidada`.
 *
 * QUÉ PASÓ
 * El endpoint del webhook está registrado con la API 2025-06-30.basil, donde
 * `invoice.paid` ya no existe. El devengo exigía `invoice.paid === true`, así
 * que la condición fue siempre falsa: `referidos_ciclos` quedó en CERO filas
 * y ningún referidor cobró nada de lo que sus referidos pagaron desde la
 * migración. El webhook ya está corregido (`invoice.status === 'paid'`); este
 * script pone al día lo que se perdió en el medio.
 *
 * CÓMO CUENTA
 * Con el MISMO código que el webhook en vivo: `devengarPorFactura`. No se
 * replica la regla del ciclo ni el porcentaje; se le pasa cada factura pagada
 * de suscripción, en orden cronológico, y el servicio decide qué ciclo es y
 * si comisiona. Así lo que quede en la tabla es exactamente lo que habría
 * quedado si el webhook hubiera funcionado. Es idempotente: `invoice_id` es
 * UNIQUE en las dos tablas, correrlo dos veces no duplica nada.
 *
 * QUÉ FACTURAS
 * Las pagadas (`status = paid`), de suscripción, con `total > 0`, creadas
 * DESDE `referido_en` de cada referido. Las anteriores ya se saldaron con
 * `backfillComisionesHistoricas.js` y están contadas en
 * `referido_ciclos_previos`; tocarlas duplicaría ciclos.
 *
 * FECHAS
 * `devengarPorFactura` estampa NOW(). Aquí, después de devengar, se corrige
 * `fecha` / `created_at` / `disponible_desde` a la fecha real de la factura:
 * si quedaran con la de hoy, el gráfico mensual amontonaría agosto y
 * septiembre en un solo mes, y la retención de 30 días volvería a correr
 * desde cero sobre cobros que ya tienen semanas. Lo que ya cumplió la
 * retención pasa a 'disponible' en el mismo acto.
 *
 * USO
 *   NODE_ENV=production node scripts/recuperarCiclosReferidos.js            → simulacro
 *   NODE_ENV=production node scripts/recuperarCiclosReferidos.js --aplicar
 *   NODE_ENV=production node scripts/recuperarCiclosReferidos.js --aplicar 2711  → solo ese referidor
 */

require('dotenv').config();

const Stripe = require('stripe');
const { db } = require('../src/database/config');
const referidosService = require('../src/services/referidos.service');
const {
  porcentajeParaCiclo,
  DIAS_RETENCION,
} = require('../src/config/referidos.config');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });
const SELECT = { type: db.QueryTypes.SELECT };
const usd = (c) => `$${((c || 0) / 100).toFixed(2)}`;

/** 'YYYY-MM-DD HH:MM:SS' en hora local, como guarda el resto del sistema. */
const aMysql = (ts) => {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
};

const subDe = (inv) =>
  inv.subscription ||
  inv.parent?.subscription_details?.subscription ||
  inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
  inv.lines?.data?.[0]?.subscription ||
  null;

/** Facturas pagadas de suscripción con total > 0, desde `desdeTs`, más vieja primero. */
async function facturasDesde(customerId, desdeTs) {
  const out = [];
  let starting_after;

  for (let pagina = 0; pagina < 12; pagina++) {
    const lote = await stripe.invoices.list({
      customer: customerId,
      status: 'paid',
      limit: 100,
      created: { gte: desdeTs },
      ...(starting_after && { starting_after }),
    });

    for (const inv of lote.data) {
      const sub = subDe(inv);
      const total = Number(inv.total || 0);
      if (total > 0 && sub) {
        out.push({
          id: inv.id,
          sub,
          total,
          moneda: inv.currency || 'usd',
          ts: Number(inv.created || 0),
          motivo: inv.billing_reason || '',
        });
      }
    }

    if (!lote.has_more) break;
    starting_after = lote.data[lote.data.length - 1]?.id;
    if (!starting_after) break;
  }

  return out.sort((a, b) => a.ts - b.ts);
}

/** Deja la comisión y el ciclo con la fecha real de la factura. */
async function corregirFechas(invoiceId, fechaFactura) {
  await db.query(
    `UPDATE referidos_ciclos SET fecha = :fecha WHERE invoice_id = :inv`,
    { replacements: { fecha: fechaFactura, inv: invoiceId } },
  );
  await db.query(
    `UPDATE referidos_comisiones
        SET created_at = :fecha,
            updated_at = :fecha,
            disponible_desde = DATE_ADD(DATE(:fecha), INTERVAL :dias DAY),
            estado = CASE
                       WHEN estado = 'pendiente'
                        AND DATE_ADD(DATE(:fecha), INTERVAL :dias DAY) <= CURDATE()
                       THEN 'disponible'
                       ELSE estado
                     END
      WHERE invoice_id = :inv`,
    {
      replacements: { fecha: fechaFactura, dias: DIAS_RETENCION, inv: invoiceId },
    },
  );
}

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
            u.referido_en, u.referido_ciclos_previos, r.nombre AS referidor
       FROM usuarios_chat_center u
       JOIN usuarios_chat_center r ON r.id_usuario = u.referido_por
      WHERE u.referido_por IS NOT NULL
        AND u.id_costumer IS NOT NULL
        ${soloRef ? 'AND u.referido_por = :ref' : ''}
      ORDER BY u.referido_por, u.id_usuario`,
    { replacements: soloRef ? { ref: Number(soloRef) } : {}, ...SELECT },
  );

  if (!referidos.length) {
    console.log('No hay referidos atribuidos con cliente de Stripe.');
    return;
  }

  // Lo que ya está en cualquiera de las dos tablas no se vuelve a tocar.
  const yaExisten = new Set(
    (
      await db.query(
        `SELECT invoice_id FROM referidos_ciclos
          UNION SELECT invoice_id FROM referidos_comisiones`,
        SELECT,
      )
    ).map((r) => r.invoice_id),
  );

  let ciclosNuevos = 0;
  let comisionesNuevas = 0;
  let totalCent = 0;
  const porReferidor = new Map();

  for (const r of referidos) {
    const desdeTs = Math.floor(new Date(r.referido_en).getTime() / 1000);
    if (!Number.isFinite(desdeTs)) continue;

    let facturas = [];
    try {
      facturas = await facturasDesde(r.id_costumer, desdeTs);
    } catch (e) {
      console.log(`  ⚠ ${r.nombre}: ${e?.message}`);
      continue;
    }

    /* En el simulacro se proyecta el ciclo igual que lo hará el servicio:
       MAX(referidos_ciclos) —vacío hoy— o `referido_ciclos_previos`, +1 por
       factura. Al aplicar, quien decide es `devengarPorFactura`. */
    const [max] = await db.query(
      `SELECT COALESCE(MAX(ciclo_num), ?) AS ult
         FROM referidos_ciclos WHERE id_usuario_referido = ?`,
      { replacements: [r.referido_ciclos_previos || 0, r.id_usuario], ...SELECT },
    );
    let ciclo = Number(max?.ult || 0);

    for (const f of facturas) {
      if (yaExisten.has(f.id)) continue;

      ciclo += 1;
      const pct = porcentajeParaCiclo(ciclo);
      const comision = pct > 0 ? Math.round((f.total * pct) / 100) : 0;
      const fechaFactura = aMysql(f.ts);

      console.log(
        `  ${aplicar ? '✓' : '·'} ${String(r.nombre).slice(0, 28).padEnd(28)} ` +
          `ciclo ${String(ciclo).padStart(2)}  ${fechaFactura.slice(0, 10)}  ` +
          `facturó ${usd(f.total).padStart(8)}  ` +
          (comision > 0 ? `${pct}% → ${usd(comision)}` : 'aún no comisiona') +
          (f.motivo && f.motivo !== 'subscription_cycle' ? `  (${f.motivo})` : ''),
      );

      if (aplicar) {
        const res = await referidosService.devengarPorFactura({
          id_usuario_referido: r.id_usuario,
          invoiceId: f.id,
          subscriptionId: f.sub,
          montoFacturadoCent: f.total,
          moneda: f.moneda,
        });
        await corregirFechas(f.id, fechaFactura);

        // Si el servicio calculó otro ciclo, es él quien manda: se avisa.
        if (res && Number(res.ciclo) !== ciclo) {
          console.log(
            `    ↳ el servicio lo contó como ciclo ${res.ciclo} (proyectado ${ciclo})`,
          );
        }
      }

      ciclosNuevos += 1;
      if (comision > 0) {
        comisionesNuevas += 1;
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
  }

  if (aplicar) await referidosService.promoverPendientes();

  console.log('\n──────────────────────────────────────────────────────────');
  if (!ciclosNuevos) {
    console.log('  Nada que recuperar: no hay facturas sin ciclo.');
  } else {
    for (const [id, a] of porReferidor) {
      console.log(`  ${a.nombre} (#${id}): ${a.n} comisiones → ${usd(a.cent)}`);
    }
    console.log(
      `\n  ${ciclosNuevos} ciclos · ${comisionesNuevas} comisiones · ` +
        `${usd(totalCent)} ${aplicar ? 'devengados' : 'se devengarían'}`,
    );
  }
  console.log('──────────────────────────────────────────────────────────');
  if (!aplicar && ciclosNuevos) {
    console.log('\n  Corre otra vez con --aplicar para escribirlo.\n');
  }
}

main()
  .catch((e) => {
    console.error('Error:', e?.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
