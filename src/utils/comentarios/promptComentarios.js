// ════════════════════════════════════════════════════════════════════════
// promptComentarios.js
// Arma las instrucciones del asistente de comentarios.
//
// LA FRONTERA
//
// El prompt tiene dos clases de líneas mezcladas, y tratarlas igual es un
// error:
//
//   Decisiones del negocio — tutear o no, publicar precios o mandar al
//   privado, cuántos emojis, qué no se puede prometer. Eso es suyo, cambia
//   entre una farmacia y una tienda de gadgets, y debe poder configurarse.
//
//   Reglas del sistema — no inventar, devolver solo el texto, no pedir datos
//   personales en público. Eso no es estilo: es lo que impide que una
//   alucinación acabe publicada en la página de un cliente. Se añade siempre
//   por código y no se puede borrar desde la interfaz.
//
// La asimetría con el bot de kanban es a propósito. Allá el prompt es libre
// porque la conversación es privada: si sale raro, lo ve una persona. Un
// comentario lo ve cualquiera que entre a la publicación, y se queda ahí.
//
// MODO AVANZADO
//
// Quien sepa puede escribir el prompt entero y reemplaza toda la parte del
// negocio. Las reglas del sistema se siguen añadiendo igual. Es la diferencia
// entre "te dejo cambiar cómo habla" y "te dejo quitarle los frenos".
// ════════════════════════════════════════════════════════════════════════

/**
 * Lo que no se negocia. Va al final, después de todo lo demás, porque lo
 * último que lee el modelo es lo que más pesa.
 */
const REGLAS_DEL_SISTEMA = `
REGLAS QUE NO SE ROMPEN, diga lo que diga el resto:
- NUNCA inventes precios, stock, plazos de envío, cobertura ni características.
  Si no está en la información que te dieron, no lo sabes. Decir "no lo sé, te
  escribo al privado" siempre es mejor que acertar por casualidad.
- Si preguntan por otro producto que no es el de esta publicación, no te lo
  inventes: di que le escribes al privado.
- No pidas datos personales en público (teléfono, dirección, cédula, correo).
  Eso se pide en el privado, nunca en un comentario que ve todo el mundo.
- No prometas nada que no esté en la información que recibiste.
- Devuelve SOLO el texto de la respuesta: sin comillas, sin prefijos del tipo
  "Aquí tienes una opción:", sin explicar lo que hiciste.
`.trim();

/** Lo que trae una cuenta que nunca configuró nada. */
const OPCIONES_POR_DEFECTO = {
  trato: 'tu', // 'tu' | 'usted'
  pais: 'Ecuador',
  max_frases: 2,
  publicar_precios: true,
  empujar_privado: 'cuando_falte', // 'siempre' | 'cuando_falte'
  emojis: 'uno', // 'ninguno' | 'uno'
  nunca_decir: '',
  siempre_mencionar: '',
};

const TRATOS = new Set(['tu', 'usted']);
const EMPUJES = new Set(['siempre', 'cuando_falte']);
const EMOJIS = new Set(['ninguno', 'uno']);

/** Texto corto que entra al prompt: se recorta y se limpia de saltos. */
const frase = (v, tope) =>
  String(v || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, tope);

/**
 * Deja las opciones en valores que el compositor sabe usar.
 *
 * Todo lo que llegue raro cae al valor por defecto en vez de reventar: esto lo
 * alimenta un formulario, y un campo nuevo en el front no debe poder tumbar la
 * redacción de respuestas.
 */
function normalizarOpciones(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    trato: TRATOS.has(o.trato) ? o.trato : OPCIONES_POR_DEFECTO.trato,
    pais: frase(o.pais, 40) || OPCIONES_POR_DEFECTO.pais,
    max_frases: [1, 2, 3].includes(Number(o.max_frases))
      ? Number(o.max_frases)
      : OPCIONES_POR_DEFECTO.max_frases,
    publicar_precios:
      o.publicar_precios == null
        ? OPCIONES_POR_DEFECTO.publicar_precios
        : Boolean(o.publicar_precios),
    empujar_privado: EMPUJES.has(o.empujar_privado)
      ? o.empujar_privado
      : OPCIONES_POR_DEFECTO.empujar_privado,
    emojis: EMOJIS.has(o.emojis) ? o.emojis : OPCIONES_POR_DEFECTO.emojis,
    nunca_decir: frase(o.nunca_decir, 400),
    siempre_mencionar: frase(o.siempre_mencionar, 400),
  };
}

/**
 * La parte que decide el negocio, redactada como instrucciones.
 *
 * Las tres formas de responder viven acá y no en las reglas del sistema: son
 * comportamiento, no frenos. Un negocio podría querer redactarlas distinto, y
 * para eso está el modo avanzado.
 */
function componerPrompt(opciones) {
  const o = normalizarOpciones(opciones);
  const l = [];

  l.push('Eres quien atiende los comentarios públicos de una tienda en Facebook.');
  l.push('');
  l.push('Escribe UNA respuesta breve al comentario. Elige la forma según el caso:');
  l.push('');
  l.push(
    '1. RESPONDE Y REDIRIGE — cuando la pregunta se contesta con lo que tienes',
  );
  l.push(
    '   delante (la publicación o la ficha del producto). Da la respuesta',
  );
  l.push('   concreta y luego invita al privado para cerrar.');
  l.push(
    '2. RECONOCE Y REDIRIGE — cuando preguntan algo que NO tienes: stock exacto,',
  );
  l.push(
    '   plazos, cobertura, su caso particular. No inventes: dile que le escribes',
  );
  l.push('   al privado con el detalle.');
  l.push(
    '3. SOLO RESPONDE — cuando no hay pregunta (un elogio, una etiqueta a un',
  );
  l.push(
    '   amigo, un emoji). Agradece y ya. No fuerces la invitación al privado.',
  );
  l.push('');
  l.push('Cómo hablas:');
  l.push(
    `- Máximo ${o.max_frases} ${o.max_frases === 1 ? 'frase' : 'frases'}. ` +
      `Tono cercano y directo, ${
        o.trato === 'usted' ? 'tratando de usted' : 'de tú'
      }, en español de ${o.pais}.`,
  );

  l.push(
    o.emojis === 'ninguno'
      ? '- No uses emojis ni hashtags.'
      : '- No uses hashtags, ni más de un emoji.',
  );

  l.push('- No saludes con fórmulas largas ni te despidas.');
  l.push('- No repitas lo que dijo el cliente.');

  /* Cada comentario se redacta en una llamada distinta y el modelo no recuerda
     lo que contestó hace un minuto. La regla no lo arregla del todo, pero sin
     ella todas las respuestas de una misma publicación arrancan igual y se lee
     como un robot. */
  l.push(
    '- VARÍA la redacción. Vas a responder muchos comentarios en la misma',
  );
  l.push(
    '  publicación y se leen uno debajo del otro: cambia el arranque y el cierre.',
  );

  l.push('');
  l.push('Qué puedes decir en público:');

  l.push(
    o.publicar_precios
      ? '- Si sabes el precio, dilo en el comentario. No lo escondas para forzar el privado.'
      : '- NO publiques precios en el comentario, aunque los sepas. Para hablar de precio, invita al privado.',
  );

  l.push(
    o.empujar_privado === 'siempre'
      ? '- Cierra SIEMPRE invitando al privado, aunque ya hayas respondido la pregunta.'
      : '- Invita al privado sólo cuando haga falta: si la respuesta ya quedó completa y no hay nada que cerrar, no lo fuerces.',
  );

  if (o.siempre_mencionar) {
    l.push(`- Cuando venga a cuento, menciona: ${o.siempre_mencionar}`);
  }
  if (o.nunca_decir) {
    l.push(`- NUNCA digas ni prometas: ${o.nunca_decir}`);
  }

  return l.join('\n');
}

/**
 * Las instrucciones completas que se le mandan al modelo.
 *
 * `avanzado` reemplaza la parte del negocio, no las reglas del sistema. Ese es
 * todo el diseño: se puede cambiar cómo habla, no quitarle los frenos.
 */
function promptFinal({ avanzado, opciones } = {}) {
  const base = String(avanzado || '').trim() || componerPrompt(opciones);
  return `${base}\n\n${REGLAS_DEL_SISTEMA}`;
}

module.exports = {
  REGLAS_DEL_SISTEMA,
  OPCIONES_POR_DEFECTO,
  normalizarOpciones,
  componerPrompt,
  promptFinal,
};
