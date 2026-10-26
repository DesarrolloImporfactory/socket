'use strict';

const Stripe = require('stripe');
const { db } = require('../database/config');

/**
 * Pagos de planes recibidos FUERA de Stripe (transferencia, efectivo).
 *
 * CASO QUE LO ORIGINÓ (2026-10-26, cuenta 1311)
 * La tarjeta del cliente rebota y él dice que sí tiene saldo. Para no perder
 * el mes se le ofrece transferir a la cuenta del negocio y el super admin
 * necesita dejar constancia: cuánto llegó, cuándo, el comprobante, y que
 * Stripe deje de reintentar esa factura. El mes siguiente Stripe vuelve a
 * intentar cobrar la tarjeta por el camino normal.
 *
 * QUÉ HACE Y QUÉ NO
 *  - Guarda el pago en pagos_manuales_chat_center (registro propio, con el
 *    comprobante en el uploader).
 *  - Si se eligió una factura de Stripe, la salda con `paid_out_of_band`: no
 *    cobra nada, la factura pasa a `paid`, Stripe deja de reintentarla y, si
 *    era de la suscripción, ésta vuelve a `active` y el webhook
 *    `invoice.payment_succeeded` sincroniza fechas y estado en la BD por el
 *    camino de siempre (ver scripts/saldarFacturaSuscripcion.js).
 *  - NUNCA crea una factura nueva en Stripe: una factura manual no tiene
 *    período ni suscripción y el webhook no puede sincronizar nada desde ella
 *    (caso 932 del 2026-09-07).
 *  - Si la cuenta no tiene nada que saldar (sin Stripe, suscripción muerta),
 *    el admin puede fijar hasta cuándo queda el acceso: se escribe
 *    fecha_renovacion y estado 'activo' directo en la BD.
 */

// Siempre la cuenta LIVE: la suscripción del cliente vive ahí aunque este
// servidor corra en development (mismo criterio que
// scripts/saldarFacturaSuscripcion.js). Con la llave TEST, "No such customer"
// se leía como "sin facturas abiertas" y el admin no veía nada que saldar.
// Solo cae a TEST si no hay llave live configurada.
const STRIPE_SECRET =
  process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || '';
const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });
const MODO = String(STRIPE_SECRET).startsWith('sk_live_') ? 'live' : 'test';
const { telefonoDe, clientesEnRiesgo, COHORTES } = require('./recuperacion.service');

const SELECT = { type: db.QueryTypes.SELECT };
const METODOS = ['transferencia', 'efectivo', 'otro'];
// Estados de factura que Stripe permite marcar como pagadas fuera de banda.
const SALDABLES = new Set(['open', 'uncollectible']);

let tablaLista = false;
async function ensureTabla() {
  if (tablaLista) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS pagos_manuales_chat_center (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_usuario INT NOT NULL,
      monto DECIMAL(10,2) NOT NULL,
      moneda VARCHAR(3) NOT NULL DEFAULT 'usd',
      metodo ENUM('transferencia','efectivo','otro') NOT NULL DEFAULT 'transferencia',
      referencia VARCHAR(120) NULL,
      fecha_pago DATE NULL,
      comprobante_url VARCHAR(500) NULL,
      nota VARCHAR(255) NULL,
      stripe_invoice_id VARCHAR(60) NULL,
      stripe_accion VARCHAR(30) NULL,
      stripe_detalle VARCHAR(255) NULL,
      acceso_hasta DATETIME NULL,
      registrado_por_id INT NULL,
      registrado_por_nombre VARCHAR(190) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_usuario (id_usuario, created_at),
      KEY ix_invoice (stripe_invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  tablaLista = true;
}

const ts = (s) => (s ? new Date(s * 1000) : null);
const idDe = (v) => (v && typeof v === 'object' ? v.id : v) || null;
// `subscription` puede venir expandido (objeto) cuando se pidió con expand.
const subDeFactura = (inv) =>
  idDe(inv.subscription) ||
  inv.parent?.subscription_details?.subscription ||
  inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
  null;
// Suscripciones que ya no van a cobrar nada: su factura abierta es deuda
// muerta (Stripe agotó los reintentos y nadie la pagará sola).
const SUB_MUERTA = new Set(['canceled', 'incomplete_expired']);

async function usuarioDe(id_usuario) {
  const [u] = await db.query(
    `SELECT u.id_usuario, u.nombre AS empresa, u.email_propietario AS email, u.estado,
            u.id_costumer, u.stripe_subscription_id, u.stripe_subscription_status AS stripe_status,
            u.fecha_renovacion, u.permanente, u.periodo_pago, p.nombre_plan, p.precio_plan
       FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.id_usuario = ? LIMIT 1`,
    { replacements: [id_usuario], ...SELECT },
  );
  return u || null;
}

function mapFactura(inv, subBd) {
  const sub = subDeFactura(inv);
  const subObj = inv.subscription && typeof inv.subscription === 'object' ? inv.subscription : null;
  const subStatus = subObj?.status || null;
  const linea = inv.lines?.data?.[0] || null;
  const esManual = inv.billing_reason === 'manual' || !sub;
  return {
    id: inv.id,
    status: inv.status,
    monto: Number(inv.amount_due || inv.total || 0) / 100,
    moneda: String(inv.currency || 'usd').toLowerCase(),
    billing_reason: inv.billing_reason || null,
    es_manual: esManual,
    subscription: sub,
    sub_status: subStatus,
    es_de_suscripcion_bd: !!sub && sub === subBd,
    // Factura de una suscripción que ya murió (la típica: el cliente volvió a
    // contratar y la vieja quedó cancelada con su última factura sin pagar).
    // Solo se sabe cuando la suscripción vino expandida; en la ficha del
    // cliente no se expande y queda null.
    sub_muerta: subStatus ? SUB_MUERTA.has(subStatus) : subStatus === null && !esManual ? null : false,
    created: ts(inv.created),
    intentos: Number(inv.attempt_count || 0),
    proximo_intento: ts(inv.next_payment_attempt),
    periodo_inicio: ts(linea?.period?.start),
    periodo_fin: ts(linea?.period?.end),
    hosted_invoice_url: inv.hosted_invoice_url || null,
    saldable: SALDABLES.has(inv.status),
  };
}

/**
 * Lo que el super admin necesita ver antes de registrar: la suscripción, las
 * facturas de Stripe que todavía se pueden saldar y los pagos manuales ya
 * registrados. Stripe puede fallar: en ese caso se devuelve `stripe_error` y
 * el registro sigue siendo posible (sin saldar factura).
 */
async function panelCliente(id_usuario) {
  await ensureTabla();
  const u = await usuarioDe(id_usuario);
  if (!u) return null;

  let suscripcion = null;
  let facturas = [];
  let stripe_error = null;

  if (u.id_costumer) {
    try {
      const [invs, sub] = await Promise.all([
        stripe.invoices.list({ customer: u.id_costumer, limit: 20 }),
        u.stripe_subscription_id
          ? stripe.subscriptions.retrieve(u.stripe_subscription_id).catch(() => null)
          : Promise.resolve(null),
      ]);
      facturas = invs.data
        .filter((i) => SALDABLES.has(i.status))
        .map((i) => mapFactura(i, u.stripe_subscription_id));
      if (sub) {
        suscripcion = {
          id: sub.id,
          status: sub.status,
          cancel_at_period_end: !!sub.cancel_at_period_end,
          periodo_fin: ts(sub.current_period_end || sub.items?.data?.[0]?.current_period_end),
          monto: Number(sub.items?.data?.[0]?.price?.unit_amount || 0) / 100,
          intervalo: sub.items?.data?.[0]?.price?.recurring?.interval || null,
        };
      }
    } catch (e) {
      stripe_error = e?.message || 'Stripe no respondió';
    }
  }

  const pagos = await listarDeCliente(id_usuario);
  return {
    modo: MODO,
    usuario: { ...u, precio_plan: u.precio_plan != null ? Number(u.precio_plan) : null },
    suscripcion,
    facturas,
    pagos,
    stripe_error,
  };
}

async function listarDeCliente(id_usuario) {
  await ensureTabla();
  return db.query(
    `SELECT * FROM pagos_manuales_chat_center WHERE id_usuario = ? ORDER BY created_at DESC LIMIT 50`,
    { replacements: [id_usuario], ...SELECT },
  );
}

/** Últimos pagos manuales de todas las cuentas (vista del super admin). */
async function listarRecientes({ limit = 100 } = {}) {
  await ensureTabla();
  return db.query(
    `SELECT pm.*, u.nombre AS empresa, u.email_propietario AS email, u.estado,
            u.stripe_subscription_status AS stripe_status, u.fecha_renovacion, p.nombre_plan
       FROM pagos_manuales_chat_center pm
       JOIN usuarios_chat_center u ON u.id_usuario = pm.id_usuario
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      ORDER BY pm.created_at DESC
      LIMIT ${Math.max(1, Math.min(500, Number(limit) || 100))}`,
    SELECT,
  );
}

/**
 * Cobros que Stripe no logró: facturas abiertas con al menos un intento
 * fallido (de suscripción o manuales) y las marcadas incobrables en los
 * últimos 60 días. Es la lista de a quién hay que escribirle para ofrecerle
 * pagar por transferencia. El embudo no los muestra a todos: cuando una
 * factura se marca incobrable la suscripción vuelve a `active` y el cliente
 * sale de «Pago rebotado» aunque no haya pagado (caso 1311).
 *
 * Caché de 2 minutos: recorre todas las facturas abiertas (~180) en Stripe.
 */
let _rebotadosCache = { at: 0, data: null };
const REBOTADOS_CACHE_MS = 2 * 60 * 1000;
const DIAS_INCOBRABLES = 60;

async function cobrosRebotados({ fresh = false } = {}) {
  if (!fresh && _rebotadosCache.data && Date.now() - _rebotadosCache.at < REBOTADOS_CACHE_MS) {
    return _rebotadosCache.data;
  }
  await ensureTabla(); // el SELECT de abajo cruza con pagos_manuales_chat_center
  const facturas = [];
  // Se expande la suscripción para saber si la factura todavía puede cobrarse
  // (sub viva) o es deuda muerta (sub cancelada): sin eso, 17 de 71 "vivos"
  // eran facturas viejas de suscripciones que el cliente ya reemplazó.
  for await (const inv of stripe.invoices.list({
    status: 'open',
    limit: 100,
    expand: ['data.subscription'],
  })) {
    if (Number(inv.amount_remaining || 0) <= 0) continue;
    // Sin intentos todavía no rebotó: es una renovación recién emitida que
    // Stripe cobrará en su primer intento. Solo entran las que ya fallaron.
    if (Number(inv.attempt_count || 0) <= 0) continue;
    facturas.push(inv);
    if (facturas.length >= 1000) break;
  }
  const desde = Math.floor(Date.now() / 1000) - DIAS_INCOBRABLES * 86400;
  for await (const inv of stripe.invoices.list({
    status: 'uncollectible',
    created: { gte: desde },
    limit: 100,
    expand: ['data.subscription'],
  })) {
    facturas.push(inv);
  }

  const custIds = [...new Set(facturas.map((i) => idDe(i.customer)).filter(Boolean))];
  // En qué cohorte del embudo está cada uno (si está): el admin pregunta
  // "¿y este en qué estado se supone que está?" al ver la lista.
  const cohorteDe = new Map();
  try {
    for (const r of await clientesEnRiesgo()) cohorteDe.set(r.id_usuario, r.cohorte);
  } catch (e) {
    console.log('[pagos_manuales] cohortes no disponibles:', e?.message);
  }
  const usuarios = custIds.length
    ? await db.query(
        `SELECT u.id_usuario, u.nombre AS empresa, u.email_propietario AS email, u.estado,
                u.id_costumer, u.stripe_subscription_id, u.stripe_subscription_status AS stripe_status,
                u.fecha_renovacion, u.whatsapp_lead, u.whatsapp_lead_pais, p.nombre_plan,
                (SELECT c.telefono FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0 ORDER BY c.id LIMIT 1) AS telefono_conexion,
                (SELECT c.nombre_configuracion FROM configuraciones c WHERE c.id_usuario = u.id_usuario AND c.suspendido = 0 ORDER BY c.id LIMIT 1) AS nombre_conexion,
                (SELECT MAX(pm.created_at) FROM pagos_manuales_chat_center pm WHERE pm.id_usuario = u.id_usuario) AS ultimo_pago_manual
           FROM usuarios_chat_center u
           LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
          WHERE u.id_costumer IN (:ids)`,
        { replacements: { ids: custIds }, ...SELECT },
      )
    : [];
  const uDe = new Map(usuarios.map((u) => [u.id_costumer, u]));

  // Una fila por cliente, con todas sus facturas rebotadas: la pregunta es
  // "¿a quién le escribo?", no "¿cuántas facturas hay?".
  const porCliente = new Map();
  for (const inv of facturas) {
    const cid = idDe(inv.customer);
    const u = uDe.get(cid) || null;
    const key = cid || inv.id;
    if (!porCliente.has(key)) {
      const tel = u ? telefonoDe(u) : { digits: null, display: null, url: null, fuente: null };
      const cohorte = u ? cohorteDe.get(u.id_usuario) || null : null;
      porCliente.set(key, {
        customer_id: cid,
        id_usuario: u?.id_usuario || null,
        empresa: u?.empresa || inv.customer_name || null,
        email: u?.email || inv.customer_email || null,
        estado: u?.estado || null,
        stripe_status: u?.stripe_status || null,
        fecha_renovacion: u?.fecha_renovacion || null,
        nombre_plan: u?.nombre_plan || null,
        cohorte,
        cohorte_label: cohorte ? COHORTES[cohorte]?.label || cohorte : null,
        whatsapp: tel.display,
        whatsapp_url: tel.url,
        telefono_fuente: tel.fuente,
        ultimo_pago_manual: u?.ultimo_pago_manual || null,
        facturas: [],
      });
    }
    const fila = porCliente.get(key);
    const f = mapFactura(inv, u?.stripe_subscription_id || null);
    // Manual sin suscripción: viva si el cliente tiene cuenta y su sub en la
    // BD no está cancelada (es a quien se le puede cobrar); si no, muerta.
    if (f.es_manual) {
      f.sub_muerta = !u || !u.stripe_subscription_id || SUB_MUERTA.has(u.stripe_status);
    } else if (f.sub_muerta === null) {
      f.sub_muerta = false;
    }
    fila.facturas.push(f);
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  const filas = [...porCliente.values()].map((fila) => {
    const vivas = fila.facturas.filter((f) => !f.sub_muerta);
    const muertas = fila.facturas.filter((f) => f.sub_muerta);
    const proximo = vivas
      .map((f) => f.proximo_intento)
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    const ultimaCreada = (vivas.length ? vivas : muertas).map((f) => f.created).sort((a, b) => b - a)[0];
    return {
      ...fila,
      // Vivo = tiene al menos una factura que todavía se puede cobrar. Las
      // facturas muertas se mandan aparte: se muestran solo si el admin pide
      // ver la deuda muerta.
      sub_muerta: vivas.length === 0,
      facturas: vivas,
      facturas_muertas: muertas,
      // Lo que debe: las abiertas. Una incobrable solo suma si no hay abierta
      // (caso 1311: la incobrable del ciclo y la manual son el MISMO mes; sumar
      // las dos diría $68 cuando debe $34).
      monto_total: r2(
        (vivas.some((f) => f.status === 'open') ? vivas.filter((f) => f.status === 'open') : vivas).reduce(
          (s, f) => s + f.monto,
          0,
        ),
      ),
      monto_muerto: r2(muertas.reduce((s, f) => s + f.monto, 0)),
      proximo_intento: proximo || null,
      ultima_factura: ultimaCreada || null,
      tiene_manual: vivas.some((f) => f.es_manual),
      tiene_incobrable: vivas.some((f) => f.status === 'uncollectible'),
    };
  });
  // Primero los vivos (hay a quién cobrar) y, entre ellos, el rebote más reciente.
  filas.sort((a, b) => {
    if (a.sub_muerta !== b.sub_muerta) return a.sub_muerta ? 1 : -1;
    return new Date(b.ultima_factura || 0) - new Date(a.ultima_factura || 0);
  });

  const data = {
    modo: MODO,
    generado_en: new Date(),
    filas,
    resumen: {
      clientes: filas.length,
      vivos: filas.filter((f) => !f.sub_muerta).length,
      monto_vivo: r2(filas.reduce((s, f) => s + f.monto_total, 0)),
      monto_muerto: r2(filas.reduce((s, f) => s + f.monto_muerto, 0)),
    },
  };
  _rebotadosCache = { at: Date.now(), data };
  return data;
}

/**
 * Registra el pago. El orden importa: primero Stripe (si falla, el pago se
 * guarda igual con stripe_accion='error' para que el dinero recibido no
 * quede sin registro, y el front avisa), después el acceso manual, y al
 * final la fila.
 */
async function registrar({
  id_usuario,
  monto,
  moneda = 'usd',
  metodo = 'transferencia',
  referencia = null,
  fecha_pago = null,
  nota = null,
  comprobante_url = null,
  stripe_invoice_id = null,
  anular_invoice_ids = [],
  acceso_hasta = null,
  admin = {},
}) {
  await ensureTabla();
  const u = await usuarioDe(id_usuario);
  if (!u) throw Object.assign(new Error('Cliente no encontrado'), { status: 404 });

  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) {
    throw Object.assign(new Error('El monto debe ser mayor a cero'), { status: 400 });
  }
  if (!METODOS.includes(metodo)) {
    throw Object.assign(new Error('Método inválido'), { status: 400 });
  }

  let stripe_accion = 'sin_factura';
  let stripe_detalle = null;
  let factura = null;

  if (stripe_invoice_id) {
    if (!/^in_[A-Za-z0-9]+$/.test(String(stripe_invoice_id))) {
      throw Object.assign(new Error('Id de factura inválido'), { status: 400 });
    }
    try {
      const inv = await stripe.invoices.retrieve(stripe_invoice_id);
      // Nunca saldar la factura de otro cliente por un id pegado mal.
      if (!u.id_costumer || inv.customer !== u.id_costumer) {
        throw Object.assign(new Error('La factura no pertenece a este cliente'), { status: 400 });
      }
      if (!SALDABLES.has(inv.status)) {
        throw Object.assign(
          new Error(`La factura está en '${inv.status}': solo se salda una abierta o incobrable`),
          { status: 400 },
        );
      }
      const pagada = await stripe.invoices.pay(stripe_invoice_id, { paid_out_of_band: true });
      factura = mapFactura(pagada, u.stripe_subscription_id);
      stripe_accion = 'saldada';
      stripe_detalle = `${pagada.status}; sub ${factura.subscription || 'ninguna'}`;
    } catch (e) {
      // Validaciones nuestras: se corta antes de registrar nada.
      if (e?.status) throw e;
      stripe_accion = 'error';
      stripe_detalle = String(e?.message || 'Stripe no respondió').slice(0, 255);
    }
  }

  // Otras facturas abiertas del mismo cliente que ya no deben cobrarse (la
  // típica: una factura manual creada en el dashboard de Stripe por el mismo
  // mes que ahora se pagó por transferencia). Se anulan (void) para que Stripe
  // deje de reintentar la tarjeta; una incobrable no se toca, ya no reintenta.
  const anuladas = [];
  const noAnuladas = [];
  for (const id of [...new Set((anular_invoice_ids || []).filter(Boolean))]) {
    if (id === stripe_invoice_id || !/^in_[A-Za-z0-9]+$/.test(String(id))) continue;
    try {
      const inv = await stripe.invoices.retrieve(id);
      if (!u.id_costumer || inv.customer !== u.id_costumer) {
        noAnuladas.push(`${id}: de otro cliente`);
        continue;
      }
      if (inv.status !== 'open') {
        noAnuladas.push(`${id}: está ${inv.status}`);
        continue;
      }
      await stripe.invoices.voidInvoice(id);
      anuladas.push(id);
    } catch (e) {
      noAnuladas.push(`${id}: ${String(e?.message || 'error').slice(0, 60)}`);
    }
  }
  if (anuladas.length || noAnuladas.length) {
    const extra = [
      anuladas.length ? `anuladas: ${anuladas.join(', ')}` : null,
      noAnuladas.length ? `sin anular: ${noAnuladas.join('; ')}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    stripe_detalle = [stripe_detalle, extra].filter(Boolean).join(' | ').slice(0, 255);
    if (stripe_accion === 'sin_factura') stripe_accion = 'anuladas';
  }

  let accesoHasta = null;
  if (acceso_hasta) {
    // Un 'YYYY-MM-DD' pelado se toma al final de ese día (hora de la BD):
    // "acceso hasta el 22" incluye el 22.
    const s = String(acceso_hasta).trim();
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59`) : new Date(s);
    if (isNaN(d)) throw Object.assign(new Error('Fecha de acceso inválida'), { status: 400 });
    if (d.getTime() < Date.now()) {
      throw Object.assign(new Error('La fecha de acceso debe ser futura'), { status: 400 });
    }
    accesoHasta = d;
    // Acceso directo en la BD: es el único camino cuando no hay factura de
    // suscripción que el webhook pueda sincronizar.
    await db.query(
      `UPDATE usuarios_chat_center SET fecha_renovacion = ?, estado = 'activo' WHERE id_usuario = ?`,
      { replacements: [accesoHasta, id_usuario] },
    );
  }

  const [id] = await db.query(
    `INSERT INTO pagos_manuales_chat_center
       (id_usuario, monto, moneda, metodo, referencia, fecha_pago, comprobante_url, nota,
        stripe_invoice_id, stripe_accion, stripe_detalle, acceso_hasta,
        registrado_por_id, registrado_por_nombre)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        id_usuario,
        montoNum.toFixed(2),
        String(moneda || 'usd').toLowerCase().slice(0, 3),
        metodo,
        referencia ? String(referencia).slice(0, 120) : null,
        fecha_pago || null,
        comprobante_url || null,
        nota ? String(nota).slice(0, 255) : null,
        stripe_invoice_id || null,
        stripe_accion,
        stripe_detalle,
        accesoHasta,
        admin.id_sub_usuario || null,
        admin.nombre ? String(admin.nombre).slice(0, 190) : null,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  const [pago] = await db.query(`SELECT * FROM pagos_manuales_chat_center WHERE id = ?`, {
    replacements: [id],
    ...SELECT,
  });

  return {
    pago,
    stripe: { accion: stripe_accion, detalle: stripe_detalle, factura, anuladas, no_anuladas: noAnuladas },
  };
}

module.exports = {
  panelCliente,
  listarDeCliente,
  listarRecientes,
  cobrosRebotados,
  registrar,
  METODOS,
};
