'use strict';

/**
 * services/combos.service.js
 *
 * Combos vendidos fuera de la plataforma (el cliente paga por otro canal) que
 * incluyen meses gratis de un plan y complementos. El super admin los activa
 * por correo desde el dashboard.
 *
 * El primero es el Combo Implementación ($297, lanzado el 11-11-2026):
 * implementación completa + 6 meses de ImporChat + ImporKiller completo.
 *
 * QUÉ PASA SEGÚN CÓMO ESTÉ LA CUENTA
 *  - Suscripción viva (active/trialing): se actualiza EN SITIO. Se le pone
 *    prueba gratis hasta la fecha del combo y se le agrega el complemento como
 *    un item más. Conserva tarjeta, conexiones adicionales y metadata. No se
 *    recrea la suscripción (crearSuscripcionCortesia sí lo hace y pierde los
 *    complementos).
 *  - Sin suscripción viva pero con tarjeta guardada: se crea la suscripción
 *    con la prueba gratis, igual que una cortesía.
 *  - Sin tarjeta: queda "pendiente de tarjeta". La cuenta entra ya con el
 *    plan y el complemento, y al crear su primera conexión se le pide la
 *    tarjeta (CARD_CAPTURE_REQUIRED, la misma puerta del Plan Method
 *    Ecommerce). Los meses empiezan a contar ese día.
 *  - Sin cuenta: queda "pendiente de cuenta" por correo. Al registrarse (o
 *    entrar por Imporsuit) pasa a "pendiente de tarjeta".
 *
 * Al terminar los meses gratis Stripe cobra el plan y el complemento cada
 * mes, como a cualquier cliente.
 */

const { db } = require('../database/config');
const { PLAN_IC_ID } = require('../config/planes.config');
const accesoPermanente = require('./acceso_permanente.service');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const COMBOS = {
  implementacion_297: {
    clave: 'implementacion_297',
    nombre: 'Combo Implementación',
    precio: 297,
    meses: 6,
    id_plan: PLAN_IC_ID,
    addons: ['imporkiller'],
    incluye: [
      'Implementación completa',
      '6 meses de ImporChat',
      'ImporKiller completo (extensión y anuncios)',
    ],
  },
};

const MAX_MESES = 12;

// Una sub en estos estados se actualiza en sitio; el resto de las vivas
// (past_due, unpaid, incomplete) arrastra una factura sin pagar y se reemplaza.
const SUB_SANA = new Set(['active', 'trialing']);

// Columnas de usuarios_chat_center que un complemento puede encender. El
// nombre se interpola en el UPDATE: nunca sale de aquí sin pasar por la lista.
const COLUMNAS_ADDON = new Set([
  'conexiones_adicionales',
  'subusuarios_adicionales',
  'imporkiller',
]);

const fallo = (msg, statusCode = 400) =>
  Object.assign(new Error(msg), { statusCode });

const q = (sql, replacements = []) =>
  db.query(sql, { replacements, type: db.QueryTypes.SELECT });

const normalizarCorreo = (email) =>
  String(email || '')
    .trim()
    .toLowerCase();

const masMeses = (meses, desde = new Date()) => {
  const d = new Date(desde);
  d.setMonth(d.getMonth() + meses);
  return d;
};

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS combos_otorgados_chat_center (
      id INT AUTO_INCREMENT PRIMARY KEY,
      clave VARCHAR(40) NOT NULL,
      email VARCHAR(190) NOT NULL,
      id_usuario INT NULL,
      id_plan INT NOT NULL,
      meses INT NOT NULL,
      addons VARCHAR(190) NOT NULL DEFAULT '',
      monto DECIMAL(10,2) NOT NULL DEFAULT 0,
      estado ENUM('pendiente_cuenta','pendiente_tarjeta','aplicado','anulado') NOT NULL,
      modo VARCHAR(30) NULL,
      stripe_subscription_id VARCHAR(80) NULL,
      gratis_hasta DATETIME NULL,
      nota VARCHAR(500) NULL,
      otorgado_por_id INT NULL,
      otorgado_por_nombre VARCHAR(120) NULL,
      aplicado_en DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY ix_combo_email (email),
      KEY ix_combo_usuario (id_usuario, estado)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  tablaLista = true;
}

async function leerCuenta({ id_usuario, email }) {
  const rows = id_usuario
    ? await q(
        `SELECT * FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`,
        [id_usuario],
      )
    : await q(
        `SELECT * FROM usuarios_chat_center WHERE email_propietario = ? LIMIT 1`,
        [email],
      );
  return rows?.[0] || null;
}

async function leerPlan(id_plan) {
  const rows = await q(
    `SELECT id_plan, nombre_plan, activo, precio_plan, id_price, tools_access
       FROM planes_chat_center WHERE id_plan = ? LIMIT 1`,
    [id_plan],
  );
  return rows?.[0] || null;
}

async function leerAddons(claves) {
  if (!claves?.length) return [];
  const rows = await q(
    `SELECT clave, nombre, precio, id_price_prod, id_price_test, target_columna
       FROM addons_chat_center WHERE activo = 1 AND clave IN (?)`,
    [claves],
  );
  return (rows || []).map((a) => ({
    clave: a.clave,
    nombre: a.nombre,
    precio: Number(a.precio || 0),
    price: isProd ? a.id_price_prod : a.id_price_test || a.id_price_prod,
    target_columna: a.target_columna,
  }));
}

/** Todos los precios que son complemento: para saber cuál item es el plan. */
async function preciosDeAddons() {
  const rows = await q(
    `SELECT id_price_prod, id_price_test FROM addons_chat_center`,
  );
  const set = new Set();
  for (const a of rows || []) {
    if (a.id_price_prod) set.add(a.id_price_prod);
    if (a.id_price_test) set.add(a.id_price_test);
  }
  return set;
}

async function encenderAddonsEnBD(id_usuario, addons) {
  for (const a of addons) {
    if (!COLUMNAS_ADDON.has(a.target_columna)) continue;
    await db.query(
      `UPDATE usuarios_chat_center
          SET ${a.target_columna} = GREATEST(COALESCE(${a.target_columna}, 0), 1)
        WHERE id_usuario = ?`,
      { replacements: [id_usuario] },
    );
  }
}

/** Combo que espera la tarjeta del cliente. Nunca lanza: lo usan middlewares. */
async function comboPendienteDeUsuario(id_usuario) {
  if (!id_usuario) return null;
  try {
    await asegurarTabla();
    const rows = await q(
      `SELECT * FROM combos_otorgados_chat_center
        WHERE id_usuario = ? AND estado = 'pendiente_tarjeta'
        ORDER BY id DESC LIMIT 1`,
      [id_usuario],
    );
    return rows?.[0] || null;
  } catch (e) {
    console.warn('[combos] no se pudo leer el combo pendiente:', e?.message);
    return null;
  }
}

/**
 * Decide qué se haría, sin escribir nada. La vista previa del panel y la
 * ejecución parten de aquí, así no pueden decidir distinto.
 *
 * @param {object} p
 * @param {import('stripe')} p.stripe
 * @param {string} [p.email]
 * @param {number} [p.id_usuario]
 * @param {string} [p.clave]
 * @param {number} [p.id_plan]   plan a dar; sin él se decide solo (ver abajo)
 * @param {number} [p.meses]
 * @param {'hoy'|'sumar'} [p.desde] 'sumar' cuenta los meses desde donde termina
 *                                  lo que la cuenta ya tiene cubierto
 */
async function prepararCombo({
  stripe,
  email,
  id_usuario,
  clave = 'implementacion_297',
  id_plan,
  meses,
  desde = 'hoy',
}) {
  const combo = COMBOS[clave];
  if (!combo) throw fallo(`Combo "${clave}" no existe`);
  if (!stripe) throw fallo('Sin cliente de Stripe configurado', 500);

  const correo = normalizarCorreo(email);
  if (!id_usuario && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    throw fallo('Correo inválido');
  }

  const n = parseInt(meses, 10) || combo.meses;
  if (n < 1 || n > MAX_MESES) {
    throw fallo(`meses debe estar entre 1 y ${MAX_MESES}`);
  }

  await asegurarTabla();
  const cuenta = await leerCuenta({ id_usuario, email: correo });
  const correoFinal = normalizarCorreo(cuenta?.email_propietario) || correo;

  const previos = cuenta
    ? await q(
        `SELECT * FROM combos_otorgados_chat_center
          WHERE clave = ? AND estado <> 'anulado'
            AND (id_usuario = ? OR email = ?)
          ORDER BY id DESC`,
        [clave, cuenta.id_usuario, correoFinal],
      )
    : await q(
        `SELECT * FROM combos_otorgados_chat_center
          WHERE clave = ? AND estado <> 'anulado' AND email = ?
          ORDER BY id DESC`,
        [clave, correoFinal],
      );

  // Plan: el pedido; si no, el que ya tiene cuando ya incluye el chat (quien
  // está en Method Ecommerce o Pro no baja a ImporChat por comprar el combo);
  // si no, el del combo.
  const planActual = cuenta?.id_plan ? await leerPlan(cuenta.id_plan) : null;
  const conservaPlan =
    planActual &&
    Number(planActual.activo) === 1 &&
    planActual.id_price &&
    ['imporchat', 'both'].includes(
      String(planActual.tools_access || '').toLowerCase(),
    );
  const idPlanFinal =
    Number(id_plan) || (conservaPlan ? planActual.id_plan : combo.id_plan);
  const plan = await leerPlan(idPlanFinal);
  if (!plan || Number(plan.activo) !== 1) {
    throw fallo('El plan elegido no existe o está inactivo');
  }
  if (!plan.id_price) throw fallo('El plan no tiene id_price en Stripe');

  const addons = await leerAddons(combo.addons);
  const faltan = combo.addons.filter(
    (c) => !addons.some((a) => a.clave === c && a.price),
  );
  if (faltan.length) {
    throw fallo(`Complemento sin precio en Stripe: ${faltan.join(', ')}`, 500);
  }

  const out = {
    combo: { ...combo, meses: n },
    email: correoFinal,
    cuenta: cuenta
      ? {
          id_usuario: cuenta.id_usuario,
          nombre: cuenta.nombre,
          email: cuenta.email_propietario,
          estado: cuenta.estado,
          permanente: Number(cuenta.permanente || 0),
          plan_actual: planActual?.nombre_plan || null,
          stripe_subscription_id: cuenta.stripe_subscription_id || null,
          stripe_subscription_status: cuenta.stripe_subscription_status || null,
          fecha_renovacion: cuenta.fecha_renovacion || null,
        }
      : null,
    plan: {
      id_plan: plan.id_plan,
      nombre: plan.nombre_plan,
      precio: Number(plan.precio_plan || 0),
      id_price: plan.id_price,
    },
    addons,
    caso: null,
    desde,
    gratis_hasta: null,
    cubierto_hasta: null,
    tarjeta: null,
    cobro_mensual_despues: 0,
    avisos: [],
    previos: (previos || []).map((p) => ({
      id: p.id,
      estado: p.estado,
      creado: p.created_at,
      gratis_hasta: p.gratis_hasta,
      otorgado_por: p.otorgado_por_nombre,
    })),
    // Uso interno de otorgarCombo; no sale al panel.
    _interno: { cuenta, sub: null, customerId: null, otrosItems: 0 },
  };

  const ahora = new Date();

  // ── Sin cuenta ──
  if (!cuenta) {
    out.caso = 'sin_cuenta';
    out.cobro_mensual_despues =
      out.plan.precio + addons.reduce((t, a) => t + a.precio, 0);
    out.avisos.push(
      'No existe una cuenta con este correo. El combo queda guardado y se activa solo cuando se registre con ese mismo correo.',
    );
    return out;
  }

  if (Number(cuenta.permanente) === 1) {
    out.caso = 'permanente';
    out.avisos.push(
      'La cuenta es permanente: ya tiene acceso sin cobro y con ImporKiller incluido. No hay nada que activar.',
    );
    return out;
  }

  // ── Stripe: suscripción y tarjeta ──
  let sub = null;
  if (cuenta.stripe_subscription_id) {
    try {
      sub = await stripe.subscriptions.retrieve(cuenta.stripe_subscription_id, {
        expand: ['items.data.price'],
      });
    } catch (e) {
      out.avisos.push(
        `No se pudo leer la suscripción ${cuenta.stripe_subscription_id} en Stripe (${e?.message}). Se trata como cuenta sin suscripción.`,
      );
    }
  }
  out._interno.sub = sub;

  let customerId = cuenta.id_costumer || null;
  if (!customerId) {
    const existentes = await stripe.customers.list({
      email: cuenta.email_propietario,
      limit: 1,
    });
    customerId = existentes?.data?.[0]?.id || null;
  }
  if (customerId) {
    const { customer, tarjeta } = await accesoPermanente.tarjetaDelCustomer(
      stripe,
      customerId,
    );
    if (!customer) customerId = null;
    out.tarjeta = tarjeta;
  }
  out._interno.customerId = customerId;

  const sana = sub && SUB_SANA.has(sub.status);
  const vivaConDeuda =
    sub && !sana && accesoPermanente.SUB_VIVA.has(String(sub.status));

  // Hasta dónde tiene cubierto hoy (prueba o periodo pagado).
  let cubierto = null;
  if (sana) {
    const finPeriodo =
      sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
    const fin =
      sub.status === 'trialing' && sub.trial_end ? sub.trial_end : finPeriodo;
    if (fin) cubierto = new Date(fin * 1000);
  } else if (
    !sub &&
    cuenta.fecha_renovacion &&
    String(cuenta.estado || '').toLowerCase() === 'activo'
  ) {
    cubierto = new Date(cuenta.fecha_renovacion);
  }
  if (cubierto && cubierto <= ahora) cubierto = null;
  out.cubierto_hasta = cubierto;

  // Nunca se le acorta lo que ya tiene.
  let hasta = masMeses(n, desde === 'sumar' && cubierto ? cubierto : ahora);
  if (cubierto && cubierto > hasta) hasta = cubierto;
  out.gratis_hasta = hasta;

  if (sana) {
    out.caso = 'sub_viva';
    const preciosAddon = await preciosDeAddons();
    const items = sub.items?.data || [];
    const otros = items.filter(
      (it) =>
        preciosAddon.has(it.price?.id) &&
        !addons.some((a) => a.price === it.price?.id),
    );
    out._interno.otrosItems = otros.length;
    out.cobro_mensual_despues =
      out.plan.precio +
      addons.reduce((t, a) => t + a.precio, 0) +
      otros.reduce(
        (t, it) =>
          t + ((it.price?.unit_amount || 0) / 100) * Number(it.quantity || 1),
        0,
      );

    if (sub.cancel_at_period_end || sub.cancel_at) {
      out.avisos.push(
        'La suscripción tiene una cancelación programada: se anula para que siga activa durante el combo.',
      );
    }
    if (sub.schedule) {
      out.avisos.push(
        'La suscripción tiene un cambio de plan programado: se descarta al aplicar el combo.',
      );
    }
    if (sub.status === 'active' && desde !== 'sumar' && cubierto) {
      out.avisos.push(
        `Tiene pagado hasta el ${cubierto.toISOString().slice(0, 10)}. Contando desde hoy, esos días pagados quedan dentro de los meses gratis; con «sumar» se le respetan.`,
      );
    }
    try {
      const pend = await stripe.invoiceItems.list({
        customer: customerId,
        pending: true,
        limit: 20,
      });
      const total = (pend?.data || []).reduce(
        (t, i) => t + Number(i.amount || 0),
        0,
      );
      if (total > 0) {
        out.avisos.push(
          `Tiene $${(total / 100).toFixed(2)} en cargos pendientes (complementos agregados a mitad de ciclo). Stripe los factura al instante al empezar la prueba gratis.`,
        );
      }
    } catch (e) {
      /* solo informativo */
    }
  } else {
    out.caso = out.tarjeta ? 'con_tarjeta' : 'sin_tarjeta';
    out.cobro_mensual_despues =
      out.plan.precio + addons.reduce((t, a) => t + a.precio, 0);
    if (vivaConDeuda) {
      out.avisos.push(
        `La suscripción actual está en ${sub.status} (cobro sin pagar): se cancela y se anulan sus facturas abiertas.`,
      );
    }
    if (out.caso === 'sin_tarjeta') {
      // Los meses corren desde que registra la tarjeta, no desde hoy.
      out.gratis_hasta = null;
      out.avisos.push(
        `No tiene tarjeta guardada. Entra ya con el plan y el complemento; al crear su primera conexión se le pide la tarjeta y los ${n} meses empiezan a contar ese día.`,
      );
    }
  }

  if (out.previos.length) {
    out.avisos.push(
      'A este correo ya se le otorgó este combo antes. Revise la lista antes de repetirlo.',
    );
  }

  return out;
}

const sinInterno = (p) => {
  const { _interno, ...resto } = p;
  return resto;
};

async function registrarCombo(datos) {
  const [id] = await db.query(
    `INSERT INTO combos_otorgados_chat_center
       (clave, email, id_usuario, id_plan, meses, addons, monto, estado, modo,
        stripe_subscription_id, gratis_hasta, nota, otorgado_por_id,
        otorgado_por_nombre, aplicado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        datos.clave,
        datos.email,
        datos.id_usuario || null,
        datos.id_plan,
        datos.meses,
        datos.addons,
        datos.monto,
        datos.estado,
        datos.modo || null,
        datos.stripe_subscription_id || null,
        datos.gratis_hasta || null,
        datos.nota || null,
        datos.ejecutor?.id || null,
        datos.ejecutor?.nombre || 'sistema',
        datos.estado === 'aplicado' ? new Date() : null,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  return id;
}

/**
 * Deja la cuenta dentro, con plan y complemento, a la espera de la tarjeta.
 * Mismo estado que un alumno de Method Ecommerce recién llegado: sin
 * suscripción de Stripe, activo y con fecha de renovación a futuro.
 */
async function dejarPendienteDeTarjeta({ cuenta, plan, addons, meses }) {
  const hasta = masMeses(meses);
  await db.query(
    `UPDATE usuarios_chat_center
        SET id_plan = ?,
            estado = 'activo',
            tipo_plan = 'mensual',
            fecha_inicio = COALESCE(fecha_inicio, NOW()),
            fecha_renovacion = ?,
            trial_end = NULL,
            stripe_subscription_id = NULL,
            stripe_subscription_status = NULL,
            cancel_at_period_end = 0,
            cancel_at = NULL,
            canceled_at = NULL,
            updated_at = NOW()
      WHERE id_usuario = ?`,
    { replacements: [plan.id_plan, hasta, cuenta.id_usuario] },
  );
  await encenderAddonsEnBD(cuenta.id_usuario, addons);
  await accesoPermanente.invalidarCacheDeLaCuenta(cuenta.id_usuario);
  return hasta;
}

/**
 * Activa el combo. Si Stripe falla no se toca la BD.
 *
 * @param {object} p  lo mismo que prepararCombo, más:
 * @param {{id:number|null,nombre:string}} p.ejecutor
 * @param {boolean} [p.repetir] permite otorgarlo aunque ya se le haya dado
 * @param {string} [p.nota]
 */
async function otorgarCombo({ ejecutor, repetir = false, nota, ...params }) {
  const { stripe } = params;
  const prev = await prepararCombo(params);
  const { cuenta, sub, otrosItems, customerId } = prev._interno;
  const { combo, plan, addons } = prev;
  const meses = combo.meses;

  if (prev.caso === 'permanente') {
    throw fallo('La cuenta es permanente: no necesita el combo');
  }
  const pendiente = prev.previos.find((p) => p.estado !== 'aplicado');
  if (pendiente) {
    throw fallo(
      'Este correo ya tiene el combo pendiente de activarse. Anúlelo antes de otorgarlo otra vez.',
      409,
    );
  }
  if (prev.previos.length && !repetir) {
    throw fallo(
      'A este correo ya se le otorgó este combo. Confirme que quiere repetirlo.',
      409,
    );
  }

  const base = {
    clave: combo.clave,
    email: prev.email,
    id_usuario: cuenta?.id_usuario || null,
    id_plan: plan.id_plan,
    meses,
    addons: combo.addons.join(','),
    monto: combo.precio,
    nota: nota ? String(nota).slice(0, 500) : null,
    ejecutor,
  };

  const textoIncluye = `${meses} mes(es) gratis de ${plan.nombre}${
    addons.length ? ` con ${addons.map((a) => a.nombre).join(', ')}` : ''
  }`;

  // ── Sin cuenta: se guarda por correo ──
  if (prev.caso === 'sin_cuenta') {
    const id = await registrarCombo({ ...base, estado: 'pendiente_cuenta' });
    console.log(
      `[combos] ${ejecutor.nombre} dejó ${combo.nombre} pendiente de cuenta para ${prev.email}`,
    );
    return {
      ...sinInterno(prev),
      id,
      estado: 'pendiente_cuenta',
      mensaje: `${combo.nombre} guardado para ${prev.email}. Se activa cuando se registre con ese correo.`,
    };
  }

  const id_usuario = cuenta.id_usuario;
  const metaCombo = {
    id_usuario: String(id_usuario),
    id_plan: String(plan.id_plan),
    combo: combo.clave,
    combo_meses: String(meses),
  };
  for (const a of addons) metaCombo[`addon_${a.clave}_qty`] = '1';

  let estado;
  let modo;
  let subId = null;
  let gratisHasta = prev.gratis_hasta;
  const detalle = [];

  if (prev.caso === 'sub_viva') {
    // ── Suscripción viva: se actualiza en sitio ──
    if (sub.schedule) await stripe.subscriptionSchedules.release(sub.schedule);

    const preciosAddon = await preciosDeAddons();
    const items = sub.items?.data || [];
    const itemPlan =
      items.find((it) => !preciosAddon.has(it.price?.id)) || items[0];
    const cambios = [];
    if (itemPlan && itemPlan.price?.id !== plan.id_price) {
      cambios.push({ id: itemPlan.id, price: plan.id_price });
    }
    for (const a of addons) {
      if (!items.some((it) => it.price?.id === a.price)) {
        cambios.push({ price: a.price, quantity: 1 });
      }
    }

    const actualizada = await stripe.subscriptions.update(sub.id, {
      ...(cambios.length ? { items: cambios } : {}),
      trial_end: Math.floor(gratisHasta.getTime() / 1000),
      proration_behavior: 'none',
      // No se pueden mandar los dos: cada forma de cancelación se deshace
      // con su propio parámetro.
      ...(sub.cancel_at_period_end
        ? { cancel_at_period_end: false }
        : sub.cancel_at
          ? { cancel_at: '' }
          : {}),
      metadata: { ...(sub.metadata || {}), ...metaCombo },
    });
    subId = actualizada.id;
    estado = 'aplicado';
    modo = 'sub_actualizada';

    await db.query(
      `UPDATE usuarios_chat_center
          SET stripe_subscription_status = ?,
              id_plan = ?,
              estado = 'activo',
              trial_end = ?,
              fecha_renovacion = ?,
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
          actualizada.status,
          plan.id_plan,
          gratisHasta,
          gratisHasta,
          id_usuario,
        ],
      },
    );
    detalle.push(
      `Se actualizó su suscripción ${sub.id}` +
        (otrosItems ? ' (conserva sus otros complementos)' : '') +
        '.',
    );
  } else {
    // ── Sin suscripción sana ──
    if (sub && accesoPermanente.SUB_VIVA.has(String(sub.status))) {
      const r = await accesoPermanente.cancelarSuscripcionStripe(stripe, sub.id);
      if (r.cancelada) {
        detalle.push(
          `Se canceló la suscripción anterior ${sub.id} (${sub.status})` +
            (r.facturas_anuladas
              ? ` y se anularon ${r.facturas_anuladas} factura(s).`
              : '.'),
        );
      }
    }

    if (prev.caso === 'con_tarjeta') {
      const nueva = await stripe.subscriptions.create({
        customer: customerId,
        items: [
          { price: plan.id_price, quantity: 1 },
          ...addons.map((a) => ({ price: a.price, quantity: 1 })),
        ],
        trial_end: Math.floor(gratisHasta.getTime() / 1000),
        default_payment_method: prev.tarjeta.id,
        proration_behavior: 'none',
        metadata: {
          ...metaCombo,
          id_plataforma: '',
          periodo: 'mensual',
          origen: 'panel_admin',
        },
      });
      subId = nueva.id;
      estado = 'aplicado';
      modo = 'sub_creada';

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
            nueva.id,
            nueva.status,
            plan.id_plan,
            gratisHasta,
            gratisHasta,
            id_usuario,
          ],
        },
      );
      detalle.push(
        `Se creó la suscripción ${nueva.id} con la tarjeta ${prev.tarjeta.marca} ${prev.tarjeta.ultimos4}.`,
      );
    } else {
      // Sin tarjeta: entra ya y la tarjeta se le pide al crear la conexión.
      gratisHasta = await dejarPendienteDeTarjeta({
        cuenta,
        plan,
        addons,
        meses,
      });
      estado = 'pendiente_tarjeta';
      modo = 'checkout';
      detalle.push(
        'Sin tarjeta guardada: se le pedirá al crear su primera conexión y los meses cuentan desde ese día.',
      );
    }
  }

  if (estado === 'aplicado') {
    await encenderAddonsEnBD(id_usuario, addons);
    await accesoPermanente.invalidarCacheDeLaCuenta(id_usuario);
  }

  const id = await registrarCombo({
    ...base,
    estado,
    modo,
    stripe_subscription_id: subId,
    gratis_hasta: gratisHasta,
  });

  const fechaTxt = gratisHasta.toISOString().slice(0, 10);
  const contenido =
    `${ejecutor.nombre} activó el ${combo.nombre} ($${combo.precio}): ${textoIncluye}` +
    (estado === 'aplicado'
      ? `, gratis hasta el ${fechaTxt}; desde ahí Stripe cobra $${prev.cobro_mensual_despues.toFixed(2)}/mes. `
      : '. ') +
    detalle.join(' ');
  await accesoPermanente.anotarSeguimiento(
    id_usuario,
    ejecutor,
    `${combo.nombre} activado`,
    contenido,
  );
  console.log(`[combos] ${contenido} (cuenta ${id_usuario})`);

  return {
    ...sinInterno(prev),
    id,
    estado,
    modo,
    stripe_subscription_id: subId,
    gratis_hasta: gratisHasta,
    mensaje:
      estado === 'aplicado'
        ? `${combo.nombre} activado: gratis hasta el ${fechaTxt}.`
        : `${combo.nombre} activado. Falta que el cliente registre su tarjeta al crear la conexión.`,
  };
}

/**
 * La cuenta acaba de nacer (registro o primer ingreso desde Imporsuit): si su
 * correo tenía un combo guardado, se le aplica. Nunca lanza.
 */
async function reclamarPorCorreo(email) {
  const correo = normalizarCorreo(email);
  if (!correo) return null;
  try {
    await asegurarTabla();
    const [pend] = await q(
      `SELECT * FROM combos_otorgados_chat_center
        WHERE email = ? AND estado = 'pendiente_cuenta'
        ORDER BY id DESC LIMIT 1`,
      [correo],
    );
    if (!pend) return null;

    const cuenta = await leerCuenta({ email: correo });
    if (!cuenta || Number(cuenta.permanente) === 1) return null;
    // Con suscripción ya no aplica en automático: lo resuelve el panel.
    if (cuenta.stripe_subscription_id) return null;

    const plan = await leerPlan(pend.id_plan);
    if (!plan) return null;
    const addons = await leerAddons(
      String(pend.addons || '')
        .split(',')
        .filter(Boolean),
    );

    const hasta = await dejarPendienteDeTarjeta({
      cuenta,
      plan,
      addons,
      meses: pend.meses,
    });
    await db.query(
      `UPDATE combos_otorgados_chat_center
          SET estado = 'pendiente_tarjeta', id_usuario = ?, modo = 'checkout',
              gratis_hasta = ?
        WHERE id = ?`,
      { replacements: [cuenta.id_usuario, hasta, pend.id] },
    );
    await accesoPermanente.anotarSeguimiento(
      cuenta.id_usuario,
      { id: null, nombre: 'sistema' },
      'Combo activado al registrarse',
      `La cuenta se creó con un ${COMBOS[pend.clave]?.nombre || pend.clave} guardado por ${pend.otorgado_por_nombre || 'el equipo'}: entra con ${plan.nombre_plan} y se le pedirá la tarjeta al crear su primera conexión.`,
    );
    console.log(
      `[combos] combo ${pend.id} reclamado por ${correo} (cuenta ${cuenta.id_usuario})`,
    );
    return { ...pend, id_usuario: cuenta.id_usuario };
  } catch (e) {
    console.warn('[combos] no se pudo reclamar el combo:', e?.message);
    return null;
  }
}

/**
 * Datos para el checkout que captura la tarjeta de un combo pendiente.
 * Los meses cuentan desde hoy (el día que registra la tarjeta).
 */
async function checkoutDeComboPendiente(pend) {
  const plan = await leerPlan(pend.id_plan);
  if (!plan?.id_price) return null;
  const addons = await leerAddons(
    String(pend.addons || '')
      .split(',')
      .filter(Boolean),
  );
  const trialEnd = masMeses(Number(pend.meses) || 1);
  const metadata = {
    id_plan: String(plan.id_plan),
    combo: pend.clave,
    combo_id: String(pend.id),
    combo_meses: String(pend.meses),
  };
  for (const a of addons) metadata[`addon_${a.clave}_qty`] = '1';
  return {
    plan,
    addons,
    trialEnd,
    line_items: [
      { price: plan.id_price, quantity: 1 },
      ...addons.filter((a) => a.price).map((a) => ({ price: a.price, quantity: 1 })),
    ],
    metadata,
    precio_despues:
      Number(plan.precio_plan || 0) + addons.reduce((t, a) => t + a.precio, 0),
  };
}

/** El checkout de un combo terminó: ya tiene suscripción. Nunca lanza. */
async function marcarAplicadoPorCheckout(combo_id, subscriptionId) {
  const id = parseInt(combo_id, 10);
  if (!id) return;
  try {
    await asegurarTabla();
    await db.query(
      `UPDATE combos_otorgados_chat_center
          SET estado = 'aplicado', stripe_subscription_id = ?,
              gratis_hasta = DATE_ADD(NOW(), INTERVAL meses MONTH),
              aplicado_en = NOW()
        WHERE id = ? AND estado = 'pendiente_tarjeta'`,
      { replacements: [subscriptionId || null, id] },
    );
  } catch (e) {
    console.warn('[combos] no se pudo marcar el combo aplicado:', e?.message);
  }
}

/** Anula un combo que todavía no se aplicó (correo mal escrito, devolución). */
async function anularCombo({ id, ejecutor }) {
  await asegurarTabla();
  const [c] = await q(
    `SELECT * FROM combos_otorgados_chat_center WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!c) throw fallo('Combo no encontrado', 404);
  if (c.estado === 'aplicado') {
    throw fallo(
      'El combo ya se aplicó en Stripe: se revierte desde la suscripción del cliente, no desde aquí.',
    );
  }
  if (c.estado === 'anulado') return c;
  await db.query(
    `UPDATE combos_otorgados_chat_center
        SET estado = 'anulado',
            nota = CONCAT(COALESCE(nota, ''), ?)
      WHERE id = ?`,
    { replacements: [` [anulado por ${ejecutor.nombre}]`, id] },
  );
  if (c.id_usuario) {
    await accesoPermanente.anotarSeguimiento(
      c.id_usuario,
      ejecutor,
      'Combo anulado',
      `${ejecutor.nombre} anuló el ${COMBOS[c.clave]?.nombre || c.clave} que estaba pendiente de tarjeta. La cuenta conserva el plan hasta su fecha de renovación.`,
    );
  }
  return { ...c, estado: 'anulado' };
}

async function listarCombos({ limite = 200 } = {}) {
  await asegurarTabla();
  return q(
    `SELECT c.id, c.clave, c.email, c.id_usuario, c.id_plan, c.meses, c.addons,
            c.monto, c.estado, c.modo, c.stripe_subscription_id, c.gratis_hasta,
            c.nota, c.otorgado_por_nombre, c.aplicado_en, c.created_at,
            u.nombre AS cuenta_nombre, p.nombre_plan
       FROM combos_otorgados_chat_center c
       LEFT JOIN usuarios_chat_center u ON u.id_usuario = c.id_usuario
       LEFT JOIN planes_chat_center p ON p.id_plan = c.id_plan
      ORDER BY c.id DESC
      LIMIT ?`,
    [Math.min(Math.max(parseInt(limite, 10) || 200, 1), 500)],
  );
}

const catalogo = () =>
  Object.values(COMBOS).map((c) => ({
    clave: c.clave,
    nombre: c.nombre,
    precio: c.precio,
    meses: c.meses,
    incluye: c.incluye,
  }));

module.exports = {
  COMBOS,
  catalogo,
  prepararCombo: async (p) => sinInterno(await prepararCombo(p)),
  otorgarCombo,
  anularCombo,
  listarCombos,
  comboPendienteDeUsuario,
  reclamarPorCorreo,
  checkoutDeComboPendiente,
  marcarAplicadoPorCheckout,
};
