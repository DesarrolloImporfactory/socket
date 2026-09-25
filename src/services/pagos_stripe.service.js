const Stripe = require('stripe');
const { db } = require('../database/config');
const { decryptToken } = require('../utils/cryptoToken');
const StripeIntegrations = require('../models/stripe_integrations.model');
const EnlacesPago = require('../models/enlaces_pago.model');
const ChatService = require('./chat.service');

/**
 * Enlaces de pago con la cuenta de Stripe de CADA cliente.
 *
 * Qué se crea en Stripe: una FACTURA (invoice) con un solo ítem, finalizada,
 * con collection_method 'send_invoice'. Se elige la factura y no un Checkout
 * porque: no vence a las 24 h, tiene página de pago hospedada + PDF de recibo,
 * y su estado (open/paid/void) es lo que el asesor quiere ver. No se le pide
 * a Stripe que la envíe por correo: el enlace va por WhatsApp.
 *
 * Cómo se sabe si se pagó: consultando la factura con la llave de la cuenta
 * (refrescarEstado), al abrir el chat del contacto y por cron cada 10 min.
 * No se exige al cliente configurar un webhook en su Stripe.
 *
 * Esta es la ÚNICA función que crea enlaces: hoy la llama el asesor desde el
 * chat; mañana la puede llamar una herramienta del bot con origen 'bot'.
 */

const chatService = new ChatService();

const MONTO_MINIMO = 0.5; // mínimo de Stripe para tarjeta (~USD 0.50)
const DIAS_VENCIMIENTO = 7;
const CACHE_MS = 5 * 60 * 1000;

class EnlacePagoError extends Error {
  constructor(message, code = 'ENLACE_PAGO', status = 400) {
    super(message);
    this.code = code;
    this.statusCode = status;
  }
}

/* ────────────────────────── llave / cliente Stripe ────────────────────────── */

const _cache = new Map(); // id_configuracion → { at, integ, stripe }

const modoDeLlave = (key) =>
  /^(sk|rk)_test_/i.test(String(key || '')) ? 'test' : 'live';

const nuevoStripe = (key) => new Stripe(key, { apiVersion: '2024-06-20' });

async function integracionActiva(id_configuracion) {
  return StripeIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
}

/**
 * { stripe, integ } de la cuenta, o null si no tiene Stripe vinculado.
 *
 * Con `soloConsulta` se admite también la última vinculación ELIMINADA: los
 * enlaces que ya se enviaron con esa llave se siguen consultando (y anulando)
 * aunque el cliente desvincule Stripe, mientras Stripe siga aceptando la
 * llave. Crear enlaces nuevos exige una vinculación activa.
 */
async function stripeDeConfig(id_configuracion, { soloConsulta = false } = {}) {
  const now = Date.now();
  const cacheKey = `${Number(id_configuracion)}:${soloConsulta ? 'c' : 'a'}`;
  const hit = _cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_MS) return hit.integ ? hit : null;

  let integ = await integracionActiva(id_configuracion);
  if (!integ && soloConsulta) {
    integ = await StripeIntegrations.findOne({
      where: { id_configuracion },
      order: [['id', 'DESC']],
    });
  }
  if (!integ) {
    _cache.set(cacheKey, { at: now, integ: null });
    return null;
  }
  const stripe = nuevoStripe(decryptToken(integ.secret_key_enc));
  const entry = { at: now, integ, stripe };
  _cache.set(cacheKey, entry);
  return entry;
}

function olvidarCache(id_configuracion) {
  _cache.delete(`${Number(id_configuracion)}:a`);
  _cache.delete(`${Number(id_configuracion)}:c`);
}

/**
 * Valida una llave contra Stripe antes de guardarla. Devuelve modo y, si la
 * llave lo permite, nombre e id de la cuenta. Lanza si la llave no sirve.
 */
async function validarLlave(key) {
  const stripe = nuevoStripe(key);

  // Se valida SOLO con lo que el flujo usa (clientes y facturas). Antes se
  // pedía el saldo de la cuenta y una llave restringida con exactamente los
  // permisos que la guía indica (Customers + Invoices) era rechazada por
  // faltarle `balance_read`, un permiso que la integración no necesita.
  const faltan = [];
  try {
    await stripe.customers.list({ limit: 1 });
  } catch (e) {
    faltan.push(esLlaveInvalida(e) ? 'LLAVE' : 'Customers');
  }
  try {
    await stripe.invoices.list({ limit: 1 });
  } catch (e) {
    faltan.push(esLlaveInvalida(e) ? 'LLAVE' : 'Invoices');
  }
  if (faltan.includes('LLAVE')) {
    throw new EnlacePagoError(
      'Stripe no reconoce esa llave. Revisa que la hayas copiado completa y que sea de esta cuenta.',
      'LLAVE_INVALIDA',
      400,
    );
  }
  if (faltan.length) {
    throw new EnlacePagoError(
      `A la llave le falta permiso de ${faltan.join(' y ')}. En Stripe edita la clave restringida y marca Customers e Invoices en "Write".`,
      'LLAVE_SIN_PERMISOS',
      400,
    );
  }

  // Nombre e id de la cuenta: solo si la llave lo permite (una restringida
  // normalmente no). Se muestra en la pantalla, no es necesario para cobrar.
  let account_id = null;
  let account_nombre = null;
  try {
    const acc = await stripe.accounts.retrieve();
    account_id = acc?.id || null;
    account_nombre =
      acc?.settings?.dashboard?.display_name ||
      acc?.business_profile?.name ||
      null;
  } catch (e) {
    /* sin permiso de cuenta: no pasa nada */
  }
  return { modo: modoDeLlave(key), account_id, account_nombre };
}

// 401 = la llave no existe/está revocada; 403 = existe pero le falta permiso.
const esLlaveInvalida = (e) =>
  e?.statusCode === 401 || e?.type === 'StripeAuthenticationError';

/* ────────────────────────── contacto ↔ customer ────────────────────────── */

async function contactoDe(id_configuracion, id_cliente) {
  const [row] = await db.query(
    `SELECT id, nombre_cliente, apellido_cliente, email_cliente, celular_cliente
       FROM clientes_chat_center
      WHERE id = ? AND id_configuracion = ?
      LIMIT 1`,
    {
      replacements: [id_cliente, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  return row || null;
}

const nombreContacto = (c) =>
  [c?.nombre_cliente, c?.apellido_cliente]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ') || null;

/**
 * Customer de Stripe del contacto, reusando el de un enlace anterior y si no
 * buscándolo por metadata; se crea recién si no existe. El email es opcional:
 * sin él Stripe igual acepta la factura y el pago con tarjeta.
 */
async function customerDe(stripe, id_configuracion, contacto) {
  const previo = await EnlacesPago.findOne({
    where: {
      id_configuracion,
      id_cliente_chat_center: contacto.id,
    },
    order: [['id', 'DESC']],
  });
  if (previo?.stripe_customer_id) {
    try {
      const c = await stripe.customers.retrieve(previo.stripe_customer_id);
      if (c && !c.deleted) return c.id;
    } catch (e) {
      /* customer borrado en Stripe: se crea otro */
    }
  }

  try {
    const found = await stripe.customers.search({
      query: `metadata['chatcenter_cliente']:'${contacto.id}' AND metadata['chatcenter_config']:'${id_configuracion}'`,
      limit: 1,
    });
    if (found?.data?.[0]?.id) return found.data[0].id;
  } catch (e) {
    /* search no disponible con esa llave: se crea */
  }

  const email = String(contacto.email_cliente || '').trim();
  const created = await stripe.customers.create({
    name: nombreContacto(contacto) || contacto.celular_cliente || undefined,
    phone: contacto.celular_cliente
      ? `+${String(contacto.celular_cliente).replace(/\D/g, '')}`
      : undefined,
    ...(email && /\S+@\S+\.\S+/.test(email) ? { email } : {}),
    metadata: {
      chatcenter_cliente: String(contacto.id),
      chatcenter_config: String(id_configuracion),
    },
  });
  return created.id;
}

/* ────────────────────────── crear / enviar ────────────────────────── */

const fmtMonto = (monto, moneda) =>
  `${String(moneda || 'usd').toUpperCase()} ${Number(monto).toFixed(2)}`;

/**
 * Crea la factura en el Stripe de la cuenta y guarda la fila. No envía nada.
 */
async function crearEnlacePago({
  id_configuracion,
  id_cliente,
  monto,
  moneda,
  concepto,
  origen = 'asesor',
  id_sub_usuario = null,
  dias_vencimiento = DIAS_VENCIMIENTO,
}) {
  const entry = await stripeDeConfig(id_configuracion);
  if (!entry) {
    throw new EnlacePagoError(
      'Esta cuenta no tiene Stripe vinculado. Vincúlalo en Integraciones → Stripe.',
      'SIN_STRIPE',
      400,
    );
  }
  const { stripe, integ } = entry;

  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum < MONTO_MINIMO) {
    throw new EnlacePagoError(
      `El monto mínimo es ${MONTO_MINIMO.toFixed(2)}.`,
      'MONTO_INVALIDO',
      400,
    );
  }
  const currency = String(moneda || integ.moneda_default || 'usd')
    .toLowerCase()
    .slice(0, 3);
  const descripcion = String(concepto || '')
    .trim()
    .slice(0, 255);
  if (!descripcion) {
    throw new EnlacePagoError('Falta el concepto del cobro.', 'SIN_CONCEPTO');
  }

  const contacto = await contactoDe(id_configuracion, id_cliente);
  if (!contacto)
    throw new EnlacePagoError('Contacto no encontrado.', 'SIN_CONTACTO', 404);

  const customer = await customerDe(stripe, id_configuracion, contacto);

  const metadata = {
    chatcenter_config: String(id_configuracion),
    chatcenter_cliente: String(contacto.id),
    origen,
  };

  // Factura en borrador → ítem → finalizar (recién ahí existe la URL de pago).
  const draft = await stripe.invoices.create({
    customer,
    collection_method: 'send_invoice',
    days_until_due: Math.max(1, Number(dias_vencimiento) || DIAS_VENCIMIENTO),
    auto_advance: false,
    currency,
    description: descripcion,
    metadata,
  });
  await stripe.invoiceItems.create({
    customer,
    invoice: draft.id,
    currency,
    unit_amount: Math.round(montoNum * 100),
    quantity: 1,
    description: descripcion,
  });
  const invoice = await stripe.invoices.finalizeInvoice(draft.id);

  const fila = await EnlacesPago.create({
    id_configuracion,
    id_cliente_chat_center: contacto.id,
    id_sub_usuario: id_sub_usuario || null,
    origen,
    stripe_customer_id: customer,
    stripe_invoice_id: invoice.id,
    stripe_payment_intent:
      typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent?.id || null,
    url_pago: invoice.hosted_invoice_url,
    url_pdf: invoice.invoice_pdf || null,
    monto: montoNum.toFixed(2),
    moneda: currency,
    concepto: descripcion,
    estado: 'pendiente',
    vence_at: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    ultimo_check_at: new Date(),
  });

  return { enlace: fila, contacto };
}

/**
 * Texto que se manda por WhatsApp. El asesor puede escribir el suyo; si no
 * incluye {enlace}, la URL se agrega al final.
 */
function textoMensaje({ enlace, contacto, mensaje }) {
  const url = enlace.url_pago;
  const propio = String(mensaje || '').trim();
  if (propio) {
    return propio.includes('{enlace}')
      ? propio.replace(/\{enlace\}/g, url)
      : `${propio}\n${url}`;
  }
  const nombre = nombreContacto(contacto);
  return (
    `${nombre ? `Hola ${nombre.split(' ')[0]}, ` : 'Hola, '}` +
    `aquí tienes tu enlace de pago por ${fmtMonto(enlace.monto, enlace.moneda)} ` +
    `(${enlace.concepto}):\n${url}`
  );
}

/**
 * Manda el enlace como mensaje de texto por WhatsApp desde el número de la
 * cuenta y lo persiste como mensaje saliente (mismo camino que el chat).
 * Solo entra dentro de la ventana de 24 h; fuera de ella Meta lo rechaza y
 * el error se devuelve tal cual para que el asesor use una plantilla.
 */
async function enviarEnlacePorWhatsapp({
  enlace,
  contacto,
  mensaje,
  responsable,
}) {
  const dataAdmin = await chatService.getDataAdmin(enlace.id_configuracion);
  const to = String(contacto.celular_cliente || '').replace(/\D/g, '');
  if (!to)
    throw new EnlacePagoError(
      'El contacto no tiene número de WhatsApp.',
      'SIN_TELEFONO',
    );

  const texto = textoMensaje({ enlace, contacto, mensaje });
  const resp = await chatService.sendMessage({
    mensaje: texto,
    to,
    dataAdmin,
    tipo_mensaje: 'text',
    id_configuracion: enlace.id_configuracion,
    nombre_encargado: responsable || null,
  });
  const nuevo = resp?.mensajeNuevo || null;
  if (nuevo?.id) {
    enlace.id_mensaje = nuevo.id;
    await enlace.save();
  }
  if (global.io && nuevo) {
    // El front (Chat.jsx → onUpdateChat) espera el contacto en `chat` y en
    // `message.clientePorCelular` (id_encargado, nombre, celular): sin eso,
    // si el chat no estaba en la lista de la izquierda, reventaba al leer
    // nombre_encargado de null. Mismo shape que chat.controller.js.
    const [cli] = await db.query(
      `SELECT c.id, c.id_configuracion, c.nombre_cliente, c.apellido_cliente,
              c.celular_cliente, c.id_encargado, s.nombre_encargado
         FROM clientes_chat_center c
         LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = c.id_encargado
        WHERE c.id = ? LIMIT 1`,
      {
        replacements: [enlace.id_cliente_chat_center],
        type: db.QueryTypes.SELECT,
      },
    );
    const chat = cli
      ? {
          id: cli.id,
          id_configuracion: cli.id_configuracion,
          nombre_cliente: cli.nombre_cliente,
          apellido_cliente: cli.apellido_cliente,
          celular_cliente: cli.celular_cliente,
          id_encargado: cli.id_encargado ?? null,
          nombre_encargado: cli.nombre_encargado ?? null,
        }
      : null;
    const message = {
      ...(nuevo.toJSON ? nuevo.toJSON() : nuevo),
      clientePorCelular: chat,
    };
    global.io.emit('UPDATE_CHAT', {
      id_configuracion: enlace.id_configuracion,
      chatId: enlace.id_cliente_chat_center,
      source: 'wa',
      message,
      chat,
    });
  }
  return { texto, mensaje: nuevo };
}

/* ────────────────────────── estado ────────────────────────── */

function estadoDesdeInvoice(inv) {
  if (!inv) return null;
  if (inv.status === 'paid') return 'pagado';
  if (inv.status === 'void' || inv.status === 'uncollectible') return 'anulado';
  return 'pendiente';
}

/**
 * Consulta la factura y actualiza la fila. Si pasó a pagado avisa al chat
 * por socket (PAGO_RECIBIDO). Devuelve la fila actualizada.
 */
async function refrescarEstado(enlace, entryOpcional = null) {
  const entry =
    entryOpcional ||
    (await stripeDeConfig(enlace.id_configuracion, { soloConsulta: true }));
  if (!entry) return enlace;
  const { stripe } = entry;

  let inv;
  try {
    inv = await stripe.invoices.retrieve(enlace.stripe_invoice_id);
  } catch (e) {
    console.log(
      '[enlaces_pago] retrieve falló:',
      enlace.stripe_invoice_id,
      e?.message,
    );
    enlace.ultimo_check_at = new Date();
    await enlace.save();
    return enlace;
  }

  const nuevoEstado = estadoDesdeInvoice(inv);
  const anterior = enlace.estado;
  enlace.ultimo_check_at = new Date();
  if (inv.hosted_invoice_url) enlace.url_pago = inv.hosted_invoice_url;
  if (inv.invoice_pdf) enlace.url_pdf = inv.invoice_pdf;
  if (inv.payment_intent) {
    enlace.stripe_payment_intent =
      typeof inv.payment_intent === 'string'
        ? inv.payment_intent
        : inv.payment_intent.id;
  }

  if (nuevoEstado && nuevoEstado !== anterior) {
    enlace.estado = nuevoEstado;
    if (nuevoEstado === 'pagado') {
      const ts = inv.status_transitions?.paid_at;
      enlace.pagado_at = ts ? new Date(ts * 1000) : new Date();
    }
    if (nuevoEstado === 'anulado') {
      const ts =
        inv.status_transitions?.voided_at ||
        inv.status_transitions?.marked_uncollectible_at;
      enlace.anulado_at = ts ? new Date(ts * 1000) : new Date();
    }
  }
  await enlace.save();

  if (nuevoEstado === 'pagado' && anterior !== 'pagado' && global.io) {
    global.io.emit('PAGO_RECIBIDO', {
      id_configuracion: enlace.id_configuracion,
      chatId: enlace.id_cliente_chat_center,
      enlace: enlace.toJSON ? enlace.toJSON() : enlace,
    });
  }
  return enlace;
}

/**
 * Refresca los pendientes. Con id_cliente, solo los de ese contacto (al abrir
 * el chat); sin él, los de toda la plataforma (cron). `minutos` evita
 * consultar Stripe más de una vez cada tanto por fila.
 */
async function sincronizarPendientes({
  id_configuracion = null,
  id_cliente = null,
  minutos = 2,
  limite = 200,
} = {}) {
  const where = {
    estado: 'pendiente',
  };
  if (id_configuracion) where.id_configuracion = id_configuracion;
  if (id_cliente) where.id_cliente_chat_center = id_cliente;

  const filas = await EnlacesPago.findAll({
    where,
    order: [['id', 'DESC']],
    limit: limite,
  });
  const corte = Date.now() - minutos * 60 * 1000;
  let revisados = 0;
  let pagados = 0;
  const entries = new Map();
  for (const f of filas) {
    if (f.ultimo_check_at && new Date(f.ultimo_check_at).getTime() > corte)
      continue;
    // Más de 90 días pendiente: se deja de consultar (la factura sigue abierta
    // en Stripe, pero ya no vale la pena gastar llamadas).
    if (Date.now() - new Date(f.created_at).getTime() > 90 * 86400000) continue;
    let entry = entries.get(f.id_configuracion);
    if (entry === undefined) {
      entry = await stripeDeConfig(f.id_configuracion, { soloConsulta: true });
      entries.set(f.id_configuracion, entry);
    }
    if (!entry) continue;
    const antes = f.estado;
    await refrescarEstado(f, entry);
    revisados++;
    if (antes !== 'pagado' && f.estado === 'pagado') pagados++;
  }
  return { revisados, pagados };
}

async function anularEnlace(enlace) {
  const entry = await stripeDeConfig(enlace.id_configuracion, {
    soloConsulta: true,
  });
  if (!entry)
    throw new EnlacePagoError(
      'Esta cuenta no tiene Stripe vinculado.',
      'SIN_STRIPE',
    );
  if (enlace.estado === 'pagado') {
    throw new EnlacePagoError(
      'Ya está pagado: no se puede anular.',
      'YA_PAGADO',
    );
  }
  try {
    await entry.stripe.invoices.voidInvoice(enlace.stripe_invoice_id);
  } catch (e) {
    // Si Stripe ya la tenía anulada, se sincroniza y listo.
    if (!/void/i.test(String(e?.message || ''))) throw e;
  }
  return refrescarEstado(enlace, entry);
}

async function listarPorCliente(id_configuracion, id_cliente, limite = 50) {
  return EnlacesPago.findAll({
    where: { id_configuracion, id_cliente_chat_center: id_cliente },
    order: [['id', 'DESC']],
    limit: limite,
  });
}

module.exports = {
  EnlacePagoError,
  MONTO_MINIMO,
  modoDeLlave,
  validarLlave,
  integracionActiva,
  stripeDeConfig,
  olvidarCache,
  crearEnlacePago,
  enviarEnlacePorWhatsapp,
  refrescarEstado,
  sincronizarPendientes,
  anularEnlace,
  listarPorCliente,
  fmtMonto,
};
