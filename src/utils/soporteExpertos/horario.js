/* ¿El equipo de Expertos está atendiendo ahora?

   Todos los textos fijos del bot dicen «un asesor te escribe apenas abramos»:
   se escribieron para el bot de noche. Medido del 10 al 24-oct en la 265, el
   92 % de lo que escriben los clientes llega en horario de oficina; si el bot
   contesta de día, «apenas abramos» es falso. Con el equipo atendiendo, el
   código lo cambia por «en breve» al final del turno (después de la guardia,
   que con razón no deja que el modelo prometa tiempos por su cuenta).

   Horario del equipo: ia_ajustes → soporte_expertos.horario_equipo
     { dias: [1,2,3,4,5], desde: '08:00', hasta: '17:30', utc: -5 }
   Sin el ajuste el bot NO cambia «apenas abramos» (turno.js): el cambio es
   por cuenta. El seguimiento, que se corre a mano por cuenta, usa L-V
   08:00-17:30 de Ecuador si falta. No hay feriados: un feriado cuenta como
   día de oficina.

   Ecommerce también atiende el sábado de 08:00 a 12:00 (Daniel, 25-oct):
   soporte_expertos.horario_ecommerce lleva el mismo horario con un tramo
   extra, `extra: [{ dias: [6], desde: '08:00', hasta: '12:00' }]`.

   Fuera de horario, con soporte_expertos.decir_apertura = true, «apenas
   abramos» pasa a decir cuándo abre el equipo («el lunes desde las 8:00»).
   Sin el ajuste el texto se queda como está. */

'use strict';

const HORARIO_EQUIPO = Object.freeze({ dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '17:30', utc: -5 });
// Ecommerce: lo mismo + el sábado de 08:00 a 12:00 (Daniel, 25-oct).
const HORARIO_ECOMMERCE = Object.freeze({ ...HORARIO_EQUIPO, extra: [{ dias: [6], desde: '08:00', hasta: '12:00' }] });

const aMinutos = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
};

/** Un tramo { dias, desde, hasta } bien escrito, o null. */
function tramo(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const dias = Array.isArray(v.dias) ? [...new Set(v.dias.map(Number).filter((d) => d >= 0 && d <= 6))] : null;
  const desde = aMinutos(v.desde);
  const hasta = aMinutos(v.hasta);
  if (!dias || !dias.length || desde === null || hasta === null || desde >= hasta) return null;
  return { dias, desde: v.desde, hasta: v.hasta };
}

/** Lo que trae la cuenta, o el de por defecto si falta o no se puede leer.
    Un tramo `extra` mal escrito se ignora; el horario principal sigue. */
function normalizarHorarioEquipo(v) {
  const base = tramo(v);
  if (!base) return { ...HORARIO_EQUIPO };
  const utc = Number(v.utc);
  const extra = (Array.isArray(v.extra) ? v.extra : []).map(tramo).filter(Boolean);
  return {
    ...base,
    utc: Number.isFinite(utc) && utc >= -12 && utc <= 14 ? utc : HORARIO_EQUIPO.utc,
    ...(extra.length ? { extra } : {}),
  };
}

const tramosDe = (h) => [{ dias: h.dias, desde: h.desde, hasta: h.hasta }, ...(h.extra || [])];

/* Las pruebas y el arnés describen el bot de noche: fijan la hora para no
   depender del día y la hora en que se corren. En producción no se usa. */
let horaDePrueba = null;
function fijarHoraParaPruebas(ms) {
  horaDePrueba = ms == null ? null : Number(ms);
}

function equipoAtendiendo(ahora, horario = HORARIO_EQUIPO) {
  const h = normalizarHorarioEquipo(horario);
  const ms = ahora ?? horaDePrueba ?? Date.now();
  const local = new Date(Number(ms) + h.utc * 3600 * 1000);
  const dia = local.getUTCDay();
  const m = local.getUTCHours() * 60 + local.getUTCMinutes();
  return tramosDe(h).some((t) => t.dias.includes(dia) && m >= aMinutos(t.desde) && m < aMinutos(t.hasta));
}

/** Minutos de oficina entre dos instantes (para contar cuánto lleva esperando
    un cliente sin sumar noches ni fines de semana). */
function minutosHabiles(desde, hasta, horario = HORARIO_EQUIPO) {
  const h = normalizarHorarioEquipo(horario);
  const off = h.utc * 3600 * 1000;
  const a = Number(desde) + off;
  const b = Number(hasta) + off;
  if (!(b > a)) return 0;
  let total = 0;
  for (let dia = Math.floor(a / 86400000) * 86400000; dia < b; dia += 86400000) {
    const nDia = new Date(dia).getUTCDay();
    for (const t of tramosDe(h)) {
      if (!t.dias.includes(nDia)) continue;
      const d0 = Math.max(a, dia + aMinutos(t.desde) * 60000);
      const d1 = Math.min(b, dia + aMinutos(t.hasta) * 60000);
      if (d1 > d0) total += d1 - d0;
    }
  }
  return Math.round(total / 60000);
}

const DIAS = ['el domingo', 'el lunes', 'el martes', 'el miércoles', 'el jueves', 'el viernes', 'el sábado'];
const hora = (hhmm) => {
  const m = aMinutos(hhmm);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * Cuándo vuelve a abrir el equipo, dicho como se le dice al cliente:
 * «hoy desde las 8:00», «mañana desde las 8:00», «el lunes desde las 8:00».
 * null si está atendiendo ahora (o si en 7 días no abre).
 */
function proximaApertura(ahora, horario = HORARIO_EQUIPO) {
  const h = normalizarHorarioEquipo(horario);
  const ms = ahora ?? horaDePrueba ?? Date.now();
  if (equipoAtendiendo(ms, h)) return null;
  const local = new Date(Number(ms) + h.utc * 3600 * 1000);
  const hoy = local.getUTCDay();
  const m = local.getUTCHours() * 60 + local.getUTCMinutes();
  for (let i = 0; i <= 7; i++) {
    const dia = (hoy + i) % 7;
    const abre = tramosDe(h)
      .filter((t) => t.dias.includes(dia) && (i > 0 || aMinutos(t.desde) > m))
      .map((t) => t.desde)
      .sort((x, y) => aMinutos(x) - aMinutos(y))[0];
    if (!abre) continue;
    const cuando = i === 0 ? 'hoy' : i === 1 ? 'mañana' : DIAS[dia];
    return `${cuando} desde las ${hora(abre)}`;
  }
  return null;
}

/* «…te escribe apenas abramos» → «…te escribe en breve» con el equipo
   atendiendo. Fuera de horario, si se le pasa `apertura` («el lunes desde las
   8:00»), «apenas abramos» → «el lunes desde las 8:00». Solo esa frase: lo
   demás del texto no cambia. */
const RE_APENAS_ABRAMOS = /apenas abramos/g;
function textoAlHorario(texto, atendiendo, apertura = null) {
  if (!texto) return texto;
  if (atendiendo) return String(texto).replace(RE_APENAS_ABRAMOS, 'en breve');
  if (apertura) return String(texto).replace(RE_APENAS_ABRAMOS, apertura);
  return texto;
}

module.exports = {
  HORARIO_EQUIPO,
  HORARIO_ECOMMERCE,
  normalizarHorarioEquipo,
  equipoAtendiendo,
  minutosHabiles,
  proximaApertura,
  textoAlHorario,
  fijarHoraParaPruebas,
};
