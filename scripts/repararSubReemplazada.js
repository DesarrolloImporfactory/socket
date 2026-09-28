'use strict';

/**
 * scripts/repararSubReemplazada.js
 *
 * Repara a los usuarios cuya fila en usuarios_chat_center quedó apuntando a
 * la suscripción VIEJA después de que un checkout la reemplazó por una nueva.
 *
 * CASO QUE LO ORIGINÓ (2026-09-27, usuario 2153, 1compraseguraparati@gmail.com)
 * La renovación del 27-09 rebotó (do_not_honor) y la sub quedó past_due. El
 * cliente pagó $29 por checkout ese mismo día: sub nueva, factura pagada.
 * checkout.session.completed programó cancel_at_period_end en la vieja y ese
 * update disparó customer.subscription.updated de la sub VIEJA, que llegó
 * después de los eventos de la nueva y pisó stripe_subscription_id/status con
 * past_due + cancelación programada. Mi plan leía esa sub y mostraba
 * "Suspendido" con el pago hecho. 4 de los 7 reemplazos desde el 22-09
 * quedaron así. El webhook ya ignora esos eventos (sub retirada); este script
 * arregla los que ya pasaron.
 *
 * Qué hace por cada usuario afectado (fila `reemplazada_por_…` en
 * transacciones_stripe_chat cuya sub vieja sigue siendo la guardada):
 *  1. Apunta la BD a la sub nueva (id, status, banderas de cancelación,
 *     fecha_renovacion, trial_end). Si el usuario estaba suspendido/vencido/
 *     cancelado y la nueva está viva, vuelve a 'activo'.
 *  2. Si la vieja quedó past_due/unpaid (su periodo NO se pagó: la nueva lo
 *     cubre), anula sus facturas abiertas y la cancela de inmediato. Si no se
 *     hace, Stripe reintenta el cobro (2153: el 30-09) y el cliente paga el
 *     mes dos veces. Una vieja `active` con cancelación programada se deja:
 *     ese periodo sí se pagó y muere sola al terminar.
 *
 * Uso:
 *   node scripts/repararSubReemplazada.js                 (solo muestra)
 *   node scripts/repararSubReemplazada.js --aplicar
 *   node scripts/repararSubReemplazada.js --usuario 2153 --aplicar
 *
 * Usa SIEMPRE la llave live: las suscripciones de los clientes viven ahí.
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

const VIVOS = ['active', 'trialing', 'past_due'];
const periodEndDeSub = (sub) =>
  sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;
const fechaDe = (ts) => (ts ? new Date(ts * 1000) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);

async function traerSub(id) {
  try {
    return await stripe.subscriptions.retrieve(id);
  } catch (e) {
    return { id, status: 'no_existe', error: e?.message };
  }
}

async function facturasAbiertas(subId) {
  const out = [];
  for (const status of ['open', 'draft']) {
    const list = await stripe.invoices.list({
      subscription: subId,
      status,
      limit: 20,
    });
    out.push(...(list?.data || []));
  }
  return out;
}

(async () => {
  const filas = await db.query(
    `SELECT t.id_usuario, t.id_suscripcion AS sub_vieja,
            SUBSTRING(t.estado_suscripcion, 17) AS sub_nueva, t.fecha,
            u.email_propietario, u.estado, u.id_costumer,
            u.stripe_subscription_id AS sub_en_bd,
            u.stripe_subscription_status, u.cancel_at_period_end,
            u.fecha_renovacion
       FROM transacciones_stripe_chat t
       JOIN usuarios_chat_center u ON u.id_usuario = t.id_usuario
      WHERE t.estado_suscripcion LIKE 'reemplazada_por_%'
        AND u.stripe_subscription_id = t.id_suscripcion
        ${soloUsuario ? 'AND t.id_usuario = ?' : ''}
      ORDER BY t.fecha DESC`,
    {
      replacements: soloUsuario ? [soloUsuario] : [],
      type: db.QueryTypes.SELECT,
    },
  );

  console.log(
    `${aplicar ? 'APLICANDO' : 'DRY-RUN'} · ${filas.length} usuario(s) apuntando a la sub reemplazada\n`,
  );

  for (const f of filas) {
    console.log(`── usuario ${f.id_usuario} · ${f.email_propietario}`);
    console.log(
      `   BD: sub ${f.sub_en_bd} · status ${f.stripe_subscription_status} · cancel_at_period_end ${f.cancel_at_period_end} · estado ${f.estado} · renueva ${iso(f.fecha_renovacion)}`,
    );

    const nueva = await traerSub(f.sub_nueva);
    const vieja = await traerSub(f.sub_vieja);
    console.log(
      `   nueva ${nueva.id}: ${nueva.status} · periodo hasta ${iso(fechaDe(periodEndDeSub(nueva)))}`,
    );
    console.log(
      `   vieja ${vieja.id}: ${vieja.status} · cancel_at_period_end ${vieja.cancel_at_period_end} · última factura ${vieja.latest_invoice || '-'}`,
    );

    if (!VIVOS.includes(nueva.status)) {
      console.log(
        `   ⏭  la sub nueva no está viva (${nueva.status}); no se toca. Revisar a mano.\n`,
      );
      continue;
    }

    // 1) BD → sub nueva
    const fechaRenovacion =
      nueva.status === 'trialing' && nueva.trial_end
        ? fechaDe(nueva.trial_end)
        : fechaDe(periodEndDeSub(nueva));
    const revive =
      ['active', 'trialing'].includes(nueva.status) &&
      ['suspendido', 'vencido', 'cancelado'].includes(f.estado);
    const estadoNuevo = revive ? 'activo' : f.estado;

    console.log(
      `   → BD: sub ${nueva.id} · status ${nueva.status} · cancel_at_period_end ${nueva.cancel_at_period_end ? 1 : 0} · renueva ${iso(fechaRenovacion)} · estado ${estadoNuevo}`,
    );

    // 2) Vieja sin pagar → anular facturas y cancelar ya
    const viejaSinPagar = ['past_due', 'unpaid'].includes(vieja.status);
    let abiertas = [];
    if (viejaSinPagar) {
      abiertas = await facturasAbiertas(vieja.id);
      for (const inv of abiertas) {
        console.log(
          `   → Stripe: ${inv.status === 'draft' ? 'borrar borrador' : 'anular factura'} ${inv.id} ($${(inv.amount_due / 100).toFixed(2)}, reintento ${iso(fechaDe(inv.next_payment_attempt)) || 'ninguno'})`,
        );
      }
      console.log(`   → Stripe: cancelar YA la sub vieja ${vieja.id}`);
    } else if (VIVOS.includes(vieja.status)) {
      console.log(
        `   · la vieja está ${vieja.status} con periodo pagado; se deja morir sola${vieja.cancel_at_period_end ? '' : ' (OJO: sin cancelación programada)'}`,
      );
    }

    if (!aplicar) {
      console.log('');
      continue;
    }

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
        WHERE id_usuario = ? AND stripe_subscription_id = ? LIMIT 1`,
      {
        replacements: [
          nueva.id,
          nueva.status,
          nueva.cancel_at_period_end ? 1 : 0,
          fechaDe(nueva.cancel_at),
          fechaDe(nueva.canceled_at),
          fechaRenovacion,
          fechaDe(nueva.trial_end),
          estadoNuevo,
          f.id_usuario,
          f.sub_vieja,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    console.log('   ✔ BD actualizada');

    if (viejaSinPagar) {
      for (const inv of abiertas) {
        if (inv.status === 'draft') await stripe.invoices.del(inv.id);
        else await stripe.invoices.voidInvoice(inv.id);
        console.log(
          `   ✔ factura ${inv.id} ${inv.status === 'draft' ? 'borrada' : 'anulada'}`,
        );
      }
      // La BD ya apunta a la nueva: el customer.subscription.deleted que
      // dispara esto cae en "ignorada_no_es_la_activa" (stripe_baja.service).
      await stripe.subscriptions.cancel(vieja.id, {
        invoice_now: false,
        prorate: false,
      });
      console.log(`   ✔ sub vieja ${vieja.id} cancelada`);
    }

    await db.query(
      `INSERT IGNORE INTO transacciones_stripe_chat
       (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      {
        replacements: [
          `reparacion_reemplazo_${f.sub_vieja}_${Date.now()}`,
          f.sub_vieja,
          f.id_usuario,
          `reparada->${nueva.id}`,
          f.id_costumer || null,
        ],
      },
    );
    console.log('');
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
