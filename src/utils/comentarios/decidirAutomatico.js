// ════════════════════════════════════════════════════════════════════════
// decidirAutomatico.js
// Si la IA contesta sola un comentario, y qué contesta.
//
// Está aparte del servicio y sin una sola consulta a la base a propósito: son
// las reglas que deciden qué se publica en la página de un negocio, a la vista
// de todos y de forma permanente. Separadas se leen de un vistazo, se prueban
// sin levantar nada y se discuten sin abrir un archivo de 2.000 líneas.
//
// LAS DOS INTERACCIONES
//
// El primer comentario de una persona se contesta en público con el contexto
// del producto. A partir del segundo, la conversación dejó de ser una pregunta
// suelta y se volvió una venta, y una venta no se lleva en los comentarios de
// una publicación —se lleva en el chat, donde está el bot de kanban con el
// catálogo, las objeciones, el envío y el cierre.
//
// Pero mudarse al privado NO es dejar de contestar en público. La primera
// versión sólo publicaba "te escribo por el privado", y visto en el hilo real
// se leía como esquivar la pregunta: el que entra a los comentarios ve una
// pregunta concreta y ninguna respuesta, y los que leen son muchos más que los
// que escriben. Así que desde la segunda se hacen las dos cosas: se contesta
// igual y además se le escribe. El puente al kanban (puenteKanban.js) deja ese
// chat anclado al producto de la publicación.
// ════════════════════════════════════════════════════════════════════════

/** Qué hacer con un comentario recién llegado. */
const ACCIONES = {
  /** No tocarlo. Lo atenderá una persona desde la bandeja, o nadie. */
  NADA: 'nada',
  /** Redactar con la IA y publicar la respuesta. */
  IA: 'ia',
  /** Línea corta en público y pasar la conversación al privado. */
  DERIVAR: 'derivar',
};

const no = (motivo) => ({ accion: ACCIONES.NADA, motivo });

/**
 * La decisión, con el motivo siempre explícito.
 *
 * El motivo no es decorativo: va al log en cada comentario que NO se contesta,
 * que es la pregunta que se hace el negocio ("¿por qué no respondió?"). Sin él
 * la única respuesta posible es leer el código.
 *
 * @param {boolean} cuentaAuto   La cuenta encendió la respuesta automática.
 * @param {object}  post         { id_producto, ia_automatica }
 * @param {object}  comentario   { es_de_la_pagina, oculto, eliminado_at,
 *                                 respondido, from_id, mensaje }
 * @param {number}  previas      Comentarios anteriores de esa persona en esta
 *                               publicación (sin contar el actual).
 * @param {boolean} privadoPrevio Ya se le mandó un privado por esta publicación.
 */
function decidirAccion({
  cuentaAuto,
  post,
  comentario,
  previas = 0,
  privadoPrevio = false,
}) {
  if (!cuentaAuto) {
    return no('la cuenta no tiene encendida la respuesta automática');
  }
  if (Number(post?.ia_automatica) !== 1) {
    return no('la IA está apagada en esta publicación');
  }
  /* Sin producto no se habla en público. Es la regla que impide que la IA
     conteste "sí, lo tenemos" sobre algo que nadie le dijo que existe, y de
     paso la que mantiene esto dentro de las cuentas que lo configuraron: el
     vínculo solo se puede poner desde la bandeja. */
  if (!post?.id_producto) {
    return no('la publicación no tiene producto vinculado');
  }

  if (Number(comentario?.es_de_la_pagina) === 1) {
    return no('es un comentario de la propia página');
  }
  if (comentario?.eliminado_at) return no('el comentario fue eliminado');
  if (Number(comentario?.oculto) === 1) return no('el comentario está oculto');
  if (Number(comentario?.respondido) === 1) return no('ya estaba respondido');

  /* Sin `from` no se puede saber si es su primer comentario o el quinto, y sin
     eso la IA le contestaría de cero cada vez. Pasa cuando al token le falta
     pages_read_engagement. */
  if (!comentario?.from_id) {
    return no('el comentario no trae autor (falta pages_read_engagement)');
  }

  if (!String(comentario?.mensaje || '').trim()) {
    return no('el comentario no tiene texto (foto o sticker)');
  }

  if (previas === 0) {
    return { accion: ACCIONES.IA, motivo: 'primera interacción de esta persona' };
  }

  return {
    accion: ACCIONES.DERIVAR,
    motivo: `interacción ${previas + 1} de esta persona`,
    privadoPrevio: Boolean(privadoPrevio),
  };
}

/**
 * La coletilla que se pega a la respuesta pública para anunciar el privado.
 *
 * Fija, sin modelo: no tiene sentido gastar tokens en una frase que siempre
 * dice lo mismo, y así no hay forma de que la promesa salga distinta de lo que
 * el código va a hacer después.
 *
 * Va detrás de lo que redactó la IA, salvo que esa respuesta ya prometa el
 * privado por su cuenta —se comprueba con `prometePrivado`— para no publicar
 * la promesa dos veces seguidas.
 *
 * Respeta el trato y los emojis que el negocio configuró en el asistente, para
 * que no se note el salto entre lo que escribe la IA y esto.
 */
function lineaDerivacion({ trato, emojis, yaEscrito }) {
  const tu = trato !== 'usted';

  const base = yaEscrito
    ? tu
      ? 'Ya te escribí por el privado, revisa tu bandeja de mensajes y ahí seguimos.'
      : 'Ya le escribí por el privado, revise su bandeja de mensajes y ahí seguimos.'
    : tu
      ? 'Te escribo por el privado para darte todos los detalles.'
      : 'Le escribo por el privado para darle todos los detalles.';

  return emojis === 'ninguno' ? base : `${base} 📩`;
}

/**
 * El primer mensaje del chat privado cuando la derivación lo abre.
 *
 * Lleva el comentario citado a propósito. No es por cortesía: ese texto entra
 * en el historial de la conversación, y es lo que el bot de kanban lee en su
 * primer turno. Sin la pregunta, el bot abre con un saludo genérico sobre un
 * producto que el cliente ya sabe que existe; con ella, contesta lo que le
 * preguntaron en la publicación.
 */
function primerPrivado({ trato, producto, comentario }) {
  const tu = trato !== 'usted';
  const texto = String(comentario || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  const nombre = String(producto || '').trim();

  const partes = [
    tu ? '¡Hola! Te escribo' : '¡Hola! Le escribo',
    nombre
      ? `por tu comentario en la publicación de ${nombre}`
      : 'por tu comentario en la publicación',
  ];
  if (!tu) partes[1] = partes[1].replace('tu comentario', 'su comentario');

  const encabezado = `${partes.join(' ')}.`;
  const cita = texto ? ` Preguntaste: «${texto}».` : '';
  const cierre = tu
    ? ' Acá te cuento todo con calma.'
    : ' Acá le cuento todo con calma.';

  return `${encabezado}${tu ? cita : cita.replace('Preguntaste', 'Preguntó')}${cierre}`;
}

module.exports = {
  ACCIONES,
  decidirAccion,
  lineaDerivacion,
  primerPrivado,
};
