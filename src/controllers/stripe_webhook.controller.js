const Stripe = require('stripe');
const { db } = require('../database/config');
const referidosService = require('../services/referidos.service');
const {
  auditarDesdeSistema,
} = require('../services/suspension_audit.service');

/* =========================
   Selección automática de variables por entorno (production vs test)
========================= */
const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// En producción => PROD; en no-prod => TEST (si no existe, cae a PROD)

// Stripe API 2025-03+ ("basil", la que usa el SDK 18) quitó current_period_end
// del objeto Subscription: ahora vive en cada item. Leerlo directo del sub
// devolvía undefined y dejaba fecha_renovacion sin actualizar (o Invalid Date).
const periodEndDeSub = (sub) =>
  sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;

const envPick = (prodKey, testKey, fallback = '') => {
  const prodVal = process.env[prodKey];
  const testVal = process.env[testKey];
  if (isProd) return prodVal ?? fallback;
  return testVal ?? prodVal ?? fallback;
};

// Stripe keys por entorno
const STRIPE_SECRET = envPick('STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST');

// Webhook secret por entorno
const STRIPE_WEBHOOK_SECRET_PLAN = envPick(
  'STRIPE_WEBHOOK_SECRET_PLAN',
  'STRIPE_WEBHOOK_SECRET_PLAN_TEST',
);

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

// ¿El error es "Unknown column 'monto'" (o moneda/billing_reason)? Pasa si
// la tabla no tiene aún las columnas monto/moneda/billing_reason (se
// agregaron el 2026-09-04); en ese caso se cae al
// INSERT/UPDATE viejo para no perder la transacción.
const esColumnaMontoFaltante = (e) => {
  const code = e?.original?.code || e?.parent?.code || e?.code;
  const msg = String(e?.original?.sqlMessage || e?.message || '');
  return (
    code === 'ER_BAD_FIELD_ERROR' &&
    /'(monto|moneda|billing_reason)'/i.test(msg)
  );
};

/* =========================
   Helpers
========================= */
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

//  Helper: obtener la suscripción activa guardada en BD para el usuario
const getActiveSubscriptionIdByUser = async (id_usuario) => {
  if (!id_usuario) return null;
  const [[u]] = await db.query(
    `SELECT stripe_subscription_id
     FROM usuarios_chat_center
     WHERE id_usuario = ?
     LIMIT 1`,
    { replacements: [id_usuario] },
  );
  return u?.stripe_subscription_id || null;
};

//  Helper: fallback para resolver id_usuario cuando la sub NO trae metadata.id_usuario
//  (subs creadas a mano en el dashboard de Stripe llegan con metadata vacía).
//  stripe_subscription_id es único por usuario en BD, así que el match es confiable.
const resolverIdUsuarioPorStripe = async (subscriptionId, customerId) => {
  if (subscriptionId) {
    const [[u]] = await db.query(
      `SELECT id_usuario
       FROM usuarios_chat_center
       WHERE stripe_subscription_id = ?
       LIMIT 1`,
      { replacements: [subscriptionId] },
    );
    if (u?.id_usuario) return Number(u.id_usuario);
  }
  if (customerId) {
    const [[u]] = await db.query(
      `SELECT id_usuario, stripe_subscription_id
       FROM usuarios_chat_center
       WHERE id_costumer = ?
       LIMIT 1`,
      { replacements: [customerId] },
    );
    // Por customer solo si el usuario no apunta a OTRA suscripción distinta
    if (
      u?.id_usuario &&
      (!u.stripe_subscription_id ||
        !subscriptionId ||
        u.stripe_subscription_id === subscriptionId)
    ) {
      return Number(u.id_usuario);
    }
  }
  return null;
};

// Columnas válidas para addons (seguridad: el UPDATE interpola el nombre)
const ADDON_COLUMNS_PERMITIDAS = new Set([
  'conexiones_adicionales',
  'subusuarios_adicionales',
]);

// Map de priceId(entorno) -> { clave, target_columna } de todos los addons activos
const getAddonPriceMap = async () => {
  const [rows] = await db.query(
    `SELECT clave, target_columna, id_price_prod, id_price_test
     FROM addons_chat_center WHERE activo = 1`,
  );
  const map = new Map();
  for (const a of rows || []) {
    const priceId = isProd ? a.id_price_prod : a.id_price_test;
    if (priceId) {
      map.set(priceId, { clave: a.clave, target_columna: a.target_columna });
    }
  }
  return map;
};

// Por cada item de la sub que sea un addon → escribe su quantity en su target_columna
const sincronizarAddons = async (items, addonMap, id_usuario) => {
  if (!addonMap || !id_usuario) return;
  for (const it of items || []) {
    const priceId = it.price?.id;
    const info = priceId ? addonMap.get(priceId) : null;
    if (!info) continue;

    const col = info.target_columna;
    if (!ADDON_COLUMNS_PERMITIDAS.has(col)) {
      console.log('[stripe] addon target_columna inválida, skip:', col);
      continue;
    }

    const qty = Number(it.quantity || 0);
    try {
      await db.query(
        `UPDATE usuarios_chat_center SET ${col} = ? WHERE id_usuario = ?`,
        { replacements: [qty, id_usuario] },
      );
      console.log(`[stripe] addon sync ${info.clave}: ${col}=${qty}`);
    } catch (e) {
      console.log('[stripe] addon sync failed:', e?.message);
    }
  }
};

exports.stripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw buffer
      sig,
      STRIPE_WEBHOOK_SECRET_PLAN,
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      /**
       *  Opcional
       * Checkout completado: guardamos ids básicos (NO es el pago real)
       * Nota: se deja con COALESCE para no pisar una suscripción activa válida.
       */
      case 'checkout.session.completed': {
        console.log('[stripe] checkout.session.completed');

        const session = event.data.object;

        const id_usuario =
          Number(session.client_reference_id || session.metadata?.id_usuario) ||
          null;

        // Puede venir o no
        const id_plataforma = Number(session.metadata?.id_plataforma) || null;

        const customerId = session.customer || null;
        const subscriptionId = session.subscription || null;

        if (!id_usuario) break;

        // Solo setear id_plataforma si viene (no tocar si no viene)
        const sql = `
          UPDATE usuarios_chat_center
          SET id_costumer = COALESCE(?, id_costumer),
              stripe_subscription_id = COALESCE(?, stripe_subscription_id)
              ${id_plataforma ? ', id_plataforma = COALESCE(?, id_plataforma)' : ''}
          WHERE id_usuario = ?
        `;

        const replacements = id_plataforma
          ? [customerId, subscriptionId, id_plataforma, id_usuario]
          : [customerId, subscriptionId, id_usuario];

        await db.query(sql, { replacements });

        break;
      }

      /**
       * Factura creada (draft) → FINALIZARLA YA.
       *
       * POR QUÉ EXISTE ESTE CASE
       * Stripe crea las facturas de suscripción en `draft` y las finaliza sola
       * ~1 hora después (esa ventana existe para poder agregar invoice items
       * antes del cierre). El cobro y el `invoice.payment_succeeded` —que es
       * donde este webhook activa al usuario— recién ocurren al finalizar.
       *
       * Resultado con membresías: al vencer `fecha_renovacion`, checkPlanActivo
       * marca al cliente 'vencido' y le bloquea el panel hasta una hora, aunque
       * su tarjeta esté perfecta. Finalizando aquí, el cobro entra en segundos.
       *
       * NO se finaliza cuando:
       *  - La factura no nace de una suscripción (billing_reason ajeno).
       *  - Ya no está en draft → el webhook se reintentó, o Stripe la finalizó
       *    primero. Es lo que hace este handler idempotente.
       *  - auto_advance = false o collection_method = 'send_invoice' → es una
       *    factura gestionada a mano; no se toca.
       *  - La suscripción tiene una cancelación programada.
       *
       * Si algo falla se registra y se sigue: la factura simplemente se cobrará
       * por el camino normal de 1h. Este atajo nunca puede tumbar el webhook.
       */
      case 'invoice.created': {
        const invoice = event.data.object;

        // Solo las facturas que hoy nadie cobra a mano.
        //
        // `subscription_update` (upgrades y addons) queda FUERA a propósito:
        // cambiarPlan y comprarAddon ya recuperan la factura y llaman a
        // invoices.pay(). Si este handler la finalizara primero, ese pay()
        // podría fallar por "ya pagada" y el controller devolvería
        // actionRequired:true con el hosted_invoice_url de una factura ya
        // cobrada — el cliente vería "Complete el pago" sin deber nada.
        const RAZONES_COBRO_INMEDIATO = new Set([
          'subscription_cycle', // renovación / fin de trial ← el caso que duele
          'subscription_create', // primera factura de una sub creada por API
        ]);

        if (!RAZONES_COBRO_INMEDIATO.has(invoice.billing_reason)) {
          console.log(
            '[stripe] invoice.created ignorada (billing_reason):',
            invoice.billing_reason,
          );
          break;
        }

        if (invoice.status !== 'draft') {
          console.log(
            '[stripe] invoice.created ya no es draft, skip:',
            invoice.id,
            invoice.status,
          );
          break;
        }

        if (
          invoice.auto_advance !== true ||
          invoice.collection_method !== 'charge_automatically'
        ) {
          console.log('[stripe] invoice.created manual, skip:', invoice.id);
          break;
        }

        const firstLineCreated = invoice.lines?.data?.[0] || null;
        const subscriptionIdCreated =
          invoice.subscription ||
          invoice.parent?.subscription_details?.subscription ||
          firstLineCreated?.parent?.subscription_item_details?.subscription ||
          firstLineCreated?.subscription ||
          null;

        // Cancelación programada → dejar que siga el curso normal de Stripe.
        if (subscriptionIdCreated) {
          try {
            const subCreated = await stripe.subscriptions.retrieve(
              subscriptionIdCreated,
            );
            if (subCreated.cancel_at_period_end) {
              console.log(
                '[stripe] invoice.created con cancelación programada, skip:',
                subscriptionIdCreated,
              );
              break;
            }
          } catch (e) {
            // No poder leer la sub no justifica retrasar el cobro una hora.
            console.log(
              '[stripe] invoice.created: subscriptions.retrieve falló, se finaliza igual:',
              e?.message,
            );
          }
        }

        try {
          const finalizada = await stripe.invoices.finalizeInvoice(invoice.id, {
            auto_advance: true,
          });
          console.log('[stripe] invoice finalizada al instante:', {
            id: finalizada.id,
            status: finalizada.status,
            amount_due: finalizada.amount_due,
            billing_reason: invoice.billing_reason,
          });

          await db.query(
            `INSERT IGNORE INTO transacciones_stripe_chat
             (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
             VALUES (?, ?, ?, ?, NOW(), ?)`,
            {
              replacements: [
                `finalize_${invoice.id}`,
                subscriptionIdCreated || null,
                null,
                `invoice_finalizada_inmediata:${invoice.billing_reason}`,
                invoice.customer || null,
              ],
            },
          );
        } catch (e) {
          // Carrera entre dos entregas del webhook, o Stripe ya la finalizó.
          console.log(
            '[stripe] finalizeInvoice falló (sigue el flujo normal):',
            invoice.id,
            e?.message,
          );
        }

        break;
      }

      /**
       *  Pago exitoso (FUENTE DE VERDAD)
       * - Activa usuario
       * - Actualiza plan/fechas
       * - Sincroniza status/flags de Stripe en columnas nuevas
       * - Inserta transacción idempotente
       * - Aplica UPGRADE solo cuando el prorrateo realmente se pagó (pending_invoice_id)
       * - Marca promo_plan2_used (promo $5) si hubo descuento real (planes 2/3/4) — 1 vez global
       * - Marca free_trial_used SOLO si el plan aplicado es el 2 y realmente hubo trial
       */
      case 'invoice.payment_succeeded': {
        console.log('[stripe] invoice.payment_succeeded');

        const invoice = event.data.object;

        const invoiceTotal = Number(invoice.total || 0); // centavos
        const invoiceAmountPaid = Number(invoice.amount_paid || 0);
        const hasRealCharge = invoiceTotal > 0 && invoiceAmountPaid > 0;

        console.log('[stripe] invoice totals:', {
          id: invoice.id,
          total: invoice.total,
          amount_paid: invoice.amount_paid,
          paid: invoice.paid,
          status: invoice.status,
        });

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

        // Importe real cobrado (en unidades, no centavos). Se guarda para que
        // el dashboard distinga un cobro de verdad de la factura en $0 del
        // trial (subscription_create): ambas disparan este mismo evento.
        const invoiceMonto = invoiceAmountPaid / 100;
        const invoiceMoneda = invoice.currency
          ? String(invoice.currency).toLowerCase()
          : null;
        const invoiceBillingReason = invoice.billing_reason
          ? String(invoice.billing_reason).slice(0, 40)
          : null;

        // 1) Insertar transacción (idempotente)
        try {
          await db.query(
            `INSERT IGNORE INTO transacciones_stripe_chat
              (id_pago, id_suscripcion, id_usuario, estado_suscripcion, monto, moneda, billing_reason, fecha, customer_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            {
              replacements: [
                invoice.id,
                subscriptionId || null,
                null,
                'payment_succeeded',
                invoiceMonto,
                invoiceMoneda,
                invoiceBillingReason,
                customerId || null,
              ],
            },
          );
          console.log('[stripe] transacciones inserted/ignored:', invoice.id);
        } catch (e) {
          if (esColumnaMontoFaltante(e)) {
            // La tabla todavía no tiene la columna monto:
            // registrar igual la transacción como antes para no perderla.
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
              console.log(
                '[stripe] transacciones inserted sin monto (falta migración):',
                invoice.id,
              );
            } catch (e2) {
              console.log('[stripe] transacciones insert failed:', e2?.message);
            }
          } else {
            console.log('[stripe] transacciones insert failed:', e?.message);
          }
        }

        // 2) Resolver id_usuario / plan + fechas + flags Stripe
        let id_usuario = null;

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

        let currentPriceId = null;
        let planRealByPrice = null;
        let addonMap = null;
        let subItemsAll = [];

        let metaSub = {};
        let pendingPlanId = null;
        let pendingChange = null;
        let pendingInvoiceId = null;

        let id_plataforma = null;

        if (subscriptionId) {
          try {
            const subscription = await stripe.subscriptions.retrieve(
              subscriptionId,
              { expand: ['items.data.price'] },
            );

            metaSub = subscription.metadata || {};
            id_usuario = Number(metaSub?.id_usuario) || null;

            id_plataforma = Number(metaSub?.id_plataforma) || null;

            addonMap = await getAddonPriceMap();
            subItemsAll = subscription.items?.data || [];

            // El plan real es el primer item que NO sea un addon
            const planItem =
              subItemsAll.find((it) => !addonMap.has(it.price?.id)) ||
              subItemsAll[0] ||
              null;
            currentPriceId = planItem?.price?.id || null;

            if (currentPriceId) {
              planRealByPrice = await getPlanByPriceId(currentPriceId);
            }

            pendingPlanId = Number(metaSub?.pending_plan_id || 0) || null;
            pendingChange = metaSub?.pending_change || null;
            pendingInvoiceId = metaSub?.pending_invoice_id || null;

            if (subscription.current_period_start)
              start = new Date(subscription.current_period_start * 1000);
            if (periodEndDeSub(subscription))
              end = new Date(periodEndDeSub(subscription) * 1000);
            if (subscription.trial_end)
              trialEnd = new Date(subscription.trial_end * 1000);

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

        if (!id_usuario) {
          id_usuario =
            Number(metaFromParent?.id_usuario || metaFromLine?.id_usuario) ||
            null;
          console.log(
            '[stripe] id_usuario fallback(invoice meta):',
            id_usuario,
          );
        }

        if (!id_plataforma) {
          id_plataforma =
            Number(
              metaFromParent?.id_plataforma || metaFromLine?.id_plataforma,
            ) || null;

          if (id_plataforma) {
            console.log(
              '[stripe] id_plataforma fallback(invoice meta):',
              id_plataforma,
            );
          }
        }

        if (!id_usuario) {
          id_usuario = await resolverIdUsuarioPorStripe(
            subscriptionId,
            customerId,
          );
          if (id_usuario) {
            console.log(
              '[stripe] id_usuario fallback(BD sub/customer):',
              id_usuario,
            );
          }
        }

        if (!id_usuario) {
          console.log(
            '[stripe] WARNING: id_usuario not found. Skipping usuarios_chat_center update.',
          );
          break;
        }

        /**
         * ✅ CAMBIO SOLICITADO (blindaje extra):
         * Si existe UPGRADE pendiente (pending_change + pending_plan_id),
         * pero NO hubo cobro real, NO aplicar el plan por priceId.
         * Esto cubre la carrera donde todavía no existe pending_invoice_id.
         */
        if (pendingChange === 'upgrade' && !!pendingPlanId && !hasRealCharge) {
          console.log(
            '[stripe] IGNORE upgrade without real charge (pending):',
            {
              invoiceId: invoice.id,
              pendingPlanId,
              pendingInvoiceId,
              total: invoice.total,
              amount_paid: invoice.amount_paid,
            },
          );
          break;
        }

        /**
         * ✅ Su guard anterior (se mantiene tal cual)
         */
        if (
          pendingChange === 'upgrade' &&
          !!pendingPlanId &&
          !!pendingInvoiceId &&
          invoice.id === pendingInvoiceId &&
          !hasRealCharge
        ) {
          console.log('[stripe] IGNORE upgrade invoice without real charge:', {
            invoiceId: invoice.id,
            pendingPlanId,
            pendingInvoiceId,
            amount_paid: invoice.amount_paid,
          });
          break;
        }

        // =========
        // Determinar plan a aplicar en BD (igual que usted lo tenía)
        // =========
        const isUpgradeInvoice =
          pendingChange === 'upgrade' &&
          !!pendingPlanId &&
          !!pendingInvoiceId &&
          invoice.id === pendingInvoiceId &&
          hasRealCharge;

        let planToApply = null;

        if (isUpgradeInvoice) {
          planToApply = pendingPlanId;
          console.log(
            '[stripe] applying UPGRADE pending_plan_id (by pending_invoice_id):',
            planToApply,
          );

          try {
            await stripe.subscriptions.update(subscriptionId, {
              metadata: {
                ...(metaSub || {}),
                id_plan: String(pendingPlanId),
                pending_plan_id: '',
                pending_change: '',
                pending_invoice_id: '',
              },
            });
          } catch (e) {
            console.log('[stripe] sub metadata finalize failed:', e?.message);
          }
        } else {
          planToApply = Number(planRealByPrice?.id_plan || 0) || null;
          console.log('[stripe] applying plan by priceId:', planToApply);
        }

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
        // Promo $5: marcar promo_plan2_used SOLO si hubo descuento real (planes 2/3/4)
        // IMPORTANTE: Promo $5: marcar promo_plan2_used SOLO si hubo descuento real en test (planes 16/17/18/20)
        // =========
        const PROMO_PLANS = new Set([2, 3, 4, 6, 16, 17, 18, 20, 22, 23]);

        const totalDiscount = (invoice.total_discount_amounts || []).reduce(
          (acc, d) => acc + (d.amount || 0),
          0,
        );

        const usedCoupon = totalDiscount > 0;
        const shouldMarkPromoUsed =
          PROMO_PLANS.has(Number(planToApply)) && usedCoupon;

        if (shouldMarkPromoUsed) {
          try {
            await db.query(
              `UPDATE usuarios_chat_center
               SET promo_plan2_used = 1
               WHERE id_usuario = ?`,
              { replacements: [id_usuario] },
            );
            console.log(
              '[stripe] promo_plan2_used (promo $5) marked:',
              id_usuario,
            );
          } catch (e) {
            console.log('[stripe] promo_plan2_used update failed:', e?.message);
          }
        }

        // =========
        // Trial: marcar free_trial_used SOLO si:
        // - plan aplicado es 2
        // - y realmente hubo trial en Stripe
        // =========
        const CONEXION_PLAN_ID = Number(
          process.env.STRIPE_PLAN_CONEXION_ID || 2,
        );
        const COMUNIDAD_PLAN_ID = isProd ? 22 : 23;
        const hadTrial = subStatus === 'trialing' || !!trialEnd;
        const isTrialPlan =
          Number(planToApply) === CONEXION_PLAN_ID ||
          Number(planToApply) === COMUNIDAD_PLAN_ID;
        const markTrialUsed = isTrialPlan && hadTrial ? 1 : 0;

        // =========
        // 3) Update usuario: sincronización total
        // ✅ id_costumer / stripe_subscription_id deben SOBRESCRIBIRSE en payment_succeeded (fuente de verdad)
        // =========
        const sqlUserUpdate = `
          UPDATE usuarios_chat_center
          SET id_plan = COALESCE(?, id_plan),
              estado = 'activo',
              fecha_inicio = COALESCE(fecha_inicio, ?),
              fecha_renovacion = ?,
              free_trial_used = GREATEST(free_trial_used, ?)
              ${id_plataforma ? ', id_plataforma = COALESCE(?, id_plataforma)' : ''},
              id_costumer = ?,                -- ✅ SET directo
              stripe_subscription_id = ?,     -- ✅ SET directo
              trial_end = ?,
              stripe_subscription_status = COALESCE(?, stripe_subscription_status),
              cancel_at_period_end = COALESCE(?, cancel_at_period_end),
              cancel_at = COALESCE(?, cancel_at),
              canceled_at = COALESCE(?, canceled_at)
          WHERE id_usuario = ?
        `;

        const userReplacements = id_plataforma
          ? [
              planToApply || null,
              start,
              end,
              markTrialUsed,
              id_plataforma,
              customerId || null,
              subscriptionId || null,
              trialEnd,
              subStatus || null,
              cancelAtPeriodEnd,
              cancelAt,
              canceledAt,
              id_usuario,
            ]
          : [
              planToApply || null,
              start,
              end,
              markTrialUsed,
              customerId || null,
              subscriptionId || null,
              trialEnd,
              subStatus || null,
              cancelAtPeriodEnd,
              cancelAt,
              canceledAt,
              id_usuario,
            ];

        const [updateResult] = await db.query(sqlUserUpdate, {
          replacements: userReplacements,
        });

        console.log(
          '[stripe] usuarios_chat_center update result:',
          updateResult,
        );

        // Sincronizar addons (conexiones/subusuarios) con sus quantities reales en Stripe
        await sincronizarAddons(subItemsAll, addonMap, id_usuario);

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
             SET estado_suscripcion = 'payment_succeeded',
                 id_usuario = COALESCE(id_usuario, ?),
                 id_suscripcion = COALESCE(id_suscripcion, ?),
                 customer_id = COALESCE(customer_id, ?),
                 monto = COALESCE(monto, ?),
                 moneda = COALESCE(moneda, ?),
                 billing_reason = COALESCE(billing_reason, ?)
             WHERE id_pago = ?`,
            {
              replacements: [
                id_usuario,
                subscriptionId || null,
                customerId || null,
                invoiceMonto,
                invoiceMoneda,
                invoiceBillingReason,
                invoice.id,
              ],
            },
          );
          console.log(
            '[stripe] transacciones updated with id_usuario:',
            invoice.id,
          );
        } catch (e) {
          if (esColumnaMontoFaltante(e)) {
            try {
              await db.query(
                `UPDATE transacciones_stripe_chat
                 SET estado_suscripcion = 'payment_succeeded',
                     id_usuario = COALESCE(id_usuario, ?),
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
                '[stripe] transacciones updated sin monto (falta migración):',
                invoice.id,
              );
            } catch (e2) {
              console.log('[stripe] transacciones update failed:', e2?.message);
            }
          } else {
            console.log('[stripe] transacciones update failed:', e?.message);
          }
        }

        // =========
        // 5) Programa de referidos: contar el ciclo y devengar comisión
        //
        // Va al final y con su propio try/catch porque NADA de referidos puede
        // impedir que el pago del cliente se procese. El servicio ya es
        // idempotente (UNIQUE sobre invoice_id) y decide solo si este ciclo
        // comisiona o no: aquí no se replica ninguna regla del programa.
        //
        // NO usa `hasRealCharge`: esa bandera exige cobro en tarjeta, y una
        // factura saldada con el saldo a favor del cliente llega con
        // amount_paid = 0. Con ese criterio, el mes que un referido paga con su
        // propio crédito de referidos no contaría ciclo ni pagaría comisión a
        // quien lo trajo, que no ve ni controla esa decisión.
        //
        // La base es `invoice.total`: lo facturado tras cupones y descuentos,
        // antes de aplicar el saldo. Un cupón sigue bajando la comisión —la
        // regla prometida se mantiene—; lo único que deja de restar es el
        // crédito, que es dinero que la empresa ya le debía al cliente.
        // =========
        const facturaLiquidada = invoiceTotal > 0 && invoice.paid === true;
        if (id_usuario && facturaLiquidada) {
          try {
            await referidosService.devengarPorFactura({
              id_usuario_referido: id_usuario,
              invoiceId: invoice.id,
              subscriptionId,
              montoFacturadoCent: invoiceTotal,
              moneda: invoice.currency || 'usd',
            });
          } catch (e) {
            console.log('[stripe] devengo de referido falló:', e?.message);
          }
        }

        break;
      }

      /**
       * ❌ Pago fallido
       * - Suspende usuario SOLO si el fallo es de la suscripción activa en BD
       * - Si es un upgrade pendiente que falló, revierte al plan original sin suspender
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

        if (!id_usuario) {
          id_usuario = await resolverIdUsuarioPorStripe(
            subscriptionId,
            customerId,
          );
          if (id_usuario) {
            console.log(
              '[stripe] id_usuario fallback(BD sub/customer):',
              id_usuario,
            );
          }
        }

        //  Blindaje: solo suspender si es la suscripción activa del usuario
        if (id_usuario) {
          const activeSubId = await getActiveSubscriptionIdByUser(id_usuario);
          const isActiveSub = !!activeSubId && activeSubId === subscriptionId;

          if (!isActiveSub) {
            console.log(
              '[stripe] IGNORE payment_failed (non-active subscription):',
              {
                id_usuario,
                subscriptionId,
                activeSubId,
              },
            );

            // Igual auditamos la transacción, pero no tocamos estado del usuario
            await db.query(
              `INSERT IGNORE INTO transacciones_stripe_chat
               (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
               VALUES (?, ?, ?, ?, NOW(), ?)`,
              {
                replacements: [
                  invoice.id,
                  subscriptionId || null,
                  id_usuario || null,
                  'payment_failed_ignored_non_active_sub',
                  customerId || null,
                ],
              },
            );

            break;
          }

          // Si ES la activa
          if (isActiveSub) {
            // ─── Verificar si es un upgrade pendiente que falló ───
            let isFailedUpgrade = false;

            try {
              const subForCheck = await stripe.subscriptions.retrieve(
                subscriptionId,
                { expand: ['items.data.price'] },
              );
              const meta = subForCheck.metadata || {};

              if (
                meta.pending_change === 'upgrade' &&
                meta.pending_plan_id &&
                meta.pending_invoice_id === invoice.id
              ) {
                isFailedUpgrade = true;

                // Obtener el price del plan original para revertir en Stripe
                const [[origPlan]] = await db.query(
                  `SELECT p.id_price
                   FROM usuarios_chat_center u
                   JOIN planes_chat_center p ON p.id_plan = u.id_plan
                   WHERE u.id_usuario = ?
                   LIMIT 1`,
                  { replacements: [id_usuario] },
                );

                const addonMapRb = await getAddonPriceMap();
                const subItem =
                  subForCheck.items?.data?.find(
                    (it) => !addonMapRb.has(it.price?.id),
                  ) || subForCheck.items?.data?.[0];

                if (origPlan?.id_price && subItem?.id) {
                  // Revertir suscripción en Stripe al plan/precio original
                  await stripe.subscriptions.update(subscriptionId, {
                    items: [{ id: subItem.id, price: origPlan.id_price }],
                    proration_behavior: 'none',
                    payment_behavior: 'allow_incomplete',
                    metadata: {
                      ...meta,
                      id_plan: meta.id_plan || '',
                      pending_plan_id: '',
                      pending_change: '',
                      pending_invoice_id: '',
                    },
                  });
                  console.log(
                    '[stripe] ROLLBACK upgrade: reverted to price',
                    origPlan.id_price,
                  );
                }

                // Limpiar SOLO pending_* en BD — no tocar estado, plan, trial, promo, nada más
                await db.query(
                  `UPDATE usuarios_chat_center
                   SET pending_plan_id = NULL,
                       pending_change = NULL,
                       pending_effective_at = NULL
                   WHERE id_usuario = ?`,
                  { replacements: [id_usuario] },
                );

                // Auditar
                await db
                  .query(
                    `INSERT IGNORE INTO transacciones_stripe_chat
                   (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
                   VALUES (?, ?, ?, ?, NOW(), ?)`,
                    {
                      replacements: [
                        `upgrade_rollback_${subscriptionId}_${invoice.id}`,
                        subscriptionId,
                        id_usuario,
                        `upgrade_rollback:${meta.pending_plan_id}`,
                        customerId || null,
                      ],
                    },
                  )
                  .catch(() => {});

                console.log(
                  '[stripe] Upgrade rollback complete for user:',
                  id_usuario,
                );
              }
            } catch (e) {
              console.log(
                '[stripe] upgrade rollback check failed:',
                e?.message,
              );
            }

            // No suspender si la suscripción SIGUE vigente en Stripe.
            const subVigente =
              subStatus === 'trialing' || subStatus === 'active';

            if (subVigente) {
              console.log(
                '[stripe] IGNORE payment_failed (suscripción vigente en Stripe):',
                {
                  id_usuario,
                  subscriptionId,
                  subStatus,
                  invoiceId: invoice.id,
                },
              );

              // Sincronizar flags sin tocar el estado de acceso.
              await db.query(
                `UPDATE usuarios_chat_center
                 SET stripe_subscription_status = COALESCE(?, stripe_subscription_status),
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

            // Solo suspender si NO fue un upgrade fallido
            if (!isFailedUpgrade && !subVigente) {
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
          }
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
       * ✅ Blindaje: NO cancelar usuario si el evento corresponde a una suscripción que NO es la activa en BD.
       */
      case 'customer.subscription.updated': {
        const sub = event.data.object;

        const subscriptionId = sub.id || null;
        const customerId = sub.customer || null;

        let id_usuario = Number(sub.metadata?.id_usuario) || null;
        if (!id_usuario) {
          id_usuario = await resolverIdUsuarioPorStripe(
            subscriptionId,
            customerId,
          );
          if (id_usuario) {
            console.log(
              '[stripe] id_usuario fallback(BD sub/customer):',
              id_usuario,
            );
          }
        }

        const cancelAtPeriodEnd = sub.cancel_at_period_end ? 1 : 0;
        const cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000) : null;
        const canceledAt = sub.canceled_at
          ? new Date(sub.canceled_at * 1000)
          : null;

        const currentPeriodEnd = periodEndDeSub(sub)
          ? new Date(periodEndDeSub(sub) * 1000)
          : null;

        const status = sub.status || null;

        // El trial también cambia por este evento (extensión desde el
        // dashboard, Thrive, etc.). Antes no se sincronizaba y la BD se quedaba
        // con el trial_end viejo: el login mandaba a /planes y checkPlanActivo
        // bloqueaba al vencer la gracia aunque en Stripe el trial siguiera vivo.
        // En trial, la "renovación" es el fin del trial (primer cobro).
        const trialEndUpd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
        const fechaRenovacionUpd =
          status === 'trialing' && trialEndUpd ? trialEndUpd : currentPeriodEnd;

        const addonMapUpd = await getAddonPriceMap();
        const allItemsUpd = sub.items?.data || [];

        // El plan real es el primer item que NO sea un addon
        const planItemUpd =
          allItemsUpd.find((it) => !addonMapUpd.has(it.price?.id)) ||
          allItemsUpd[0] ||
          null;
        const currentPriceId = planItemUpd?.price?.id || null;

        let planRealByPrice = null;
        if (currentPriceId) {
          try {
            planRealByPrice = await getPlanByPriceId(currentPriceId);
          } catch (e) {
            console.log('[stripe] getPlanByPriceId failed:', e?.message);
          }
        }
        const planRealId = Number(planRealByPrice?.id_plan || 0) || null;

        // ⚠️ El pending_* se programa en el SCHEDULE y Stripe NO lo propaga a la
        // metadata de la SUB al avanzar de fase. La fuente de verdad es la BD.
        let pendingPlanIdDb = null;
        let pendingChangeDb = null;
        if (id_usuario) {
          try {
            const [[urow]] = await db.query(
              `SELECT pending_plan_id, pending_change
               FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
              { replacements: [id_usuario] },
            );
            pendingPlanIdDb = Number(urow?.pending_plan_id || 0) || null;
            pendingChangeDb = urow?.pending_change || null;
          } catch (e) {
            console.log('[stripe] read pending from DB failed:', e?.message);
          }
        }

        const pendingPlanId =
          pendingPlanIdDb || Number(sub.metadata?.pending_plan_id || 0) || null;
        const pendingChange =
          pendingChangeDb || sub.metadata?.pending_change || null;

        const shouldApplyDowngradeNow =
          pendingChange === 'downgrade' &&
          !!pendingPlanId &&
          !!planRealId &&
          planRealId === pendingPlanId;

        const isDowngradePending =
          pendingChange === 'downgrade' && !!pendingPlanId;

        const idPlanToWrite =
          isDowngradePending && !shouldApplyDowngradeNow
            ? null
            : planRealId || Number(sub.metadata?.id_plan) || null;

        // Leer la sub activa guardada (blindaje)
        let activeSubId = null;
        let isActiveSub = false;
        if (id_usuario) {
          activeSubId = await getActiveSubscriptionIdByUser(id_usuario);
          isActiveSub = !!activeSubId && activeSubId === subscriptionId;
        }

        const isUpgradePending = pendingChange === 'upgrade' && !!pendingPlanId;

        if (id_usuario) {
          /**
           * Si hay UPGRADE pendiente, NO escribir id_plan aquí (customer.subscription.updated),
           * porque Stripe dispara este evento al cambiar el price aunque aún no se haya pagado.
           * Se siguen sincronizando flags/fechas/status normalmente.
           */
          if (isUpgradePending) {
            await db.query(
              `UPDATE usuarios_chat_center
               SET id_costumer = COALESCE(?, id_costumer),
                   stripe_subscription_id = COALESCE(?, stripe_subscription_id),
                   fecha_renovacion = COALESCE(?, fecha_renovacion),
                   trial_end = COALESCE(?, trial_end),
                   stripe_subscription_status = ?,
                   cancel_at_period_end = ?,
                   cancel_at = ?,
                   canceled_at = ?
               WHERE id_usuario = ?`,
              {
                replacements: [
                  customerId || null,
                  subscriptionId || null,
                  fechaRenovacionUpd,
                  trialEndUpd,
                  status,
                  cancelAtPeriodEnd,
                  cancelAt,
                  canceledAt,
                  id_usuario,
                ],
              },
            );

            console.log('[stripe] IGNORE id_plan update (upgrade pending):', {
              id_usuario,
              subscriptionId,
              pendingPlanId,
            });
          } else {
            // Mantener  UPDATE original cuando NO es upgrade pendiente
            await db.query(
              `UPDATE usuarios_chat_center
               SET id_plan = COALESCE(?, id_plan),
                   id_costumer = COALESCE(?, id_costumer),
                   stripe_subscription_id = COALESCE(?, stripe_subscription_id),
                   fecha_renovacion = COALESCE(?, fecha_renovacion),
                   trial_end = COALESCE(?, trial_end),
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
                  fechaRenovacionUpd,
                  trialEndUpd,
                  status,
                  cancelAtPeriodEnd,
                  cancelAt,
                  canceledAt,
                  id_usuario,
                ],
              },
            );
          }

          // Si checkPlanActivo ya lo había marcado 'vencido' (marca pegajosa)
          // pero Stripe dice que sigue en trial/activo con fecha por delante,
          // se le devuelve el acceso: el vencimiento era del dato viejo.
          if (
            (status === 'trialing' || status === 'active') &&
            fechaRenovacionUpd &&
            fechaRenovacionUpd.getTime() > Date.now()
          ) {
            await db.query(
              `UPDATE usuarios_chat_center
               SET estado = 'activo'
               WHERE id_usuario = ? AND estado = 'vencido'`,
              { replacements: [id_usuario] },
            );
          }

          //  Solo cancelar usuario si el evento es de SU suscripción activa
          if (status === 'canceled' || sub.ended_at) {
            if (!isActiveSub) {
              console.log(
                '[stripe] IGNORE subscription_canceled (non-active subscription):',
                {
                  id_usuario,
                  subscriptionId,
                  activeSubId,
                  status,
                },
              );
            } else {
              await db.query(
                `UPDATE usuarios_chat_center
                 SET estado = 'cancelado'
                 WHERE id_usuario = ?`,
                { replacements: [id_usuario] },
              );
            }
          }
        }

        if (shouldApplyDowngradeNow && id_usuario) {
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

          // Suspender las conexiones que el cliente eligió al programar el downgrade
          try {
            // Los ids se leen ANTES del UPDATE: la propia sentencia limpia
            // pending_suspension, así que después ya no se sabe a cuáles pegó
            // y no se podrían auditar.
            const conexionesASuspender = await db.query(
              `SELECT id FROM configuraciones
                WHERE id_usuario = ? AND pending_suspension = 1`,
              { replacements: [id_usuario], type: db.QueryTypes.SELECT },
            );

            const [resSusp] = await db.query(
              `UPDATE configuraciones
               SET suspendido = 1,
                   suspended_at = NOW(),
                   suspended_reason = 'downgrade',
                   suspended_by_cliente = 1,
                   pending_suspension = 0
               WHERE id_usuario = ? AND pending_suspension = 1`,
              { replacements: [id_usuario] },
            );
            console.log(
              '[stripe] downgrade suspendió conexiones:',
              resSusp?.affectedRows,
            );

            for (const c of conexionesASuspender) {
              await auditarDesdeSistema({
                id_configuracion: c.id,
                id_usuario,
                accion: 'suspender',
                origen: 'stripe_downgrade',
                motivo: 'downgrade',
                detalle: `sub ${subscriptionId || '-'} → plan ${pendingPlanId}`,
              });
            }
          } catch (e) {
            console.log('[stripe] downgrade suspend failed:', e?.message);
          }

          // Suspender los subusuarios que el cliente eligió al programar el downgrade
          try {
            const [resSub] = await db.query(
              `UPDATE sub_usuarios_chat_center
               SET suspendido = 1,
                   suspended_at = NOW(),
                   suspended_reason = 'downgrade',
                   suspended_by_cliente = 1,
                   pending_suspension = 0
               WHERE id_usuario = ? AND pending_suspension = 1`,
              { replacements: [id_usuario] },
            );
            console.log(
              '[stripe] downgrade suspendió subusuarios:',
              resSub?.affectedRows,
            );
          } catch (e) {
            console.log(
              '[stripe] downgrade suspend subusuarios failed:',
              e?.message,
            );
          }

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

        const estadoTx =
          status === 'canceled' || sub.ended_at
            ? isActiveSub
              ? 'subscription_canceled'
              : 'subscription_canceled_ignored_non_active_sub'
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

      /**
       * 💸 Reembolso — revierte la comisión de referido de esa factura
       *
       * Sin esto se paga comisión sobre dinero que después se devuelve, y
       * recuperarla de un referidor ya liquidado no ocurre nunca. El servicio
       * decide qué hacer según el estado: si aún no se pagó la marca revertida,
       * y si ya se pagó crea un ajuste negativo que se descuenta de lo que ese
       * referidor gane más adelante.
       *
       * Solo se revierte en el reembolso TOTAL. En uno parcial el referido sí
       * se quedó con servicio y el referidor con su parte; recalcular
       * proporcionalmente cuesta más de lo que corrige.
       */
      case 'charge.refunded': {
        const charge = event.data.object;
        const invoiceId = charge.invoice || null;
        const totalReembolsado = Number(charge.amount_refunded || 0);
        const totalCobrado = Number(charge.amount || 0);

        if (invoiceId && totalReembolsado >= totalCobrado && totalCobrado > 0) {
          await referidosService.revertirPorFactura(invoiceId, 'reembolso');
        }
        break;
      }

      /**
       * ⚠️ Contracargo — misma lógica que el reembolso.
       * Se revierte al ABRIRSE la disputa, no al perderla: el dinero ya salió
       * de la cuenta en ese momento.
       */
      case 'charge.dispute.created': {
        const dispute = event.data.object;
        let invoiceId = null;
        try {
          if (dispute.charge) {
            const charge = await stripe.charges.retrieve(dispute.charge);
            invoiceId = charge?.invoice || null;
          }
        } catch (e) {
          console.log('[stripe] no se pudo resolver el charge de la disputa:', e?.message);
        }
        if (invoiceId) {
          await referidosService.revertirPorFactura(invoiceId, 'contracargo');
        }
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
