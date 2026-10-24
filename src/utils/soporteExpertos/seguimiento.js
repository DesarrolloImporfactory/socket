/* Seguimiento al cliente de Expertos que quedó esperando.

   Medido del 10 al 24-oct en la 265: 171 turnos sin respuesta en 24 h y 1.557
   contestados tarde (2–24 h). Las cotizaciones enviadas ya tienen su
   seguimiento (cron_template_programado: «Le escribo para hacer seguimiento a
   su proceso de importación», 1.464 envíos en 14 días); este módulo NO las
   repite. Cubre lo que nadie retoma: el cliente al que el bot le dijo «un
   asesor te escribe» y después nadie le escribió.

   Dos casos:
     · espera_asesor  el bot le pasó el caso a una persona y nadie del equipo
                      le escribió en UMBRAL_CLIENTE minutos de oficina. Es el
                      único caso en que se le puede escribir al cliente.
     · espera_equipo  el cliente escribió en una gestión con un asesor y nadie
                      le contesta hace UMBRAL_EQUIPO minutos de oficina. Solo
                      se lista para el equipo (al cliente no se le escribe:
                      la gestión es del asesor).

   Nunca: dos seguimientos al mismo turno del cliente, más de TOPE_SEMANA por
   chat en 7 días, escribir fuera del horario del equipo, escribir si ya le
   llegó una plantilla programada en 48 h, contestar un «ok/gracias» o a un bot
   de tienda. Fuera de la ventana de 24 h de WhatsApp solo con plantilla de
   Meta (todavía no existe: queda como «necesita plantilla»).

   Puro: no lee ni escribe nada. Lo usa scripts/seguimiento_soporte_expertos.js. */

'use strict';

const { noPideNada, esMensajeDeBot } = require('./senales');
const { equipoAtendiendo, minutosHabiles, HORARIO_EQUIPO } = require('./horario');
const { esPase, areaDelCaso, personaDelArea } = require('./escalado');
const T = require('./textos');

const UMBRAL_CLIENTE = 180; // 3 h de oficina tras el «un asesor te escribe»
const UMBRAL_EQUIPO = 120; // 2 h de oficina sin respuesta en una gestión
const TOPE_SEMANA = 2;
const VENTANA_MS = 24 * 3600 * 1000;
const RESPONSABLE = 'IA_Seguimiento Expertos';

/* Remitentes automáticos: no son la respuesta de una persona. Misma regla que
   liberar_sin_respuesta.service (esResponsableAutomatico) más los avisos que
   en la 265 salen como «Soporte» (guías) y «Sistema de valoraciones». */
const AUTOMATICOS = [
  'crm ventas',
  'dropi status',
  'aliclik status',
  'bot confirmación',
  'sistema de valoraciones',
  'shopify confirmación',
  'shopify recovery',
  'automatizador | cotizador pro',
  'automatizador',
  'encuesta link público',
  'encuesta webhook',
  'aviso calendario',
  'agenda',
  'sistema',
  'soporte',
];
function esAutomatico(responsable) {
  const r = String(responsable || '').trim();
  if (!r) return false;
  if (/^(IA_|cron_)/i.test(r)) return true;
  return AUTOMATICOS.includes(r.toLowerCase());
}
const esDelBot = (m) => m.rol === 1 && /^IA_/i.test(String(m.resp || ''));
const esSeguimiento = (m) => String(m.resp || '').startsWith('IA_Seguimiento');
const esHumano = (m) => m.rol === 1 && !esAutomatico(m.resp) && m.tm !== 'revoke';
const necesitaRespuesta = (m) => {
  if (m.rol !== 0) return false;
  const tx = String(m.tx || '');
  if (m.tm === 'reaction' || m.tm === 'sticker') return false;
  if (!tx.trim()) return true; // adjunto sin texto
  return !(esMensajeDeBot(tx) || (m.tm === 'text' && noPideNada(tx)));
};

/**
 * ¿Hay que hacerle seguimiento a este chat ahora?
 * @param {object} p
 *   mensajes  [{ id, rol: 0 cliente | 1 nuestro | 3 nota, resp, t (ms), tx, tm }] de los últimos días
 *   ahora     ms; horario del equipo; telefono (para el área de logística MX)
 * @returns {{ caso: null|'espera_asesor'|'espera_equipo', accion?: 'texto'|'plantilla'|'listar',
 *             texto?, area?, destino?, esperaMin?, razon }}
 */
function decidirSeguimiento({ mensajes = [], ahora = Date.now(), horario = HORARIO_EQUIPO, telefono = '' } = {}) {
  const ms = [...mensajes].filter((m) => m && m.rol !== 3).sort((a, b) => a.t - b.t || a.id - b.id);
  let ultimoHumano = -1;
  ms.forEach((m, i) => {
    if (esHumano(m)) ultimoHumano = i;
  });
  const despues = ms.slice(ultimoHumano + 1);
  const pendientes = despues.filter(necesitaRespuesta);
  if (!pendientes.length) return { caso: null, razon: 'nadie espera respuesta' };

  const desde = pendientes[0].t;
  const desdeAqui = despues.filter((m) => m.t >= desde);
  if (desdeAqui.some(esSeguimiento)) return { caso: null, razon: 'ya se le hizo seguimiento a este turno' };
  const enSemana = ms.filter((m) => esSeguimiento(m) && ahora - m.t < 7 * 86400000).length;
  if (enSemana >= TOPE_SEMANA) return { caso: null, razon: `tope de ${TOPE_SEMANA} seguimientos en 7 días` };

  const esperaMin = minutosHabiles(desde, ahora, horario);
  const texto = pendientes.map((m) => m.tx || '').join('\n');
  const area = areaDelCaso({ mensaje: texto });
  const destino = personaDelArea(area, telefono);
  // Lo último que le dijo el bot: si le respondió sin pasarlo a una persona, quedó atendido.
  const ultimoBot = [...desdeAqui].reverse().find((m) => esDelBot(m) && !esSeguimiento(m));
  if (ultimoBot && !esPase(ultimoBot.tx)) return { caso: null, razon: 'el bot le respondió' };
  const paseDelBot = Boolean(ultimoBot);

  if (!paseDelBot) {
    if (esperaMin < UMBRAL_EQUIPO) return { caso: null, razon: `espera ${esperaMin} min de oficina (< ${UMBRAL_EQUIPO})` };
    return { caso: 'espera_equipo', accion: 'listar', area, destino, esperaMin, razon: 'gestión con un asesor sin respuesta' };
  }
  if (esperaMin < UMBRAL_CLIENTE) return { caso: null, razon: `espera ${esperaMin} min de oficina (< ${UMBRAL_CLIENTE})` };
  const base = { caso: 'espera_asesor', area, destino, esperaMin };
  if (!equipoAtendiendo(ahora, horario)) return { ...base, accion: 'listar', razon: 'fuera del horario del equipo: no se le escribe' };
  if (ms.some((m) => m.rol === 1 && /^cron_/i.test(String(m.resp || '')) && ahora - m.t < 48 * 3600 * 1000))
    return { ...base, accion: 'listar', razon: 'ya le llegó una plantilla programada en 48 h' };
  const ultimoCliente = [...ms].reverse().find((m) => m.rol === 0);
  if (!ultimoCliente || ahora - ultimoCliente.t >= VENTANA_MS)
    return { ...base, accion: 'plantilla', razon: 'fuera de la ventana de 24 h: necesita plantilla de Meta' };
  return {
    ...base,
    accion: 'texto',
    texto: T.MENSAJE_SEGUIMIENTO.replace('{quien}', T.QUIEN_SEGUIMIENTO[area] || T.QUIEN_SEGUIMIENTO.otro),
    razon: 'el bot le dijo que un asesor le escribía y nadie le escribió',
  };
}

module.exports = { UMBRAL_CLIENTE, UMBRAL_EQUIPO, TOPE_SEMANA, RESPONSABLE, esAutomatico, decidirSeguimiento };
