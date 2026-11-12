'use strict';

/**
 * services/acceso_permanente.service.js
 *
 * Acceso permanente (plan gratuito sin vencimiento) para cuentas del equipo y
 * cortesías. Antes se hacía con SQL a mano sobre usuarios_chat_center.
 *
 * permanente = 1 hace que checkPlanActivo, checkToolAccess, espiaAcceso y
 * planAcceso (bot) dejen pasar sin mirar fechas ni Stripe, y que el login
 * mande directo a /conexiones sin ofrecer planes. El id_plan sigue siendo
 * obligatorio porque limiteConexiones y limiteSub_usuarios sacan de él los
 * cupos base.
 *
 * Si la cuenta tiene una suscripción viva en Stripe, el permanente por sí
 * solo NO frena los cobros: por eso `cancelar_stripe` la cancela de inmediato
 * (sin prorrateo ni factura final) y anula sus facturas abiertas para que
 * Stripe no reintente. Se marca permanente ANTES de cancelar: el
 * customer.subscription.deleted que dispara la cancelación cae en
 * stripe_baja.service, que a un permanente le conserva el estado.
 *
 * Lo usan el panel (controllers/admin_usuarios.controller.js, solo super
 * admin) y scripts/darAccesoPermanente.js. El cliente de Stripe lo pone quien
 * llama: el panel usa la llave del entorno (test en local, live en
 * producción); el script exige la live porque las suscripciones de los
 * clientes viven ahí.
 */

const { db } = require('../database/config');
const { invalidarAccesoCache } = require('../utils/planAcceso');

// Avanzado: el plan base de las cuentas permanentes de Imporfactory.
const PLAN_PERMANENTE_POR_DEFECTO = 4;

// Estados de Stripe en los que una sub todavía puede generar cobros.
const SUB_VIVA = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
]);

const q = (sql, replacements = []) =>
  db.query(sql, { replacements, type: db.QueryTypes.SELECT });

async function leerUsuario(id_usuario) {
  const rows = await q(
    `SELECT id_usuario, nombre, email_propietario, id_plan, permanente, estado,
            fecha_renovacion, stripe_subscription_id, stripe_subscription_status,
            cancel_at_period_end, id_costumer
       FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
    [id_usuario],
  );
  return rows?.[0] || null;
}

async function leerPlan(id_plan) {
  const rows = await q(
    `SELECT id_plan, nombre_plan, activo, max_conexiones, max_subusuarios,
            id_price, precio_plan
       FROM planes_chat_center WHERE id_plan = ? LIMIT 1`,
    [id_plan],
  );
  return rows?.[0] || null;
}

const subViva = (usuario) =>
  !!usuario?.stripe_subscription_id &&
  SUB_VIVA.has(String(usuario.stripe_subscription_status || '').toLowerCase());

/**
 * Deja constancia en la pestaña Seguimientos del panel de usuarios: así el
 * equipo ve quién regaló el acceso o subió los cupos y cuándo. Nunca tumba
 * la operación principal.
 */
async function anotarSeguimiento(id_usuario, ejecutor, asunto, contenido) {
  try {
    await db.query(
      `INSERT INTO seguimiento_clientes_chat_center
         (id_usuario, tipo, resultado, asunto, contenido,
          ejecutado_por_id, ejecutado_por_nombre, fecha_seguimiento)
       VALUES (?, 'nota_interna', 'sin_resultado', ?, ?, ?, ?, NOW())`,
      {
        replacements: [
          id_usuario,
          asunto,
          contenido,
          ejecutor?.id || null,
          ejecutor?.nombre || 'sistema',
        ],
      },
    );
  } catch (e) {
    console.warn(
      `[acceso_permanente] no se pudo anotar el seguimiento de ${id_usuario}:`,
      e?.message,
    );
  }
}

/** El bot cachea 60 s si una configuración puede automatizar. */
async function invalidarCacheDeLaCuenta(id_usuario) {
  const cfgs = await q(`SELECT id FROM configuraciones WHERE id_usuario = ?`, [
    id_usuario,
  ]);
  for (const c of cfgs || []) invalidarAccesoCache(c.id);
}

/**
 * Cancela YA la suscripción en Stripe y anula sus facturas abiertas (si una
 * queda open, Stripe la sigue reintentando aunque la sub esté muerta).
 * Sin prorrateo ni factura final: la cuenta pasa a permanente, no se le
 * devuelve ni se le cobra nada.
 */
async function cancelarSuscripcionStripe(stripe, subId) {
  const sub = await stripe.subscriptions.retrieve(subId);
  if (!SUB_VIVA.has(sub.status)) {
    return { cancelada: false, status: sub.status, facturas_anuladas: 0 };
  }

  let anuladas = 0;
  for (const status of ['open', 'draft']) {
    const list = await stripe.invoices.list({
      subscription: subId,
      status,
      limit: 20,
    });
    for (const inv of list?.data || []) {
      if (inv.status === 'draft') await stripe.invoices.del(inv.id);
      else await stripe.invoices.voidInvoice(inv.id);
      anuladas += 1;
    }
  }

  const out = await stripe.subscriptions.cancel(subId, {
    invoice_now: false,
    prorate: false,
  });
  return { cancelada: true, status: out.status, facturas_anuladas: anuladas };
}

/**
 * Activa (o re-configura) el acceso permanente.
 *
 * @param {object} p
 * @param {number} p.id_usuario
 * @param {number} [p.id_plan]          plan base; si falta, el actual o Avanzado
 * @param {boolean} [p.cancelar_stripe] cancelar la sub viva de Stripe
 * @param {import('stripe')} [p.stripe] cliente de Stripe (obligatorio si cancelar_stripe)
 * @param {{id:number|null,nombre:string}} p.ejecutor
 * @param {boolean} [p.aplicar=true]    false = solo decide, no escribe
 * @returns {Promise<{antes, plan, ya_era:boolean, stripe:object|null, stripe_error:string|null, asunto:string, contenido:string}>}
 */
async function activarAccesoPermanente({
  id_usuario,
  id_plan,
  cancelar_stripe = false,
  stripe = null,
  ejecutor,
  aplicar = true,
}) {
  const antes = await leerUsuario(id_usuario);
  if (!antes)
    throw Object.assign(new Error('Usuario no encontrado'), {
      statusCode: 404,
    });

  const idPlanFinal =
    Number(id_plan) || Number(antes.id_plan) || PLAN_PERMANENTE_POR_DEFECTO;
  const plan = await leerPlan(idPlanFinal);
  if (!plan || Number(plan.activo) !== 1) {
    throw Object.assign(
      new Error('El plan elegido no existe o está inactivo'),
      {
        statusCode: 400,
      },
    );
  }

  const yaEra = Number(antes.permanente) === 1;
  const mismoPlan = Number(antes.id_plan) === Number(plan.id_plan);
  const cancelar = cancelar_stripe && subViva(antes);

  const resultado = {
    antes,
    plan,
    ya_era: yaEra,
    cancelar_stripe: cancelar,
    stripe: null,
    stripe_error: null,
    asunto: '',
    contenido: '',
  };

  if (!aplicar) return resultado;

  await db.query(
    `UPDATE usuarios_chat_center
        SET permanente = 1,
            estado = 'activo',
            id_plan = ?,
            fecha_inicio = COALESCE(fecha_inicio, NOW()),
            updated_at = NOW()
      WHERE id_usuario = ?`,
    { replacements: [plan.id_plan, id_usuario] },
  );

  if (cancelar) {
    if (!stripe) {
      resultado.stripe_error = 'Sin cliente de Stripe configurado';
    } else {
      try {
        resultado.stripe = await cancelarSuscripcionStripe(
          stripe,
          antes.stripe_subscription_id,
        );
        await db.query(
          `UPDATE usuarios_chat_center
              SET stripe_subscription_status = 'canceled',
                  cancel_at_period_end = 0,
                  cancel_at = NULL,
                  canceled_at = COALESCE(canceled_at, NOW()),
                  updated_at = NOW()
            WHERE id_usuario = ?`,
          { replacements: [id_usuario] },
        );
      } catch (e) {
        resultado.stripe_error = e?.message || String(e);
      }
    }
  }

  await invalidarCacheDeLaCuenta(id_usuario);

  // Nota para Seguimientos.
  const partes = [];
  if (!yaEra) {
    partes.push(
      `${ejecutor.nombre} activó el acceso permanente (sin cobro ni vencimiento) con el plan ${plan.nombre_plan}.`,
    );
    resultado.asunto = 'Acceso permanente activado';
  } else if (!mismoPlan) {
    partes.push(
      `${ejecutor.nombre} cambió el plan de la cuenta permanente a ${plan.nombre_plan}.`,
    );
    resultado.asunto = 'Plan permanente: cambio de plan';
  } else {
    resultado.asunto = 'Cuenta permanente';
  }

  if (resultado.stripe?.cancelada) {
    partes.push(
      `Canceló la suscripción de Stripe ${antes.stripe_subscription_id}` +
        (resultado.stripe.facturas_anuladas
          ? ` y anuló ${resultado.stripe.facturas_anuladas} factura(s) pendiente(s)`
          : '') +
        ': no se le cobra más.',
    );
    if (yaEra && mismoPlan)
      resultado.asunto = 'Suscripción de Stripe cancelada';
  } else if (resultado.stripe && !resultado.stripe.cancelada) {
    partes.push(
      `La suscripción de Stripe ya estaba en estado ${resultado.stripe.status}; no había nada que cancelar.`,
    );
  } else if (resultado.stripe_error) {
    partes.push(
      `No se pudo cancelar la suscripción de Stripe ${antes.stripe_subscription_id}: ${resultado.stripe_error}. Se le seguirá cobrando hasta cancelarla.`,
    );
  } else if (subViva(antes)) {
    partes.push(
      'La cuenta tiene una suscripción viva en Stripe: se le seguirá cobrando hasta cancelarla.',
    );
  }

  resultado.contenido = partes.join(' ');
  if (resultado.contenido) {
    await anotarSeguimiento(
      id_usuario,
      ejecutor,
      resultado.asunto,
      resultado.contenido,
    );
    console.log(
      `[acceso_permanente] ${resultado.contenido} (cuenta ${id_usuario})`,
    );
  }
  return resultado;
}

/**
 * Quita el acceso permanente: vuelven las reglas normales. Sin suscripción
 * en Stripe se vence hoy (fecha_renovacion = NOW()) para que al entrar pase
 * por /planes; con suscripción, Stripe manda y no se toca nada más.
 */
async function quitarAccesoPermanente({ id_usuario, ejecutor }) {
  const antes = await leerUsuario(id_usuario);
  if (!antes)
    throw Object.assign(new Error('Usuario no encontrado'), {
      statusCode: 404,
    });
  if (Number(antes.permanente) !== 1) {
    throw Object.assign(new Error('La cuenta no es permanente'), {
      statusCode: 400,
    });
  }

  const conStripe = !!antes.stripe_subscription_id;
  await db.query(
    conStripe
      ? `UPDATE usuarios_chat_center SET permanente = 0, updated_at = NOW()
          WHERE id_usuario = ?`
      : `UPDATE usuarios_chat_center
            SET permanente = 0, fecha_renovacion = NOW(), updated_at = NOW()
          WHERE id_usuario = ?`,
    { replacements: [id_usuario] },
  );

  await invalidarCacheDeLaCuenta(id_usuario);

  const asunto = 'Acceso permanente retirado';
  const contenido = conStripe
    ? `${ejecutor.nombre} quitó el acceso permanente; la cuenta sigue por su suscripción de Stripe.`
    : `${ejecutor.nombre} quitó el acceso permanente; la cuenta queda vencida y debe elegir un plan.`;
  await anotarSeguimiento(id_usuario, ejecutor, asunto, contenido);
  console.log(`[acceso_permanente] ${contenido} (cuenta ${id_usuario})`);

  return { antes, asunto, contenido };
}

/* ══════════════════════════════════════════════════════════════
   Suscripción de cortesía: N meses gratis y luego cobro mensual.

   Para los que llegan con meses gratis (Imporsuit: 3 meses) o a quien se le
   quiere cambiar el producto sin cobrarle ahora. A diferencia del permanente,
   aquí SÍ se crea una suscripción real en Stripe, con trial de N meses y la
   misma metadata que el checkout ({id_usuario, id_plan, periodo}), así el
   webhook la recibe como cualquier otra: la factura en $0 del trial
   (invoice.payment_succeeded, subscription_create) apunta la BD a la sub, y
   al terminar el trial Stripe cobra el plan mes a mes con la tarjeta
   guardada. Si no hay tarjeta, al mes N+1 la factura queda pendiente y el
   flujo normal de pago fallido suspende la cuenta.

   La sub viva anterior (otro producto) se cancela sin prorrateo y se anulan
   las facturas abiertas del customer: son deudas del plan viejo que no se
   van a cobrar.
   ══════════════════════════════════════════════════════════════ */

const MAX_MESES_CORTESIA = 12;

const fechaMasMeses = (meses, desde = new Date()) => {
  const d = new Date(desde);
  d.setMonth(d.getMonth() + meses);
  return d;
};

async function tarjetaDelCustomer(stripe, customerId) {
  const cust = await stripe.customers.retrieve(customerId);
  if (cust?.deleted) return { customer: null, tarjeta: null };
  const pms = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
    limit: 10,
  });
  const lista = pms?.data || [];
  const porDefecto = cust?.invoice_settings?.default_payment_method;
  const pm =
    lista.find((p) => p.id === porDefecto) ||
    lista.sort((a, b) => (b.created || 0) - (a.created || 0))[0] ||
    null;
  return {
    customer: cust,
    tarjeta: pm
      ? {
          id: pm.id,
          marca: pm.card?.brand,
          ultimos4: pm.card?.last4,
          vence: `${pm.card?.exp_month}/${pm.card?.exp_year}`,
        }
      : null,
  };
}

async function facturasAbiertasDelCustomer(stripe, customerId) {
  const list = await stripe.invoices.list({
    customer: customerId,
    status: 'open',
    limit: 50,
  });
  return list?.data || [];
}

/**
 * @param {object} p
 * @param {import('stripe')} p.stripe  cliente de Stripe (live en producción)
 * @param {number} p.id_usuario
 * @param {number} p.id_plan           plan a dar (debe tener id_price)
 * @param {number} p.meses             meses gratis (1..12)
 * @param {{id:number|null,nombre:string}} p.ejecutor
 * @param {boolean} [p.aplicar=true]   false = solo decide, no escribe
 */
async function crearSuscripcionCortesia({
  stripe,
  id_usuario,
  id_plan,
  meses,
  ejecutor,
  aplicar = true,
}) {
  const fail = (msg, code = 400) =>
    Object.assign(new Error(msg), { statusCode: code });

  if (!stripe) throw fail('Sin cliente de Stripe configurado', 500);
  const n = parseInt(meses, 10);
  if (!n || n < 1 || n > MAX_MESES_CORTESIA) {
    throw fail(`meses debe estar entre 1 y ${MAX_MESES_CORTESIA}`);
  }

  const antes = await leerUsuario(id_usuario);
  if (!antes) throw fail('Usuario no encontrado', 404);
  const plan = await leerPlan(Number(id_plan));
  if (!plan || Number(plan.activo) !== 1) {
    throw fail('El plan elegido no existe o está inactivo');
  }
  if (!plan.id_price) throw fail('El plan no tiene id_price en Stripe');

  // Customer: el que ya tiene; si nunca pasó por el checkout, por correo o nuevo.
  let customerId = antes.id_costumer || null;
  if (!customerId) {
    const existentes = await stripe.customers.list({
      email: antes.email_propietario,
      limit: 1,
    });
    customerId = existentes?.data?.[0]?.id || null;
  }

  const { customer, tarjeta } = customerId
    ? await tarjetaDelCustomer(stripe, customerId)
    : { customer: null, tarjeta: null };
  if (customerId && !customer) customerId = null; // customer borrado en Stripe

  const abiertas = customerId
    ? await facturasAbiertasDelCustomer(stripe, customerId)
    : [];
  const cancelarAnterior = subViva(antes);
  const trialEnd = fechaMasMeses(n);

  const resultado = {
    antes,
    plan,
    meses: n,
    trial_end: trialEnd,
    customer_id: customerId,
    tarjeta,
    cancelar_anterior: cancelarAnterior ? antes.stripe_subscription_id : null,
    facturas_a_anular: abiertas.map((i) => ({
      id: i.id,
      monto: (i.amount_due || 0) / 100,
    })),
    sub: null,
    asunto: '',
    contenido: '',
  };
  if (!aplicar) return resultado;

  if (!customerId) {
    const nuevo = await stripe.customers.create({
      name: antes.nombre,
      email: antes.email_propietario,
      metadata: { id_usuario: String(id_usuario) },
    });
    customerId = nuevo.id;
    resultado.customer_id = customerId;
  }

  // 1) Sub viva anterior: muere sin prorrateo (y sus facturas abiertas).
  let anteriorCancelada = null;
  if (cancelarAnterior) {
    anteriorCancelada = await cancelarSuscripcionStripe(
      stripe,
      antes.stripe_subscription_id,
    );
  }

  // 2) Deudas viejas del customer: no se cobran.
  let anuladas = 0;
  for (const inv of await facturasAbiertasDelCustomer(stripe, customerId)) {
    await stripe.invoices.voidInvoice(inv.id);
    anuladas += 1;
  }

  // 3) La suscripción nueva, con la misma metadata que el checkout.
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: plan.id_price, quantity: 1 }],
    trial_end: Math.floor(trialEnd.getTime() / 1000),
    ...(tarjeta ? { default_payment_method: tarjeta.id } : {}),
    proration_behavior: 'none',
    metadata: {
      id_usuario: String(id_usuario),
      id_plan: String(plan.id_plan),
      id_plataforma: '',
      periodo: 'mensual',
      cortesia_meses: String(n),
      origen: 'panel_admin',
    },
  });
  resultado.sub = { id: sub.id, status: sub.status };

  // 4) BD como la dejaría el webhook (que llegará después y escribirá lo mismo).
  await db.query(
    `UPDATE usuarios_chat_center
        SET id_costumer = ?,
            stripe_subscription_id = ?,
            stripe_subscription_status = ?,
            id_plan = ?,
            estado = 'activo',
            tipo_plan = 'mensual',
            periodo_pago = 'mensual',
            trial_end = ?,
            fecha_renovacion = ?,
            fecha_inicio = COALESCE(fecha_inicio, NOW()),
            cancel_at_period_end = 0,
            cancel_at = NULL,
            canceled_at = NULL,
            pending_plan_id = NULL,
            pending_change = NULL,
            pending_effective_at = NULL,
            updated_at = NOW()
      WHERE id_usuario = ?`,
    {
      replacements: [
        customerId,
        sub.id,
        sub.status,
        plan.id_plan,
        trialEnd,
        trialEnd,
        id_usuario,
      ],
    },
  );

  try {
    await db.query(
      `INSERT IGNORE INTO transacciones_stripe_chat
         (id_pago, id_suscripcion, id_usuario, estado_suscripcion, fecha, customer_id)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      {
        replacements: [
          `cortesia_${sub.id}`,
          sub.id,
          id_usuario,
          `suscripcion_cortesia_${n}_meses`,
          customerId,
        ],
      },
    );
  } catch (e) {
    console.warn('[acceso_permanente] auditoría cortesía:', e?.message);
  }

  await invalidarCacheDeLaCuenta(id_usuario);

  const fechaTxt = trialEnd.toISOString().slice(0, 10);
  const partes = [
    `${ejecutor.nombre} creó una suscripción de cortesía: ${plan.nombre_plan}, ${n} mes(es) gratis hasta el ${fechaTxt}; desde ahí Stripe cobra $${Number(plan.precio_plan || 0).toFixed(2)}/mes` +
      (tarjeta
        ? ` con la tarjeta ${tarjeta.marca} ${tarjeta.ultimos4}.`
        : '. Sin tarjeta guardada: ese primer cobro quedará pendiente hasta que la registre.'),
  ];
  if (anteriorCancelada?.cancelada) {
    partes.push(
      `Canceló la suscripción anterior ${antes.stripe_subscription_id} (${antes.stripe_subscription_status}).`,
    );
  }
  if (anuladas)
    partes.push(`Anuló ${anuladas} factura(s) abierta(s) del plan viejo.`);
  if (Number(antes.permanente) === 1) {
    partes.push(
      'La cuenta sigue marcada como permanente: mientras lo esté, no se le pide pago aunque la sub cobre.',
    );
  }

  resultado.asunto = `Cortesía: ${n} mes(es) gratis de ${plan.nombre_plan}`;
  resultado.contenido = partes.join(' ');
  await anotarSeguimiento(
    id_usuario,
    ejecutor,
    resultado.asunto,
    resultado.contenido,
  );
  console.log(
    `[acceso_permanente] ${resultado.contenido} (cuenta ${id_usuario})`,
  );
  return resultado;
}

module.exports = {
  PLAN_PERMANENTE_POR_DEFECTO,
  MAX_MESES_CORTESIA,
  SUB_VIVA,
  subViva,
  leerUsuario,
  anotarSeguimiento,
  invalidarCacheDeLaCuenta,
  cancelarSuscripcionStripe,
  tarjetaDelCustomer,
  activarAccesoPermanente,
  quitarAccesoPermanente,
  crearSuscripcionCortesia,
};
