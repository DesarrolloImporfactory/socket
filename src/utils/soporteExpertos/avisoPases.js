/* Aviso de Jeff a la persona del equipo cuando un pase del bot lleva 2 h de
   oficina sin respuesta (tramo 5, aprobado por Daniel el 27-oct).

   Es un WhatsApp INTERNO (a la persona, o al grupo del equipo si no hay su
   número): nunca al cliente. Lo arma scripts/aviso_pases_sin_respuesta.js en
   el servidor del chat (solo lee) y lo encola en Jeff
   scripts/erp/aviso_pases_jeff.py desde el ERP, que guarda qué pases ya avisó
   (un aviso por pase).

   Puro: no lee ni escribe nada. */

'use strict';

const { esPase } = require('./escalado');
const { esAutomatico } = require('./seguimiento');
const { equipoAtendiendo, minutosHabiles, HORARIO_EQUIPO } = require('./horario');

const UMBRAL_AVISO = 120; // 2 h de oficina
const VENTANA_MS = 72 * 3600 * 1000; // pases de los últimos 3 días

const esHumano = (m) => m.rol === 1 && !esAutomatico(m.resp) && m.tm !== 'revoke';
const esDelBot = (m) => m.rol === 1 && /^IA_/i.test(String(m.resp || '')) && !String(m.resp || '').startsWith('IA_Seguimiento');

/**
 * ¿Hay que avisarle a la persona?
 * @param {object} p  mensajes [{ id, rol, resp, t, tx, tm }], ahora (ms), horario,
 *                    yaAvisados Set de ids de pase ya avisados
 * @returns {{ avisar: boolean, razon, paseId?, desde?, esperaMin?, extracto? }}
 */
function decidirAviso({ mensajes = [], ahora = Date.now(), horario = HORARIO_EQUIPO, yaAvisados = new Set() } = {}) {
  const ms = [...mensajes].filter((m) => m && m.rol !== 3).sort((a, b) => a.t - b.t || a.id - b.id);
  let ultimoHumano = -1;
  ms.forEach((m, i) => {
    if (esHumano(m)) ultimoHumano = i;
  });
  const despues = ms.slice(ultimoHumano + 1);
  const pase = despues.find((m) => esDelBot(m) && ahora - m.t < VENTANA_MS && esPase(m.tx));
  if (!pase) return { avisar: false, razon: 'no hay un pase sin respuesta' };
  const paseId = String(pase.id);
  if (yaAvisados.has(paseId)) return { avisar: false, razon: 'ya se avisó este pase', paseId };
  if (!equipoAtendiendo(ahora, horario)) return { avisar: false, razon: 'fuera de oficina', paseId };
  const esperaMin = minutosHabiles(pase.t, ahora, horario);
  if (esperaMin < UMBRAL_AVISO) return { avisar: false, razon: `espera ${esperaMin} min de oficina (< ${UMBRAL_AVISO})`, paseId };
  const delCliente = ms.filter((m) => m.rol === 0 && m.t <= pase.t).pop();
  return {
    avisar: true,
    razon: 'pase sin respuesta de una persona',
    paseId,
    desde: pase.t,
    esperaMin,
    extracto: String((delCliente && delCliente.tx) || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

const duracion = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
};

/** El WhatsApp para la persona. Sin el teléfono del cliente. */
function textoAviso({ nombre, cliente, esperaMin, idChat, extracto }) {
  return (
    `🔔 ${nombre || 'Equipo'}, el bot te pasó un chat hace ${duracion(esperaMin)} de oficina y nadie le ha respondido: ` +
    `${cliente || 'cliente'} (chat ${idChat}).` +
    (extracto ? ` Escribió: «${extracto}».` : '') +
    ' Ábrelo en Team y contéstale por favor.'
  );
}

module.exports = { UMBRAL_AVISO, decidirAviso, textoAviso };
