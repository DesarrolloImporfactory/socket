'use strict';

const moment = require('moment-timezone');

/* El bloque de agendamiento lleva la fecha en formato de sistema
   ("2026-08-01 10:00") porque así la parsea el backend sin ambigüedad. El
   problema es que ese bloque SÍ le llega al cliente, y leer "2026-08-01" en un
   WhatsApp se ve a kilómetros que lo escribió una máquina.

   En vez de pedirle al modelo que escriba bonito —y que a veces obedezca— la
   fecha se traduce acá, después de haberla usado: el backend lee el formato
   exacto que necesita y el cliente recibe "sábado 1 de agosto, 10:00".

   Solo toca fechas completas con hora. Un año suelto o un número de guía con
   guiones no se parecen a este patrón. */
const RE_FECHA_HORA =
  /\b(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?\b/g;

const RE_FECHA_SOLA = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

function humanizarFechas(texto, tz = 'America/Guayaquil') {
  if (!texto || typeof texto !== 'string') return texto;

  const hoy = moment().tz(tz).startOf('day');

  const bonita = (m, conHora) => {
    if (!m.isValid()) return null;

    const dias = m.clone().startOf('day').diff(hoy, 'days');
    const etiqueta =
      dias === 0 ? 'hoy' : dias === 1 ? 'mañana' : m.locale('es').format('dddd');

    /* "mañana sábado" es como lo diría una persona; "el sábado 1 de agosto"
       cuando ya está lejos y hace falta la fecha para ubicarse. */
    const fecha =
      dias >= 0 && dias <= 1
        ? `${etiqueta} ${m.locale('es').format('dddd D [de] MMMM')}`
        : `${etiqueta} ${m.locale('es').format('D [de] MMMM')}`;

    return conHora ? `${fecha}, ${m.format('HH:mm')}` : fecha;
  };

  let salida = texto.replace(RE_FECHA_HORA, (completo, a, me, d, h, mi) => {
    const m = moment.tz(`${a}-${me}-${d} ${h}:${mi}`, 'YYYY-MM-DD HH:mm', tz);
    return bonita(m, true) || completo;
  });

  salida = salida.replace(RE_FECHA_SOLA, (completo, a, me, d) => {
    const m = moment.tz(`${a}-${me}-${d}`, 'YYYY-MM-DD', tz);
    return bonita(m, false) || completo;
  });

  return salida;
}

module.exports = { humanizarFechas };
