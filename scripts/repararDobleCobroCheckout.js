'use strict';

/**
 * scripts/repararDobleCobroCheckout.js
 *
 * Detecta y repara a los clientes que volvieron a contratar (checkout)
 * mientras su suscripción anterior seguía viva, y por eso pagaron o están por
 * pagar el mismo mes dos veces.
 *
 * CÓMO PASÓ (10 casos entre el 23-09 y el 12-10-2026; el que lo destapó fue
 * jezahuanca@gmail.com, usuario 3116):
 *  1. La renovación rebota → la sub queda past_due y el usuario 'suspendido'.
 *  2. Todas las pantallas bloqueadas lo mandan a /planes, donde hasActivePlan
 *     solo es true con estado activo/trial: el botón dice "Comenzar ahora" y
 *     llama a crearSesionPago → checkout → sub NUEVA, pagada al instante.
 *  3. checkout.session.completed marcaba la vieja con cancel_at_period_end y
 *     metadata.reemplazada_por, pero dejaba su factura abierta con reintentos.
 *  4. El checkout guardó en el customer una tarjeta que sí pasa; Stripe
 *     reintentó la factura vieja con ella y la cobró días después (3116: $29
 *     el 08-10 por la nueva y $29 el 10-10 por la vieja). Además ese
 *     invoice.payment_succeeded volvía a apuntar la BD a la sub vieja.
 *
 * Desde el 12-10 crearSesionPago responde 409 (PAGO_PENDIENTE /
 * SUSCRIPCION_VIVA), el webhook anula la factura y cancela la vieja cuando
 * está past_due, y payment_succeeded ignora las subs reemplazadas. Este
 * script arregla lo que ya pasó. Por cada sub viva con metadata
 * reemplazada_por cuya reemplazante también está viva:
 *  1. BD → sub nueva (id, status, fechas; revive suspendido/vencido).
 *  2. Facturas abiertas/borrador de la vieja → se anulan (si no, se cobran
 *     en el siguiente reintento con la tarjeta nueva).
 *  3. Facturas de la vieja pagadas DESPUÉS de crearse la nueva → doble cobro.
 *     Se LISTAN con su id y su charge para reembolsarlas desde el dashboard
 *     de Stripe (Pagos → Reembolsar, motivo "duplicado"); este script no
 *     mueve dinero. Se dejan marcadas en transacciones_stripe_chat.
 *  4. Si hubo algo que anular o un doble cobro, la vieja se cancela YA. Una
 *     vieja active cuyo periodo se pagó ANTES del checkout se deja morir
 *     sola (cancel_at_period_end): ese periodo se pagó una sola vez.
 *
 * Al final lista la exposición actual: subs past_due/unpaid con factura
 * abierta (los que podrían caer en lo mismo mientras no salga el deploy).
 *
 * Uso:
 *   node scripts/repararDobleCobroCheckout.js                   (solo muestra)
 *   node scripts/repararDobleCobroCheckout.js --aplicar
 *   node scripts/repararDobleCobroCheckout.js --usuario 3116 --aplicar
 *
 * Usa SIEMPRE la llave live. Con --aplicar escribe en Stripe (anulaciones y
 * cancelaciones) y en la BD de producción: leer el dry-run antes.
 */
require('dotenv').config();
const Stripe = require('stripe');
const { db } = require('../src/database/config');

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const idxUsuario = args.indexOf('--usuario');
const soloUsuario = idxUsuario >= 0 ? Number(args[idxUsuario + 1]) : null;

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY no es una llave live (sk_live_). Abortado.');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

const VIVOS = ['active', 'trialing', 'past_due', 'unpaid'];
const periodEndDeSub = (sub) =>
  sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;
const fechaDe = (ts) => (ts ? new Date(ts * 1000) : null);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 16) : '-');
const usd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

async function traerSub(id) {
  try {
    return await stripe.subscriptions.retrieve(id);
  } catch (e) {
    return { id, status: 'no_existe', error: e?.message };
  }
}

async function registrarTx({ idPago, subId, idUsuario, estado, customerId }) {
  await db.query(
    `INSERT IGNORE INTO transacciones_stripe_chat
       (id_pago, id_suscripcion, id_usuario, estado_suscripcion, monto, moneda, billing_reason, fecha, customer_id)
     VALUES (?, ?, ?, ?, 0, 'usd', 'reparacion', NOW(), ?)`,
    {
      replacements: [idPago, subId, idUsuario, estado, customerId],
      type: db.QueryTypes.INSERT,
    },
  );
}

async function main() {
  // 1) Casos: subs vivas que un checkout reemplazó
  const viejas = [];
  for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    if (!VIVOS.includes(s.status) || !s.metadata?.reemplazada_por) continue;
    if (soloUsuario && Number(s.metadata?.id_usuario) !== soloUsuario) continue;
    viejas.push(s);
  }
  viejas.sort((a, b) => a.created - b.created);
  console.log(
    `${aplicar ? 'APLICANDO' : 'DRY-RUN'} · ${viejas.length} suscripción(es) viva(s) reemplazada(s) por un checkout\n`,
  );

  let totalDoble = 0;
  let totalAnulado = 0;
  const paraReembolsar = [];

  for (const vieja of viejas) {
    const nueva = await traerSub(vieja.metadata.reemplazada_por);
    const customerId =
      typeof vieja.customer === 'string' ? vieja.customer : vieja.customer?.id;
    const id_usuario =
      Number(vieja.metadata?.id_usuario) ||
      Number(nueva.metadata?.id_usuario) ||
      null;
    const [u] = id_usuario
      ? await db.query(
          `SELECT id_usuario, email_propietario, estado, stripe_subscription_id,
                  stripe_subscription_status, fecha_renovacion
             FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
          { replacements: [id_usuario], type: db.QueryTypes.SELECT },
        )
      : [];

    console.log(
      `── usuario ${id_usuario ?? '?'} · ${u?.email_propietario || customerId}`,
    );
    console.log(
      `   BD: sub ${u?.stripe_subscription_id || '-'} · ${u?.stripe_subscription_status || '-'} · estado ${u?.estado || '-'} · renueva ${iso(u?.fecha_renovacion)}`,
    );
    console.log(
      `   vieja ${vieja.id}: ${vieja.status} · creada ${iso(fechaDe(vieja.created))} · cancel_at_period_end ${vieja.cancel_at_period_end}`,
    );
    console.log(
      `   nueva ${nueva.id}: ${nueva.status} · creada ${iso(fechaDe(nueva.created))} · periodo hasta ${iso(fechaDe(periodEndDeSub(nueva)))}`,
    );

    if (!u) {
      console.log('   ⏭  sin fila en usuarios_chat_center; revisar a mano.\n');
      continue;
    }
    if (!VIVOS.includes(nueva.status)) {
      console.log(
        `   ⏭  la nueva no está viva (${nueva.status}): la vieja vuelve a ser la buena. Revisar a mano.\n`,
      );
      continue;
    }

    // 2) Facturas de la vieja
    const invs = (
      await stripe.invoices.list({ subscription: vieja.id, limit: 20 })
    ).data;
    const abiertas = invs.filter((i) => ['open', 'draft'].includes(i.status));
    const dobles = invs.filter(
      (i) =>
        i.status === 'paid' &&
        i.amount_paid > 0 &&
        (i.status_transitions?.paid_at || 0) >= nueva.created,
    );

    for (const inv of abiertas) {
      console.log(
        `   → Stripe: ${inv.status === 'draft' ? 'borrar borrador' : 'anular factura'} ${inv.id} (${usd(inv.amount_due)}, reintento ${iso(fechaDe(inv.next_payment_attempt))})`,
      );
      totalAnulado += inv.amount_due || 0;
    }
    for (const inv of dobles) {
      const horas = Math.round(
        (inv.status_transitions.paid_at - nueva.created) / 3600,
      );
      console.log(
        `   ‼ DOBLE COBRO ${inv.id} · charge ${inv.charge || '-'} · ${usd(inv.amount_paid)} pagada ${iso(fechaDe(inv.status_transitions.paid_at))} (${horas} h después del checkout) → reembolsar en el dashboard`,
      );
      totalDoble += inv.amount_paid || 0;
      paraReembolsar.push({
        id_usuario,
        email: u.email_propietario,
        invoice: inv.id,
        charge: inv.charge || null,
        monto: inv.amount_paid,
      });
    }

    const cancelarYa = abiertas.length > 0 || dobles.length > 0;
    if (cancelarYa) {
      console.log(`   → Stripe: cancelar YA la vieja ${vieja.id}`);
    } else {
      console.log(
        `   · la vieja tiene su periodo pagado antes del checkout; se deja morir sola${vieja.cancel_at_period_end ? '' : ' (OJO: sin cancelación programada)'}`,
      );
    }

    // 3) BD → nueva
    const apuntaVieja = u.stripe_subscription_id !== nueva.id;
    const revive =
      ['active', 'trialing'].includes(nueva.status) &&
      ['suspendido', 'vencido', 'cancelado'].includes(u.estado);
    const fechaRenovacion =
      nueva.status === 'trialing' && nueva.trial_end
        ? fechaDe(nueva.trial_end)
        : fechaDe(periodEndDeSub(nueva));
    if (apuntaVieja || revive) {
      console.log(
        `   → BD: sub ${nueva.id} · ${nueva.status} · renueva ${iso(fechaRenovacion)} · estado ${revive ? 'activo' : u.estado}`,
      );
    } else {
      console.log('   · BD ya apunta a la nueva');
    }

    if (!aplicar) {
      console.log('');
      continue;
    }

    // ── Aplicar, en este orden: BD, anular, marcar, cancelar ──
    if (apuntaVieja || revive) {
      await db.query(
        `UPDATE usuarios_chat_center
            SET stripe_subscription_id = ?,
                stripe_subscription_status = ?,
                cancel_at_period_end = ?,
                cancel_at = ?,
                canceled_at = ?,
                fecha_renovacion = COALESCE(?, fecha_renovacion),
                trial_end = COALESCE(?, trial_end),
                estado = ?
          WHERE id_usuario = ? LIMIT 1`,
        {
          replacements: [
            nueva.id,
            nueva.status,
            nueva.cancel_at_period_end ? 1 : 0,
            fechaDe(nueva.cancel_at),
            fechaDe(nueva.canceled_at),
            fechaRenovacion,
            fechaDe(nueva.trial_end),
            revive ? 'activo' : u.estado,
            id_usuario,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
      console.log('   ✔ BD actualizada');
    }

    for (const inv of abiertas) {
      if (inv.status === 'draft') await stripe.invoices.del(inv.id);
      else await stripe.invoices.voidInvoice(inv.id);
      await registrarTx({
        idPago: `anulada_${inv.id}`,
        subId: vieja.id,
        idUsuario: id_usuario,
        estado: 'factura_anulada_sub_reemplazada',
        customerId,
      });
      console.log(
        `   ✔ factura ${inv.id} ${inv.status === 'draft' ? 'borrada' : 'anulada'}`,
      );
    }

    for (const inv of dobles) {
      await db.query(
        `UPDATE transacciones_stripe_chat
            SET estado_suscripcion = 'cobro_sub_reemplazada',
                id_usuario = COALESCE(id_usuario, ?)
          WHERE id_pago = ?`,
        { replacements: [id_usuario, inv.id], type: db.QueryTypes.UPDATE },
      );
    }

    if (cancelarYa) {
      // La BD ya apunta a la nueva: el customer.subscription.deleted que esto
      // dispara se ignora (resolverBajaSuscripcion: no es la sub guardada).
      await stripe.subscriptions.cancel(vieja.id);
      console.log(`   ✔ vieja ${vieja.id} cancelada`);
    }
    console.log('');
  }

  console.log(
    `\nTotal: cobrado dos veces ${usd(totalDoble)} (reembolsar a mano) · facturas abiertas a anular ${usd(totalAnulado)}`,
  );
  if (paraReembolsar.length) {
    console.log('\nReembolsos pendientes (dashboard de Stripe → Pagos → Reembolsar, motivo duplicado):');
    for (const r of paraReembolsar) {
      console.log(
        `   ${r.id_usuario} · ${r.email} · ${r.invoice} · ${r.charge || 'sin charge'} · ${usd(r.monto)}`,
      );
    }
  }

  // 4) Exposición: quién está hoy en past_due con factura abierta
  if (!soloUsuario) {
    console.log(
      '\n── Exposición: subs past_due/unpaid con factura abierta (sin reemplazar aún)',
    );
    let n = 0;
    for (const status of ['past_due', 'unpaid']) {
      for await (const s of stripe.subscriptions.list({
        status,
        limit: 100,
        expand: ['data.latest_invoice', 'data.customer'],
      })) {
        if (s.metadata?.reemplazada_por) continue;
        const inv = s.latest_invoice;
        if (!inv || inv.status !== 'open') continue;
        n += 1;
        console.log(
          `   ${s.metadata?.id_usuario || '?'} · ${s.customer?.email || s.customer?.id} · ${usd(inv.amount_due)} · ${inv.attempt_count} intento(s) · próximo ${iso(fechaDe(inv.next_payment_attempt))}`,
        );
      }
    }
    console.log(
      `   ${n} cliente(s) que hoy podrían volver a contratar por checkout.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
