'use strict';

/**
 * scripts/saldarFacturaSuscripcion.js
 *
 * Marca como pagada FUERA de Stripe una factura de suscripción que quedó
 * `open` porque el mes ya se cobró por otra vía (una factura manual creada en
 * el dashboard, una transferencia, etc.).
 *
 * CASO QUE LO ORIGINÓ (2026-09-07, usuario 932)
 * La renovación falló por fondos y en Stripe, en vez de cobrar esa factura
 * abierta, se creó y cobró una factura manual nueva. La suscripción quedó
 * `past_due` con su factura `open` programada para reintentar al día
 * siguiente: el cliente iba a pagar el mes dos veces.
 *
 * Saldarla con `paid_out_of_band` no cobra nada: la suscripción vuelve a
 * `active`, conserva su ciclo y el webhook `invoice.payment_succeeded`
 * sincroniza fechas y estado en la BD por el camino normal.
 *
 * Uso:
 *   node scripts/saldarFacturaSuscripcion.js in_xxx                 (solo muestra)
 *   node scripts/saldarFacturaSuscripcion.js in_xxx --ejecutar
 *   node scripts/saldarFacturaSuscripcion.js in_xxx --ejecutar --borrar-borrador in_yyy
 *   node scripts/saldarFacturaSuscripcion.js in_xxx --ejecutar --factura-manual in_zzz
 *
 * `--borrar-borrador` elimina un borrador ($0 o sin usar) que haya quedado
 * huérfano del intento manual. Solo se borra si sigue en `draft`.
 *
 * `--factura-manual` es la factura con la que SÍ se cobró la tarjeta. El
 * webhook registra las dos en transacciones_stripe_chat, y el dashboard de
 * cobros reales cuenta toda fila con monto > 0: el mes saldría dos veces. Si
 * la factura saldada llega con amount_paid > 0, a la fila de la manual se le
 * pone monto 0 (el dinero queda representado por la de suscripción, que es la
 * que además cuenta ciclo de referidos). Si llega en 0, la manual se deja.
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

// La suscripción del cliente vive en la cuenta live aunque el script corra en
// local: se usa la key live salvo que se pida lo contrario.
const key = process.argv.includes('--test')
  ? STRIPE_SECRET
  : process.env.STRIPE_SECRET_KEY;
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

const args = process.argv.slice(2);
const invoiceId = args.find((a) => a.startsWith('in_'));
const ejecutar = args.includes('--ejecutar');
const idxBorrador = args.indexOf('--borrar-borrador');
const borradorId = idxBorrador >= 0 ? args[idxBorrador + 1] : null;
const idxManual = args.indexOf('--factura-manual');
const manualId = idxManual >= 0 ? args[idxManual + 1] : null;

const f = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);

(async () => {
  if (!invoiceId) {
    console.error('Falta el id de la factura (in_...).');
    process.exit(1);
  }

  const inv = await stripe.invoices.retrieve(invoiceId);
  const subId =
    inv.subscription || inv.parent?.subscription_details?.subscription || null;

  console.log('Factura:', {
    id: inv.id,
    status: inv.status,
    billing_reason: inv.billing_reason,
    amount_due: inv.amount_due,
    amount_paid: inv.amount_paid,
    subscription: subId,
    next_payment_attempt: f(inv.next_payment_attempt),
  });

  if (!subId) {
    console.error('La factura no pertenece a una suscripción. No se toca.');
    process.exit(1);
  }
  if (inv.status !== 'open') {
    console.error(
      `La factura está en '${inv.status}', solo se salda una 'open'.`,
    );
    process.exit(1);
  }

  if (borradorId) {
    const b = await stripe.invoices.retrieve(borradorId);
    console.log('Borrador:', { id: b.id, status: b.status, total: b.total });
    if (b.status !== 'draft') {
      console.error('El borrador ya no está en draft. No se borra.');
      process.exit(1);
    }
  }

  if (manualId) {
    const m = await stripe.invoices.retrieve(manualId);
    console.log('Factura manual (la cobrada):', {
      id: m.id,
      status: m.status,
      amount_paid: m.amount_paid,
      billing_reason: m.billing_reason,
    });
    if (m.status !== 'paid' || m.amount_paid <= 0) {
      console.error('La factura manual no figura cobrada. No se reconcilia.');
      process.exit(1);
    }
    const [[fila]] = await db.query(
      `SELECT id_pago, monto, estado_suscripcion FROM transacciones_stripe_chat WHERE id_pago = ?`,
      { replacements: [manualId] },
    );
    console.log('Fila en transacciones_stripe_chat:', fila || '(no existe)');
  }

  if (!ejecutar) {
    console.log('\nModo lectura. Agregue --ejecutar para saldar la factura.');
    process.exit(0);
  }

  const pagada = await stripe.invoices.pay(invoiceId, {
    paid_out_of_band: true,
  });
  console.log('Saldada fuera de Stripe:', {
    status: pagada.status,
    paid: pagada.paid,
    amount_paid: pagada.amount_paid,
    paid_out_of_band: pagada.paid_out_of_band,
  });

  if (borradorId) {
    const del = await stripe.invoices.del(borradorId);
    console.log('Borrador eliminado:', del.deleted);
  }

  if (manualId) {
    if (Number(pagada.amount_paid) > 0) {
      const [, meta] = await db.query(
        `UPDATE transacciones_stripe_chat
            SET monto = 0,
                estado_suscripcion = 'payment_succeeded_manual_reconciliada'
          WHERE id_pago = ? AND monto > 0`,
        { replacements: [manualId] },
      );
      console.log(
        `Fila manual reconciliada (monto 0) para no contar el mes dos veces: filas=${meta?.affectedRows ?? '?'}`,
      );
    } else {
      console.log(
        'La factura saldada llegó con amount_paid 0: la fila manual se deja como el cobro real.',
      );
    }
  }

  const sub = await stripe.subscriptions.retrieve(subId);
  console.log('Suscripción:', {
    id: sub.id,
    status: sub.status,
    current_period_end: f(
      sub.current_period_end || sub.items?.data?.[0]?.current_period_end,
    ),
  });

  process.exit(0);
})().catch((e) => {
  console.error('Error:', e?.message);
  process.exit(1);
});
