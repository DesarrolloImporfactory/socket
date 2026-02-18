const Stripe = require('stripe');
const { db } = require('../database/config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const getPlanByPriceId = async (priceId) => {
  if (!priceId) return null;

  const [[p]] = await db.query(
    `SELECT id_plan, nombre_plan, id_price, precio_plan
     FROM planes_chat_center
     WHERE id_price = ?
     LIMIT 1`,
    { replacements: [priceId] },
  );

  return p || null;
};

exports.stripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET_PLAN,
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      /**
       *  Opcional
       * Checkout completado: guardamos ids básicos (NO es el pago real)
       */
      case 'checkout.session.completed': {
        console.log('[stripe] checkout.session.completed');

        const session = event.data.object;

        const id_usuario =
          Number(session.client_reference_id || session.metadata?.id_usuario) ||
          null;

        const customerId = session.customer || null;
        const subscriptionId = session.subscription || null;

        if (!id_usuario) break;

        await db.query(
          `UPDATE usuarios_chat_center
           SET id_costumer = COALESCE(?, id_costumer),
               stripe_subscription_id = COALESCE(?, stripe_subscription_id)
           WHERE id_usuario = ?`,
          {
            replacements: [customerId, subscriptionId, id_usuario],
          },
        );

        break;
      }

      /**
       *  Pago exitoso (FUENTE DE VERDAD)
       * - Activa usuario
       * - Actualiza plan/fechas
       * - Sincroniza status/flags de Stripe en columnas nuevas
       * - Inserta transacción idempotente
       * - Aplica UPGRADE solo cuando el prorrateo realmente se pagó (pending_invoice_id)
       * - Marca promo_plan2_used solo si hubo descuento real en la invoice
       */
      case 'invoice.payment_succeeded': {
        console.log('[stripe] invoice.payment_succeeded');

        const invoice = event.data.object;

        const customerId = invoice.customer || null;
        const firstLine = invoice.lines?.data?.[0] || null;

        const subscriptionId =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          firstLine?.parent?.subscription_item_details?.subscription ||
          firstLine?.subscription ||
          null;

        const metaFromParent =
          invoice.parent?.subscription_details?.metadata || {};
        const metaFromLine = firstLine?.metadata || {};

        // 1) Insertar transacción (idempotente)
        try {
          await db.query(
            `INSERT IGNORE INTO transacciones_stripe_chat
             (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
             VALUES (?, ?, ?, ?, NOW(), ?)`,
            {
              replacements: [
                invoice.id,
                subscriptionId || null,
                null,
                'payment_succeeded',
                customerId || null,
              ],
            },
          );
          console.log('[stripe] transacciones inserted/ignored:', invoice.id);
        } catch (e) {
          console.log('[stripe] transacciones insert failed:', e?.message);
        }

        // 2) Resolver id_usuario / plan + fechas + flags Stripe
        let id_usuario = null;

        // Base: fechas desde line item (fallback)
        let start = firstLine?.period?.start
          ? new Date(firstLine.period.start * 1000)
          : null;
        let end = firstLine?.period?.end
          ? new Date(firstLine.period.end * 1000)
          : null;
        let trialEnd = null;

        let subStatus = null;
        let cancelAtPeriodEnd = 0;
        let cancelAt = null;
        let canceledAt = null;

        // Plan real por priceId
        let currentPriceId = null;
        let planRealByPrice = null;

        // Metadata subscription
        let metaSub = {};
        let pendingPlanId = null;
        let pendingChange = null;
        let pendingInvoiceId = null;

        if (subscriptionId) {
          try {
            const subscription = await stripe.subscriptions.retrieve(
              subscriptionId,
              { expand: ['items.data.price'] },
            );

            metaSub = subscription.metadata || {};

            id_usuario = Number(metaSub?.id_usuario) || null;

            // Plan REAL por priceId
            const item0 = subscription.items?.data?.[0] || null;
            currentPriceId = item0?.price?.id || null;

            if (currentPriceId) {
              planRealByPrice = await getPlanByPriceId(currentPriceId);
            }

            // Pending (upgrade/downgrade) en metadata
            pendingPlanId = Number(metaSub?.pending_plan_id || 0) || null;
            pendingChange = metaSub?.pending_change || null;

            //  NUEVO: invoice exacta que debe gatillar el upgrade
            pendingInvoiceId = metaSub?.pending_invoice_id || null;

            // Fechas más confiables desde subscription
            if (subscription.current_period_start)
              start = new Date(subscription.current_period_start * 1000);
            if (subscription.current_period_end)
              end = new Date(subscription.current_period_end * 1000);
            if (subscription.trial_end)
              trialEnd = new Date(subscription.trial_end * 1000);

            // Flags/status reales
            subStatus = subscription.status || null;
            cancelAtPeriodEnd = subscription.cancel_at_period_end ? 1 : 0;
            cancelAt = subscription.cancel_at
              ? new Date(subscription.cancel_at * 1000)
              : null;
            canceledAt = subscription.canceled_at
              ? new Date(subscription.canceled_at * 1000)
              : null;
          } catch (e) {
            console.log('[stripe] subscriptions.retrieve failed:', e?.message);
          }
        }

        // Fallback id_usuario por metadata invoice si no vino desde subscription
        if (!id_usuario) {
          id_usuario =
            Number(metaFromParent?.id_usuario || metaFromLine?.id_usuario) ||
            null;
          console.log(
            '[stripe] id_usuario fallback(invoice meta):',
            id_usuario,
          );
        }

        if (!id_usuario) {
          console.log(
            '[stripe] WARNING: id_usuario not found. Skipping usuarios_chat_center update.',
          );
          break;
        }

        // =========
        // Determinar plan a aplicar en BD
        // - UPGRADE: solo aplicar pending cuando invoice.id === pending_invoice_id
        // - Normal: usar plan REAL por priceId
        // =========
        const isUpgradeInvoice =
          pendingChange === 'upgrade' &&
          !!pendingPlanId &&
          !!pendingInvoiceId &&
          invoice.id === pendingInvoiceId;

        // plan final
        let planToApply = null;

        if (isUpgradeInvoice) {
          planToApply = pendingPlanId;
          console.log(
            '[stripe] applying UPGRADE pending_plan_id (by pending_invoice_id):',
            planToApply,
          );

          // Finalizar metadata en Stripe: id_plan definitivo y limpiar pending
          try {
            await stripe.subscriptions.update(subscriptionId, {
              metadata: {
                ...(metaSub || {}),
                id_plan: String(pendingPlanId),
                pending_plan_id: '',
                pending_change: '',
                pending_invoice_id: '', // ✅ limpiar para que no se re-aplique
              },
            });
          } catch (e) {
            console.log('[stripe] sub metadata finalize failed:', e?.message);
          }
        } else {
          // Normal: plan REAL por priceId (más confiable que metadata)
          planToApply = Number(planRealByPrice?.id_plan || 0) || null;
          console.log('[stripe] applying plan by priceId:', planToApply);
        }

        // Fallback final (por si no hubo priceId o falla DB)
        if (!planToApply) {
          const fallbackPlan =
            Number(
              metaSub?.id_plan ||
                metaFromParent?.id_plan ||
                metaFromLine?.id_plan,
            ) || null;
          planToApply = fallbackPlan;
          console.log('[stripe] plan fallback(meta):', planToApply);
        }

        // =========
        // Promo: marcar promo_plan2_used SOLO si hubo descuento real en esta invoice
        // =========
        const CONEXION_PLAN_ID = Number(
          process.env.STRIPE_PLAN_CONEXION_ID || 2,
        );

        const totalDiscount = (invoice.total_discount_amounts || []).reduce(
          (acc, d) => acc + (d.amount || 0),
          0,
        );

        const usedCoupon = totalDiscount > 0;
        const shouldMarkPromoUsed =
          Number(planToApply) === CONEXION_PLAN_ID && usedCoupon;

        if (shouldMarkPromoUsed) {
          try {
            await db.query(
              `UPDATE usuarios_chat_center
               SET promo_plan2_used = 1
               WHERE id_usuario = ?`,
              { replacements: [id_usuario] },
            );
            console.log('[stripe] promo_plan2_used marked:', id_usuario);
          } catch (e) {
            console.log('[stripe] promo_plan2_used update failed:', e?.message);
          }
        }

        // =========
        // 3) Update usuario: sincronización total
        // =========
        const [updateResult] = await db.query(
          `UPDATE usuarios_chat_center
           SET id_plan = ?,
               estado = 'activo',
               fecha_inicio = COALESCE(fecha_inicio, ?),
               fecha_renovacion = ?,
               free_trial_used = 1,
               id_costumer = COALESCE(?, id_costumer),
               stripe_subscription_id = COALESCE(?, stripe_subscription_id),
               trial_end = ?,
               stripe_subscription_status = COALESCE(?, stripe_subscription_status),
               cancel_at_period_end = COALESCE(?, cancel_at_period_end),
               cancel_at = COALESCE(?, cancel_at),
               canceled_at = COALESCE(?, canceled_at)
           WHERE id_usuario = ?`,
          {
            replacements: [
              planToApply || null,
              start,
              end,
              customerId || null,
              subscriptionId || null,
              trialEnd,
              subStatus || null,
              cancelAtPeriodEnd,
              cancelAt,
              canceledAt,
              id_usuario,
            ],
          },
        );

        console.log(
          '[stripe] usuarios_chat_center update result:',
          updateResult,
        );

        // =========
        // 3.1) Si fue upgrade invoice: limpiar pending_* en BD y auditar
        // =========
        if (isUpgradeInvoice) {
          try {
            await db.query(
              `UPDATE usuarios_chat_center
               SET pending_plan_id = NULL,
                   pending_change = NULL,
                   pending_effective_at = NULL
               WHERE id_usuario = ?`,
              { replacements: [id_usuario] },
            );
          } catch (e) {
            console.log('[stripe] pending cleanup failed:', e?.message);
          }

          try {
            const idPagoAudit = `upgrade_applied_${subscriptionId}_${invoice.id}`;
            await db.query(
              `INSERT IGNORE INTO transacciones_stripe_chat
               (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
               VALUES (?, ?, ?, ?, NOW(), ?)`,
              {
                replacements: [
                  idPagoAudit,
                  subscriptionId || null,
                  id_usuario,
                  `upgrade_applied->${pendingPlanId}`,
                  customerId || null,
                ],
              },
            );
          } catch (e) {
            console.log('[stripe] upgrade audit insert failed:', e?.message);
          }
        }

        // =========
        // 4) Completar id_usuario en transacciones
        // =========
        try {
          await db.query(
            `UPDATE transacciones_stripe_chat
             SET id_usuario = COALESCE(id_usuario, ?),
                 id_suscripcion = COALESCE(id_suscripcion, ?),
                 customer_id = COALESCE(customer_id, ?)
             WHERE id_pago = ?`,
            {
              replacements: [
                id_usuario,
                subscriptionId || null,
                customerId || null,
                invoice.id,
              ],
            },
          );
          console.log(
            '[stripe] transacciones updated with id_usuario:',
            invoice.id,
          );
        } catch (e) {
          console.log('[stripe] transacciones update failed:', e?.message);
        }

        break;
      }

      /**
       * ❌ Pago fallido
       * - Suspende usuario
       * - Sincroniza status/flags de Stripe
       * - Inserta transacción idempotente
       */
      case 'invoice.payment_failed': {
        console.log('[stripe] invoice.payment_failed');

        const invoice = event.data.object;

        const customerId = invoice.customer || null;
        const firstLine = invoice.lines?.data?.[0] || null;

        const subscriptionId =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          firstLine?.parent?.subscription_item_details?.subscription ||
          firstLine?.subscription ||
          null;

        console.log('[stripe] invoice.id:', invoice.id);
        console.log('[stripe] customerId:', customerId);
        console.log('[stripe] subscriptionId:', subscriptionId);

        let id_usuario = null;

        let subStatus = null;
        let cancelAtPeriodEnd = 0;
        let cancelAt = null;
        let canceledAt = null;

        if (subscriptionId) {
          try {
            const subscription = await stripe.subscriptions.retrieve(
              subscriptionId,
              { expand: ['items.data.price'] },
            );

            id_usuario = Number(subscription.metadata?.id_usuario) || null;

            subStatus = subscription.status || null;
            cancelAtPeriodEnd = subscription.cancel_at_period_end ? 1 : 0;
            cancelAt = subscription.cancel_at
              ? new Date(subscription.cancel_at * 1000)
              : null;
            canceledAt = subscription.canceled_at
              ? new Date(subscription.canceled_at * 1000)
              : null;
          } catch (e) {
            console.log('[stripe] subscriptions.retrieve failed:', e?.message);
          }
        }

        if (id_usuario) {
          await db.query(
            `UPDATE usuarios_chat_center
             SET estado = 'suspendido',
                 stripe_subscription_status = COALESCE(?, stripe_subscription_status),
                 cancel_at_period_end = COALESCE(?, cancel_at_period_end),
                 cancel_at = COALESCE(?, cancel_at),
                 canceled_at = COALESCE(?, canceled_at)
             WHERE id_usuario = ?`,
            {
              replacements: [
                subStatus,
                cancelAtPeriodEnd,
                cancelAt,
                canceledAt,
                id_usuario,
              ],
            },
          );
        }

        await db.query(
          `INSERT IGNORE INTO transacciones_stripe_chat
           (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
           VALUES (?, ?, ?, ?, NOW(), ?)`,
          {
            replacements: [
              invoice.id,
              subscriptionId || null,
              id_usuario || null,
              'payment_failed',
              customerId || null,
            ],
          },
        );

        break;
      }

      /**
       * Cambios en la suscripción
       * - Sirve para:
       *   - Cancelación programada / efectiva
       *   - DOWNGRADE: aplicar cuando Stripe ya cambió el price (inicio de la nueva fase)
       */
      case 'customer.subscription.updated': {
        const sub = event.data.object;

        const subscriptionId = sub.id || null;
        const customerId = sub.customer || null;

        const id_usuario = Number(sub.metadata?.id_usuario) || null;

        // Estado / flags
        const cancelAtPeriodEnd = sub.cancel_at_period_end ? 1 : 0;
        const cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000) : null;
        const canceledAt = sub.canceled_at
          ? new Date(sub.canceled_at * 1000)
          : null;

        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : null;

        const status = sub.status || null;

        // Plan REAL por priceId (lo que Stripe está cobrando en ESTE momento)
        const currentPriceId = sub.items?.data?.[0]?.price?.id || null;
        let planRealByPrice = null;
        if (currentPriceId) {
          try {
            planRealByPrice = await getPlanByPriceId(currentPriceId);
          } catch (e) {
            console.log('[stripe] getPlanByPriceId failed:', e?.message);
          }
        }
        const planRealId = Number(planRealByPrice?.id_plan || 0) || null;

        // Pending desde metadata (downgrade programado)
        const pendingPlanId =
          Number(sub.metadata?.pending_plan_id || 0) || null;
        const pendingChange = sub.metadata?.pending_change || null;

        const shouldApplyDowngradeNow =
          pendingChange === 'downgrade' &&
          !!pendingPlanId &&
          !!planRealId &&
          planRealId === pendingPlanId;

        // Si downgrade está pending pero aún NO cambió el price, NO toque id_plan (mantiene beneficios)
        const isDowngradePending =
          pendingChange === 'downgrade' && !!pendingPlanId;

        const idPlanToWrite =
          isDowngradePending && !shouldApplyDowngradeNow
            ? null
            : planRealId || Number(sub.metadata?.id_plan) || null;

        // 1) Actualizar flags del usuario
        if (id_usuario) {
          await db.query(
            `UPDATE usuarios_chat_center
             SET id_plan = COALESCE(?, id_plan),
                 id_costumer = COALESCE(?, id_costumer),
                 stripe_subscription_id = COALESCE(?, stripe_subscription_id),
                 fecha_renovacion = COALESCE(?, fecha_renovacion),
                 stripe_subscription_status = ?,
                 cancel_at_period_end = ?,
                 cancel_at = ?,
                 canceled_at = ?
             WHERE id_usuario = ?`,
            {
              replacements: [
                idPlanToWrite,
                customerId || null,
                subscriptionId || null,
                currentPeriodEnd,
                status,
                cancelAtPeriodEnd,
                cancelAt,
                canceledAt,
                id_usuario,
              ],
            },
          );

          // Si ya terminó realmente: cancelar en BD
          if (status === 'canceled' || sub.ended_at) {
            await db.query(
              `UPDATE usuarios_chat_center
               SET estado = 'cancelado'
               WHERE id_usuario = ?`,
              { replacements: [id_usuario] },
            );
          }
        }

        // 2) Si corresponde: aplicar DOWNGRADE ahora (ya cambió el price)
        if (shouldApplyDowngradeNow && id_usuario) {
          // Limpieza pending en BD
          try {
            await db.query(
              `UPDATE usuarios_chat_center
               SET id_plan = ?,
                   pending_plan_id = NULL,
                   pending_change = NULL,
                   pending_effective_at = NULL
               WHERE id_usuario = ?`,
              { replacements: [pendingPlanId, id_usuario] },
            );
          } catch (e) {
            console.log(
              '[stripe] downgrade pending cleanup failed:',
              e?.message,
            );
          }

          // Finalizar metadata en Stripe
          try {
            await stripe.subscriptions.update(subscriptionId, {
              metadata: {
                ...(sub.metadata || {}),
                id_plan: String(pendingPlanId),
                pending_plan_id: '',
                pending_change: '',
              },
            });
          } catch (e) {
            console.log(
              '[stripe] finalize downgrade metadata failed:',
              e?.message,
            );
          }

          // Auditoría
          try {
            const idPagoAudit = `downgrade_applied_${subscriptionId}_${Date.now()}`;
            await db.query(
              `INSERT IGNORE INTO transacciones_stripe_chat
               (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
               VALUES (?, ?, ?, ?, NOW(), ?)`,
              {
                replacements: [
                  idPagoAudit,
                  subscriptionId || null,
                  id_usuario,
                  `downgrade_applied->${pendingPlanId}`,
                  customerId || null,
                ],
              },
            );
          } catch (e) {
            console.log('[stripe] downgrade audit insert failed:', e?.message);
          }
        }

        // 3) Auditoría idempotente general
        const estadoTx =
          status === 'canceled' || sub.ended_at
            ? 'subscription_canceled'
            : cancelAtPeriodEnd
              ? 'cancel_scheduled'
              : 'subscription_updated';

        const idPago = event.id;

        await db.query(
          `INSERT IGNORE INTO transacciones_stripe_chat
           (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
           VALUES (?, ?, ?, ?, NOW(), ?)`,
          {
            replacements: [
              idPago,
              subscriptionId || null,
              id_usuario || null,
              estadoTx,
              customerId || null,
            ],
          },
        );

        break;
      }

      default:
        console.log('[stripe] ignored event:', event.type);
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.log('[stripe] webhook handler error:', err?.message);
    return res.status(500).json({ received: false, error: err.message });
  }
};
