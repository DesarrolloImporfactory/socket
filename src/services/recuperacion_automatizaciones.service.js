'use strict';

const crypto = require('crypto');
const Stripe = require('stripe');
const { db } = require('../database/config');
const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');
const recuperacion = require('./recuperacion.service');

/**
 * Automatizaciones de recuperación (pedido 2026-10-12): secuencias de
 * plantillas de WhatsApp que salen desde la conexión de Expertos hacia los
 * clientes del embudo. Cuatro secuencias:
 *  - pago_rebotado (3 pasos de remarketing: aviso → implementación gratis →
 *    10% de descuento), cada paso solo si el cliente NO respondió al anterior;
 *  - cancelacion_programada (3 pasos: qué te frenó → te implementamos →
 *    10% para que te quedes), misma regla;
 *  - nutricion_prueba y nutricion_sin_tarjeta: tips cada 15 días, rotando,
 *    sin repetir el mismo en 2 meses.
 *
 * CÓMO ENVÍA: no habla con Meta. Encola filas en template_envios_programados
 * y el cron de siempre (templateProgramadoMasivo) las manda con sus
 * reintentos, cache de plantillas y límites. Por eso cada paso necesita una
 * PLANTILLA APROBADA en Meta (a quien no escribió en 24 h solo se le puede
 * mandar plantilla): aquí se guarda el nombre y el texto sugerido; la
 * plantilla se crea en Meta desde "Plantillas" de la conexión.
 *
 * ANTI-SPAM: un cliente recibe como máximo un mensaje de automatización cada
 * MIN_DIAS_ENTRE_MENSAJES días (de cualquier secuencia); si escribió en los
 * últimos 2 días no se le manda nada (ya hay conversación); si respondió a un
 * paso, la secuencia se detiene y el asesor sigue a mano; cada automatización
 * tiene tope diario. Todo queda en recuperacion_automatizacion_envios.
 *
 * DESCUENTO 10%: el paso marcado aplica el cupón de Stripe al customer
 * (customers.update coupon): la próxima factura sale con 10% y en el
 * dashboard de Stripe se ve a quién se le dio. Una factura ya emitida no se
 * puede rebajar, así que al que rebotó el pago se le dice "paga la pendiente
 * y tu próxima renovación va con 10%".
 *
 * Nace APAGADO (activa = 0, inicia_en NULL): se prende desde la pestaña
 * Automatizaciones cuando el equipo esté listo.
 */

const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const STRIPE_SECRET = isProd
  ? process.env.STRIPE_SECRET_KEY
  : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;
const stripe = new Stripe(STRIPE_SECRET || '', { apiVersion: '2024-06-20' });

const MIN_DIAS_ENTRE_MENSAJES = 3;
const DIAS_CONVERSACION_ACTIVA = 2;
const FRONT_BASE = (process.env.FRONTEND_URL || process.env.FRONT_URL || 'https://chatcenter.imporfactory.app').replace(/\/$/, '');
const TZ_OFFSET_MS = -5 * 3600 * 1000; // America/Guayaquil

// Variables que puede llevar una plantilla. Se resuelven por cliente al encolar.
const VARIABLES = {
  '{{nombre}}': 'Nombre del cliente (empresa o dueño)',
  '{{plan}}': 'Nombre de su plan',
  '{{precio}}': 'Precio mensual del plan',
  '{{link_pago}}': 'Enlace de la factura pendiente en Stripe (solo pago rebotado)',
  '{{link_planes}}': 'Enlace a la página de planes de ImporChat',
  '{{fecha}}': 'Fecha clave (vence / se cancela / termina la prueba)',
  '{{dias}}': 'Días que faltan para esa fecha',
  '{{descuento}}': 'Texto del descuento (10%)',
};

/* ── Secuencias por defecto (se siembran una vez; después se editan en la UI) ── */
const DEFAULTS = [
  {
    clave: 'pago_rebotado',
    nombre: 'Pago rebotado',
    descripcion: 'Remarketing a quien pagaba y la tarjeta falló. Tres mensajes; cada uno solo si no respondió al anterior. El tercero aplica el 10%.',
    cohortes: ['pago_rebotado'],
    intervalo_dias: 3,
    max_por_dia: 120,
    pasos: [
      {
        orden: 1, espera_dias: 0, titulo: 'Aviso: no pasó tu pago',
        nombre_template: 'recup_pago_1',
        parametros: ['{{nombre}}', '{{plan}}', '{{link_pago}}'],
        texto_sugerido:
          'Hola {{1}} 👋, te escribe el equipo de ImporChat. Intentamos renovar tu plan {{2}} y tu banco no aprobó el cobro, así que tu cuenta quedó en pausa: el bot dejó de responder, los seguimientos automáticos están detenidos y tus clientes esperan.\n\nLo regularizas en un minuto aquí: {{3}}\n\nSi hubo un problema con la tarjeta, respóndeme y lo resolvemos juntos hoy.',
      },
      {
        orden: 2, espera_dias: 3, titulo: 'Implementación gratis + reunión',
        nombre_template: 'recup_pago_2',
        parametros: ['{{nombre}}', '{{link_pago}}'],
        texto_sugerido:
          '{{1}}, no quiero que tu negocio siga parado. Muchas veces el problema no es el pago, es el tiempo para dejar todo armado. Por eso te regalo una sesión de implementación 1 a 1 con nuestro equipo: dejamos tu bot, tus respuestas y tus seguimientos listos para vender solos.\n\nSolo necesitamos tu cuenta activa: {{2}}\n\n¿Agendamos? Respóndeme «sí» y te paso los horarios.',
      },
      {
        orden: 3, espera_dias: 4, titulo: '10% de descuento, última propuesta', aplica_descuento: 1,
        nombre_template: 'recup_pago_3',
        parametros: ['{{nombre}}', '{{plan}}', '{{link_pago}}'],
        texto_sugerido:
          '{{1}}, última propuesta y es la mejor: ya dejamos activado un 10% de descuento en tu plan {{2}} para tu próxima renovación. Paga hoy tu factura pendiente aquí {{3}} y tu bot vuelve a cerrar ventas en minutos.\n\nSi no es el momento, dímelo y dejo de escribirte. Pero si quieres volver, este es el día.',
      },
    ],
  },
  {
    clave: 'cancelacion_programada',
    nombre: 'Cancelación programada',
    descripcion: 'Retención de quien pidió cancelar y sigue activo. Tres mensajes; cada uno solo si no respondió al anterior. El tercero aplica el 10%.',
    cohortes: ['cancelacion_programada'],
    intervalo_dias: 3,
    max_por_dia: 60,
    pasos: [
      {
        orden: 1, espera_dias: 0, titulo: '¿Qué te frenó?',
        nombre_template: 'recup_cancel_1',
        parametros: ['{{nombre}}', '{{plan}}', '{{fecha}}'],
        texto_sugerido:
          'Hola {{1}}, vimos que programaste la cancelación de tu plan {{2}} (termina el {{3}}). Antes de que pase, quiero entender qué te frenó: ¿tiempo, resultados, precio, algo técnico?\n\nCuéntamelo en una línea. Si es algo que podemos resolver, lo hacemos esta misma semana.',
      },
      {
        orden: 2, espera_dias: 3, titulo: 'Te dejamos todo implementado',
        nombre_template: 'recup_cancel_2',
        parametros: ['{{nombre}}'],
        texto_sugerido:
          '{{1}}, si lo que faltó fue dejar todo implementado, lo hacemos nosotros: configuramos tu bot, tus plantillas y tus seguimientos automáticos sin costo, en una sesión 1 a 1. Es nuestra forma de que veas ImporChat trabajando de verdad antes de decidir.\n\n¿Te agendo? Respóndeme «sí».',
      },
      {
        orden: 3, espera_dias: 4, titulo: '10% para que te quedes', aplica_descuento: 1,
        nombre_template: 'recup_cancel_3',
        parametros: ['{{nombre}}', '{{plan}}'],
        texto_sugerido:
          '{{1}}, queremos que te quedes: ya dejamos aplicado un 10% de descuento en tu plan {{2}} para tu próxima renovación. Solo tienes que quitar la cancelación desde «Mi plan», o responderme «me quedo» y lo hago por ti.\n\nSi decides irte, gracias por probarnos; la puerta queda abierta.',
      },
    ],
  },
  {
    clave: 'nutricion_prueba',
    nombre: 'Nutrición: en prueba',
    descripcion: 'Tips cada 15 días a quien está en trial, para que llegue al primer cobro usando el sistema. Rotan; no se repite el mismo en 2 meses.',
    cohortes: ['en_prueba'],
    intervalo_dias: 15,
    max_por_dia: 100,
    ciclico: 1,
    pasos: nutricion('recup_nutri'),
  },
  {
    clave: 'nutricion_sin_tarjeta',
    nombre: 'Nutrición: sin tarjeta',
    descripcion: 'Tips cada 15 días a quien tiene acceso sin tarjeta (curso o manual), para que vea valor y pase a pagar. Comparte plantillas con la de prueba.',
    cohortes: ['sin_tarjeta'],
    intervalo_dias: 15,
    max_por_dia: 100,
    ciclico: 1,
    pasos: nutricion('recup_nutri'),
  },
];

function nutricion(prefijo) {
  return [
    {
      orden: 1, espera_dias: 0, titulo: 'Tip: el bot cotiza solo',
      nombre_template: `${prefijo}_1`, parametros: ['{{nombre}}'],
      texto_sugerido:
        'Hola {{1}} 👋 ¿cómo va tu flujo de ventas en ImporChat? Tip de la semana: activa las respuestas automáticas con tu catálogo y el bot cotiza solo mientras tú atiendes lo importante.\n\nSi quieres, te muestro cómo en 10 minutos. Respóndeme «tip».',
    },
    {
      orden: 2, espera_dias: 15, titulo: 'Tip: seguimientos automáticos',
      nombre_template: `${prefijo}_2`, parametros: ['{{nombre}}'],
      texto_sugerido:
        '{{1}}, ¿ya probaste los seguimientos automáticos? A los clientes que no responden les llega un recordatorio solo y vuelven a la conversación. Es la función que más ventas recupera.\n\n¿Te ayudo a activarla? Respóndeme «seguimientos».',
    },
    {
      orden: 3, espera_dias: 15, titulo: 'Tip: anuncios conectados',
      nombre_template: `${prefijo}_3`, parametros: ['{{nombre}}'],
      texto_sugerido:
        '{{1}}, una idea rápida: conecta tus anuncios de Meta a ImporChat y cada lead entra con el producto que vio, sin copiar y pegar nada.\n\nDime «anuncios» y te lo configuramos.',
    },
    {
      orden: 4, espera_dias: 15, titulo: 'Cierre: ¿listo para el plan completo?',
      nombre_template: `${prefijo}_4`, parametros: ['{{nombre}}', '{{link_planes}}'],
      texto_sugerido:
        '{{1}}, llevas un tiempo probando ImporChat y queremos que le saques todo. Si algo no te funcionó o te falta configurar, respóndeme y lo resolvemos juntos.\n\nY si ya estás listo para activar tu plan completo, aquí está: {{2}}',
    },
  ];
}

/* ── Tablas ── */
let tablasListas = false;
async function ensureTablas() {
  if (tablasListas) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS recuperacion_automatizaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      clave VARCHAR(40) NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      descripcion TEXT NULL,
      cohortes JSON NULL,
      activa TINYINT(1) NOT NULL DEFAULT 0,
      inicia_en DATETIME NULL,
      solo_sin_respuesta TINYINT(1) NOT NULL DEFAULT 1,
      ciclico TINYINT(1) NOT NULL DEFAULT 0,
      intervalo_dias INT NOT NULL DEFAULT 3,
      max_por_dia INT NOT NULL DEFAULT 100,
      incluir_numero_conexion TINYINT(1) NOT NULL DEFAULT 0,
      stripe_coupon_id VARCHAR(60) NOT NULL DEFAULT 'RECUPERACION10',
      actualizado_por VARCHAR(190) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_clave (clave)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recuperacion_automatizacion_pasos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_automatizacion INT NOT NULL,
      orden INT NOT NULL,
      titulo VARCHAR(120) NOT NULL,
      texto_sugerido TEXT NULL,
      nombre_template VARCHAR(120) NULL,
      language_code VARCHAR(10) NOT NULL DEFAULT 'es',
      parametros JSON NULL,
      espera_dias INT NOT NULL DEFAULT 3,
      aplica_descuento TINYINT(1) NOT NULL DEFAULT 0,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_auto_orden (id_automatizacion, orden)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS recuperacion_automatizacion_envios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_automatizacion INT NOT NULL,
      id_paso INT NOT NULL,
      orden INT NOT NULL,
      id_usuario INT NOT NULL,
      id_caso INT NULL,
      telefono VARCHAR(30) NULL,
      id_cliente_chat INT NULL,
      id_envio_programado INT NULL,
      nombre_template VARCHAR(120) NULL,
      parametros_resueltos JSON NULL,
      origen VARCHAR(20) NOT NULL DEFAULT 'cron',
      estado ENUM('encolado','enviado','error','omitido') NOT NULL DEFAULT 'encolado',
      detalle VARCHAR(255) NULL,
      enviado_en DATETIME NULL,
      respondio_en DATETIME NULL,
      descuento_aplicado TINYINT(1) NOT NULL DEFAULT 0,
      descuento_detalle VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY ix_auto_usuario (id_automatizacion, id_usuario, created_at),
      KEY ix_usuario (id_usuario, created_at),
      KEY ix_envio_prog (id_envio_programado)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await sembrar();
  await sincronizarTextos();
  tablasListas = true;
}

// Los textos viven en recuperacion_textos.js (fuente de verdad): si cambian
// en el código, se reflejan en la BD sin tocar lo demás del paso.
const TEXTOS = require('./recuperacion_textos');
async function sincronizarTextos() {
  const autos = await db.query(`SELECT id, clave FROM recuperacion_automatizaciones`, { type: db.QueryTypes.SELECT });
  for (const a of autos) {
    const grupo = a.clave.startsWith('nutricion') ? TEXTOS.nutricion : TEXTOS[a.clave];
    if (!grupo) continue;
    for (const [orden, texto] of Object.entries(grupo)) {
      await db.query(
        `UPDATE recuperacion_automatizacion_pasos SET texto_sugerido = ?
          WHERE id_automatizacion = ? AND orden = ? AND (texto_sugerido IS NULL OR texto_sugerido <> ?)`,
        { replacements: [texto, a.id, Number(orden), texto], type: db.QueryTypes.UPDATE },
      );
    }
  }
}

async function sembrar() {
  const existentes = await db.query(`SELECT clave FROM recuperacion_automatizaciones`, { type: db.QueryTypes.SELECT });
  const claves = new Set(existentes.map((e) => e.clave));
  for (const d of DEFAULTS) {
    if (claves.has(d.clave)) continue;
    const [id] = await db.query(
      `INSERT INTO recuperacion_automatizaciones
         (clave, nombre, descripcion, cohortes, activa, intervalo_dias, max_por_dia, ciclico)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      {
        replacements: [d.clave, d.nombre, d.descripcion, JSON.stringify(d.cohortes), d.intervalo_dias, d.max_por_dia, d.ciclico ? 1 : 0],
        type: db.QueryTypes.INSERT,
      },
    );
    for (const p of d.pasos) {
      await db.query(
        `INSERT INTO recuperacion_automatizacion_pasos
           (id_automatizacion, orden, titulo, texto_sugerido, nombre_template, parametros, espera_dias, aplica_descuento)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [id, p.orden, p.titulo, p.texto_sugerido, p.nombre_template, JSON.stringify(p.parametros), p.espera_dias, p.aplica_descuento ? 1 : 0],
          type: db.QueryTypes.INSERT,
        },
      );
    }
  }
}

const parseJson = (v, fb) => {
  if (v == null) return fb;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fb; }
};

/* ── Lectura ── */
async function listar() {
  await ensureTablas();
  const autos = await db.query(`SELECT * FROM recuperacion_automatizaciones ORDER BY id`, { type: db.QueryTypes.SELECT });
  const pasos = await db.query(`SELECT * FROM recuperacion_automatizacion_pasos ORDER BY id_automatizacion, orden`, { type: db.QueryTypes.SELECT });
  const stats = await db.query(
    `SELECT id_automatizacion,
            SUM(estado = 'encolado') AS encolados,
            SUM(estado = 'enviado') AS enviados,
            SUM(estado = 'error') AS errores,
            SUM(estado = 'omitido') AS omitidos,
            SUM(respondio_en IS NOT NULL) AS respondieron,
            SUM(descuento_aplicado = 1) AS descuentos,
            COUNT(DISTINCT id_usuario) AS clientes,
            MAX(created_at) AS ultimo
       FROM recuperacion_automatizacion_envios
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY id_automatizacion`,
    { type: db.QueryTypes.SELECT },
  );
  // Convertidos: el caso del cliente se cerró como recuperado después del primer envío.
  const conv = await db.query(
    `SELECT e.id_automatizacion, COUNT(DISTINCT e.id_usuario) AS convertidos
       FROM recuperacion_automatizacion_envios e
       JOIN recuperacion_casos_chat_center c
         ON c.id_usuario = e.id_usuario AND c.estado = 'recuperado' AND c.cerrado_en > e.created_at
      WHERE e.estado = 'enviado' AND e.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
      GROUP BY e.id_automatizacion`,
    { type: db.QueryTypes.SELECT },
  );
  const stMap = new Map(stats.map((s) => [s.id_automatizacion, s]));
  const convMap = new Map(conv.map((c) => [c.id_automatizacion, Number(c.convertidos)]));
  return autos.map((a) => {
    const s = stMap.get(a.id) || {};
    return {
      ...a,
      cohortes: parseJson(a.cohortes, []),
      activa: Number(a.activa) === 1,
      ciclico: Number(a.ciclico) === 1,
      solo_sin_respuesta: Number(a.solo_sin_respuesta) === 1,
      incluir_numero_conexion: Number(a.incluir_numero_conexion) === 1,
      pasos: pasos
        .filter((p) => p.id_automatizacion === a.id)
        .map((p) => ({ ...p, parametros: parseJson(p.parametros, []), activo: Number(p.activo) === 1, aplica_descuento: Number(p.aplica_descuento) === 1 })),
      stats: {
        encolados: Number(s.encolados || 0),
        enviados: Number(s.enviados || 0),
        errores: Number(s.errores || 0),
        omitidos: Number(s.omitidos || 0),
        respondieron: Number(s.respondieron || 0),
        descuentos: Number(s.descuentos || 0),
        clientes: Number(s.clientes || 0),
        convertidos: convMap.get(a.id) || 0,
        ultimo: s.ultimo || null,
      },
    };
  });
}

async function actualizar(id, cambios, actualizado_por) {
  await ensureTablas();
  const permitidos = ['activa', 'inicia_en', 'solo_sin_respuesta', 'intervalo_dias', 'max_por_dia', 'incluir_numero_conexion', 'stripe_coupon_id', 'descripcion'];
  const sets = [];
  const reps = [];
  for (const k of permitidos) {
    if (!Object.prototype.hasOwnProperty.call(cambios, k)) continue;
    let v = cambios[k];
    if (['activa', 'solo_sin_respuesta', 'incluir_numero_conexion'].includes(k)) v = v ? 1 : 0;
    if (k === 'inicia_en') v = v ? new Date(v) : null;
    if (['intervalo_dias', 'max_por_dia'].includes(k)) v = Math.max(1, Number(v) || 1);
    sets.push(`${k} = ?`);
    reps.push(v);
  }
  if (!sets.length) return;
  sets.push('actualizado_por = ?');
  reps.push(actualizado_por || null, id);
  await db.query(`UPDATE recuperacion_automatizaciones SET ${sets.join(', ')} WHERE id = ?`, { replacements: reps, type: db.QueryTypes.UPDATE });
}

async function actualizarPaso(idPaso, cambios) {
  await ensureTablas();
  const permitidos = ['titulo', 'texto_sugerido', 'nombre_template', 'language_code', 'parametros', 'espera_dias', 'aplica_descuento', 'activo'];
  const sets = [];
  const reps = [];
  for (const k of permitidos) {
    if (!Object.prototype.hasOwnProperty.call(cambios, k)) continue;
    let v = cambios[k];
    if (k === 'parametros') v = JSON.stringify(Array.isArray(v) ? v : []);
    if (['aplica_descuento', 'activo'].includes(k)) v = v ? 1 : 0;
    if (k === 'espera_dias') v = Math.max(0, Number(v) || 0);
    if (k === 'nombre_template') v = String(v || '').trim() || null;
    sets.push(`${k} = ?`);
    reps.push(v);
  }
  if (!sets.length) return;
  reps.push(idPaso);
  await db.query(`UPDATE recuperacion_automatizacion_pasos SET ${sets.join(', ')} WHERE id = ?`, { replacements: reps, type: db.QueryTypes.UPDATE });
}

async function envios({ id_automatizacion = null, limit = 100 } = {}) {
  await ensureTablas();
  return db.query(
    `SELECT e.*, a.nombre AS automatizacion, p.titulo AS paso_titulo,
            u.nombre AS empresa, u.email_propietario AS email,
            t.estado AS estado_programado, t.error_message
       FROM recuperacion_automatizacion_envios e
       JOIN recuperacion_automatizaciones a ON a.id = e.id_automatizacion
       LEFT JOIN recuperacion_automatizacion_pasos p ON p.id = e.id_paso
       LEFT JOIN usuarios_chat_center u ON u.id_usuario = e.id_usuario
       LEFT JOIN template_envios_programados t ON t.id = e.id_envio_programado
      ${id_automatizacion ? 'WHERE e.id_automatizacion = :id' : ''}
      ORDER BY e.id DESC LIMIT :limit`,
    { replacements: { id: id_automatizacion, limit: Math.min(Number(limit) || 100, 500) }, type: db.QueryTypes.SELECT },
  );
}

/* ── Variables ── */
const fmtFecha = (d) => (d ? new Date(d).toLocaleDateString('es-EC', { day: '2-digit', month: 'long' }) : '');
const fmtPrecio = (n) => (n != null ? `$${Number(n).toFixed(0)}` : '');

async function linkPagoDe(f) {
  // Factura abierta del customer en Stripe (pago rebotado). Si no hay, la
  // página de planes: nunca un enlace roto en el mensaje.
  try {
    const [u] = await db.query(`SELECT id_costumer FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`, { replacements: [f.id_usuario], type: db.QueryTypes.SELECT });
    if (u?.id_costumer) {
      const list = await stripe.invoices.list({ customer: u.id_costumer, status: 'open', limit: 1 });
      const inv = list?.data?.[0];
      if (inv?.hosted_invoice_url) return inv.hosted_invoice_url;
    }
  } catch (e) {
    console.warn('[recup-auto] link de pago no disponible:', e?.message);
  }
  return `${FRONT_BASE}/plan`;
}

async function resolverParametros(tokens, f) {
  const out = [];
  for (const t of tokens || []) {
    switch (String(t).trim()) {
      case '{{nombre}}': out.push((f.empresa || f.email || 'hola').split('@')[0].trim().slice(0, 40)); break;
      case '{{plan}}': out.push(f.nombre_plan || 'ImporChat'); break;
      case '{{precio}}': out.push(fmtPrecio(f.precio_plan)); break;
      case '{{link_pago}}': out.push(await linkPagoDe(f)); break;
      case '{{link_planes}}': out.push(`${FRONT_BASE}/planes`); break;
      case '{{fecha}}': out.push(fmtFecha(f.fecha_clave) || 'pronto'); break;
      case '{{dias}}': out.push(f.dias != null ? String(Math.abs(f.dias)) : ''); break;
      case '{{descuento}}': out.push('10%'); break;
      default: out.push(String(t)); // texto fijo
    }
  }
  // Meta rechaza parámetros vacíos: siempre algo.
  return out.map((v) => (v == null || v === '' ? '-' : String(v)));
}

/* ── Descuento en Stripe ── */
async function aplicarDescuento({ id_usuario, coupon }) {
  const [u] = await db.query(`SELECT id_costumer FROM usuarios_chat_center WHERE id_usuario = ? LIMIT 1`, { replacements: [id_usuario], type: db.QueryTypes.SELECT });
  if (!u?.id_costumer) return { ok: false, detalle: 'Sin customer de Stripe' };
  try {
    await stripe.coupons.retrieve(coupon);
  } catch (e) {
    if (e?.code !== 'resource_missing') return { ok: false, detalle: `Stripe: ${e.message}` };
    await stripe.coupons.create({ id: coupon, percent_off: 10, duration: 'once', name: 'Recuperación 10%' });
  }
  try {
    await stripe.customers.update(u.id_costumer, { coupon, metadata: { recuperacion_descuento: new Date().toISOString().slice(0, 10) } });
    return { ok: true, detalle: `Cupón ${coupon} aplicado al customer ${u.id_costumer} (próxima factura -10%)` };
  } catch (e) {
    return { ok: false, detalle: `Stripe: ${e.message}` };
  }
}

/* ── Encolar un envío ── */
const fmtSql = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

async function encolar({ auto, paso, f, expertos, origen = 'cron', id_caso = null, asesor_id = null }) {
  const cliente = await ensureUnifiedClient({
    id_configuracion: expertos.id_configuracion,
    id_usuario_dueno: expertos.id_usuario,
    source: 'wa',
    business_phone_id: expertos.id_telefono,
    phone: f.whatsapp_digits,
    nombre_cliente: String(f.empresa || '').trim(),
    apellido_cliente: '',
    motivo: 'recuperacion_automatizacion',
    permiso_round_robin: 0,
  });
  if (!cliente?.id) throw new Error('No se pudo crear el contacto en Expertos');

  // El chat queda a nombre del asesor que lleva el caso de recuperación: cuando
  // el cliente responda, le cae a él y no al reparto general de la conexión.
  if (asesor_id && !cliente.id_encargado) {
    await db.query(
      `UPDATE clientes_chat_center SET id_encargado = ?, chat_cerrado = 0 WHERE id = ?`,
      { replacements: [asesor_id, cliente.id], type: db.QueryTypes.UPDATE },
    );
  }

  const params = await resolverParametros(paso.parametros, f);
  const ahora = Date.now() + 60 * 1000; // en 1 minuto, el cron de programados lo toma
  const local = fmtSql(new Date(ahora + TZ_OFFSET_MS));
  const utc = fmtSql(new Date(ahora));
  const meta = {
    origen: 'recuperacion_automatizacion',
    automatizacion: auto.clave,
    paso: paso.orden,
    id_usuario_cliente: f.id_usuario,
    disparo: origen,
  };
  const [idProg] = await db.query(
    `INSERT INTO template_envios_programados
       (uuid_lote, id_configuracion, id_usuario, id_cliente_chat_center, telefono, telefono_configuracion,
        business_phone_id, waba_id, nombre_template, language_code, template_parameters_json,
        fecha_programada, fecha_programada_utc, timezone, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'America/Guayaquil', ?)`,
    {
      replacements: [
        crypto.randomUUID(), expertos.id_configuracion, expertos.id_usuario, cliente.id, f.whatsapp_digits,
        expertos.telefono, expertos.id_telefono, expertos.waba_id, paso.nombre_template, paso.language_code || 'es',
        JSON.stringify(params), local, utc, JSON.stringify(meta),
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  let descuento = { ok: false, detalle: null };
  if (paso.aplica_descuento) descuento = await aplicarDescuento({ id_usuario: f.id_usuario, coupon: auto.stripe_coupon_id || 'RECUPERACION10' });

  await db.query(
    `INSERT INTO recuperacion_automatizacion_envios
       (id_automatizacion, id_paso, orden, id_usuario, id_caso, telefono, id_cliente_chat, id_envio_programado,
        nombre_template, parametros_resueltos, origen, estado, descuento_aplicado, descuento_detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'encolado', ?, ?)`,
    {
      replacements: [
        auto.id, paso.id, paso.orden, f.id_usuario, id_caso, f.whatsapp_digits, cliente.id, idProg,
        paso.nombre_template, JSON.stringify(params), origen, descuento.ok ? 1 : 0, descuento.detalle,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  return { id_envio_programado: idProg, id_cliente_chat: cliente.id, descuento };
}

async function omitir({ auto, paso, f, motivo, origen = 'cron' }) {
  await db.query(
    `INSERT INTO recuperacion_automatizacion_envios
       (id_automatizacion, id_paso, orden, id_usuario, telefono, nombre_template, origen, estado, detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'omitido', ?)`,
    { replacements: [auto.id, paso?.id || 0, paso?.orden || 0, f.id_usuario, f.whatsapp_digits || null, paso?.nombre_template || null, origen, motivo], type: db.QueryTypes.INSERT },
  );
}

/* ── Sincronizar estados y respuestas ── */
async function sincronizar(expertos) {
  // 1) estado real desde la cola de programados
  await db.query(
    `UPDATE recuperacion_automatizacion_envios e
       JOIN template_envios_programados t ON t.id = e.id_envio_programado
        SET e.estado = CASE WHEN t.estado = 'enviado' THEN 'enviado'
                            WHEN t.estado IN ('error','cancelado') THEN 'error' ELSE e.estado END,
            e.enviado_en = COALESCE(t.enviado_en, e.enviado_en),
            e.detalle = CASE WHEN t.estado IN ('error','cancelado') THEN LEFT(COALESCE(t.error_message, t.estado), 255) ELSE e.detalle END
      WHERE e.estado = 'encolado' AND t.estado IN ('enviado','error','cancelado')`,
    { type: db.QueryTypes.UPDATE },
  );
  // 2) ¿respondió? Primer mensaje entrante del cliente en Expertos después del envío.
  //    Se cruza por los últimos 9 dígitos (0969… y 593969… son el mismo número).
  await db.query(
    `UPDATE recuperacion_automatizacion_envios e
       JOIN (
         SELECT e2.id, MIN(m.created_at) AS primera
           FROM recuperacion_automatizacion_envios e2
           JOIN mensajes_clientes m
             ON m.id_configuracion = :cfg AND m.rol_mensaje = 0
            AND RIGHT(REPLACE(REPLACE(m.celular_recibe, ' ', ''), '+', ''), 9) = RIGHT(e2.telefono, 9)
            AND m.created_at > COALESCE(e2.enviado_en, e2.created_at)
          WHERE e2.estado = 'enviado' AND e2.respondio_en IS NULL
            AND e2.created_at >= DATE_SUB(NOW(), INTERVAL 45 DAY)
          GROUP BY e2.id
       ) r ON r.id = e.id
        SET e.respondio_en = r.primera`,
    { replacements: { cfg: expertos.id_configuracion }, type: db.QueryTypes.UPDATE },
  );
}

/* ── Motor ── */
async function historialPorUsuario(ids) {
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT id_automatizacion, id_usuario, orden, estado, created_at, enviado_en, respondio_en
       FROM recuperacion_automatizacion_envios
      WHERE id_usuario IN (:ids) AND estado <> 'omitido'
      ORDER BY id`,
    { replacements: { ids }, type: db.QueryTypes.SELECT },
  );
  const map = new Map();
  for (const r of rows) {
    const k = `${r.id_automatizacion}|${r.id_usuario}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return { porAuto: map, todos: rows };
}

async function conversacionActiva(expertos, digits) {
  const [r] = await db.query(
    `SELECT COUNT(*) AS n FROM mensajes_clientes
      WHERE id_configuracion = ? AND rol_mensaje = 0
        AND RIGHT(REPLACE(REPLACE(celular_recibe, ' ', ''), '+', ''), 9) = RIGHT(?, 9)
        AND created_at >= DATE_SUB(NOW(), INTERVAL ${DIAS_CONVERSACION_ACTIVA} DAY)`,
    { replacements: [expertos.id_configuracion, digits], type: db.QueryTypes.SELECT },
  );
  return Number(r?.n || 0) > 0;
}

const diasDesde = (d) => (Date.now() - new Date(d).getTime()) / 86400000;

/**
 * Qué paso toca para este cliente en esta automatización, o null con el
 * motivo. `forzar` (envío manual) salta las esperas pero no el "ya respondió".
 */
function decidirPaso(auto, pasos, hist, { forzar = false, pasoForzado = null } = {}) {
  if (pasoForzado) return { paso: pasoForzado };
  if (!hist.length) return { paso: pasos[0] };
  const ultimo = hist[hist.length - 1];
  if (ultimo.estado === 'encolado') return { motivo: 'hay un envío en cola' };
  if (auto.solo_sin_respuesta) {
    const respuestas = hist.filter((h) => h.respondio_en);
    if (respuestas.length) {
      // Secuencia (pago, cancelación): si respondió, se acaba; la sigue el asesor.
      if (!auto.ciclico) return { motivo: 'respondió: la sigue el asesor' };
      // Nutrición: una respuesta pausa los tips 30 días (ya hay conversación),
      // pero no los corta para siempre: en 15 días vuelve a tener algo útil.
      const ultimaRespuesta = Math.max(...respuestas.map((h) => new Date(h.respondio_en).getTime()));
      if ((Date.now() - ultimaRespuesta) / 86400000 < 30) return { motivo: 'respondió hace menos de 30 días: tips en pausa' };
    }
  }
  if (ultimo.estado === 'error') {
    if (!forzar && diasDesde(ultimo.created_at) < 2) return { motivo: 'último envío falló hace menos de 2 días' };
    return { paso: pasos.find((p) => p.orden === ultimo.orden) || pasos[0] };
  }
  const idx = pasos.findIndex((p) => p.orden === ultimo.orden);
  let siguiente = pasos[idx + 1];
  if (!siguiente) {
    if (!auto.ciclico) return { motivo: 'secuencia completa' };
    // Nutrición: vuelve a empezar, pero no repite un tip visto en los últimos 60 días
    const recientes = new Set(hist.filter((h) => diasDesde(h.created_at) < 60).map((h) => h.orden));
    siguiente = pasos.find((p) => !recientes.has(p.orden)) || pasos[0];
  }
  const espera = auto.ciclico ? auto.intervalo_dias : siguiente.espera_dias;
  if (!forzar && diasDesde(ultimo.enviado_en || ultimo.created_at) < espera) {
    return { motivo: `esperando ${espera} días desde el paso ${ultimo.orden}` };
  }
  return { paso: siguiente };
}

/**
 * Corre todas las automatizaciones activas (lo llama el cron cada hora).
 * Devuelve un resumen por automatización: encolados / omitidos y por qué.
 */
async function correr({ ahora = new Date(), soloAuto = null, forzar = false, pasoForzado = null, idsUsuarios = null, origen = 'cron' } = {}) {
  await ensureTablas();
  const expertos = await recuperacion.conexionExpertos(null);
  if (!expertos?.id_configuracion || !expertos.id_telefono) {
    return { error: 'La conexión de Expertos no está disponible' };
  }
  const [cfg] = await db.query(`SELECT id_whatsapp AS waba_id, token FROM configuraciones WHERE id = ? LIMIT 1`, { replacements: [expertos.id_configuracion], type: db.QueryTypes.SELECT });
  expertos.waba_id = cfg?.waba_id || null;
  if (!expertos.waba_id || !cfg?.token) return { error: 'La conexión de Expertos no tiene credenciales de WhatsApp (WABA/token)' };

  await sincronizar(expertos);

  const autos = (await listar()).filter((a) => (soloAuto ? a.id === Number(soloAuto) : true));
  const filas = await recuperacion.clientesEnRiesgo();
  const porUsuario = new Map(filas.map((f) => [f.id_usuario, f]));
  const casosAbiertos = new Map(
    (await db.query(`SELECT id_caso, id_usuario, asignado_a_id FROM recuperacion_casos_chat_center WHERE estado = 'abierto'`, { type: db.QueryTypes.SELECT })).map((c) => [c.id_usuario, c]),
  );
  const { porAuto, todos } = await historialPorUsuario([...porUsuario.keys()]);
  const ultimoGlobal = new Map();
  for (const r of todos) {
    const prev = ultimoGlobal.get(r.id_usuario);
    if (!prev || new Date(r.created_at) > new Date(prev)) ultimoGlobal.set(r.id_usuario, r.created_at);
  }

  const resumen = [];
  for (const auto of autos) {
    const r = { id: auto.id, clave: auto.clave, nombre: auto.nombre, encolados: 0, omitidos: 0, motivos: {}, errores: [] };
    resumen.push(r);
    const activa = auto.activa && (!auto.inicia_en || new Date(auto.inicia_en) <= ahora);
    if (!forzar && !activa) { r.motivos.apagada = 1; continue; }
    const pasos = auto.pasos.filter((p) => p.activo && p.nombre_template);
    if (!pasos.length) { r.motivos.sin_plantillas = 1; continue; }
    const pasoF = pasoForzado ? pasos.find((p) => p.id === Number(pasoForzado)) : null;
    if (pasoForzado && !pasoF) { r.errores.push('El paso elegido no tiene plantilla o está inactivo'); continue; }

    const [hoy] = await db.query(
      `SELECT COUNT(*) AS n FROM recuperacion_automatizacion_envios WHERE id_automatizacion = ? AND estado <> 'omitido' AND created_at >= CURDATE()`,
      { replacements: [auto.id], type: db.QueryTypes.SELECT },
    );
    let cupo = Math.max(0, auto.max_por_dia - Number(hoy?.n || 0));

    let candidatos = filas.filter((f) => auto.cohortes.includes(f.cohorte));
    if (Array.isArray(idsUsuarios)) candidatos = candidatos.filter((f) => idsUsuarios.includes(f.id_usuario));

    for (const f of candidatos) {
      const omitir_ = (m) => { r.omitidos += 1; r.motivos[m] = (r.motivos[m] || 0) + 1; };
      if (!f.whatsapp_digits) { omitir_('sin número'); continue; }
      if (f.telefono_fuente === 'conexion' && !auto.incluir_numero_conexion) { omitir_('solo tiene el número de su bot'); continue; }
      const hist = porAuto.get(`${auto.id}|${f.id_usuario}`) || [];
      const d = decidirPaso(auto, pasos, hist, { forzar, pasoForzado: pasoF });
      if (!d.paso) { omitir_(d.motivo); continue; }
      if (!forzar) {
        const ug = ultimoGlobal.get(f.id_usuario);
        if (ug && diasDesde(ug) < MIN_DIAS_ENTRE_MENSAJES) { omitir_(`ya recibió otra automatización hace < ${MIN_DIAS_ENTRE_MENSAJES} días`); continue; }
      }
      if (await conversacionActiva(expertos, f.whatsapp_digits)) { omitir_('escribió hace poco: ya hay conversación'); continue; }
      if (cupo <= 0) { omitir_('tope diario alcanzado'); continue; }
      try {
        const caso = casosAbiertos.get(f.id_usuario) || null;
        await encolar({ auto, paso: d.paso, f, expertos, origen, id_caso: caso?.id_caso || null, asesor_id: caso?.asignado_a_id || null });
        r.encolados += 1;
        cupo -= 1;
        ultimoGlobal.set(f.id_usuario, new Date().toISOString());
      } catch (e) {
        r.errores.push(`${f.empresa || f.email}: ${e.message}`);
        await omitir({ auto, paso: d.paso, f, motivo: `error al encolar: ${e.message}`.slice(0, 255), origen });
      }
    }
  }
  return { ahora: ahora.toISOString(), expertos: { id_configuracion: expertos.id_configuracion, nombre: expertos.nombre }, resumen };
}

/** Qué pasaría si corriera ahora (sin encolar): para el botón "Simular". */
async function simular({ id_automatizacion }) {
  await ensureTablas();
  const autos = (await listar()).filter((a) => a.id === Number(id_automatizacion));
  const auto = autos[0];
  if (!auto) return { error: 'Automatización no encontrada' };
  const pasos = auto.pasos.filter((p) => p.activo && p.nombre_template);
  const filas = (await recuperacion.clientesEnRiesgo()).filter((f) => auto.cohortes.includes(f.cohorte));
  const { porAuto, todos } = await historialPorUsuario(filas.map((f) => f.id_usuario));
  const ultimoGlobal = new Map();
  for (const r of todos) {
    const prev = ultimoGlobal.get(r.id_usuario);
    if (!prev || new Date(r.created_at) > new Date(prev)) ultimoGlobal.set(r.id_usuario, r.created_at);
  }
  const porPaso = {};
  const motivos = {};
  const ejemplos = [];
  for (const f of filas) {
    let motivo = null;
    let paso = null;
    if (!pasos.length) motivo = 'sin plantillas configuradas';
    else if (!f.whatsapp_digits) motivo = 'sin número';
    else if (f.telefono_fuente === 'conexion' && !auto.incluir_numero_conexion) motivo = 'solo tiene el número de su bot';
    else {
      const d = decidirPaso(auto, pasos, porAuto.get(`${auto.id}|${f.id_usuario}`) || []);
      if (!d.paso) motivo = d.motivo;
      else {
        const ug = ultimoGlobal.get(f.id_usuario);
        if (ug && diasDesde(ug) < MIN_DIAS_ENTRE_MENSAJES) motivo = `ya recibió otra automatización hace < ${MIN_DIAS_ENTRE_MENSAJES} días`;
        else paso = d.paso;
      }
    }
    if (paso) {
      porPaso[paso.orden] = (porPaso[paso.orden] || 0) + 1;
      if (ejemplos.length < 8) ejemplos.push({ id_usuario: f.id_usuario, empresa: f.empresa, whatsapp: f.whatsapp, paso: paso.orden, titulo: paso.titulo });
    } else {
      motivos[motivo] = (motivos[motivo] || 0) + 1;
    }
  }
  const enviaria = Object.values(porPaso).reduce((s, n) => s + n, 0);
  return { candidatos: filas.length, enviaria: Math.min(enviaria, auto.max_por_dia), enviaria_sin_tope: enviaria, tope_diario: auto.max_por_dia, por_paso: porPaso, omitidos: motivos, ejemplos };
}

/* ── Crear las plantillas en Meta ── */
const axios = require('axios');
const EJEMPLO_VAR = {
  '{{nombre}}': 'Carolina',
  '{{plan}}': 'Plan ImporChat',
  '{{precio}}': '$39',
  '{{link_pago}}': 'https://invoice.stripe.com/i/acct_ejemplo/pagar',
  '{{link_planes}}': `${FRONT_BASE}/planes`,
  '{{fecha}}': '24 de octubre',
  '{{dias}}': '3',
  '{{descuento}}': '10%',
};

/**
 * Crea en la WABA de Expertos las plantillas de todos los pasos (una por
 * nombre; las de nutrición se comparten). Las que ya existen se omiten.
 * Categoría MARKETING salvo el aviso de pago rebotado (UTILITY); con
 * allow_category_change Meta la ajusta si no está de acuerdo. Devuelve el
 * resultado por plantilla; Meta las deja PENDING hasta aprobarlas.
 */
async function crearPlantillasEnMeta() {
  await ensureTablas();
  const [cfg] = await db.query(
    `SELECT id_whatsapp AS waba_id, token FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [Number(process.env.RECUPERACION_CONEXION_EXPERTOS || 265)], type: db.QueryTypes.SELECT },
  );
  if (!cfg?.waba_id || !cfg?.token) throw new Error('La conexión de Expertos no tiene WABA/token');
  const base = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v21.0'}/${cfg.waba_id}/message_templates`;
  const headers = { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };

  const existentes = new Set();
  let url = `${base}?limit=100&fields=name,status`;
  while (url) {
    const { data } = await axios.get(url, { headers, timeout: 30000 });
    for (const t of data?.data || []) existentes.add(t.name);
    url = data?.paging?.next || null;
  }

  const autos = await listar();
  const vistas = new Set();
  const resultados = [];
  for (const a of autos) {
    for (const p of a.pasos) {
      if (!p.nombre_template || vistas.has(p.nombre_template)) continue;
      vistas.add(p.nombre_template);
      if (existentes.has(p.nombre_template)) {
        resultados.push({ nombre: p.nombre_template, estado: 'ya existía' });
        continue;
      }
      const ejemplos = (p.parametros || []).map((t) => EJEMPLO_VAR[t] || String(t).replace(/[{}]/g, ''));
      const payload = {
        name: p.nombre_template,
        language: p.language_code || 'es',
        category: a.clave === 'pago_rebotado' && p.orden === 1 ? 'UTILITY' : 'MARKETING',
        allow_category_change: true,
        components: [
          {
            type: 'BODY',
            text: p.texto_sugerido,
            ...(ejemplos.length ? { example: { body_text: [ejemplos] } } : {}),
          },
        ],
      };
      try {
        const { data } = await axios.post(base, payload, { headers, timeout: 30000 });
        resultados.push({ nombre: p.nombre_template, estado: 'creada', meta: { id: data?.id, status: data?.status, category: data?.category } });
      } catch (e) {
        const err = e?.response?.data?.error;
        resultados.push({ nombre: p.nombre_template, estado: 'error', error: err?.error_user_msg || err?.message || e.message });
      }
    }
  }
  return resultados;
}

module.exports = {
  VARIABLES,
  ensureTablas,
  crearPlantillasEnMeta,
  listar,
  actualizar,
  actualizarPaso,
  envios,
  correr,
  simular,
  MIN_DIAS_ENTRE_MENSAJES,
};
