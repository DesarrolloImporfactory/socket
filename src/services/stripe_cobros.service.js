const Stripe = require('stripe');
const { db } = require('../database/config');

/**
 * Cobros reales de la cuenta Stripe de la plataforma, leídos de la API.
 * La tabla transacciones_stripe_chat no guarda monto de los fallidos, ni
 * reembolsos ni comisiones: aquí Stripe es la fuente de verdad.
 *
 * Además de los cobros del rango, devuelve dos alertas que no dependen del
 * rango y que ya costaron dinero (incidente del 12-10-2026, diez clientes
 * con dos suscripciones y $150 cobrados dos veces):
 *  - clientes con 2+ suscripciones vivas a la vez;
 *  - facturas abiertas cuya suscripción ya está cancelada (deuda muerta que
 *    ensucia el "pendiente de cobro" y que Stripe puede reintentar).
 */

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : (process.env.STRIPE_SECRET_KEY_TEST ?? process.env.STRIPE_SECRET_KEY);

const stripe = new Stripe(STRIPE_SECRET || '', { apiVersion: '2024-06-20' });
const MODO = String(STRIPE_SECRET || '').startsWith('sk_live_') ? 'live' : 'test';

const TZ = '-05:00'; // America/Guayaquil, igual que el resto del dashboard
const MAX_CHARGES = 5000;
const MAX_DIAS = 366;
const TRAMOS = 12;
const CACHE_MS = 5 * 60 * 1000;
const _cache = new Map();
const _productos = new Map(); // id → nombre (no cambian; se cachean sin vencer)

const SUB_VIVA = ['active', 'trialing', 'past_due', 'unpaid'];

const MOTIVOS = {
  insufficient_funds: 'Fondos insuficientes',
  card_declined: 'Tarjeta rechazada',
  generic_decline: 'Tarjeta rechazada',
  do_not_honor: 'Rechazada por el banco',
  expired_card: 'Tarjeta vencida',
  incorrect_cvc: 'CVC incorrecto',
  incorrect_number: 'Número incorrecto',
  lost_card: 'Tarjeta reportada perdida',
  stolen_card: 'Tarjeta reportada robada',
  fraudulent: 'Bloqueada por fraude',
  highest_risk_level: 'Bloqueada por Radar (riesgo)',
  elevated_risk_level: 'Bloqueada por Radar (riesgo)',
  authentication_required: 'Requiere autenticación (3DS)',
  card_velocity_exceeded: 'Límite de la tarjeta excedido',
  withdrawal_count_limit_exceeded: 'Límite de la tarjeta excedido',
  processing_error: 'Error de procesamiento',
  transaction_not_allowed: 'Transacción no permitida',
  pickup_card: 'Tarjeta retenida por el banco',
  previously_declined_do_not_retry: 'Rechazada antes (banco pide no reintentar)',
  invalid_account: 'Cuenta de la tarjeta inválida',
  insufficient_funds_retry: 'Fondos insuficientes',
};

const motivoDe = (ch) => {
  const code =
    ch.outcome?.reason || ch.failure_code || ch.outcome?.type || 'otro';
  return {
    codigo: code,
    motivo:
      MOTIVOS[code] ||
      MOTIVOS[ch.failure_code] ||
      ch.failure_message ||
      'Otro motivo',
  };
};

const cents = (n) => Math.round(Number(n || 0)) / 100;
const fechaLocal = (unix) =>
  new Date(unix * 1000 + -5 * 3600 * 1000).toISOString().slice(0, 10);
const idDe = (x) => (x && typeof x === 'object' ? x.id : x) || null;
const isoDe = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

function parseRango(desde, hasta) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(desde || '') || !re.test(hasta || '')) {
    throw new Error('Formato de fecha inválido (YYYY-MM-DD)');
  }
  const gte = Math.floor(Date.parse(`${desde}T00:00:00${TZ}`) / 1000);
  const lt = Math.floor(Date.parse(`${hasta}T00:00:00${TZ}`) / 1000) + 86400;
  if (!(lt > gte)) throw new Error('El rango de fechas es inválido');
  if ((lt - gte) / 86400 > MAX_DIAS) {
    throw new Error(`El rango máximo es de ${MAX_DIAS} días`);
  }
  return { gte, lt };
}

async function usuariosPorStripe(customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await db.query(
    `SELECT id_usuario, nombre AS empresa, email_propietario AS email,
            estado, id_costumer, stripe_subscription_id
       FROM usuarios_chat_center
      WHERE id_costumer IN (:ids)`,
    { replacements: { ids: customerIds }, type: db.QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [r.id_costumer, r]));
}

async function nombreProducto(productId) {
  if (!productId) return null;
  if (_productos.has(productId)) return _productos.get(productId);
  const nombre = await stripe.products
    .retrieve(productId)
    .then((p) => p?.name || productId)
    .catch(() => productId);
  _productos.set(productId, nombre);
  return nombre;
}

// La paginación de Stripe es secuencial (~2 s por página): se parte el rango
// en tramos y se piden en paralelo. Un mes baja de ~20 s a ~2 s.
// `truncado` se marca si CUALQUIER tramo tocó su tope (antes solo se detectaba
// si todos lo tocaban, y un día con pico se perdía en silencio).
async function listarCharges(gte, lt) {
  const dias = Math.ceil((lt - gte) / 86400);
  const tramos = Math.min(TRAMOS, Math.max(1, dias));
  const paso = Math.ceil((lt - gte) / tramos);
  const porTramo = Math.ceil(MAX_CHARGES / tramos);
  const pedidos = [];
  for (let a = gte; a < lt; a += paso) {
    pedidos.push(
      (async () => {
        const out = [];
        let truncado = false;
        const iter = stripe.charges.list({
          created: { gte: a, lt: Math.min(a + paso, lt) },
          limit: 100,
          expand: ['data.balance_transaction'],
        });
        for await (const ch of iter) {
          out.push(ch);
          if (out.length >= porTramo) {
            truncado = true;
            break;
          }
        }
        return { out, truncado };
      })(),
    );
  }
  const res = await Promise.all(pedidos);
  return {
    charges: res.flatMap((r) => r.out),
    truncado: res.some((r) => r.truncado),
  };
}

// Estado actual de facturas fallidas que no se resolvieron con el rango
async function estadosFacturas(ids) {
  const out = new Map();
  const lista = ids.slice(0, 200);
  for (let i = 0; i < lista.length; i += 20) {
    const lote = await Promise.all(
      lista.slice(i, i + 20).map((id) =>
        stripe.invoices.retrieve(id).catch(() => null),
      ),
    );
    for (const inv of lote) {
      if (inv) out.set(inv.id, { status: inv.status, attempt_count: inv.attempt_count });
    }
  }
  return out;
}

// Facturas abiertas HOY: lo que Stripe aún intenta cobrar (o espera pago).
// Se expande la suscripción para saber si la deuda sigue viva (sub activa o
// past_due) o ya es basura (sub cancelada: nadie la va a pagar).
async function listarPendientes() {
  const out = [];
  const iter = stripe.invoices.list({
    status: 'open',
    limit: 100,
    expand: ['data.subscription'],
  });
  for await (const inv of iter) {
    if (Number(inv.amount_remaining || 0) <= 0) continue;
    out.push(inv);
    if (out.length >= 1000) break;
  }
  return out;
}

// Clientes con 2+ suscripciones vivas a la vez. Es el síntoma del doble cobro:
// una renovación rebotó, el cliente volvió a contratar por checkout y la vieja
// siguió viva. `reemplazada_por` en la metadata de la vieja confirma el caso.
async function listarDoblesSubs() {
  const porCust = new Map();
  for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    if (!SUB_VIVA.includes(s.status)) continue;
    const cid = idDe(s.customer);
    if (!cid) continue;
    if (!porCust.has(cid)) porCust.set(cid, []);
    porCust.get(cid).push(s);
  }
  const dobles = [];
  for (const [cid, subs] of porCust) {
    if (subs.length < 2) continue;
    const detalle = [];
    for (const s of subs.sort((a, b) => a.created - b.created)) {
      const it = s.items?.data?.[0];
      detalle.push({
        id: s.id,
        status: s.status,
        creada: isoDe(s.created),
        monto: cents(it?.price?.unit_amount) * (it?.quantity || 1),
        producto: await nombreProducto(idDe(it?.price?.product)),
        cancel_at_period_end: !!s.cancel_at_period_end,
        reemplazada_por: s.metadata?.reemplazada_por || null,
      });
    }
    dobles.push({ customer_id: cid, subs: detalle });
  }
  return dobles;
}

async function cobrosEnRango(desde, hasta, { fresh = false } = {}) {
  const { gte, lt } = parseRango(desde, hasta);
  const key = `${gte}|${lt}`;
  const hit = _cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const [{ charges, truncado }, pendientesRaw, doblesRaw] = await Promise.all([
    listarCharges(gte, lt),
    listarPendientes(),
    listarDoblesSubs().catch((e) => {
      console.warn('[cobros] no se pudieron listar subs dobles:', e?.message);
      return [];
    }),
  ]);

  charges.sort((a, b) => b.created - a.created);
  const custIds = new Set(
    [
      ...charges.map((x) => idDe(x.customer)),
      ...pendientesRaw.map((x) => idDe(x.customer)),
      ...doblesRaw.map((x) => x.customer_id),
    ].filter(Boolean),
  );

  // Estado de cada factura: abiertas hoy, pagadas dentro del rango y,
  // para las fallidas que quedan sin resolver, se consulta a Stripe.
  const facturas = new Map();
  for (const inv of pendientesRaw) {
    facturas.set(inv.id, { status: 'open', attempt_count: inv.attempt_count });
  }
  const facturasPagadas = new Set(
    charges
      .filter((ch) => ch.status === 'succeeded' && ch.invoice)
      .map((ch) => idDe(ch.invoice)),
  );
  for (const id of facturasPagadas) {
    if (!facturas.has(id)) facturas.set(id, { status: 'paid' });
  }
  const sinResolver = [
    ...new Set(
      charges
        .filter((ch) => ch.status === 'failed' && ch.invoice)
        .map((ch) => idDe(ch.invoice))
        .filter((id) => !facturas.has(id)),
    ),
  ];
  const [usuarios, extra] = await Promise.all([
    usuariosPorStripe([...custIds]),
    estadosFacturas(sinResolver),
  ]);
  for (const [id, v] of extra) facturas.set(id, v);

  const k = {
    bruto: 0,
    comisiones: 0,
    reembolsado: 0,
    neto: 0,
    cobros_ok: 0,
    intentos_fallidos: 0,
    monto_intentos_fallidos: 0,
    disputas: 0,
    monto_disputas: 0,
  };
  const porDia = new Map();
  const motivos = new Map();
  const facturasFallidas = new Map(); // invoice_id → { monto, recuperada }
  const clientesFallidos = new Set();
  const monedas = new Set();
  const filas = [];

  for (const ch of charges) {
    const fecha = fechaLocal(ch.created);
    const dia = porDia.get(fecha) || {
      fecha,
      cobrado: 0,
      fallido: 0,
      reembolsado: 0,
      n_ok: 0,
      n_fail: 0,
    };
    const monto = cents(ch.amount);
    const customerId = idDe(ch.customer);
    const u = customerId ? usuarios.get(customerId) : null;
    const invoiceId = idDe(ch.invoice);
    const inv = invoiceId ? facturas.get(invoiceId) || null : null;
    monedas.add(String(ch.currency || 'usd').toUpperCase());

    let estado = ch.status === 'succeeded' ? 'cobrado' : ch.status; // failed | pending
    let motivo = null;
    let comision = 0;
    let neto = 0;
    const reembolsado = cents(ch.amount_refunded);

    if (ch.status === 'succeeded') {
      const bt =
        ch.balance_transaction && typeof ch.balance_transaction === 'object'
          ? ch.balance_transaction
          : null;
      comision = bt ? cents(bt.fee) : 0;
      neto = (bt ? cents(bt.net) : monto) - reembolsado;
      k.bruto += monto;
      k.comisiones += comision;
      k.reembolsado += reembolsado;
      k.neto += neto;
      k.cobros_ok += 1;
      dia.cobrado += monto;
      dia.reembolsado += reembolsado;
      dia.n_ok += 1;
      if (ch.refunded) estado = 'reembolsado';
      else if (reembolsado > 0) estado = 'reembolso_parcial';
      if (ch.disputed) {
        estado = 'disputa';
        k.disputas += 1;
        k.monto_disputas += monto;
      }
    } else if (ch.status === 'failed') {
      motivo = motivoDe(ch);
      k.intentos_fallidos += 1;
      k.monto_intentos_fallidos += monto;
      dia.fallido += monto;
      dia.n_fail += 1;
      const m = motivos.get(motivo.motivo) || {
        motivo: motivo.motivo,
        cantidad: 0,
        monto: 0,
      };
      m.cantidad += 1;
      m.monto += monto;
      motivos.set(motivo.motivo, m);
      if (customerId) clientesFallidos.add(customerId);

      // Agrupa reintentos por factura para no contar 4 veces la misma deuda
      const fkey = invoiceId || ch.id;
      if (!facturasFallidas.has(fkey)) {
        const recuperada =
          (invoiceId && facturasPagadas.has(invoiceId)) || inv?.status === 'paid';
        facturasFallidas.set(fkey, {
          monto,
          recuperada,
          estado_factura: inv?.status || null,
        });
      }
    }
    porDia.set(fecha, dia);

    filas.push({
      id: ch.id,
      fecha: new Date(ch.created * 1000).toISOString(),
      estado,
      monto,
      reembolsado,
      comision,
      neto,
      moneda: String(ch.currency || 'usd').toUpperCase(),
      descripcion: ch.description || null,
      motivo: motivo?.motivo || null,
      motivo_codigo: motivo?.codigo || null,
      mensaje_banco: ch.status === 'failed' ? ch.failure_message || null : null,
      tarjeta: ch.payment_method_details?.card
        ? `${ch.payment_method_details.card.brand || ''} ····${ch.payment_method_details.card.last4 || ''}`.trim()
        : null,
      invoice_id: invoiceId,
      estado_factura: inv?.status || null,
      intento: inv?.attempt_count || null,
      cliente_email:
        ch.billing_details?.email || ch.receipt_email || u?.email || null,
      cliente_nombre: ch.billing_details?.name || null,
      customer_id: customerId,
      id_usuario: u?.id_usuario || null,
      empresa: u?.empresa || null,
      recibo: ch.receipt_url || null,
    });
  }

  let facturasRecuperadas = 0;
  let montoNoRecuperado = 0;
  for (const f of facturasFallidas.values()) {
    if (f.recuperada) facturasRecuperadas += 1;
    else montoNoRecuperado += f.monto;
  }

  const pendientes = pendientesRaw
    .map((inv) => {
      const cid = idDe(inv.customer);
      const u = cid ? usuarios.get(cid) : null;
      const sub =
        inv.subscription && typeof inv.subscription === 'object'
          ? inv.subscription
          : null;
      const subStatus = sub?.status || (inv.subscription ? 'desconocido' : null);
      // Deuda muerta: la sub ya no existe o está cancelada; o Stripe agotó
      // los reintentos. Nadie la va a pagar sola: anularla o cobrar a mano.
      const subMuerta = !inv.subscription || subStatus === 'canceled';
      return {
        invoice_id: inv.id,
        creada: isoDe(inv.created),
        monto: cents(inv.amount_remaining),
        moneda: String(inv.currency || 'usd').toUpperCase(),
        intentos: inv.attempt_count || 0,
        proximo_intento: isoDe(inv.next_payment_attempt),
        vence: isoDe(inv.due_date),
        cliente_email: inv.customer_email || u?.email || null,
        cliente_nombre: inv.customer_name || null,
        id_usuario: u?.id_usuario || null,
        empresa: u?.empresa || null,
        estado_usuario: u?.estado || null,
        sub_id: idDe(inv.subscription),
        sub_status: subStatus,
        sub_muerta: subMuerta,
        sin_reintento: !inv.next_payment_attempt,
        url_pago: inv.hosted_invoice_url || null,
      };
    })
    .sort((a, b) => b.monto - a.monto);

  const dobles = doblesRaw.map((d) => {
    const u = usuarios.get(d.customer_id);
    return {
      ...d,
      id_usuario: u?.id_usuario || null,
      empresa: u?.empresa || null,
      cliente_email: u?.email || null,
      // Sub que la BD considera la del usuario; las demás son las sobrantes.
      sub_en_bd: u?.stripe_subscription_id || null,
    };
  });

  const r2 = (n) => Math.round(n * 100) / 100;
  const totalIntentos = k.cobros_ok + k.intentos_fallidos;
  const pendientesMuertas = pendientes.filter((p) => p.sub_muerta);
  const data = {
    rango: { desde, hasta },
    modo: MODO,
    monedas: [...monedas],
    truncado,
    kpis: {
      bruto: r2(k.bruto),
      comisiones: r2(k.comisiones),
      reembolsado: r2(k.reembolsado),
      neto: r2(k.neto),
      cobros_ok: k.cobros_ok,
      intentos_fallidos: k.intentos_fallidos,
      monto_intentos_fallidos: r2(k.monto_intentos_fallidos),
      facturas_fallidas: facturasFallidas.size,
      facturas_recuperadas: facturasRecuperadas,
      monto_no_recuperado: r2(montoNoRecuperado),
      clientes_con_fallo: clientesFallidos.size,
      disputas: k.disputas,
      monto_disputas: r2(k.monto_disputas),
      tasa_exito: totalIntentos
        ? r2((k.cobros_ok / totalIntentos) * 100)
        : null,
      pendiente_total: r2(pendientes.reduce((s, p) => s + p.monto, 0)),
      pendiente_facturas: pendientes.length,
      // Parte del pendiente que ya no se va a cobrar sola
      pendiente_muerto: r2(pendientesMuertas.reduce((s, p) => s + p.monto, 0)),
      pendiente_muerto_facturas: pendientesMuertas.length,
      clientes_doble_sub: dobles.length,
    },
    por_dia: [...porDia.values()]
      .map((d) => ({
        ...d,
        cobrado: r2(d.cobrado),
        fallido: r2(d.fallido),
        reembolsado: r2(d.reembolsado),
      }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha)),
    motivos: [...motivos.values()]
      .map((m) => ({ ...m, monto: r2(m.monto) }))
      .sort((a, b) => b.cantidad - a.cantidad),
    cobros: filas,
    pendientes,
    alertas: { dobles },
    generado: new Date().toISOString(),
  };

  if (_cache.size > 50) _cache.clear();
  _cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { cobrosEnRango };
