/* «Consentidos»: el equipo de Expertos le escribe PRIMERO al alumno en los
   momentos que importan, para que no tenga que preguntar.

   Medido el 25-oct en la 265 (30 días): 50 chats se quejaron de abandono
   («nadie me responde», «sigo esperando») y 26 eran por la carga. Lo que hoy
   les escribimos sin que pregunten es venta o renovación de IMPORCHAT
   (cron_template_programado) y pedidos de valoración: nada les cuenta cómo va
   su carga. Diseño: side-session-notes/…/consentidos_diseno_2026-10-25.md.

   TRAMO 1 = ENSAYO. Este módulo decide; `scripts/consentidos_soporte_expertos.js`
   lee la base y arma el resumen diario para Daniel. Ninguno de los dos tiene
   código de envío.

   Todo gira alrededor de un día de referencia `ref` ('YYYY-MM-DD', hora de
   Ecuador): lo que pasó ese día dispara el momento, y en modo real se le
   escribiría al día siguiente en horario del equipo.

   Momentos (orden = prioridad; a cada alumno le toca uno por día como mucho):
     carga     bodega_destino · puerto · zarpo · novedad · contenedor_cerrado ·
               en_contenedor · recibido_china · entregada · sigue_en_camino
     dinero    pago_recibido
     curso     logro · post_reunion · primera_clase · te_guarde
   Solo para el equipo (nunca al cliente): estimada_vencida.

   Candados (aplicarCandados), en este orden:
     1. pidió que no le escriban                 → no
     2. no tiene chat en la línea                → no (sin chat no hay a quién)
     3. bot apagado en el chat / gestión abierta → aviso al asesor, no al cliente
     4. ya recibió un «consentido» esta semana   → no (los de carga admiten 2)
     5. le llegó otro automático en 24 h         → pasa al día siguiente
     6. si no escribió en 24 h                   → solo con plantilla de Meta

   Puro: no lee ni escribe nada y no mira el reloj (`ahora` entra por
   parámetro). */

'use strict';

const T = require('./textos');
const { esAutomatico } = require('./seguimiento');
const { PASO_DE_CONTENEDOR } = require('./estadoCarga');

const MOMENTOS = Object.freeze({
  bodega_destino: { grupo: 'carga', prioridad: 1 },
  puerto: { grupo: 'carga', prioridad: 2 },
  zarpo: { grupo: 'carga', prioridad: 3 },
  novedad: { grupo: 'carga', prioridad: 4 },
  contenedor_cerrado: { grupo: 'carga', prioridad: 5 },
  en_contenedor: { grupo: 'carga', prioridad: 6 },
  recibido_china: { grupo: 'carga', prioridad: 7 },
  entregada: { grupo: 'carga', prioridad: 8 },
  sigue_en_camino: { grupo: 'carga', prioridad: 9 },
  pago_recibido: { grupo: 'dinero', prioridad: 10 },
  logro: { grupo: 'curso', prioridad: 11 },
  post_reunion: { grupo: 'curso', prioridad: 12 },
  primera_clase: { grupo: 'curso', prioridad: 13 },
  te_guarde: { grupo: 'curso', prioridad: 14 },
});

const NOMBRE_MOMENTO = Object.freeze({
  bodega_destino: 'Tu carga llegó a la bodega',
  puerto: 'Tu carga llegó al puerto',
  zarpo: 'Tu carga zarpó',
  novedad: 'Novedad del contenedor',
  contenedor_cerrado: 'Se cerró tu contenedor',
  en_contenedor: 'Tu carga subió al contenedor',
  recibido_china: 'Llegó a la bodega de China',
  entregada: 'Carga entregada: ¿llegó bien?',
  sigue_en_camino: 'Sigue en camino (cada 10 días)',
  pago_recibido: 'Recibimos tu pago',
  logro: 'Terminaste los módulos 1 y 2',
  post_reunion: '¿Te quedó alguna duda de la reunión?',
  primera_clase: 'Día 3 sin abrir ninguna clase',
  te_guarde: 'Te guardé donde te quedaste (14 días)',
});

const CADA_DIAS_EN_CAMINO = 10;
const DIAS_PRIMERA_CLASE = 3;
const DIAS_TE_GUARDE = 14;
const MIN_LECCIONES_TE_GUARDE = 5;
const TOPE_SEMANA = 1;
const TOPE_SEMANA_CARGA = 2;
const DIA_MS = 24 * 3600 * 1000;
const RESPONSABLE = 'IA_Consentidos';
const ENLACE_AGENDA = 'https://imporfactory.app/cursos/32?contenido=737';

/* ── Fechas: 'YYYY-MM-DD' (o 'YYYY-MM-DD HH:MM…') → día ─────────────────── */
const dia = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const msDia = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
};
/** Días de `a` a `b` (b − a); null si falta alguna. */
function diasEntre(a, b) {
  const x = msDia(dia(a));
  const y = msDia(dia(b));
  return x === null || y === null ? null : Math.round((y - x) / DIA_MS);
}
const MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function fechaLarga(d) {
  const ms = msDia(dia(d));
  if (ms === null) return '';
  const f = new Date(ms);
  return `${f.getUTCDate()} de ${MESES[f.getUTCMonth() + 1]}`;
}
function diaSemana(d) {
  const ms = msDia(dia(d));
  if (ms === null) return '';
  const f = new Date(ms);
  return `${DIAS_SEMANA[f.getUTCDay()]} ${f.getUTCDate()}`;
}

/* ── Carga ──────────────────────────────────────────────────────────────── */
/**
 * Momentos de carga de UNA cotización en el día `ref`.
 * @param {object} cot
 *   marcas        [{ codigo, fecha_recibida, cajas }]
 *   asignada      fecha en que la cotización subió a su contenedor (cotizacion_carga.created_at)
 *   contenedor    { nombre, destino, estado, fecha_cierre, fecha_salida, fecha_puerto,
 *                   fecha_bodega_destino, fecha_estimada, nota_cliente, nota_cliente_at } | null
 *   entrega       { estado, fecha_entrega } | null
 * @param {string} ref 'YYYY-MM-DD'
 * @returns {Array<{ momento, datos }>} ordenados por prioridad
 */
function momentosDeCarga(cot, ref) {
  const out = [];
  const el = (f) => dia(f) === ref;
  const cont = cot.contenedor || null;
  const nombreCont = cont?.nombre ? String(cont.nombre) : '';

  if (cot.entrega && el(cot.entrega.fecha_entrega) && /entreg/i.test(String(cot.entrega.estado || '')))
    out.push({ momento: 'entregada', datos: {} });

  if (cont) {
    const llego = dia(cont.fecha_bodega_destino);
    if (el(cont.fecha_bodega_destino)) out.push({ momento: 'bodega_destino', datos: { contenedor: nombreCont, destino: cont.destino } });
    if (el(cont.fecha_puerto) && !llego) out.push({ momento: 'puerto', datos: { contenedor: nombreCont } });
    if (el(cont.fecha_salida) && !llego) out.push({ momento: 'zarpo', datos: { contenedor: nombreCont, estimada: estimadaVigente(cont, ref) } });
    if (el(cont.nota_cliente_at) && String(cont.nota_cliente || '').trim())
      out.push({ momento: 'novedad', datos: { contenedor: nombreCont, nota: String(cont.nota_cliente).trim() } });
    if (el(cont.fecha_cierre) && !dia(cont.fecha_salida)) out.push({ momento: 'contenedor_cerrado', datos: { contenedor: nombreCont } });
    if (el(cot.asignada) && !dia(cont.fecha_cierre)) out.push({ momento: 'en_contenedor', datos: { contenedor: nombreCont } });

    // Sigue en camino: cada 10 días desde que zarpó (o se cerró), mientras el
    // contenedor esté cerrado o en tránsito (pasos 3-4). En aduana, liberado o
    // en bodega ya no «va en camino». Si el equipo dejó una novedad para el
    // cliente, se cuenta esa novedad en vez de decir «sin novedades».
    const desde = dia(cont.fecha_salida) || dia(cont.fecha_cierre);
    const dias = desde ? diasEntre(desde, ref) : null;
    const paso = PASO_DE_CONTENEDOR[String(cont.estado || '').trim().toLowerCase()] || null;
    if (!llego && !dia(cont.fecha_puerto) && dia(cont.fecha_cierre) && (paso === 3 || paso === 4) && dias > 0 && dias % CADA_DIAS_EN_CAMINO === 0) {
      const nota = String(cont.nota_cliente || '').trim();
      out.push({ momento: 'sigue_en_camino', datos: { contenedor: nombreCont, estimada: estimadaVigente(cont, ref), dias, nota } });
    }
  }

  const recibidas = (cot.marcas || []).filter((m) => el(m.fecha_recibida));
  if (recibidas.length) {
    const cajas = recibidas.reduce((s, m) => s + (Number(m.cajas) || 0), 0);
    out.push({ momento: 'recibido_china', datos: { marca: recibidas.map((m) => m.codigo).filter(Boolean).join(', '), cajas } });
  }
  return ordenar(out);
}

/** La fecha estimada solo se nombra si todavía no pasó (regla de estadoCarga). */
function estimadaVigente(cont, ref) {
  const f = dia(cont?.fecha_estimada);
  return f && diasEntre(ref, f) >= 0 ? f : null;
}

/** ¿Este contenedor vence su fecha estimada hoy sin haber llegado? Solo para el equipo. */
function estimadaVencida(cont, ref) {
  const f = dia(cont?.fecha_estimada);
  return Boolean(f && dia(cont?.fecha_cierre) && !dia(cont?.fecha_bodega_destino) && diasEntre(f, ref) === 1);
}

/* ── Alumno: pagos, logros, reuniones, clases ───────────────────────────── */
/**
 * @param {object} a
 *   alta            users.date_added
 *   lecciones       cuántas lecciones tiene con avance
 *   ultimoAvance    fecha del último avance (cursos_contenido_progreso.updated_at)
 *   ultimaLeccion   { titulo, enlace } de ese último avance
 *   modulosListosEl fecha en que completó la última lección de los módulos 1 y 2 (si los completó)
 *   pagos           [{ fecha, monto, moneda }] registrados
 *   reuniones       [{ inicio (día en Ecuador), estado }]
 */
function momentosDeAlumno(a, ref) {
  const out = [];
  const el = (f) => dia(f) === ref;
  const pagosHoy = (a.pagos || []).filter((p) => el(p.fecha) && Number(p.monto) > 0);
  if (pagosHoy.length) {
    const moneda = pagosHoy[0].moneda || 'USD';
    const total = pagosHoy.filter((p) => (p.moneda || 'USD') === moneda).reduce((s, p) => s + Number(p.monto), 0);
    out.push({ momento: 'pago_recibido', datos: { monto: monto(total, moneda) } });
  }
  if (el(a.modulosListosEl)) out.push({ momento: 'logro', datos: { enlace: ENLACE_AGENDA } });
  const reunion = (a.reuniones || []).find((r) => el(r.inicio) && !/cancel/i.test(String(r.estado || '')));
  if (reunion) out.push({ momento: 'post_reunion', datos: { dia: diaSemana(reunion.inicio) } });
  const lecciones = Number(a.lecciones) || 0;
  if (lecciones === 0 && diasEntre(a.alta, ref) === DIAS_PRIMERA_CLASE) out.push({ momento: 'primera_clase', datos: { enlace: T.LINKS.plataforma } });
  if (lecciones >= MIN_LECCIONES_TE_GUARDE && diasEntre(a.ultimoAvance, ref) === DIAS_TE_GUARDE && a.ultimaLeccion?.enlace)
    out.push({ momento: 'te_guarde', datos: { leccion: a.ultimaLeccion.titulo, enlace: a.ultimaLeccion.enlace } });
  return ordenar(out);
}

function monto(n, moneda) {
  const v = Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return moneda === 'MXN' ? `$${v} MXN` : `$${v}`;
}

const ordenar = (lista) => lista.sort((x, y) => MOMENTOS[x.momento].prioridad - MOMENTOS[y.momento].prioridad);

/** El de más prioridad de todos los momentos de un alumno (o null). */
const elegir = (lista) => ordenar([...lista])[0] || null;

/* ── Candados ───────────────────────────────────────────────────────────── */
const PIDE_NO_ESCRIBIR =
  /\b(no me (escriban|escribas|manden|envien|envíen) (mas|más)|ya no me (escriban|escribas|manden)|dejen de (escribirme|mandarme)|no quiero (recibir )?(mas |más )?mensajes|stop|darme de baja|dame de baja|desuscrib)/i;

/** Mensajes que la línea manda sola sin que el cliente pregunte (no las respuestas del bot). */
const esEmpuje = (m) => m.rol === 1 && esAutomatico(m.resp) && !/^IA_Contacto/i.test(String(m.resp || ''));

/**
 * ¿Qué se haría con este momento para este alumno?
 * @param {object} p
 *   momento    clave de MOMENTOS
 *   chat       { id, bot_openia } | null (sin chat en la línea)
 *   mensajes   [{ rol, resp, t (ms), tx }] del chat, de los últimos 8 días
 *   bajas      true si alguna vez pidió que no le escriban (se mira aparte, más atrás)
 *   enviados   [{ momento, t (ms) }] «consentidos» de los últimos 7 días
 *   ahora      ms
 * @returns {{ accion: 'escribir'|'aviso_asesor'|'pasa_a_manana'|'no', razon, via? }}
 */
function aplicarCandados({ momento, chat, mensajes = [], bajas = false, enviados = [], ahora }) {
  const delCliente = mensajes.filter((m) => m.rol === 0);
  if (bajas || delCliente.some((m) => PIDE_NO_ESCRIBIR.test(String(m.tx || '')))) return { accion: 'no', razon: 'pidió que no le escriban' };
  if (!chat) return { accion: 'no', razon: 'no tiene chat en la línea' };

  const hace24 = ahora - DIA_MS;
  if (Number(chat.bot_openia) === 0) return { accion: 'aviso_asesor', razon: 'lo atiende una persona (bot apagado en el chat)' };
  const humanoReciente = mensajes.some((m) => m.rol === 1 && !esAutomatico(m.resp) && m.t >= hace24);
  if (humanoReciente) return { accion: 'aviso_asesor', razon: 'tiene una gestión abierta con un asesor' };

  const esCarga = MOMENTOS[momento]?.grupo === 'carga';
  const semana = enviados.filter((e) => e.t >= ahora - 7 * DIA_MS);
  const tope = esCarga ? TOPE_SEMANA_CARGA : TOPE_SEMANA;
  const cuentan = esCarga ? semana : semana.filter((e) => MOMENTOS[e.momento]?.grupo !== 'carga');
  if (cuentan.length >= tope) return { accion: 'no', razon: 'ya recibió uno esta semana' };

  if (mensajes.some((m) => esEmpuje(m) && m.t >= hace24)) return { accion: 'pasa_a_manana', razon: 'hoy le llegó otro mensaje automático' };

  const escribio24 = delCliente.some((m) => m.t >= hace24);
  return { accion: 'escribir', razon: escribio24 ? 'ventana abierta' : 'necesita plantilla', via: escribio24 ? 'texto' : 'plantilla' };
}

/* ── Texto ──────────────────────────────────────────────────────────────── */
const DESTINOS = { ec: ' de Ecuador', ecuador: ' de Ecuador', mx: ' de México', mexico: ' de México', méxico: ' de México' };

function primerNombre(nombre) {
  const p = String(nombre || '').trim().split(/\s+/)[0] || '';
  if (!/^[\p{L}]{2,}$/u.test(p)) return '';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/** El texto que se le escribiría (borrador de textos.js). */
function textoDe(momento, datos = {}, nombre = '') {
  let t = momento === 'sigue_en_camino' && datos.nota ? T.CONSENTIDOS.sigue_en_camino_nota : T.CONSENTIDOS[momento];
  if (!t) return '';
  const n = primerNombre(nombre);
  const fecha = datos.estimada ? T.CONSENTIDOS_FECHA.con.replace('{fecha}', fechaLarga(datos.estimada)) : T.CONSENTIDOS_FECHA.sin;
  const reemplazos = {
    nombre: n,
    marca: datos.marca ? String(datos.marca) : '',
    cajas: datos.cajas ? ` (${datos.cajas} ${datos.cajas === 1 ? 'caja' : 'cajas'})` : '',
    contenedor: datos.contenedor || '',
    fecha,
    ciudad: DESTINOS[String(datos.destino || '').trim().toLowerCase()] || '',
    nota: datos.nota || '',
    monto: datos.monto || '',
    enlace: datos.enlace || '',
    dia: datos.dia || '',
    leccion: datos.leccion || '',
  };
  t = t.replace(/\{(\w+)\}/g, (_, k) => (k in reemplazos ? reemplazos[k] : ''));
  // Sin nombre: «Hola 👋 …», «, tu carga…» → arranca limpio.
  return t
    .replace(/^Hola\s+👋/, 'Hola 👋')
    .replace(/^([^\p{L}]*)\s*,\s*/u, '$1')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase())
    .trim();
}

/** «María» → «M***»; para el resumen que ve Daniel. */
const enmascarar = (nombre) => {
  const n = primerNombre(nombre);
  return n ? `${n[0]}***` : 'Alumno';
};

module.exports = {
  MOMENTOS,
  NOMBRE_MOMENTO,
  RESPONSABLE,
  TOPE_SEMANA,
  TOPE_SEMANA_CARGA,
  CADA_DIAS_EN_CAMINO,
  dia,
  diasEntre,
  momentosDeCarga,
  momentosDeAlumno,
  estimadaVencida,
  elegir,
  aplicarCandados,
  textoDe,
  primerNombre,
  enmascarar,
};
