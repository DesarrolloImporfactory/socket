'use strict';

/**
 * services/referidos.service.js
 *
 * Toda la mecánica del programa de referidos: códigos, devengo, reversión y
 * liquidación.
 *
 * DECISIONES QUE CONVIENE TENER PRESENTES ANTES DE TOCAR ESTE ARCHIVO
 *
 * 1. El dinero se maneja SIEMPRE en centavos enteros. Stripe entrega centavos;
 *    convertir a dólares y volver arrastra errores de redondeo que en un ledger
 *    de comisiones terminan en descuadres que nadie sabe explicar.
 *
 * 2. La idempotencia no se resuelve en código sino en la base: `invoice_id` es
 *    UNIQUE en `referidos_ciclos` y en `referidos_comisiones`. Stripe reintenta
 *    los webhooks —es su comportamiento normal, no un fallo— y sin ese UNIQUE
 *    cada reintento pagaría la comisión otra vez.
 *
 * 3. El porcentaje se guarda EN CADA FILA. Cambiar la escalera en
 *    `referidos.config.js` afecta a lo que se devengue de ahí en adelante y
 *    jamás reescribe lo ya devengado.
 *
 * 4. `referido_por` se sella en el registro y no se edita. Es la base de un
 *    pago real: si fuera editable, sería el primer sitio por donde entraría el
 *    fraude.
 */

const crypto = require('crypto');
const Stripe = require('stripe');
const { db } = require('../database/config');
const {
  CICLO_INICIO,
  porcentajeParaCiclo,
  DIAS_RETENCION,
  UMBRAL_TRANSFERENCIA_CENT,
  CODIGO_ALFABETO,
  CODIGO_LONGITUD,
  construirEnlace,
} = require('../config/referidos.config');

const isProd =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// Mismo criterio de selección de llave que stripe.controller.js.
const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });

const SELECT = { type: db.QueryTypes.SELECT };

// ═══════════════════════════════════════════════════════════════
// Códigos de referido
// ═══════════════════════════════════════════════════════════════

const generarCodigo = () => {
  const bytes = crypto.randomBytes(CODIGO_LONGITUD);
  let out = '';
  for (let i = 0; i < CODIGO_LONGITUD; i++) {
    out += CODIGO_ALFABETO[bytes[i] % CODIGO_ALFABETO.length];
  }
  return out;
};

/**
 * Devuelve el código del usuario, creándolo la primera vez que lo pide.
 *
 * Se genera perezosamente en vez de al registrarse para no tener que rellenar
 * la columna en todas las cuentas históricas: quien nunca abre la sección de
 * referidos no necesita código.
 *
 * El UPDATE lleva `codigo_referido IS NULL` en el WHERE: si dos pestañas abren
 * la sección a la vez, la segunda no pisa el código que ya ganó la primera.
 */
const obtenerOCrearCodigo = async (id_usuario) => {
  const [row] = await db.query(
    `SELECT codigo_referido FROM usuarios_chat_center WHERE id_usuario = ?`,
    { replacements: [id_usuario], ...SELECT },
  );
  if (!row) return null;
  if (row.codigo_referido) return row.codigo_referido;

  for (let intento = 0; intento < 6; intento++) {
    const codigo = generarCodigo();
    try {
      await db.query(
        `UPDATE usuarios_chat_center
            SET codigo_referido = ?
          WHERE id_usuario = ? AND codigo_referido IS NULL`,
        { replacements: [codigo, id_usuario] },
      );
    } catch (e) {
      // Choque contra el UNIQUE: se reintenta con otro código.
      continue;
    }
    const [check] = await db.query(
      `SELECT codigo_referido FROM usuarios_chat_center WHERE id_usuario = ?`,
      { replacements: [id_usuario], ...SELECT },
    );
    if (check?.codigo_referido) return check.codigo_referido;
  }
  return null;
};

/**
 * Traduce un código de la URL al usuario que lo repartió.
 *
 * `datosNuevo` trae el email y el WhatsApp de quien se está registrando para
 * cortar el autoreferido obvio —la misma persona abriendo una segunda cuenta
 * con su propio enlace para cobrarse a sí misma—. No pretende ser antifraude
 * completo: la coincidencia de tarjeta se revisa después, ya con el pago hecho.
 *
 * Ante cualquier duda devuelve null. Un código inválido nunca puede tumbar un
 * registro: perder una atribución cuesta mucho menos que perder un cliente.
 */
const resolverReferidor = async (codigo, datosNuevo = {}) => {
  const limpio = String(codigo || '')
    .trim()
    .toUpperCase()
    .slice(0, 16);
  if (!limpio) return null;

  const [ref] = await db.query(
    `SELECT id_usuario, email_propietario, whatsapp_lead, estado
       FROM usuarios_chat_center
      WHERE codigo_referido = ?
      LIMIT 1`,
    { replacements: [limpio], ...SELECT },
  );
  if (!ref) return null;

  const emailNuevo = String(datosNuevo.email || '')
    .toLowerCase()
    .trim();
  const emailRef = String(ref.email_propietario || '')
    .toLowerCase()
    .trim();
  if (emailNuevo && emailNuevo === emailRef) return null;

  const waNuevo = String(datosNuevo.whatsapp || '').replace(/\D/g, '');
  const waRef = String(ref.whatsapp_lead || '').replace(/\D/g, '');
  if (waNuevo && waRef && waNuevo.slice(-9) === waRef.slice(-9)) return null;

  return ref.id_usuario;
};

/** Datos públicos del referidor, para que el registro muestre quién invita. */
const infoPublicaPorCodigo = async (codigo) => {
  const limpio = String(codigo || '')
    .trim()
    .toUpperCase()
    .slice(0, 16);
  if (!limpio) return null;

  const [ref] = await db.query(
    `SELECT nombre FROM usuarios_chat_center WHERE codigo_referido = ? LIMIT 1`,
    { replacements: [limpio], ...SELECT },
  );
  if (!ref) return null;

  return { codigo: limpio, nombre: ref.nombre || 'un usuario de Imporchat' };
};

// ═══════════════════════════════════════════════════════════════
// Devengo
// ═══════════════════════════════════════════════════════════════

/**
 * Registra el ciclo de facturación y, si corresponde, devenga la comisión.
 *
 * Lo llama el webhook de Stripe en `invoice.payment_succeeded`. Nunca lanza:
 * un fallo aquí no puede tumbar el procesamiento del pago del cliente, que es
 * lo que de verdad importa en ese handler.
 *
 * El conteo de ciclos vive en `referidos_ciclos` y no se le pregunta a Stripe
 * en cada webhook. Además arranca en `referido_ciclos_previos`, que es lo que
 * permite que un usuario migrado desde el esquema viejo de comunidades entre
 * directo al ciclo que le toca en vez de volver a esperar tres meses.
 *
 * `montoFacturadoCent` es `invoice.total` —lo facturado ya con cupones y
 * descuentos— y NO `amount_paid`. Un mes saldado con el saldo a favor del
 * cliente llega con amount_paid = 0 y aun así es un mes vendido: con el otro
 * criterio, el referidor perdía ciclo y comisión por una decisión de su
 * referido que él ni ve.
 */
const devengarPorFactura = async ({
  id_usuario_referido,
  invoiceId,
  subscriptionId,
  montoFacturadoCent,
  moneda = 'usd',
}) => {
  try {
    if (!id_usuario_referido || !invoiceId) return null;
    if (!subscriptionId) return null; // Solo facturas de suscripción.

    const base = Number(montoFacturadoCent) || 0;
    if (base <= 0) return null; // Trials y facturas en $0 no cuentan ciclo.

    const [usuario] = await db.query(
      `SELECT referido_por, referido_ciclos_previos
         FROM usuarios_chat_center
        WHERE id_usuario = ?`,
      { replacements: [id_usuario_referido], ...SELECT },
    );
    if (!usuario?.referido_por) return null;

    const idReferidor = Number(usuario.referido_por);
    if (idReferidor === Number(id_usuario_referido)) return null;

    const previos = Number(usuario.referido_ciclos_previos) || 0;

    // Transacción con bloqueo sobre la fila del referido: dos facturas del
    // mismo usuario procesadas a la vez no pueden calcular el mismo ciclo.
    const resultado = await db.transaction(async (t) => {
      await db.query(
        `SELECT id_usuario FROM usuarios_chat_center WHERE id_usuario = ? FOR UPDATE`,
        { replacements: [id_usuario_referido], transaction: t },
      );

      const [ya] = await db.query(
        `SELECT ciclo_num FROM referidos_ciclos WHERE invoice_id = ?`,
        { replacements: [invoiceId], type: db.QueryTypes.SELECT, transaction: t },
      );
      if (ya) return { ciclo: Number(ya.ciclo_num), repetido: true };

      const [max] = await db.query(
        `SELECT COALESCE(MAX(ciclo_num), ?) AS ult
           FROM referidos_ciclos
          WHERE id_usuario_referido = ?`,
        {
          replacements: [previos, id_usuario_referido],
          type: db.QueryTypes.SELECT,
          transaction: t,
        },
      );
      const ciclo = Number(max?.ult || previos) + 1;

      await db.query(
        `INSERT IGNORE INTO referidos_ciclos
           (id_usuario_referido, invoice_id, subscription_id, ciclo_num,
            monto_pagado_cent, moneda, fecha)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        {
          replacements: [
            id_usuario_referido,
            invoiceId,
            subscriptionId,
            ciclo,
            base,
            moneda,
          ],
          transaction: t,
        },
      );

      return { ciclo, repetido: false };
    });

    if (!resultado || resultado.repetido) return null;

    const porcentaje = porcentajeParaCiclo(resultado.ciclo);
    if (porcentaje <= 0) {
      console.log(
        `[referidos] ciclo ${resultado.ciclo} de usuario ${id_usuario_referido}: aún no comisiona (arranca en ${CICLO_INICIO})`,
      );
      return null;
    }

    const comision = Math.round((base * porcentaje) / 100);
    if (comision <= 0) return null;

    await db.query(
      `INSERT IGNORE INTO referidos_comisiones
         (id_usuario_referidor, id_usuario_referido, invoice_id, subscription_id,
          ciclo_num, monto_base_cent, porcentaje, monto_comision_cent, moneda,
          estado, disponible_desde)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente',
               DATE_ADD(CURDATE(), INTERVAL ? DAY))`,
      {
        replacements: [
          idReferidor,
          id_usuario_referido,
          invoiceId,
          subscriptionId,
          resultado.ciclo,
          base,
          porcentaje,
          comision,
          moneda,
          DIAS_RETENCION,
        ],
      },
    );

    console.log(
      `[referidos] comisión devengada: referidor=${idReferidor} referido=${id_usuario_referido} ciclo=${resultado.ciclo} ${porcentaje}% = ${comision} cent`,
    );

    return { id_usuario_referidor: idReferidor, ciclo: resultado.ciclo, comision };
  } catch (e) {
    console.log('[referidos] devengarPorFactura falló:', e?.message);
    return null;
  }
};

/**
 * Revierte la comisión de una factura reembolsada o con contracargo.
 *
 * Si todavía no se pagó, basta con marcarla. Si YA se pagó, marcarla no
 * devuelve nada: por eso se inserta un ajuste negativo que se descuenta de lo
 * que el referidor gane después. Es la única forma de recuperar dinero que ya
 * salió sin ponerse a perseguir a nadie.
 */
const revertirPorFactura = async (invoiceId, motivo = 'reembolso') => {
  try {
    if (!invoiceId) return;

    const [com] = await db.query(
      `SELECT * FROM referidos_comisiones WHERE invoice_id = ?`,
      { replacements: [invoiceId], ...SELECT },
    );
    if (!com) return;

    if (com.estado === 'pagada') {
      const idAjuste = `rev_${invoiceId}`.slice(0, 64);
      await db.query(
        `INSERT IGNORE INTO referidos_comisiones
           (id_usuario_referidor, id_usuario_referido, invoice_id, subscription_id,
            ciclo_num, monto_base_cent, porcentaje, monto_comision_cent, moneda,
            estado, disponible_desde, motivo_reversion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'disponible', CURDATE(), ?)`,
        {
          replacements: [
            com.id_usuario_referidor,
            com.id_usuario_referido,
            idAjuste,
            com.subscription_id,
            com.ciclo_num,
            -Math.abs(com.monto_base_cent),
            com.porcentaje,
            -Math.abs(com.monto_comision_cent),
            com.moneda,
            `Ajuste por ${motivo} de ${invoiceId} (comisión ya liquidada)`,
          ],
        },
      );
      console.log(
        `[referidos] ajuste negativo creado por ${motivo} de comisión ya pagada: ${invoiceId}`,
      );
      return;
    }

    await db.query(
      `UPDATE referidos_comisiones
          SET estado = 'revertida', motivo_reversion = ?
        WHERE invoice_id = ? AND estado IN ('pendiente','disponible')`,
      { replacements: [motivo, invoiceId] },
    );
    console.log(`[referidos] comisión revertida (${motivo}): ${invoiceId}`);
  } catch (e) {
    console.log('[referidos] revertirPorFactura falló:', e?.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// Saldos y resumen
// ═══════════════════════════════════════════════════════════════

/**
 * Pasa a 'disponible' lo que ya cumplió la ventana de retención.
 *
 * Se ejecuta al leer el resumen y antes de cualquier liquidación en vez de
 * dejarlo en un cron: es un UPDATE por índice, y así el saldo que ve el usuario
 * nunca depende de que un cron haya corrido.
 */
const promoverPendientes = async (id_usuario = null) => {
  const where = id_usuario ? 'AND id_usuario_referidor = ?' : '';
  await db.query(
    `UPDATE referidos_comisiones
        SET estado = 'disponible'
      WHERE estado = 'pendiente'
        AND disponible_desde IS NOT NULL
        AND disponible_desde <= CURDATE()
        ${where}`,
    { replacements: id_usuario ? [id_usuario] : [] },
  );
};

/**
 * Saldos del referidor, en centavos.
 *
 * `disponible` excluye lo que ya está reservado por una solicitud de
 * transferencia en curso (`id_pago IS NOT NULL`): sin esa condición se podría
 * pedir transferencia y aplicar crédito por el mismo dinero.
 */
const obtenerSaldos = async (id_usuario) => {
  const [row] = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN estado = 'pendiente'  THEN monto_comision_cent END), 0) AS pendiente,
       COALESCE(SUM(CASE WHEN estado = 'disponible' AND id_pago IS NULL
                         THEN monto_comision_cent END), 0)                            AS disponible,
       COALESCE(SUM(CASE WHEN estado = 'disponible' AND id_pago IS NOT NULL
                         THEN monto_comision_cent END), 0)                            AS reservado,
       COALESCE(SUM(CASE WHEN estado = 'pagada'     THEN monto_comision_cent END), 0) AS pagado,
       COALESCE(SUM(CASE WHEN estado <> 'revertida' THEN monto_comision_cent END), 0) AS ganado_total
     FROM referidos_comisiones
     WHERE id_usuario_referidor = ?`,
    { replacements: [id_usuario], ...SELECT },
  );

  return {
    pendiente_cent: Number(row?.pendiente || 0),
    disponible_cent: Number(row?.disponible || 0),
    reservado_cent: Number(row?.reservado || 0),
    pagado_cent: Number(row?.pagado || 0),
    ganado_total_cent: Number(row?.ganado_total || 0),
  };
};

const ESTADOS_PAGANDO = new Set(['activo', 'trial_usage', 'promo_usage']);

const sumarMeses = (fecha, n) => {
  const d = new Date(fecha);
  d.setMonth(d.getMonth() + n);
  return d;
};

/**
 * Cuándo y cuánto va a comisionar un referido que todavía no ha generado nada.
 *
 * POR QUÉ EXISTE
 * Un referidor que trae diez cuentas y ve $0.00 durante dos meses no concluye
 * "todavía no maduran": concluye que no le están pagando. La regla de arrancar
 * en el ciclo 3 es defendible, pero solo si la pantalla dice EN QUÉ FECHA
 * empieza a cobrar y CUÁNTO. Sin eso, el programa se lee como una estafa
 * justo en el momento en que más ilusión tiene el que refiere.
 *
 * Es una ESTIMACIÓN y así hay que presentarla. Sale del precio de lista del
 * plan, no de lo que la persona pagará de verdad: si usa un cupón, la comisión
 * real será menor. Se prefiere el precio de lista antes que no mostrar nada,
 * porque el orden de magnitud es correcto y es lo que responde la pregunta.
 */
const proyectarReferido = (r, ciclosPagados) => {
  if (!ESTADOS_PAGANDO.has(String(r.estado || '').toLowerCase())) return null;

  const precioCent = Math.round(Number(r.precio_plan || 0) * 100);
  if (precioCent <= 0) return null;

  // El próximo cobro es el ciclo siguiente al último pagado. El primero que
  // comisiona es ese, o el CICLO_INICIO si todavía no llegó.
  const cicloComision = Math.max(CICLO_INICIO, ciclosPagados + 1);
  const cobrosFaltantes = cicloComision - ciclosPagados; // ≥ 1

  const porcentaje = porcentajeParaCiclo(cicloComision);
  if (porcentaje <= 0) return null;

  /* `fecha_renovacion` es la del próximo cobro. Si viene vacía o ya pasó
     —suscripción recién migrada, o un cobro que ocurrió sin que se
     actualizara— se ancla en hoy: es preferible una fecha aproximada a un
     "sin fecha", que devuelve al referidor a la misma incertidumbre. */
  const hoy = new Date();
  const renov = r.fecha_renovacion ? new Date(r.fecha_renovacion) : null;
  const base = renov && renov > hoy ? renov : hoy;
  const aproximada = !(renov && renov > hoy);

  return {
    fecha: sumarMeses(base, cobrosFaltantes - 1).toISOString().slice(0, 10),
    fecha_aproximada: aproximada,
    monto_cent: Math.round((precioCent * porcentaje) / 100),
    porcentaje,
    ciclo: cicloComision,
    cobros_faltantes: cobrosFaltantes,
  };
};

/** Enmascara el correo: el referidor necesita reconocer a quién trajo, no su dato de contacto. */
const enmascararEmail = (email) => {
  const s = String(email || '');
  const [user, dominio] = s.split('@');
  if (!user || !dominio) return '';
  const visible = user.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, user.length - 2))}@${dominio}`;
};

/**
 * Todo lo que necesita la pantalla /referidos en una sola llamada.
 */
const resumen = async (id_usuario) => {
  await promoverPendientes(id_usuario);

  const codigo = await obtenerOCrearCodigo(id_usuario);
  const saldos = await obtenerSaldos(id_usuario);

  const referidos = await db.query(
    `SELECT u.id_usuario,
            u.nombre,
            u.email_propietario,
            u.estado,
            u.referido_en,
            u.referido_origen,
            u.referido_ciclos_previos,
            u.fecha_renovacion,
            u.created_at AS cuenta_creada,
            p.nombre_plan,
            p.precio_plan,
            (SELECT COALESCE(MAX(rc.ciclo_num), u.referido_ciclos_previos)
               FROM referidos_ciclos rc
              WHERE rc.id_usuario_referido = u.id_usuario)                AS ciclos_pagados,
            (SELECT COALESCE(SUM(c.monto_comision_cent), 0)
               FROM referidos_comisiones c
              WHERE c.id_usuario_referido = u.id_usuario
                AND c.id_usuario_referidor = ?
                AND c.estado <> 'revertida')                              AS generado_cent
       FROM usuarios_chat_center u
       LEFT JOIN planes_chat_center p ON p.id_plan = u.id_plan
      WHERE u.referido_por = ?
      -- Por lo que aporta, no por cuándo llegó: tras la migración de
      -- comunidades todos comparten la misma referido_en y ese orden no
      -- distingue a nadie.
      ORDER BY generado_cent DESC, u.created_at DESC
      LIMIT 500`,
    { replacements: [id_usuario, id_usuario], ...SELECT },
  );

  const comisiones = await db.query(
    `SELECT c.id, c.ciclo_num, c.monto_base_cent, c.porcentaje,
            c.monto_comision_cent, c.estado, c.disponible_desde, c.created_at,
            c.motivo_reversion, u.nombre AS nombre_referido
       FROM referidos_comisiones c
       LEFT JOIN usuarios_chat_center u ON u.id_usuario = c.id_usuario_referido
      WHERE c.id_usuario_referidor = ?
      ORDER BY c.created_at DESC
      LIMIT 100`,
    { replacements: [id_usuario], ...SELECT },
  );

  /* `datos_pago` y `comprobante_url` viajan a propósito: sin ellos el
     referidor ve "Pagada" y una referencia escrita a mano, que no le sirve
     para reclamar si el dinero no llegó. El comprobante es la prueba y la
     cuenta destino es a dónde se envió. */
  const pagos = await db.query(
    `SELECT id, monto_cent, metodo, estado, referencia, nota_admin,
            datos_pago, comprobante_url, created_at, pagado_en
       FROM referidos_pagos
      WHERE id_usuario = ?
      ORDER BY created_at DESC
      LIMIT 50`,
    { replacements: [id_usuario], ...SELECT },
  );

  const [pref] = await db.query(
    `SELECT referidos_pago_pref FROM usuarios_chat_center WHERE id_usuario = ?`,
    { replacements: [id_usuario], ...SELECT },
  );

  /* Serie mensual para el gráfico. Se agrega en SQL y no reduciendo el array
     de `comisiones`, que viene cortado en 100 filas: un referidor con varias
     decenas de referidos vería la serie truncada justo en los meses viejos, y
     un gráfico al que le falta el pasado miente sobre la tendencia.
     Las revertidas se restan —no se ignoran— porque el mes en que se cae una
     comisión es información, no ruido. */
  const serieMensual = await db.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m')                        AS mes,
            COALESCE(SUM(CASE WHEN estado <> 'revertida'
                              THEN monto_comision_cent ELSE 0 END), 0) AS comision_cent,
            COUNT(DISTINCT id_usuario_referido)                     AS referidos
       FROM referidos_comisiones
      WHERE id_usuario_referidor = ?
        AND created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 5 MONTH)
      GROUP BY mes
      ORDER BY mes ASC`,
    { replacements: [id_usuario], ...SELECT },
  );

  const listaReferidos = referidos.map((r) => {
    const pagados = Number(r.ciclos_pagados || 0);
    const proximaComision = proyectarReferido(r, pagados);
    return {
      id_usuario: r.id_usuario,
      nombre: r.nombre,
      email: enmascararEmail(r.email_propietario),
      estado: r.estado,
      plan: r.nombre_plan || null,
      origen: r.referido_origen || 'link',
      /* `referido_en` es cuándo se SELLÓ la atribución, que en los migrados
         desde comunidades es el día que corrimos la migración — mostrarlo
         hace parecer que 13 personas se registraron todas el mismo día. Lo
         que el referidor quiere ver es cuándo esa persona creó su cuenta. */
      referido_en: r.cuenta_creada || r.referido_en,
      atribuido_en: r.referido_en,
      ciclos_pagados: pagados,
      // Cuántos meses le faltan para que este referido empiece a comisionar.
      ciclos_faltantes: Math.max(0, CICLO_INICIO - 1 - pagados),
      comisiona: pagados >= CICLO_INICIO - 1,
      generado_cent: Number(r.generado_cent || 0),
      proxima_comision: proximaComision,
    };
  });

  /* Resumen de la proyección para la cabecera.
     `mensual_cent` es lo que este referidor ganaría CADA MES una vez que todos
     sus referidos activos hayan madurado. Es el número que contesta "¿esto
     para qué me sirve?" cuando todos los saldos están en cero. */
  const conProyeccion = listaReferidos
    .map((r) => r.proxima_comision)
    .filter(Boolean);

  const proximas = [...conProyeccion].sort((a, b) =>
    a.fecha.localeCompare(b.fecha),
  );

  const proyeccion = {
    mensual_cent: conProyeccion.reduce((a, p) => a + p.monto_cent, 0),
    referidos_en_camino: conProyeccion.length,
    // La más cercana: es la que convierte "algún día" en una fecha concreta.
    proxima: proximas[0] || null,
  };

  /* Estado del cobro por crédito. Solo se le pregunta a Stripe cuando hay algo
     que decir —saldo por aplicar o crédito ya aplicado antes—; en el resto de
     visitas, que son la mayoría, la pantalla no paga esa latencia. */
  const hayCreditoPrevio = pagos.some(
    (p) => p.metodo === 'credito' && p.estado === 'pagado',
  );
  const credito =
    saldos.disponible_cent > 0 || hayCreditoPrevio
      ? await infoCredito(id_usuario, saldos)
      : { puede: true, code: 'SIN_SALDO', message: null, proxima_factura: null,
          credito_en_cuenta_cent: 0 };

  return {
    codigo,
    // Puede venir null: el enlace definitivo lo arma el front con su propio
    // origin. Ver la nota en referidos.config.js.
    enlace: construirEnlace(codigo),
    preferencia_pago: pref?.referidos_pago_pref || 'credito',
    saldos,
    credito,
    umbral_transferencia_cent: UMBRAL_TRANSFERENCIA_CENT,
    referidos: listaReferidos,
    proyeccion,
    comisiones,
    pagos,
    serie_mensual: serieMensual.map((m) => ({
      mes: m.mes,
      comision_cent: Number(m.comision_cent || 0),
      referidos: Number(m.referidos || 0),
    })),
  };
};

// ═══════════════════════════════════════════════════════════════
// Liquidación
// ═══════════════════════════════════════════════════════════════

/**
 * ¿Puede este usuario convertir su saldo en descuento del plan? ¿Y en qué
 * factura se va a notar?
 *
 * POR QUÉ EXISTE
 * `createBalanceTransaction` acredita saldo en el CLIENTE, no en una factura.
 * Stripe lo descuenta solo cuando emite la siguiente. Si el usuario no tiene
 * suscripción viva, ese dinero queda estacionado sin fecha: la operación
 * "funciona" —devuelve 200, marca las comisiones como pagadas— y aun así el
 * usuario no ve un centavo de descuento nunca. Es la peor clase de éxito.
 *
 * Por eso aquí se comprueba ANTES que exista una próxima factura de verdad, y
 * se devuelve su previsualización: cuánto iba a pagar, cuánto pagará con el
 * saldo y cuánto le sobra para el mes siguiente. Esa previsualización sale de
 * Stripe, no de una estimación nuestra.
 *
 * Ante un fallo de red de Stripe NO se bloquea: se deja aplicar sin
 * previsualización. Una caída de su API no puede impedirle a alguien cobrar lo
 * que ya ganó; lo que se bloquea es lo que sabemos que va a terminar mal.
 */
const infoCredito = async (id_usuario, saldos) => {
  const [u] = await db.query(
    `SELECT id_costumer, id_plan, estado, stripe_subscription_id,
            stripe_subscription_status, cancel_at_period_end, cancel_at,
            fecha_renovacion
       FROM usuarios_chat_center
      WHERE id_usuario = ?`,
    { replacements: [id_usuario], ...SELECT },
  );

  const base = {
    puede: false,
    code: 'OK',
    message: null,
    proxima_factura: null,
    credito_en_cuenta_cent: 0,
  };

  if (!u) return { ...base, code: 'SIN_CUENTA', message: 'No se encontró tu cuenta.' };

  if (!u.id_costumer) {
    return {
      ...base,
      code: 'SIN_CUSTOMER',
      message:
        'Tu cuenta todavía no tiene un cliente de facturación asociado. Escríbenos y lo dejamos listo.',
    };
  }

  const estado = String(u.estado || '').toLowerCase();
  const subStatus = String(u.stripe_subscription_status || '').toLowerCase();

  // Sin suscripción con cobro no hay factura futura: ni con plan en trial.
  if (!u.id_plan || !u.stripe_subscription_id) {
    return {
      ...base,
      code: 'SIN_PLAN',
      message:
        'Para usar tu saldo como descuento necesitas un plan con cobro activo. Elige tu plan y el saldo se descontará de tu primera factura.',
    };
  }

  if (subStatus === 'canceled' || estado === 'cancelado') {
    return {
      ...base,
      code: 'SUSCRIPCION_CANCELADA',
      message:
        'Tu suscripción está cancelada, así que no habrá una próxima factura de la que descontar. Reactiva tu plan o pide el saldo por transferencia.',
    };
  }

  if (['inactivo', 'suspendido', 'vencido'].includes(estado)) {
    return {
      ...base,
      code: 'PLAN_INACTIVO',
      message:
        'Tu plan no está al día, así que todavía no hay una factura futura donde aplicar el saldo. Reactívalo y podrás usarlo, o pídelo por transferencia.',
    };
  }

  if (Number(u.cancel_at_period_end) === 1) {
    const cuando = u.cancel_at || u.fecha_renovacion;
    return {
      ...base,
      code: 'CANCELACION_PROGRAMADA',
      message: `Tu plan está programado para cancelarse${
        cuando ? ` el ${String(cuando).slice(0, 10)}` : ''
      }, así que no se emitirá otra factura donde aplicar el saldo. Si retomas el plan podrás usarlo; si no, pídelo por transferencia.`,
    };
  }

  // Hasta aquí llega la base. Lo que sigue lo contesta Stripe.
  let credito = 0;
  try {
    const cliente = await stripe.customers.retrieve(u.id_costumer);
    if (cliente?.deleted) {
      return {
        ...base,
        code: 'SIN_CUSTOMER',
        message:
          'Tu cliente de facturación ya no existe en la pasarela. Escríbenos para regenerarlo.',
      };
    }
    // Negativo = saldo a favor. Se muestra en positivo.
    credito = Math.abs(Math.min(0, Number(cliente?.balance || 0)));
  } catch (e) {
    console.log('[referidos] no se pudo leer el customer:', e?.message);
    return { ...base, puede: true, code: 'SIN_PREVIA', credito_en_cuenta_cent: 0 };
  }

  try {
    const previa = await stripe.invoices.createPreview({
      customer: u.id_costumer,
    });

    /* `starting_balance` es lo que Stripe YA tiene a favor. Al aplicar el saldo
       nuevo, lo que se descontará es la suma de ambos, siempre topada por el
       total de la factura: nunca deja un importe negativo. */
    const total = Number(previa.total || 0);
    const yaAFavor = Math.abs(Math.min(0, Number(previa.starting_balance || 0)));
    const aFavorTras = yaAFavor + Number(saldos.disponible_cent || 0);
    const descuento = Math.min(total, aFavorTras);

    /* Una factura vencida NO bloquea: el saldo no se aplica sobre facturas ya
       emitidas —Stripe solo lo descuenta de la siguiente que genere— y hay que
       decirlo, o el usuario aplicará el crédito esperando que le pague la
       deuda que ya tiene abierta. */
    const enMora = ['past_due', 'unpaid', 'incomplete'].includes(subStatus);

    return {
      puede: true,
      code: enMora ? 'FACTURA_PENDIENTE' : 'OK',
      message: enMora
        ? 'Tienes una factura pendiente de pago. El saldo no se descuenta de una factura ya emitida: se aplicará a la siguiente.'
        : null,
      credito_en_cuenta_cent: credito,
      proxima_factura: {
        fecha: previa.period_end
          ? new Date(previa.period_end * 1000).toISOString().slice(0, 10)
          : u.fecha_renovacion
            ? String(u.fecha_renovacion).slice(0, 10)
            : null,
        total_cent: total,
        // Lo que pagaría HOY, con el saldo que ya tiene acreditado.
        a_pagar_ahora_cent: Number(previa.amount_due || 0),
        // Lo que pagaría si aplica también el saldo disponible del programa.
        a_pagar_con_saldo_cent: Math.max(0, total - descuento),
        saldo_restante_cent: Math.max(0, aFavorTras - descuento),
      },
    };
  } catch (e) {
    /* "No upcoming invoices" es una respuesta legítima: hay suscripción en la
       base pero Stripe no tiene nada que facturar. Aplicar el saldo ahí es
       justo el caso que esta función existe para evitar. */
    const msg = String(e?.message || '');
    if (/upcoming invoice/i.test(msg) || e?.code === 'invoice_upcoming_none') {
      return {
        ...base,
        code: 'SIN_FACTURA_PROXIMA',
        credito_en_cuenta_cent: credito,
        message:
          'No tenemos una próxima factura tuya donde aplicar el descuento. Revisa tu plan o pide el saldo por transferencia.',
      };
    }
    console.log('[referidos] previsualización de factura falló:', msg);
    return { ...base, puede: true, code: 'SIN_PREVIA', credito_en_cuenta_cent: credito };
  }
};

/**
 * Aplica el saldo disponible como crédito en Stripe.
 *
 * `createBalanceTransaction` con monto NEGATIVO es un saldo a favor: Stripe lo
 * descuenta solo de la próxima factura del cliente. Es el camino por defecto
 * del programa porque no saca dinero de caja y no obliga al referidor a emitir
 * factura para cobrar.
 *
 * El orden importa: primero se reservan las filas contra `id_pago`, después se
 * llama a Stripe. Si Stripe falla, se sueltan. Al revés se correría el riesgo
 * de acreditar en Stripe y no poder marcar las comisiones, que es el único
 * error de los dos que cuesta dinero.
 */
const aplicarCredito = async (id_usuario) => {
  await promoverPendientes(id_usuario);
  const saldos = await obtenerSaldos(id_usuario);

  if (saldos.disponible_cent <= 0) {
    return { ok: false, code: 'SIN_SALDO', message: 'No tienes saldo disponible todavía.' };
  }

  /* Se vuelve a comprobar aquí y no solo en la pantalla: entre que se pintó el
     botón y se pulsó, el usuario pudo cancelar su plan en otra pestaña. */
  const info = await infoCredito(id_usuario, saldos);
  if (!info.puede) {
    return { ok: false, code: info.code, message: info.message };
  }

  const [usuario] = await db.query(
    `SELECT id_costumer FROM usuarios_chat_center WHERE id_usuario = ?`,
    { replacements: [id_usuario], ...SELECT },
  );
  if (!usuario?.id_costumer) {
    return {
      ok: false,
      code: 'SIN_CUSTOMER',
      message: 'Tu cuenta no tiene un cliente de Stripe asociado. Contacta a soporte.',
    };
  }

  const [insert] = await db.query(
    `INSERT INTO referidos_pagos (id_usuario, monto_cent, metodo, estado, created_at)
     VALUES (?, ?, 'credito', 'aprobado', NOW())`,
    { replacements: [id_usuario, saldos.disponible_cent] },
  );
  const idPago = Number(insert);

  await db.query(
    `UPDATE referidos_comisiones
        SET id_pago = ?
      WHERE id_usuario_referidor = ? AND estado = 'disponible' AND id_pago IS NULL`,
    { replacements: [idPago, id_usuario] },
  );

  try {
    const txn = await stripe.customers.createBalanceTransaction(
      usuario.id_costumer,
      {
        amount: -Math.abs(saldos.disponible_cent),
        currency: 'usd',
        description: `Comisiones programa de referidos (pago #${idPago})`,
      },
    );

    await db.query(
      `UPDATE referidos_comisiones SET estado = 'pagada' WHERE id_pago = ?`,
      { replacements: [idPago] },
    );
    await db.query(
      `UPDATE referidos_pagos
          SET estado = 'pagado', referencia = ?, pagado_en = NOW()
        WHERE id = ?`,
      { replacements: [txn.id, idPago] },
    );

    return {
      ok: true,
      id_pago: idPago,
      monto_cent: saldos.disponible_cent,
      referencia: txn.id,
      // La factura donde se va a notar: es lo que convierte un "listo" en algo
      // comprobable por el usuario.
      proxima_factura: info.proxima_factura,
    };
  } catch (e) {
    // Stripe falló: se sueltan las comisiones para que el saldo vuelva a estar
    // disponible y el usuario pueda reintentar.
    await db.query(
      `UPDATE referidos_comisiones SET id_pago = NULL WHERE id_pago = ?`,
      { replacements: [idPago] },
    );
    await db.query(
      `UPDATE referidos_pagos SET estado = 'rechazado', nota_admin = ? WHERE id = ?`,
      { replacements: [String(e?.message || 'error Stripe').slice(0, 255), idPago] },
    );
    console.log('[referidos] aplicarCredito falló en Stripe:', e?.message);
    return {
      ok: false,
      code: 'STRIPE_ERROR',
      message: 'No se pudo aplicar el crédito. Inténtalo de nuevo en unos minutos.',
    };
  }
};

/**
 * Solicita el pago en efectivo del saldo disponible.
 *
 * No mueve dinero: reserva las comisiones y deja la solicitud esperando
 * aprobación manual. La transferencia sale de una cuenta bancaria y necesita
 * comprobante del referidor, así que no puede ser automática.
 */
const solicitarTransferencia = async (id_usuario, datosPago) => {
  await promoverPendientes(id_usuario);
  const saldos = await obtenerSaldos(id_usuario);

  /* La solicitud en curso se comprueba ANTES que el umbral: una solicitud
     abierta se lleva reservado todo el saldo, así que el disponible queda en
     cero y el usuario recibiría "necesitas $30" —que contradice el aviso de
     saldo reservado que tiene delante en la misma pantalla—. */
  const [pendiente] = await db.query(
    `SELECT id FROM referidos_pagos
      WHERE id_usuario = ? AND metodo = 'transferencia'
        AND estado IN ('solicitado','aprobado')
      LIMIT 1`,
    { replacements: [id_usuario], ...SELECT },
  );
  if (pendiente) {
    return {
      ok: false,
      code: 'YA_SOLICITADO',
      message:
        'Ya tienes una solicitud de transferencia en revisión. Cuando la resolvamos podrás pedir la siguiente.',
    };
  }

  if (saldos.disponible_cent < UMBRAL_TRANSFERENCIA_CENT) {
    return {
      ok: false,
      code: 'BAJO_UMBRAL',
      message: `Necesitas al menos $${(UMBRAL_TRANSFERENCIA_CENT / 100).toFixed(2)} disponibles para pedir transferencia. Puedes aplicar el saldo como crédito sin mínimo.`,
    };
  }

  const [insert] = await db.query(
    `INSERT INTO referidos_pagos
       (id_usuario, monto_cent, metodo, estado, datos_pago, created_at)
     VALUES (?, ?, 'transferencia', 'solicitado', ?, NOW())`,
    {
      replacements: [
        id_usuario,
        saldos.disponible_cent,
        String(datosPago || '').slice(0, 2000),
      ],
    },
  );
  const idPago = Number(insert);

  await db.query(
    `UPDATE referidos_comisiones
        SET id_pago = ?
      WHERE id_usuario_referidor = ? AND estado = 'disponible' AND id_pago IS NULL`,
    { replacements: [idPago, id_usuario] },
  );

  return { ok: true, id_pago: idPago, monto_cent: saldos.disponible_cent };
};

/** Preferencia de cobro. Solo informativa: no mueve saldos por sí sola. */
const guardarPreferenciaPago = async (id_usuario, pref) => {
  await db.query(
    `UPDATE usuarios_chat_center SET referidos_pago_pref = ? WHERE id_usuario = ?`,
    { replacements: [pref, id_usuario] },
  );
};

// ═══════════════════════════════════════════════════════════════
// Administración
// ═══════════════════════════════════════════════════════════════

/**
 * Bandeja del super admin.
 *
 * `estado = 'todos'` trae también el histórico ya resuelto: sin eso no hay
 * forma de responder "¿esta transferencia ya se pagó?" un mes después.
 *
 * Los agregados (cuántas comisiones agrupa y de cuántos referidos vienen)
 * viajan en la misma consulta porque son lo que permite juzgar la solicitud sin
 * abrirla: un monto alto formado por una sola comisión merece más mirada que
 * el mismo monto repartido en quince.
 */
const listarSolicitudes = async (estado = null) => {
  const filtro =
    estado === 'todos'
      ? ''
      : estado
        ? 'AND p.estado = ?'
        : "AND p.estado IN ('solicitado','aprobado')";

  return db.query(
    `SELECT p.*,
            u.nombre, u.email_propietario, u.whatsapp_lead,
            a.nombre_encargado AS admin_nombre,
            (SELECT COUNT(*) FROM referidos_comisiones c
              WHERE c.id_pago = p.id)                       AS comisiones_n,
            (SELECT COUNT(DISTINCT c.id_usuario_referido)
               FROM referidos_comisiones c
              WHERE c.id_pago = p.id)                       AS referidos_n
       FROM referidos_pagos p
       JOIN usuarios_chat_center u ON u.id_usuario = p.id_usuario
       LEFT JOIN sub_usuarios_chat_center a
              ON a.id_sub_usuario = p.id_sub_usuario_admin
      WHERE p.metodo = 'transferencia' ${filtro}
      ORDER BY p.created_at ASC
      LIMIT 200`,
    { replacements: estado && estado !== 'todos' ? [estado] : [], ...SELECT },
  );
};

/**
 * Desglose de una solicitud: qué comisiones la componen.
 *
 * Es lo que el admin necesita antes de sacar dinero de caja — de qué referidos
 * salió el monto y de qué facturas. Sin esto, aprobar es un acto de fe.
 */
const detalleSolicitud = async (id_pago) => {
  const [pago] = await db.query(
    `SELECT p.*, u.nombre, u.email_propietario, u.whatsapp_lead
       FROM referidos_pagos p
       JOIN usuarios_chat_center u ON u.id_usuario = p.id_usuario
      WHERE p.id = ?`,
    { replacements: [id_pago], ...SELECT },
  );
  if (!pago) return null;

  const comisiones = await db.query(
    `SELECT c.id, c.ciclo_num, c.monto_base_cent, c.porcentaje,
            c.monto_comision_cent, c.invoice_id, c.created_at,
            r.nombre AS nombre_referido, r.email_propietario AS email_referido
       FROM referidos_comisiones c
       LEFT JOIN usuarios_chat_center r ON r.id_usuario = c.id_usuario_referido
      WHERE c.id_pago = ?
      ORDER BY c.created_at ASC`,
    { replacements: [id_pago], ...SELECT },
  );

  return { ...pago, comisiones };
};

const resolverSolicitud = async ({
  id_pago,
  accion,
  referencia,
  nota,
  comprobante_url,
  id_sub_usuario_admin,
}) => {
  const [pago] = await db.query(
    `SELECT * FROM referidos_pagos WHERE id = ?`,
    { replacements: [id_pago], ...SELECT },
  );
  if (!pago) return { ok: false, code: 'NO_EXISTE', message: 'Solicitud no encontrada' };
  if (pago.estado === 'pagado' || pago.estado === 'rechazado') {
    return { ok: false, code: 'YA_RESUELTA', message: 'Esa solicitud ya fue resuelta' };
  }

  if (accion === 'pagar') {
    await db.query(
      `UPDATE referidos_comisiones SET estado = 'pagada' WHERE id_pago = ?`,
      { replacements: [id_pago] },
    );
    /* El comprobante solo se pisa si viene uno nuevo: reabrir el modal para
       corregir la referencia no puede borrar el archivo ya subido. */
    await db.query(
      `UPDATE referidos_pagos
          SET estado = 'pagado', referencia = ?, nota_admin = ?,
              comprobante_url = COALESCE(?, comprobante_url),
              id_sub_usuario_admin = ?, pagado_en = NOW()
        WHERE id = ?`,
      {
        replacements: [
          String(referencia || '').slice(0, 120) || null,
          String(nota || '').slice(0, 255) || null,
          comprobante_url || null,
          id_sub_usuario_admin || null,
          id_pago,
        ],
      },
    );
    return { ok: true };
  }

  // Rechazo: se sueltan las comisiones para que el saldo vuelva a estar libre.
  await db.query(
    `UPDATE referidos_comisiones SET id_pago = NULL WHERE id_pago = ?`,
    { replacements: [id_pago] },
  );
  await db.query(
    `UPDATE referidos_pagos
        SET estado = 'rechazado', nota_admin = ?, id_sub_usuario_admin = ?
      WHERE id = ?`,
    {
      replacements: [
        String(nota || '').slice(0, 255) || null,
        id_sub_usuario_admin || null,
        id_pago,
      ],
    },
  );
  return { ok: true };
};

module.exports = {
  obtenerOCrearCodigo,
  resolverReferidor,
  infoPublicaPorCodigo,
  devengarPorFactura,
  revertirPorFactura,
  promoverPendientes,
  obtenerSaldos,
  infoCredito,
  resumen,
  aplicarCredito,
  solicitarTransferencia,
  guardarPreferenciaPago,
  listarSolicitudes,
  detalleSolicitud,
  resolverSolicitud,
};
