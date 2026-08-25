'use strict';

/**
 * Cierre de venta para las respuestas rápidas del wizard.
 *
 * Las quemadas ahorran tokens pero su trabajo no es informar: es VENDER. Una
 * respuesta que contesta y se queda callada mata el impulso — y pedirle al
 * negocio que escriba la pregunta de cierre en cada FAQ no funciona: el que
 * agrega una a mano se olvida. Por eso el remate vive en CÓDIGO, al momento
 * de enviar (runtime) y de simular (wizard), no en los datos guardados:
 *  - si la respuesta ya termina preguntando (las generadas con IA vienen así,
 *    con pregunta contextual), se respeta tal cual;
 *  - si no, se le añade una pregunta corta de cierre, rotada por contacto
 *    para no sonar a robot.
 * Una sola fuente para runtime y simulador: lo que se prueba es lo que sale.
 */

const CIERRES_RAPIDA = [
  '¿Te confirmo tu pedido? 😊',
  '¿Cuántas unidades te aparto?',
  '¿Te lo enviamos con pago contra entrega?',
  '¿Deseas que te lo reserve de una vez?',
];

/* "...¿te aparto uno? 😊" también cuenta como pregunta final: se toleran
   emojis y signos después del "?". */
function terminaPreguntando(texto) {
  return /\?[\s\p{Extended_Pictographic}️!.)]*$/u.test(
    String(texto || '').trim(),
  );
}

function conCierreDeVenta(respuesta, semilla) {
  const t = String(respuesta || '').trim();
  if (!t || terminaPreguntando(t)) return t;
  const i = Math.abs(Number(semilla) || 0) % CIERRES_RAPIDA.length;
  return `${t}\n\n${CIERRES_RAPIDA[i]}`;
}

/* Semilla estable por contacto+faq: el mismo cliente no ve siempre el mismo
   remate en FAQs distintas, pero tampoco cambia si repite la pregunta. */
function semillaCierre(telefono, indice) {
  const base = Number(
    String(telefono || '')
      .replace(/\D/g, '')
      .slice(-4),
  );
  return (Number.isFinite(base) ? base : 0) + (Number(indice) || 0);
}

module.exports = {
  CIERRES_RAPIDA,
  terminaPreguntando,
  conCierreDeVenta,
  semillaCierre,
};
