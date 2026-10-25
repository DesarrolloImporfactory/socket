/* «¿Cuánto debo?», «¿llegó mi pago?», «mi factura» con datos reales, para el
   bot de soporte de Expertos.

   Con el teléfono de WhatsApp del que escribe —y SOLO con ese dato— busca al
   alumno en Imporsuit (segunda conexión, `db_2`, la misma de cargaCliente) y
   lee su cartera: cuotas (`cuenta_por_pagar`), pagos registrados
   (`cartera_pagos`) y facturas electrónicas vigentes (`facturas_electronicas`,
   emitidas con Dátil). Son las mismas tablas que pinta la pantalla de cartera
   del asesor (AsesorModel::get_deudas_usuario).

   SOLO LECTURA: ni un INSERT, UPDATE ni DELETE; el adaptador se niega a correr
   lo que no empiece por SELECT. No usa la llave de Carterachat (esa también
   registra y borra pagos).

   SEGURIDAD — de quién es la cuenta:
     · Se busca por el número que entrega Meta, nunca por un número, correo o
       cotización que alguien ESCRIBA en el chat.
     · El WhatsApp guardado sin código de país solo vale si la moneda de sus
       cuotas es la del país del que escribe (USD → Ecuador, MXN → México).
     · Si el número está en cuentas de dos personas distintas (otro nombre),
       no se informa nada. Dos cuentas de la misma persona se suman (medido el
       24-oct: 6 de 300 chats). Si ninguna tiene cuotas ni facturas, es
       «sin cartera»: no hay nada que callar.
     · Al modelo solo le llega lo que el alumno necesita: concepto, cuota,
       saldo, fecha límite, pagos (fecha, monto, «con comprobante sí/no») y el
       número y PDF de la factura. Nunca la imagen del comprobante, la
       referencia bancaria ni el asesor. */

'use strict';

const { consultarImporsuit, esCorreoDePrueba } = require('./cargaCliente');
const { comoCoincide, colaCandidatos, paisDelTelefono } = require('./telefono');
const { fechaTexto, hoyEcuador } = require('./estadoCarga');
const { sinTildes } = require('./texto');

const LIMITE_MS = 8000;
const MAX_CUOTAS = 6; // pendientes que se listan
const MAX_PAGOS = 3; // últimos pagos que se listan
const MAX_FACTURAS = 4;
const ROLES_ALUMNO = [3, 4, 14, 16, 18];
const PAIS_DE_MONEDA = { USD: 'ec', MXN: 'mx', COP: 'co' };

const COLA_SQL = (col, conRegexp = true) =>
  conRegexp
    ? `RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 9)`
    : `RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', ''), 9)`;

/* El WhatsApp de la plataforma más antigua del alumno (igual que cargaCliente). */
const SQL_USUARIOS = (conRegexp) => `
  SELECT up.id_usuario AS id_users, p.whatsapp, u.email_users AS email, u.nombre_users AS nombre
    FROM plataformas p
    INNER JOIN usuario_plataforma up ON up.id_plataforma = p.id_plataforma
    INNER JOIN users u ON u.id_users = up.id_usuario
   WHERE ${COLA_SQL('p.whatsapp', conRegexp)} = ?
     AND u.id_rol IN (${ROLES_ALUMNO.join(', ')})
     AND up.id_plataforma = (SELECT MIN(x.id_plataforma) FROM usuario_plataforma x
                              WHERE x.id_usuario = up.id_usuario)
   LIMIT 20`;

/* estado: 0 pendiente, 1 pagada (AsesorModel::eliminar_pago); otro = anulada. */
const SQL_CUOTAS = `
  SELECT cpp.id_cpp, c.id_users, cpp.concepto, cpp.estado, cpp.monto_original, cpp.monto_pendiente,
         DATE_FORMAT(cpp.fecha_limite, '%Y-%m-%d') AS fecha_limite,
         DATE_FORMAT(cpp.fecha_emision, '%Y-%m-%d') AS fecha_emision,
         cpp.num_cuota, cpp.total_cuotas, cpp.id_cotizacion, cpp.moneda
    FROM carteras c
    INNER JOIN cuenta_por_pagar cpp ON cpp.id_cartera = c.id_cartera
   WHERE c.id_users IN (?)
   ORDER BY cpp.fecha_limite ASC, cpp.id_cpp ASC
   LIMIT 200`;

const SQL_PAGOS = `
  SELECT cp.id_cpp, cp.monto_pagado, cp.moneda,
         DATE_FORMAT(COALESCE(cp.fecha_transaccion, cp.fecha_pago), '%Y-%m-%d') AS fecha,
         JSON_LENGTH(IFNULL(cp.imagenes, '[]')) > 0 AS con_comprobante
    FROM cartera_pagos cp
   WHERE cp.id_cpp IN (?)
   ORDER BY COALESCE(cp.fecha_transaccion, cp.fecha_pago) DESC, cp.id_cd DESC
   LIMIT 50`;

/* Facturas del alumno: las de cuotas (id_cpp) y las de cargas (id_cotizacion).
   `id_users` es siempre el comprador (medido el 24-oct: 79 de 79). */
const SQL_FACTURAS = `
  SELECT f.id_users, f.id_cpp, f.id_cotizacion, f.estado, f.establecimiento, f.punto_emision, f.secuencial,
         f.datil_id, f.importe_total, DATE_FORMAT(COALESCE(f.fecha_autorizacion, f.fecha_creacion), '%Y-%m-%d') AS fecha
    FROM facturas_electronicas f
   WHERE f.vigente = 1 AND f.id_users IN (?)
   ORDER BY f.fecha_creacion DESC
   LIMIT 20`;

const conLimite = (promesa, ms) =>
  Promise.race([
    promesa,
    new Promise((_, rechazar) => {
      const t = setTimeout(() => rechazar(new Error(`sin respuesta en ${ms} ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
/** «1.250,00 USD» — formato de Ecuador, como lo lee el alumno. */
function monto(v, moneda) {
  const [ent, dec] = num(v).toFixed(2).split('.');
  return `${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}${moneda ? ` ${moneda}` : ''}`;
}
/** Número de la factura (FacturaElectronicaModel::numero). */
function numeroFactura(f) {
  if (!f.secuencial) return null;
  return `${f.establecimiento}-${f.punto_emision}-${String(f.secuencial).padStart(9, '0')}`;
}
/** PDF público de Dátil (DatilService::urls). */
function pdfFactura(datilId) {
  const id = String(datilId || '').trim();
  return /^[A-Za-z0-9]+$/.test(id) ? `https://app.datil.co/ver/${id}/pdf` : null;
}
const concepto = (c) => String(c || '').replace(/\s+/g, ' ').trim().slice(0, 90);
const cuotaDe = (c) => (Number(c.total_cuotas) > 1 ? ` (cuota ${c.num_cuota}/${c.total_cuotas})` : '');

const VACIO = (estado, motivo) => ({ estado, motivo, pendientes: [], pagos: [], facturas: [], totales: [], pagadas: 0 });

/**
 * La cartera del número de WhatsApp que escribe.
 * @param {string} telefono  número del remitente, como lo entrega Meta
 * @param {object} [o]  consultar (doble en pruebas), limite_ms
 * @returns {Promise<object>} estado: encontrado | sin_cartera | varios_clientes |
 *          telefono_no_valido | error
 */
async function pagosDelTelefono(telefono, o = {}) {
  const consultar = o.consultar || consultarImporsuit;
  const cola = colaCandidatos(telefono);
  if (!cola) return VACIO('telefono_no_valido', 'el número del remitente no sirve para buscar');
  try {
    return await conLimite(buscar(telefono, cola, consultar), o.limite_ms || LIMITE_MS);
  } catch (err) {
    return VACIO('error', `no se pudo consultar: ${err.message}`);
  }
}

/**
 * Los alumnos de Imporsuit con este WhatsApp (sin cuentas de prueba).
 * @returns {Promise<{como: Map<number,'exacto'|'nacional'>, persona: Map<number,string>}>}
 *          `persona` = dos primeras palabras del nombre (o el correo): dos
 *          cuentas con la misma persona se pueden sumar.
 */
async function alumnosDelTelefono(telefono, cola, consultar) {
  const usuarios = await consultar(SQL_USUARIOS(true), [cola]).catch((e) => {
    if (!/regexp_replace|function .* does not exist/i.test(String(e.message))) throw e;
    return consultar(SQL_USUARIOS(false), [cola]);
  });
  const como = new Map(); // id → 'exacto' | 'nacional'
  const persona = new Map(); // id → nombre (dos primeras palabras) o correo
  for (const u of usuarios || []) {
    if (esCorreoDePrueba(u.email)) continue;
    const c = comoCoincide(telefono, u.whatsapp);
    const id = Number(u.id_users);
    if (!c || !id) continue;
    if (como.get(id) !== 'exacto') como.set(id, c);
    const nombre = sinTildes(u.nombre).replace(/[^a-z ]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
    persona.set(id, nombre || String(u.email || '').trim().toLowerCase() || `id:${id}`);
  }
  return { como, persona };
}

async function buscar(telefono, cola, consultar) {
  const { como, persona } = await alumnosDelTelefono(telefono, cola, consultar);
  if (!como.size) return VACIO('sin_cartera', 'ningún alumno con este número');
  const ids = [...como.keys()];
  const [cuotasTodas, facturasTodas] = await Promise.all([
    consultar(SQL_CUOTAS, [ids]),
    consultar(SQL_FACTURAS, [ids]).catch(() => []), // la tabla puede no existir
  ]);

  /* Guardado sin código de país: solo valen sus cuotas en la moneda del país
     del que escribe. El mismo 987654321 es un móvil de Ecuador y otro de Perú.
     Sus facturas no traen moneda: solo valen las de un número exacto. */
  const pais = paisDelTelefono(telefono);
  const cuotas = (cuotasTodas || []).filter((c) => {
    const m = como.get(Number(c.id_users));
    if (m === 'exacto') return true;
    return m === 'nacional' && PAIS_DE_MONEDA[String(c.moneda || '').toUpperCase()] === pais;
  });
  const facturas = (facturasTodas || []).filter((f) => como.get(Number(f.id_users)) === 'exacto');
  if (!cuotas.length && !facturas.length) return VACIO('sin_cartera', 'el número no tiene cuotas ni facturas');
  const personas = new Set(ids.map((id) => persona.get(id)));
  if (personas.size > 1) return VACIO('varios_clientes', `el número está en cuentas de ${personas.size} personas`);

  const propias = cuotas.filter((c) => [0, 1].includes(Number(c.estado)));
  const idsCpp = propias.map((c) => Number(c.id_cpp));
  const pagos = idsCpp.length ? await consultar(SQL_PAGOS, [idsCpp]) : [];

  const pendientes = propias
    .filter((c) => Number(c.estado) === 0 && num(c.monto_pendiente) > 0.009)
    .map((c) => ({
      id_cpp: Number(c.id_cpp),
      concepto: concepto(c.concepto),
      cuota: cuotaDe(c),
      moneda: String(c.moneda || '').toUpperCase() || null,
      original: num(c.monto_original),
      pendiente: num(c.monto_pendiente),
      fecha_limite: c.fecha_limite || null,
    }));
  const totales = {};
  for (const p of pendientes) totales[p.moneda || ''] = num((totales[p.moneda || ''] || 0) + p.pendiente);
  const monedaDe = new Map(propias.map((c) => [Number(c.id_cpp), String(c.moneda || '').toUpperCase() || null]));
  const conceptoDe = new Map(propias.map((c) => [Number(c.id_cpp), `${concepto(c.concepto)}${cuotaDe(c)}`]));

  const facturasOut = (facturas || []).slice(0, MAX_FACTURAS).map((f) => ({
    de: Number(f.id_cpp) > 0 ? conceptoDe.get(Number(f.id_cpp)) || 'un pago' : f.id_cotizacion ? `la cotización N.º ${f.id_cotizacion}` : 'un pago',
    estado: String(f.estado || '').toLowerCase(),
    numero: numeroFactura(f),
    pdf: String(f.estado || '').toLowerCase() === 'autorizada' ? pdfFactura(f.datil_id) : null,
    fecha: f.fecha || null,
  }));

  if (!propias.length && !facturasOut.length) return VACIO('sin_cartera', 'el alumno no tiene cuotas registradas');
  return {
    estado: 'encontrado',
    motivo: `${pendientes.length} cuota(s) pendiente(s)`,
    pendientes: pendientes.slice(0, MAX_CUOTAS),
    hay_mas: Math.max(0, pendientes.length - MAX_CUOTAS),
    totales: Object.entries(totales).map(([moneda, total]) => ({ moneda: moneda || null, total })),
    pagadas: propias.filter((c) => Number(c.estado) === 1).length,
    pagos: (pagos || []).slice(0, MAX_PAGOS).map((p) => ({
      fecha: p.fecha || null,
      monto: num(p.monto_pagado),
      moneda: String(p.moneda || '').toUpperCase() || monedaDe.get(Number(p.id_cpp)) || null,
      de: conceptoDe.get(Number(p.id_cpp)) || '',
      con_comprobante: Boolean(Number(p.con_comprobante)),
    })),
    facturas: facturasOut,
  };
}

/* ── Lo que se le entrega al modelo ───────────────────────────────────────── */

const ESTADO_FACTURA = {
  autorizada: null, // se da número y PDF
  procesando: 'en proceso de emisión',
  error: 'con un problema al emitirse: la revisa cobranza',
  rechazada: 'con un problema al emitirse: la revisa cobranza',
};

/** Bloque de contexto con la cartera, armado en código. */
/* «fecha límite 5 de noviembre» o, si ya pasó, «venció el 10 de octubre». */
const plazo = (f, hoy) => (!f ? '' : f < hoy ? `venció el ${fechaTexto(f)}` : `fecha límite ${fechaTexto(f)}`);

function bloquePagos(r, { hoy = hoyEcuador() } = {}) {
  const cab = '💳 PAGOS DE ESTE CLIENTE — leído ahora de la cartera, buscando SOLO por el número de WhatsApp desde el que escribe';
  if (r.estado === 'varios_clientes')
    return `${cab}: ESTE NÚMERO ESTÁ EN LA CUENTA DE VARIOS ALUMNOS. No digas montos, cuotas, pagos ni facturas. Dile que cobranza lo revisa y usa pasar_a_humano con motivo pago.`;
  if (r.estado === 'error' || r.estado === 'telefono_no_valido')
    return `${cab}: NO SE PUDO CONSULTAR. No digas montos ni si pagó. Usa pasar_a_humano con motivo pago.`;
  if (r.estado !== 'encontrado')
    return `${cab}: no hay cuotas ni facturas registradas con este número. No digas que no debe ni que no pagó (puede estar registrado con otro número). Si pregunta por su pago o su factura, pide su correo o su número de cotización y usa pasar_a_humano con motivo pago.`;

  const L = [`${cab}:`];
  if (!r.pendientes.length) L.push('Cuotas pendientes: ninguna. Todo lo registrado está pagado.');
  else {
    L.push(`Saldo pendiente: ${r.totales.map((t) => monto(t.total, t.moneda)).join(' y ')}.`);
    L.push(`Cuotas pendientes${r.hay_mas ? ` (las ${r.pendientes.length} más próximas de ${r.pendientes.length + r.hay_mas})` : ''}:`);
    for (const p of r.pendientes) {
      const parcial = p.pendiente < p.original ? ` de ${monto(p.original, p.moneda)}` : '';
      L.push(`- ${p.concepto}${p.cuota}: debe ${monto(p.pendiente, p.moneda)}${parcial}${p.fecha_limite ? `, ${plazo(p.fecha_limite, hoy)}` : ''}.`);
    }
  }
  if (r.pagadas) L.push(`Cuotas ya pagadas: ${r.pagadas}.`);
  if (r.pagos.length) {
    L.push('Últimos pagos registrados:');
    for (const p of r.pagos)
      L.push(`- ${p.fecha ? fechaTexto(p.fecha) : 'sin fecha'}: ${monto(p.monto, p.moneda)}${p.de ? ` a ${p.de}` : ''} (${p.con_comprobante ? 'con comprobante' : 'sin comprobante adjunto'}).`);
  } else L.push('Pagos registrados: ninguno.');
  if (r.facturas.length) {
    L.push('Facturas:');
    for (const f of r.facturas) {
      const extra = ESTADO_FACTURA[f.estado];
      if (f.estado === 'autorizada' && f.numero)
        L.push(`- De ${f.de}: factura N.º ${f.numero}${f.fecha ? ` del ${fechaTexto(f.fecha)}` : ''}${f.pdf ? `. PDF: ${f.pdf}` : ''}`);
      else L.push(`- De ${f.de}: ${extra || 'la revisa cobranza'}.`);
    }
  } else L.push('Facturas emitidas: ninguna.');
  L.push('');
  L.push('Cómo usarlo: di solo lo que está aquí, con los mismos montos, fechas y enlaces. Si dice que ya pagó y ese pago no está en la lista, NO le digas que no pagó: dile que cobranza lo registra con su comprobante y usa pasar_a_humano con motivo pago. Si pide una factura que no está, usa pasar_a_humano con motivo pago. Nunca digas cuentas bancarias, ni que «verificaste» un comprobante.');
  return L.join('\n');
}

/**
 * Texto seguro, armado en código, para cuando la guardia rechaza lo que
 * escribió el modelo y la pregunta era de pagos o de factura. null si el
 * caso tiene que verlo una persona.
 */
function textoPagosParaCliente(r, { pideFactura = false, hoy = hoyEcuador() } = {}) {
  if (r?.estado !== 'encontrado') return null;
  const autorizadas = r.facturas.filter((f) => f.estado === 'autorizada' && f.numero && f.pdf);
  if (pideFactura) {
    if (!autorizadas.length) return null;
    return `Hola, estas son tus facturas:\n${autorizadas.map((f) => `- De ${f.de}: N.º ${f.numero}. PDF: ${f.pdf}`).join('\n')}`;
  }
  if (!r.pendientes.length) return 'Hola, en tu cuenta no tienes cuotas pendientes: todo lo registrado está pagado.';
  const proxima = r.pendientes[0];
  return (
    `Hola, tu saldo pendiente es ${r.totales.map((t) => monto(t.total, t.moneda)).join(' y ')}.` +
    ` La próxima cuota es ${proxima.concepto}${proxima.cuota}: ${monto(proxima.pendiente, proxima.moneda)}` +
    `${proxima.fecha_limite ? (proxima.fecha_limite < hoy ? `; venció el ${fechaTexto(proxima.fecha_limite)}` : `, con fecha límite ${fechaTexto(proxima.fecha_limite)}`) : ''}.`
  );
}

/* Las formas en que el modelo puede escribir un mismo monto. Solo van al
   respaldo de la guardia (nunca al cliente): sin esto, «$1.250» contra el
   «1.250,00 USD» leído cambiaba una respuesta correcta por el paso a asesor. */
function formasDeMonto(v) {
  const n = num(v);
  const [ent, dec] = n.toFixed(2).split('.');
  const conPuntos = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const conComas = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const numeros = new Set([ent, `${ent},${dec}`, `${ent}.${dec}`, conPuntos, `${conPuntos},${dec}`, conComas, `${conComas}.${dec}`]);
  if (dec === '00') numeros.add(ent);
  else if (dec.endsWith('0')) {
    // 12,50 → «12,5» / «12.5»
    numeros.add(`${conPuntos},${dec[0]}`);
    numeros.add(`${ent}.${dec[0]}`);
  }
  const formas = [];
  for (const x of numeros) {
    formas.push(`$${x}`, `$ ${x}`, `us$${x}`, `usd ${x}`, `usd${x}`, `${x} usd`, `${x} dolares`, `${x} pesos`, `${x} mxn`);
  }
  return formas;
}
function variantesDeMontos(r) {
  if (r?.estado !== 'encontrado') return '';
  const montos = [
    ...r.totales.map((t) => t.total),
    ...r.pendientes.flatMap((p) => [p.pendiente, p.original]),
    ...r.pagos.map((p) => p.monto),
  ];
  return `Montos leídos de la cartera: ${[...new Set(montos.flatMap(formasDeMonto))].join(' · ')}`;
}

/* ¿El cliente PREGUNTA por su saldo o su factura? «Ya pagué», «te mando el
   comprobante» no: eso lo registra cobranza y no se le contesta con el saldo. */
const RE_AVISA_PAGO = /\b(?:ya (?:pague|transferi|deposite|cancele|realice el pago|hice el pago)|te (?:envio|mando|adjunto) el (?:comprobante|pago)|aqui (?:esta|va) (?:el|mi) (?:comprobante|pago)|comprobante)\b/;
const RE_PIDE_FACTURA = /\bfactur\w*/;
const RE_PIDE_SALDO =
  /\b(?:cuanto (?:debo|me falta|me queda|tengo que pagar|es mi cuota|pago)|mi saldo|el saldo|saldo pendiente|estado de cuenta|(?:mi |la )?proxima cuota|mis cuotas|cuando (?:tengo que|me toca|debo) pagar|fecha (?:de pago|limite)|se registro mi pago|registraron mi pago|les llego mi pago|ya les llego (?:el|mi) pago)\b/;
function pidePagos(texto) {
  const t = sinTildes(texto);
  if (RE_AVISA_PAGO.test(t) && !/\bse registro|registraron|les llego\b/.test(t)) return null;
  if (RE_PIDE_FACTURA.test(t)) return 'factura';
  if (RE_PIDE_SALDO.test(t)) return 'saldo';
  return null;
}

module.exports = {
  pagosDelTelefono,
  alumnosDelTelefono,
  bloquePagos,
  textoPagosParaCliente,
  variantesDeMontos,
  pidePagos,
  monto,
  numeroFactura,
  pdfFactura,
};
