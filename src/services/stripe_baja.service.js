const { db } = require('../database/config');

/**
 * Baja de una suscripción de Stripe (customer.subscription.deleted).
 *
 * Stripe manda `customer.subscription.deleted` tanto en la cancelación
 * inmediata como cuando una cancelación programada (cancel_at_period_end)
 * llega al fin del periodo. NO manda `customer.subscription.updated` con
 * status=canceled (0 de 100 updated en 30 días vs 40 deleted), así que la
 * rama "canceled" del handler de updated nunca corre y la BD se quedaba con
 * stripe_subscription_status='active' para siempre: el dashboard_admin
 * contaba clientes que ya no pagaban (150 en BD vs 147 en Stripe el
 * 2026-09-22).
 *
 * Esta función es la ÚNICA fuente de esa decisión: la usan el webhook y el
 * script scripts/reconciliarSuscripcionesStripe.js. Reglas:
 *  1. Solo se toca al usuario si la sub que murió es LA que tiene guardada
 *     (stripe_subscription_id). Los add-ons (Conexión $5) y subs viejas van
 *     como subs aparte y no deben cancelar la cuenta.
 *  2. Si el mismo customer tiene OTRA sub viva (active/trialing/past_due),
 *     se apunta la BD a esa en vez de cancelar: es el caso del cliente que
 *     se re-suscribió antes de que venciera la anterior.
 *  3. Si no hay otra, stripe_subscription_status='canceled' y
 *     estado='cancelado' (mismo criterio que el login en stripe.controller).
 *     Un permanente=1 conserva su estado: su acceso no depende de Stripe.
 */

const ESTADOS_VIVOS = ['active', 'trialing', 'past_due'];

const periodEndDeSub = (sub) =>
  sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;

const fechaDe = (ts) => (ts ? new Date(ts * 1000) : null);

async function buscarOtraSubViva(stripe, customerId, excluirSubId) {
  if (!customerId) return null;
  const list = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
  });
  const subs = (list?.data || []).filter((s) => s.id !== excluirSubId);
  for (const st of ESTADOS_VIVOS) {
    const found = subs
      .filter((s) => s.status === st)
      .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    if (found) return found;
  }
  return null;
}

async function auditar({ idPago, sub, id_usuario, accion }) {
  try {
    await db.query(
      `INSERT IGNORE INTO transacciones_stripe_chat
       (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      {
        replacements: [
          idPago,
          sub.id || null,
          id_usuario || null,
          accion,
          sub.customer || null,
        ],
      },
    );
  } catch (e) {
    console.log('[stripe] baja audit insert failed:', e?.message);
  }
}

/**
 * @param {object} p
 * @param {import('stripe')} p.stripe   instancia ya configurada
 * @param {object} p.sub                objeto Subscription (del evento o de retrieve)
 * @param {number|null} p.id_usuario    ya resuelto por el caller (metadata o BD)
 * @param {string} p.idPago             id para la fila de auditoría (event.id o reconcile_*)
 * @param {boolean} [p.aplicar=true]    false = solo decide, no escribe (dry-run)
 * @returns {Promise<{accion:string, detalle?:object}>}
 *   accion: 'sin_usuario' | 'ignorada_no_es_la_activa' | 'reemplazada' | 'cancelada'
 */
async function resolverBajaSuscripcion({
  stripe,
  sub,
  id_usuario,
  idPago,
  aplicar = true,
}) {
  if (!id_usuario) return { accion: 'sin_usuario' };

  const [[user]] = await db.query(
    `SELECT id_usuario, estado, permanente, id_costumer, stripe_subscription_id
       FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
    { replacements: [id_usuario] },
  );
  if (!user) return { accion: 'sin_usuario' };

  if (user.stripe_subscription_id !== sub.id) {
    const accion = 'ignorada_no_es_la_activa';
    if (aplicar && idPago) {
      await auditar({
        idPago,
        sub,
        id_usuario,
        accion: 'subscription_deleted_ignored_non_active_sub',
      });
    }
    return {
      accion,
      detalle: { sub_en_bd: user.stripe_subscription_id },
    };
  }

  const otra = await buscarOtraSubViva(
    stripe,
    sub.customer || user.id_costumer,
    sub.id,
  );

  if (otra) {
    // No se toca id_plan: lo escribieron los eventos de esa otra sub cuando
    // se creó (checkout / invoice.payment_succeeded) y aquí no se sabe
    // distinguir el item del plan de los add-ons.
    const fechaRenovacion =
      otra.status === 'trialing' && otra.trial_end
        ? fechaDe(otra.trial_end)
        : fechaDe(periodEndDeSub(otra));
    // 'suspendido' solo lo pone invoice.payment_failed (no hay suspensión
    // manual de cuentas en el backend): una sub nueva viva del mismo
    // customer significa que ya pagó por otro lado (caso 1558: falló el
    // cobro de la vieja, se re-suscribió el mismo día y quedó suspendido).
    const revive =
      ['active', 'trialing'].includes(otra.status) &&
      ['cancelado', 'vencido', 'suspendido'].includes(user.estado);

    if (aplicar) {
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
            otra.id,
            otra.status,
            otra.cancel_at_period_end ? 1 : 0,
            fechaDe(otra.cancel_at),
            fechaDe(otra.canceled_at),
            fechaRenovacion,
            fechaDe(otra.trial_end),
            revive ? 'activo' : user.estado,
            id_usuario,
          ],
        },
      );
      if (idPago) {
        await auditar({
          idPago,
          sub,
          id_usuario,
          accion: `subscription_deleted_reemplazada`,
        });
      }
    }
    return {
      accion: 'reemplazada',
      detalle: {
        nueva_sub: otra.id,
        nuevo_status: otra.status,
        estado: revive ? 'activo' : user.estado,
      },
    };
  }

  const estadoFinal = Number(user.permanente) === 1 ? user.estado : 'cancelado';
  if (aplicar) {
    await db.query(
      `UPDATE usuarios_chat_center
          SET stripe_subscription_status = 'canceled',
              cancel_at_period_end = 0,
              cancel_at = COALESCE(?, cancel_at),
              canceled_at = COALESCE(?, canceled_at),
              estado = ?
        WHERE id_usuario = ? LIMIT 1`,
      {
        replacements: [
          fechaDe(sub.cancel_at),
          fechaDe(sub.canceled_at),
          estadoFinal,
          id_usuario,
        ],
      },
    );
    if (idPago) {
      await auditar({
        idPago,
        sub,
        id_usuario,
        accion: 'subscription_deleted',
      });
    }
  }
  return {
    accion: 'cancelada',
    detalle: { estado: estadoFinal, estado_anterior: user.estado },
  };
}

module.exports = { resolverBajaSuscripcion, buscarOtraSubViva, ESTADOS_VIVOS };
