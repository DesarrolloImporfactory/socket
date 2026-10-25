/* «¿Cuándo es mi reunión?», «pásame el link del Meet», «¿cómo agendo mi
   implementación?» con datos reales, para el bot de soporte de Expertos.

   Dos fuentes, las dos SOLO LECTURA (los adaptadores se niegan a correr lo que
   no empiece por SELECT):
     1. El calendario de la cuenta en IMPORCHAT (`appointments` de los
        calendarios con `account_id` = la configuración): las reuniones que el
        asesor le agendó, buscadas por el teléfono del invitado.
     2. La sesión de implementación de Imporsuit (MentoriaImplementacionModel):
        si la tiene habilitada, cuántas clases de los módulos 1 y 2 le faltan y
        su cita (`mentoria_citas`). Se replica la LECTURA de `estadoDe` sin su
        `autohabilitar` (ese escribe en users): si ya completó los módulos,
        se le dice que entre a «Agenda tu implementación», que es lo que la
        habilita.

   El bot NO agenda, no cambia ni cancela: las fichas `llamada-o-reunion`,
   `sesion-de-onboarding` y `camp-agenda-tu-implementacion` lo prohíben.

   SEGURIDAD — de quién es la reunión:
     · Se busca por el número que entrega Meta, nunca por uno que escriban.
     · Un teléfono guardado sin código de país solo vale si el que escribe es
       de Ecuador o México (los dos países de la línea).
     · Si el número sale con invitados o alumnos de nombres distintos, de esa
       fuente no se informa nada.
     · Al modelo le llega día, hora, con quién (primer nombre) y el enlace de
       la reunión; nunca la descripción, el título ni otros invitados. */

'use strict';

const { consultarImporsuit } = require('./cargaCliente');
const { consultarImporchat } = require('./diagnosticoCuenta');
const { alumnosDelTelefono } = require('./pagosCliente');
const { comoCoincide, colaCandidatos, paisDelTelefono } = require('./telefono');
const { fechaTexto } = require('./estadoCarga');
const { sinTildes } = require('./texto');

const LIMITE_MS = 8000;
const DIAS_ATRAS = 14; // reunión anterior que se menciona
const PAISES_SIN_CODIGO = ['ec', 'mx'];
const MODULOS_REQUERIDOS = [135, 136]; // MentoriaImplementacionModel::MODULOS_REQUERIDOS
const ENLACE_AGENDA = 'https://imporfactory.app/cursos/32?contenido=737';
const TZ_ECUADOR = 'America/Guayaquil';

const COLA_SQL = (col) => `RIGHT(REGEXP_REPLACE(COALESCE(${col}, ''), '[^0-9]', ''), 9)`;

/* Reuniones del calendario de la cuenta. start_utc / end_utc están en UTC. */
const SQL_CITAS = `
  SELECT a.id, a.status,
         DATE_FORMAT(a.start_utc, '%Y-%m-%d %H:%i') AS inicio_utc,
         DATE_FORMAT(a.end_utc, '%Y-%m-%d %H:%i') AS fin_utc,
         a.meeting_url, c.time_zone, i.phone, i.name, s.nombre_encargado AS asesor
    FROM appointments a
    INNER JOIN calendars c ON c.id = a.calendar_id AND c.account_id = :cuenta
    INNER JOIN appointment_invitees i ON i.appointment_id = a.id
    LEFT JOIN sub_usuarios_chat_center s ON s.id_sub_usuario = a.assigned_user_id
   WHERE ${COLA_SQL('i.phone')} = :cola
     AND a.status IN ('Agendado', 'Confirmado', 'Completado', 'Cancelado')
     AND a.start_utc >= UTC_TIMESTAMP() - INTERVAL ${DIAS_ATRAS} DAY
   ORDER BY a.start_utc ASC
   LIMIT 20`;

const SQL_MENTORIA_USUARIOS = `
  SELECT id_users, ecommerce, mentoria_implementacion, mentoria_bloqueada
    FROM users WHERE id_users IN (?)`;
const SQL_MENTORIA_TOTAL = `
  SELECT COUNT(*) AS total FROM cursos_contenidos
   WHERE id_modulo IN (${MODULOS_REQUERIDOS.join(', ')}) AND visible = 1`;
const SQL_MENTORIA_AVANCE = `
  SELECT ccp.id_users, COUNT(DISTINCT cc.id_contenido) AS completados
    FROM cursos_contenidos cc
    INNER JOIN cursos_contenido_progreso ccp ON ccp.id_contenido = cc.id_contenido
   WHERE cc.id_modulo IN (${MODULOS_REQUERIDOS.join(', ')}) AND cc.visible = 1
     AND ccp.completado = 1 AND ccp.id_users IN (?)
   GROUP BY ccp.id_users`;
/* `inicio` está en hora de Ecuador (lo escribe Imporsuit). */
const SQL_MENTORIA_CITAS = `
  SELECT id_cita, id_users, DATE_FORMAT(inicio, '%Y-%m-%d %H:%i') AS inicio, estado, activa,
         meet_url, chatcenter_cita_id
    FROM mentoria_citas WHERE id_users IN (?)
   ORDER BY inicio DESC LIMIT 10`;

const conLimite = (promesa, ms) =>
  Promise.race([
    promesa,
    new Promise((_, rechazar) => {
      const t = setTimeout(() => rechazar(new Error(`sin respuesta en ${ms} ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

/* ── Fechas ────────────────────────────────────────────────────────────── */
const msDeUtc = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};
/* Ecuador no cambia de hora: local + 5 h = UTC. */
const msDeEcuador = (s) => {
  const ms = msDeUtc(s);
  return ms === null ? null : ms + 5 * 3600 * 1000;
};
const partes = (ms, tz) => {
  const p = {};
  for (const x of new Intl.DateTimeFormat('es-EC', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { dia: p.weekday, fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
};
const nombreZona = (tz) =>
  tz === TZ_ECUADOR ? 'hora de Ecuador' : tz === 'America/Mexico_City' ? 'hora de Ciudad de México' : `hora de ${tz}`;

/** { cuando: «lunes 27 de octubre, 10:00 (hora de Ecuador)», relativo: 'hoy'|'mañana'|null, … } */
function cuando(ms, tz, ahora) {
  const zona = tz || TZ_ECUADOR;
  const p = partes(ms, zona);
  const hoy = partes(ahora.getTime(), zona).fecha;
  const manana = partes(ahora.getTime() + 24 * 3600 * 1000, zona).fecha;
  return {
    ...p,
    zona: nombreZona(zona),
    relativo: p.fecha === hoy ? 'hoy' : p.fecha === manana ? 'mañana' : null,
    texto: `${p.dia} ${fechaTexto(p.fecha)}, ${p.hora} (${nombreZona(zona)})`,
    textoA: `${p.dia} ${fechaTexto(p.fecha)} a las ${p.hora} (${nombreZona(zona)})`,
  };
}

const primerNombre = (s) => {
  const n = String(s || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}]{2,20}$/u.test(n) ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : null;
};
const clavePersona = (s) => sinTildes(s).replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] || '';
const enlace = (u) => {
  const s = String(u || '').trim();
  return /^https:\/\/[^\s<>"'«»]+$/.test(s) ? s : null;
};
const vale = (telefono, c) => c === 'exacto' || (c === 'nacional' && PAISES_SIN_CODIGO.includes(paisDelTelefono(telefono)));

/* ── Lectura ───────────────────────────────────────────────────────────── */
async function leerCalendario(telefono, cola, consultar, cuenta, ahora) {
  if (!cuenta) return { estado: 'sin_cuenta', proximas: [], anterior: null, ids: new Set() };
  const filas = (await consultar(SQL_CITAS, { cuenta: Number(cuenta), cola })) || [];
  const propias = filas.filter((f) => vale(telefono, comoCoincide(telefono, f.phone)));
  const personas = new Set(propias.map((f) => clavePersona(f.name)).filter(Boolean));
  if (personas.size > 1) return { estado: 'varios', proximas: [], anterior: null, ids: new Set() };

  const vistas = new Map();
  for (const f of propias) if (!vistas.has(Number(f.id))) vistas.set(Number(f.id), f);
  const ahoraMs = ahora.getTime();
  const reuniones = [...vistas.values()].map((f) => {
    const ini = msDeUtc(f.inicio_utc);
    const fin = msDeUtc(f.fin_utc) ?? ini;
    return {
      id: Number(f.id),
      estado: String(f.status || ''),
      inicioMs: ini,
      finMs: fin,
      cuando: cuando(ini, f.time_zone, ahora),
      con: primerNombre(f.asesor),
      enlace: enlace(f.meeting_url),
    };
  });
  const proximas = reuniones
    .filter((r) => ['Agendado', 'Confirmado'].includes(r.estado) && r.finMs >= ahoraMs)
    .sort((a, b) => a.inicioMs - b.inicioMs)
    .slice(0, 2);
  const anterior =
    reuniones
      .filter((r) => !proximas.includes(r) && (r.finMs < ahoraMs || r.estado === 'Cancelado'))
      .sort((a, b) => b.inicioMs - a.inicioMs)[0] || null;
  return { estado: 'ok', proximas, anterior, ids: new Set(reuniones.map((r) => r.id)) };
}

async function leerMentoria(telefono, cola, consultar, ahora) {
  const { como, persona } = await alumnosDelTelefono(telefono, cola, consultar);
  const ids = [...como.keys()].filter((id) => vale(telefono, como.get(id)));
  if (!ids.length) return { estado: 'sin_alumno' };
  if (new Set(ids.map((id) => persona.get(id))).size > 1) return { estado: 'varios' };

  const [usuarios, [tot], avance, citas] = await Promise.all([
    consultar(SQL_MENTORIA_USUARIOS, [ids]),
    consultar(SQL_MENTORIA_TOTAL, []),
    consultar(SQL_MENTORIA_AVANCE, [ids]),
    consultar(SQL_MENTORIA_CITAS, [ids]),
  ]);
  const u = usuarios || [];
  const total = Number(tot?.total) || 0;
  const completados = Math.max(0, ...(avance || []).map((a) => Number(a.completados) || 0));
  const ahoraMs = ahora.getTime();
  const lista = (citas || []).map((c) => {
    const ini = msDeEcuador(c.inicio);
    return {
      estado: String(c.estado || ''),
      activa: Number(c.activa) === 1,
      inicioMs: ini,
      cuando: ini === null ? null : cuando(ini, TZ_ECUADOR, ahora),
      enlace: enlace(c.meet_url),
      chatcenter: Number(c.chatcenter_cita_id) || null,
    };
  });
  const activa = lista.find((c) => c.activa && c.inicioMs !== null) || null;
  const completada = lista.find((c) => c.estado === 'completada') || null;
  return {
    estado: 'ok',
    ecommerce: u.some((x) => Number(x.ecommerce) === 1),
    habilitada: u.some((x) => Number(x.mentoria_implementacion) === 1),
    bloqueada: u.some((x) => Number(x.mentoria_bloqueada) === 1),
    total,
    completados: Math.min(completados, total),
    faltan: Math.max(0, total - completados),
    // Una cita «agendada» cuya hora ya pasó (nadie la cerró) no es «próxima».
    cita: activa ? { ...activa, paso: activa.inicioMs + 20 * 60 * 1000 < ahoraMs } : null,
    completada,
  };
}

/**
 * Reuniones y sesión de implementación del número de WhatsApp que escribe.
 * @param {string} telefono  número del remitente, como lo entrega Meta
 * @param {object} [o]  cuenta (id_configuracion), consultarImporchat, consultarImporsuit, ahora, limite_ms
 * @returns {Promise<object>} estado: leido | telefono_no_valido | error
 */
async function reunionesDelTelefono(telefono, o = {}) {
  const cola = colaCandidatos(telefono);
  if (!cola) return { estado: 'telefono_no_valido', motivo: 'el número del remitente no sirve para buscar' };
  const ahora = o.ahora instanceof Date ? o.ahora : new Date();
  const lim = o.limite_ms || LIMITE_MS;
  const [cal, men] = await Promise.all([
    conLimite(leerCalendario(telefono, cola, o.consultarImporchat || consultarImporchat, o.cuenta, ahora), lim).catch((e) => ({
      estado: 'error',
      motivo: e.message,
      proximas: [],
      anterior: null,
      ids: new Set(),
    })),
    conLimite(leerMentoria(telefono, cola, o.consultarImporsuit || consultarImporsuit, ahora), lim).catch((e) => ({
      estado: 'error',
      motivo: e.message,
    })),
  ]);
  if (cal.estado === 'error' && men.estado === 'error') return { estado: 'error', motivo: `no se pudo consultar: ${cal.motivo}` };
  // La cita de la mentoría también está en el calendario: no se cuenta dos veces.
  if (men.cita?.chatcenter && cal.ids?.has(men.cita.chatcenter)) {
    cal.proximas = cal.proximas.filter((r) => r.id !== men.cita.chatcenter);
    if (cal.anterior?.id === men.cita.chatcenter) cal.anterior = null;
  }
  return { estado: 'leido', calendario: cal, mentoria: men };
}

/* ── Lo que lee el modelo ──────────────────────────────────────────────── */
const ESTADO_ANTERIOR = { Agendado: 'estaba agendada', Confirmado: 'estaba confirmada', Completado: 'marcada como hecha', Cancelado: 'cancelada' };

function lineaReunion(r) {
  return `${r.cuando.texto}${r.con ? `, con ${r.con}` : ''}.${r.enlace ? ` Enlace: ${r.enlace}` : ' Sin enlace de videollamada guardado.'}`;
}

function lineasMentoria(m) {
  if (m.estado === 'varios') return ['Sesión de implementación: el número está en cuentas de varias personas; no se informa.'];
  if (m.estado === 'error') return ['Sesión de implementación: no se pudo consultar la plataforma.'];
  if (m.estado !== 'ok') return ['Sesión de implementación: no hay un alumno de la plataforma con este número.'];
  if (m.cita && !m.cita.paso)
    return [`Sesión de implementación agendada: ${m.cita.cuando.texto}.${m.cita.enlace ? ` Enlace: ${m.cita.enlace}` : ''}`];
  if (m.cita?.paso || m.completada)
    return [
      `Sesión de implementación: ya tuvo su sesión (${(m.cita || m.completada).cuando?.texto || 'fecha sin dato'}). Es una sola por alumno: si no se hizo o necesita otra, la revisa el equipo.`,
    ];
  if (m.bloqueada) return ['Sesión de implementación: no está disponible para esta cuenta; la revisa el equipo.'];
  if (!m.ecommerce) return ['Sesión de implementación: es para alumnos de The Ecommerce Method y esta cuenta no figura como tal.'];
  if (m.habilitada)
    return [`Sesión de implementación: HABILITADA y sin agendar. La agenda el alumno en «Agenda tu implementación»: ${ENLACE_AGENDA}`];
  if (m.total > 0 && m.faltan === 0)
    return [
      `Sesión de implementación: ya completó las ${m.total} clases de los módulos 1 y 2. Al entrar a «Agenda tu implementación» se le habilita y la agenda el alumno: ${ENLACE_AGENDA}`,
    ];
  if (m.total > 0)
    return [
      `Sesión de implementación: todavía no está habilitada. Lleva ${m.completados} de ${m.total} clases de los módulos 1 y 2 del Dropsystem; le faltan ${m.faltan}. Al completarlas se abre «Agenda tu implementación»: ${ENLACE_AGENDA}`,
    ];
  return ['Sesión de implementación: sin dato del avance.'];
}

/** El bloque que devuelve la herramienta. */
function bloqueReunion(r) {
  const cab = '📅 REUNIONES DE ESTE CLIENTE (leído del calendario y de la plataforma, por el número desde el que escribe):';
  if (r.estado === 'telefono_no_valido' || r.estado === 'error')
    return `${cab}\nNo se pudo consultar. No digas días, horas ni enlaces: pasa el caso con pasar_a_humano (motivo otro).`;
  const c = r.calendario;
  const lineas = [cab];
  if (c.estado === 'varios') lineas.push('Calendario: el número está en reuniones de varias personas; no se informa.');
  else if (c.estado === 'error') lineas.push('Calendario: no se pudo consultar.');
  else if (!c.proximas.length) lineas.push('Calendario: no tiene ninguna reunión agendada con su asesor.');
  else for (const p of c.proximas) lineas.push(`Próxima reunión: ${lineaReunion(p)}`);
  if (c.anterior) lineas.push(`Reunión anterior: ${c.anterior.cuando.texto}${c.anterior.con ? `, con ${c.anterior.con}` : ''} — ${ESTADO_ANTERIOR[c.anterior.estado] || c.anterior.estado}.`);
  lineas.push(...lineasMentoria(r.mentoria));
  lineas.push(
    '',
    'Cómo usarlo: di solo lo que está aquí, con el día, la hora y el enlace tal cual. ' +
      'No agendes, no cambies, no canceles ni propongas otro día u hora. Si quiere una reunión nueva con su asesor, cambiarla o cancelarla, ' +
      'o una reunión anterior no se hizo, usa pasar_a_humano (motivo otro). La sesión de implementación la agenda el alumno en el enlace de la plataforma.',
  );
  return lineas.join('\n');
}

/* ── Respaldo para la guardia ──────────────────────────────────────────── */
function formasDeHora(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 || 12;
  const sufijos = h < 12 ? ['am', 'a. m.', 'a.m.', 'de la mañana'] : ['pm', 'p. m.', 'p.m.', h < 19 ? 'de la tarde' : 'de la noche'];
  const base12 = m ? [`${h12}:${String(m).padStart(2, '0')}`] : [`${h12}:00`, `${h12}`];
  return [hhmm, `${h}h${String(m).padStart(2, '0')}`, ...base12.flatMap((b) => [b, ...sufijos.map((s) => `${b} ${s}`)])];
}

/** Las formas en que el modelo puede escribir el día y la hora leídos: van
    solo al respaldo de la guardia, no al modelo. */
function variantesDeReuniones(r) {
  if (r?.estado !== 'leido') return '';
  const cs = [
    ...(r.calendario?.proximas || []).map((p) => p.cuando),
    r.calendario?.anterior?.cuando,
    r.mentoria?.cita?.cuando,
    r.mentoria?.completada?.cuando,
  ].filter(Boolean);
  const out = [];
  for (const c of cs) {
    const fecha = fechaTexto(c.fecha);
    const dias = [c.dia, `el ${c.dia}`, `este ${c.dia}`, `el próximo ${c.dia}`, `el proximo ${c.dia}`, `${c.dia} ${fecha}`, `el ${c.dia} ${fecha}`, `el ${fecha}`, fecha];
    if (c.relativo) dias.push(c.relativo, `${c.relativo} ${c.dia}`);
    for (const d of dias) for (const h of formasDeHora(c.hora)) out.push(`${d} a las ${h}`, `${d}, ${h}`, `${d} ${h}`);
    out.push(...dias);
  }
  return [...new Set(out)].join('\n');
}

/* ── Texto seguro (si la guardia rechaza) ──────────────────────────────── */
const RE_REUNION = /reuni[oó]n|llamada|videollamada|zoom|meet|cita\b|sesi[oó]n|asesor[ií]a/i;
const RE_PREGUNTA_EXISTENTE = /cu[aá]ndo|a qu[eé] hora|qu[eé] hora|qu[eé] d[ií]a|link|enlace|\bmi (?:reuni|cita|llamada|sesi)|me (?:agendaron|dieron)|ten[ií]a|tengo (?:una )?(?:reuni|cita|llamada)/i;
const RE_MENTORIA = /mentor[ií]a|implementaci[oó]n|agenda tu/i;

/** 'reunion' si pregunta por una reunión que ya tiene; 'mentoria' si por la
    sesión de implementación; null si no. */
function pideReunion(texto) {
  const t = String(texto || '');
  if (RE_MENTORIA.test(t)) return 'mentoria';
  if (RE_REUNION.test(t) && RE_PREGUNTA_EXISTENTE.test(t)) return 'reunion';
  return null;
}

/** El texto armado en código para el cliente, o null si no hay un dato claro. */
function textoReunionParaCliente(r, { pide } = {}) {
  if (r?.estado !== 'leido' || !pide) return null;
  const c = r.calendario;
  const m = r.mentoria;
  if (pide === 'reunion' && c?.estado === 'ok' && c.proximas.length) {
    const p = c.proximas[0];
    return `Tu próxima reunión es el ${p.cuando.textoA}${p.con ? ` con ${p.con}` : ''}.${p.enlace ? ` Te conectas aquí: ${p.enlace}` : ''}`;
  }
  if (pide !== 'mentoria' || m?.estado !== 'ok') return null;
  if (m.cita && !m.cita.paso)
    return `Tu sesión de implementación es el ${m.cita.cuando.textoA}.${m.cita.enlace ? ` Te conectas aquí: ${m.cita.enlace}` : ''}`;
  if (m.cita || m.completada || m.bloqueada || !m.ecommerce) return null;
  if (m.habilitada) return `Ya tienes habilitada tu sesión de implementación. La agendas tú desde «Agenda tu implementación»: ${ENLACE_AGENDA}`;
  if (m.total > 0 && m.faltan === 0)
    return `Ya completaste los módulos 1 y 2. Entra a «Agenda tu implementación» y desde ahí agendas tu sesión: ${ENLACE_AGENDA}`;
  if (m.total > 0)
    return `Para agendar tu sesión de implementación te faltan ${m.faltan} de ${m.total} clases de los módulos 1 y 2 del Dropsystem. Al completarlas se abre «Agenda tu implementación»: ${ENLACE_AGENDA}`;
  return null;
}

module.exports = {
  reunionesDelTelefono,
  bloqueReunion,
  variantesDeReuniones,
  textoReunionParaCliente,
  pideReunion,
  ENLACE_AGENDA,
  MODULOS_REQUERIDOS,
};
