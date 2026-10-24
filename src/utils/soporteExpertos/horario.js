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
   día de oficina. */

'use strict';

const HORARIO_EQUIPO = Object.freeze({ dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '17:30', utc: -5 });

const aMinutos = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
};

/** Lo que trae la cuenta, o el de por defecto si falta o no se puede leer. */
function normalizarHorarioEquipo(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...HORARIO_EQUIPO };
  const dias = Array.isArray(v.dias) ? [...new Set(v.dias.map(Number).filter((d) => d >= 0 && d <= 6))] : null;
  const desde = aMinutos(v.desde);
  const hasta = aMinutos(v.hasta);
  const utc = Number(v.utc);
  if (!dias || desde === null || hasta === null || desde >= hasta) return { ...HORARIO_EQUIPO };
  return { dias, desde: v.desde, hasta: v.hasta, utc: Number.isFinite(utc) && utc >= -12 && utc <= 14 ? utc : HORARIO_EQUIPO.utc };
}

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
  if (!h.dias.includes(local.getUTCDay())) return false;
  const m = local.getUTCHours() * 60 + local.getUTCMinutes();
  return m >= aMinutos(h.desde) && m < aMinutos(h.hasta);
}

/** Minutos de oficina entre dos instantes (para contar cuánto lleva esperando
    un cliente sin sumar noches ni fines de semana). */
function minutosHabiles(desde, hasta, horario = HORARIO_EQUIPO) {
  const h = normalizarHorarioEquipo(horario);
  const off = h.utc * 3600 * 1000;
  const a = Number(desde) + off;
  const b = Number(hasta) + off;
  if (!(b > a)) return 0;
  const ini = aMinutos(h.desde) * 60000;
  const fin = aMinutos(h.hasta) * 60000;
  let total = 0;
  for (let dia = Math.floor(a / 86400000) * 86400000; dia < b; dia += 86400000) {
    if (!h.dias.includes(new Date(dia).getUTCDay())) continue;
    const d0 = Math.max(a, dia + ini);
    const d1 = Math.min(b, dia + fin);
    if (d1 > d0) total += d1 - d0;
  }
  return Math.round(total / 60000);
}

/* «…te escribe apenas abramos» → «…te escribe en breve». Solo esa frase:
   lo demás del texto no cambia. */
const RE_APENAS_ABRAMOS = /apenas abramos/g;
function textoAlHorario(texto, atendiendo) {
  if (!atendiendo || !texto) return texto;
  return String(texto).replace(RE_APENAS_ABRAMOS, 'en breve');
}

module.exports = { HORARIO_EQUIPO, normalizarHorarioEquipo, equipoAtendiendo, minutosHabiles, textoAlHorario, fijarHoraParaPruebas };
